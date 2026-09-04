/**
 * Section library reader — provides emitters with the curated 120-section
 * Elementor library shipped by Brandon via iadm-template-lab.
 * --------------------------------------------------------------------------
 * Companion to:
 *   db/migrations/029_arion_section_library.sql   (manifest table schema)
 *   scripts/upload-section-library.mjs            (blob + sql uploader)
 *
 * Each emitter (heroEmitter, aboutEmitter, ...) can swap its scratch-emit
 * path for `pickSection({ archetype, ...filters })` to get a curated
 * Elementor section container directly. The library is keyed by
 * archetype (12 total) × variant (10 each) = 120 entries; each archetype
 * has 10 variants, so the picker has real choices.
 *
 * Layout:
 *   - SQL row   → metadata + blob pointer  (arion.section_library)
 *   - Blob      → the full Elementor container JSON
 *                 (stiadmprod / ia-section-library / sections/<blueprint>.json)
 *
 * Performance:
 *   - listAvailable() caches the SQL manifest in-memory; 5-min TTL.
 *   - fetchSection() caches up to 50 hot Elementor JSON blobs in an LRU.
 *
 * NOTHING in this module mutates the library. Re-ingestion is the
 * uploader's job; this reader is strictly read-only and side-effect-free
 * apart from caches.
 *
 * Tier gating contract:
 *   Lite tier sites do NOT have Elementor Pro installed (per
 *   project_arion_seo_tier_matrix.md + reference_arion_plugin_stack.md).
 *   Pro-dependent variants (the 11 form-widget sections) must be filtered
 *   out for Lite. Callers pass `requirePro=false` to allow Pro variants
 *   (Standard+) and `requirePro=false` is the default for the all-tiers
 *   picker; we treat "Pro present" as "Pro variants are allowed" — see
 *   each emitter's wiring.
 *
 *   `requirePro: true`   → only return variants whose dependencies.pro === true
 *   `requirePro: false`  → return ALL variants (Pro + non-Pro)
 *   `allowPro: false`    → return ONLY non-Pro variants (lite tier path)
 */

import fs from 'node:fs';
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import { isLocalDatabase } from './aiDevStub.js';

const SQL_SERVER = process.env.SQL_SERVER || 'sql-iadm-prod-cus.database.windows.net';
const SQL_DATABASE = process.env.SQL_DATABASE || 'iadm_services';
const STORAGE_ACCOUNT = process.env.SECTION_LIBRARY_ACCOUNT || 'stiadmprod';
const CONTAINER_NAME  = process.env.SECTION_LIBRARY_CONTAINER || 'ia-section-library';

const SQL_TOKEN_SCOPE = 'https://database.windows.net/.default';

// ─── Caches ─────────────────────────────────────────────────────────────────
// Manifest cache (the SQL rows). Short TTL — re-uploads are infrequent but
// we want fresh data within a few minutes so a hot-fix to one variant
// doesn't require a redeploy.
const MANIFEST_TTL_MS = 5 * 60 * 1000;
let _manifestCache = null;   // { ts: number, rows: SectionMeta[] }

// Section JSON LRU. Keyed by blueprint_id. Capped at 50 entries — enough
// for the entire 4-page onboarding flow to land in cache, but bounded so a
// runaway test or live-edit session can't blow up the heap.
const BLOB_LRU_CAP = 50;
const BLOB_TTL_MS = 5 * 60 * 1000;
/** @type {Map<string,{ts:number, value:object, dependencies:object|null}>} */
const _blobCache = new Map();

// Azure SDK clients — lazy-init so non-emitter callers (tests, lint) don't
// pay the cred cost.
let _credential = null;
let _blobSvc = null;
function getCredential() {
  if (!_credential) _credential = new DefaultAzureCredential();
  return _credential;
}
function getBlobService() {
  if (_blobSvc) return _blobSvc;
  _blobSvc = new BlobServiceClient(
    `https://${STORAGE_ACCOUNT}.blob.core.windows.net`,
    getCredential(),
  );
  return _blobSvc;
}

