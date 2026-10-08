// lib/productOwnership.js — "does this business have <product> switched on?",
// asked by every background job before it does work for a business.
//
// Scope: overnight-report/SCOPE_ACCESS_FOLLOWS_SUBSCRIPTION_2026-10-07.md §4.3
// ("Agents and timers stop"). When a business stops paying for a product, the
// product's API already refuses it (§4.1, requireArionAccess). The timers did
// not: the content agent kept drafting and GBP auto-reply kept answering
// Google reviews (and spending credits) for a business whose ARION had ended.
// Every runner now asks here, right after it has chosen its businesses, and
// leaves out the ones whose product is off.
//
// A DECLARED COPY of oliver-api lib/productOwnership.js (same rule, same SQL,
// same words), one per repo the way lib/entitlementsRule.js is. Change both.
//
// THE ANSWER comes from the same table every product gate reads:
// iadm_platform core.tenant_services (+ core.services, core.tenants).
//   ON   = a row for the product with is_enabled = 1 on an active service, or
//          the business is the platform owner or an agency (never switched off
//          by the subscription, scope §1.2).
//   OFF  = the business is known and has no such row. This is the same answer
//          the product's own API gives (requireArionAccess here; requireOliverAccess
//          and requireStellaAccess in oliver-api):
//          a business the API refuses must not get its timers either.
//
// WHEN WE DO NOT KNOW, NOTHING CHANGES. (Brandon's standing rule for this build:
// never deny on "we don't know".) If the platform database cannot be read, if it
// answers with no rows at all for a non-empty question (a wrong database or a
// half-read looks like that), or if one business is missing from core.tenants,
// that business is KEPT and the runner runs exactly as it did before this file
// existed. The reason is logged at error so a person sees it. Decided here, and
// a departure from the scope's sketch ("skip that run"): see the stream-3
// report; flipping it is the one constant UNDECIDED_RUNS_AS_BEFORE.
//
// CACHE: decided answers only, 60 seconds per product and business. A failure is
// never cached, so the next tick asks again.
import sql from "mssql";

export const UNDECIDED_RUNS_AS_BEFORE = true;
export const CACHE_TTL_MS = 60 * 1000;

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEPT_KINDS = new Set(["platform_owner", "agency"]);
const PRODUCT_NAMES = { oliver: "OLIVER", stella: "STELLA", spark: "SPARK", arion: "ARION" };
// The gates read their service key from these settings (requireOliverAccess,
// requireStellaAccess, requireArionAccess). The copy must read the same one,
// or a set variable would read every business as "not part of the plan".
const SERVICE_KEY_ENV = { oliver: "OLIVER_SERVICE_KEY", stella: "STELLA_SERVICE_KEY", arion: "ARION_SERVICE_KEY" };

const _cache = new Map(); // `${product}:${TENANTID}` -> { at, on, reason }

/** Forget cached answers (tests, or a founder who just switched a product back on). */
export function clearOwnershipCache() { _cache.clear(); }

const norm = (v) => String(v || "").trim().toUpperCase();
export const productName = (product) => PRODUCT_NAMES[String(product).toLowerCase()] || String(product).toUpperCase();

/** The core.services.service_key the product's gate reads (env override, as the gate does). */
export function serviceKeyFor(product, env = process.env) {
  const key = String(product || "").trim().toLowerCase();
  const name = SERVICE_KEY_ENV[key];
  const v = name ? String(env?.[name] || "").trim() : "";
  return (v || key).toLowerCase();
}

/**
 * The sentence a runner's summary carries for a business it left out: which
 * product, what did not happen, and what brings it back.
 *   ended=true  -> "SPARK has ended for this business, so the Responder did not
 *                  answer this lead. It starts again after a re-subscribe."
 *   ended=false -> "SPARK isn't part of this business's plan, so ..."
 */
export function skipSentence(product, ended, did = "nothing was run for it") {
  const p = productName(product);
  return ended
    ? `${p} has ended for this business, so ${did}. It starts again after a re-subscribe.`
    : `${p} isn't part of this business's plan, so ${did}.`;
}

/**
 * Of these businesses, which have `product` on?
 *
 * Never throws. Returns:
 *   owned     — the ids to run for, as they were passed in (order kept)
 *   off       — [{ tenantId, reason }] the ids left out, with the reason in words
 *   undecided — true when the read failed or made no sense; then owned = every id
 *   unknown   — ids missing from core.tenants (kept, logged)
 *   error     — what went wrong, when undecided
 *
 * @param {object} platformPool  connected mssql pool on iadm_platform
 * @param {'oliver'|'stella'|'spark'|'arion'} product  core.services.service_key
 * @param {Array<string>} tenantIds
 * @param {object} [deps]  { log, now } test seams
 */
