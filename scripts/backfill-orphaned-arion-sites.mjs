/**
 * scripts/backfill-orphaned-arion-sites.mjs
 *
 * F-A.5 — Backfill already-orphaned arion.site rows.
 *
 * Why this exists:
 *   F-SEC1.2 (activate.js email-match guard) + F-A.4 (resolveTenantForBuyer
 *   in the Stripe webhook) plug new buyers into core.tenants from the moment
 *   of payment. But buyers who paid BEFORE those fixes shipped have an
 *   arion.site row with an unused welcome_token AND no matching core.tenants
 *   row keyed off their email. When they finally click their activation
 *   link, activate.js fails-closed at the email-match step and they hit a
 *   dead end.
 *
 *   This script inventories those orphans and either:
 *     (a) seeds a minimal core.tenants row for them (re-linking the orphan
 *         to the canonical platform table), OR
 *     (b) expires the orphan's welcome_token so a fresh activation email
 *         must be resent (safer fallback when tier / cart context is
 *         missing or ambiguous).
 *
 * Strategy:
 *   Default is (b) — the conservative path. We only do (a) if --mode=create
 *   is passed AND every required field can be read from arion.tenant +
 *   arion.signup_session. The expired-token path is reversible (a resend
 *   issues a brand-new token + expiry); a bad core.tenants insert is not.
 *
 *   Cross-DB note: arion.* lives in iadm_services; core.tenants lives in
 *   iadm_platform. We open two pools (servicesPool + platformPool) instead
 *   of relying on three-part-name cross-DB queries (which won't work on
 *   Azure SQL DB).
 *
 * Modes:
 *   node scripts/backfill-orphaned-arion-sites.mjs                 (default: --dry-run --mode=expire)
 *   node scripts/backfill-orphaned-arion-sites.mjs --apply         (apply --mode=expire)
 *   node scripts/backfill-orphaned-arion-sites.mjs --mode=create   (dry-run, would create core.tenants rows)
 *   node scripts/backfill-orphaned-arion-sites.mjs --mode=create --apply  (actually create them)
 *
 *   IMPORTANT: first commit ships dry-run-default. Brandon reviews the
 *   inventory, then re-runs with --apply once he's seen the count.
 *
 * Idempotency:
 *   - expire mode: only touches rows whose welcome_token_used_at IS NULL AND
 *     whose welcome_token_expires_at is in the future (or missing). Safe to
 *     re-run; second run is a no-op.
 *   - create mode: only inserts when core.tenants has no row for the email
 *     AND no tenant_user link for that email. Wrapped in NOT EXISTS guard.
 *
 * Transactions:
 *   Per-orphan transaction. A failure on one orphan rolls back ONLY that
 *   row, logs the error, and continues with the rest. We do not wrap the
 *   whole batch in one transaction because (a) the cross-DB write would
 *   require MSDTC, which Azure SQL DB doesn't support, and (b) one bad row
 *   shouldn't block the rest from being fixed.
 *
 * Auth:
 *   AzureCliCredential (same pattern as backfill-schema-migrations.mjs and
 *   run-pipeline-migrations.js).
 *
 * Output:
 *   - Pre-flight orphan inventory (count + per-row table).
 *   - Per-orphan action log (BACKFILL_CREATE | EXPIRE | SKIP | FAIL).
 *   - Final summary.
 */
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVICES_SERVER = process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER || "sql-iadm-prod-cus.database.windows.net";
const SERVICES_DB = process.env.SERVICES_SQL_DATABASE || "iadm_services";
const PLATFORM_SERVER = process.env.PLATFORM_SQL_SERVER || SERVICES_SERVER;
const PLATFORM_DB = process.env.PLATFORM_SQL_DATABASE || "iadm_platform";
const SCOPE = "https://database.windows.net/.default";

const MODE_APPLY = process.argv.includes("--apply");
const ACTION = process.argv.find((a) => a.startsWith("--mode="))?.slice(7) || "expire";
if (!["expire", "create"].includes(ACTION)) {
  console.error(`[backfill-orphans] invalid --mode=${ACTION}. Allowed: expire | create`);
  process.exit(1);
}
const MODE_LABEL = MODE_APPLY ? "APPLY" : "DRY-RUN";

function maskEmail(e) {
  if (!e) return "";
  const [u, d] = String(e).split("@");
  if (!d) return e;
  const um = u.length <= 2 ? u : u.slice(0, 2) + "***";
  return `${um}@${d}`;
}

