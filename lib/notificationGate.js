// lib/notificationGate.js — arion-api's thin client for the ONE preference gate.
//
// BYTE-IDENTICAL IN CONTRACT to arion-func src/shared/notificationGate.js and to
// LUMEN's, oliver's and iadm-webhooks' copies. arion-api did not have one because
// nothing on this line sent a gated message until the ARION Content & Social
// Agent arrived: its escalation, cost-halt and margin alerts address the business
// owner, and they leave through the same door as every other message.
//
// The decision itself lives in platform-api `lib/notificationGate.js` and is
// served at POST /internal/notify/can-send. Six implementations of "may we send
// this person this message?" existed across four repos and disagreed with each
// other (seams audit §2, items 1 and 2); this is one of the four clients that
// replaced them. Nothing in this file decides anything — if you find yourself
// adding a rule here, you are creating the seventh copy.
//
// THE CACHE. 30 seconds, keyed on everything the answer depends on. Long enough
// that a 20-row batch is one call, short enough that a customer who ticks a box
// sees it honoured on the next send rather than after a restart. iadm-webhooks'
// process-lifetime `senderCache` with no expiry cost an afternoon in August;
// every cache on this seam has a TTL for that reason.
//
// FAIL DIRECTION — THE OPPOSITE OF EVERY OTHER CLIENT ON THIS PLATFORM.
// A gate that cannot decide does NOT return "allowed". It throws
// GateUnavailable, and the caller holds the message:
//   · the Content Agent HOLDS the alert, counts it as held in the tick summary,
//     and next Monday asks again — an alert nobody consented to is worse than an
//     alert that is one week late;
//   · the weekly digest and the monthly re-score skip THAT recipient for THIS
//     run and say why on the run row; the next run asks again.
// Nothing is lost. The message is late, not gone. The alternative — send when
// unsure — is a message arriving at somebody who asked us to stop, which is the
// failure this whole pack exists to remove.
//
// REQUIRES, on this App Service: PLATFORM_API_URL (or PLATFORM_API_BASE_URL)
// and PLATFORM_INTERNAL_TOKEN (or PLATFORM_INTERNAL_SERVICE_TOKEN /
// LUMEN_INTERNAL_SERVICE_TOKEN). Unconfigured is treated as unreachable — it is
// NOT treated as "allow": an unconfigured guard that lets traffic through is
// how /internal became an open relay in June.

import { platformApiUrl, platformInternalToken } from "./platformEnv.js";

export class GateUnavailable extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "GateUnavailable";
    this.reason = reason;
  }
}

const CACHE_TTL_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 5000;
const _cache = new Map(); // key -> { at, verdict }

/** Test seam. */
export function clearGateCache() { _cache.clear(); }

export function platformBase() {
  // SEAM-11: PLATFORM_API_URL, then the two legacy names, with one warning at
  // boot naming the file to fix. This was its own fallback chain, in a
  // DIFFERENT order from the one in the three sibling repos — set only one of
  // the two names on the Functions app and half the calls authenticate.
  return platformApiUrl();
}

export function internalToken() {
  return platformInternalToken();
}

function cacheKey({ tenantId, channel, to, categoryKey, contactId }) {
  return [
    String(tenantId).toLowerCase(),
    channel,
    String(to).toLowerCase(),
    categoryKey || "-",
    contactId ? String(contactId).toLowerCase() : "-",
  ].join("|");
}

/**
 * @param {{tenantId:string, channel:'email'|'sms', to:string,
 *          categoryKey?:string|null, contactId?:string|null,
 *          fetchImpl?:Function}} opts
 * @returns {Promise<{allowed:boolean, reason:string|null, contactId:string|null,
 *                    contactRowId:number|null, categoryKey:string|null,
 *                    knownCategory:boolean}>}
 * @throws {GateUnavailable}
 */
export async function canSend(opts) {
  const { tenantId, channel, to } = opts || {};
  const categoryKey = opts?.categoryKey || null;
  const contactId = opts?.contactId || null;
  const doFetch = opts?.fetchImpl || globalThis.fetch;

  if (!tenantId || !channel || !to) {
    return { allowed: false, reason: "missing_required_args", contactId, contactRowId: null, categoryKey, knownCategory: false };
  }

  const key = cacheKey({ tenantId, channel, to, categoryKey, contactId });
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.verdict;

  const base = platformBase();
  const token = internalToken();
  if (!base) throw new GateUnavailable("gate_not_configured", "PLATFORM_API_URL is not set");
  if (!token) throw new GateUnavailable("gate_not_configured", "no platform internal token is set");

  let res;
  try {
    res = await doFetch(`${base}/internal/notify/can-send`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": token },
      body: JSON.stringify({ tenantId, channel, to, categoryKey, contactId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new GateUnavailable("gate_unreachable", e?.message || String(e));
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = `${detail} ${JSON.stringify(await res.json())}`; } catch { /* body is not JSON */ }
    throw new GateUnavailable("gate_unavailable", detail);
  }

  const verdict = await res.json();
  if (typeof verdict?.allowed !== "boolean") {
    throw new GateUnavailable("gate_bad_response", JSON.stringify(verdict).slice(0, 200));
  }
  _cache.set(key, { at: Date.now(), verdict });
  return verdict;
}

export default { canSend, clearGateCache, GateUnavailable, platformBase, internalToken };
