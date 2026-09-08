// lib/contentAgent/serankingHealth.js
//
// Tells "SE Ranking answered and there is genuinely nothing" apart from
// "SE Ranking is down or misconfigured". The scope gives those OPPOSITE
// recoveries, and today they are indistinguishable.
//
// THE PROBLEM
//
// lib/serankingData.js swallows every failure. dataRequest() catches, retries
// three times, logs to console, and returns null; each exported function then
// converts null into []. researchKeyword() goes further and wraps every call in
// .catch(() => []). So a caller receives [] for all of:
//
//   * the API returned zero rows          -> edge case E1
//   * the Data API key is wrong (401)     -> failure mode F1
//   * SE Ranking is having an outage      -> failure mode F1
//   * the key is not set at all           -> misconfiguration
//
// That matters because the documented recoveries diverge:
//
//   E1  "no qualifying topic this cycle"  -> log it, skip the slot, do NOT
//                                            substitute anything. This is the
//                                            agent working correctly.
//   F1  SE Ranking unavailable            -> fall back to a backlog topic AND
//                                            alert Brandon. Scenario 3 in the
//                                            scope is explicit that he must see
//                                            "SE Ranking unavailable, ran on
//                                            backlog" rather than a silent bad
//                                            output.
//
// Collapse them and the agent quietly reports "no good topics this week" every
// week while the integration has been dead since a key rotation. That is the
// platform's catch-swallow-report-success pattern with a content-shaped hat on.
//
// THE 401 IS THE LIKELY ONE. SE Ranking uses two different keys for two hosts:
// the legacy Project API on api4.seranking.com and the unified v1 API on
// api.seranking.com/v1. Each returns 401 for the other's key. The ARION
// blueprint documents this as a known silent-401 failure mode.
//
// WHY A SEPARATE PROBE RATHER THAN CHANGING THE SHARED CLIENT
//
// lib/serankingData.js is shared code with existing callers that rely on
// []-on-failure. Changing its contract to throw would be a blast-radius edit
// across features this build has no business touching. So this module makes its
// own small request and reads the HTTP status directly, leaving the shared
// client's behaviour exactly as it is.
//
// The probe only runs when a research call comes back EMPTY, so the normal path
// pays nothing for it.
//
// Health is judged on the PRESENCE of a positive signal (HTTP 200 + a parseable
// body), never on the absence of an error. Absence-based guards fail open, and
// failing open here means publishing on a dead integration.

const DATA_BASE = process.env.SERANKING_DATA_API_BASE || 'https://api.seranking.com/v1';

const DATA_KEY = () => process.env.SERANKING_DATA_API_KEY
  || process.env['SE-RANKING-DATA-API-KEY']
  || process.env.SE_RANKING_DATA_API_KEY;

/** Health verdicts. Only HEALTHY permits an empty result to be read as E1. */
export const HEALTH = {
  HEALTHY: 'healthy',              // 200 + parseable body — empty means empty
  AUTH_FAILED: 'auth_failed',      // 401/403 — the dual-key trap (F1)
  NOT_CONFIGURED: 'not_configured',// no key present at all
  UNAVAILABLE: 'unavailable',      // 5xx, network, timeout (F1)
};

/** A verdict that is not HEALTHY means the pipeline must treat results as F1. */
export function isUsable(verdict) {
  return verdict === HEALTH.HEALTHY;
}

/**
 * Probe the SE Ranking Data API with one cheap, well-known request.
 *
 * Deliberately does NOT retry: this runs precisely when we suspect the provider
 * is unhealthy, and three more retries would triple the latency of a run that is
 * already going to fall back. lib/serankingData.js has already retried 3x by the
 * time we get here.
 *
 * @returns {Promise<{verdict: string, status: number|null, detail: string}>}
 */