// SQL connection pool — also lazy. Token expiry handled by re-acquiring on
// connection-pool refresh; the AAD token typically lives 1h, well past any
// single request.
let _poolPromise = null;
async function getPool() {
  if (_poolPromise) {
    try { return await _poolPromise; } catch { _poolPromise = null; }
  }
  _poolPromise = (async () => {
    const token = await getCredential().getToken(SQL_TOKEN_SCOPE);
    const pool = await new sql.ConnectionPool({
      server: SQL_SERVER,
      database: SQL_DATABASE,
      options: { encrypt: true },
      connectionTimeout: 15000,
      requestTimeout: 30000,
      authentication: {
        type: 'azure-active-directory-access-token',
        options: { token: token.token },
      },
    }).connect();
    return pool;
  })();
  return _poolPromise;
}

/* ── LOCAL DEV SOURCE ───────────────────────────────────────────────────────
 * The manifest lives in SQL and the blueprints in prod blob storage, neither
 * of which a local dev machine can reach. Without a local source the "add a
 * section" picker cannot be clicked through at all in dev, and the standing
 * rule is that every button is clicked in the real dev app before Brandon
 * walks it (feedback_exhaustive_ui_test_before_walkthrough).
 *
 * So: point SECTION_LIBRARY_LOCAL_FILE at Brandon's own authoring export (the
 * same iadm-section-library.json scripts/upload-section-library.mjs uploads
 * from) and the reader serves the library from that file instead.
 *
 * Guarded the way lib/devAuth.js guards its seam, and for the same reason:
 *   1. inert unless the variable is set;
 *   2. refuses when NODE_ENV === 'production';
 *   3. refuses unless the database this process is pointed at is LOCAL — the
 *      load-bearing lock, because an env var can be set by accident and a
 *      connection string to localhost cannot be prod.
 * All three are presence checks (reference_absence_based_guards_fail_open).
 *
 * It is a READ source only. Nothing here writes anywhere, in dev or anywhere
 * else — re-ingestion stays the uploader's job.
 * ------------------------------------------------------------------------ */

let _localCache = null;

export function localLibraryFile(env = process.env) {
  const file = String(env.SECTION_LIBRARY_LOCAL_FILE || '').trim();
  if (!file) return null;
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
    console.warn('[sectionLibrary] refusing the local export: NODE_ENV=production');
    return null;
  }
  if (!isLocalDatabase(env)) {
    console.warn('[sectionLibrary] refusing the local export: the database is not local');
    return null;
  }
  return file;
}

/** The export, read once, shaped exactly like the SQL manifest rows. */
function readLocalLibrary() {
  const file = localLibraryFile();
  if (!file) return null;
  if (_localCache && _localCache.file === file) return _localCache;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn(`[sectionLibrary] local export unreadable (${file}): ${e?.message}`);
    return null;
  }
  const sections = doc?.sections || {};
  const rows = Object.keys(sections).map((blueprintId) => {
    const [archetype, variantKey] = String(blueprintId).split('.');
    const json = JSON.stringify(sections[blueprintId] || {});
    return {
      blueprint_id: blueprintId,
      archetype,
      variant_key: variantKey || blueprintId,
      axes: null,
      // The manifest's Pro flag comes from the uploader; locally, a blueprint
      // carrying a form widget is exactly the Pro-dependent set.
      dependencies: /"widgetType"\s*:\s*"form"/.test(json) ? { pro: true, plugins: ['elementor-pro'] } : null,
      version: 1,
      status: 'active',
      blob_ref: `local:${blueprintId}`,
    };
  });
  _localCache = { file, rows, sections };
  console.log(`[sectionLibrary] LOCAL DEV: serving ${rows.length} blueprints from ${file}`);
  return _localCache;
}