export async function filterOwned(platformPool, product, tenantIds, deps = {}) {
  const { log = console, now = Date.now, env = process.env } = deps;
  const key = String(product || "").trim().toLowerCase();
  const serviceKey = serviceKeyFor(key, env);
  const passed = [...(tenantIds || [])];
  const out = { product: key, owned: [], off: [], unknown: [], unconfirmed: [], undecided: false, error: null };
  if (!passed.length) return out;

  const asked = [...new Set(passed.map(norm).filter((id) => GUID_RE.test(id)))];
  const verdict = new Map(); // TENANTID -> { on, reason }
  const t = now();
  const toRead = [];
  for (const id of asked) {
    const hit = _cache.get(`${serviceKey}:${id}`);
    if (hit && t - hit.at < CACHE_TTL_MS) verdict.set(id, hit);
    else toRead.push(id);
  }

  if (toRead.length) {
    let rows;
    try {
      if (!platformPool || typeof platformPool.request !== "function") throw new Error("no platform database connection");
      const r = await platformPool.request()
        .input("ids", sql.NVarChar(sql.MAX), JSON.stringify(toRead))
        .input("product", sql.NVarChar(100), serviceKey)
        .query(`
          SELECT t.tenant_id, t.tenant_kind,
                 CAST(CASE WHEN EXISTS (
                   SELECT 1 FROM core.tenant_services ts
                     JOIN core.services s ON s.service_id = ts.service_id
                    WHERE ts.tenant_id = t.tenant_id
                      AND ts.is_enabled = 1 AND s.is_active = 1
                      AND LOWER(s.service_key) = @product) THEN 1 ELSE 0 END AS BIT) AS has_on,
                 CAST(CASE WHEN EXISTS (
                   SELECT 1 FROM core.tenant_services ts
                     JOIN core.services s ON s.service_id = ts.service_id
                    WHERE ts.tenant_id = t.tenant_id
                      AND LOWER(s.service_key) = @product) THEN 1 ELSE 0 END AS BIT) AS has_row
            FROM core.tenants t
           WHERE t.tenant_id IN (SELECT TRY_CAST([value] AS UNIQUEIDENTIFIER) FROM OPENJSON(@ids))`);
      rows = r?.recordset;
      if (!Array.isArray(rows)) throw new Error("the platform database gave an answer this code does not understand");
      if (rows.length === 0) throw new Error(`the platform database knows none of the ${toRead.length} businesses asked about`);
    } catch (e) {
      out.undecided = true;
      out.error = `could not check which businesses have ${productName(key)}: ${e.message}`;
      log.error?.("[productOwnership]", `${out.error} — running for every business as before`);
      if (UNDECIDED_RUNS_AS_BEFORE) { out.owned = passed; return out; }
      out.off = passed.map((tenantId) => ({ tenantId, reason: "could not be checked" }));
      return out;
    }
    for (const row of rows) {
      const id = norm(row.tenant_id);
      const kind = String(row.tenant_kind || "").trim().toLowerCase();
      let v;
      if (KEPT_KINDS.has(kind)) v = { on: true, reason: kind };
      else if (row.has_on === true || row.has_on === 1) v = { on: true, reason: "switched on" };
      else if (row.has_row === true || row.has_row === 1) v = { on: false, ended: true, reason: `${productName(key)} is switched off` };
      else v = { on: false, ended: false, reason: `${productName(key)} is not part of this business's plan` };
      verdict.set(id, v);
      _cache.set(`${serviceKey}:${id}`, { at: t, ...v });
    }
  }

  for (const original of passed) {
    const id = norm(original);
    const v = verdict.get(id);
    if (!v) {
      // Missing from core.tenants, not an id at all, or SPARK's off could not
      // be confirmed: we do not know, so we do not take it away.
      if (!out.unconfirmed.includes(id)) out.unknown.push(original);
      out.owned.push(original);
      continue;
    }
    if (v.on) out.owned.push(original);
    else out.off.push({ tenantId: original, reason: v.reason, ended: !!v.ended });
  }
  if (out.unknown.length) {
    log.error?.("[productOwnership]",
      `${out.unknown.length} business(es) not found in the platform database while checking ${productName(key)}; ran for them as before: ${out.unknown.join(", ")}`);
  }
  return out;
}

/**
 * The runners' default: open the platform pool and ask. Never throws; a pool
 * that cannot be opened is "undecided" like any other failed read.
 *
 * @param {string} product
 * @param {Array<string>} tenantIds
 * @param {object} [deps] { getPlatformPool, log }
 */
export async function checkOwnership(product, tenantIds, deps = {}) {
  const log = deps.log || console;
  let pool;
  try {
    const get = deps.getPlatformPool || (await import("../db/platformPool.js")).getPlatformPool;
    pool = await get();
  } catch (e) {
    pool = null;
    log.error?.("[productOwnership]", `platform database unavailable: ${e.message}`);
  }
  const verdict = await filterOwned(pool, product, tenantIds, { log, env: deps.env });
  if (verdict.off.length) {
    log.log?.("[productOwnership]",
      `${productName(product)} is off for ${verdict.off.length} business(es), so nothing was run for them: ${verdict.off.map((o) => `${o.tenantId} (${o.reason})`).join(", ")}`);
  }
  return verdict;
}

/**
 * What a runner's summary says about the check, in one object:
 *   { product, skipped: [{ tenantId, reason, ended, note }], undecided, error, unknown, unconfirmed }
 * `did` names what this runner did not do ("the Responder did not answer this
 * lead"), so the note says which job stopped and what brings it back.
 */
export function ownershipSummary(verdict, did) {
  return {
    product: verdict.product,
    skipped: verdict.off.map((o) => ({ tenantId: o.tenantId, reason: o.reason, ended: !!o.ended, note: skipSentence(verdict.product, !!o.ended, did) })),
    undecided: verdict.undecided,
    error: verdict.error,
    unknown: verdict.unknown,
    unconfirmed: verdict.unconfirmed || [],
  };
}

export default { filterOwned, checkOwnership, ownershipSummary, skipSentence, clearOwnershipCache, productName, serviceKeyFor };
