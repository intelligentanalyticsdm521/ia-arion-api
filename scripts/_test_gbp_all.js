import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

const credential = new AzureCliCredential();
const kv = new SecretClient("https://kv-iadm-prod.vault.azure.net/", credential);
process.env.GOOGLE_OAUTH_CLIENT_ID = (await kv.getSecret("ARION-GOOGLE-OAUTH-CLIENT-ID")).value;
process.env.GOOGLE_OAUTH_CLIENT_SECRET = (await kv.getSecret("ARION-GOOGLE-OAUTH-CLIENT-SECRET")).value;

const { fetchReviews, fetchLocalPosts, fetchPerformance, summarizePerformance, fetchQuestions } = await import("../lib/gbpApi.js");

const token = await credential.getToken("https://database.windows.net/.default");
const pool = await new sql.ConnectionPool({
  server: "sql-iadm-prod-cus.database.windows.net",
  database: "iadm_services",
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();

const SITE = '64C43F2F-B4FE-40C2-B023-0F06F7D275FA';
const r = await pool.request().query(`SELECT gbp_oauth_token_ref, gbp_location_name FROM arion.site WHERE site_id = '${SITE}'`);
const refreshToken = r.recordset[0].gbp_oauth_token_ref;
const locationName = r.recordset[0].gbp_location_name;
console.log(`Using location: ${locationName}\n`);

// Reviews
console.log("─── Reviews ───");
try {
  const rev = await fetchReviews(refreshToken, locationName);
  if (rev.error) console.log("✗", rev.error);
  else {
    console.log(`✓ ${rev.totalReviewCount || 0} total reviews, avg ${rev.averageRating || 'n/a'}`);
    console.log(`  ${(rev.reviews || []).length} returned`);
    if (rev.reviews?.[0]) {
      const r0 = rev.reviews[0];
      console.log(`  most recent: ${r0.starRating} stars, "${(r0.comment || '').slice(0, 60)}..."`);
    }
  }
} catch (e) { console.log("✗ exception:", e.message); }

// Posts
console.log("\n─── Local Posts ───");
try {
  const posts = await fetchLocalPosts(refreshToken, locationName);
  if (posts.error) console.log("✗", posts.error);
  else console.log(`✓ ${(posts.posts || []).length} posts`);
} catch (e) { console.log("✗ exception:", e.message); }

// Performance
console.log("\n─── Performance (30d) ───");
try {
  const perf = await fetchPerformance(refreshToken, locationName, 30);
  if (perf.error) console.log("✗", perf.error);
  else {
    const s = summarizePerformance(perf);
    console.log(`✓ Impressions: ${s.totals?.impressions || 0}`);
    console.log(`  Website clicks: ${s.totals?.websiteClicks || 0}`);
    console.log(`  Calls: ${s.totals?.calls || 0}`);
    console.log(`  Direction requests: ${s.totals?.directionRequests || 0}`);
  }
} catch (e) { console.log("✗ exception:", e.message); }

// Q&A
console.log("\n─── Questions & Answers ───");
try {
  const qna = await fetchQuestions(refreshToken, locationName);
  if (qna.error) console.log("✗", qna.error);
  else console.log(`✓ ${(qna.questions || []).length} questions`);
} catch (e) { console.log("✗ exception:", e.message); }

await pool.close();
