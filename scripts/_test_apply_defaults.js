import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";
import { plugin as pluginApi } from "../lib/pluginClient.js";

const credential = new AzureCliCredential();
const token = await credential.getToken("https://database.windows.net/.default");
const pool = await new sql.ConnectionPool({
  server: "sql-iadm-prod-cus.database.windows.net",
  database: "iadm_services",
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();

const SITE = '64C43F2F-B4FE-40C2-B023-0F06F7D275FA';

const result = await pool.request().query(`
  SELECT site_id, tenant_id, domain, site_token_raw, wp_admin_url, wp_app_password_ref
  FROM arion.site WHERE site_id = '${SITE}'
`);
const site = result.recordset[0];
console.log("Site loaded:", { domain: site.domain, has_token: !!site.site_token_raw });

console.log("\n→ Calling plugin /onboarding/apply-defaults directly...");
const r = await pluginApi.applyIADefaults(site);
console.log("Plugin response:");
console.log("  ok:", r.ok);
console.log("  status:", r.pluginStatus);
console.log("  errors:", JSON.stringify(r.errors));
if (r.data?.results) {
  console.log("  results per plugin:");
  for (const [name, res] of Object.entries(r.data.results)) {
    console.log(`    ${name}: ${JSON.stringify(res)}`);
  }
}

console.log("\n→ Now reading current LiteSpeed config...");
const ls = await pluginApi.litespeedConfigGet(site);
console.log("LiteSpeed config (first 5 keys):");
const cfg = ls.data?.current || {};
let i = 0;
for (const [k, v] of Object.entries(cfg)) {
  console.log(`  ${k}: ${JSON.stringify(v)}`);
  if (++i >= 8) break;
}

await pool.close();
