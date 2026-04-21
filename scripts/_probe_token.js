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

const row = await pool.request().query(`
  SELECT site_id, domain, site_token_hash, site_token_last_rotated
  FROM arion.site WHERE site_id = '${siteId}'
`);
const storedHash = row.recordset[0]?.site_token_hash;
console.log("ARION stored hash:", storedHash);
console.log("Last rotated:", row.recordset[0]?.site_token_last_rotated);

// The plugin shows token prefix "9f59bdbd" and suffix "ed86".
// We can't know the full token, but we CAN hash known-candidate tokens:
const candidates = [
  "6dfb76a0-0d66-4385-b184-79e5726600e6", // the UUID from Apply IA Test Config
];
for (const c of candidates) {
  const h = crypto.createHash("sha256").update(c).digest("hex");
  console.log(`candidate "${c}" → ${h}  ${h === storedHash ? '← MATCH' : ''}`);
}

// Recent provision codes (redeemed implies fresh token was generated)
const codes = await pool.request().query(`
  SELECT code_id, created_at, redeemed_at, redeemed_from_url
  FROM arion.site_provision_code
  WHERE site_id = '${siteId}' AND redeemed_at IS NOT NULL
  ORDER BY redeemed_at DESC
`);
console.log("\nRedeemed provision codes (most recent first):");
console.table(codes.recordset);

await pool.close();
