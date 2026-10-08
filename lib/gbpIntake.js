/**
 * lib/gbpIntake.js — what a business's Google listing has for SPARK.
 *
 * DECISION D-69. SPARK's "Google Business Profile" lead source is written and
 * presence-gated: `LUMEN/src/services/intake/providers/gbpCall.js` registers
 * itself ONLY when a reader is configured, so the catalogue card says "coming"
 * until this endpoint exists. THIS is the reader. One Google client on this
 * platform and it is ARION's — LUMEN never grows a second one.
 *
 * TWO HALVES, AND THEY ARE NOT THE SAME KIND OF THING
 * ────────────────────────────────────────────────────────────────────────────
 *   ARRIVALS      a question somebody typed on the listing, under a display
 *                 name, waiting for an answer. A real person, so a real lead.
 *   ATTRIBUTION   the daily CALL_CLICKS and WEBSITE_CLICKS totals. Google
 *                 reports how MANY people tapped Call on Tuesday and never who
 *                 they were. A lead row per tap would be an inbox full of rows
 *                 nobody can ring back, which is worse than the gap. They come
 *                 back as NUMBERS and SPARK shows them as numbers.
 *
 * THE HONEST PART, WHICH IS NOT WHAT THE CATALOGUE ROW ASSUMED
 * ────────────────────────────────────────────────────────────────────────────
 * Google RETIRED the public Business Profile Q&A API in 2022 and never
 * replaced it (`lib/gbpApi.js:647`). There is no endpoint that hands over the
 * questions, for us or for anybody. So the arrivals half is empty TODAY, not
 * because it is unbuilt but because the source does not exist, and this reader
 * says which of those two it is — `questions_available:false` with a reason —
 * rather than returning `[]` and letting SPARK read "no questions today".
 * The loop stays because the seam is the endpoint: if Google restores it, this
 * file changes and nothing downstream does.
 *
 * NOTHING HERE FAILS QUIET. A performance call that fails comes back as an
 * error with Google's own reason on it. Zeroes are a real answer — "nobody
 * tapped Call this week" — and must never be manufactured out of a failure.
 */

import sql from 'mssql';
import { fetchQuestions, fetchPerformance, summarizePerformance } from './gbpApi.js';
import { hasSiteToken, siteRefreshToken } from './gbpTokenAtRest.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Google's performance window. 30 days is what the ARION dashboards use. */
export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 30;
export const MIN_WINDOW_DAYS = 1;

/**
 * The SAME "connected" predicate `lib/gbpReplyRunner.js` loadSites and LUMEN's
 * `services/intake/providers/gbpCall.js connectedSite` use, so "connected"
 * means one thing on both sides of the wire.
 */
export const SITE_SQL = `
  SELECT TOP 1 site_id, tenant_id, gbp_connected, gbp_oauth_token_ref,
         gbp_location_name, status
    FROM arion.site
   WHERE site_id = @siteId`;

/** How many days of clicks to ask for, given when SPARK last looked. */
export function windowDaysFor(since, now = new Date()) {
  if (!since) return DEFAULT_WINDOW_DAYS;
  const then = new Date(since);
  if (Number.isNaN(then.getTime())) return DEFAULT_WINDOW_DAYS;
  const days = Math.ceil((now.getTime() - then.getTime()) / 86400000);
  if (!Number.isFinite(days)) return DEFAULT_WINDOW_DAYS;
  return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, days));
}

/** Questions newer than SPARK's last look. No createTime = keep it and let the
 *  idempotency key on the far side decide; dropping it would lose a real one. */
export function questionsSince(questions, since) {
  const rows = Array.isArray(questions) ? questions : [];
  if (!since) return rows;
  const cut = new Date(since).getTime();
  if (Number.isNaN(cut)) return rows;
  return rows.filter((q) => {
    if (!q || !q.createTime) return true;
    const t = new Date(q.createTime).getTime();
    return Number.isNaN(t) ? true : t > cut;
  });
}

/**
 * @returns one of
 *   { ok:false, status, code, message }
 *   { ok:true, site_id, questions, questions_available, questions_unavailable_reason,
 *     call_clicks, website_clicks, window_days }
 */
export async function readGbpIntake(pool, siteId, opts = {}) {
  const {
    since = null,
    now = new Date(),
    deps = {},
  } = opts;
  const doQuestions = deps.fetchQuestions || fetchQuestions;
  const doPerformance = deps.fetchPerformance || fetchPerformance;
  const doSummarize = deps.summarizePerformance || summarizePerformance;

  // A malformed id is a caller mistake, not a 500. mssql throws on a bad
  // UNIQUEIDENTIFIER bind, and a thrown bind reads as "ARION is broken".
  if (!GUID.test(String(siteId || ''))) {
    return { ok: false, status: 400, code: 'bad_site_id', message: 'siteId must be a GUID.' };
  }

  const r = await pool.request()
    .input('siteId', sql.UniqueIdentifier, siteId)
    .query(SITE_SQL);
  const site = r.recordset && r.recordset[0];
  if (!site) {
    return { ok: false, status: 404, code: 'site_not_found', message: 'No ARION site with that id.' };
  }
  const connected = site.gbp_connected === true || site.gbp_connected === 1;
  if (!connected || !hasSiteToken(site) || !site.gbp_location_name
      || String(site.status || '') === 'disconnected') {
    // Not an error: this business has not connected Google. SPARK shows the
    // card and the words, and does not poll a listing that is not there.
    return {
      ok: false,
      status: 409,
      code: 'gbp_not_connected',
      message: 'This business has not connected a Google Business Profile listing.',
    };
  }

  const windowDays = windowDaysFor(since, now);

  // ── attribution ──────────────────────────────────────────────────────────
  // The stored token is opened once; a sealed one this server cannot open is
  // refused in plain words, never sent to Google (lib/gbpTokenAtRest.js).
  let token;
  try { token = siteRefreshToken(site); } catch (err) {
    return { ok: false, status: 409, code: 'gbp_token_unreadable', message: err.message };
  }
  const perf = await doPerformance(token, site.gbp_location_name, windowDays);
  if (!perf || perf.error) {
    // Google's own reason, forwarded. NEVER zeroes: "nobody tapped Call" and
    // "we could not ask" are different answers and a client acts on them
    // differently (reference_catch_swallow_report_success).
    return {
      ok: false,
      status: 502,
      code: 'gbp_performance_unavailable',
      message: String(perf?.error || 'Google did not answer the performance request.'),
    };
  }
  const totals = doSummarize(perf.data) || {};

  // ── arrivals ─────────────────────────────────────────────────────────────
  const q = await doQuestions(token, site.gbp_location_name);
  const available = !(q && q.unavailable);

  return {
    ok: true,
    site_id: String(site.site_id),
    questions: questionsSince(q?.questions, since),
    questions_available: available,
    questions_unavailable_reason: available ? null : String(q?.reason || 'unavailable'),
    questions_unavailable_note: available ? null : String(q?.note || ''),
    call_clicks: Number(totals.calls) || 0,
    website_clicks: Number(totals.websiteClicks) || 0,
    window_days: windowDays,
  };
}
