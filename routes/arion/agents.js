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
// requireArionAccess -> requireArionTier, and under requireArionTenantAdmin for
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

const router = Router({ mergeParams: true });

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

const CONTENT_TYPES = ['blog_post', 'social_post', 'social_carousel'];
const PROVIDERS = ['auto', 'se_ranking', 'rankmath', 'none'];

function cleanContentTypes(v, current) {
  if (v == null) return current;
  const list = String(v).split(',').map((s) => s.trim()).filter((s) => CONTENT_TYPES.includes(s));
  return list.length ? [...new Set(list)].join(',') : current;
}

// ---------------------------------------------------------------------------
// GET /arion/agents/activity
// ---------------------------------------------------------------------------
router.get('/activity', async (req, res) => {
  try {
    const pool = await getServicesPool();
    const limit = clampInt(req.query.limit, 1, 200, 50);
    // { data: { rows, escalated, meta } } — one envelope with the payload INSIDE
    // it, because the Portal's api helper strips a top-level `data` and a sibling
    // `meta` would be dropped on the floor (the payouts-page bug).
    res.json({ data: await loadArionActivity(pool, req.tenant.tenantId, { limit }) });
  } catch (err) {
    console.error('[arion/agents:activity]', err);
    fail(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

// ---------------------------------------------------------------------------
// GET /arion/agents/runs
// ---------------------------------------------------------------------------
router.get('/runs', async (req, res) => {
  try {
    const pool = await getServicesPool();
    const limit = clampInt(req.query.limit, 1, 100, 20);
    res.json({ data: await loadArionRuns(pool, req.tenant.tenantId, { limit }) });
  } catch (err) {
    console.error('[arion/agents:runs]', err);
    fail(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

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
    .query(`SELECT enabled, slots_per_cycle, content_types, keyword_provider,
                   authority_stage, price_usd_monthly, halted_at, halted_reason
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
        enabled: !!c.enabled,
        paused: !!c.halted_at,
        paused_reason: c.halted_reason || null,
        settings: {
          posts_per_week: c.slots_per_cycle == null ? 1 : Number(c.slots_per_cycle),
          // Dollars per month, or null. Null is a real answer.
          price_usd_monthly: c.price_usd_monthly == null ? null : Number(c.price_usd_monthly),
          content_types: c.content_types || 'blog_post',
          keyword_provider: c.keyword_provider || 'auto',
          authority_stage: c.authority_stage || 'new',
        },
        margin,
      },
    ],
  };
}

router.get('/settings', async (req, res) => {
  try {
    const pool = await getServicesPool();
    res.json({ data: await readSettings(pool, req.tenant.tenantId) });
  } catch (err) {
    console.error('[arion/agents:settings:get]', err);
    fail(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

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
router.put('/settings', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const body = req.body || {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    return fail(res, 400, 'BAD_REQUEST', 'Expected an object.');
  }
  try {
    const pool = await getServicesPool();
    const before = await readSettings(pool, tenantId);
    const cur = before.agents[0];

    if (body.content && typeof body.content === 'object') {
      const p = body.content;
      const enabled = typeof p.enabled === 'boolean' ? p.enabled : cur.enabled;
      const slots = p.posts_per_week == null
        ? cur.settings.posts_per_week
        : clampInt(p.posts_per_week, 1, 14, cur.settings.posts_per_week);
      const price = cleanPrice(p.price_usd_monthly, cur.settings.price_usd_monthly);
      const types = cleanContentTypes(p.content_types, cur.settings.content_types);
      const provider = PROVIDERS.includes(String(p.keyword_provider))
        ? String(p.keyword_provider) : cur.settings.keyword_provider;
      const clearHalt = p.paused === false;

      await pool.request()
        .input('t', sql.UniqueIdentifier, tenantId)
        .input('enabled', sql.Bit, enabled ? 1 : 0)
        .input('slots', sql.Int, slots)
        .input('price', sql.Decimal(10, 2), price)
        .input('types', sql.NVarChar(200), types)
        .input('provider', sql.NVarChar(20), provider)
        .input('clearHalt', sql.Bit, clearHalt ? 1 : 0)
        .query(`
          MERGE arion.content_agent_tenant_config AS tgt
          USING (SELECT @t AS tenant_id) AS s ON tgt.tenant_id = s.tenant_id
          WHEN MATCHED THEN UPDATE SET
            enabled = @enabled, slots_per_cycle = @slots, price_usd_monthly = @price,
            content_types = @types, keyword_provider = @provider,
            halted_at = CASE WHEN @clearHalt = 1 THEN NULL ELSE tgt.halted_at END,
            halted_reason = CASE WHEN @clearHalt = 1 THEN NULL ELSE tgt.halted_reason END,
            updated_at = SYSDATETIMEOFFSET()
          WHEN NOT MATCHED THEN
            INSERT (tenant_id, enabled, slots_per_cycle, price_usd_monthly, content_types, keyword_provider)
            VALUES (@t, @enabled, @slots, @price, @types, @provider);`);
    }

    res.json({ data: await readSettings(pool, tenantId) });
  } catch (err) {
    console.error('[arion/agents:settings:put]', err);
    fail(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

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
router.post('/run', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  try {
    if (isContentAgentDisabled()) {
      return fail(res, 503, 'AGENT_DISABLED',
        `${KILL_SWITCH_ENV} is set — the agent did not run, read nothing and spent nothing.`);
    }
    const pool = await getServicesPool();
    const cfg = await pool.request()
      .input('t', sql.UniqueIdentifier, tenantId)
      .query('SELECT enabled, halted_at, halted_reason FROM arion.content_agent_tenant_config WHERE tenant_id = @t');
    const row = cfg.recordset[0];
    if (!row) {
      return fail(res, 409, 'NOT_ENABLED', 'This agent has never been switched on for this business. Turn it on first, and set what it costs.');
    }
    if (!row.enabled) {
      return fail(res, 409, 'NOT_ENABLED', 'This agent is switched off for this business.');
    }
    if (row.halted_at) {
      return fail(res, 409, 'HALTED', `It stopped itself on ${row.halted_at}: ${row.halted_reason}. Start it again first.`);
    }

    // The fleet tick, narrowed to one tenant by filtering the config load. One
    // code path for a scheduled run and a hand-pressed run, so they cannot drift.
    const summary = await runTick({
      pool,
      log: (m) => console.log(`[content-agent:run] ${m}`),
      tenantFilter: tenantId,
    });
    res.json({ data: summary });
  } catch (err) {
    console.error('[arion/agents:run]', err);
    fail(res, 500, 'INTERNAL_ERROR', err.message);
  }
});

export default router;
