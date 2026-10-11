// routes/arion/agents.js — Settings -> ARION -> Agents.
//
//   GET /arion/agents/activity   what the agent wrote, and what waits for you
//   GET /arion/agents/runs       WHEN it ran, what came of it, what went wrong
//   GET /arion/agents/settings   the switch, the price, the posts per week
//   PUT /arion/agents/settings   save them  <-- THE ROUTE THE PRODUCT DID NOT HAVE
//
// ═══ WHY THE PUT MATTERS MORE THAN IT LOOKS ════════════════════════════════
//
// `arion.content_agent_tenant_config` IS the product. Migration 064's own header
// says it: "Signup writes one; the weekly tick runs for every row with
// enabled = 1 and for nobody else. No row, no runs, no cost."
//
// And the only write to that table anywhere in the codebase was the sticky F8
// halt. There was no route, no signup hook and no admin surface that could create
// a row, so:
//
//   · the agent could not be switched on for a client at all, except by hand in
//     a query window (which is how the dev row got there), and
//   · `price_usd_monthly` was NULL for every real business, so the 60% margin
//     rule — the one that says "our AI spend must stay under 60% of what they pay
//     us" — reported `price_not_set` for everybody and protected nothing.
//
// The price is deliberately NOT defaulted. Per the standing no-fabricated-catalog
// rule, a price comes from configuration and never from code: NULL means "nobody
// has told us what this client pays", which is a true statement and the honest
// input to a margin check. A hardcoded $99 would make the margin monitor report
// a number that means nothing.
//
// ═══ AUTH ══════════════════════════════════════════════════════════════════
//
// Mounted under /arion, which already carries requireAuth -> tenantResolution ->
// requireArionAccess -> arionRouteFeatures, and under requireArionTenantAdmin for
// the write (see routes/arion.js). Every statement takes its tenant from
// req.tenant.tenantId and NEVER from a param, query or body: the documented
// wrong-tenant root cause on this platform is trusting a caller-supplied tenant,
// and a content agent pointed at the wrong business publishes one client's voice
// on another client's site.

import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import { loadArionActivity, ARION_AGENTS, ENGINE } from '../../lib/agents/activity.js';
import { loadArionRuns } from '../../lib/agents/runs.js';
import { checkMargin } from '../../lib/contentAgent/marginMonitor.js';
import { runTick } from '../../lib/contentAgent/tick.js';
import { isContentAgentDisabled, KILL_SWITCH_ENV } from '../../lib/contentAgent/config.js';
import { jobsOn as seamJobsOn } from '../../lib/teamSeam.js';
import { CONTENT_JOBS, dayWords } from '../../lib/jobChecks.js';

const fail = (res, status, code, message) =>
  res.status(status).json({ error: { code, message, status } });

const clampInt = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

/** A money value or null. NEVER a default — see the header. */
function cleanPrice(v, current) {
  if (v === undefined) return current;
  if (v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100000) return current;
  return Math.round(n * 100) / 100;
}

const PROVIDERS = ['auto', 'se_ranking', 'rankmath', 'none'];

// ---------------------------------------------------------------------------
// WHAT A PUT MAY NAME — one list, read by the writer AND by the refusal.
// ---------------------------------------------------------------------------
// Pre-walk pass 3 (2026-09-09): `PUT /arion/agents/settings` was
// `if (body.content && typeof body.content === 'object') { … }` with no else,
// and then re-read and returned the settings. So a caller sending
// `{ key: 'content', enabled: false }` — the shape the OLIVER and SPARK agent
// pages use — got a cheerful 200, an unchanged payload and no clue that nothing
// had been saved. It cost that pass a wrong reading of three walk rows before
// the route was read.
//
// A 200 that changed nothing is the platform's recurring
// catch -> swallow -> report success shape wearing a different coat: the caller
// is TOLD it worked. So an unrecognised body is a 400 that names the fields,
// and the fields are named from these two lists rather than typed into the
// message — a field can never be accepted and unnamed, or named and unaccepted.
const SETTINGS_SECTIONS = Object.freeze(['content']);
// ARGUS employees phase 1 (§G.9): the on/off, the posts per week and which
// kinds of post are the web person's JOBS now ("Blog posts", "Social posts"),
// switched only through platform-api PUT /me/team/jobs/:jobKey. What stays here
// is founder input and agent state: the price, the keyword source, and
// clearing a sticky stop.
const CONTENT_FIELDS = Object.freeze(['price_usd_monthly', 'keyword_provider', 'paused']);
/** Fields that moved to the job, refused with where they live now. */
const MOVED_FIELDS = Object.freeze(['enabled', 'posts_per_week', 'content_types']);
const MOVED_WORDS = "That's set on the job now: ARGUS → Your team → The web person → Jobs.";

