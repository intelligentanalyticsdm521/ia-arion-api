import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

// Load OAuth secrets from Key Vault
const credential = new AzureCliCredential();
const kvClient = new SecretClient("https://kv-iadm-prod.vault.azure.net/", credential);
process.env.GOOGLE_OAUTH_CLIENT_ID = (await kvClient.getSecret("ARION-GOOGLE-OAUTH-CLIENT-ID")).value;
process.env.GOOGLE_OAUTH_CLIENT_SECRET = (await kvClient.getSecret("ARION-GOOGLE-OAUTH-CLIENT-SECRET")).value;
console.log("✓ Loaded OAuth creds from Key Vault");

const { resolveGbpLocationName, fetchBusinessInfo } = await import("../lib/gbpApi.js");
const { getAccessToken } = await import("../lib/googleBusiness.js");

const token = await credential.getToken("https://database.windows.net/.default");
const pool = await new sql.ConnectionPool({
  server: "sql-iadm-prod-cus.database.windows.net",
  database: "iadm_services",
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();

const SITE = '64C43F2F-B4FE-40C2-B023-0F06F7D275FA';
const TENANT = '8c9527b9-8999-4b31-a306-f3d4ccc39fbd';

const r = await pool.request().query(`SELECT gbp_oauth_token_ref FROM arion.site WHERE site_id = '${SITE}'`);
const refreshToken = r.recordset[0].gbp_oauth_token_ref;

console.log("\nStep 1: Refresh access token...");
const tokenData = await getAccessToken(refreshToken);
if (!tokenData) { console.log("✗ Token refresh failed"); process.exit(1); }
console.log("✓ Got fresh access token");

console.log("\nStep 2: Resolve GBP location (calls accounts + locations APIs)...");
try {
  const locName = await resolveGbpLocationName(tokenData.access_token);
  if (!locName) {
    console.log("✗ No locations found");
  } else {
    console.log(`✓ Location: ${locName}`);
    await pool.request()
      .input('siteId', sql.UniqueIdentifier, SITE)
      .input('tenantId', sql.UniqueIdentifier, TENANT)
      .input('locationName', sql.NVarChar(200), locName)
      .query('UPDATE arion.site SET gbp_location_name = @locationName WHERE site_id = @siteId AND tenant_id = @tenantId');
    console.log("✓ Saved to DB");

    console.log("\nStep 3: Fetch business info...");
    const info = await fetchBusinessInfo(refreshToken, locName);
    if (info.error) {
      console.log("✗ Error:", info.error);
    } else {
      console.log("✓ Business info:");
      console.log("  Title:", info.location?.title);
      console.log("  Address:", JSON.stringify(info.location?.storefrontAddress, null, 2));
      console.log("  Phone:", info.location?.phoneNumbers?.primaryPhone);
      console.log("  Website:", info.location?.websiteUri);
      console.log("  Categories:", info.location?.categories?.primaryCategory?.displayName);
    }
  }
} catch (err) {
  console.log("✗ Error:", err.message);
  console.log("  HTTP status:", err.status);
  console.log("  code:", err.code);
  if (err.body) console.log("  body:", JSON.stringify(err.body).slice(0, 500));
}

await pool.close();
