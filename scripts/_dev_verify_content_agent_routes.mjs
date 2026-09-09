#!/usr/bin/env node
/**
 * scripts/_dev_verify_content_agent_routes.mjs — the review surface, live.
 *
 * `_dev_verify_content_agent.mjs` drives the CYCLE (meter, breaker, guardrails,
 * persistence). This one drives the ROUTES the way the Portal would, because the
 * branches that matter most here are the refusals, and a refusal is the one
 * thing a happy-path click never shows you:
 *
 *   · an escalated unit cannot be approved through the ordinary queue;
 *   · a unit you have not approved cannot be published;
 *   · an approved unit whose website is unreachable stays approved and
 *     UNSCHEDULED, and says so, instead of reporting a 200 it did not earn;
 *   · another business's unit is indistinguishable from one that does not exist;
 *   · a proposal can be approved and STILL not applied — there is no door;
 *   · ARGUS pack 1: the agent can be SWITCHED ON for a business at all, which
 *     nothing in the codebase could do before, and the Portal's three reads
 *     (activity / runs / settings) answer the shape the shared components expect.
 *
 * It starts arion-api itself on an ephemeral port with DEV_AUTH=1, so this is
 * ONE command, and it stops it again whatever happens. It never touches the
 * founder's stack (4000/4001/4003/8081/5174) and it refuses any API base that is
 * not loopback.
 *
 * Every row it writes it deletes, and it re-reads to prove the deletion. The
 * three pre-existing fixture queue rows are left exactly as they were: it
 * creates its own unit to review so that walking this does not consume the
 * drafts waiting in the queue.
 *
 *   node scripts/_dev_verify_content_agent_routes.mjs [--port 4098]
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sql from 'mssql';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(arg('port', '4098'));
const API = `http://localhost:${PORT}`;
const TENANT = 'a0000001-0000-0000-0000-000000000001';
const OTHER_TENANT = 'b0000002-0000-0000-0000-000000000002';
const FOUNDER_PORTS = [4000, 4001, 4003, 8081, 5174, 4999];
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (FOUNDER_PORTS.includes(PORT)) {
  console.error(`REFUSING port ${PORT}: that is the founder's stack. Pick an ephemeral one.`);
  process.exit(2);
}

let pass = 0;
let fail = 0;
const check = (ok, label, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

/* ── the database, for setup and teardown only ──────────────────────────── */

function loopbackOrDie() {
  const raw = process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER || '';
  const [host, port] = String(raw).split(',');
  if (!/^(localhost|127\.0\.0\.1|::1)$/i.test((host || '').trim())) {
    console.error(`REFUSING: "${raw}" is not provably the local dev server.`);
    process.exit(2);
  }
  return { host: host.trim(), port: Number((port || '1433').trim()) };
}

async function connect() {
  const { host, port } = loopbackOrDie();
  return new sql.ConnectionPool({
    server: host,
    port,
    database: process.env.SERVICES_SQL_DATABASE || 'iadm_services',
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    options: { encrypt: false, trustServerCertificate: true },
  }).connect();
}

/** One run + one output row to review, ours, so the fixture queue is untouched. */
async function seedUnit(pool, { tenantId = TENANT, reviewStatus = 'pending', keyword = 'walk fixture keyword' } = {}) {
  const run = await pool.request()
    .input('t', sql.UniqueIdentifier, tenantId)
    .query(`INSERT INTO arion.content_agent_run_log
              (tenant_id, agent_name, agent_version, trigger_source, status, model_version)
            OUTPUT INSERTED.run_id
            VALUES (@t, 'arion.content_agent', 'walk', 'manual', 'completed', 'walk-fixture')`);
  const runId = run.recordset[0].run_id;
  const out = await pool.request()
    .input('r', sql.UniqueIdentifier, runId)
    .input('t', sql.UniqueIdentifier, tenantId)
    .input('k', sql.NVarChar(300), keyword)
    .input('rev', sql.NVarChar(20), reviewStatus)
    .query(`INSERT INTO arion.content_agent_output
              (run_id, tenant_id, content_type, primary_keyword, keyword_rationale,
               title, body_markdown, meta_description, url_slug, review_status)
            OUTPUT INSERTED.output_id
            VALUES (@r, @t, 'blog_post', @k, 'seeded by the route walk',
                    'A walk fixture post', 'The body the agent wrote.',
                    'A walk fixture meta description.', 'walk-fixture-post', @rev)`);
  return { runId, outputId: out.recordset[0].output_id };
}

