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

console.log("=== Tables in arion schema ===");
const tables = await pool.request().query(`
  SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA='arion' ORDER BY TABLE_NAME
`);
console.table(tables.recordset);

console.log("=== arion.site columns ===");
const siteCols = await pool.request().query(`
  SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='site'
  ORDER BY ORDINAL_POSITION
`);
console.table(siteCols.recordset);

console.log("=== arion.tenant columns ===");
const tenantCols = await pool.request().query(`
  SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='tenant'
  ORDER BY ORDINAL_POSITION
`);
console.table(tenantCols.recordset);

await pool.close();
