import sql from "mssql";
import crypto from "node:crypto";
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
const currentPluginToken = "6dfb76a0-0d66-4385-b184-79e5726600e6";
const hash = crypto.createHash("sha256").update(currentPluginToken).digest("hex");

const result = await pool.request()
  .input("siteId", sql.UniqueIdentifier, siteId)
  .input("hash", sql.NVarChar(64), hash)
  .query(`
    UPDATE arion.site
    SET site_token_hash = @hash,
        site_token_last_rotated = SYSDATETIMEOFFSET(),
        plugin_last_status_at = SYSDATETIMEOFFSET()
    OUTPUT inserted.site_token_hash, inserted.site_token_last_rotated
    WHERE site_id = @siteId
  `);

console.log("Token hash synced to match plugin's current UUID.");
console.table(result.recordset);
await pool.close();