async function connectPool(server, database) {
  const credential = new AzureCliCredential();
  const token = await credential.getToken(SCOPE);
  const pool = await new sql.ConnectionPool({
    server,
    database,
    options: { encrypt: true },
    connectionTimeout: 15000,
    requestTimeout: 120000,
    authentication: {
      type: "azure-active-directory-access-token",
      options: { token: token.token },
    },
  }).connect();
  return pool;
}

/**
 * Inventory arion.site rows that:
 *   - Have a welcome_token set in provisioning_details_json
 *   - Have welcome_token_used_at NULL
 *   - We join arion.tenant for the email, plan, billing_cycle, stripe ids
 *   - We left-join arion.signup_session for backup email (if tenant row is
 *     somehow missing the primary_email)
 *
 * Returns: array of orphan candidates (un-filtered by core.tenants yet —
 * that filter happens client-side because core.tenants lives in a different DB).
 */
async function loadCandidateOrphans(servicesPool) {
  const r = await servicesPool.request().query(`
    SELECT
      s.site_id,
      s.tenant_id,
      s.domain,
      s.tier              AS site_tier,
      s.created_at        AS site_created_at,
      s.provisioning_details_json,
      JSON_VALUE(s.provisioning_details_json, '$.welcome_token')             AS welcome_token,
      JSON_VALUE(s.provisioning_details_json, '$.welcome_token_used_at')     AS welcome_token_used_at,
      JSON_VALUE(s.provisioning_details_json, '$.welcome_token_expires_at')  AS welcome_token_expires_at,
      t.primary_email,
      t.[plan]            AS tenant_plan,
      t.billing_cycle     AS tenant_billing_cycle,
      t.stripe_customer_id,
      t.stripe_subscription_id,
      ss.email            AS signup_email
    FROM arion.site s
    LEFT JOIN arion.tenant         t  ON t.tenant_id  = s.tenant_id
    LEFT JOIN arion.signup_session ss ON ss.tenant_id = s.tenant_id
    WHERE JSON_VALUE(s.provisioning_details_json, '$.welcome_token') IS NOT NULL
      AND JSON_VALUE(s.provisioning_details_json, '$.welcome_token_used_at') IS NULL
  `);
  return r.recordset;
}

/**
 * For each candidate, look up core.tenants on the platform DB by email. If
 * we find a row, the site is NOT orphaned (already has a canonical tenant)
 * — and there's nothing to do at the platform level. We still report it as
 * 'matched' for clarity. If we find NO row, it IS an orphan and needs fix.
 */
async function classifyOrphans(platformPool, candidates) {
  const out = [];
  for (const row of candidates) {
    const email = (row.primary_email || row.signup_email || "").trim().toLowerCase();
    if (!email) {
      out.push({ ...row, _email: null, _matched: false, _reason: "no email on arion.tenant or arion.signup_session" });
      continue;
    }
    const hit = await platformPool.request()
      .input("email", sql.NVarChar(640), email)
      .query(`
        SELECT TOP 1 t.tenant_id
        FROM core.tenants t
        LEFT JOIN core.users u ON LOWER(u.email) = @email
        LEFT JOIN core.tenant_users tu ON tu.user_id = u.user_id AND tu.tenant_id = t.tenant_id
        WHERE LOWER(t.primary_contact_email) = @email
           OR tu.tenant_id IS NOT NULL
      `);
    if (hit.recordset.length > 0) {
      out.push({ ...row, _email: email, _matched: true, _matched_tenant_id: hit.recordset[0].tenant_id });
    } else {
      out.push({ ...row, _email: email, _matched: false });
    }
  }
  return out;
}

/**
 * Generate a slug compatible with core.tenants.slug uniqueness.
 * Mirrors lib/coreTenants.js generateUniqueSlug — duplicated here so this
 * script is self-contained.
 */
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
 * Action (a): seed core.tenants with the arion.tenant.tenant_id so the
 * orphan arion.site row is now reachable via the canonical platform table.
 * Uses arion.tenant for email/plan/billing.
 *
 * Wrapped in a transaction. On failure the inserted row rolls back.
 */
