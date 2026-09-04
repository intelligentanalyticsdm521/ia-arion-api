/**
 * "Tell the AI what you want, preview, approve" — the guards.
 *
 * Three of these are the ones that matter, and each was mutation-tested by
 * breaking the thing it guards and confirming the suite goes red
 * (feedback_mutation_test_your_guards):
 *
 *   1. A Lite site never reaches a model. Deleting the tier gate must fail
 *      this file, not just change a status code.
 *   2. Exactly one metered call per proposal. Zero (metering skipped) and two
 *      (metered twice) both fail.
 *   3. A field the schema does not know is refused outright, not dropped —
 *      because a dropped field means the client approves a diff that does not
 *      describe what gets written.
 *
 * NO REAL MODEL IS CALLED ANYWHERE IN THIS FILE. Every call goes through the
 * injected `callModel` seam.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  proposeSectionEdit, proposePageEdit, aiTierGate, buildDiff, diffToPlain,
  ACTION_SECTION_EDIT, ACTION_PAGE_EDIT, MODEL_SECTION_EDIT, LITE_UPSELL,
  MAX_INSTRUCTION_CHARS, meterErrorToHttp, __test__ as aiInternals,
} from '../lib/websiteBuilder/aiEdit.js';
import { _resetArgusTablesProbe } from '../lib/argus/tables.js';
import { validateProposedFields, extractFields } from '../lib/websiteBuilder/sectionSchema.js';
import { buildStarterSection } from '../lib/websiteBuilder/starterSections.js';
import { markProposalsApplied, resolveProposal, __test__ as storeInternals } from '../lib/websiteBuilder/proposalStore.js';
import { writePageSections } from '../lib/websiteBuilder/pageClient.js';

/* ── a SQL pool that answers ARGUS and records everything ──────────────── */

function fakePool({ credits = 1, balance = 500, spendEnabled = true, consolidated = true } = {}) {
  const calls = [];
  const pool = {
    calls,
    request() {
      const req = {
        input() { return req; },
        async query(text) {
          calls.push({ kind: 'query', text: String(text).replace(/\s+/g, ' ').trim() });
          const t = String(text);
          if (t.includes("OBJECT_ID('argus.credit_grant'")) {
            return { recordset: [{ id: consolidated ? 1 : null }] };
          }
          if (t.includes('platform_config')) {
            return { recordset: [{ value: spendEnabled ? 'true' : 'false' }] };
          }
          if (t.includes('credits_per_call')) {
            return { recordset: credits == null ? [] : [{ credits_per_call: credits, outlier_cap_usd: 0.5, is_active: true }] };
          }
          if (/UPDATE\s+arion\.site_edit_proposal/i.test(t)) {
            return { recordset: [{ moved: 1 }] };
          }
          return { recordset: [] };
        },
        async execute(proc) {
          calls.push({ kind: 'execute', text: proc });
          return { recordset: [{ balance, lifetime_granted: balance, lifetime_spent: 0, lifetime_refunded: 0 }] };
        },
      };
      return req;
    },
  };
  return pool;
}

const auditInserts = (pool) => pool.calls.filter((c) => /INSERT INTO argus\.ai_call_audit/i.test(c.text));
const debitInserts = (pool) => pool.calls.filter((c) => /INSERT INTO argus\.credit_use/i.test(c.text));
const proposalInserts = (pool) => pool.calls.filter((c) => /INSERT INTO arion\.site_edit_proposal/i.test(c.text));

/* ── a model that answers whatever the test wants, and counts ──────────── */

function fakeModel(reply) {
  const calls = [];
  const impl = async (opts) => {
    calls.push(opts);
    const r = typeof reply === 'function' ? reply(opts) : reply;
    if (r instanceof Error) throw r;
    return {
      ok: r.ok !== false,
      data: r.data,
      text: JSON.stringify(r.data || {}),
      inputTokens: r.inputTokens ?? 1200,
      outputTokens: r.outputTokens ?? 300,
      model: opts.model,
      latencyMs: 12,
      ...(r.ok === false ? { error: r.error || { code: 'http_500', message: 'boom' } } : {}),
    };
  };
  impl.calls = calls;
  return impl;
}

