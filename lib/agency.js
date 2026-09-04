// lib/agency.js — "which agency serves THIS tenant?"
//
// WHY THIS EXISTS
// ────────────────────────────────────────────────────────────────────────────
// ~27 files across oliver-api / LUMEN-API / arion-api carried the literal
//
//     (process.env.FOUNDER_TENANT_ID || "8C9527B9-8999-4B31-A306-F3D4CCC39FBD")
//
// as a single global answer to the question "who is the agency?". That is only
// correct while exactly one agency exists (Intelligent Analytics). The platform
// is an AGENCY platform: any agency must be able to run it for its own clients.
// FOUNDER_TENANT_ID is not even set in production app settings, so the inline
// GUID is what actually ran.
//
// The DATA MODEL already supports this (migration 138). core.tenants, in
// **iadm_platform**, carries:
//     tenant_kind      platform_owner | agency | direct | agency_client
//     provider_tenant_id  → the agency that serves an agency_client
//
// Production today: IA = platform_owner; Briarwood Dental / Midwest Ag /
// MS Moments / Rolling In It = agency_client with provider_tenant_id = IA;
// Brandon Test Business / Cold Start Test Co / Green Check Co = direct.
// So for every tenant that exists right now this resolver returns the IA
// tenant id — byte-identical to the constant it replaces.
//
// CONTRACT
// ────────────────────────────────────────────────────────────────────────────
//   resolveAgencyTenantId(tenantId) -> Promise<string>  (UPPERCASE GUID)
//     agency_client                 → its provider_tenant_id
//     platform_owner | agency       → itself (an agency is its own agency)
//     direct (self-serve, no agency) → the platform owner
//     unknown tenant / lookup error → PLATFORM_OWNER_FALLBACK_TENANT_ID + log
//
//   NEVER THROWS. Callers are notification, onboarding and billing paths; a
//   throw here would break sends. Every failure degrades to the fallback and
//   logs `[agency]`.
//
// CACHE
// ────────────────────────────────────────────────────────────────────────────
// Per-tenant with a TTL — deliberately NOT a permanent Map. An unbounded
// permanent cache is what caused the iadm-webhooks `senderCache` incident: it
// held a stale ACS sender for the life of the process and outbound mail kept
// using the wrong sender long after the DB was fixed. Here a tenant can be
// re-parented (direct → agency_client) at any time, so a permanent cache would
// route a client's notifications to the wrong agency until the app restarted.
// The map is also bounded so a hostile/odd tenant-id stream cannot grow it.
//
// DATABASE
// ────────────────────────────────────────────────────────────────────────────
// core.tenants lives in iadm_platform; most callers hold an iadm_services
// pool. Querying core.tenants from a services pool is the cross-database trap
// that silently broke loadAdminEmails (returns [] there to this day). This
// module therefore ALWAYS uses getPlatformPool() and never accepts a services
// pool. A caller may inject a pool (tests) via opts.pool.
//
// Kept byte-for-byte in step with oliver-api/lib/agency.js — same contract,
// same cache semantics. Change both together.

import sql from "mssql";
import { getPlatformPool } from "../db/platformPool.js";

// ── SEAMS PACK 4B: THE ONE PLACE IN THIS REPO THAT HOLDS THE GUID ─────────
//
// Seams audit §4 / §0 item 9: the literal was pasted into runtime source in
// six repos, and its damage line is one sentence — nobody can change the
// founder tenant, ever. Migration 138's `tenant_kind` model exists precisely
// so a SECOND agency can run this platform.
//
// In arion-api it lived in four more runtime files: lib/devAuth.js,
// middleware/enforceViewAsReadOnly.js, routes/argus.js and routes/sso.js.
// They import from here now, and test/founder-tenant-one-module.test.mjs
// fails on any new hit in runtime source.
//
// WHY THE LITERAL IS STILL THE DEFAULT: `FOUNDER_TENANT_ID` is not set in
// production app settings (checked 2026-09-01 and again on this pass), so the
// default is what actually runs. Removing it would not force the config to be
// right; it would take the founder surfaces down on the next deploy.
export const FOUNDER_TENANT_ID_DEFAULT = "8C9527B9-8999-4B31-A306-F3D4CCC39FBD";

