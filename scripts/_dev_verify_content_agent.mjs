#!/usr/bin/env node
/**
 * scripts/_dev_verify_content_agent.mjs — the ARION Content & Social Agent,
 * exercised against the LOCAL dev database. Read-mostly, and every row it
 * writes it deletes before it exits.
 *
 * WHY THIS EXISTS. The suite proves the pieces with fake pools. It cannot prove
 * that the real tables, the real meter, the real breaker and the real tenant
 * config agree with each other — and "the tests pass" is exactly what the two
 * documented release failures both said. So this drives the whole cycle through
 * the real database and asserts what the DATA says afterwards.
 *
 * NO MONEY, EVER. Two parts, and neither one calls a provider:
 *
 *   A  provider `none`, NO API KEY. The proof that a keyless run fails CLOSED:
 *      a run is recorded, and content_agent_output gains ZERO rows. Run twice —
 *      once as the platform stands (the meter refuses first) and once with the
 *      action pricing present (the key check refuses) — because those are two
 *      different closed doors and only the second one is the key.
 *   B  provider stand-in. A canned draft, no network, so the meter, the cost
 *      breaker, the guardrails and the persistence all run for real. Then every
 *      row is deleted and the deletion is verified by re-counting.
 *
 * THE PRICING ROWS ARE BORROWED, NOT INVENTED. LUMEN migration 149 seeds
 * arion.content_draft / arion.social_copy / arion.content_quality_scan into
 * `lumen.argus_action_pricing`, but lib/argus/tables.js resolves to
 * `argus.action_pricing` on any database where the 132 consolidation has run —
 * which is this one, and production. So the rows exist in the table nobody
 * reads. This script COPIES those three rows verbatim into the consolidated
 * table for the length of the exercise and deletes them again, so it can show
 * what the agent does once the pricing lands in the right place. It invents no
 * price. The permanent fix is a LUMEN migration; see MASTER_DEFECT_REGISTER 4d.
 *
 * SAFETY. Refuses any server that is not provably loopback (presence of the
 * marker, never absence of a prod one) and touches ONE fixture tenant.
 *
 *   node scripts/_dev_verify_content_agent.mjs
 */
import 'dotenv/config';
import sql from 'mssql';

import { runTick, loadEnabledTenants } from '../lib/contentAgent/tick.js';
import { runCycle } from '../lib/contentAgent/runner.js';
import { MODELS } from '../lib/contentAgent/config.js';

const FIXTURE_TENANT = 'a0000001-0000-0000-0000-000000000001';
const AGENT_ACTIONS = ['arion.content_draft', 'arion.social_copy', 'arion.content_quality_scan'];