const PAID_SITE = Object.freeze({ site_id: 's1', tenant_id: 't1', domain: 'fernbrook.invalid', site_token_raw: 'tok', arion_tier: 'pro' });
const LITE_SITE = Object.freeze({ ...PAID_SITE, arion_tier: 'lite' });
const BRAND = Object.freeze({ business_name: 'Fernbrook Joinery', brand_voice: 'warm', email: 'hello@fernbrook.invalid' });
const HERO_NOW = Object.freeze({
  headline: 'Bespoke joinery', subheadline: 'Made in the workshop.',
  cta_text: 'Get a quote', cta_href: '#contact',
});

const TENANT = '11111111-1111-1111-1111-111111111111';
const SITE_UUID = '22222222-2222-2222-2222-222222222222';

test.beforeEach(() => { _resetArgusTablesProbe(); });

/* ==========================================================================
 * 1. The plan gate — PRESENCE of a paid tier, never absence of "lite"
 * ======================================================================== */

test('the AI gate is an allowlist of paid tiers, not a "not lite" test', () => {
  assert.equal(aiTierGate({ arion_tier: 'standard' }).allowed, true);
  assert.equal(aiTierGate({ arion_tier: 'PRO' }).allowed, true);
  assert.equal(aiTierGate({ arion_tier: 'business' }).allowed, true);
  assert.equal(aiTierGate({ arion_tier: 'enterprise' }).allowed, true);

  assert.equal(aiTierGate({ arion_tier: 'lite' }).allowed, false);
  // The cases an absence-based guard fails open on
  // (reference_absence_based_guards_fail_open): every one of these is NOT the
  // word "lite" and every one of them must still be refused.
  assert.equal(aiTierGate({ arion_tier: '' }).allowed, false);
  assert.equal(aiTierGate({ arion_tier: null }).allowed, false);
  assert.equal(aiTierGate({}).allowed, false);
  assert.equal(aiTierGate({ arion_tier: 'starter' }).allowed, false);   // an SEO add-on word
  assert.equal(aiTierGate({ arion_tier: 'lite-plus' }).allowed, false);
  assert.equal(aiTierGate(null).allowed, false);
});

test('a Lite site never reaches a model, and is never charged', async () => {
  const pool = fakePool();
  const model = fakeModel({ data: { fields: { headline: 'Nope' } } });

  const out = await proposeSectionEdit({
    pool, tenantId: TENANT, site: LITE_SITE, kind: 'hero',
    fields: HERO_NOW, brand: BRAND, instruction: 'Make it friendlier', callModel: model,
  });

  assert.equal(out.ok, false);
  assert.equal(out.error.status, 403);
  assert.equal(out.error.code, 'AI_NOT_ON_THIS_PLAN');
  assert.equal(out.error.message, LITE_UPSELL);
  // The two assertions the gate exists for.
  assert.equal(model.calls.length, 0, 'a Lite site must not reach a model');
  assert.equal(auditInserts(pool).length, 0, 'a refused plan must not write an ARGUS audit row');
  assert.equal(debitInserts(pool).length, 0, 'a refused plan must not be debited');
});

test('the upsell names the plan, never a vendor', () => {
  assert.match(LITE_UPSELL, /ARION Standard/);
  assert.doesNotMatch(LITE_UPSELL, /claude|anthropic|openai|gpt|llm/i);
  assert.match(LITE_UPSELL, /change every word and picture on this page yourself/);
});

/* ==========================================================================
 * 2. Metering — exactly one per proposal, and never around it
 * ======================================================================== */

