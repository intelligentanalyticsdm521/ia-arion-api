// lib/devAuth.js — LOCAL TEST-ONLY auth seam.
//
// Ported 2026-07-16 from oliver-api/lib/devAuth.js (same guardrails, same
// header contract, same allowlist). Deliberately NOT a new design.
//
// Lets local dev + automated tests drive the real API without CIAM by sending
// `x-dev-tenant: <test-tenant-guid>` (+ optional `x-dev-tier`).
//
// HARD GUARDRAILS — this must never be exploitable in prod:
//   • Inert unless process.env.DEV_AUTH is "1"/"true"  (prod sets neither —
//     verified 2026-07-16 across all four prod App Services).
//   • Refuses entirely if NODE_ENV === "production"  (arion-api prod HAS
//     NODE_ENV=production set, so that is a real second lock, not a comment).
//   • Only the explicit test-tenant allowlist; the founder/prod tenant GUID is
//     blocked even if someone adds it to DEV_AUTH_TENANTS.
//
// NOTE — what this deliberately does NOT bypass:
//   requireArionAccess still runs for real. devAuth only proves *who* you are;
//   whether that tenant may use ARION is answered by core.tenant_services
//   against the seeded data. Test Company A has arion enabled and passes;
//   Test Company B does not and is correctly rejected. Short-circuiting the
//   product gate (as oliver-api does) would hide exactly the class of bug —
//   wrong tenant sees wrong product — that this stack exists to catch.
import sql from "mssql";
import { getPlatformPool } from "../db/platformPool.js";
import { FOUNDER_TENANT_ID_DEFAULT } from "./agency.js";

// SEAMS PACK 4B — the literal lives in lib/agency.js, this repo's ONE module
// for it. The DEFAULT, not founderTenantId(): what must never be a dev tenant
// is the PRODUCTION founder tenant (the shared CIAM directory GUID equals it).
// A dev .env may legitimately point FOUNDER_TENANT_ID at a fixture agency that
// IS in the allow-list below — oliver-api's does — and blocking the configured
// value would break the seam it is configured for.
const FOUNDER_TENANT = FOUNDER_TENANT_ID_DEFAULT.toLowerCase();
const DEFAULT_TEST_TENANTS = [
  "a0000001-0000-0000-0000-000000000001", // Test Company A  (arion, spark)
  "b0000002-0000-0000-0000-000000000002", // Test Company B  (oliver, spark)
  "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", // isolation-test-b (arion)
  "c0000003-0000-0000-0000-000000000003", // Harbor Point Coffee (fixture)
  "0a6e0c00-0000-4000-8000-00000000a6e0", // The Software Company (fixture agency)
  // ARGUS pack 1 - the DEV POC business, shaped like Intelligent Analytics.
  // A FIXTURE id on purpose: the production founder tenant is hard-blocked by
  // the filter below and must stay blocked, so "run the agents on my own
  // business" is walked on an agency-shaped stand-in with agency-shaped data.
  // Seeded and deleted by oliver-api/scripts/_dev_seed_ia_poc_business.mjs.
  "1a1a1a1a-0000-4000-8000-00000001a1a1", // IA POC (fixture agency, ARGUS demo)
  // WALK FIXTURES 2026-09-09 - the SPARK-ONLY business. Pre-walk pass 3 marked
  // SPARK rows S7.1, S7.2 and S7.3 BLOCK for one reason: every fixture on this
  // database owns three or four products, so "IA Insights on a business with no
  // marketing history" and "the health page for a business with SPARK data only"
  // had nothing to be walked on and the cross-product tiles could not be caught
  // inventing a score. Seeded and deleted by
  // platform-api/scripts/dev/seed-walk-spark-only-business.cjs.
  "d0000004-0000-0000-0000-000000000004", // Redbird Insurance (fixture, SPARK only)
];

