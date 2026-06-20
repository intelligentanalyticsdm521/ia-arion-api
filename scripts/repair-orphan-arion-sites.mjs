// scripts/repair-orphan-arion-sites.mjs
//
// F-A.5 — One-time backfill for already-orphaned ARION self-serve buyers.
//
// WHY THIS EXISTS
// ----------------------------------------------------------------------------
// Commit 0d8f0ef4 fixed the STRUCTURAL bug in routes/onboarding/webhook.js so
// FUTURE Stripe checkouts reuse the core.tenants.tenant_id (via the new
// lib/coreTenants.js → resolveTenantForBuyer helper). But buyers who paid
// BEFORE that fix landed have orphaned arion.site rows whose tenant_id is a
// random GUID that does NOT match any core.tenants row. When those buyers
// sign into the Portal, tenantResolution middleware resolves their canonical
// tenant_id from core.tenants and the dashboard query returns 0 rows.
//
// This script walks every arion.site whose tenant_id is unknown to
// core.tenants, looks up the buyer's email from arion.tenant, runs the same
// resolveTenantForBuyer logic the webhook now uses, and rewrites
// arion.site.tenant_id (and arion.tenant) to point at the canonical
// core.tenants.tenant_id. After this runs, the buyer's dashboard works.
//
// RUN ORDER (per the F-A.4 / F-A.5 plan)
// ----------------------------------------------------------------------------
//   1. Deploy commit 0d8f0ef4 via the pipeline (already done at script time).
//   2. From a workstation with `az login` complete:
//        node scripts/repair-orphan-arion-sites.mjs               (dry-run)
//        node scripts/repair-orphan-arion-sites.mjs --apply --confirm N
//      where N is the row count the dry-run printed. The --confirm value MUST
//      match the planned-action count exactly, so you cannot run blind.
//
// SAFETY
// ----------------------------------------------------------------------------
// - This script is a REPAIR script. It NEVER deletes any row.
// - --dry-run is the default. You must pass BOTH --apply AND --confirm <N>
//   to mutate. --confirm guards against running while the live orphan count
//   has shifted under you (new orphans appearing between dry-run and apply).
// - --limit caps the number of orphans considered (default 100).
// - The repair is idempotent: rows whose tenant_id already matches a
//   core.tenants row are skipped with status="already-linked".
//
// FLAGS
// ----------------------------------------------------------------------------
//   --apply           Actually write changes. Default is dry-run.
//   --confirm N       Required with --apply. Must match the count of rows
//                     that would be touched. Mismatch → abort.
//   --limit N         Cap the SELECT to first N orphans. Default 100.
//   --help            Print usage and exit.
//
// ENV
// ----------------------------------------------------------------------------
//   Reads the same SQL_SERVER / PLATFORM_SQL_SERVER / SERVICES_SQL_SERVER /
//   AUTH_MODE env vars as the app. By default uses AzureCliCredential
//   (i.e. assumes `az login`). If running from a managed identity context,
//   set AUTH_MODE=MANAGED_IDENTITY.

