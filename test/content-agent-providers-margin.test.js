// test/content-agent-providers-margin.test.js
//
// The 2026-08-24 direction change, pinned as tests:
//
//   1. SEO tools are OPTIONAL inputs. A tenant without SE Ranking still gets a
//      working agent — qualification adapts to what the provider can know, and
//      the rationale honestly says what it didn't know (the upsell line).
//
//   2. The 60% rule. LLM spend must stay under 60% of what the tenant pays.
//      A breach is a pricing alarm, price comes from CONFIG (never code), and
//      "price not set" is itself a surfaced finding — not silently OK.
//
//   3. The tick runs enabled tenants only, isolates their failures, and the F8
//      halt is STICKY on the tenant's config row.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDERS, CAPABILITIES, UPSELL_LINE, resolveProvider,
} from '../lib/contentAgent/keywordProviders.js';
import { qualify, buildRationale, FULL_CAPABILITIES, REJECT } from '../lib/contentAgent/topicSelection.js';
import {
  checkMargin, marginReport, MARGIN, MAX_COST_TO_PRICE_RATIO,
} from '../lib/contentAgent/marginMonitor.js';
import { runTick, haltTenant } from '../lib/contentAgent/tick.js';
import { fakeJobsOn, fakeBriefFor } from './helpers/team-job-fakes.mjs';
import { HEALTH } from '../lib/contentAgent/serankingHealth.js';
import { planSlides, slideHtml, esc, renderCarousel, MAX_RENDER_ATTEMPTS } from '../lib/contentAgent/carouselRenderer.js';
import { AssetStoreNotConfigured, storeAsset, _resetClient } from '../lib/contentAgent/assetStore.js';

// Every business here has ARION on; the product check has its own tests
// (test/product-ownership.test.mjs). Without this the tick would open the real
// platform pool to ask.
const ALL_ON = async (product, ids) => ({ product, owned: [...ids], off: [], unknown: [], undecided: false, error: null });

const T_A = 'a0000001-0000-0000-0000-000000000001';

/** Pool answering by query shape. */
function fakePool(answers = {}) {
  return {
    queries: [],
    request() {
      const self = this;
      return {
        inputs: {},
        input(n, _t, v) { this.inputs[n] = v; return this; },
        async query(text) {
          self.queries.push({ text, inputs: this.inputs });
          for (const [pattern, rows] of Object.entries(answers)) {
            if (new RegExp(pattern, 'i').test(text)) {
              return { recordset: typeof rows === 'function' ? rows(this.inputs) : rows };
            }
          }
          return { recordset: [] };
        },
      };
    },
  };
}

// --- provider tiers ---------------------------------------------------------

test('capability-gated qualification: a no-KD provider does not reject on missing KD', () => {
  const kw = { keyword: 'seasonal maintenance', intent: 'informational' }; // no volume, no KD
  // Under SE Ranking semantics this is rejected — missing data from a source
  // that should have it means something is broken.
  assert.equal(qualify(kw, { capabilities: FULL_CAPABILITIES }).ok, false);
  // Under RankMath/none semantics the gates are simply not applicable.
  assert.equal(qualify(kw, { capabilities: CAPABILITIES[PROVIDERS.RANKMATH] }).ok, true);
  assert.equal(qualify(kw, { capabilities: CAPABILITIES[PROVIDERS.NONE] }).ok, true);
});

test('dedup is NOT capability-gated — Rule 21.1 applies to every tenant', () => {
  const published = [{ primary_keyword: 'seasonal maintenance', published_at: new Date().toISOString() }];
  const v = qualify({ keyword: 'seasonal maintenance' }, {
    capabilities: CAPABILITIES[PROVIDERS.NONE], publishedKeywords: published,
  });
  assert.equal(v.ok, false);
  assert.equal(v.reason, REJECT.DUPLICATE);
});

test('the rationale says what was NOT known, and carries the upsell', () => {
  const r = buildRationale({ keyword: 'gutter cleaning' }, {
    authorityStage: 'new', sourceRule: 'RankMath (via IA plugin)',
    capabilities: CAPABILITIES[PROVIDERS.RANKMATH], upsell: UPSELL_LINE,
  });
  assert.match(r, /not available/i, 'missing data must be stated, not implied');
  assert.match(r, /make your agent smarter/i, 'the honest gap IS the upsell');
  assert.doesNotMatch(r, /Search volume \d+\/mo/, 'no fabricated numbers for data the provider never had');
});

