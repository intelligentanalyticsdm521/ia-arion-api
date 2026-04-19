/**
 * Re-seed the test site watchlist with URLs verified live via HEAD check.
 *
 * Changes vs seed-test-watchlist.js:
 *   - HEAD each URL, discard any that return non-200
 *   - Use simpler, more canonical URLs (homepage, primary sections)
 *   - Keep 10 own + 20 competitor pool
 */
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

const TENANT_ID = "8c9527b9-8999-4b31-a306-f3d4ccc39fbd";
const SITE_ID = "64C43F2F-B4FE-40C2-B023-0F06F7D275FA";

// Candidate pages — we'll HEAD-check each and keep the first N that work.
const OWN_CANDIDATES = [
  "https://intelligentanalyticsdm.com/",
  "https://intelligentanalyticsdm.com/about",
  "https://intelligentanalyticsdm.com/about/",
  "https://intelligentanalyticsdm.com/contact",
  "https://intelligentanalyticsdm.com/contact/",
  "https://intelligentanalyticsdm.com/services",
  "https://intelligentanalyticsdm.com/services/",
  "https://intelligentanalyticsdm.com/blog",
  "https://intelligentanalyticsdm.com/blog/",
  "https://intelligentanalyticsdm.com/case-studies",
  "https://intelligentanalyticsdm.com/case-studies/",
  "https://intelligentanalyticsdm.com/pricing",
  "https://intelligentanalyticsdm.com/arion",
  "https://intelligentanalyticsdm.com/oliver",
  "https://intelligentanalyticsdm.com/data-analytics",
  "https://intelligentanalyticsdm.com/web-development",
  "https://intelligentanalyticsdm.com/seo-services",
];

const COMP_CANDIDATES = [
  // bluecompass — target 7
  ["https://bluecompass.com/", "bluecompass.com"],
  ["https://bluecompass.com/about", "bluecompass.com"],
  ["https://bluecompass.com/about/", "bluecompass.com"],
  ["https://bluecompass.com/services", "bluecompass.com"],
  ["https://bluecompass.com/services/", "bluecompass.com"],
  ["https://bluecompass.com/work", "bluecompass.com"],
  ["https://bluecompass.com/work/", "bluecompass.com"],
  ["https://bluecompass.com/contact", "bluecompass.com"],
  ["https://bluecompass.com/insights", "bluecompass.com"],
  ["https://bluecompass.com/insights/", "bluecompass.com"],
  ["https://bluecompass.com/blog", "bluecompass.com"],
  ["https://bluecompass.com/blog/", "bluecompass.com"],
  // visionary — target 5
  ["https://visionary.com/", "visionary.com"],
  ["https://www.visionary.com/", "visionary.com"],
  ["https://visionary.com/about", "visionary.com"],
  ["https://visionary.com/services", "visionary.com"],
  ["https://visionary.com/work", "visionary.com"],
  ["https://visionary.com/contact", "visionary.com"],
  ["https://visionary.com/blog", "visionary.com"],
  // webspec — target 3
  ["https://www.webspec.com/", "webspec.com"],
  ["https://webspec.com/", "webspec.com"],
  ["https://www.webspec.com/about", "webspec.com"],
  ["https://www.webspec.com/services", "webspec.com"],
  ["https://www.webspec.com/work", "webspec.com"],
  ["https://www.webspec.com/blog", "webspec.com"],
  ["https://www.webspec.com/contact", "webspec.com"],
  // studiojasolutions — target 3
  ["https://studiojasolutions.com/", "studiojasolutions.com"],
  ["https://www.studiojasolutions.com/", "studiojasolutions.com"],
  ["https://studiojasolutions.com/about", "studiojasolutions.com"],
  ["https://studiojasolutions.com/services", "studiojasolutions.com"],
  ["https://studiojasolutions.com/work", "studiojasolutions.com"],
  ["https://studiojasolutions.com/portfolio", "studiojasolutions.com"],
  // aureon — target 2
  ["https://aureon.com/", "aureon.com"],
  ["https://www.aureon.com/", "aureon.com"],
  ["https://aureon.com/about", "aureon.com"],
  ["https://aureon.com/services", "aureon.com"],
  ["https://aureon.com/solutions", "aureon.com"],
];

