// scripts/repair-gbp-cross-tenant-bleed.mjs
//
// DATA REPAIR for the GBP cross-tenant bleed. Brandon runs this — it writes to
// production, which is why it is a script and not something I ran.
//
// WHAT IS WRONG
// -------------
// arion.business_location holds 12 rows: 4 tenants x the same 3 businesses.
// 9 of 12 are foreign. Verified against prod 2026-07-16:
//
//   Rolling In It        * PRIMARY = Briarwood Dental        <- THE BLEED
//   Briarwood Dental     * PRIMARY = Briarwood Dental        <- correct by luck
//   Midwest Ag Services  * PRIMARY = Midwest Ag Services     <- correct by luck
//   iadm                 * PRIMARY = Intelligent Analytics   <- correct by luck
//
// Every tenant carries all three businesses. GET /arion/business-locations
// therefore returns Briarwood's and Midwest Ag's name/address/phone/website to
// Rolling In It's portal users. All public Google data, so NOT a PII breach —
// the damage is commercial: it leaks IA's client roster to IA's other clients.
//
// The cause was gbpSync.js:134 electing a primary by array position, plus
// gbpSync.js:59-171 importing every listing the authorising Google identity can
// reach with no tenant boundary. Both are fixed in code (commit 2744c73). This
// script cleans up the rows those bugs already wrote — the code fix does not
// retroactively remove them.
//
// THE REPAIR RULE
// ---------------
// arion.site.gbp_location_name is the AUTHORITATIVE pointer to a tenant's own
// listing, and it is already correct (verified 2026-07-16):
//
//   Briarwood Dental     -> .../locations/12493166159484644955   correct
//   Midwest Ag Services  -> .../locations/14048610290937912195   correct
//   iadm                 -> .../locations/11271761378845175557   correct
//   Rolling In It        -> NOT SET                              honest: RII has no GBP yet
//
// So: for each tenant, keep ONLY the business_location row whose
// gbp_location_id matches the locationId in that tenant's
// arion.site.gbp_location_name. Delete the rest. A tenant with no pointer keeps
// nothing — Rolling In It genuinely owns none of these three businesses.
//
// Expected outcome: 12 rows -> 3 rows, 9 deleted, RII left with 0.
// RII showing "no locations" is CORRECT. They have no Google Business Profile.
// That is the whole point of the GBP Connect work scoped for the Aug 6 window.
//
// SAFETY
//   * Dry-run by DEFAULT. --apply is required to write anything.
//   * Deletes only rows it can prove are foreign (no matching pointer).
//   * NEVER deletes a row that matches its tenant's own pointer.
//   * Prints every row and its verdict before doing anything.
//   * Wraps the deletes in a transaction.
//   * Takes a backup of every row to a JSON file first, so a mistake is
//     recoverable — these are hard deletes.
//
// USAGE
//   node scripts/repair-gbp-cross-tenant-bleed.mjs            # dry run (default)
//   node scripts/repair-gbp-cross-tenant-bleed.mjs --apply    # actually delete

import sql from "mssql";
import fs from "node:fs";
import path from "node:path";
import { AzureCliCredential } from "@azure/identity";

const APPLY = process.argv.includes("--apply");
const SERVER = "sql-iadm-prod-cus.database.windows.net";

const token = await new AzureCliCredential().getToken("https://database.windows.net/.default");
const connect = (database) =>
  new sql.ConnectionPool({
    server: SERVER,
    database,
    options: { encrypt: true },
    authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
  }).connect();

const services = await connect("iadm_services");
const platform = await connect("iadm_platform");

const tenantNames = Object.fromEntries(
  (await platform.request().query("SELECT tenant_id, name FROM core.tenants")).recordset.map((r) => [
    String(r.tenant_id).toLowerCase(),
    r.name,
  ])
);
const nameOf = (id) => tenantNames[String(id || "").toLowerCase()] || String(id || "?").slice(0, 8);

/** "accounts/123/locations/456" -> "456" */
function locationIdOf(resourceName) {
  const m = /locations\/([^/]+)$/.exec(String(resourceName || ""));
  return m ? m[1] : null;
}

const rows = (
  await services.request().query(`
    SELECT location_id, tenant_id, gbp_location_id, display_name, is_primary, website
    FROM arion.business_location
    ORDER BY tenant_id, display_name`)
).recordset;

