// Provision SE Ranking for Rolling In It (rollinginitllc.com)
// Tier: ARION Pro + ARION SEO Essentials → essentials config
//   • 25 keyword cap × Google US Desktop + Google US Mobile + Bing US
//   • No AI engines, no backlink monitoring (those are Growth+)
//   • check_daily cadence
// Idempotent: reuses existing project if it matches the URL.

import sql from "mssql";
import { DefaultAzureCredential } from "@azure/identity";

const SR_LEGACY_KEY = process.env.SE_RANKING_API_SYSTEM_KEY;
const SR_V1_KEY     = process.env.SE_RANKING_DATA_API_KEY;
const SR_LEGACY     = "https://api4.seranking.com";
const SR_V1         = "https://api.seranking.com/v1";

const SQL_SERVER   = "sql-iadm-prod-cus.database.windows.net";
const SERVICES_DB  = "iadm_services";
const PLATFORM_DB  = "iadm_platform";

const SERVICES = [
  "pressure washing",
  "soft washing",
  "house washing",
  "concrete cleaning",
  "snow removal",
  "snow plowing",
  "driveway sealing",
  "deck cleaning",
];

const PRIMARY_CITY  = "Des Moines";
const PRIMARY_STATE = "IA";
const PRIMARY_STATE_FULL = "Iowa";

const BUSINESS_NAME = "Rolling In It";
const SITE_URL      = "https://rollinginitllc.com";
const SITE_DOMAIN   = "rollinginitllc.com";

const ENGINE_GOOGLE_US_DESKTOP = 200;
const ENGINE_GOOGLE_US_MOBILE  = 1540;
const ENGINE_BING_US           = 415;

const REGION_NAME = `${PRIMARY_CITY}, ${PRIMARY_STATE_FULL}, United States`;

async function sr(method, path, body, opts = {}) {
  const base = opts.v1 ? SR_V1 : SR_LEGACY;
  const key  = opts.v1 ? SR_V1_KEY : SR_LEGACY_KEY;
  if (!key) throw new Error(`No SE Ranking key for ${base}`);
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  return { ok: res.ok, status: res.status, data, raw: text };
}

function buildKeywords() {
  const out = new Set();
  for (const s of SERVICES) {
    out.add(s);
    out.add(`${s} ${PRIMARY_CITY.toLowerCase()}`);
  }
  out.add(`commercial pressure washing ${PRIMARY_STATE_FULL.toLowerCase()}`);
  out.add(`commercial snow removal ${PRIMARY_STATE_FULL.toLowerCase()}`);
  out.add(`pressure washing near me`);
  out.add(`snow removal near me`);
  return Array.from(out).slice(0, 20);
}

async function getSqlPool(database) {
  const cred = new DefaultAzureCredential();
  const token = await cred.getToken("https://database.windows.net/.default");
  return await new sql.ConnectionPool({
    server: SQL_SERVER,
    database,
    options: { encrypt: true },
    connectionTimeout: 20000,
    requestTimeout: 30000,
    authentication: {
      type: "azure-active-directory-access-token",
      options: { token: token.token },
    },
  }).connect();
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

async function findTenantAndSite(platformPool, servicesPool) {
  const tRes = await platformPool.request()
    .input("name", sql.NVarChar(1000), BUSINESS_NAME)
    .query(`
      SELECT TOP 5 tenant_id, business_name, website_url, primary_contact_email
      FROM core.tenants
      WHERE business_name = @name OR website_url LIKE '%rollinginitllc%'
    `);
  const sRes = await servicesPool.request()
    .input("domain", sql.NVarChar(253), SITE_DOMAIN)
    .query(`
      SELECT TOP 5 site_id, tenant_id, domain, arion_tier, seo_addon_tier,
             se_ranking_project_id, se_ranking_audit_id
      FROM arion.site
      WHERE domain = @domain OR domain LIKE '%rollinginitllc%'
    `);
  return { tenants: tRes.recordset, sites: sRes.recordset };
}

/**
 * Ensure the tenant exists in iadm_services.core.tenants (federated mirror).
 * The integrations.tenant_integration_configs table has a FK referencing
 * iadm_services.core.tenants, but production tenants typically only live in
 * iadm_platform.core.tenants. Mirror minimum fields (tenant_id + name) so the
 * integration config write succeeds.
 */
async function ensureTenantMirror(pool, tenantId, businessName) {
  const sel = await pool.request()
    .input("tid", sql.UniqueIdentifier, tenantId)
    .query("SELECT TOP 1 tenant_id FROM core.tenants WHERE tenant_id = @tid");
  if (sel.recordset[0]) return false;
  // Schema: tenant_id, name (NOT NULL), full_name, status, is_test, created_at, updated_at, agency_managed
  await pool.request()
    .input("tid", sql.UniqueIdentifier, tenantId)
    .input("name", sql.VarChar(200), businessName.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 200))
    .input("fullName", sql.VarChar(200), businessName)
    .query(`
      INSERT INTO core.tenants (tenant_id, name, full_name, status, is_test, agency_managed)
      VALUES (@tid, @name, @fullName, 'ACTIVE', 0, 0)
    `);
  return true;
}