test('auto-resolution prefers SE Ranking, falls to RankMath on captured focus keywords, then none', async () => {
  const okProbe = async () => ({ verdict: HEALTH.HEALTHY, status: 200, detail: 'ok' });
  const deadProbe = async () => ({ verdict: HEALTH.AUTH_FAILED, status: 401, detail: '401' });

  const se = await resolveProvider(fakePool(), T_A, { probe: okProbe });
  assert.equal(se.provider, PROVIDERS.SE_RANKING);

  const rm = await resolveProvider(fakePool({ 'focus_keyword IS NOT NULL': [{ n: 12 }] }), T_A, { probe: deadProbe });
  assert.equal(rm.provider, PROVIDERS.RANKMATH);

  const none = await resolveProvider(fakePool({ 'focus_keyword IS NOT NULL': [{ n: 0 }] }), T_A, { probe: deadProbe });
  assert.equal(none.provider, PROVIDERS.NONE);
  assert.match(none.detail, /no RankMath focus keywords/i);
});

test('a pinned provider bypasses auto-detection', async () => {
  let probed = 0;
  const r = await resolveProvider(fakePool(), T_A, {
    configured: 'rankmath', probe: async () => { probed += 1; },
  });
  assert.equal(r.provider, PROVIDERS.RANKMATH);
  assert.equal(probed, 0, 'a pinned choice must not pay for detection');
});

// --- the 60% rule -----------------------------------------------------------

test('cost over 60% of price is a BREACH with a rethink-pricing message', async () => {
  const pool = fakePool({ 'SUM\\(cost_usd\\)': [{ cost_usd: 65, price_usd_monthly: 100 }] });
  const m = await checkMargin(pool, T_A, { windowDays: 30 });
  assert.equal(m.verdict, MARGIN.BREACH);
  assert.ok(m.ratio >= MAX_COST_TO_PRICE_RATIO);
  assert.match(m.message, /rethink pricing/i);
});

test('45-60% warns before the line is crossed', async () => {
  const pool = fakePool({ 'SUM\\(cost_usd\\)': [{ cost_usd: 50, price_usd_monthly: 100 }] });
  const m = await checkMargin(pool, T_A);
  assert.equal(m.verdict, MARGIN.WARN);
});

test('healthy margin is OK', async () => {
  const pool = fakePool({ 'SUM\\(cost_usd\\)': [{ cost_usd: 3, price_usd_monthly: 100 }] });
  const m = await checkMargin(pool, T_A);
  assert.equal(m.verdict, MARGIN.OK);
});

test('no configured price = PRICE_NOT_SET, surfaced — never silently OK, never a hardcoded default', async () => {
  const pool = fakePool({ 'SUM\\(cost_usd\\)': [{ cost_usd: 5, price_usd_monthly: null }] });
  const m = await checkMargin(pool, T_A);
  assert.equal(m.verdict, MARGIN.PRICE_NOT_SET);
  assert.equal(m.ratio, null, 'no fabricated ratio from a fabricated price');
  assert.match(m.message, /no price is configured/i);
});

test('a shorter window is normalised to a month before comparing', async () => {
  // $14 in 7 days = $60/mo against a $100 price = 60% breach, even though
  // $14 < $60 raw. Without normalisation the weekly check would always pass.
  const pool = fakePool({ 'SUM\\(cost_usd\\)': [{ cost_usd: 14, price_usd_monthly: 100 }] });
  const m = await checkMargin(pool, T_A, { windowDays: 7 });
  assert.equal(m.verdict, MARGIN.BREACH);
});

test('the founder report sorts worst margin first, unpriced on top', async () => {
  const pool = fakePool({
    'FROM arion\\.content_agent_tenant_config c': [
      { tenant_id: 't-ok', price_usd_monthly: 100, cost_usd: 5 },
      { tenant_id: 't-bad', price_usd_monthly: 100, cost_usd: 70 },
      { tenant_id: 't-unpriced', price_usd_monthly: null, cost_usd: 9 },
    ],
  });
  const rows = await marginReport(pool);
  assert.equal(rows[0].tenantId, 't-unpriced', 'unmeasurable comes first — it is the most urgent gap');
  assert.equal(rows[1].tenantId, 't-bad');
  assert.equal(rows[1].verdict, MARGIN.BREACH);
  assert.equal(rows[2].verdict, MARGIN.OK);
});

