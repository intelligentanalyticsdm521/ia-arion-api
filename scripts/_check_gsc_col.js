import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";
const credential = new AzureCliCredential();
const token = await credential.getToken("https://database.windows.net/.default");
const pool = await new sql.ConnectionPool({
  server: "sql-iadm-prod-cus.database.windows.net",
  database: "iadm_services",
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();
const r = await pool.request().query(`
  SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='site' AND (COLUMN_NAME LIKE '%gsc%' OR COLUMN_NAME LIKE '%ga4%')
`);
console.table(r.recordset);
await pool.close();
