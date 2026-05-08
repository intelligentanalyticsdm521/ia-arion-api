import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

const credential = new AzureCliCredential();
const kv = new SecretClient("https://kv-iadm-prod.vault.azure.net/", credential);
process.env.GOOGLE_OAUTH_CLIENT_ID = (await kv.getSecret("ARION-GOOGLE-OAUTH-CLIENT-ID")).value;
process.env.GOOGLE_OAUTH_CLIENT_SECRET = (await kv.getSecret("ARION-GOOGLE-OAUTH-CLIENT-SECRET")).value;

const { listAllGbpLocations } = await import("../lib/gbpApi.js");
const { getAccessToken } = await import("../lib/googleBusiness.js");

const token = await credential.getToken("https://database.windows.net/.default");
const pool = await new sql.ConnectionPool({
  server: "sql-iadm-prod-cus.database.windows.net",
  database: "iadm_services",
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();

const SITE = '64C43F2F-B4FE-40C2-B023-0F06F7D275FA';
const r = await pool.request().query(`SELECT gbp_oauth_token_ref, domain FROM arion.site WHERE site_id = '${SITE}'`);
const refreshToken = r.recordset[0].gbp_oauth_token_ref;
const siteDomain = r.recordset[0].domain;
const siteHost = String(siteDomain).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');

if (!refreshToken) { console.log("✗ No refresh token — user needs to re-OAuth"); process.exit(1); }

const tokenData = await getAccessToken(refreshToken);
const accessToken = tokenData.access_token;
console.log("✓ Got fresh access token");

console.log("\n─── GBP locations ───");
const locations = await listAllGbpLocations(accessToken, siteDomain);
console.log(`Found ${locations.length} location(s):`);
for (const loc of locations) {
  console.log(`  • ${loc.title} | ${loc.website_uri || 'no website'} | match=${loc.match_score}`);
}

const exactMatches = locations.filter(l => l.match_score >= 1.0);
let pick = null;
if (locations.length === 1) pick = locations[0];
else if (exactMatches.length === 1) pick = exactMatches[0];

if (pick) {
  await pool.request()
    .input('siteId', sql.UniqueIdentifier, SITE)
    .input('locationName', sql.NVarChar(200), pick.location_name)
    .query('UPDATE arion.site SET gbp_location_name = @locationName WHERE site_id = @siteId');
  console.log(`\n✓ Auto-picked: ${pick.title}`);
} else {
  console.log(`\n⚠ Multiple locations + multiple/no domain matches → user must pick manually in Portal`);
}

console.log("\n─── GA4 properties ───");
const ga4Res = await fetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries', { headers: { Authorization: 'Bearer ' + accessToken } });
if (ga4Res.ok) {
  const data = await ga4Res.json();
  const props = [];
  for (const acct of (data.accountSummaries || [])) {
    for (const p of (acct.propertySummaries || [])) {
      props.push({ propertyId: p.property.replace('properties/', ''), displayName: p.displayName });
    }
  }
  console.log(`Found ${props.length} GA4 property:`);
  for (const p of props) console.log(`  • ${p.displayName}`);
  const ga4Match = props.find(p => (p.displayName || '').toLowerCase().includes(siteHost.toLowerCase()));
  const ga4Pick = ga4Match || (props.length === 1 ? props[0] : null);
  if (ga4Pick) {
    await pool.request()
      .input('siteId', sql.UniqueIdentifier, SITE)
      .input('ga4PropertyId', sql.NVarChar(40), ga4Pick.propertyId)
      .query('UPDATE arion.site SET ga4_property_id = @ga4PropertyId WHERE site_id = @siteId');
    console.log(`✓ Auto-picked GA4: ${ga4Pick.displayName}`);
  }
}

console.log("\n─── GSC sites ───");
const gscRes = await fetch('https://www.googleapis.com/webmasters/v3/sites', { headers: { Authorization: 'Bearer ' + accessToken } });
if (gscRes.ok) {
  const data = await gscRes.json();
  const sites = (data.siteEntry || []).map(s => ({ siteUrl: s.siteUrl }));
  console.log(`Found ${sites.length} GSC site:`);
  for (const s of sites) console.log(`  • ${s.siteUrl}`);
  const gscMatch = sites.find(s => {
    const sHost = String(s.siteUrl || '').replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
    return sHost === siteHost;
  });
  const gscPick = gscMatch || (sites.length === 1 ? sites[0] : null);
  if (gscPick) {
    await pool.request()
      .input('siteId', sql.UniqueIdentifier, SITE)
      .input('gscSiteUrl', sql.NVarChar(500), gscPick.siteUrl)
      .query('UPDATE arion.site SET gsc_site_url = @gscSiteUrl WHERE site_id = @siteId');
    console.log(`✓ Auto-picked GSC: ${gscPick.siteUrl}`);
  }
}

await pool.close();