/** The founder / platform-owner tenant, UPPERCASE. Read as a function so a
 *  late-set env var (or a test) is honoured rather than frozen at import. */
export function founderTenantId(env = process.env) {
  return String(env?.FOUNDER_TENANT_ID || FOUNDER_TENANT_ID_DEFAULT).trim().toUpperCase();
}

/** Case-insensitive comparison against the founder tenant. */
export function isFounderTenantId(value, env = process.env) {
  const v = String(value || "").trim().toUpperCase();
  return !!v && v === founderTenantId(env);
}

// Last-resort answer when core.tenants cannot answer the question. Keeping the
// historical GUID here means a lookup failure degrades to exactly today's
// behaviour instead of dropping a notification.
export const PLATFORM_OWNER_FALLBACK_TENANT_ID = founderTenantId();

// Kinds that ARE an agency (they serve clients, so they are their own agency).
export const AGENCY_KINDS = new Set(["platform_owner", "agency"]);

const SUCCESS_TTL_MS = Number(process.env.AGENCY_CACHE_TTL_MS || 5 * 60 * 1000);
// Failures get a much shorter TTL: a fallback must not stick around, but we
// also must not hammer the platform DB on every notification while it is down.
const FAILURE_TTL_MS = Number(process.env.AGENCY_CACHE_FAILURE_TTL_MS || 15 * 1000);
const CACHE_MAX_ENTRIES = 1000;

/** @type {Map<string, {value: string, ok: boolean, expiresAt: number}>} */
const _cache = new Map();

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    _cache.delete(key);
    return null;
  }
  return hit;
}