async function deleteUnit(pool, { runId }) {
  await pool.request().input('r', sql.UniqueIdentifier, runId)
    .query('DELETE FROM arion.content_agent_style_signal WHERE output_id IN (SELECT output_id FROM arion.content_agent_output WHERE run_id=@r)');
  await pool.request().input('r', sql.UniqueIdentifier, runId)
    .query('DELETE FROM arion.content_agent_output WHERE run_id=@r');
  await pool.request().input('r', sql.UniqueIdentifier, runId)
    .query('DELETE FROM arion.content_agent_run_log WHERE run_id=@r');
}

/* ── the server ─────────────────────────────────────────────────────────── */

async function startApi() {
  const child = spawn(process.execPath, ['index.js'], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(PORT),
      DEV_AUTH: '1',
      NODE_ENV: 'development',
      // No key: this walk must not be able to spend anything even by accident.
      ANTHROPIC_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));

  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return { child, log };
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 400));
  }
  child.kill();
  throw new Error(`arion-api did not come up on ${PORT}. Output:\n${log.join('')}`);
}

async function api(pathname, { method = 'GET', body, tenant = TENANT } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      Accept: 'application/json',
      'x-dev-tenant': tenant,
      Authorization: 'Bearer dev',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
}

/* ── the walk ───────────────────────────────────────────────────────────── */