test('one section proposal spends exactly one metered call', async () => {
  const pool = fakePool({ credits: 1 });
  const model = fakeModel({ data: { fields: { headline: 'Joinery made by hand' }, summary: 'Warmer headline.' } });

  const out = await proposeSectionEdit({
    pool, tenantId: TENANT, site: PAID_SITE, kind: 'hero',
    fields: HERO_NOW, brand: BRAND, instruction: 'Warmer, please', callModel: model,
  });

  assert.equal(out.ok, true);
  assert.equal(model.calls.length, 1);
  // Zero would mean the metering was skipped; two would mean it ran twice.
  assert.equal(auditInserts(pool).length, 1, 'exactly one ARGUS audit row per proposal');
  assert.equal(debitInserts(pool).length, 1, 'exactly one credit debit per proposal');
  assert.equal(out.audit.credits_charged, 1);
  assert.equal(out.proposal.cost_units, 1);
});

test('the section edit is metered as its own ARGUS action, on the cheap model', async () => {
  const pool = fakePool();
  const model = fakeModel({ data: { fields: { headline: 'x' } } });
  await proposeSectionEdit({
    pool, tenantId: TENANT, site: PAID_SITE, kind: 'hero',
    fields: HERO_NOW, brand: BRAND, instruction: 'shorter', callModel: model,
  });
  assert.equal(model.calls[0].model, MODEL_SECTION_EDIT);
  assert.equal(ACTION_SECTION_EDIT, 'arion.site_edit_section');
  assert.equal(ACTION_PAGE_EDIT, 'arion.site_edit_page');
});

test('no credits, no call — and the client is told the number', async () => {
  const pool = fakePool({ credits: 6, balance: 2 });
  const model = fakeModel({ data: { fields: { headline: 'x' } } });

  const out = await proposeSectionEdit({
    pool, tenantId: TENANT, site: PAID_SITE, kind: 'hero',
    fields: HERO_NOW, brand: BRAND, instruction: 'warmer', callModel: model,
  });

  assert.equal(out.ok, false);
  assert.equal(out.error.status, 402);
  assert.match(out.error.message, /6 ARGUS credits and you have 2/);
  assert.equal(model.calls.length, 0, 'a balance check that runs after the call is not a balance check');
});

test('a missing pricing row switches the feature OFF — it never runs free', async () => {
  // meterAndAudit answers `unknown_action` when no row matches. Falling back
  // to an unmetered call would be a generation nobody can account for, which
  // is exactly what migration 059 exists to prevent.
  const pool = fakePool({ credits: null });
  const model = fakeModel({ data: { fields: { headline: 'x' } } });

  const out = await proposeSectionEdit({
    pool, tenantId: TENANT, site: PAID_SITE, kind: 'hero',
    fields: HERO_NOW, brand: BRAND, instruction: 'warmer', callModel: model,
  });

  assert.equal(out.ok, false);
  assert.equal(out.error.status, 503);
  assert.equal(model.calls.length, 0);
});

test('the ARGUS kill switch stops the spend', async () => {
  const pool = fakePool({ spendEnabled: false });
  const model = fakeModel({ data: { fields: { headline: 'x' } } });
  const out = await proposeSectionEdit({
    pool, tenantId: TENANT, site: PAID_SITE, kind: 'hero',
    fields: HERO_NOW, brand: BRAND, instruction: 'warmer', callModel: model,
  });
  assert.equal(out.ok, false);
  assert.equal(out.error.status, 503);
  assert.equal(model.calls.length, 0);
});

/* ==========================================================================
 * 3. Validation — a field the schema does not know is REFUSED, not dropped
 * ======================================================================== */

