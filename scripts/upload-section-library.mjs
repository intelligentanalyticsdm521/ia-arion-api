#!/usr/bin/env node
/**
 * Section library uploader — ingests `iadm-section-library.json` into the
 * production library so the AI Website Builder emitters can inject curated
 * sections instead of (or alongside) the scratch-emit path.
 * --------------------------------------------------------------------------
 * Source:
 *   C:/Users/brand/Downloads/iadm-section-library.json
 *     — exported from the iadm-template-lab WordPress authoring site.
 *     Shape: { generated, source, archetypes, sections_count, note,
 *              sections: { <blueprint_id>: <container json>, ... } }
 *     `sections` is a flat map of blueprint_id → top-level Elementor container
 *     object whose settings._title equals the blueprint_id.
 *
 * Destination (per migration 029_arion_section_library.sql):
 *   Blob:   stiadmprod / ia-section-library / sections/{blueprint_id}.json
 *   SQL:    iadm_services.arion.section_library
 *           (blueprint_id PK; archetype + variant_key + axes + dependencies +
 *            version + status + blob_ref)
 *
 * What this script does per entry:
 *   1. Parse blueprint_id "archetype.variant_key.v{N}" into its 3 parts.
 *   2. Normalize per handoff §5 (idempotent, safe to re-run):
 *        a. strip vendor `_css_classes` hooks recursively from settings,
 *        b. null out placeholder image url/id and link.url so the emitter's
 *           injection step lands real assets cleanly,
 *        c. re-set settings._title = blueprint_id (defensive — authoring
 *           pages may have stray title overrides).
 *   3. Walk the section tree for widgetType:"form" → set dependencies.pro=true
 *      (mirrors the handoff: 11 sections use Pro form widget).
 *   4. Upload the normalized container JSON to Azure Blob.
 *   5. Upsert the SQL manifest row (MERGE; idempotent on blueprint_id).
 *
 * Auth:
 *   AzureCliCredential — must be inside an `az login` shell. The signed-in
 *   principal needs:
 *     - "Storage Blob Data Contributor" on stiadmprod  (for blob writes)
 *     - db_ddladmin / table-level INSERT+UPDATE on arion.section_library
 *
 *   Brandon's local dev account has both; the pipeline service principal
 *   has the SQL role (and we re-use it for the blob path so the script
 *   runs identically locally and in CI).
 *
 * Modes:
 *   --dry-run   Default. Walk every entry, log normalization stats + which
 *               sections would carry dependencies.pro=true, do NOT touch
 *               Blob or SQL. Safe to run anytime.
 *   --apply     Same walk, but actually uploads + upserts. Idempotent — re-
 *               running on the same source file is a no-op except for
 *               updated_at + the underlying blob etag.
 *
 *   --source=<path>   Override the default source file path.
 *
 * Exit codes:
 *   0  success (dry-run or apply)
 *   1  fatal error (auth, malformed source, etc)
 *   2  one or more sections failed to upload/upsert in apply mode
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BlobServiceClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import { AzureCliCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import sql from 'mssql';

const SOURCE_DEFAULT = 'C:/Users/brand/Downloads/iadm-section-library.json';
const STORAGE_ACCOUNT = process.env.SECTION_LIBRARY_ACCOUNT || 'stiadmprod';
const CONTAINER_NAME = process.env.SECTION_LIBRARY_CONTAINER || 'ia-section-library';
const SQL_SERVER = process.env.SQL_SERVER || 'sql-iadm-prod-cus.database.windows.net';
const SQL_DATABASE = process.env.SQL_DATABASE || 'iadm_services';
const SQL_SCOPE = 'https://database.windows.net/.default';
const STORAGE_SCOPE = 'https://storage.azure.com/.default';

const MODE_DRY_RUN = process.argv.includes('--dry-run') || (!process.argv.includes('--apply'));
const MODE_APPLY = process.argv.includes('--apply');

const sourceArg = process.argv.find((a) => a.startsWith('--source='));
const SOURCE = sourceArg ? sourceArg.slice('--source='.length) : SOURCE_DEFAULT;

// blueprint_id parser — "archetype.variant_key.v{N}"
// archetype is alphanumeric, variant_key allows hyphens (e.g. "gradient-dual-cta"),
// version is "v" + integer. We're tolerant of multi-dot variant keys: split on
// the FIRST dot for archetype, the LAST dot for version, the middle stays as
// the variant key.
const BLUEPRINT_RE = /^([a-z][a-z0-9]*)\.(.+?)\.v(\d+)$/i;

function parseBlueprintId(blueprintId) {
  const m = BLUEPRINT_RE.exec(blueprintId);
  if (!m) return null;
  return { archetype: m[1], variant_key: m[2], version: parseInt(m[3], 10) };
}

/**
 * Walk a node tree and remove `_css_classes` settings recursively.
 * The handoff calls this "vendor pollution" — leftover Hostinger / theme
 * builder hooks that hard-pin styles to the authoring environment.
 */