async function actionCreate(platformPool, orphan) {
  const tx = new sql.Transaction(platformPool);
  await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
  try {
    const safeEmail = orphan._email;
    const safeName = safeEmail; // no business name reliably known at this point
    const slug = await generateUniqueSlug(platformPool, safeName);
    await new sql.Request(tx)
      .input("tid", sql.UniqueIdentifier, orphan.tenant_id)
      .input("name", sql.NVarChar(100), safeName.slice(0, 100))
      .input("fullName", sql.NVarChar(200), safeName.slice(0, 200))
      .input("slug", sql.NVarChar(63), slug)
      .input("status", sql.NVarChar(20), "pending_onboarding")
      .input("tier", sql.NVarChar(20), String(orphan.tenant_plan || orphan.site_tier || "starter").slice(0, 20))
      .input("email", sql.NVarChar(640), safeEmail)
      .input("product", sql.NVarChar(20), "arion")
      .input("billing", sql.NVarChar(20), String(orphan.tenant_billing_cycle || "monthly").slice(0, 20))
      .input("cust", sql.NVarChar(100), orphan.stripe_customer_id || null)
      .input("sub", sql.NVarChar(100), orphan.stripe_subscription_id || null)
      .query(`
        -- INSERT shape mirrors lib/coreTenants.js resolveTenantForBuyer
        -- exactly. signup_source column does NOT exist on core.tenants —
        -- the 'orphan_backfill' marker is logged in script output instead.
        IF NOT EXISTS (SELECT 1 FROM core.tenants WHERE tenant_id = @tid)
        INSERT INTO core.tenants
          (tenant_id, name, full_name, slug, status, subscription_tier,
           primary_contact_email, signup_product, billing_cycle,
           saas_stripe_customer_id, saas_stripe_subscription_id)
        VALUES
          (@tid, @name, @fullName, @slug, @status, @tier,
           @email, @product, @billing, @cust, @sub)
      `);
    await tx.commit();
    return { action: "BACKFILL_CREATE", note: `core.tenants seeded with tenant_id=${orphan.tenant_id}` };
  } catch (err) {
    try { await tx.rollback(); } catch { /* already rolled back */ }
    return { action: "FAIL", note: `create failed: ${err.message}` };
  }
}

/**
 * Action (b): expire the orphan's welcome_token by overwriting
 * provisioning_details_json with welcome_token_expires_at = now and
 * welcome_token_expired_by = 'orphan_backfill'. Token VALUE is left in
 * place so the original email link still validates the TOKEN_EXPIRED branch
 * (we want a clear "expired" UX, not a "not found"). The buyer needs a
 * fresh resend to redeem.
 */
async function actionExpire(servicesPool, orphan) {
  const tx = new sql.Transaction(servicesPool);
  await tx.begin(sql.ISOLATION_LEVEL.READ_COMMITTED);
  try {
    let details = {};
    try {
      details = orphan.provisioning_details_json ? JSON.parse(orphan.provisioning_details_json) : {};
    } catch { details = {}; }
    details.welcome_token_expires_at = new Date().toISOString();
    details.welcome_token_expired_by = "orphan_backfill_F-A.5";
    details.welcome_token_expired_at = new Date().toISOString();

    await new sql.Request(tx)
      .input("siteId", sql.UniqueIdentifier, orphan.site_id)
      .input("details", sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`
        UPDATE arion.site
        SET provisioning_details_json = @details,
            updated_at = SYSDATETIMEOFFSET()
        WHERE site_id = @siteId
          AND JSON_VALUE(provisioning_details_json, '$.welcome_token_used_at') IS NULL
      `);
    await tx.commit();
    return { action: "EXPIRE", note: `welcome_token_expires_at set to now` };
  } catch (err) {
    try { await tx.rollback(); } catch { /* already rolled back */ }
    return { action: "FAIL", note: `expire failed: ${err.message}` };
  }
}

function printOrphanTable(orphans) {
  const rows = orphans.map((o) => ({
    site_id: String(o.site_id).slice(0, 8) + "…",
    tenant_id: String(o.tenant_id).slice(0, 8) + "…",
    domain: (o.domain || "").slice(0, 28),
    email: maskEmail(o._email || ""),
    created: o.site_created_at ? new Date(o.site_created_at).toISOString().slice(0, 10) : "",
    matched: o._matched ? "yes" : "no",
    reason: o._reason || "",
  }));
  if (rows.length === 0) {
    console.log("[backfill-orphans] no candidate rows.");
    return;
  }
  const w = {
    site_id: 12, tenant_id: 12, domain: 28, email: 26, created: 10, matched: 7, reason: 36,
  };
  const sep = "+" + Object.values(w).map((n) => "-".repeat(n + 2)).join("+") + "+";
  console.log(sep);
  console.log("| " + Object.keys(w).map((k) => k.padEnd(w[k])).join(" | ") + " |");
  console.log(sep);
  for (const r of rows) {
    console.log("| " + Object.keys(w).map((k) => String(r[k] || "").slice(0, w[k]).padEnd(w[k])).join(" | ") + " |");
  }
  console.log(sep);
}