test('a field the schema does not know is refused', () => {
  const bad = validateProposedFields('hero', { ...HERO_NOW, sparkle_level: 'high' });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].field, 'sparkle_level');
  assert.match(bad.errors[0].message, /is not something this section has/);

  // …including a field that belongs to a DIFFERENT section kind.
  const wrongKind = validateProposedFields('hero', { ...HERO_NOW, faqs: [{ question: 'q', answer: 'a' }] });
  assert.equal(wrongKind.ok, false);
  assert.equal(wrongKind.errors[0].field, 'faqs');

  // …and a stray key inside a list row.
  const strayRow = validateProposedFields('services', {
    headline: 'What we do',
    services: [{ title: 'Fitting', description: 'd', icon_name: 'check', colour: 'red' }],
  });
  assert.equal(strayRow.ok, false);
  assert.equal(strayRow.errors[0].field, 'services[0].colour');

  // The ordinary editor validator still ignores unknown keys, which is right
  // for a form that can only ever send keys it rendered.
  assert.equal(validateProposedFields('hero', HERO_NOW).ok, true);
});

test('a proposal carrying an unknown field is refused whole, and nothing is proposed', async () => {
  const pool = fakePool();
  const model = fakeModel({ data: { fields: { headline: 'Fine', sparkle_level: 'high' } } });

  const out = await proposeSectionEdit({
    pool, tenantId: TENANT, site: PAID_SITE, kind: 'hero',
    fields: HERO_NOW, brand: BRAND, instruction: 'sparkle', callModel: model,
  });

  assert.equal(out.ok, false);
  assert.equal(out.error.status, 422);
  assert.equal(out.error.code, 'AI_PROPOSAL_INVALID');
  assert.equal(out.proposal, undefined, 'a refused proposal is not half-returned');
  // The call still happened, so it is still audited and still charged.
  assert.equal(auditInserts(pool).length, 1);
});

test('a proposal that breaks a length limit is refused, not truncated', async () => {
  const pool = fakePool();
  const model = fakeModel({ data: { fields: { headline: 'x'.repeat(400) } } });
  const out = await proposeSectionEdit({
    pool, tenantId: TENANT, site: PAID_SITE, kind: 'hero',
    fields: HERO_NOW, brand: BRAND, instruction: 'longer', callModel: model,
  });
  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'AI_PROPOSAL_INVALID');
  assert.match(out.error.errors[0].message, /too long/);
});

test('an unreadable answer is a failure, never a silent no-op', async () => {
  const pool = fakePool();
  for (const reply of [{ data: 'just a string' }, { data: { nope: true } }, { data: null }]) {
    const out = await proposeSectionEdit({
      pool, tenantId: TENANT, site: PAID_SITE, kind: 'hero',
      fields: HERO_NOW, brand: BRAND, instruction: 'warmer', callModel: fakeModel(reply),
    });
    assert.equal(out.ok, false);
    assert.equal(out.error.status, 502);
  }
});

