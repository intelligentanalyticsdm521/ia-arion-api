// lib/entitlements.js — oliver's THIN CLIENT for the one entitlement answer.
//
// SEAMS AUDIT §3 / SEAM-3-A. The decision lives in platform-api
// (lib/entitlements.js + GET /internal/entitlements/:tenantId). This file only
// fetches it and caches it, exactly like lib/notificationGate.js fetches the
// one preference gate and lib/ownerAlert.js posts to /internal/push.
//
// THERE IS NO SECOND RESOLVER IN HERE, AND THERE MUST NEVER BE ONE.
// oliver still owns the CHECKOUT side of Stripe — routes/billing.js,
// routes/subscriptions.js, routes/webhooks.js and lib/multiProductCoupon.js —
// and that is a different job: it CREATES customers and subscriptions, and a
// gate must never do that. The read-only "what did they buy?" question is
// answered in one place for the whole platform.
//
// ═══ SEAM-3-B — allow the FEATURE, refuse the SPEND ═════════════════════════
// mayUseFeature() and maySpend() below are copied VERBATIM from platform-api's
// lib/entitlements.js and pinned by test/entitlements-client.test.mjs. The rule
// also rides in the payload as `rule`, in words, so a future reader does not
// have to find this comment.
//
// FAIL DIRECTION OF THE FETCH ITSELF. An unreachable or unconfigured
// platform-api yields `null`, and null means UNDECIDED, which means the same
// two things: features open, spending shut. That is deliberately NOT the
// notification gate's stance next door — that one refuses to send when it
// cannot decide, because the failure there is a message reaching somebody who
// asked us to stop. The failure here is a paying customer staring at a locked
// page, so it points the other way. Two internal seams, two fail directions,
// each written down where it applies.

import {
  mayUseFeature as _mayUseFeature,
  maySpend as _maySpend,
} from "./entitlementsRule.js";

const CACHE_TTL_MS = 60 * 1000;
const _cache = new Map(); // tenantId(lower) -> { at, payload }

export function clearEntitlementCache(tenantId) {
  if (tenantId) _cache.delete(String(tenantId).toLowerCase());
  else _cache.clear();
}

function baseUrl(env = process.env) {
  return (env.PLATFORM_API_URL || env.PLATFORM_API_BASE_URL || "").trim().replace(/\/+$/, "");
}

function token(env = process.env) {
  return (env.PLATFORM_INTERNAL_TOKEN
    || env.PLATFORM_INTERNAL_SERVICE_TOKEN
    || env.LUMEN_INTERNAL_SERVICE_TOKEN
    || "").trim();
}

/**
 * The payload for one business, or null when we could not get one.
 * Never throws — every caller of this is a gate, and a gate that throws is an
 * outage with extra steps.
 *
 * @param {object} [deps.fetchImpl] test seam
 */
export async function getEntitlements(tenantId, deps = {}) {
  const env = deps.env || process.env;
  const key = String(tenantId || "").toLowerCase();
  if (!key) return null;

  if (!deps.force) {
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.payload;
  }

  const base = baseUrl(env);
  const tok = token(env);
  if (!base || !tok) {
    // Logged once per minute per business rather than on every gate — an
    // unconfigured seam is an operational fault, not a per-request event.
    console.warn(`[entitlements] PLATFORM_API_URL / PLATFORM_INTERNAL_TOKEN not set — entitlement undecided for ${key}`);
    return null;
  }

  const doFetch = deps.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.ENTITLEMENT_TIMEOUT_MS || 4000));
  try {
    const res = await doFetch(`${base}/internal/entitlements/${encodeURIComponent(tenantId)}`, {
      method: "GET",
      headers: { "x-internal-token": tok },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[entitlements] platform-api answered ${res.status} for ${key}`);
      return null;
    }
    const payload = await res.json();
    // Only a DECIDED answer is worth keeping for a minute. An undecided one is
    // re-asked, so a blip costs one slow minute rather than sixty seconds of
    // telling a paying customer no.
    if (payload && payload.decided) _cache.set(key, { at: Date.now(), payload });
    return payload || null;
  } catch (err) {
    console.warn(`[entitlements] could not reach platform-api for ${key}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The product node, or null when there is no payload. */
export function productOf(payload, product) {
  return payload?.products?.[String(product || "").toLowerCase()] || null;
}

/** The add-on node, or null when there is no payload. */
export function addonOf(payload, addon) {
  return payload?.addons?.[String(addon || "").toLowerCase()] || null;
}

export const mayUseFeature = _mayUseFeature;
export const maySpend = _maySpend;

export default { getEntitlements, clearEntitlementCache, productOf, addonOf, mayUseFeature, maySpend };