async function checkUrl(url) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    // Try HEAD first, fall back to GET if server rejects HEAD
    let r = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
    if (r.status === 405 || r.status === 403) {
      r = await fetch(url, { method: "GET", redirect: "follow", signal: controller.signal });
    }
    clearTimeout(t);
    return { ok: r.ok, status: r.status, finalUrl: r.url };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

console.log("Verifying own-site URLs...");
const ownVerified = [];
for (const u of OWN_CANDIDATES) {
  if (ownVerified.length >= 10) break;
  const r = await checkUrl(u);
  console.log(`  ${r.status === 200 ? "✓" : "✗"} ${r.status} ${u}`);
  if (r.status === 200) {
    // Dedupe on canonicalized URL (trailing slash)
    const canonical = r.finalUrl || u;
    if (!ownVerified.some((x) => x === canonical)) ownVerified.push(canonical);
  }
}

console.log("\nVerifying competitor URLs...");
const compPerDomain = new Map();
const TARGETS = { "bluecompass.com": 7, "visionary.com": 5, "webspec.com": 3, "studiojasolutions.com": 3, "aureon.com": 2 };
for (const [domain, _] of Object.entries(TARGETS)) compPerDomain.set(domain, []);

for (const [u, domain] of COMP_CANDIDATES) {
  const list = compPerDomain.get(domain);
  if (list.length >= TARGETS[domain]) continue;
  const r = await checkUrl(u);
  console.log(`  ${r.status === 200 ? "✓" : "✗"} ${r.status} ${u}`);
  if (r.status === 200) {
    const canonical = r.finalUrl || u;
    if (!list.some((x) => x === canonical)) list.push(canonical);
  }
}

const compVerified = [];
for (const [domain, urls] of compPerDomain) {
  for (const u of urls) compVerified.push([u, domain]);
}

console.log(`\nVerified ${ownVerified.length}/10 own, ${compVerified.length}/20 competitor`);

// Wipe and re-insert
await pool.request()
  .input("siteId", sql.UniqueIdentifier, SITE_ID)
  .query(`DELETE FROM arion.site_page_watch WHERE site_id = @siteId`);

for (const url of ownVerified) {
  await pool.request()
    .input("tenantId", sql.UniqueIdentifier, TENANT_ID)
    .input("siteId", sql.UniqueIdentifier, SITE_ID)
    .input("pageUrl", sql.NVarChar(1000), url)
    .input("pageType", sql.NVarChar(40), "own_site")
    .query(`
      INSERT INTO arion.site_page_watch (tenant_id, site_id, page_url, page_type, enabled)
      VALUES (@tenantId, @siteId, @pageUrl, @pageType, 1)
    `);
}
for (const [url, domain] of compVerified) {
  await pool.request()
    .input("tenantId", sql.UniqueIdentifier, TENANT_ID)
    .input("siteId", sql.UniqueIdentifier, SITE_ID)
    .input("pageUrl", sql.NVarChar(1000), url)
    .input("pageType", sql.NVarChar(40), "competitor")
    .input("compDomain", sql.NVarChar(300), domain)
    .query(`
      INSERT INTO arion.site_page_watch (tenant_id, site_id, page_url, page_type, competitor_domain, enabled)
      VALUES (@tenantId, @siteId, @pageUrl, @pageType, @compDomain, 1)
    `);
}

await pool.close();
console.log(`\n✓ Re-seeded watchlist: ${ownVerified.length} own + ${compVerified.length} competitor = ${ownVerified.length + compVerified.length} total`);
