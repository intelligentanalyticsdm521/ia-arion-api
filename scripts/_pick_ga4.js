import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

const credential = new AzureCliCredential();
const kv = new SecretClient("https://kv-iadm-prod.vault.azure.net/", credential);
process.env.GOOGLE_OAUTH_CLIENT_ID = (await kv.getSecret("ARION-GOOGLE-OAUTH-CLIENT-ID")).value;
process.env.GOOGLE_OAUTH_CLIENT_SECRET = (await kv.getSecret("ARION-GOOGLE-OAUTH-CLIENT-SECRET")).value;
const { getAccessToken } = await import("../lib/googleBusiness.js");

const token = await credential.getToken("https://database.windows.net/.default");
const pool = await new sql.ConnectionPool({
  server: "sql-iadm-prod-cus.database.windows.net", database: "iadm_services",
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();

const SITE = '64C43F2F-B4FE-40C2-B023-0F06F7D275FA';
const r = await pool.request().query(`SELECT gbp_oauth_token_ref, domain FROM arion.site WHERE site_id = '${SITE}'`);
const tokenData = await getAccessToken(r.recordset[0].gbp_oauth_token_ref);
const accessToken = tokenData.access_token;
const siteHost = String(r.recordset[0].domain).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');

const ga4Res = await fetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries', { headers: { Authorization: 'Bearer ' + accessToken } });
const data = await ga4Res.json();
const props = [];
for (const acct of (data.accountSummaries || [])) {
  for (const p of (acct.propertySummaries || [])) {
    props.push({ propertyId: p.property.replace('properties/', ''), displayName: p.displayName });
  }
}

const cleanHost = siteHost.toLowerCase().replace(/[^a-z0-9]/g, '');
console.log("Properties:");
for (const p of props) {
  const cleanDn = (p.displayName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const matches = cleanDn && (cleanHost.includes(cleanDn) || cleanDn.includes(cleanHost));
  console.log(`  ${matches ? '✓' : ' '} ${p.propertyId} — "${p.displayName}"`);
}

const ga4Pick = props.find(p => {
  const cleanDn = (p.displayName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return cleanDn && (cleanHost.includes(cleanDn) || cleanDn.includes(cleanHost));
});
if (ga4Pick) {
  await pool.request()
    .input('siteId', sql.UniqueIdentifier, SITE)
    .input('ga4PropertyId', sql.NVarChar(40), ga4Pick.propertyId)
    .query('UPDATE arion.site SET ga4_property_id = @ga4PropertyId WHERE site_id = @siteId');
  console.log(`\n✓ Saved ${ga4Pick.propertyId} (${ga4Pick.displayName})`);
}
await pool.close();
