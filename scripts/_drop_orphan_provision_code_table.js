// One-off: drop the orphan arion.provision_code table (if it exists). The
// onboard-client wizard previously created this stray table via inline DDL
// — wrong schema and wrong name (canonical is arion.site_provision_code).
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

const exists = await pool.request().query(`
  SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = 'arion' AND TABLE_NAME = 'provision_code'
`);
if (exists.recordset.length === 0) {
  console.log("✓ No orphan arion.provision_code table — nothing to drop.");
} else {
  const rowCount = (await pool.request().query("SELECT COUNT(*) AS n FROM arion.provision_code")).recordset[0].n;
  console.log(`Dropping orphan arion.provision_code (${rowCount} row(s))...`);
  await pool.request().batch("DROP TABLE arion.provision_code");
  console.log("✓ Dropped.");
}
await pool.close();
