/**
 * Apply migrations 014–017 (onboarding signup + provisioning + portal account
 * + integration kickoff) against iadm_services prod.
 *
 * All four migrations are additive + idempotent — safe to run multiple times.
 * Auth uses Azure CLI credentials (run `az login` first if needed).
 *
 * Usage:  node scripts/_apply_onboarding_migrations.js
 */

import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";
import { readFileSync } from "fs";

const credential = new AzureCliCredential();
const token = await credential.getToken("https://database.windows.net/.default");

const pool = await new sql.ConnectionPool({
  server: "sql-iadm-prod-cus.database.windows.net",
  database: "iadm_services",
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();

const migrations = [
  { num: "014", file: "./db/migrations/014_onboarding_signup_provisioning.sql" },
  { num: "015", file: "./db/migrations/015_provisioning_jobs.sql" },
  { num: "016", file: "./db/migrations/016_tenant_entra_user_id.sql" },
  { num: "017", file: "./db/migrations/017_site_integration_status.sql" },
];

for (const m of migrations) {
  process.stdout.write(`Applying migration ${m.num}... `);
  const text = readFileSync(m.file, "utf8");
  try {
    await pool.request().batch(text);
    console.log("✓");
  } catch (err) {
    console.log("✗");
    console.error(`  Error in ${m.num}:`, err.message);
    process.exit(1);
  }
}

// Verify
console.log("\nVerifying tables/columns:");

const checks = [
  { name: "arion.tenant",                    sql: "SELECT COUNT(*) AS c FROM arion.tenant" },
  { name: "arion.signup_session",            sql: "SELECT COUNT(*) AS c FROM arion.signup_session" },
  { name: "arion.stripe_webhook_log",        sql: "SELECT COUNT(*) AS c FROM arion.stripe_webhook_log" },
  { name: "arion.provisioning_job",          sql: "SELECT COUNT(*) AS c FROM arion.provisioning_job" },
  { name: "arion.site_integration_status",   sql: "SELECT COUNT(*) AS c FROM arion.site_integration_status" },
  { name: "arion.site.domain_mode",          sql: "SELECT TOP 0 domain_mode FROM arion.site" },
  { name: "arion.site.tier",                 sql: "SELECT TOP 0 tier FROM arion.site" },
  { name: "arion.site.provisioning_state",   sql: "SELECT TOP 0 provisioning_state FROM arion.site" },
  { name: "arion.site.branding_primary_color", sql: "SELECT TOP 0 branding_primary_color FROM arion.site" },
  { name: "arion.site.hostinger_website_id", sql: "SELECT TOP 0 hostinger_website_id FROM arion.site" },
  { name: "arion.tenant.entra_user_id",      sql: "SELECT TOP 0 entra_user_id FROM arion.tenant" },
  { name: "arion.signup_session.domain_json", sql: "SELECT TOP 0 domain_json FROM arion.signup_session" },
];

let allGood = true;
for (const check of checks) {
  try {
    await pool.request().query(check.sql);
    console.log(`  ✓ ${check.name}`);
  } catch (err) {
    console.log(`  ✗ ${check.name}: ${err.message.slice(0, 100)}`);
    allGood = false;
  }
}

await pool.close();

console.log(allGood ? "\n✓ All migrations applied + verified." : "\n✗ Verification failures — check the errors above.");
process.exit(allGood ? 0 : 1);
