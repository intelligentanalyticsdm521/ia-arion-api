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

const SITE = '64C43F2F-B4FE-40C2-B023-0F06F7D275FA';

// Check site row for GBP fields
console.log("Site GBP-related columns:");
const cols = await pool.request().query(`
  SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='site'
    AND (COLUMN_NAME LIKE '%gbp%' OR COLUMN_NAME LIKE '%google%' OR COLUMN_NAME LIKE '%business%')
`);
console.table(cols.recordset);

// Get site's GBP state
const site = await pool.request().query(`SELECT * FROM arion.site WHERE site_id = '${SITE}'`);
const row = site.recordset[0];
const gbpFields = {};
for (const [k, v] of Object.entries(row)) {
  if (k.includes('gbp') || k.includes('google') || k.includes('business')) gbpFields[k] = v;
}
console.log("\nSite GBP state:");
console.table([gbpFields]);

// Check connected_account / oauth tables
const tables = await pool.request().query(`
  SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = 'arion'
    AND (TABLE_NAME LIKE '%oauth%' OR TABLE_NAME LIKE '%google%' OR TABLE_NAME LIKE '%account%' OR TABLE_NAME LIKE '%integration%' OR TABLE_NAME LIKE '%connect%')
`);
console.log("\nConnection-related tables:");
console.table(tables.recordset);

await pool.close();