function stripCssClasses(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) stripCssClasses(child);
    return;
  }
  if (node.settings && typeof node.settings === 'object' && '_css_classes' in node.settings) {
    delete node.settings._css_classes;
  }
  if (Array.isArray(node.elements)) {
    for (const child of node.elements) stripCssClasses(child);
  }
}

/**
 * Null out placeholder image url/id and link.url on every widget so the
 * emitter's injection step can drop a real URL in cleanly. Elementor's
 * placeholder.png path is the canonical "empty" — we treat ANY url on the
 * image widget as a placeholder unless the variant_key explicitly opts out.
 *
 * For link widgets (button, etc) we only blank link.url; we keep is_external
 * and nofollow flags so the emitter doesn't have to re-set them.
 */
function nullPlaceholderAssets(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) nullPlaceholderAssets(child);
    return;
  }
  if (node.elType === 'widget' && node.settings) {
    // Image widgets — null url/id.
    if (node.widgetType === 'image' && node.settings.image && typeof node.settings.image === 'object') {
      node.settings.image.url = '';
      node.settings.image.id = '';
    }
    // Background images on containers/sections.
    if (node.settings.background_image && typeof node.settings.background_image === 'object') {
      node.settings.background_image.url = '';
      node.settings.background_image.id = '';
    }
    // Button / link widgets — null link.url.
    if (node.settings.link && typeof node.settings.link === 'object' && 'url' in node.settings.link) {
      node.settings.link.url = '';
    }
  }
  // Containers can also have background_image at the top settings level.
  if (node.elType === 'container' && node.settings && node.settings.background_image && typeof node.settings.background_image === 'object') {
    node.settings.background_image.url = '';
    node.settings.background_image.id = '';
  }
  if (Array.isArray(node.elements)) {
    for (const child of node.elements) nullPlaceholderAssets(child);
  }
}

/**
 * Walk the tree for any widget with widgetType === 'form' (Elementor Pro).
 * Returns true if found, false otherwise.
 */
function usesProFormWidget(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(usesProFormWidget);
  if (node.elType === 'widget' && node.widgetType === 'form') return true;
  if (Array.isArray(node.elements)) return node.elements.some(usesProFormWidget);
  return false;
}

/**
 * Build the axes object — light JSON-ish summary of section characteristics
 * the picker can score. Derived from the variant_key for now (the authoring
 * site doesn't carry richer axes). Future iterations can pull this from
 * a separate library-manifest-full.json catalog when one ships.
 */
function deriveAxes(archetype, variantKey) {
  const tokens = variantKey.split('-');
  const axes = { tokens };
  // Heuristic flags scanned from the variant_key.
  const has = (t) => tokens.includes(t);
  if (has('gradient') || has('image')) axes.style = has('gradient') ? 'gradient' : 'image';
  if (has('solid'))    axes.style = axes.style || 'solid';
  if (has('split') || has('two-col')) axes.layout = 'split';
  if (has('centered')) axes.layout = axes.layout || 'centered';
  if (has('minimal') || has('light')) axes.density = 'minimal';
  if (has('full') || has('expanded') || has('panel')) axes.density = axes.density || 'rich';
  if (has('form'))    axes.has_form = true;
  if (has('cta') || has('dual'))   axes.cta_emphasis = has('dual') ? 'dual' : 'single';
  return axes;
}