export async function probeDataApi({ timeoutMs = 15_000, fetchImpl = fetch } = {}) {
  const key = DATA_KEY();
  if (!key) {
    return {
      verdict: HEALTH.NOT_CONFIGURED,
      status: null,
      detail: 'SERANKING_DATA_API_KEY / SE-RANKING-DATA-API-KEY is not set',
    };
  }

  // "seo" is a guaranteed-populated term. If SE Ranking returns zero rows for
  // it, something is wrong with the API, not with our keyword.
  const params = new URLSearchParams({ source: 'us' });
  params.append('keywords[]', 'seo');
  const url = `${DATA_BASE}/keywords/overview?${params.toString()}`;

  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      verdict: HEALTH.UNAVAILABLE,
      status: null,
      detail: `network/timeout: ${String(err?.message || err).slice(0, 200)}`,
    };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      verdict: HEALTH.AUTH_FAILED,
      status: res.status,
      // Name the actual cause. A bare "401" sends the next person key-hunting
      // when the key is fine and merely pointed at the wrong host.
      detail: `HTTP ${res.status} from ${DATA_BASE}. This is the documented dual-key `
        + 'failure: the Data API key works on api.seranking.com/v1 and returns 401 on '
        + 'api4.seranking.com, and the legacy Project API key does the reverse. Check '
        + 'that SERANKING_DATA_API_KEY holds the v1 key, not the Project API key.',
    };
  }

  if (!res.ok) {
    return { verdict: HEALTH.UNAVAILABLE, status: res.status, detail: `HTTP ${res.status}` };
  }

  // A 200 is necessary but not sufficient — require a parseable body of the
  // expected shape. A proxy or captive portal can return 200 with HTML.
  let body;
  try {
    body = await res.json();
  } catch {
    return { verdict: HEALTH.UNAVAILABLE, status: res.status, detail: '200 with unparseable body' };
  }
  if (!Array.isArray(body)) {
    return {
      verdict: HEALTH.UNAVAILABLE,
      status: res.status,
      detail: `200 with unexpected body shape: ${typeof body}`,
    };
  }

  return { verdict: HEALTH.HEALTHY, status: res.status, detail: `200, ${body.length} row(s)` };
}

/**
 * Wrap a research call so an empty result is CLASSIFIED rather than guessed at.
 *
 * Returns { ok, rows, verdict, detail }:
 *   ok:true  + rows.length      -> normal path, no probe was needed
 *   ok:true  + rows empty       -> provider healthy, genuinely nothing (E1)
 *   ok:false                    -> provider unhealthy (F1); caller must fall
 *                                  back to backlog AND alert, never treat as E1
 *
 * @param {() => Promise<Array>} researchFn a lib/serankingData.js call
 */
export async function researchWithHealth(researchFn, { probe = probeDataApi } = {}) {
  let rows;
  try {
    rows = await researchFn();
  } catch (err) {
    // The shared client is not supposed to throw, but if it ever does, that is
    // unambiguously a provider problem — not an empty result set.
    const p = await probe();
    return {
      ok: false,
      rows: [],
      verdict: p.verdict === HEALTH.HEALTHY ? HEALTH.UNAVAILABLE : p.verdict,
      detail: `research call threw: ${String(err?.message || err).slice(0, 200)}`,
    };
  }

  if (Array.isArray(rows) && rows.length > 0) {
    // Data came back. The provider is demonstrably alive; no probe needed.
    return { ok: true, rows, verdict: HEALTH.HEALTHY, detail: `${rows.length} row(s)` };
  }

  // Empty. This is the ambiguous case, and the only one worth paying for.
  const p = await probe();
  if (p.verdict === HEALTH.HEALTHY) {
    return { ok: true, rows: [], verdict: HEALTH.HEALTHY, detail: 'provider healthy, zero rows (E1)' };
  }
  return { ok: false, rows: [], verdict: p.verdict, detail: p.detail };
}

export default { HEALTH, isUsable, probeDataApi, researchWithHealth };