import sql from "mssql";
import crypto from "node:crypto";
import {
  AzureCliCredential,
  DefaultAzureCredential,
  ManagedIdentityCredential,
} from "@azure/identity";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { dryRun: true, apply: false, confirm: null, limit: 100, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { args.help = true; }
    else if (a === "--apply") { args.apply = true; args.dryRun = false; }
    else if (a === "--dry-run") { args.dryRun = true; args.apply = false; }
    else if (a === "--confirm") { args.confirm = Number(argv[++i]); }
    else if (a.startsWith("--confirm=")) { args.confirm = Number(a.split("=")[1]); }
    else if (a === "--limit") { args.limit = Number(argv[++i]); }
    else if (a.startsWith("--limit=")) { args.limit = Number(a.split("=")[1]); }
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Usage: node scripts/repair-orphan-arion-sites.mjs [--apply --confirm N] [--limit N]

Repairs arion.site rows whose tenant_id is NOT a known core.tenants row
(i.e. orphaned by the pre-0d8f0ef4 self-serve webhook bug).

  --apply        Actually apply the repair. Default is dry-run.
  --confirm N    REQUIRED with --apply. Must equal the number of orphans
                 the script would touch. Mismatch aborts.
  --limit N      Cap the orphan scan to N rows. Default 100.
  --help, -h     This help.
`);
}

// ---------------------------------------------------------------------------
// Credentials / pool setup
// ---------------------------------------------------------------------------
const SQL_SCOPE = "https://database.windows.net/.default";
const SERVICES_DB = process.env.SERVICES_SQL_DATABASE || "iadm_services";
const PLATFORM_DB = process.env.PLATFORM_SQL_DATABASE || "iadm_platform";
const SERVICES_SERVER = process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER || "sql-iadm-prod-cus.database.windows.net";
const PLATFORM_SERVER = process.env.PLATFORM_SQL_SERVER || process.env.SQL_SERVER || "sql-iadm-prod-cus.database.windows.net";

function getCredential() {
  const mode = process.env.AUTH_MODE || "LOCAL_DEV";
  if (mode === "MANAGED_IDENTITY") return new ManagedIdentityCredential();
  if (mode === "AZURE_CLI") return new AzureCliCredential();
  if (mode === "LOCAL_DEV") return new AzureCliCredential();
  return new DefaultAzureCredential();
}

async function buildPool(server, database, token) {
  return new sql.ConnectionPool({
    server,
    database,
    options: { encrypt: true },
    connectionTimeout: 15000,
    requestTimeout: 30000,
    authentication: {
      type: "azure-active-directory-access-token",
      options: { token },
    },
    pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
  }).connect();
}

// ---------------------------------------------------------------------------
// Email normalization + slug helper (mirrors lib/coreTenants.js exactly so
// the script produces identical-shape rows). Kept inline to avoid pulling in
// the app's getPlatformPool() module which has its own caching/env wiring.
// ---------------------------------------------------------------------------
function normalizeEmail(e) {
  return String(e || "").trim().toLowerCase();
}

async function generateUniqueSlug(platformPool, name) {
  let base = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  if (base.length < 3) base = "tenant-" + crypto.randomUUID().slice(0, 6);
  let candidate = base;
  let n = 2;
  while (true) {
    const hit = await platformPool.request()
      .input("slug", sql.NVarChar(63), candidate)
      .query("SELECT 1 AS h FROM core.tenants WHERE slug = @slug");
    if (hit.recordset.length === 0) return candidate;
    candidate = `${base}-${n}`.slice(0, 63);
    n++;
    if (n > 100) return `${base}-${crypto.randomUUID().slice(0, 6)}`.slice(0, 63);
  }
}

/**
 * Find or create the canonical core.tenants row for this buyer.
 * Mirrors lib/coreTenants.js → resolveTenantForBuyer so the backfill produces
 * rows indistinguishable from those the live webhook will produce going
 * forward.
 *
 * @returns {Promise<{tenantId:string, source:'existing'|'created'}>}
 */
async function resolveTenantForBuyer(platformPool, { email, name, tier, billingCycle, stripeCustomerId, stripeSubscriptionId }) {
  if (!email) throw new Error("resolveTenantForBuyer: email is required");
  const safeEmail = normalizeEmail(email);
  const safeName = String(name || "").trim() || safeEmail;

  const hit = await platformPool.request()
    .input("email", sql.NVarChar(640), safeEmail)
    .query(`
      SELECT TOP 1 t.tenant_id
      FROM core.tenants t
      LEFT JOIN core.users u ON LOWER(u.email) = @email
      LEFT JOIN core.tenant_users tu ON tu.user_id = u.user_id AND tu.tenant_id = t.tenant_id
      WHERE LOWER(t.primary_contact_email) = @email
         OR tu.tenant_id IS NOT NULL
      ORDER BY t.created_at ASC
    `);

  if (hit.recordset.length > 0) {
    return { tenantId: hit.recordset[0].tenant_id, source: "existing" };
  }

  const tenantId = crypto.randomUUID();
  const slug = await generateUniqueSlug(platformPool, safeName);

  await platformPool.request()
    .input("tid", sql.UniqueIdentifier, tenantId)
    .input("name", sql.NVarChar(100), safeName.slice(0, 100))
    .input("fullName", sql.NVarChar(200), safeName.slice(0, 200))
    .input("slug", sql.NVarChar(63), slug)
    .input("status", sql.NVarChar(20), "pending_onboarding")
    .input("tier", sql.NVarChar(20), String(tier || "starter").slice(0, 20))
    .input("email", sql.NVarChar(640), safeEmail)
    .input("product", sql.NVarChar(20), "arion")
    .input("billing", sql.NVarChar(20), String(billingCycle || "monthly").slice(0, 20))
    .input("cust", sql.NVarChar(100), stripeCustomerId || null)
    .input("sub", sql.NVarChar(100), stripeSubscriptionId || null)
    .query(`
      INSERT INTO core.tenants
        (tenant_id, name, full_name, slug, status, subscription_tier,
         primary_contact_email, signup_product, billing_cycle,
         saas_stripe_customer_id, saas_stripe_subscription_id)
      VALUES
        (@tid, @name, @fullName, @slug, @status, @tier,
         @email, @product, @billing, @cust, @sub)
    `);

  return { tenantId, source: "created" };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); return; }

  console.log("=== ARION orphan-site backfill (F-A.5) ===");
  console.log(`Mode:       ${args.apply ? "APPLY (will write)" : "DRY-RUN (read-only)"}`);
  console.log(`Limit:      ${args.limit}`);
  console.log(`Services:   ${SERVICES_SERVER} / ${SERVICES_DB}`);
  console.log(`Platform:   ${PLATFORM_SERVER} / ${PLATFORM_DB}`);

  const cred = getCredential();
  const token = (await cred.getToken(SQL_SCOPE)).token;

  const servicesPool = await buildPool(SERVICES_SERVER, SERVICES_DB, token);
  const platformPool = (SERVICES_SERVER === PLATFORM_SERVER)
    // Same logical SQL server — reuse the same token for the second DB
    ? await buildPool(PLATFORM_SERVER, PLATFORM_DB, token)
    : await buildPool(PLATFORM_SERVER, PLATFORM_DB, (await cred.getToken(SQL_SCOPE)).token);

  try {
    // -----------------------------------------------------------------------
    // 1. Snapshot every known core.tenants.tenant_id. arion.* and core.*
    //    live in two different databases (iadm_services vs iadm_platform), so
    //    we can't do a single cross-DB JOIN — we pull the GUIDs into memory
    //    and check membership in JS / via a TVP.
    // -----------------------------------------------------------------------
    const knownRes = await platformPool.request().query(`
      SELECT tenant_id FROM core.tenants
    `);
    const knownTenantIds = new Set(
      knownRes.recordset.map((r) => String(r.tenant_id).toUpperCase())
    );
    console.log(`\nKnown core.tenants rows: ${knownTenantIds.size}`);

    // -----------------------------------------------------------------------
    // 2. Pull arion.site rows whose tenant_id is NOT in that set. We sort by
    //    created_at so the --limit cap is deterministic (oldest first).
    //    We JOIN arion.tenant to get the buyer's primary_email + plan +
    //    Stripe IDs. LEFT JOIN because the bug may have written arion.site
    //    without arion.tenant in some edge cases — we still want to see
    //    those rows.
    // -----------------------------------------------------------------------
    const allSitesRes = await servicesPool.request().query(`
      SELECT
        s.site_id,
        s.tenant_id        AS site_tenant_id,
        s.domain,
        s.status           AS site_status,
        s.created_at       AS site_created_at,
        t.tenant_id        AS arion_tenant_id,
        t.primary_email,
        t.[plan],
        t.billing_cycle,
        t.stripe_customer_id,
        t.stripe_subscription_id
      FROM arion.site s
      LEFT JOIN arion.tenant t ON t.tenant_id = s.tenant_id
      ORDER BY s.created_at ASC
    `);

    const orphans = [];
    for (const row of allSitesRes.recordset) {
      const tid = String(row.site_tenant_id).toUpperCase();
      if (!knownTenantIds.has(tid)) orphans.push(row);
      if (orphans.length >= args.limit) break;
    }

    console.log(`Orphan arion.site rows found (capped at ${args.limit}): ${orphans.length}`);
    if (orphans.length === 0) {
      console.log("\nNothing to repair. Exiting.");
      return;
    }

    // -----------------------------------------------------------------------
    // 3. Plan a repair action for each orphan WITHOUT mutating anything yet.
    //    During this phase we may still read core.tenants — we will not
    //    INSERT a new core.tenants row until --apply.
    // -----------------------------------------------------------------------
    const planned = [];
    for (const row of orphans) {
      const email = normalizeEmail(row.primary_email);
      if (!email) {
        planned.push({
          site_id: row.site_id,
          old_tenant_id: row.site_tenant_id,
          new_tenant_id: null,
          email: null,
          action: "skip",
          reason: "no primary_email on arion.tenant — cannot resolve buyer",
        });
        continue;
      }

      // Look up the canonical core.tenants row for this email — read-only.
      const hit = await platformPool.request()
        .input("email", sql.NVarChar(640), email)
        .query(`
          SELECT TOP 1 t.tenant_id
          FROM core.tenants t
          LEFT JOIN core.users u ON LOWER(u.email) = @email
          LEFT JOIN core.tenant_users tu ON tu.user_id = u.user_id AND tu.tenant_id = t.tenant_id
          WHERE LOWER(t.primary_contact_email) = @email
             OR tu.tenant_id IS NOT NULL
          ORDER BY t.created_at ASC
        `);
      const existingCoreTenantId = hit.recordset[0]?.tenant_id || null;

      planned.push({
        site_id: row.site_id,
        old_tenant_id: row.site_tenant_id,
        new_tenant_id: existingCoreTenantId, // null = will seed during --apply
        email,
        action: existingCoreTenantId ? "link" : "reseed",
        reason: existingCoreTenantId
          ? "core.tenants row exists for this email — relink only"
          : "no core.tenants row for this email — will seed one then relink",
        domain: row.domain,
        plan: row.plan,
        billing_cycle: row.billing_cycle,
        stripe_customer_id: row.stripe_customer_id,
        stripe_subscription_id: row.stripe_subscription_id,
      });
    }

    // -----------------------------------------------------------------------
    // 4. Print plan. In dry-run we stop here.
    // -----------------------------------------------------------------------
    console.log("\nPlanned actions:");
    console.table(planned.map((p) => ({
      site_id: p.site_id,
      old_tenant_id: p.old_tenant_id,
      new_tenant_id: p.new_tenant_id || "(to-mint)",
      email: p.email,
      action: p.action,
      domain: p.domain || "",
    })));

    const counts = planned.reduce((acc, p) => {
      acc[p.action] = (acc[p.action] || 0) + 1;
      return acc;
    }, {});
    console.log("\nPlanned action summary:", counts);
    console.log(`Total planned rows: ${planned.length}`);

    if (!args.apply) {
      console.log(`\nDRY-RUN. Re-run with:`);
      console.log(`  node scripts/repair-orphan-arion-sites.mjs --apply --confirm ${planned.length}`);
      console.log(`(--confirm must EQUAL the planned row count above)`);
      return;
    }

    // -----------------------------------------------------------------------
    // 5. --apply: validate --confirm matches plan count BEFORE writing.
    // -----------------------------------------------------------------------
    if (args.confirm !== planned.length) {
      console.error(`\nABORT: --confirm=${args.confirm} does not match planned row count (${planned.length}).`);
      console.error("This guard prevents running blind if the orphan set has shifted since dry-run.");
      console.error(`Re-run dry-run, then pass --confirm ${planned.length}.`);
      process.exit(3);
    }

    // -----------------------------------------------------------------------
    // 6. Apply each repair. Two-step: (a) reseed core.tenants if missing,
    //    (b) UPDATE arion.site (and arion.tenant) to point at the canonical
    //    tenant_id. We log every action. We NEVER delete anything.
    // -----------------------------------------------------------------------
    const results = [];
    for (const p of planned) {
      try {
        if (p.action === "skip") {
          results.push({ ...p, status: "skipped" });
          continue;
        }

        // Step (i): make sure a canonical core.tenants row exists.
        let newTenantId = p.new_tenant_id;
        let source = "existing";
        if (!newTenantId) {
          const resolved = await resolveTenantForBuyer(platformPool, {
            email: p.email,
            name: p.email, // no business name available at backfill time
            tier: p.plan || "starter",
            billingCycle: p.billing_cycle || "monthly",
            stripeCustomerId: p.stripe_customer_id || null,
            stripeSubscriptionId: p.stripe_subscription_id || null,
          });
          newTenantId = resolved.tenantId;
          source = resolved.source; // 'created'
        }

        // Idempotency: if arion.site is already pointing at this tenant, no-op.
        if (String(p.old_tenant_id).toUpperCase() === String(newTenantId).toUpperCase()) {
          results.push({ ...p, new_tenant_id: newTenantId, status: "already-linked" });
          continue;
        }

        // Step (ii.a): re-stamp arion.site.tenant_id. There is NO foreign key
        // from arion.site to arion.tenant (verified against migration 001
        // and 014) so this UPDATE is safe.
        const upSite = await servicesPool.request()
          .input("siteId", sql.UniqueIdentifier, p.site_id)
          .input("newTid", sql.UniqueIdentifier, newTenantId)
          .input("oldTid", sql.UniqueIdentifier, p.old_tenant_id)
          .query(`
            UPDATE arion.site
               SET tenant_id  = @newTid,
                   updated_at = SYSDATETIMEOFFSET()
             WHERE site_id    = @siteId
               AND tenant_id  = @oldTid
          `);

        // Step (ii.b): keep arion.tenant consistent. If a row already exists
        // under the canonical tenant_id (because the buyer already
        // re-subscribed and the post-fix webhook seeded one), do nothing.
        // Otherwise INSERT a new row under the canonical id carrying the
        // original buyer's data (email/plan/Stripe IDs). We do NOT delete
        // the old orphan arion.tenant row — leave it for manual audit.
        const haveCanonical = await servicesPool.request()
          .input("tid", sql.UniqueIdentifier, newTenantId)
          .query("SELECT 1 AS h FROM arion.tenant WHERE tenant_id = @tid");

        if (haveCanonical.recordset.length === 0) {
          await servicesPool.request()
            .input("tid", sql.UniqueIdentifier, newTenantId)
            .input("email", sql.NVarChar(320), p.email)
            .input("plan", sql.NVarChar(40), p.plan || "starter")
            .input("billing", sql.NVarChar(20), p.billing_cycle || "monthly")
            .input("cust", sql.NVarChar(200), p.stripe_customer_id || "")
            .input("sub", sql.NVarChar(200), p.stripe_subscription_id || "")
            .query(`
              INSERT INTO arion.tenant
                (tenant_id, primary_email, [plan], billing_cycle,
                 stripe_customer_id, stripe_subscription_id, status, created_at)
              VALUES
                (@tid, @email, @plan, @billing, @cust, @sub, 'pending_onboarding', SYSDATETIMEOFFSET())
            `);
        }

        results.push({
          ...p,
          new_tenant_id: newTenantId,
          status: upSite.rowsAffected[0] > 0
            ? (source === "created" ? "reseeded" : "linked")
            : "failed",
          rowsAffected: upSite.rowsAffected[0],
        });
      } catch (err) {
        results.push({ ...p, status: "failed", error: err.message });
        console.error(`  ! site_id=${p.site_id} failed: ${err.message}`);
      }
    }

    // -----------------------------------------------------------------------
    // 7. Summary
    // -----------------------------------------------------------------------
    const summary = results.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});
    console.log("\nApplied. Final status counts:", summary);
    console.log("\nFull result log:");
    console.table(results.map((r) => ({
      site_id: r.site_id,
      old_tenant_id: r.old_tenant_id,
      new_tenant_id: r.new_tenant_id,
      email: r.email,
      status: r.status,
    })));
  } finally {
    await Promise.all([
      servicesPool.close().catch(() => {}),
      platformPool.close().catch(() => {}),
    ]);
  }
}

main().catch((err) => {
  console.error("\nFATAL:", err);
  process.exit(1);
});