function parseJsonField(s) {
  if (!s) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * @typedef {object} SectionMeta
 * @property {string} blueprint_id
 * @property {string} archetype
 * @property {string} variant_key
 * @property {object|null} axes
 * @property {object|null} dependencies     {pro:boolean, plugins:string[]}
 * @property {number} version
 * @property {string} status
 * @property {string} blob_ref
 */

async function loadManifestUncached() {
  let pool;
  try {
    pool = await getPool();
  } catch (e) {
    console.warn(`[sectionLibrary] sql connect failed (non-fatal): ${e?.message?.slice(0, 200)}`);
    return [];
  }
  try {
    const r = await pool.request().query(`
      SELECT
        blueprint_id, archetype, variant_key,
        axes, dependencies, version, status, blob_ref
      FROM arion.section_library
      WHERE status = 'active'
    `);
    return r.recordset.map((row) => ({
      blueprint_id: row.blueprint_id,
      archetype:    row.archetype,
      variant_key:  row.variant_key,
      axes:         parseJsonField(row.axes),
      dependencies: parseJsonField(row.dependencies),
      version:      row.version,
      status:       row.status,
      blob_ref:     row.blob_ref,
    }));
  } catch (e) {
    // Table missing or other SQL error — return empty so emitters fall back
    // to scratch-emit cleanly. Production should never hit this once
    // migration 029 has been applied.
    console.warn(`[sectionLibrary] manifest query failed (non-fatal): ${e?.message?.slice(0, 200)}`);
    return [];
  }
}

async function getManifest() {
  const local = readLocalLibrary();
  if (local) return local.rows;
  const now = Date.now();
  if (_manifestCache && now - _manifestCache.ts < MANIFEST_TTL_MS) {
    return _manifestCache.rows;
  }
  const rows = await loadManifestUncached();
  _manifestCache = { ts: now, rows };
  return rows;
}

/**
 * List available variants matching the requested archetype + filters.
 *
 * @param {object} args
 * @param {string} args.archetype                  — e.g. 'hero'
 * @param {boolean} [args.requirePro=false]        — only return Pro-dependent variants
 * @param {boolean} [args.allowPro=true]           — set false to exclude Pro variants (Lite tier)
 * @returns {Promise<SectionMeta[]>}
 */
export async function listAvailable({ archetype, requirePro = false, allowPro = true } = {}) {
  if (!archetype || typeof archetype !== 'string') return [];
  const all = await getManifest();
  return all.filter((row) => {
    if (row.archetype !== archetype) return false;
    const isPro = !!row.dependencies?.pro;
    if (requirePro && !isPro) return false;
    if (!allowPro && isPro) return false;
    return true;
  });
}

function lruGet(key) {
  const entry = _blobCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > BLOB_TTL_MS) {
    _blobCache.delete(key);
    return null;
  }
  // Move-to-end so it's marked as MRU.
  _blobCache.delete(key);
  _blobCache.set(key, entry);
  return entry;
}

function lruSet(key, value, dependencies) {
  if (_blobCache.size >= BLOB_LRU_CAP) {
    const oldest = _blobCache.keys().next().value;
    if (oldest !== undefined) _blobCache.delete(oldest);
  }
  _blobCache.set(key, { ts: Date.now(), value, dependencies });
}

/**
 * Fetch one section's Elementor JSON container by blueprint_id.
 *
 * Returns the raw top-level Elementor container — caller is responsible for
 * regenerating element ids before injection (the library has stable ids
 * baked in to keep diffs readable in the authoring environment).
 *
 * @param {string} blueprintId
 * @returns {Promise<{ sectionJson: object, dependencies: object|null } | null>}
 */
export async function fetchSection(blueprintId) {
  if (!blueprintId || typeof blueprintId !== 'string') return null;

  const local = readLocalLibrary();
  if (local) {
    const json = local.sections[blueprintId];
    if (!json) return null;
    const rowMeta = local.rows.find((r) => r.blueprint_id === blueprintId);
    return { sectionJson: json, dependencies: rowMeta?.dependencies || null };
  }

  const cached = lruGet(blueprintId);
  if (cached) return { sectionJson: cached.value, dependencies: cached.dependencies };

  // Find the manifest row first so we get the blob_ref + dependencies.
  const all = await getManifest();
  const row = all.find((r) => r.blueprint_id === blueprintId);
  if (!row) return null;

  try {
    const svc = getBlobService();
    const container = svc.getContainerClient(CONTAINER_NAME);
    const blob = container.getBlobClient(row.blob_ref);
    const buf = await blob.downloadToBuffer();
    const json = JSON.parse(buf.toString('utf8'));
    lruSet(blueprintId, json, row.dependencies);
    return { sectionJson: json, dependencies: row.dependencies };
  } catch (e) {
    console.warn(`[sectionLibrary] blob fetch failed for ${blueprintId} (non-fatal): ${e?.message?.slice(0, 200)}`);
    return null;
  }
}

