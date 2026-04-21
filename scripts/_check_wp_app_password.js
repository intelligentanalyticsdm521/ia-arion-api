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

const siteId = "64C43F2F-B4FE-40C2-B023-0F06F7D275FA";

const row = await pool.request().query(`
  SELECT site_id, domain, wp_admin_url, wp_app_password_ref,
         CASE WHEN wp_app_password_ref IS NULL THEN 'NULL'
              WHEN wp_app_password_ref = '' THEN 'EMPTY'
              ELSE 'SET (length ' + CAST(LEN(wp_app_password_ref) AS VARCHAR) + ')'
         END as app_password_status,
         site_token_hash,
         plugin_status
  FROM arion.site WHERE site_id = '${siteId}'
`);
console.log("Site auth-config state:");
console.table(row.recordset);

await pool.close();