// --- the tick ---------------------------------------------------------------
// ARGUS employees phase 1: WHO runs is the jobs that are on (jobsOn), not the
// old config row; the config row is optional agent state (the sticky breaker).

const agentRow = (tenantId, extra = {}) => ({
  tenant_id: tenantId, site_id: null, keyword_provider: 'none', authority_stage: 'new',
  halted_at: null, halted_reason: null, ...extra,
});
const AGENT_ROWS = 'FROM arion\\.content_agent_tenant_config\\s+WHERE tenant_id IN';

test('the tick runs businesses with a job on and skips halted ones without touching them', async () => {
  const pool = fakePool({
    [AGENT_ROWS]: [agentRow('t-halted', { halted_at: '2026-08-20T00:00:00Z', halted_reason: 'cost ceiling' })],
    'FROM arion\\.content_agent_tenant_config c': [],
  });
  const ranFor = [];
  const s = await runTick({ ownership: ALL_ON,
    pool,
    jobsOn: fakeJobsOn({ 't-live': ['arion.blog_posts'], 't-halted': ['arion.blog_posts'] }),
    briefFor: fakeBriefFor(),
    cycle: async ({ tenantId }) => { ranFor.push(tenantId); return { runId: 'r', status: 'completed', outcome: 'selected', drafted: 1, escalated: 0, costUsd: 0.09, alerts: [] }; },
    doResearch: async () => ({ provider: 'none', capabilities: CAPABILITIES.none, rows: [{ keyword: 'x' }], detail: 'test' }),
  });
  assert.deepEqual(ranFor, ['t-live'], 'the halted business must do NO work');
  assert.equal(s.skippedHalted, 1);
  assert.equal(s.ran, 1);
});

test('an F8 outcome halts the business STICKILY, creating its agent row when it has none', async () => {
  const pool = fakePool({
    [AGENT_ROWS]: [],
    'FROM arion\\.content_agent_tenant_config c': [],
  });
  await runTick({ ownership: ALL_ON,
    pool,
    jobsOn: fakeJobsOn({ 't-spendy': ['arion.blog_posts'] }),
    briefFor: fakeBriefFor(),
    cycle: async () => ({ runId: null, status: 'halted', outcome: 'cost_ceiling', drafted: 0, escalated: 0, costUsd: 9, alerts: [{ failure_mode: 'F8', code: 'cycle_ceiling_exceeded', message: 'over' }] }),
    doResearch: async () => ({ provider: 'none', capabilities: CAPABILITIES.none, rows: [], detail: 'test' }),
  });
  const halt = pool.queries.find((q) => /SET halted_at = SYSDATETIMEOFFSET/i.test(q.text));
  assert.ok(halt, 'the halt must be WRITTEN, not just reported');
  assert.match(halt.text, /halted_at IS NULL/i, 'idempotent — never overwrite an existing halt');
  assert.match(halt.text, /WHEN NOT MATCHED THEN\s+INSERT/i, 'a business with no agent row still trips the breaker (F3)');
});

test('one business\'s failure never costs another business\'s cycle', async () => {
  const pool = fakePool({ [AGENT_ROWS]: [], 'FROM arion\\.content_agent_tenant_config c': [] });
  const ranFor = [];
  const s = await runTick({ ownership: ALL_ON,
    pool,
    jobsOn: fakeJobsOn({ 't-boom': ['arion.blog_posts'], 't-fine': ['arion.blog_posts'] }),
    briefFor: fakeBriefFor(),
    cycle: async ({ tenantId }) => {
      ranFor.push(tenantId);
      if (tenantId === 't-boom') throw new Error('kaboom');
      return { runId: 'r', status: 'completed', outcome: 'selected', drafted: 1, escalated: 0, costUsd: 0.05, alerts: [] };
    },
    doResearch: async () => ({ provider: 'none', capabilities: CAPABILITIES.none, rows: [{ keyword: 'x' }], detail: 'test' }),
  });
  assert.ok(ranFor.includes('t-fine'), 'the healthy business still ran');
  assert.equal(s.failed, 1);
  assert.equal(s.ran, 1);
});

