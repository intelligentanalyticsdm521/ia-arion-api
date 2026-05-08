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
console.log("Clearing GBP connection for intelligentanalyticsdm.com site...");
await pool.request().input('siteId', sql.UniqueIdentifier, SITE).query(`
  UPDATE arion.site
  SET gbp_connected = 0,
      gbp_oauth_token_ref = NULL,
      gbp_location_name = NULL,
      gbp_place_id = NULL
  WHERE site_id = @siteId
`);
const r = await pool.request().query(`
  SELECT gbp_connected, gbp_oauth_token_ref, gbp_location_name FROM arion.site WHERE site_id = '${SITE}'
`);
console.table(r.recordset);
console.log("✓ GBP cleared. Site needs to re-OAuth + pick correct location.");
await pool.close();