// ─── Regenerate element ids on injection ────────────────────────────────────
// Elementor requires globally-unique ids inside _elementor_data. The library
// stores stable ids (h1, t2, b3, ...) for readability during authoring; we
// MUST rewrite them before stitching into a customer page so multiple library
// sections on the same page don't collide.
function shortId() {
  // 7-char base36 random — collision-free enough for one page's worth of
  // sections (a 4-page onboarding flow is ~16 sections × ~20 nodes = 320
  // ids; 36^7 = 78B combos = trivially safe).
  return Math.random().toString(36).slice(2, 9);
}

/**
 * Deep-clone + regenerate every `id` field on the section + children. Returns
 * a NEW object — does NOT mutate the input.
 *
 * @param {object} sectionJson
 * @returns {object}
 */
export function regenerateIds(sectionJson) {
  if (!sectionJson || typeof sectionJson !== 'object') return sectionJson;
  // Single deep clone, then rewrite in-place on the clone.
  const cloned = JSON.parse(JSON.stringify(sectionJson));
  const rewrite = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const c of node) rewrite(c); return; }
    if ('id' in node) node.id = shortId();
    if (Array.isArray(node.elements)) { for (const c of node.elements) rewrite(c); }
  };
  rewrite(cloned);
  return cloned;
}

/**
 * Scoring heuristic — pick the "best" variant for the given brand context.
 *
 * The library has 10 variants per archetype. We score on axes vs. brand:
 *   + style match  (gradient/image/solid vs brand.style_preference)
 *   + density match (minimal vs rich vs brand.brand_voice)
 *   + cta emphasis (dual cta for "engagement", single for "minimal")
 *
 * Returns the meta object for the chosen variant, or null if input is empty.
 * Ties broken by blueprint_id sort order (deterministic).
 *
 * @param {SectionMeta[]} variants
 * @param {object} brand
 * @returns {SectionMeta|null}
 */
export function pickBestVariant(variants, brand = {}) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const voice = String(brand.brand_voice || '').toLowerCase();
  const style = String(brand.style_preference || '').toLowerCase();
  const wantsMinimal = voice.includes('minimal') || voice.includes('clean')
                    || style.includes('minimal') || style.includes('clean');
  const wantsBold = voice.includes('bold') || voice.includes('confident')
                 || voice.includes('strong');
  const wantsImage = style.includes('image') || style.includes('photographic')
                  || style.includes('visual');
  const wantsGradient = style.includes('gradient') || style.includes('vibrant')
                     || style.includes('colorful');

  let best = null;
  let bestScore = -Infinity;
  for (const v of variants) {
    let score = 0;
    const axes = v.axes || {};
    if (wantsMinimal && axes.density === 'minimal') score += 3;
    if (wantsBold && axes.density === 'rich')       score += 3;
    if (wantsImage && axes.style === 'image')       score += 4;
    if (wantsGradient && axes.style === 'gradient') score += 4;
    if (!wantsMinimal && !wantsBold && axes.density === 'minimal') score += 1; // gentle default
    // Avoid bias by blueprint_id by NOT scoring on it, but break ties
    // deterministically below.
    if (score > bestScore || (score === bestScore && (best === null || v.blueprint_id < best.blueprint_id))) {
      best = v;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Convenience: pick + fetch + regenerate ids in one call. Returns the picked
 * meta + a ready-to-inject Elementor section container (or null if nothing
 * matches).
 *
 * @param {object} args
 * @param {string} args.archetype
 * @param {object} args.brand          — for variant selection
 * @param {boolean} [args.allowPro=true]
 * @param {boolean} [args.requirePro=false]
 * @returns {Promise<{ meta: SectionMeta, sectionJson: object }|null>}
 */
export async function pickAndPrepareSection({ archetype, brand, allowPro = true, requirePro = false }) {
  const variants = await listAvailable({ archetype, allowPro, requirePro });
  if (variants.length === 0) return null;
  const chosen = pickBestVariant(variants, brand || {});
  if (!chosen) return null;
  const fetched = await fetchSection(chosen.blueprint_id);
  if (!fetched) return null;
  return {
    meta: chosen,
    sectionJson: regenerateIds(fetched.sectionJson),
  };
}

/**
 * Reset caches — TEST-ONLY hook (the verifier scripts use it).
 */
export function __resetCaches() {
  _manifestCache = null;
  _localCache = null;
  _blobCache.clear();
}

export const __test__ = {
  shortId, lruGet, lruSet, parseJsonField,
  STORAGE_ACCOUNT, CONTAINER_NAME, SQL_DATABASE, SQL_SERVER,
};
