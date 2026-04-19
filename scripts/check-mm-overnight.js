/**
 * Quick health check on Market Monitor overnight runs.
 *
 * Reports:
 *   1. job_log rows for moves/backlinks/page_changes in last 24h
 *   2. actual row counts in each data table
 *   3. position_history sample (first 5 rows)
 *   4. page_watch hash status (so we can confirm baselines were captured)
 */
import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";

const credential = new AzureCliCredential();
const token = await credential.getToken("https://database.windows.net/.default");
const pool = await new sql.ConnectionPool({
  server: process.env.SQL_SERVER || "sql-iadm-prod-cus.database.windows.net",
  database: process.env.SQL_DATABASE || "iadm_services",
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();

console.log("══════════════════════════════════════════════════════════════");
console.log(" Market Monitor — Overnight Run Report");
console.log("══════════════════════════════════════════════════════════════\n");

// 1. Job log
const jobLog = await pool.request().query(`
  SELECT job_name, status, rows_processed, started_at, completed_at,
         DATEDIFF(SECOND, started_at, ISNULL(completed_at, SYSDATETIMEOFFSET())) AS duration_sec,
         LEFT(ISNULL(error_message, ''), 200) AS error_message
  FROM arion.market_monitor_job_log
  WHERE started_at >= DATEADD(HOUR, -24, SYSDATETIMEOFFSET())
  ORDER BY started_at DESC
`);
console.log("── Job log (last 24h) ────────────────────────────────────────");
if (jobLog.recordset.length === 0) {
  console.log("  ⚠️  NO ROWS — none of the timers fired in the last 24h.");
} else {
  for (const r of jobLog.recordset) {
    const icon = r.status === 'success' ? '✓' : r.status === 'error' ? '✗' : '⋯';
    console.log(`  ${icon} ${r.job_name.padEnd(15)} status=${r.status.padEnd(8)} rows=${String(r.rows_processed ?? '-').padStart(5)} dur=${String(r.duration_sec).padStart(4)}s started=${new Date(r.started_at).toISOString()}`);
    if (r.error_message) console.log(`      error: ${r.error_message}`);
  }
}

// 2. Data table row counts
console.log("\n── Data table row counts ─────────────────────────────────────");
const tables = ['se_ranking_position_history', 'se_ranking_backlink_snapshot', 'site_page_change', 'site_page_watch'];
for (const t of tables) {
  const r = await pool.request().query(`SELECT COUNT(*) AS n FROM arion.${t}`);
  console.log(`  arion.${t}: ${r.recordset[0].n} row(s)`);
}

// 3. Position history sample
console.log("\n── position_history sample (first 5 rows) ────────────────────");
const sample = await pool.request().query(`
  SELECT TOP 5 keyword, competitor_domain, position, recorded_for, site_engine_id
  FROM arion.se_ranking_position_history
  ORDER BY recorded_at DESC
`);
if (sample.recordset.length === 0) {
  console.log("  (no rows)");
} else {
  for (const r of sample.recordset) {
    console.log(`  ${(r.competitor_domain || '[OWN]').padEnd(28)} ${(r.keyword || '').slice(0, 40).padEnd(40)} pos=${String(r.position ?? '--').padStart(3)} engine=${r.site_engine_id} for=${r.recorded_for.toISOString().split('T')[0]}`);
  }
}

// 4. Page watch hash status
console.log("\n── page_watch hash status (have we captured baselines?) ──────");
const watchStatus = await pool.request().query(`
  SELECT page_type,
         COUNT(*) AS total,
         SUM(CASE WHEN last_content_hash IS NOT NULL THEN 1 ELSE 0 END) AS hashed,
         SUM(CASE WHEN last_checked_at IS NOT NULL THEN 1 ELSE 0 END) AS checked
  FROM arion.site_page_watch
  GROUP BY page_type
`);
for (const r of watchStatus.recordset) {
  console.log(`  ${r.page_type.padEnd(12)} total=${r.total}  hashed=${r.hashed}  checked=${r.checked}`);
}

// 5. Backlink snapshot summary
console.log("\n── backlink_snapshot summary ─────────────────────────────────");
const bls = await pool.request().query(`
  SELECT link_status, COUNT(*) AS n
  FROM arion.se_ranking_backlink_snapshot
  GROUP BY link_status
`);
if (bls.recordset.length === 0) {
  console.log("  (no rows — Sunday weekly run hasn't fired yet, that's expected)");
} else {
  for (const r of bls.recordset) console.log(`  ${r.link_status}: ${r.n}`);
}

await pool.close();
console.log("\n══════════════════════════════════════════════════════════════");
