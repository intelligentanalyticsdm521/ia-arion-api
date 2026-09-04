// lib/founderClient.js — arion-api's thin client for the ONE founder answer.
// Seams audit §4 / §0 item 9.
//
// The predicate lives in platform-api `lib/founder.js` and is served at
// POST /internal/founder. NOTHING IN THIS FILE DECIDES WHO THE FOUNDER IS.
//
// WHAT IT REPLACES, IN THIS REPO: middleware/requireFounder.js ran its OWN
// platform-role SQL (findFounderRole), and middleware/enforceViewAsReadOnly.js
// ran a SECOND, different query with its own 60-second cache — two of the six
// implementations across four repos, asking two of the three questions:
//
//   · a TENANT comparison            (LUMEN lib/myBrand/tierCheck.js)
//   · MEMBERSHIP of the founder tenant (this file's predecessor, and the
//     identical copies in LUMEN and arion)
//   · a PLATFORM ROLE                (platform-api, and the only one that is
//     authorization per reference_role_access_model)
//
// The route answers all three separately and by name, so nothing has to be
// collapsed here: `isFounder` is the role, `isFounderTeam` is the membership.
// This repo's view-as gate keeps asking the MEMBERSHIP question, because that
// is what it has always asked and changing the population it admits is not a
// consolidation — it is a policy change, and it belongs to whoever owns
// view-as, not to a pack that is deleting duplicates.
//
// ── FAIL CLOSED, AND SAY WHICH KIND OF CLOSED ─────────────────────────────
// This throws `FounderUnavailable` when it cannot get an answer — it never
// returns `false`. A gate that reads "could not check" as "not a founder"
// tells the caller "we checked and you may not", which is a lie they cannot
// act on, and it is what the old `catch { founder = false }` did. The gate
// turns a throw into 500 (retryable) and a real `false` into 403.
//
// Unconfigured is unreachable, NOT "allow": the same rule as
// lib/notificationGate.js. An unconfigured guard that lets traffic through is
// how /internal became an open relay in June.
//
// ── THE CACHE ─────────────────────────────────────────────────────────────
// 60 seconds per identity, matching the TTL the deleted in-repo check used.
// A founder grant is an administrative act, not an asynchronous event, and the
// alternative is a platform-api round trip on every request of a view-as
// session. Only POSITIVE and NEGATIVE ANSWERS are cached — never a failure, so
// an outage lasts as long as the outage and not a minute longer.
//
// REQUIRES: PLATFORM_API_URL and PLATFORM_INTERNAL_TOKEN (SEAM-11).

import { platformApiUrl, platformInternalToken } from "./platformEnv.js";

export class FounderUnavailable extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "FounderUnavailable";
    this.reason = reason;
  }
}

export const FOUNDER_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5000;

const _cache = new Map();
const CACHE_MAX = 500;

export function clearFounderCache() { _cache.clear(); }

/** The identity a set of verified claims names. Same five spellings every
 *  caller had to handle; kept in one place so they cannot drift again. */
export function identityFromClaims(claims) {
  const c = claims || {};
  const email = String(
    c.email || c.preferred_username || c.upn ||
    (Array.isArray(c.emails) ? c.emails.find((x) => typeof x === "string" && x.includes("@")) : "") || ""
  ).trim().toLowerCase();
  const externalSubject = String(c.oid || c.sub || "").trim();
  return { email: email || null, externalSubject: externalSubject || null };
}

/**
 * Ask platform-api about a caller.
 *
 * @param {object} claims verified JWT claims for the caller in front of you
 * @param {{fetchImpl?:Function, now?:Function}} [opts]
 * @returns {Promise<{is_founder:boolean, is_founder_team:boolean,
 *                    agency_grant:string|null, role_key:string|null}>}
 * @throws {FounderUnavailable}
 */
export async function resolveFounderFacts(claims, opts = {}) {
  const { email, externalSubject } = identityFromClaims(claims);
  if (!email && !externalSubject) {
    // Not a failure: nobody was named. A real, cacheable "no".
    return { is_founder: false, is_founder_team: false, agency_grant: null, role_key: null };
  }
  const key = `${externalSubject || ""}|${email || ""}`;
  const now = opts.now || Date.now;
  const hit = _cache.get(key);
  if (hit && now() - hit.at < FOUNDER_TTL_MS) return hit.facts;

  const base = platformApiUrl();
  const token = platformInternalToken();
  if (!base) throw new FounderUnavailable("founder_not_configured", "PLATFORM_API_URL is not set");
  if (!token) throw new FounderUnavailable("founder_not_configured", "no platform internal token is set");

  const doFetch = opts.fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await doFetch(`${base}/internal/founder`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": token },
      body: JSON.stringify({ email, external_subject: externalSubject }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new FounderUnavailable("founder_unreachable", e?.message || String(e));
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = `${detail} ${JSON.stringify(await res.json())}`; } catch { /* not JSON */ }
    throw new FounderUnavailable("founder_unavailable", detail);
  }
  let facts;
  try { facts = await res.json(); } catch (e) { throw new FounderUnavailable("founder_bad_response", e?.message); }
  if (typeof facts?.is_founder !== "boolean") {
    throw new FounderUnavailable("founder_bad_response", JSON.stringify(facts).slice(0, 200));
  }

  if (_cache.size >= CACHE_MAX) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(key, { facts, at: now() });
  return facts;
}

export default { resolveFounderFacts, clearFounderCache, FounderUnavailable, identityFromClaims };