async function main() {
  const pool = await connect();
  console.log(`api: ${API} (started by this script, DEV_AUTH=1, no provider key)\n`);
  const server = await startApi();
  const mine = [];

  try {
    /* 1. the queue */
    console.log('1. the review queue');
    const seeded = await seedUnit(pool);
    mine.push(seeded);
    let q = await api('/arion/content-agent/queue');
    check(q.status === 200, 'the queue answers', `HTTP ${q.status}`);
    const ids = (q.json?.data || []).map((r) => String(r.output_id).toUpperCase());
    check(ids.includes(String(seeded.outputId).toUpperCase()), 'the new unit is in it');
    check(Array.isArray(q.json?.escalated), 'escalated units come back in their own collection, not mixed in');
    check(typeof q.json?.meta?.escalated_count === 'number', 'and are counted separately');
    const firstPending = (q.json?.data || [])[0];
    check(firstPending && firstPending.review_status === 'pending', 'everything in the main list is pending');

    /* 2. an escalated unit is withheld */
    console.log('\n2. an escalated unit cannot be approved through the ordinary queue (AC2)');
    const esc = await seedUnit(pool, { reviewStatus: 'escalated', keyword: 'walk fixture escalated' });
    mine.push(esc);
    q = await api('/arion/content-agent/queue');
    const escIds = (q.json?.escalated || []).map((r) => String(r.output_id).toUpperCase());
    check(escIds.includes(String(esc.outputId).toUpperCase()), 'it appears in the escalated collection');
    check(!(q.json?.data || []).some((r) => String(r.output_id).toUpperCase() === String(esc.outputId).toUpperCase()),
      'and NOT in the approvable list');
    let r = await api(`/arion/content-agent/queue/${esc.outputId}/approve`, { method: 'POST', body: {} });
    check(r.status === 409, 'approving it is refused', `HTTP ${r.status} ${r.json?.error?.code || ''}`);
    check(/escalation rule/i.test(r.json?.error?.message || ''), 'and the refusal says why in words');

    /* 3. another business's unit */
    console.log("\n3. another business's unit is indistinguishable from one that does not exist");
    r = await api(`/arion/content-agent/queue/${seeded.outputId}/approve`, { method: 'POST', body: {}, tenant: OTHER_TENANT });
    check(r.status === 404 || r.status === 403 || r.status === 400,
      'it is not approvable from the other business', `HTTP ${r.status}`);
    if (r.status === 404) check(/No such queue item/i.test(r.json?.error?.message || ''), 'and the message leaks nothing');

    /* 4. publish before approval */
    console.log('\n4. nothing publishes without an approval (AC8)');
    r = await api(`/arion/content-agent/queue/${seeded.outputId}/publish`, { method: 'POST', body: {} });
    check(r.status === 409, 'publishing a pending unit is refused', `HTTP ${r.status} ${r.json?.error?.code || ''}`);
    check(/review_status is 'pending'/.test(r.json?.error?.message || ''), 'and names the state it refused on');

    /* 5. approve with an edit */
    console.log('\n5. approving with an edit keeps BOTH versions (AC3, E2)');
    const EDITED = 'The body the reviewer actually wants published.';
    r = await api(`/arion/content-agent/queue/${seeded.outputId}/approve`, {
      method: 'POST',
      body: { body_markdown: EDITED, note: 'tightened the opening' },
    });
    check(r.status === 200, 'the approval is accepted', `HTTP ${r.status}`);
    check(r.json?.data?.review_status === 'edited', 'an edited approval is recorded as edited, not approved',
      r.json?.data?.review_status);
    check(r.json?.data?.published === false, 'the response says it is NOT published');
    check(/separate step/i.test(r.json?.data?.note || ''), 'and says publishing is a separate step');

    const row = (await pool.request().input('o', sql.UniqueIdentifier, seeded.outputId)
      .query(`SELECT body_markdown, body_markdown_final, review_status, approved_at, published_at
                FROM arion.content_agent_output WHERE output_id=@o`)).recordset[0];
    check(row.body_markdown_final === EDITED, 'the edited text is what the publisher will read');
    check(row.body_markdown === 'The body the agent wrote.', "the agent's original is still there beside it");
    check(row.approved_at !== null, 'the approval is timestamped');
    check(row.published_at === null, 'and it is still not published');

    const signals = (await pool.request().input('o', sql.UniqueIdentifier, seeded.outputId)
      .query(`SELECT signal_kind, field_name, edit_distance FROM arion.content_agent_style_signal WHERE output_id=@o`)).recordset;
    check(signals.length === 1 && signals[0].signal_kind === 'edited',
      'the edit was recorded as something to learn from', `${signals.length} signal(s)`);
    check(signals[0]?.field_name === 'body' && signals[0]?.edit_distance > 0,
      'with the field and how big the change was', `${signals[0]?.field_name} distance=${signals[0]?.edit_distance}`);

    /* 6. approving twice */
    console.log('\n6. approving twice');
    r = await api(`/arion/content-agent/queue/${seeded.outputId}/approve`, { method: 'POST', body: {} });
    check(r.status === 409, 'the second approval is refused', `HTTP ${r.status} ${r.json?.error?.code || ''}`);

    /* 7. publish with no reachable website */
    console.log('\n7. an approved unit whose website cannot be reached stays approved and UNSCHEDULED (F5)');
    r = await api(`/arion/content-agent/queue/${seeded.outputId}/publish`, { method: 'POST', body: {} });
    check(r.status === 502 || r.status === 409, 'the publish attempt does not report success', `HTTP ${r.status}`);
    check(r.json?.data?.published !== true, 'nothing claims to be published');
    const after = (await pool.request().input('o', sql.UniqueIdentifier, seeded.outputId)
      .query('SELECT review_status, published_at, wordpress_post_id FROM arion.content_agent_output WHERE output_id=@o')).recordset[0];
    check(after.published_at === null, 'the row is still unpublished');
    check(after.review_status === 'edited', 'and still carries its approval, ready to retry', after.review_status);
    check(after.wordpress_post_id === null, 'with no post id invented');

    /* 8. rejecting needs a reason */
    console.log('\n8. a rejection has to teach the agent something');
    const rej = await seedUnit(pool, { keyword: 'walk fixture rejection' });
    mine.push(rej);
    r = await api(`/arion/content-agent/queue/${rej.outputId}/reject`, { method: 'POST', body: {} });
    check(r.status === 400, 'rejecting with no reason is refused', `HTTP ${r.status} ${r.json?.error?.code || ''}`);
    r = await api(`/arion/content-agent/queue/${rej.outputId}/reject`, { method: 'POST', body: { reason: 'off-topic for this business' } });
    check(r.status === 200 && r.json?.data?.review_status === 'rejected', 'with a reason it is accepted');
    const rejSignals = (await pool.request().input('o', sql.UniqueIdentifier, rej.outputId)
      .query("SELECT signal_kind, reviewer_note FROM arion.content_agent_style_signal WHERE output_id=@o")).recordset;
    check(rejSignals.length === 1 && rejSignals[0].signal_kind === 'rejected', 'and the reason is kept as evidence');

    /* 9. runs + cost */
    console.log('\n9. the run log and what it cost');
    r = await api('/arion/content-agent/runs');
    check(r.status === 200, 'the run log answers', `HTTP ${r.status}`);
    check(typeof r.json?.meta?.cost_usd_30d === 'number', 'it reports a 30-day cost in dollars', `$${r.json?.meta?.cost_usd_30d}`);
    check(typeof r.json?.meta?.cost_usd_all_time === 'number', 'and an all-time cost');
    check(r.json?.meta?.cost_breaker && typeof r.json.meta.cost_breaker.allowed === 'boolean',
      'and says whether the cost breaker is currently letting runs through');

    /* 10. learned style */
    console.log('\n10. what the agent has learned');
    r = await api('/arion/content-agent/style');
    check(r.status === 200, 'the style endpoint answers', `HTTP ${r.status}`);
    check(r.json?.data === null, 'it says NOTHING has been learned yet rather than inventing a voice');
    check(/No style profile learned yet/i.test(r.json?.meta?.message || ''), 'in words');

    /* 11. proposals stay proposals */
    console.log('\n11. a code proposal can be approved and still not applied');
    r = await api('/arion/content-agent/proposals');
    check(r.status === 200, 'the proposal queue answers', `HTTP ${r.status}`);
    check(/applied automatically/i.test(r.json?.meta?.note || ''), 'and says nothing is applied automatically', r.json?.meta?.note || '(no note)');
    r = await api('/arion/content-agent/proposals/00000000-0000-0000-0000-000000000000/apply', { method: 'POST', body: {} });
    check(r.status === 400 || r.status === 404, 'there is no apply door', `HTTP ${r.status}`);
    if (r.status === 400) check(/approve or reject/i.test(r.json?.error?.message || ''), 'only approve or reject exist');

    /* 12. THE ROUTE THAT DID NOT EXIST: switching the agent on */
    console.log('\n12. switching the agent on for a business, and setting what it costs (ARGUS pack 1)');
    // `arion.content_agent_tenant_config` IS the product - no row, no runs, no
    // cost - and until this pack the only write to it anywhere was the sticky
    // halt. So the agent could not be sold to anybody without a query window, and
    // `price_usd_monthly` was NULL for every real business, which made the 60%
    // margin rule report "price not set" and protect nothing.
    const cfgBefore = (await pool.request().input('t', sql.UniqueIdentifier, TENANT)
      .query('SELECT enabled, slots_per_cycle, price_usd_monthly FROM arion.content_agent_tenant_config WHERE tenant_id=@t')).recordset[0];

    r = await api('/arion/agents/settings');
    check(r.status === 200, 'the settings read answers', `HTTP ${r.status}`);
    const agent0 = r.json?.data?.agents?.[0];
    check(agent0 && agent0.key === 'content', 'it describes the content agent');
    check(typeof agent0?.enabled === 'boolean', 'with an on/off state');
    check(Object.prototype.hasOwnProperty.call(agent0?.settings || {}, 'price_usd_monthly'),
      'and what this business pays for it');
    check(agent0?.margin && typeof agent0.margin.verdict === 'string',
      'and the 60% margin verdict, where the price is set', agent0?.margin?.verdict);

    r = await api('/arion/agents/settings', {
      method: 'PUT',
      body: { content: { enabled: true, posts_per_week: 2, price_usd_monthly: 249 } },
    });
    check(r.status === 200, 'the write answers', `HTTP ${r.status}`);
    const saved = r.json?.data?.agents?.[0];
    check(saved?.enabled === true, 'the agent is ON for this business');
    check(Number(saved?.settings?.posts_per_week) === 2, 'two pieces a week');
    check(Number(saved?.settings?.price_usd_monthly) === 249, 'at $249 a month');
    check(saved?.margin?.verdict !== 'price_not_set',
      'and the margin rule can now be evaluated at all', saved?.margin?.verdict);

    // A price is configuration, never code: clearing it must be possible and must
    // mean "nobody has told us", not "assume a default".
    r = await api('/arion/agents/settings', { method: 'PUT', body: { content: { price_usd_monthly: null } } });
    check(r.json?.data?.agents?.[0]?.settings?.price_usd_monthly === null,
      'clearing the price is allowed, and it stays empty rather than defaulting');
    check(r.json?.data?.agents?.[0]?.margin?.verdict === 'price_not_set',
      'and the margin check says so out loud');
    // A nonsense value is ignored rather than stored.
    r = await api('/arion/agents/settings', { method: 'PUT', body: { content: { posts_per_week: 9999 } } });
    check(Number(r.json?.data?.agents?.[0]?.settings?.posts_per_week) <= 14,
      'an absurd number of posts a week is clamped, not stored');

    /* 13. the Portal's three reads */
    console.log('\n13. the three reads the Portal page makes');
    r = await api('/arion/agents/activity');
    check(r.status === 200, 'activity answers', `HTTP ${r.status}`);
    check(Array.isArray(r.json?.data?.rows), 'with rows');
    check(Array.isArray(r.json?.data?.escalated), 'and held-back drafts in their OWN collection');
    check(typeof r.json?.data?.meta?.waiting === 'number', 'and a count of what is waiting on a person');
    check(!JSON.stringify(r.json?.data?.rows || []).includes('cost_usd'),
      'AG-1: no cost figure on a client surface');
    const anyRow = (r.json?.data?.rows || [])[0];
    if (anyRow) {
      check(typeof anyRow.cost_note === 'string', 'the client gets cost in words instead');
      check(/Created by Intelligent Analytics/.test(anyRow.attribution || ''),
        'and the attribution line comes from the server');
    }

    r = await api('/arion/agents/runs');
    check(r.status === 200, 'the run history answers', `HTTP ${r.status}`);
    check(Array.isArray(r.json?.data?.rows), 'with runs');
    check(typeof r.json?.data?.meta?.failed === 'number', 'and counts failures separately from empty runs');
    check(!JSON.stringify(r.json?.data || {}).includes('cost_usd'),
      'AG-1 again: no dollar figure in the run history a client can see');

    /* 14. Run it now */
    console.log('\n14. Run it now - this business only, never the fleet');
    // It must refuse politely rather than 500 when the agent is off or halted.
    await pool.request().input('t', sql.UniqueIdentifier, TENANT)
      .query('UPDATE arion.content_agent_tenant_config SET enabled = 0 WHERE tenant_id = @t');
    r = await api('/arion/agents/run', { method: 'POST', body: {} });
    check(r.status === 409 && r.json?.error?.code === 'NOT_ENABLED',
      'a switched-off agent refuses in words rather than pretending to run', `HTTP ${r.status}`);
    await pool.request().input('t', sql.UniqueIdentifier, TENANT)
      .query("UPDATE arion.content_agent_tenant_config SET enabled = 1, halted_at = SYSDATETIMEOFFSET(), halted_reason = 'walk fixture halt' WHERE tenant_id = @t");
    r = await api('/arion/agents/run', { method: 'POST', body: {} });
    check(r.status === 409 && r.json?.error?.code === 'HALTED',
      'and one that stopped itself says so, and stays stopped', `HTTP ${r.status}`);
    // Put the business back exactly as it was found.
    await pool.request()
      .input('t', sql.UniqueIdentifier, TENANT)
      .input('en', sql.Bit, cfgBefore ? cfgBefore.enabled : 0)
      .input('slots', sql.Int, cfgBefore ? cfgBefore.slots_per_cycle : 1)
      .input('price', sql.Decimal(10, 2), cfgBefore ? cfgBefore.price_usd_monthly : null)
      .query(`UPDATE arion.content_agent_tenant_config
                 SET enabled = @en, slots_per_cycle = @slots, price_usd_monthly = @price,
                     halted_at = NULL, halted_reason = NULL
               WHERE tenant_id = @t`);
    const cfgAfter = (await pool.request().input('t', sql.UniqueIdentifier, TENANT)
      .query('SELECT enabled, slots_per_cycle, price_usd_monthly, halted_at FROM arion.content_agent_tenant_config WHERE tenant_id=@t')).recordset[0];
    check(!!cfgAfter && cfgAfter.halted_at === null
      && Number(cfgAfter.enabled) === Number(cfgBefore ? cfgBefore.enabled : 0)
      && Number(cfgAfter.slots_per_cycle) === Number(cfgBefore ? cfgBefore.slots_per_cycle : 1),
    'the business is left exactly as this walk found it');

    /* 15. cleanup */
    console.log('\n15. removing everything this walk created');
    for (const u of mine) await deleteUnit(pool, u);
    const left = (await pool.request()
      .query(`SELECT COUNT(*) n FROM arion.content_agent_output WHERE primary_keyword LIKE 'walk fixture%'`)).recordset[0].n;
    check(left === 0, 'no walk rows remain in the queue', `${left} left`);
    const runsLeft = (await pool.request()
      .query("SELECT COUNT(*) n FROM arion.content_agent_run_log WHERE agent_version = 'walk'")).recordset[0].n;
    check(runsLeft === 0, 'and none in the run log', `${runsLeft} left`);
    const counts = (await pool.request().query(`
      SELECT (SELECT COUNT(*) FROM arion.content_agent_run_log) AS runs,
             (SELECT COUNT(*) FROM arion.content_agent_output) AS outputs,
             (SELECT COUNT(*) FROM arion.content_agent_style_signal) AS signals`)).recordset[0];
    check(counts.runs === 4 && counts.outputs === 3 && counts.signals === 2,
      'the three pre-existing fixture drafts and their two signals are exactly as they were',
      `runs=${counts.runs} outputs=${counts.outputs} signals=${counts.signals}`);
  } finally {
    server.child.kill();
    await pool.close();
  }

  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('\nWALK ERROR:', err); process.exit(1); });