test('margin breaches surface as alerts in the tick summary', async () => {
  const pool = fakePool({
    [AGENT_ROWS]: [],
    'FROM arion\\.content_agent_tenant_config c': [{ tenant_id: 't-bad', price_usd_monthly: 100, cost_usd: 70 }],
  });
  const s = await runTick({ ownership: ALL_ON, pool, jobsOn: fakeJobsOn({}), briefFor: fakeBriefFor(), cycle: async () => ({}), doResearch: async () => ({}) });
  assert.ok(s.alerts.some((a) => a.failure_mode === 'MARGIN'), 'the 60% breach must be un-missable in the summary');
});

// --- the renderer (Task 5) --------------------------------------------------

test('planSlides: structured slides win, H2 sections next, single-thought fallback last', () => {
  assert.equal(planSlides({ slides: [{ heading: 'A' }, { heading: 'B' }] }).length, 2);
  const fromMd = planSlides({ body_markdown: 'intro\n## First point\ndetail one\n## Second point\ndetail two' });
  assert.equal(fromMd.length, 2);
  assert.equal(fromMd[0].heading, 'First point');
  const fallback = planSlides({ title: 'One thought', body_markdown: 'no headings here' });
  assert.ok(fallback.length >= 1);
});

test('slide HTML escapes tenant copy — a heading cannot inject markup', () => {
  const html = slideHtml({ heading: '<script>alert(1)</script>', body: '', index: 0, total: 1 });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(esc('a & b'), 'a &amp; b');
});

test('brand tokens drive the slide colors — tenant A\'s tokens never come from a global', () => {
  const html = slideHtml({ heading: 'H', body: '', index: 0, total: 1, tokens: { bg: '#123456', accent: '#654321' } });
  assert.match(html, /#123456/);
  assert.match(html, /#654321/);
});

test('renderCarousel retries up to the F7 cap then throws a manual-fallback error', async () => {
  let attempts = 0;
  await assert.rejects(
    () => renderCarousel({
      tenantId: T_A, outputId: 'o1', draft: { title: 'T', body_markdown: 'body' },
      store: async () => 'p', launch: async () => { attempts += 1; throw new Error('no chromium'); },
    }),
    (e) => { assert.equal(e.failureMode, 'F7'); return true; },
  );
  assert.equal(attempts, MAX_RENDER_ATTEMPTS, `must try exactly ${MAX_RENDER_ATTEMPTS} times (Rule 21.4)`);
});

test('a successful render stores one PNG per slide under the tenant/output prefix', async () => {
  const stored = [];
  const fakePage = {
    setContent: async () => {},
    screenshot: async () => Buffer.from('png'),
  };
  const res = await renderCarousel({
    tenantId: T_A, outputId: 'o1',
    draft: { body_markdown: '## One\na\n## Two\nb' },
    store: async ({ tenantId, outputId, name }) => { stored.push(`${tenantId}/${outputId}/${name}`); return `content-agent/${tenantId}/${outputId}/${name}`; },
    launch: async () => ({ newPage: async () => fakePage, close: async () => {} }),
  });
  assert.equal(res.slides, 2);
  assert.equal(stored.length, 2);
  assert.ok(stored[0].startsWith(`${T_A}/o1/`), 'blob path must be tenant-scoped');
});

// --- the asset store fails closed -------------------------------------------

test('no STORAGE_CONNECTION_STRING => AssetStoreNotConfigured, never a default location', async () => {
  const saved = process.env.STORAGE_CONNECTION_STRING;
  delete process.env.STORAGE_CONNECTION_STRING;
  _resetClient();
  try {
    await assert.rejects(
      () => storeAsset({ tenantId: T_A, outputId: 'o', name: 'x.png', buffer: Buffer.from('x') }),
      AssetStoreNotConfigured,
    );
  } finally {
    if (saved !== undefined) process.env.STORAGE_CONNECTION_STRING = saved;
    _resetClient();
  }
});
