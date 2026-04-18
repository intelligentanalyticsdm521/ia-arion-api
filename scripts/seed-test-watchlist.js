/**
 * Seed the test site's Market Monitor watchlist.
 *
 * Target: intelligentanalyticsdm.com / site_id 64C43F2F-B4FE-40C2-B023-0F06F7D275FA
 *
 * Usage:
 *   node scripts/seed-test-watchlist.js
 *
 * Will also bump the site's seo_addon_tier to 'authority' if it isn't already,
 * so the Market Monitor feature is unlocked for testing.
 */
import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";

const SERVER = process.env.SQL_SERVER || "sql-iadm-prod-cus.database.windows.net";
const DATABASE = process.env.SQL_DATABASE || "iadm_services";
const TENANT_ID = "8c9527b9-8999-4b31-a306-f3d4ccc39fbd";
const SITE_ID = "64C43F2F-B4FE-40C2-B023-0F06F7D275FA";

// Curated watchlist — 10 own + 20 competitor. Competitors drawn from the
// SE Ranking project's tracked set: bluecompass.com, visionary.com,
// webspec.com, studiojasolutions.com, aureon.com. Allocation 7-5-3-3-2 =
// 20 competitor pages.
const OWN_PAGES = [
  "https://intelligentanalyticsdm.com/",
  "https://intelligentanalyticsdm.com/services/",
  "https://intelligentanalyticsdm.com/services/data-analytics/",
  "https://intelligentanalyticsdm.com/services/seo/",
  "https://intelligentanalyticsdm.com/services/web-development/",
  "https://intelligentanalyticsdm.com/about/",
  "https://intelligentanalyticsdm.com/contact/",
  "https://intelligentanalyticsdm.com/blog/",
  "https://intelligentanalyticsdm.com/case-studies/",
  "https://intelligentanalyticsdm.com/pricing/",
];

const COMPETITOR_PAGES = [
  // Primary rival — bluecompass (7 pages)
  ["https://bluecompass.com/",                                    "bluecompass.com"],
  ["https://bluecompass.com/services/",                           "bluecompass.com"],
  ["https://bluecompass.com/services/seo/",                       "bluecompass.com"],
  ["https://bluecompass.com/services/web-design/",                "bluecompass.com"],
  ["https://bluecompass.com/services/digital-marketing/",         "bluecompass.com"],
  ["https://bluecompass.com/about/",                              "bluecompass.com"],
  ["https://bluecompass.com/blog/",                               "bluecompass.com"],
  // Secondary rival — visionary (5 pages)
  ["https://visionary.com/",                                      "visionary.com"],
  ["https://visionary.com/services/",                             "visionary.com"],
  ["https://visionary.com/work/",                                 "visionary.com"],
  ["https://visionary.com/about/",                                "visionary.com"],
  ["https://visionary.com/insights/",                             "visionary.com"],
  // Tertiary — webspec (3 pages)
  ["https://www.webspec.com/",                                    "webspec.com"],
  ["https://www.webspec.com/services/",                           "webspec.com"],
  ["https://www.webspec.com/blog/",                               "webspec.com"],
  // Tertiary — studiojasolutions (3 pages)
  ["https://studiojasolutions.com/",                              "studiojasolutions.com"],
  ["https://studiojasolutions.com/services/",                     "studiojasolutions.com"],
  ["https://studiojasolutions.com/work/",                         "studiojasolutions.com"],
  // Watchlist — aureon (2 pages)
  ["https://aureon.com/",                                         "aureon.com"],
  ["https://aureon.com/services/",                                "aureon.com"],
];

const credential = new AzureCliCredential();
const token = await credential.getToken("https://database.windows.net/.default");

const pool = await new sql.ConnectionPool({
  server: SERVER,
  database: DATABASE,
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();

// Confirm tier
const siteRes = await pool.request()
  .input("siteId", sql.UniqueIdentifier, SITE_ID)
  .query(`SELECT domain, seo_addon_tier FROM arion.site WHERE site_id = @siteId`);
const site = siteRes.recordset[0];
if (!site) throw new Error("Site not found");
console.log(`[seed] site=${site.domain} tier=${site.seo_addon_tier}`);

if ((site.seo_addon_tier || "").toLowerCase() !== "authority") {
  console.log(`[seed] bumping seo_addon_tier to 'authority' for testing...`);
  await pool.request()
    .input("siteId", sql.UniqueIdentifier, SITE_ID)
    .query(`UPDATE arion.site SET seo_addon_tier = 'authority', updated_at = SYSDATETIMEOFFSET() WHERE site_id = @siteId`);
}

// Wipe any existing watchlist rows
const del = await pool.request()
  .input("siteId", sql.UniqueIdentifier, SITE_ID)
  .query(`DELETE FROM arion.site_page_watch WHERE site_id = @siteId`);
console.log(`[seed] cleared ${del.rowsAffected[0]} existing row(s)`);

// Insert own pages
for (const url of OWN_PAGES) {
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
console.log(`[seed] inserted ${OWN_PAGES.length} own-site page(s)`);

// Insert competitor pages
for (const [url, domain] of COMPETITOR_PAGES) {
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
console.log(`[seed] inserted ${COMPETITOR_PAGES.length} competitor page(s)`);

// Summary
const summary = await pool.request()
  .input("siteId", sql.UniqueIdentifier, SITE_ID)
  .query(`
    SELECT page_type, COUNT(*) AS n
    FROM arion.site_page_watch
    WHERE site_id = @siteId
    GROUP BY page_type
  `);
for (const r of summary.recordset) console.log(`[seed] ${r.page_type}: ${r.n}`);

await pool.close();
console.log("[seed] done");