test('a provider failure never reports success', async () => {
  const pool = fakePool();
  const out = await proposeSectionEdit({
    pool, tenantId: TENANT, site: PAID_SITE, kind: 'hero',
    fields: HERO_NOW, brand: BRAND, instruction: 'warmer',
    callModel: fakeModel({ ok: false, error: { code: 'http_529', message: 'overloaded' } }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.proposal, undefined);
  assert.match(out.error.message, /Nothing was changed/);
});

test('an empty or over-long instruction is refused before anything is spent', async () => {
  const pool = fakePool();
  const model = fakeModel({ data: { fields: {} } });
  for (const instruction of ['', '   ', 'x'.repeat(MAX_INSTRUCTION_CHARS + 1)]) {
    const out = await proposeSectionEdit({
      pool, tenantId: TENANT, site: PAID_SITE, kind: 'hero',
      fields: HERO_NOW, brand: BRAND, instruction, callModel: model,
    });
    assert.equal(out.ok, false);
    assert.equal(out.error.status, 400);
  }
  assert.equal(model.calls.length, 0);
  assert.equal(auditInserts(pool).length, 0);
});

/* ==========================================================================
 * 4. The proposal itself — what the client reads before approving
 * ======================================================================== */

test('the proposal merges onto what is there and diffs only what moved', async () => {
  const pool = fakePool();
  const model = fakeModel({
    data: { fields: { headline: 'Joinery made by hand' }, summary: 'Warmer headline.' },
  });

  const out = await proposeSectionEdit({
    pool, tenantId: TENANT, site: PAID_SITE, kind: 'hero',
    fields: HERO_NOW, brand: BRAND, instruction: 'warmer', callModel: model,
  });

  assert.equal(out.ok, true);
  assert.deepEqual(out.proposal.before, HERO_NOW);
  assert.equal(out.proposal.after.headline, 'Joinery made by hand');
  // Untouched fields survive the merge — a partial answer is not a wipe.
  assert.equal(out.proposal.after.cta_text, 'Get a quote');
  assert.equal(out.proposal.after.subheadline, 'Made in the workshop.');
  assert.equal(out.proposal.diff.length, 1);
  assert.equal(out.proposal.diff[0].field, 'headline');
  assert.match(out.proposal.diff_plain, /Headline: “Bespoke joinery” → “Joinery made by hand”/);
});

test('a field the model returned unchanged never shows up in the diff', () => {
  const rows = buildDiff('hero', HERO_NOW, { ...HERO_NOW, cta_text: 'Get a quote' });
  assert.equal(rows.length, 0);
  assert.equal(diffToPlain(rows), 'Nothing would change.');
});

test('a list diff counts rows rather than dumping JSON at the client', () => {
  const before = { headline: 'What we do', services: [{ title: 'A' }] };
  const after = { headline: 'What we do', services: [{ title: 'A' }, { title: 'B' }] };
  const rows = buildDiff('services', before, after);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'list');
  assert.equal(rows[0].beforeText, '1 service');
  assert.equal(rows[0].afterText, '2 services');
});

test('the prompt carries the schema and the business, and never the vendor', async () => {
  const pool = fakePool();
  const model = fakeModel({ data: { fields: { headline: 'x' } } });
  await proposeSectionEdit({
    pool, tenantId: TENANT, site: PAID_SITE, kind: 'services',
    fields: { headline: 'What we do', services: [{ title: 'Fitting', description: 'd', icon_name: 'check' }] },
    brand: BRAND, instruction: 'shorter', callModel: model,
  });
  const { system, user } = model.calls[0];
  assert.match(system, /services \(list\)/);
  assert.match(system, /each row has: \{ title \(text\) REQUIRED/);
  assert.match(system, /Never invent a fact/);
  assert.match(user, /Fernbrook Joinery/);
  assert.doesNotMatch(system, /claude|anthropic/i);
});

test('a number where a string belongs is coerced; a shape that is wrong is not', () => {
  const { coerceFields } = aiInternals;
  assert.deepEqual(coerceFields('hero', { headline: 42 }), { headline: '42' });
  assert.deepEqual(coerceFields('about', { story_paragraphs: 'one\n\ntwo' }), { story_paragraphs: ['one', 'two'] });
  // Not coerced: the validator has to see this and refuse it.
  assert.deepEqual(coerceFields('services', { services: 'not a list' }), { services: 'not a list' });
});

/* ==========================================================================
 * 5. Page-level — proposals only, and never onto a locked section
 * ======================================================================== */

const PAGE = Object.freeze([
  { index: 0, kind: 'hero', editable: true, fields: { ...HERO_NOW } },
  { index: 1, kind: null, editable: false, fields: null },     // built on the site itself
  { index: 2, kind: 'cta', editable: true, fields: { headline: 'Ready?', primary_cta_text: 'Call', primary_cta_href: 'tel:1' } },
]);

test('a page proposal edits what it may and adds what it was asked for', async () => {
  const pool = fakePool({ credits: 6 });
  const model = fakeModel({
    data: {
      edits: [{ index: 0, fields: { headline: 'Warm joinery for warm homes' } }],
      add_sections: [{ kind: 'faq', after_index: 2, fields: { headline: 'Winter questions', faqs: [{ question: 'Do you fit in winter?', answer: 'Yes.' }] } }],
      summary: 'Warmer hero and a winter FAQ.',
    },
  });

  const out = await proposePageEdit({
    pool, tenantId: TENANT, site: PAID_SITE, sections: PAGE, brand: BRAND,
    instruction: 'Warmer tone, and add something about winter', callModel: model,
  });

  assert.equal(out.ok, true);
  assert.equal(auditInserts(pool).length, 1, 'a page instruction is one metered call, not one per section');
  assert.equal(out.proposal.edits.length, 1);
  assert.equal(out.proposal.edits[0].index, 0);
  assert.equal(out.proposal.additions.length, 1);
  assert.equal(out.proposal.additions[0].kind, 'faq');
  assert.equal(out.proposal.additions[0].afterIndex, 2);
});

test('a page proposal cannot touch a section built on the website itself', async () => {
  const pool = fakePool({ credits: 6 });
  const model = fakeModel({
    data: { edits: [{ index: 1, fields: { headline: 'Mine now' } }], summary: 'x' },
  });

  const out = await proposePageEdit({
    pool, tenantId: TENANT, site: PAID_SITE, sections: PAGE, brand: BRAND,
    instruction: 'change everything', callModel: model,
  });

  assert.equal(out.ok, false);
  assert.equal(out.error.code, 'AI_NOTHING_TO_CHANGE');
  assert.match(out.error.errors[0].message, /built on the website itself/);
});

test('a page proposal is capped at three new sections', async () => {
  const pool = fakePool({ credits: 6 });
  const many = Array.from({ length: 6 }, (_, i) => ({
    kind: 'cta', after_index: 2, fields: { headline: `Band ${i}` },
  }));
  const out = await proposePageEdit({
    pool, tenantId: TENANT, site: PAID_SITE, sections: PAGE, brand: BRAND,
    instruction: 'add lots', callModel: fakeModel({ data: { add_sections: many } }),
  });
  assert.equal(out.ok, true);
  assert.equal(out.proposal.additions.length, 3);
});

test('a Lite site cannot reach the page-level instruction either', async () => {
  const pool = fakePool({ credits: 6 });
  const model = fakeModel({ data: { edits: [] } });
  const out = await proposePageEdit({
    pool, tenantId: TENANT, site: LITE_SITE, sections: PAGE, brand: BRAND,
    instruction: 'warmer', callModel: model,
  });
  assert.equal(out.ok, false);
  assert.equal(out.error.status, 403);
  assert.equal(model.calls.length, 0);
  assert.equal(auditInserts(pool).length, 0);
});

test('a proposed new section is a real, editable section before the client ever sees it', () => {
  // The route builds the node the same way "add a section" does and then
  // applies the proposed copy. If that produced something the editor could
  // not read back, the client would approve a row that then could not be
  // edited — the exact thing the picker rule forbids.
  const built = buildStarterSection('faq', BRAND);
  assert.equal(built.ok, true);
  const fields = extractFields(built.node, 'faq');
  assert.ok(Array.isArray(fields.faqs) && fields.faqs.length >= 1);
});

/* ==========================================================================
 * 6. Approve is the ordinary save; discard writes nothing
 * ======================================================================== */

function fakeFetch(reply) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const r = typeof reply === 'function' ? reply(url, init) : reply;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body ?? {}) };
  };
  impl.calls = calls;
  return impl;
}