const sites = (
  await services.request().query("SELECT tenant_id, domain, gbp_location_name FROM arion.site")
).recordset;

// tenant -> the locationId they actually own, per the authoritative pointer
const ownedByTenant = new Map();
for (const s of sites) {
  const id = locationIdOf(s.gbp_location_name);
  if (id) ownedByTenant.set(String(s.tenant_id).toLowerCase(), id);
}

console.log("\n══════════════════════════════════════════════════════════════");
console.log(`  GBP cross-tenant bleed repair — ${APPLY ? "APPLY (WILL DELETE)" : "DRY RUN"}`);
console.log("══════════════════════════════════════════════════════════════\n");

const toDelete = [];
const toKeep = [];
let lastTenant = "";
for (const r of rows) {
  const tkey = String(r.tenant_id).toLowerCase();
  const owned = ownedByTenant.get(tkey) || null;
  const isOwn = owned && String(r.gbp_location_id) === String(owned);
  (isOwn ? toKeep : toDelete).push(r);

  const tname = nameOf(r.tenant_id);
  if (tname !== lastTenant) {
    console.log(`\n  ${tname}   (owns: ${owned || "NOTHING — no gbp_location_name set"})`);
    lastTenant = tname;
  }
  console.log(
    `    ${isOwn ? "KEEP  " : "DELETE"}  ${r.is_primary ? "* " : "  "}${String(r.display_name).padEnd(26)} ${String(r.website || "").slice(0, 32)}`
  );
}

console.log("\n──────────────────────────────────────────────────────────────");
console.log(`  total rows : ${rows.length}`);
console.log(`  keep       : ${toKeep.length}`);
console.log(`  delete     : ${toDelete.length}`);

// Sanity: every tenant with a pointer must end up with exactly one row.
console.log("\n  Post-repair per tenant:");
for (const [tkey, owned] of ownedByTenant) {
  const kept = toKeep.filter((r) => String(r.tenant_id).toLowerCase() === tkey);
  const flag = kept.length === 1 ? "OK" : `!! ${kept.length} rows — expected 1`;
  console.log(`    ${nameOf(tkey).padEnd(22)} -> ${kept.length} row(s)   ${flag}`);
}
for (const t of new Set(rows.map((r) => String(r.tenant_id).toLowerCase()))) {
  if (!ownedByTenant.has(t)) {
    console.log(`    ${nameOf(t).padEnd(22)} -> 0 row(s)   OK — no GBP selected; owning none of these is CORRECT`);
  }
}

if (!toDelete.length) {
  console.log("\n  Nothing to do.\n");
  await services.close();
  await platform.close();
  process.exit(0);
}

if (!APPLY) {
  console.log("\n  DRY RUN — nothing was changed. Re-run with --apply to delete.\n");
  await services.close();
  await platform.close();
  process.exit(0);
}

// ── Backup before hard-deleting ──────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupPath = path.resolve(process.cwd(), `gbp-bleed-backup-${stamp}.json`);
fs.writeFileSync(backupPath, JSON.stringify({ takenAt: new Date().toISOString(), rows }, null, 2));
console.log(`\n  Backup of ALL ${rows.length} rows written to:\n    ${backupPath}`);

const tx = new sql.Transaction(services);
await tx.begin();
try {
  let deleted = 0;
  for (const r of toDelete) {
    const res = await new sql.Request(tx)
      .input("locationId", sql.UniqueIdentifier, r.location_id)
      .query("DELETE FROM arion.business_location WHERE location_id = @locationId");
    deleted += res.rowsAffected[0] || 0;
  }
  await tx.commit();
  console.log(`\n  ✅ Deleted ${deleted} foreign row(s). Committed.`);
} catch (e) {
  await tx.rollback();
  console.error(`\n  🔴 FAILED — rolled back, nothing changed: ${e.message}`);
  process.exit(1);
}

const after = (
  await services.request().query(`
    SELECT tenant_id, COUNT(*) n, SUM(CASE WHEN is_primary = 1 THEN 1 ELSE 0 END) primaries
    FROM arion.business_location GROUP BY tenant_id`)
).recordset;
console.log("\n  Verified after:");
after.forEach((x) => console.log(`    ${nameOf(x.tenant_id).padEnd(22)} ${x.n} row(s), ${x.primaries} primary`));

await services.close();
await platform.close();
console.log("");