async function loadSource() {
  const txt = await fs.readFile(SOURCE, 'utf-8');
  const data = JSON.parse(txt);
  const sections = data?.sections;
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) {
    throw new Error(`source file ${SOURCE} missing top-level .sections object`);
  }
  const entries = Object.entries(sections).map(([blueprintId, section]) => ({
    blueprintId,
    section,
  }));
  return { entries, meta: { generated: data.generated, source: data.source } };
}

async function ensureContainer(containerClient) {
  // create-if-missing is idempotent: the SDK returns silently if it already
  // exists, so we don't need a separate exists() probe.
  await containerClient.createIfNotExists();
}

function buildBlobPath(blueprintId) {
  return `sections/${blueprintId}.json`;
}

async function upsertManifestRow(pool, row) {
  // MERGE so re-running is a no-op except for blob_ref + updated_at. We
  // intentionally bump version every time the source file is re-ingested for
  // the same blueprint_id — the migration column defaults to 1, but on the
  // updated-path we increment to make stale-cache invalidation easy.
  await pool.request()
    .input('blueprint_id', sql.NVarChar(120), row.blueprintId)
    .input('archetype',    sql.NVarChar(40),  row.archetype)
    .input('variant_key',  sql.NVarChar(80),  row.variantKey)
    .input('axes',         sql.NVarChar(sql.MAX), row.axes ? JSON.stringify(row.axes) : null)
    .input('dependencies', sql.NVarChar(sql.MAX), row.dependencies ? JSON.stringify(row.dependencies) : null)
    .input('blob_ref',     sql.NVarChar(400), row.blobRef)
    .query(`
      MERGE arion.section_library AS tgt
      USING (
        SELECT
          @blueprint_id AS blueprint_id,
          @archetype    AS archetype,
          @variant_key  AS variant_key,
          @axes         AS axes,
          @dependencies AS dependencies,
          @blob_ref     AS blob_ref
      ) AS src
      ON tgt.blueprint_id = src.blueprint_id
      WHEN MATCHED THEN UPDATE SET
        archetype    = src.archetype,
        variant_key  = src.variant_key,
        axes         = src.axes,
        dependencies = src.dependencies,
        blob_ref     = src.blob_ref,
        version      = tgt.version + 1,
        updated_at   = SYSDATETIMEOFFSET()
      WHEN NOT MATCHED THEN INSERT
        (blueprint_id, archetype, variant_key, axes, dependencies, blob_ref)
      VALUES
        (src.blueprint_id, src.archetype, src.variant_key, src.axes, src.dependencies, src.blob_ref);
    `);
}