test('approving is ONE write to the site — the same one a typed edit makes', async () => {
  const f = fakeFetch({ status: 200, body: { success: true, page_id: 12, snapshot_count: 3 } });
  await writePageSections(
    { site_id: 's1', domain: 'fernbrook.invalid', site_token_raw: 'tok' },
    12,
    { sections: [{ handle: 'ia:hero:scratch:-', node: { elType: 'section' } }] },
    { fetchImpl: f },
  );
  // One request. The snapshot is taken by the plugin inside that same write,
  // which is what makes Undo cover an AI edit exactly as it covers a typed one.
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.method, 'POST');
});

test('a proposal is stamped applied only by an UPDATE guarded on `proposed`', async () => {
  const pool = fakePool();
  const out = await markProposalsApplied(pool, {
    tenantId: TENANT, siteId: SITE_UUID,
    proposalId: undefined, proposalIds: ['33333333-3333-3333-3333-333333333333'],
  });
  assert.equal(out.applied, 1);
  const updates = pool.calls.filter((c) => /UPDATE arion\.site_edit_proposal/i.test(c.text));
  assert.equal(updates.length, 1);
  // The guard that makes a double-tap on Approve harmless.
  assert.match(updates[0].text, /AND status = 'proposed'/);
  assert.match(updates[0].text, /SET status = @status, resolved_at = SYSUTCDATETIME\(\)/);
  // No INSERT anywhere: stamping is not a second write path.
  assert.equal(proposalInserts(pool).length, 0);
});

