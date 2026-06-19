// One-off cleanup — Brandon's IA tenant has a stray ARION site with
// a test/example domain that shows up in the ACTIVE SITE dropdown.
// Earlier RCA assumed domain='test-site@example.com'; actual value
// is likely 'test-site.example.com'. This script searches for ALL
// plausible test rows on Brandon's tenant, prints them, and deletes
// after confirming with the operator (set CONFIRM=1 env var).
import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";

const SQL_SCOPE = "https://database.windows.net/.default";
const server = "sql-iadm-prod-cus.database.windows.net";
const IA_TENANT_ID = "8C9527B9-8999-4B31-A306-F3D4CCC39FBD";

const cred = new AzureCliCredential();
const token = await cred.getToken(SQL_SCOPE);
const pool = await sql.connect({
  server, database: "iadm_services",
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
});

console.log("=== Searching arion.site for test/example rows on IA tenant ===");
const found = await pool.request()
  .input("tid", sql.UniqueIdentifier, IA_TENANT_ID)
  .query(`
    SELECT site_id, tenant_id, domain, status, provisioning_state,
           wp_admin_url, arion_tier, created_at, updated_at
      FROM arion.site
     WHERE tenant_id = @tid
       AND (
         domain LIKE '%test-site%' OR
         domain LIKE '%test_site%' OR
         domain LIKE '%example.com%' OR
         domain LIKE '%example.org%' OR
         domain LIKE '%@%' OR
         domain IS NULL OR
         domain = ''
       )
     ORDER BY created_at DESC;
  `);
console.table(found.recordset);

if (!found.recordset.length) {
  console.log("\nNothing matched. Maybe the dropdown shows it via stale local cache only — clear localStorage and reload.");
  await pool.close();
  process.exit(0);
}

if (process.env.CONFIRM !== "1") {
  console.log("\nDRY RUN. Set CONFIRM=1 env var to delete the row(s) above.");
  await pool.close();
  process.exit(0);
}

for (const row of found.recordset) {
  const siteId = row.site_id;
  console.log(`\n→ Deleting site_id ${siteId} (domain: ${row.domain || "<empty>"}) ...`);
  const childTables = [
    "arion.site_provision_code",
    "arion.site_page_watch",
    "arion.site_page_change",
    "arion.site_form_submission",
    "arion.site_form_config",
    "arion.site_booking_request",
    "arion.site_access_log",
    "arion.site_content_change",
    "arion.site_content_event",
    "arion.site_security_event",
    "arion.site_page_view",
    "arion.site_pagespeed_snapshot",
    "arion.site_plugin_inventory",
    "arion.site_plugin_snapshot",
    "arion.site_plugin_update_log",
    "arion.site_integration_status",
    "arion.site_woo_order",
    "arion.signup_session",
    "arion.provisioning_job",
  ];
  let total = 0;
  for (const tbl of childTables) {
    try {
      const r = await pool.request()
        .input("siteId", sql.UniqueIdentifier, siteId)
        .query(`DELETE FROM ${tbl} WHERE site_id = @siteId;`);
      if (r.rowsAffected[0] > 0) {
        console.log(`    cleared ${tbl}: ${r.rowsAffected[0]} row(s)`);
        total += r.rowsAffected[0];
      }
    } catch (e) {
      console.log(`    skipped ${tbl}: ${e.message.split("\n")[0]}`);
    }
  }
  console.log(`  children cleared: ${total}`);
  const r = await pool.request()
    .input("siteId", sql.UniqueIdentifier, siteId)
    .input("tid", sql.UniqueIdentifier, IA_TENANT_ID)
    .query(`DELETE FROM arion.site WHERE site_id = @siteId AND tenant_id = @tid;`);
  console.log(`  removed arion.site rows: ${r.rowsAffected[0]}`);
}

await pool.close();
console.log("\nDone.");