async function main() {
  const mode = MODE_APPLY ? 'APPLY' : 'DRY-RUN';
  console.log(`[upload-section-library] mode=${mode} source=${SOURCE}`);
  console.log(`[upload-section-library] target storage=${STORAGE_ACCOUNT}/${CONTAINER_NAME}`);
  console.log(`[upload-section-library] target sql=${SQL_SERVER}/${SQL_DATABASE} arion.section_library`);

  const { entries, meta } = await loadSource();
  console.log(`[upload-section-library] loaded ${entries.length} sections from source (generated=${meta.generated || 'n/a'} source=${meta.source || 'n/a'})`);

  if (entries.length === 0) {
    console.error('[upload-section-library] FATAL: source file has zero sections');
    process.exit(1);
  }

  // Validation pass — every blueprint_id must parse + every section must be a
  // top-level container. Fail loud BEFORE acquiring any auth.
  const archetypeCounts = {};
  const proIds = [];
  const parseFailures = [];
  const shapeFailures = [];
  const prepared = [];

  for (const { blueprintId, section } of entries) {
    const parsed = parseBlueprintId(blueprintId);
    if (!parsed) { parseFailures.push(blueprintId); continue; }
    if (!section || section.elType !== 'container') {
      shapeFailures.push({ blueprintId, elType: section?.elType || 'undefined' });
      continue;
    }

    // Deep-clone before mutating so the source JSON in-memory stays clean for
    // dry-run summary purposes (also matters when --source points at an
    // already-processed file you re-load).
    const clone = JSON.parse(JSON.stringify(section));

    // Normalization sequence per scope §5 + defensive _title reset.
    stripCssClasses(clone);
    nullPlaceholderAssets(clone);
    if (!clone.settings || typeof clone.settings !== 'object') clone.settings = {};
    clone.settings._title = blueprintId;

    const isPro = usesProFormWidget(clone);
    if (isPro) proIds.push(blueprintId);

    archetypeCounts[parsed.archetype] = (archetypeCounts[parsed.archetype] || 0) + 1;

    prepared.push({
      blueprintId,
      archetype:   parsed.archetype,
      variantKey:  parsed.variant_key,
      axes:        deriveAxes(parsed.archetype, parsed.variant_key),
      dependencies: isPro
        ? { pro: true, plugins: ['elementor-pro'] }
        : { pro: false, plugins: [] },
      blobRef:     buildBlobPath(blueprintId),
      sectionJson: clone,
    });
  }

  if (parseFailures.length) {
    console.error(`[upload-section-library] FATAL: ${parseFailures.length} blueprint_id(s) failed to parse:`);
    for (const id of parseFailures.slice(0, 10)) console.error(`  - ${id}`);
    process.exit(1);
  }
  if (shapeFailures.length) {
    console.error(`[upload-section-library] FATAL: ${shapeFailures.length} section(s) are not top-level containers:`);
    for (const f of shapeFailures.slice(0, 10)) console.error(`  - ${f.blueprintId} (elType=${f.elType})`);
    process.exit(1);
  }

  console.log('\n[upload-section-library] archetype counts (parsed):');
  for (const arch of Object.keys(archetypeCounts).sort()) {
    console.log(`  ${arch.padEnd(14)} ${archetypeCounts[arch]}`);
  }
  console.log(`[upload-section-library] pro-dependent sections (${proIds.length}):`);
  for (const id of proIds) console.log(`  - ${id}`);

  if (MODE_DRY_RUN && !MODE_APPLY) {
    console.log(`\n[upload-section-library] DRY-RUN complete — would upload ${prepared.length} blob(s) and upsert ${prepared.length} SQL row(s). Re-run with --apply.`);
    return;
  }

  // ─── APPLY mode: blob + SQL ───────────────────────────────────────────────
  const credential = new AzureCliCredential();

  // Blob auth — two paths, per `lib/azureBlob.js` precedent (the
  // arion-api MI lacks Storage Blob Data RBAC because granting it requires
  // Owner on the subscription; the account-key path sidesteps that).
  //
  //   Path A — Storage account key (preferred for local + pipeline runs)
  //            Picks up STIADMPROD_ACCOUNT_KEY env, or falls back to
  //            kv-iadm-prod secret STIADMPROD-ACCOUNT-KEY.
  //   Path B — Token credential (RBAC). Requires "Storage Blob Data
  //            Contributor" on stiadmprod for the signed-in principal.
  //
  // Path A is selected automatically when an account key is available; Path B
  // is the fallback so this script keeps working in environments where the
  // key isn't reachable (e.g. dev tenants without KV access).
  let blobSvc;
  let blobAuthSource;
  const envKey = process.env.STIADMPROD_ACCOUNT_KEY;
  let accountKey = (envKey && envKey.length > 30 && !envKey.startsWith('@Microsoft.KeyVault'))
    ? envKey : null;
  if (!accountKey) {
    // Try KV. The signed-in principal needs "Key Vault Secrets User" on
    // kv-iadm-prod; if it doesn't, fall through to RBAC.
    try {
      const kvUri = process.env.KEY_VAULT_URI || 'https://kv-iadm-prod.vault.azure.net/';
      const kv = new SecretClient(kvUri, credential);
      const secret = await kv.getSecret('STIADMPROD-ACCOUNT-KEY');
      if (secret?.value && secret.value.length > 30) accountKey = secret.value;
    } catch (e) {
      console.warn(`[upload-section-library] KV fetch of STIADMPROD-ACCOUNT-KEY failed (non-fatal, will try RBAC): ${e?.message?.slice(0, 200)}`);
    }
  }
  if (accountKey) {
    const sharedKeyCred = new StorageSharedKeyCredential(STORAGE_ACCOUNT, accountKey);
    blobSvc = new BlobServiceClient(
      `https://${STORAGE_ACCOUNT}.blob.core.windows.net`,
      sharedKeyCred,
    );
    blobAuthSource = 'shared_key';
  } else {
    await credential.getToken(STORAGE_SCOPE);
    blobSvc = new BlobServiceClient(
      `https://${STORAGE_ACCOUNT}.blob.core.windows.net`,
      credential,
    );
    blobAuthSource = 'rbac_token';
  }
  console.log(`[upload-section-library] blob auth: ${blobAuthSource}`);
  const containerClient = blobSvc.getContainerClient(CONTAINER_NAME);
  console.log(`[upload-section-library] ensuring container ${CONTAINER_NAME} exists`);
  await ensureContainer(containerClient);

  // SQL connection — re-uses the same credential class as the pipeline
  // migration runner so the role grants are identical.
  const sqlToken = await credential.getToken(SQL_SCOPE);
  console.log(`[upload-section-library] acquired SQL AAD token (expires ${new Date(sqlToken.expiresOnTimestamp).toISOString()})`);

  const pool = await new sql.ConnectionPool({
    server: SQL_SERVER,
    database: SQL_DATABASE,
    options: { encrypt: true },
    connectionTimeout: 15000,
    requestTimeout: 60000,
    authentication: {
      type: 'azure-active-directory-access-token',
      options: { token: sqlToken.token },
    },
  }).connect();
  console.log('[upload-section-library] sql connected');

  // Sanity-check the target table exists. If migration 029 hasn't been
  // applied yet we fail loud rather than silently no-op.
  const probe = await pool.request().query(`
    SELECT COUNT(*) AS c
    FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'arion' AND t.name = 'section_library'
  `);
  if (probe.recordset[0].c === 0) {
    await pool.close();
    console.error('[upload-section-library] FATAL: arion.section_library does not exist. Apply migration 029_arion_section_library.sql first.');
    process.exit(1);
  }

  let uploaded = 0;
  let upserted = 0;
  const failures = [];

  try {
    for (const row of prepared) {
      try {
        const blob = containerClient.getBlockBlobClient(row.blobRef);
        const body = JSON.stringify(row.sectionJson);
        await blob.upload(body, Buffer.byteLength(body, 'utf8'), {
          blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8' },
        });
        uploaded++;
      } catch (e) {
        failures.push({ blueprintId: row.blueprintId, stage: 'blob', error: e.message });
        continue;
      }
      try {
        await upsertManifestRow(pool, row);
        upserted++;
      } catch (e) {
        failures.push({ blueprintId: row.blueprintId, stage: 'sql', error: e.message });
      }
      if ((uploaded + upserted) % 20 === 0) {
        console.log(`  ... progress: ${uploaded} blob uploads, ${upserted} sql upserts`);
      }
    }
  } finally {
    await pool.close();
  }

  console.log('\n[upload-section-library] APPLY complete.');
  console.log(`  blobs uploaded:   ${uploaded}/${prepared.length}`);
  console.log(`  sql rows upserted: ${upserted}/${prepared.length}`);
  console.log(`  failures:         ${failures.length}`);
  if (failures.length) {
    for (const f of failures.slice(0, 20)) {
      console.error(`    [${f.stage}] ${f.blueprintId}: ${f.error?.slice(0, 200)}`);
    }
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[upload-section-library] fatal:', err);
  process.exit(1);
});