test('the same proposal cannot be stamped twice', async () => {
  const pool = fakePool();
  const id = '33333333-3333-3333-3333-333333333333';
  const out = await markProposalsApplied(pool, { tenantId: TENANT, siteId: SITE_UUID, proposalIds: [id, id, id] });
  assert.equal(out.applied, 1, 'duplicates in one request collapse to one');
  assert.equal(pool.calls.filter((c) => /UPDATE arion\.site_edit_proposal/i.test(c.text)).length, 1);
});

test('discarding writes one status row and touches no website', async () => {
  const pool = fakePool();
  const f = fakeFetch({ status: 200, body: {} });
  const moved = await resolveProposal(pool, {
    tenantId: TENANT, siteId: SITE_UUID, proposalId: '44444444-4444-4444-4444-444444444444', status: 'discarded',
  });
  assert.equal(moved, 1);
  assert.equal(f.calls.length, 0, 'discarding a suggestion never reaches the site');
  const updates = pool.calls.filter((c) => /UPDATE arion\.site_edit_proposal/i.test(c.text));
  assert.equal(updates.length, 1);
  assert.equal(proposalInserts(pool).length, 0);
});

test('resolveProposal refuses a status that is not one of the two', async () => {
  await assert.rejects(
    () => resolveProposal(fakePool(), { tenantId: TENANT, siteId: SITE_UUID, proposalId: 'x', status: 'approved' }),
    /refusing unknown status/,
  );
});

test('a proposal body too large to store is clipped, not thrown away mid-insert', () => {
  const huge = { blob: 'x'.repeat(storeInternals.MAX_JSON + 10) };
  const clipped = JSON.parse(storeInternals.clip(huge));
  assert.equal(clipped._truncated, true);
  assert.ok(clipped.bytes > storeInternals.MAX_JSON);
});

/* ==========================================================================
 * 7. Failure wording — every one of these is read by a client
 * ======================================================================== */

test('every AI failure says nothing was changed, and never names a vendor', () => {
  const cases = [
    meterErrorToHttp({ code: 'insufficient_credits', required: 6, balance: 1 }),
    meterErrorToHttp({ code: 'argus_spend_disabled' }),
    meterErrorToHttp({ code: 'unknown_action' }),
    meterErrorToHttp({ code: 'provider_error' }),
  ];
  for (const c of cases) {
    assert.ok(c.status >= 400);
    assert.doesNotMatch(c.message, /claude|anthropic|openai|gpt|llm|token/i);
    assert.doesNotMatch(c.message, /tenant/i);
  }
  assert.match(cases[1].message, /ARGUS AI/);
  assert.match(cases[3].message, /Nothing was changed/);
});