let pass = 0;
let fail = 0;
const check = (ok, label, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ── the target ─────────────────────────────────────────────────────────── */

function loopbackOrDie() {
  const raw = process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER || '';
  const [host, port] = String(raw).split(',');
  // PRESENCE of a loopback marker. An unrecognised host is production.
  if (!/^(localhost|127\.0\.0\.1|::1)$/i.test((host || '').trim())) {
    console.error(`REFUSING: "${raw}" is not provably the local dev server. This script never runs anywhere else.`);
    process.exit(2);
  }
  return { host: host.trim(), port: Number((port || '1433').trim()) };
}

async function connect() {
  const { host, port } = loopbackOrDie();
  const pool = await new sql.ConnectionPool({
    server: host,
    port,
    database: process.env.SERVICES_SQL_DATABASE || process.env.SQL_DATABASE || 'iadm_services',
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    options: { encrypt: false, trustServerCertificate: true },
  }).connect();
  console.log(`target: ${host},${port}/${process.env.SERVICES_SQL_DATABASE || 'iadm_services'}  tenant: ${FIXTURE_TENANT}\n`);
  return pool;
}

/* ── counting, so "nothing was queued" is a number and not a feeling ────── */

async function counts(pool) {
  const r = await pool.request()
    .input('t', sql.UniqueIdentifier, FIXTURE_TENANT)
    .query(`
      SELECT
        (SELECT COUNT(*) FROM arion.content_agent_run_log WHERE tenant_id=@t)  AS runs,
        (SELECT COUNT(*) FROM arion.content_agent_output  WHERE tenant_id=@t)  AS outputs,
        (SELECT COUNT(*) FROM argus.ai_call_audit         WHERE tenant_id=@t)  AS audits,
        (SELECT COUNT(*) FROM argus.credit_use            WHERE tenant_id=@t)  AS debits`);
  return r.recordset[0];
}

// EVERY tenant the tick touched. ARGUS pack 1 put a second business (the IA
// POC fixture) on the agent, and a cleanup scoped to one tenant leaves the
// other one's run rows behind for ever.
const runIdsSince = async (pool, since) => (await pool.request()
  .input('s', sql.DateTimeOffset, since)
  .query('SELECT run_id FROM arion.content_agent_run_log WHERE triggered_at >= @s'))
  .recordset.map((x) => x.run_id);

// The whole-table baseline, so cleanup is measured against what was here when
// this run started rather than against a number typed in when there was only
// one fixture business.
const wholeCounts = async (pool) => (await pool.request().query(`
  SELECT (SELECT COUNT(*) FROM arion.content_agent_run_log)      AS runs,
         (SELECT COUNT(*) FROM arion.content_agent_output)       AS outputs,
         (SELECT COUNT(*) FROM arion.content_agent_tenant_style) AS styles`)).recordset[0];

/* ── the borrowed pricing rows ──────────────────────────────────────────── */

async function pricingState(pool) {
  const r = await pool.request().query(`
    SELECT 'consolidated' AS tbl, action_type FROM argus.action_pricing WHERE action_type IN ('${AGENT_ACTIONS.join("','")}')
    UNION ALL
    SELECT 'legacy', action_type FROM lumen.argus_action_pricing WHERE action_type IN ('${AGENT_ACTIONS.join("','")}')`);
  return r.recordset;
}

// The rows THIS script inserted, and only those. LUMEN migration 174 now seeds
// the three prices into argus.action_pricing permanently, so an unconditional
// DELETE here hands the database back missing the very rows 174 exists to put
// there — the agent goes dead again and nothing says so. Found by pre-walk
// pass 3, which ran this script twice and then measured 3 of 6 agent prices.
let borrowedActions = [];

async function borrowPricing(pool) {
  const already = new Set((await pricingState(pool))
    .filter((r) => r.tbl === 'consolidated')
    .map((r) => r.action_type));
  borrowedActions = AGENT_ACTIONS.filter((a) => !already.has(a));
  if (borrowedActions.length === 0) return;
  await pool.request().query(`
    INSERT INTO argus.action_pricing (action_type, credits_per_call, description, outlier_cap_usd, is_active)
    SELECT l.action_type, l.credits_per_call, l.description, l.outlier_cap_usd, l.is_active
      FROM lumen.argus_action_pricing l
     WHERE l.action_type IN ('${borrowedActions.join("','")}')
       AND NOT EXISTS (SELECT 1 FROM argus.action_pricing a WHERE a.action_type = l.action_type)`);
}

async function returnPricing(pool) {
  if (borrowedActions.length === 0) return;
  await pool.request().query(`
    DELETE FROM argus.action_pricing WHERE action_type IN ('${borrowedActions.join("','")}')`);
  borrowedActions = [];
}

/* ── the canned draft (no network, no tokens bought) ────────────────────── */

const KEYWORD_BODY = (kw) => [
  `## ${kw} in practice`,
  '',
  `A ${kw} problem is usually a maintenance problem that waited too long. ${'This paragraph is deliberately ordinary and specific so the quality rules have real prose to read rather than filler. '.repeat(6)}`,
  '',
  `### Where ${kw} work actually starts`,
  '',
  'Start with the thing that is cheapest to check. '.repeat(20),
  '',
  '### What it costs to leave it',
  '',
  'A small repair booked in the spring is a smaller repair than the same one booked in August. '.repeat(14),
].join('\n');

function cannedProvider({ keyword }) {
  return async () => ({
    inputTokens: 9800,
    outputTokens: 3900,
    imageCount: 0,
    data: {
      text: JSON.stringify({
        title: `${keyword}: what to check first`,
        body_markdown: `${keyword} starts here. ${KEYWORD_BODY(keyword)}`,
        meta_description: `${keyword} explained in plain terms, with the checks that matter and the ones that do not, in about a hundred and sixty characters of honest summary.`,
        url_slug: keyword.toLowerCase().split(' ').join('-'),
        cover_image_prompt: 'A plain photograph of a downspout at the corner of a house, overcast light.',
        confidence_note: 'Written from a canned fixture; no provider was called.',
      }),
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      stopReason: 'end_turn',
    },
  });
}

/* ── the exercise ───────────────────────────────────────────────────────── */

async function main() {
  const startedAt = new Date();
  const pool = await connect();
  const created = { runs: [], outputs: [] };
  let borrowed = false;

  try {
    /* 0. the ground truth we are exercising against */
    console.log('0. the fixture and the platform state');
    const baseline = await wholeCounts(pool);
    const enabled = await loadEnabledTenants(pool);
    const cfg = enabled.find((c) => String(c.tenant_id).toLowerCase() === FIXTURE_TENANT);
    check(!!cfg, 'the fixture business has an agent config row and it is enabled');
    check(cfg && !cfg.halted_at, 'it is not halted');
    check(cfg && cfg.keyword_provider === 'none', 'its keyword provider is `none` — no SEO tool, no outbound research call',
      cfg ? `provider=${cfg.keyword_provider}` : '');
    // ARGUS pack 1 switched the agent on for the IA POC fixture too, so "one"
    // stopped being the answer. What still has to be true is that the business
    // this script drives is one of them.
    check(!!cfg, 'the business this script drives is among the ones with the agent switched on',
      `${enabled.length} enabled on this database`);

    const priced = await pricingState(pool);
    const inConsolidated = priced.filter((p) => p.tbl === 'consolidated').map((p) => p.action_type);
    const inLegacy = priced.filter((p) => p.tbl === 'legacy').map((p) => p.action_type);
    check(inLegacy.length === 3, 'LUMEN 149 seeded all three action prices', `legacy: ${inLegacy.join(', ') || 'none'}`);
    // Was DEFECT CONFIRMED. LUMEN migration 174 (ARGUS pack 1, merged
    // 2026-09-08) copies these three into the consolidated home, which is the
    // table this repo reads. A database missing them has an agent that cannot
    // make a single call, so the check is now the other way up.
    check(inConsolidated.length === 3,
      'all three prices are in argus.action_pricing, which is the table this repo reads (LUMEN 174)',
      `consolidated: ${inConsolidated.join(', ') || 'NONE — apply LUMEN migration 174'}`);

    const keyless = !process.env.ANTHROPIC_API_KEY;
    check(keyless, 'ANTHROPIC_API_KEY is empty for this run — nothing here can cost money',
      keyless ? '' : 'A KEY IS PRESENT. Re-run with ANTHROPIC_API_KEY= to keep this free.');
    if (!keyless) { console.log('\nSTOPPING: refusing to exercise a keyed environment.'); process.exit(3); }

    /* A1. as the platform stands: the meter refuses before anything else can */
    console.log('\nA1. keyless run, pricing as it actually is — nothing may be queued');
    let before = await counts(pool);
    let mark = new Date();
    let summary = await runTick({ pool, log: (m) => console.log(`      [tick] ${m}`), notify: async () => [] });
    created.runs.push(...await runIdsSince(pool, mark));
    let after = await counts(pool);
    check(after.outputs === before.outputs, 'content_agent_output gained NOTHING', `${before.outputs} -> ${after.outputs}`);
    check(after.runs > before.runs, 'the run was recorded anyway (AC6: a failed run still leaves a row)', `${before.runs} -> ${after.runs}`);
    check(after.debits === before.debits, 'no credits were debited', `${before.debits} -> ${after.debits}`);
    check(summary.ran > 0, 'the tick did attempt the tenant rather than skipping it silently', `ran=${summary.ran}`);
    // Which door closed first depends on whether LUMEN 174 has been applied.
    // Before it, the meter refuses (unknown_action). After it, the price is
    // found and the missing key is the door. Either way nothing was drafted
    // and nothing was charged, which is what A1 exists to prove.
    const alertsA1 = JSON.stringify(summary.alerts);
    const pricedAlready = inConsolidated.length === AGENT_ACTIONS.length;
    const closedDoor = pricedAlready
      ? alertsA1.includes('ANTHROPIC_API_KEY is not set')
      : alertsA1.includes('unknown_action');
    check(closedDoor,
      pricedAlready
        ? 'and it stopped on the missing key — LUMEN 174 has landed, so the price is no longer the door'
        : 'and it stopped on the metering refusal — the pricing row the defect is about',
      alertsA1.slice(0, 160));

    /* A2. with the pricing borrowed: now the KEY is the closed door */
    console.log('\nA2. keyless run with the three prices borrowed into the consolidated table');
    await borrowPricing(pool);
    borrowed = true;
    const nowPriced = (await pricingState(pool)).filter((p) => p.tbl === 'consolidated').length;
    check(nowPriced === 3, 'the three prices are readable where the wrapper looks', `${nowPriced}/3`);

    before = await counts(pool);
    mark = new Date();
    summary = await runTick({ pool, log: (m) => console.log(`      [tick] ${m}`), notify: async () => [] });
    created.runs.push(...await runIdsSince(pool, mark));
    after = await counts(pool);
    check(after.outputs === before.outputs, 'STILL nothing queued — a keyless run fails CLOSED', `${before.outputs} -> ${after.outputs}`);
    check(after.debits === before.debits, 'nothing was charged for a call that never happened', `${before.debits} -> ${after.debits}`);
    // The CAUSE is in the message, not in the code: meterAndAudit catches
    // anything runCall throws and reports code 'provider_error', so a missing key
    // and an Anthropic outage arrive as the same code. Named in
    // MASTER_DEFECT_REGISTER 4d — it is the F1/E1 collapse in a new place.
    const alertText = JSON.stringify(summary.alerts);
    const noKey = alertText.includes('ANTHROPIC_API_KEY is not set');
    check(noKey, 'and the missing key is named in the alert message',
      noKey ? 'ANTHROPIC_API_KEY is not set' : alertText.slice(0, 200));
    check(alertText.includes('provider_error'),
      'though only in the message: the alert CODE flattens "no key" into provider_error');
    check(after.runs > before.runs, 'the run row exists so Monday morning has an answer', `${before.runs} -> ${after.runs}`);

    /* B. the provider stand-in: a real draft lands, metered */
    console.log('\nB. one cycle with a canned provider — a draft must land AND be metered');
    before = await counts(pool);
    mark = new Date();
    const KEYWORD = 'downspout drainage tips';
    const result = await runCycle({
      pool,
      tenantId: FIXTURE_TENANT,
      slots: 1,
      triggerSource: 'manual',
      contentType: 'blog_post',
      authorityStage: 'new',
      capabilities: { volume: false, kd: false, intent: false, label: 'dev exercise' },
      sourceLabel: 'dev exercise (canned provider)',
      healthCheck: false,
      research: async () => [{ keyword: KEYWORD, volume: null, difficulty: null, intent: 'informational' }],
      callImpl: cannedProvider({ keyword: KEYWORD }),
    });
    created.runs.push(...await runIdsSince(pool, mark));
    after = await counts(pool);

    check(result.status === 'completed', 'the cycle completed', `status=${result.status} outcome=${result.outcome}`);
    check(result.drafted === 1, 'exactly one draft was produced', `drafted=${result.drafted}`);
    check(after.outputs === before.outputs + 1, 'ONE row landed in content_agent_output', `${before.outputs} -> ${after.outputs}`);
    check(after.audits === before.audits + 1, 'the call was AUDITED through the ARGUS meter', `${before.audits} -> ${after.audits}`);
    check(after.debits === before.debits + 1, 'and DEBITED against the credit pool', `${before.debits} -> ${after.debits}`);

    const row = (await pool.request()
      .input('t', sql.UniqueIdentifier, FIXTURE_TENANT)
      .input('r', sql.UniqueIdentifier, result.runId)
      .query(`SELECT output_id, review_status, published_at, approved_at, primary_keyword, title, cover_image_prompt
                FROM arion.content_agent_output WHERE tenant_id=@t AND run_id=@r`)).recordset[0];
    check(!!row, 'the row is findable by its run');
    if (row) {
      created.outputs.push(row.output_id);
      check(row.review_status === 'pending', 'it is PENDING — a human has not seen it yet', row.review_status);
      check(row.published_at === null, 'and it is not published (AC8: approval is a separate act)');
      check(row.approved_at === null, 'and not approved');
      check(row.primary_keyword === KEYWORD, 'the keyword it was drafted for is on the row', row.primary_keyword);
    }

    const audit = (await pool.request()
      .input('t', sql.UniqueIdentifier, FIXTURE_TENANT)
      .input('s', sql.DateTimeOffset, mark)
      .query(`SELECT TOP 1 action_type, model, provider, input_tokens, output_tokens, cost_basis_usd, credits_charged, outlier_refunded
                FROM argus.ai_call_audit WHERE tenant_id=@t AND created_at >= @s ORDER BY created_at DESC`)).recordset[0];
    check(!!audit, 'there is an audit row for the call');
    if (audit) {
      check(audit.action_type === 'arion.content_draft', 'metered as the blog-draft action', audit.action_type);
      check(audit.model === MODELS.DRAFT, 'against the configured drafting model', `${audit.model}`);
      check(Number(audit.cost_basis_usd) > 0, 'with a real cost basis, so the outlier guard is live', `$${audit.cost_basis_usd}`);
      check(audit.outlier_refunded === false, 'and it did not trip the per-call cap');
    }

    const runRow = (await pool.request()
      .input('r', sql.UniqueIdentifier, result.runId)
      .query('SELECT status, cost_usd, tokens_in, tokens_out, decision_rule_flags_json FROM arion.content_agent_run_log WHERE run_id=@r')).recordset[0];
    check(runRow && runRow.status === 'completed', 'the run log agrees the run completed');
    check(runRow && Number(runRow.cost_usd) > 0, 'and carries the cost, in dollars', `$${runRow?.cost_usd}`);
    // An ARRAY, never null: "no flags" and "flags were never evaluated" must not
    // look the same. It is no longer always EMPTY — ARGUS pack 1 made the
    // decision rules actually run, so a clean draft can still carry a note.
    const flagsRaw = runRow && runRow.decision_rule_flags_json;
    let flagsParsed = null;
    try { flagsParsed = JSON.parse(flagsRaw); } catch { flagsParsed = null; }
    check(Array.isArray(flagsParsed), 'with a flag list rather than a null one', String(flagsRaw));

    /* C. clean up, and PROVE it */
    console.log('\nC. removing every row this exercise created');
    const uniqueRuns = [...new Set(created.runs.map(String))];
    for (const runId of uniqueRuns) {
      await pool.request().input('r', sql.UniqueIdentifier, runId)
        .query('DELETE FROM arion.content_agent_output WHERE run_id=@r');
      await pool.request().input('r', sql.UniqueIdentifier, runId)
        .query('DELETE FROM arion.content_agent_run_log WHERE run_id=@r');
    }
    await pool.request().input('t', sql.UniqueIdentifier, FIXTURE_TENANT)
      .input('s', sql.DateTimeOffset, mark)
      .query('DELETE FROM argus.ai_call_audit WHERE tenant_id=@t AND created_at >= @s');
    await pool.request().input('t', sql.UniqueIdentifier, FIXTURE_TENANT)
      .input('s', sql.DateTimeOffset, mark)
      .query(`DELETE FROM argus.credit_use
                WHERE tenant_id=@t AND occurred_at >= @s
                  AND feature_key IN ('${AGENT_ACTIONS.join("','")}')`);
    await returnPricing(pool);
    borrowed = false;

    // and anything an earlier interrupted run of THIS script left behind.
    // Bounded by startedAt: an unbounded sweep on action_type would also delete
    // real metering history for the fixture business, and a cleanup that eats
    // data it did not create is not a cleanup.
    await pool.request().input('t', sql.UniqueIdentifier, FIXTURE_TENANT)
      .input('s', sql.DateTimeOffset, startedAt)
      .query(`DELETE FROM argus.credit_use
                WHERE tenant_id=@t AND occurred_at >= @s
                  AND feature_key IN ('${AGENT_ACTIONS.join("','")}')`);
    await pool.request().input('t', sql.UniqueIdentifier, FIXTURE_TENANT)
      .input('s', sql.DateTimeOffset, startedAt)
      .query(`DELETE FROM argus.ai_call_audit
                WHERE tenant_id=@t AND created_at >= @s
                  AND action_type IN ('${AGENT_ACTIONS.join("','")}')`);

    // Any voice profile the tick learned while running. It is written by the
    // cycle, it is not attached to a run id, and leaving it behind makes the
    // NEXT script report that the agent has learned something it was taught by
    // a test.
    await pool.request().input('s', sql.DateTimeOffset, startedAt)
      .query('DELETE FROM arion.content_agent_tenant_style WHERE created_at >= @s');

    const gone = await wholeCounts(pool);
    check(gone.runs === baseline.runs,
      `the run log is back to its ${baseline.runs} pre-existing fixture rows`, `now ${gone.runs}`);
    check(gone.outputs === baseline.outputs,
      `the queue is back to its ${baseline.outputs} pre-existing fixture rows`, `now ${gone.outputs}`);
    check(gone.styles === baseline.styles,
      `the learned voices are back to the ${baseline.styles} that were here`, `now ${gone.styles}`);
    for (const runId of uniqueRuns) {
      const n = (await pool.request().input('r', sql.UniqueIdentifier, runId)
        .query('SELECT COUNT(*) n FROM arion.content_agent_run_log WHERE run_id=@r')).recordset[0].n;
      check(n === 0, `run ${String(runId).slice(0, 8)} is gone`);
    }
    const nowPricedAfter = (await pricingState(pool)).filter((p) => p.tbl === 'consolidated').length;
    check(nowPricedAfter === inConsolidated.length,
      'argus.action_pricing is exactly as we found it — nothing borrowed was kept, nothing pre-existing was eaten',
      `${nowPricedAfter} of the 3, was ${inConsolidated.length}`);
  } finally {
    if (borrowed) { await returnPricing(pool).catch(() => {}); }
    await pool.close();
  }

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('\nEXERCISE ERROR:', err); process.exit(1); });
