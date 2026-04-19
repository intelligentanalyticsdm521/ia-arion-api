/**
 * Diagnose Market Monitor issues from this morning:
 *   1. Why are positions NULL? Look at raw SE Ranking response
 *   2. Which pages failed to hash and why?
 *   3. Which Data API backlink endpoint actually works?
 */
import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";
import 'dotenv/config';

const credential = new AzureCliCredential();
const token = await credential.getToken("https://database.windows.net/.default");
const pool = await new sql.ConnectionPool({
  server: "sql-iadm-prod-cus.database.windows.net",
  database: "iadm_services",
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();

console.log("\n━━━ ISSUE 1: Why are positions NULL? ━━━━━━━━━━━━━━━━━━━━");

// Look at distribution of position values from this morning's run
const posDist = await pool.request().query(`
  SELECT
    CASE
      WHEN position IS NULL THEN 'NULL'
      WHEN position = 0 THEN 'zero'
      WHEN position BETWEEN 1 AND 10 THEN '1-10'
      WHEN position BETWEEN 11 AND 30 THEN '11-30'
      WHEN position BETWEEN 31 AND 100 THEN '31-100'
      ELSE 'over100'
    END AS bucket,
    COUNT(*) AS n,
    SUM(CASE WHEN competitor_domain IS NULL THEN 1 ELSE 0 END) AS own_rows,
    SUM(CASE WHEN competitor_domain IS NOT NULL THEN 1 ELSE 0 END) AS comp_rows
  FROM arion.se_ranking_position_history
  WHERE recorded_for = CAST(SYSUTCDATETIME() AS DATE)
  GROUP BY CASE
      WHEN position IS NULL THEN 'NULL'
      WHEN position = 0 THEN 'zero'
      WHEN position BETWEEN 1 AND 10 THEN '1-10'
      WHEN position BETWEEN 11 AND 30 THEN '11-30'
      WHEN position BETWEEN 31 AND 100 THEN '31-100'
      ELSE 'over100'
    END
  ORDER BY n DESC
`);
console.log("Position bucket distribution (today's rows):");
for (const r of posDist.recordset) {
  console.log(`  ${r.bucket.padEnd(8)} total=${String(r.n).padStart(4)}  own=${String(r.own_rows).padStart(4)}  comp=${String(r.comp_rows).padStart(4)}`);
}

console.log("\n━━━ ISSUE 2: Which pages failed to hash? ━━━━━━━━━━━━━━━━");
const watchStatus = await pool.request().query(`
  SELECT page_url, page_type, competitor_domain,
         CASE WHEN last_content_hash IS NULL THEN 'FAILED' ELSE 'OK' END AS status,
         last_checked_at
  FROM arion.site_page_watch
  ORDER BY status DESC, page_type, page_url
`);
const failed = watchStatus.recordset.filter((r) => r.status === 'FAILED');
console.log(`${failed.length} of ${watchStatus.recordset.length} pages failed to hash:`);
for (const r of failed) {
  console.log(`  ✗ [${r.page_type}] ${r.page_url}`);
}

console.log("\n━━━ ISSUE 3: Probe SE Ranking Data API backlink endpoints ━");
const dataKey = process.env.SERANKING_DATA_API_KEY;
if (!dataKey) {
  console.log("⚠️  SERANKING_DATA_API_KEY env var not set locally — skip API probe");
} else {
  const candidates = [
    "/backlinks/overview?target=intelligentanalyticsdm.com&mode=domain",
    "/backlinks/overview?target=intelligentanalyticsdm.com",
    "/backlinks/refdomains?target=intelligentanalyticsdm.com&mode=domain",
    "/backlinks/refdomains?target=intelligentanalyticsdm.com",
    "/backlinks/list?target=intelligentanalyticsdm.com&mode=domain",
    "/backlinks/list?target=intelligentanalyticsdm.com",
    "/backlinks?target=intelligentanalyticsdm.com",
    "/backlinks/new?target=intelligentanalyticsdm.com",
    "/backlinks/lost?target=intelligentanalyticsdm.com",
    "/backlinks/anchors?target=intelligentanalyticsdm.com&mode=domain",
    "/backlinks/summary?target=intelligentanalyticsdm.com",
    "/backlinks/domain/intelligentanalyticsdm.com/summary",
    "/backlinks/domain/intelligentanalyticsdm.com/backlinks",
    "/backlinks/domain/intelligentanalyticsdm.com/refdomains",
  ];
  for (const path of candidates) {
    try {
      const r = await fetch(`https://api.seranking.com/v1${path}`, {
        headers: { Authorization: `Token ${dataKey}` },
      });
      const text = await r.text();
      const sample = text.slice(0, 100).replace(/\s+/g, ' ');
      console.log(`  ${r.status} ${path}`);
      if (r.ok) console.log(`     body: ${sample}`);
    } catch (e) {
      console.log(`  ERR ${path} — ${e.message}`);
    }
  }
}

await pool.close();
console.log("\n━━━ done ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
