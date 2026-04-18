/**
 * Sanity check for migration 009 — verifies all 5 tables exist.
 */
import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";

const SERVER = process.env.SQL_SERVER || "sql-iadm-prod-cus.database.windows.net";
const DATABASE = process.env.SQL_DATABASE || "iadm_services";

const credential = new AzureCliCredential();
const token = await credential.getToken("https://database.windows.net/.default");

const pool = await new sql.ConnectionPool({
  server: SERVER,
  database: DATABASE,
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();

const expected = [
  "se_ranking_position_history",
  "se_ranking_backlink_snapshot",
  "site_page_change",
  "site_page_watch",
  "market_monitor_job_log",
];

for (const t of expected) {
  const r = await pool.request().query(`
    SELECT OBJECT_ID(N'arion.${t}', 'U') AS id
  `);
  const exists = r.recordset[0].id != null;
  console.log(`arion.${t}: ${exists ? "✔" : "✘ MISSING"}`);
}

await pool.close();