async function ensureSeRankingProvider(pool) {
  const sel = await pool.request().query(`
    SELECT TOP 1 provider_id FROM integrations.providers WHERE provider_code = 'SERANKING'
  `);
  if (sel.recordset[0]?.provider_id) return sel.recordset[0].provider_id;
  await pool.request().query(`
    INSERT INTO integrations.providers (provider_code, provider_name, is_active)
    VALUES ('SERANKING', 'SE Ranking', 1)
  `);
  const sel2 = await pool.request().query(`
    SELECT TOP 1 provider_id FROM integrations.providers WHERE provider_code = 'SERANKING'
  `);
  return sel2.recordset[0].provider_id;
}

async function ensureSeRankingAccount(pool, providerId) {
  const sel = await pool.request()
    .input("pid", sql.UniqueIdentifier, providerId)
    .query(`
      SELECT TOP 1 integration_account_id
      FROM integrations.integration_accounts
      WHERE provider_id = @pid AND account_scope = 'IADM_SHARED'
    `);
  if (sel.recordset[0]?.integration_account_id) return sel.recordset[0].integration_account_id;
  await pool.request()
    .input("pid", sql.UniqueIdentifier, providerId)
    .query(`
      INSERT INTO integrations.integration_accounts (provider_id, account_name, account_scope, status)
      VALUES (@pid, 'IADM SE Ranking Workspace', 'IADM_SHARED', 'ACTIVE')
    `);
  const sel2 = await pool.request()
    .input("pid", sql.UniqueIdentifier, providerId)
    .query(`
      SELECT TOP 1 integration_account_id
      FROM integrations.integration_accounts
      WHERE provider_id = @pid AND account_scope = 'IADM_SHARED'
    `);
  return sel2.recordset[0].integration_account_id;
}

async function upsertTenantIntegrationConfig(pool, tenantId, providerId, accountId, configJson) {
  const sel = await pool.request()
    .input("tid", sql.UniqueIdentifier, tenantId)
    .input("pid", sql.UniqueIdentifier, providerId)
    .query(`
      SELECT TOP 1 tenant_integration_config_id
      FROM integrations.tenant_integration_configs
      WHERE tenant_id = @tid AND provider_id = @pid
    `);
  if (sel.recordset[0]?.tenant_integration_config_id) {
    await pool.request()
      .input("id", sql.UniqueIdentifier, sel.recordset[0].tenant_integration_config_id)
      .input("cfg", sql.NVarChar(sql.MAX), JSON.stringify(configJson))
      .query(`
        UPDATE integrations.tenant_integration_configs
        SET config_json = @cfg, status = 'ACTIVE', updated_at = SYSUTCDATETIME()
        WHERE tenant_integration_config_id = @id
      `);
    return sel.recordset[0].tenant_integration_config_id;
  }
  await pool.request()
    .input("tid", sql.UniqueIdentifier, tenantId)
    .input("pid", sql.UniqueIdentifier, providerId)
    .input("aid", sql.UniqueIdentifier, accountId)
    .input("cfg", sql.NVarChar(sql.MAX), JSON.stringify(configJson))
    .query(`
      INSERT INTO integrations.tenant_integration_configs (tenant_id, provider_id, integration_account_id, config_json, status)
      VALUES (@tid, @pid, @aid, @cfg, 'ACTIVE')
    `);
  const sel2 = await pool.request()
    .input("tid", sql.UniqueIdentifier, tenantId)
    .input("pid", sql.UniqueIdentifier, providerId)
    .query(`
      SELECT TOP 1 tenant_integration_config_id
      FROM integrations.tenant_integration_configs
      WHERE tenant_id = @tid AND provider_id = @pid
    `);
  return sel2.recordset[0].tenant_integration_config_id;
}

