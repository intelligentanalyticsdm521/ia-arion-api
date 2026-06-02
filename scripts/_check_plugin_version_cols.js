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

console.log("Columns on arion.plugin_version:");
console.table((await pool.request().query(`
  SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='plugin_version'
  ORDER BY ORDINAL_POSITION
`)).recordset);

console.log("\nCurrent rows:");
console.table((await pool.request().query(`SELECT * FROM arion.plugin_version ORDER BY channel`)).recordset);

await pool.close();