function cacheSet(key, value, ok) {
  // Bounded: evict the oldest insertion (Map preserves insertion order).
  if (_cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(key, {
    value,
    ok,
    expiresAt: Date.now() + (ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
  });
}

/** Test/ops hook — drop every cached resolution. */
export function clearAgencyCache() {
  _cache.clear();
}

function norm(v) {
  const s = String(v ?? "").trim();
  return s ? s.toUpperCase() : null;
}

// One round trip, one database (iadm_platform). Scalar subqueries so a missing
// tenant row still returns the platform owner instead of an empty recordset.
export const AGENCY_LOOKUP_SQL = `
  SELECT
    (SELECT TOP 1 t.tenant_kind        FROM core.tenants t WHERE t.tenant_id = @tid) AS tenant_kind,
    (SELECT TOP 1 t.provider_tenant_id FROM core.tenants t WHERE t.tenant_id = @tid) AS provider_tenant_id,
    (SELECT TOP 1 o.tenant_id          FROM core.tenants o WHERE o.tenant_kind = 'platform_owner'
       ORDER BY o.created_at, o.tenant_id) AS platform_owner_tenant_id
`;

/**
 * Resolve the agency tenant that serves `tenantId`.
 *
 * @param {string|null|undefined} tenantId
 * @param {{pool?: object, bypassCache?: boolean}} [opts]
 * @returns {Promise<string>} UPPERCASE tenant GUID. Never rejects.
 */
export async function resolveAgencyTenantId(tenantId, opts = {}) {
  const key = norm(tenantId);
  if (!key) {
    // No tenant in context at all (unauthenticated / internal job). The only
    // sane answer is the platform owner.
    return PLATFORM_OWNER_FALLBACK_TENANT_ID;
  }

  if (!opts.bypassCache) {
    const hit = cacheGet(key);
    if (hit) return hit.value;
  }

  try {
    const pool = opts.pool || (await getPlatformPool());
    const r = await pool
      .request()
      .input("tid", sql.UniqueIdentifier, key)
      .query(AGENCY_LOOKUP_SQL);

    const row = r?.recordset?.[0] || {};
    const kind = row.tenant_kind ? String(row.tenant_kind).trim() : null;
    const provider = norm(row.provider_tenant_id);
    const platformOwner = norm(row.platform_owner_tenant_id);

    if (!kind) {
      console.warn(
        `[agency] tenant ${key} not found in core.tenants — falling back to ${platformOwner || PLATFORM_OWNER_FALLBACK_TENANT_ID}`
      );
      const fb = platformOwner || PLATFORM_OWNER_FALLBACK_TENANT_ID;
      cacheSet(key, fb, false);
      return fb;
    }

    // An agency is its own agency.
    if (AGENCY_KINDS.has(kind)) {
      cacheSet(key, key, true);
      return key;
    }

    // A client of an agency → that agency.
    if (kind === "agency_client") {
      if (provider) {
        cacheSet(key, provider, true);
        return provider;
      }
      console.warn(
        `[agency] tenant ${key} is agency_client with NULL provider_tenant_id — falling back to platform owner`
      );
      const fb = platformOwner || PLATFORM_OWNER_FALLBACK_TENANT_ID;
      cacheSet(key, fb, false);
      return fb;
    }

    // 'direct' (self-serve, no agency) and any future kind: the platform owner
    // is the party that serves them.
    if (platformOwner) {
      cacheSet(key, platformOwner, true);
      return platformOwner;
    }
    console.warn(
      `[agency] no platform_owner tenant found for ${key} (kind=${kind}) — falling back to ${PLATFORM_OWNER_FALLBACK_TENANT_ID}`
    );
    cacheSet(key, PLATFORM_OWNER_FALLBACK_TENANT_ID, false);
    return PLATFORM_OWNER_FALLBACK_TENANT_ID;
  } catch (e) {
    // Fire-and-forget contract: never throw out of here.
    console.error(
      `[agency] lookup failed for ${key}: ${e?.message} — falling back to ${PLATFORM_OWNER_FALLBACK_TENANT_ID}`
    );
    cacheSet(key, PLATFORM_OWNER_FALLBACK_TENANT_ID, false);
    return PLATFORM_OWNER_FALLBACK_TENANT_ID;
  }
}

/**
 * True when `tenantId` IS an agency (platform_owner | agency) — i.e. it is its
 * own provider. This is the generalization of the old
 * `tenantId === FOUNDER_TENANT_ID` provider check.
 */
export async function isAgencyTenant(tenantId, opts = {}) {
  const key = norm(tenantId);
  if (!key) return false;
  return (await resolveAgencyTenantId(key, opts)) === key;
}

/**
 * Express middleware — resolve the agency ONCE per request and stamp it on the
 * request so downstream handlers stay synchronous.
 *
 *   req.agencyTenantId  the agency serving the caller's tenant (UPPERCASE)
 *   req.isAgencyCaller  true when the caller's tenant IS that agency
 *
 * Mount AFTER tenantResolution. Never fails the request: on any error it
 * stamps the fallback, which is exactly the pre-existing behaviour.
 */
export function attachAgencyContext() {
  return async function agencyContext(req, _res, next) {
    try {
      const tid = req.tenant?.tenantId || null;
      const agency = await resolveAgencyTenantId(tid);
      req.agencyTenantId = agency;
      req.isAgencyCaller = !!tid && String(tid).toUpperCase() === agency;
    } catch (e) {
      console.error("[agency] attachAgencyContext failed:", e?.message);
      req.agencyTenantId = PLATFORM_OWNER_FALLBACK_TENANT_ID;
      req.isAgencyCaller =
        String(req.tenant?.tenantId || "").toUpperCase() === PLATFORM_OWNER_FALLBACK_TENANT_ID;
    }
    next();
  };
}

/**
 * Synchronous read of the agency for the CURRENT request. Returns the stamped
 * value from attachAgencyContext, or the fallback when the middleware did not
 * run (so a router mounted without it behaves exactly as it did before).
 */
export function agencyTenantIdOf(req) {
  return req?.agencyTenantId || PLATFORM_OWNER_FALLBACK_TENANT_ID;
}

/** Synchronous "is this caller their own agency?" for the current request. */
export function isAgencyCaller(req) {
  const caller = norm(req?.tenant?.tenantId);
  if (!caller) return false;
  return caller === agencyTenantIdOf(req);
}