async function updateArionSite(pool, siteId, tenantId, projectId, auditId, tier) {
  await pool.request()
    .input("sid", sql.UniqueIdentifier, siteId)
    .input("tid", sql.UniqueIdentifier, tenantId)
    .input("pid", sql.NVarChar(50), projectId ? String(projectId) : null)
    .input("aid", sql.NVarChar(50), auditId ? String(auditId) : null)
    .input("tier", sql.NVarChar(20), tier || null)
    .query(`
      UPDATE arion.site
      SET se_ranking_project_id = COALESCE(@pid, se_ranking_project_id),
          se_ranking_audit_id   = COALESCE(@aid, se_ranking_audit_id),
          seo_addon_tier        = COALESCE(seo_addon_tier, @tier)
      WHERE site_id = @sid AND tenant_id = @tid
    `);
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

const steps = [];
const errors = [];

async function main() {
  console.log("=== SE Ranking provisioning for Rolling In It ===\n");
  if (!SR_LEGACY_KEY || !SR_V1_KEY) throw new Error("Missing SE Ranking keys");

  // 0) DB lookup
  console.log("[0] Looking up tenant + site in SQL...");
  const platformPool = await getSqlPool(PLATFORM_DB);
  const servicesPool = await getSqlPool(SERVICES_DB);
  const { tenants, sites } = await findTenantAndSite(platformPool, servicesPool);
  console.log("  tenants found:", tenants.length);
  console.log("  sites found:",   sites.length);
  const tenantRow = tenants[0] || null;
  const siteRow   = sites[0]   || null;
  const tenantId  = tenantRow?.tenant_id || siteRow?.tenant_id || null;
  const siteId    = siteRow?.site_id || null;
  if (!tenantId) errors.push("No tenant for Rolling In It");
  if (!siteId)   errors.push("No arion.site row for rollinginitllc.com");

  // Project lookup: prefer the row's value, else search by URL match
  let projectId = siteRow?.se_ranking_project_id ? Number(siteRow.se_ranking_project_id) : null;
  if (!projectId) {
    console.log("\n[1] Searching for existing SE Ranking project by URL match...");
    const list = await sr("GET", "/sites");
    if (list.ok && Array.isArray(list.data)) {
      const match = list.data.find(p => (p?.name || "").toLowerCase().includes(SITE_DOMAIN));
      if (match) {
        projectId = match.id;
        steps.push(`Reusing existing SE Ranking project ${projectId} (matched by name "${match.name}")`);
        console.log(`  Found existing project id ${projectId}`);
      }
    }
  } else {
    steps.push(`Reusing SE Ranking project ${projectId} from arion.site.se_ranking_project_id`);
  }

  // 1) Create if absent
  if (!projectId) {
    console.log("\n[1] Creating SE Ranking project on v1 host...");
    const body = {
      url: SITE_URL,
      name: `${BUSINESS_NAME} - ARION (essentials)`,
      depth: 100,
      subdomain_match: 1,
      exact_url: 0,
      check_freq: "check_daily",
      auto_reports: 1,
      disable_audit: 0,
      is_active: 1,
    };
    const r = await sr("POST", "/project-management/sites", body, { v1: true });
    console.log("  POST /project-management/sites →", r.status, r.raw.slice(0, 300));
    if (r.ok) {
      projectId = r.data?.site_id || r.data?.id;
      if (projectId) steps.push(`Created SE Ranking project id ${projectId}`);
    } else {
      errors.push(`createProject failed HTTP ${r.status}: ${r.raw.slice(0, 200)}`);
    }
  }

  // 2) Search engines (idempotent — skip if engines already configured)
  let engineIds = { desktop: null, mobile: null, bing: null };
  if (projectId) {
    console.log("\n[2] Checking + configuring SERP search engines...");
    const existing = await sr("GET", `/project-management/sites/search-engines?site_id=${projectId}`, undefined, { v1: true });
    const existingArr = Array.isArray(existing.data) ? existing.data : [];
    for (const e of existingArr) {
      if (e.search_engine_id === ENGINE_GOOGLE_US_DESKTOP) engineIds.desktop = e.site_engine_id;
      if (e.search_engine_id === ENGINE_GOOGLE_US_MOBILE)  engineIds.mobile  = e.site_engine_id;
      if (e.search_engine_id === ENGINE_BING_US)           engineIds.bing    = e.site_engine_id;
    }
    console.log("  existing engines:", existingArr.map(e => `${e.search_engine_id}=>se#${e.site_engine_id}`).join(", "));

    const toAdd = [];
    if (!engineIds.desktop) toAdd.push({ search_engine_id: ENGINE_GOOGLE_US_DESKTOP, lang_code: "en", region_name: REGION_NAME, key: "desktop" });
    if (!engineIds.mobile)  toAdd.push({ search_engine_id: ENGINE_GOOGLE_US_MOBILE,  lang_code: "en", region_name: REGION_NAME, key: "mobile" });
    if (!engineIds.bing)    toAdd.push({ search_engine_id: ENGINE_BING_US, key: "bing" });

    for (const e of toAdd) {
      const body = { search_engine_id: e.search_engine_id };
      if (e.lang_code) body.lang_code = e.lang_code;
      if (e.region_name) body.region_name = e.region_name;
      const r = await sr("POST", `/project-management/sites/search-engines?site_id=${projectId}`, body, { v1: true });
      console.log(`  add engine ${e.search_engine_id} →`, r.status, r.raw.slice(0, 100));
      if (r.ok) engineIds[e.key] = r.data?.site_engine_id;
      else errors.push(`engine ${e.search_engine_id} add failed HTTP ${r.status}: ${r.raw.slice(0, 200)}`);
    }
    steps.push(`Search engines: Google US Desktop (#${engineIds.desktop}), Google US Mobile (#${engineIds.mobile}) at "${REGION_NAME}", Bing US (#${engineIds.bing})`);
  }

  // 3) Skip keyword group creation (the API auto-creates a default group on
  // first keyword add; manual group creation requires the SE Ranking UI for
  // Essentials tier — only Growth/Authority warrant multiple groups anyway).

  // 4) Bootstrap keywords (idempotent — check existing first)
  const targetKeywords = buildKeywords();
  let addedCount = 0;
  if (projectId) {
    console.log("\n[4] Adding bootstrap keywords...");
    const existingKw = await sr("GET", `/sites/${projectId}/keywords`);
    const existingNames = new Set((existingKw.data || []).map(k => (k.name || "").toLowerCase()));
    console.log(`  existing keywords: ${existingNames.size}`);

    const toAdd = targetKeywords.filter(k => !existingNames.has(k.toLowerCase()));
    if (toAdd.length === 0) {
      steps.push(`All ${targetKeywords.length} target keywords already present`);
    } else {
      const engineList = [engineIds.desktop, engineIds.mobile, engineIds.bing].filter(Boolean);
      const body = toAdd.map(kw => ({ keyword: kw, site_engine_ids: engineList }));
      const r = await sr("POST", `/sites/${projectId}/keywords`, body);
      console.log("  POST /sites/{id}/keywords →", r.status, r.raw.slice(0, 200));
      if (r.ok) {
        addedCount = r.data?.added || toAdd.length;
        steps.push(`Added ${addedCount} of ${toAdd.length} new keywords (target list = ${targetKeywords.length})`);
      } else {
        errors.push(`addKeywords failed HTTP ${r.status}: ${r.raw.slice(0, 200)}`);
      }
    }
  }

  // 5) Competitors (v1 endpoint with body, idempotent — check first)
  let competitorCount = 0;
  if (projectId) {
    console.log("\n[5] Adding competitor placeholders (3 = Essentials cap)...");
    const competitors = [
      "https://wellesleyspressurewashing.com",
      "https://iowacleanteam.com",
      "https://topshelfdesmoines.com",
    ];
    const existingComp = await sr("GET", `/project-management/competitors?site_id=${projectId}`, undefined, { v1: true });
    const existingArr = Array.isArray(existingComp.data) ? existingComp.data : (existingComp.data?.competitors || []);
    const existingUrls = new Set(existingArr.map(c => (c.url || c.domain || "").toLowerCase()));
    competitorCount = existingArr.length;

    for (const url of competitors) {
      if ([...existingUrls].some(u => u.includes(url.replace(/^https?:\/\//, "")))) {
        console.log(`  competitor ${url} already exists, skip`);
        continue;
      }
      const r = await sr("POST", `/project-management/competitors`, { site_id: projectId, url }, { v1: true });
      console.log(`  add competitor ${url} →`, r.status, r.raw.slice(0, 100));
      if (r.ok) competitorCount += 1;
    }
    steps.push(`Competitors total now ${competitorCount}/3 (placeholders — founder to refine)`);
  }

  // 6) Trigger audit (audit_id == site_id model — POST /audit/{id}/recheck on legacy host)
  let auditId = siteRow?.se_ranking_audit_id ? Number(siteRow.se_ranking_audit_id) : null;
  if (projectId) {
    console.log("\n[6] Triggering site audit recheck (audit_id == site_id)...");
    const r = await sr("POST", `/audit/${projectId}/recheck`);
    console.log(`  POST /audit/${projectId}/recheck →`, r.status, r.raw.slice(0, 100));
    if (r.ok) {
      auditId = projectId;
      steps.push(`Audit recheck triggered (audit_id = ${auditId})`);
    } else {
      errors.push(`audit recheck failed HTTP ${r.status}: ${r.raw.slice(0, 200)}`);
    }
  }

  // 7) Persist to DB
  let cfgId = null;
  if (tenantId && projectId) {
    console.log("\n[7] Writing DB persistence layer...");
    const mirrored = await ensureTenantMirror(servicesPool, tenantId, BUSINESS_NAME);
    if (mirrored) steps.push(`Mirrored tenant ${tenantId} into iadm_services.core.tenants for FK`);

    const providerId = await ensureSeRankingProvider(servicesPool);
    console.log("  SERANKING provider_id =", providerId);
    const accountId  = await ensureSeRankingAccount(servicesPool, providerId);
    console.log("  SERANKING account_id  =", accountId);

    const cfg = {
      project_id: projectId,
      audit_id: auditId,
      tier: "essentials",
      url: SITE_URL,
      region_name: REGION_NAME,
      site_engine_ids: engineIds,
      engines: ["google_us_desktop", "google_us_mobile", "bing_us"],
      keyword_count_target: targetKeywords.length,
      check_freq: "check_daily",
      configured_at: new Date().toISOString(),
    };
    cfgId = await upsertTenantIntegrationConfig(servicesPool, tenantId, providerId, accountId, cfg);
    console.log("  tenant_integration_config_id =", cfgId);
    steps.push(`integrations.tenant_integration_configs row id=${cfgId}`);

    if (siteId) {
      await updateArionSite(servicesPool, siteId, tenantId, projectId, auditId, "essentials");
      steps.push(`arion.site updated: se_ranking_project_id=${projectId}, se_ranking_audit_id=${auditId}, seo_addon_tier='essentials'`);
    }
  } else {
    errors.push(`Skipped DB persistence: tenantId=${tenantId} projectId=${projectId}`);
  }

  console.log("\n=== DONE ===");
  console.log("Project ID:", projectId);
  console.log("Audit ID:",   auditId);
  console.log("Steps:");
  steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  if (errors.length) {
    console.log("Errors:");
    errors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
  }

  await platformPool.close().catch(() => {});
  await servicesPool.close().catch(() => {});

  console.log("\nSUMMARY_JSON=" + JSON.stringify({
    ok: errors.length === 0,
    project_id: projectId,
    audit_id: auditId,
    tenant_id: tenantId,
    site_id: siteId,
    tenant_integration_config_id: cfgId,
    site_engine_ids: engineIds,
    keyword_target_count: targetKeywords.length,
    keywords_added_this_run: addedCount,
    competitor_count_now: competitorCount,
    steps,
    errors,
  }));
}

main().catch((e) => {
  console.error("FATAL:", e);
  console.log("SUMMARY_JSON=" + JSON.stringify({ ok: false, fatal: e.message, steps, errors }));
  process.exit(1);
});