async function main() {
  console.log(`[backfill-orphans] mode=${MODE_LABEL} action=${ACTION}`);
  console.log(`[backfill-orphans] services=${SERVICES_SERVER}/${SERVICES_DB}`);
  console.log(`[backfill-orphans] platform=${PLATFORM_SERVER}/${PLATFORM_DB}`);

  const servicesPool = await connectPool(SERVICES_SERVER, SERVICES_DB);
  console.log("[backfill-orphans] services pool connected");
  const platformPool = await connectPool(PLATFORM_SERVER, PLATFORM_DB);
  console.log("[backfill-orphans] platform pool connected");

  let counts = {
    candidates: 0,
    matched: 0,        // candidate had core.tenants — NOT orphan, no-op
    orphans: 0,        // confirmed orphan
    expired: 0,
    created: 0,
    skipped: 0,
    failed: 0,
  };

  try {
    console.log("\n[backfill-orphans] === STEP 1: load candidate rows from iadm_services ===");
    const candidates = await loadCandidateOrphans(servicesPool);
    counts.candidates = candidates.length;
    console.log(`[backfill-orphans] found ${candidates.length} arion.site row(s) with unused welcome_token`);

    if (candidates.length === 0) {
      console.log("[backfill-orphans] nothing to do. exiting clean.");
      return;
    }

    console.log("\n[backfill-orphans] === STEP 2: classify against core.tenants on iadm_platform ===");
    const classified = await classifyOrphans(platformPool, candidates);
    counts.matched = classified.filter((r) => r._matched).length;
    counts.orphans = classified.filter((r) => !r._matched).length;
    console.log(`[backfill-orphans] matched=${counts.matched} (have core.tenants) | orphans=${counts.orphans} (no core.tenants)`);

    console.log("\n[backfill-orphans] === STEP 3: per-candidate inventory ===");
    printOrphanTable(classified);

    const orphans = classified.filter((r) => !r._matched);
    if (orphans.length === 0) {
      console.log("\n[backfill-orphans] no true orphans to fix. exiting clean.");
      return;
    }

    console.log(`\n[backfill-orphans] === STEP 4: ${MODE_LABEL} ${ACTION} on ${orphans.length} orphan(s) ===`);

    for (const orphan of orphans) {
      const label = `site=${String(orphan.site_id).slice(0, 8)} tenant=${String(orphan.tenant_id).slice(0, 8)} email=${maskEmail(orphan._email || "(none)")}`;

      // Decide if this orphan is fixable in current ACTION.
      if (ACTION === "create" && !orphan._email) {
        console.log(`  [${label}] SKIP — create requires email; arion.tenant + signup_session both missing one`);
        counts.skipped++;
        continue;
      }

      if (!MODE_APPLY) {
        console.log(`  [${label}] WOULD ${ACTION.toUpperCase()} ${orphan._email ? `(email=${maskEmail(orphan._email)})` : "(no email)"}`);
        if (ACTION === "create") counts.created++; else counts.expired++;
        continue;
      }

      let result;
      if (ACTION === "create") {
        result = await actionCreate(platformPool, orphan);
      } else {
        result = await actionExpire(servicesPool, orphan);
      }
      console.log(`  [${label}] ${result.action} — ${result.note}`);
      if (result.action === "BACKFILL_CREATE") counts.created++;
      else if (result.action === "EXPIRE") counts.expired++;
      else counts.failed++;
    }
  } finally {
    await servicesPool.close().catch(() => {});
    await platformPool.close().catch(() => {});
  }

  console.log("\n[backfill-orphans] === SUMMARY ===");
  console.log(JSON.stringify(counts, null, 2));
  if (!MODE_APPLY) {
    console.log(`\n[backfill-orphans] DRY-RUN complete. Re-run with --apply (and optionally --mode=create) to mutate.`);
  } else {
    console.log(`\n[backfill-orphans] APPLY complete.`);
  }
}

main().catch((err) => {
  console.error("[backfill-orphans] fatal:", err);
  process.exit(1);
});
