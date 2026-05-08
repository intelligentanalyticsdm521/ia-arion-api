import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";
import { runPageSpeedTest } from "../lib/pagespeed.js";

const SITE = '64C43F2F-B4FE-40C2-B023-0F06F7D275FA';
const TENANT = '8c9527b9-8999-4b31-a306-f3d4ccc39fbd';
const URL = 'https://intelligentanalyticsdm.com';

const credential = new AzureCliCredential();
const token = await credential.getToken("https://database.windows.net/.default");
const pool = await new sql.ConnectionPool({
  server: "sql-iadm-prod-cus.database.windows.net",
  database: "iadm_services",
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();

async function saveSnapshot(result, triggered_by) {
  const today = new Date().toISOString().slice(0, 10);
  const m = result.metrics || {};
  await pool.request()
    .input('tenantId', sql.UniqueIdentifier, TENANT)
    .input('siteId', sql.UniqueIdentifier, SITE)
    .input('runDate', sql.Date, today)
    .input('strategy', sql.NVarChar(10), result.strategy)
    .query(`DELETE FROM arion.site_pagespeed_snapshot WHERE tenant_id=@tenantId AND site_id=@siteId AND run_date=@runDate AND strategy=@strategy`);

  await pool.request()
    .input('tenantId', sql.UniqueIdentifier, TENANT)
    .input('siteId', sql.UniqueIdentifier, SITE)
    .input('runDate', sql.Date, today)
    .input('strategy', sql.NVarChar(10), result.strategy)
    .input('performanceScore', sql.Int, result.scores?.performance ?? null)
    .input('accessibilityScore', sql.Int, result.scores?.accessibility ?? null)
    .input('seoScore', sql.Int, result.scores?.seo ?? null)
    .input('bestPracticesScore', sql.Int, result.scores?.bestPractices ?? null)
    .input('mobilePerformance', sql.Int, result.strategy === 'mobile' ? result.scores?.performance ?? null : null)
    .input('desktopPerformance', sql.Int, result.strategy === 'desktop' ? result.scores?.performance ?? null : null)
    .input('lcpMs', sql.Int, Math.round(m.lcp?.value ?? 0) || null)
    .input('inpMs', sql.Int, Math.round(m.inp?.value ?? 0) || null)
    .input('clsScore', sql.Decimal(6, 4), m.cls?.value != null ? Number(m.cls.value).toFixed(4) : null)
    .input('fcpMs', sql.Int, Math.round(m.fcp?.value ?? 0) || null)
    .input('tbtMs', sql.Int, Math.round(m.tbt?.value ?? 0) || null)
    .input('opportunities', sql.NVarChar(sql.MAX), JSON.stringify(result.opportunities || []))
    .input('cruxUrl', sql.NVarChar(sql.MAX), result.field_url ? JSON.stringify(result.field_url) : null)
    .input('cruxOrigin', sql.NVarChar(sql.MAX), result.field_origin ? JSON.stringify(result.field_origin) : null)
    .input('triggeredBy', sql.NVarChar(50), triggered_by)
    .query(`
      INSERT INTO arion.site_pagespeed_snapshot
        (tenant_id, site_id, run_date, strategy,
         performance_score, accessibility_score, seo_score, best_practices_score,
         mobile_performance, desktop_performance,
         lcp_ms, inp_ms, cls_score, fcp_ms, tbt_ms,
         opportunities, crux_url_json, crux_origin_json, triggered_by)
      VALUES (@tenantId, @siteId, @runDate, @strategy,
              @performanceScore, @accessibilityScore, @seoScore, @bestPracticesScore,
              @mobilePerformance, @desktopPerformance,
              @lcpMs, @inpMs, @clsScore, @fcpMs, @tbtMs,
              @opportunities, @cruxUrl, @cruxOrigin, @triggeredBy)
    `);
}

console.log("Running mobile PSI...");
const mobile = await runPageSpeedTest(URL, 'mobile');
if (mobile) {
  console.log(`  mobile score: ${mobile.scores?.performance}`);
  await saveSnapshot(mobile, 'manual_force');
  console.log("  ✓ saved mobile");
} else {
  console.log("  ✗ mobile failed");
}

console.log("Running desktop PSI...");
const desktop = await runPageSpeedTest(URL, 'desktop');
if (desktop) {
  console.log(`  desktop score: ${desktop.scores?.performance}`);
  await saveSnapshot(desktop, 'manual_force');
  console.log("  ✓ saved desktop");
} else {
  console.log("  ✗ desktop failed");
}

console.log("\nDone. Refresh the CWV page in your Portal.");
await pool.close();
