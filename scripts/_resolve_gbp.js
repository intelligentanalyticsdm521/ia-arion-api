import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";
import { resolveGbpLocationName, fetchBusinessInfo } from "../lib/gbpApi.js";
import { getAccessToken } from "../lib/googleBusiness.js";

const credential = new AzureCliCredential();
const token = await credential.getToken("https://database.windows.net/.default");
const pool = await new sql.ConnectionPool({
  server: "sql-iadm-prod-cus.database.windows.net",
  database: "iadm_services",
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();

const SITE = '64C43F2F-B4FE-40C2-B023-0F06F7D275FA';
const TENANT = '8c9527b9-8999-4b31-a306-f3d4ccc39fbd';

const r = await pool.request().query(`SELECT gbp_oauth_token_ref, gbp_location_name FROM arion.site WHERE site_id = '${SITE}'`);
const refreshToken = r.recordset[0].gbp_oauth_token_ref;

console.log("Step 1: Get access token from refresh token...");
const tokenData = await getAccessToken(refreshToken);
if (!tokenData) { console.log("✗ Token refresh failed"); process.exit(1); }
console.log("✓ Got access token (length:", tokenData.access_token?.length, ")");

console.log("\nStep 2: List GBP accounts...");
try {
  const locName = await resolveGbpLocationName(tokenData.access_token);
  if (!locName) {
    console.log("✗ No locations found under your account");
  } else {
    console.log(`✓ Resolved location: ${locName}`);
    // Save it
    await pool.request()
      .input('siteId', sql.UniqueIdentifier, SITE)
      .input('tenantId', sql.UniqueIdentifier, TENANT)
      .input('locationName', sql.NVarChar(200), locName)
      .query('UPDATE arion.site SET gbp_location_name = @locationName WHERE site_id = @siteId AND tenant_id = @tenantId');
    console.log("✓ Saved gbp_location_name to DB");

    console.log("\nStep 3: Fetch full business info...");
    const info = await fetchBusinessInfo(refreshToken, locName);
    if (info.error) {
      console.log("✗ fetchBusinessInfo error:", info.error);
    } else {
      console.log("✓ Got business info:");
      console.log("  Title:", info.location?.title);
      console.log("  Address:", JSON.stringify(info.location?.storefrontAddress));
      console.log("  Phone:", info.location?.phoneNumbers?.primaryPhone);
      console.log("  Website:", info.location?.websiteUri);
      console.log("  Categories:", JSON.stringify(info.location?.categories));
    }
  }
} catch (err) {
  console.log("✗ Error:", err.message);
  console.log("  code:", err.code);
  console.log("  status:", err.status);
}

await pool.close();