function allowedTenants() {
  const fromEnv = (process.env.DEV_AUTH_TENANTS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const list = (fromEnv.length ? fromEnv : DEFAULT_TEST_TENANTS);
  return list.filter((g) => g !== FOUNDER_TENANT); // founder can never be a dev tenant
}

export function devAuthActive() {
  // Lock 1 — affirmative: DEV_AUTH must be explicitly turned on.
  const on = ["1", "true"].includes(String(process.env.DEV_AUTH || "").toLowerCase());
  if (!on) return false;

  // Lock 2 — NODE_ENV. Weaker than it looks: `NODE_ENV || ""` means an UNSET
  // NODE_ENV passes this test. This app does set NODE_ENV=production (verified
  // 2026-07-17 against live app settings), but api-platform-iadm-prod does not
  // — so the pattern is only as safe as an env var someone remembered to set.
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") return false;

  // Lock 3 — infrastructure, not configuration. App Service injects
  // WEBSITE_SITE_NAME into every running site; nothing sets it on a laptop. If
  // we are inside App Service we are not a dev box, whatever NODE_ENV says and
  // whoever set DEV_AUTH. Deliberately checks for the PRESENCE of a prod marker
  // rather than the ABSENCE of one — absence is what makes lock 2 fail open.
  if (process.env.WEBSITE_SITE_NAME) return false;

  return true;
}

export function requestedDevTenant(req) {
  if (!devAuthActive()) return null;
  const g = String(req.headers["x-dev-tenant"] || "").trim().toLowerCase();
  if (!g) return null;
  if (g === FOUNDER_TENANT) {
    console.warn("[devAuth] refused: founder tenant is not allowed as a dev tenant");
    return null;
  }
  return allowedTenants().includes(g) ? g : null;
}

export async function applyDevContext(req, tenantGuid) {
  const pool = await getPlatformPool();
  const t = await pool.request()
    .input("tid", sql.UniqueIdentifier, tenantGuid)
    .query(`SELECT TOP 1 tenant_id, name, full_name, subscription_tier
            FROM core.tenants WHERE tenant_id=@tid`);
  if (!t.recordset.length) {
    const err = new Error(`dev tenant ${tenantGuid} not found in core.tenants — run platform-api/scripts/seed-local-dev.mjs`);
    err.statusCode = 404;
    throw err;
  }
  const row = t.recordset[0];
  const tierOverride = String(req.headers["x-dev-tier"] || "").trim().toLowerCase();
  const tier = tierOverride || (row.subscription_tier || "standard").toLowerCase();

  // Reuse the seeded member's external_subject so requireArionAccess's
  // resolvePlatformUser(req.auth) finds the real core.users row rather than
  // failing 403 "User was not found in iadm_platform".
  let email = "dev-tester@local.test";
  let displayName = "Dev Tester";
  let externalSubject = `dev-${tenantGuid}`;
  try {
    const m = await pool.request()
      .input("tid", sql.UniqueIdentifier, tenantGuid)
      .query(`SELECT TOP 1 u.email, u.full_name, u.external_subject
              FROM core.tenant_users tu JOIN core.users u ON u.user_id = tu.user_id
              WHERE tu.tenant_id=@tid AND (tu.status IS NULL OR tu.status='active')
              ORDER BY tu.created_at`);
    if (m.recordset.length) {
      const u = m.recordset[0];
      email = u.email || email;
      displayName = u.full_name || displayName;
      externalSubject = u.external_subject || externalSubject;
    }
  } catch { /* fall back to synthetic identity */ }

  req.auth = {
    dev: true,
    sub: externalSubject,
    oid: externalSubject,
    email,
    preferred_username: email,
    name: displayName,
    tid: tenantGuid, // the DEV tenant — never the founder tenant
  };
  req.authClientId = "dev-auth";
  req.surface = "iadm_portal";
  req.tenant = {
    tenantId: row.tenant_id,
    tenantName: row.name,
    tenantFullName: row.full_name,
    tier,
    resolvedBy: "dev_auth",
  };
  req.tenantTier = tier;
  req._devAuth = true;
}