/**
 * @returns {string|null} null when the body names something this route can act
 * on; otherwise the sentence to send back, in the caller's words.
 */
function whyBodyIsUnusable(body) {
  const keys = Object.keys(body);
  const shape = `Send { "${SETTINGS_SECTIONS[0]}": { … } } naming one or more of: ${CONTENT_FIELDS.join(', ')}.`;

  if (!keys.length) return `That request named nothing to change. ${shape}`;

  const unknownSections = keys.filter((k) => !SETTINGS_SECTIONS.includes(k));
  if (unknownSections.length) {
    return `This endpoint does not know ${unknownSections.map((k) => `"${k}"`).join(', ')}. `
      + `It changes ${SETTINGS_SECTIONS.map((k) => `"${k}"`).join(', ')} only. ${shape}`;
  }

  for (const section of keys) {
    const v = body[section];
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return `"${section}" must be an object. ${shape}`;
    }
    const fields = Object.keys(v);
    if (!fields.length) return `"${section}" named nothing to change. ${shape}`;
    if (fields.some((f) => MOVED_FIELDS.includes(f))) return MOVED_WORDS;
    const unknownFields = fields.filter((f) => !CONTENT_FIELDS.includes(f));
    if (unknownFields.length) {
      return `"${section}" does not have ${unknownFields.map((f) => `"${f}"`).join(', ')}. ${shape}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /arion/agents/activity
// ---------------------------------------------------------------------------
export const activityHandler = (getPool = getServicesPool) => async (req, res) => {
  try {
    const pool = await getPool();
    const limit = clampInt(req.query.limit, 1, 200, 50);
    // ?waiting=1 — Needs you: only the rows somebody can act on.
    const waiting = String(req.query.waiting || '') === '1';
    // { data: { rows, escalated, meta } } — one envelope with the payload INSIDE
    // it, because the Portal's api helper strips a top-level `data` and a sibling
    // `meta` would be dropped on the floor (the payouts-page bug).
    res.json({ data: await loadArionActivity(pool, req.tenant.tenantId, { limit, waiting }) });
  } catch (err) {
    console.error('[arion/agents:activity]', err);
    fail(res, 500, 'INTERNAL_ERROR', SERVER_WORDS);
  }
};

// ---------------------------------------------------------------------------
// GET /arion/agents/runs
// ---------------------------------------------------------------------------
export const runsHandler = (getPool = getServicesPool) => async (req, res) => {
  try {
    const pool = await getPool();
    const limit = clampInt(req.query.limit, 1, 100, 20);
    res.json({ data: await loadArionRuns(pool, req.tenant.tenantId, { limit }) });
  } catch (err) {
    console.error('[arion/agents:runs]', err);
    fail(res, 500, 'INTERNAL_ERROR', SERVER_WORDS);
  }
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
// No config row = the agent has never been switched on for this business. That is
// `enabled: false` with migration 064's declared defaults — not an error, and not
// a reason to hide the switch.
// ---------------------------------------------------------------------------
async function readSettings(pool, tenantId) {
  const r = await pool.request()
    .input('t', sql.UniqueIdentifier, tenantId)
    .query(`SELECT keyword_provider, authority_stage, price_usd_monthly, halted_at, halted_reason
              FROM arion.content_agent_tenant_config WHERE tenant_id = @t`);
  const c = r.recordset[0] || {};

  // The 60% rule, reported here because this is where the price is set — a
  // number you cannot see the consequence of is a number nobody sets carefully.
  let margin = null;
  try {
    margin = await checkMargin(pool, tenantId);
  } catch {
    margin = null;   // reported as null, never as a comfortable-looking zero
  }

  return {
    engine: ENGINE,
    agents: [
      {
        ...ARION_AGENTS.content,
        // The on/off and posts per week are the jobs' now (platform-api
        // GET /me/team/web); this read reports agent state only.
        paused: !!c.halted_at,
        paused_reason: c.halted_reason || null,
        settings: {
          // Dollars per month, or null. Null is a real answer.
          price_usd_monthly: c.price_usd_monthly == null ? null : Number(c.price_usd_monthly),
          keyword_provider: c.keyword_provider || 'auto',
          authority_stage: c.authority_stage || 'new',
        },
        margin,
      },
    ],
  };
}

export const settingsReadHandler = (getPool = getServicesPool) => async (req, res) => {
  try {
    const pool = await getPool();
    res.json({ data: await readSettings(pool, req.tenant.tenantId) });
  } catch (err) {
    console.error('[arion/agents:settings:get]', err);
    fail(res, 500, 'INTERNAL_ERROR', SERVER_WORDS);
  }
};

// ---------------------------------------------------------------------------
// PUT /arion/agents/settings
// Body: { content?: { enabled?, posts_per_week?, price_usd_monthly?,
//                     content_types?, keyword_provider?, paused? } }
//
// UPSERT, because switching the agent on for the first time is exactly the case
// that has to CREATE the row — a business with no row is the normal starting
// state and was, until now, a business the agent could never run for.
//
// `paused: false` clears a sticky F8 halt. There is deliberately no
// `paused: true`: pausing is what `enabled: false` already means, and two
// switches for one idea is how they end up disagreeing.
// ---------------------------------------------------------------------------
export const settingsWriteHandler = (getPool = getServicesPool) => async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const body = req.body || {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    return fail(res, 400, 'BAD_REQUEST', 'Expected an object.');
  }
  // A body this route cannot act on is refused, out loud, with the field names
  // in it. It used to answer 200 and change nothing — see whyBodyIsUnusable.
  const why = whyBodyIsUnusable(body);
  if (why) return fail(res, 400, 'BAD_REQUEST', why);
  try {
    const pool = await getPool();
    const before = await readSettings(pool, tenantId);
    const cur = before.agents[0];

    if (body.content && typeof body.content === 'object') {
      const p = body.content;
      const price = cleanPrice(p.price_usd_monthly, cur.settings.price_usd_monthly);
      const provider = PROVIDERS.includes(String(p.keyword_provider))
        ? String(p.keyword_provider) : cur.settings.keyword_provider;
      const clearHalt = p.paused === false;

      await pool.request()
        .input('t', sql.UniqueIdentifier, tenantId)
        .input('price', sql.Decimal(10, 2), price)
        .input('provider', sql.NVarChar(20), provider)
        .input('clearHalt', sql.Bit, clearHalt ? 1 : 0)
        .query(`
          MERGE arion.content_agent_tenant_config AS tgt
          USING (SELECT @t AS tenant_id) AS s ON tgt.tenant_id = s.tenant_id
          WHEN MATCHED THEN UPDATE SET
            price_usd_monthly = @price, keyword_provider = @provider,
            halted_at = CASE WHEN @clearHalt = 1 THEN NULL ELSE tgt.halted_at END,
            halted_reason = CASE WHEN @clearHalt = 1 THEN NULL ELSE tgt.halted_reason END,
            updated_at = SYSDATETIMEOFFSET()
          WHEN NOT MATCHED THEN
            INSERT (tenant_id, price_usd_monthly, keyword_provider)
            VALUES (@t, @price, @provider);`);
    }

    res.json({ data: await readSettings(pool, tenantId) });
  } catch (err) {
    console.error('[arion/agents:settings:put]', err);
    fail(res, 500, 'INTERNAL_ERROR', SERVER_WORDS);
  }
};

// ---------------------------------------------------------------------------
// POST /arion/agents/run — "Run it now"
// ---------------------------------------------------------------------------
// The POC cannot wait until Monday. The other four agents already had a manual
// trigger (POST /qtc-agent/run, /fieldops-agent/run, /campaign-agent/draft,
// /argus/governance/reindex); this agent had only the internal tick behind an
// ingest key, so there was no way for a person to run it at all.
//
// It runs the tick for THIS BUSINESS ONLY — never the fleet. A button on one
// business's settings page that runs every business's cycle is a button that
// spends other people's money, and there is a separate internal tick for the
// fleet.
//
// The kill switch is honoured here as well, and answers 503 rather than a
// cheerful 200 with nothing in it.
// ---------------------------------------------------------------------------
/**
 * The sentences "Run it now" answers with. An owner reads them: the jobs'
 * names, never their keys, and never a setting's name (§0.3).
 */
export const RUN_WORDS = Object.freeze({
  disabled: 'The web person is switched off for every business right now, so nothing ran and nothing was spent.',
  whichJob: 'Say which job to run: Blog posts or Social posts.',
  unreadable: "ARGUS couldn't check whether that job is on, so nothing ran. Try again in a minute.",
  off: 'That job is off. Switch it on first.',
  halted: (when, why) => `It stopped itself${when ? ` on ${when}` : ''}: ${why}. Start it again first.`,
  // A thrown error is logged here, never sent: an owner reads this, not the exception.
  broke: 'Something went wrong on our side, so nothing ran. Try again in a minute.',
});

/** What an owner reads when a read or a save throws (the error itself goes to the log). */
export const SERVER_WORDS = 'Something went wrong on our side. Try again in a minute.';

/**
 * What "Run it now" sends back: THIS business's results only. The tick's
 * summary is a fleet shape (margins, every alert, notifications); an owner
 * route must never hand one business another business's id, price or spend.
 *
 * productOff is kept, narrowed to this business: a business whose ARION
 * ended while a job stayed on gets no results, and the Portal's runResult
 * (src/lib/team.ts) reads `productOff.skipped` to say "your plan doesn't
 * include this job" instead of "It couldn't finish this time". Each entry
 * carries the plain sentence only (no id, no reason code); `words` repeats it.
 */
export function ownRunSummary(summary, tenantId) {
  const T = String(tenantId).toUpperCase();
  const mine = (x) => String(x?.tenantId || '').toUpperCase() === T;
  const skipped = (summary?.productOff?.skipped || []).filter(mine)
    .map((s) => ({ ended: !!s.ended, note: String(s.note || '') }));
  return {
    ran: Number(summary?.ran) || 0,
    results: (summary?.results || []).filter(mine),
    alerts: (summary?.alerts || []).filter((a) => mine(a) && a.failure_mode !== 'MARGIN')
      .map(({ tenantId: _t, ...a }) => a),
    productOff: { skipped },
    ...(skipped.length && skipped[0].note ? { words: skipped[0].note } : {}),
    ...(summary?.jobStateUnreadable ? { jobStateUnreadable: true, words: summary.words } : {}),
  };
}

/** Factory so a test can hand in fake readers; the default router uses the real ones. */
export function makeRunHandler({ getPool = getServicesPool, jobsOn = seamJobsOn, tick = runTick } = {}) {
  return async (req, res) => {
    const tenantId = req.tenant.tenantId;
    const jobKey = String(req.body?.job_key || '');
    try {
      if (isContentAgentDisabled()) {
        console.warn(`[arion/agents:run] ${KILL_SWITCH_ENV} is set; refused`);
        return fail(res, 503, 'AGENT_DISABLED', RUN_WORDS.disabled);
      }
      if (!CONTENT_JOBS.includes(jobKey)) {
        return fail(res, 400, 'BAD_REQUEST', RUN_WORDS.whichJob);
      }
      // Is THIS job on for THIS business? Unreadable = nothing runs (503).
      const state = await jobsOn([jobKey], { tenantId });
      if (!state || state.ok !== true || !(state.on instanceof Map)) {
        return fail(res, 503, 'JOB_STATE_UNREADABLE', RUN_WORDS.unreadable);
      }
      const mine = state.on.get(String(tenantId).toUpperCase());
      if (!(mine instanceof Map) || !mine.has(jobKey)) {
        return fail(res, 409, 'JOB_OFF', RUN_WORDS.off);
      }
      const pool = await getPool();
      const cfg = await pool.request()
        .input('t', sql.UniqueIdentifier, tenantId)
        .query('SELECT halted_at, halted_reason FROM arion.content_agent_tenant_config WHERE tenant_id = @t');
      const row = cfg.recordset[0];
      if (row?.halted_at) {
        return fail(res, 409, 'HALTED', RUN_WORDS.halted(dayWords(row.halted_at), row.halted_reason));
      }

      // The fleet tick, narrowed to one business and one job. One code path for
      // a scheduled run and a hand-pressed run, so they cannot drift.
      const summary = await tick({
        pool,
        log: (m) => console.log(`[content-agent:run] ${m}`),
        tenantFilter: tenantId,
        jobKeys: [jobKey],
        jobsOn,
        triggerSource: 'manual',
      });
      res.json({ data: ownRunSummary(summary, tenantId) });
    } catch (err) {
      console.error('[arion/agents:run]', err);
      fail(res, 500, 'INTERNAL_ERROR', RUN_WORDS.broke);
    }
  };
}

// ---------------------------------------------------------------------------
// POST /arion/agents/run { job_key } — "Run it now", THIS business, ONE job.
// ---------------------------------------------------------------------------
// It runs the tick for this business only — never the fleet — and only the
// named job (arion.blog_posts or arion.social_posts). A job that is off is
// refused (409) rather than quietly run: the switch is the job's, not this
// button's. The kill switch answers 503 rather than a cheerful 200.
// ---------------------------------------------------------------------------
/**
 * The router, with its pool, job reader and tick handed in (tests pass fakes;
 * a store that throws must answer SERVER_WORDS, never the exception).
 */
export function makeAgentsRouter({ getPool = getServicesPool, jobsOn = seamJobsOn, tick = runTick } = {}) {
  const router = Router({ mergeParams: true });
  router.get('/activity', activityHandler(getPool));
  router.get('/runs', runsHandler(getPool));
  router.get('/settings', settingsReadHandler(getPool));
  router.put('/settings', settingsWriteHandler(getPool));
  router.post('/run', makeRunHandler({ getPool, jobsOn, tick }));
  return router;
}

export default makeAgentsRouter();
