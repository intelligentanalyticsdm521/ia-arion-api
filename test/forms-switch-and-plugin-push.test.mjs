/**
 * The website forms switch ("Send this form to my SPARK inbox") and what the
 * IA plugin is told about the subscription (11 Oct 2026).
 *
 * Runs the REAL routes in routes/arion/forms.js with the database and the
 * website stubbed. The database stub runs the route's own MERGE text: it reads
 * the UPDATE SET list and the INSERT list out of the SQL the route sends and
 * applies them to an in-memory row, so a statement that writes NULL over a
 * column the body did not name fails here exactly as it would in SQL Server.
 *
 *   - POST /config with only { form_id, is_active } flips the switch and keeps
 *     the form's tags, list, field map, opt-in, name and type.
 *   - GET /seen: one row per form, its switch OFF until a config row says on.
 *   - every save pushes ia_spark_capture (true only for SPARK decided owned AND
 *     at least one form switched on) and ia_tier (the ARION tier the business
 *     pays for; absent when the subscription names none).
 *   - the daily tick asks the subscription once per business.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import formsRouter, { formsDeps, configWrite, bitFrom, publicSeenForm, SEEN_FORMS_SQL } from '../routes/arion/forms.js';
import {
  pushSiteSubscriptionConfig, subscriptionConfigBody, pluginTierFrom, sparkCaptureFrom,
  runSubscriptionConfigTick, syncSubscriptionConfigSoon, subscriptionPushed,
} from '../lib/websiteBuilder/subscriptionConfig.js';
import { pushSubscriptionConfig } from '../lib/websiteBuilder/pageClient.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const SITE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SITE_ROW = { site_id: SITE, tenant_id: TENANT, domain: 'example.test', site_token_raw: 'tok' };

/* ── the subscription answers ──────────────────────────────────────────── */

const node = (owned, tier = null, decided = true) => ({ owned, tier, decided });
const payloadOf = ({ arion = node(true, 'pro'), spark = node(true, 'pro') } = {}) =>
  ({ tenant_id: TENANT, decided: true, products: { arion, spark } });

/* ── a database that runs the route's own MERGE ────────────────────────── */

function splitTop(list) {
  return list.split(',').map((s) => s.trim()).filter(Boolean);
}

function evalExpr(expr, inputs, row) {
  const e = expr.trim();
  let m = /^CASE WHEN @(\w+) = 1 THEN @(\w+) ELSE target\.(\w+) END$/.exec(e);
  if (m) return Number(inputs[m[1]]) === 1 ? inputs[m[2]] : row[m[3]];
  m = /^@(\w+)$/.exec(e);
  if (m) {
    assert.ok(Object.prototype.hasOwnProperty.call(inputs, m[1]), `the route never set @${m[1]}`);
    return inputs[m[1]];
  }
  if (e === 'SYSDATETIMEOFFSET()') return 'now';
  throw new Error(`the test database does not understand: ${e}`);
}

function fakeDb({ configs = [], site = SITE_ROW, seenRows = [], sites = [] } = {}) {
  const queries = [];
  const request = () => {
    const inputs = {};
    const r = {
      input(name, _type, value) { inputs[name] = value; return r; },
      async query(text) {
        const q = String(text);
        queries.push({ q, inputs: { ...inputs } });
        if (/MERGE arion\.site_form_config/.test(q)) {
          const hit = configs.find((c) => c.tenant_id === inputs.tenantId && c.site_id === inputs.siteId && c.form_id === inputs.formId);
          if (hit) {
            const set = /UPDATE SET([\s\S]*?)WHEN NOT MATCHED/.exec(q)[1];
            const next = { ...hit };
            for (const part of splitTop(set)) {
              const [col, ...rest] = part.split('=');
              next[col.trim()] = evalExpr(rest.join('='), inputs, hit);
            }
            Object.assign(hit, next);
            return { recordset: [{ config_id: hit.config_id, form_type: hit.form_type, is_active: hit.is_active, merge_action: 'UPDATE' }] };
          }
          const cols = splitTop(/INSERT \(([\s\S]*?)\)/.exec(q)[1]);
          const vals = splitTop(/VALUES \(([\s\S]*?)\)\s*OUTPUT/.exec(q)[1].replace(/SYSDATETIMEOFFSET\(\)/g, 'SYSDATETIMEOFFSET'))
            .map((v) => (v === 'SYSDATETIMEOFFSET' ? 'SYSDATETIMEOFFSET()' : v));
          assert.equal(cols.length, vals.length, 'INSERT columns and VALUES line up');
          const row = {};
          cols.forEach((c, i) => { row[c] = evalExpr(vals[i], inputs, {}); });
          configs.push(row);
          return { recordset: [{ config_id: row.config_id, form_type: row.form_type, is_active: row.is_active, merge_action: 'INSERT' }] };
        }
        if (/SELECT TOP 1 \* FROM arion\.site WHERE/.test(q)) return { recordset: site ? [site] : [] };
        if (/COUNT\(\*\) AS active[\s\S]*FROM arion\.site_form_config/.test(q)) {
          const n = configs.filter((c) => c.tenant_id === inputs.tenantId && c.site_id === inputs.siteId && Number(c.is_active) === 1).length;
          return { recordset: [{ active: n }] };
        }
        if (q === SEEN_FORMS_SQL) return { recordset: seenRows };
        if (/FROM arion\.site\b[\s\S]*site_token_raw IS NOT NULL OR/.test(q)) return { recordset: sites };
        return { recordset: [] };
      },
    };
    return r;
  };
  return { request, configs, queries };
}

const OUTCOMES = () => ({
  config_id: 'cfg-1', tenant_id: TENANT, site_id: SITE, form_id: 'contact-7',
  form_name: 'Contact us', form_type: 'newsletter', field_map: '{"your-email":"email"}',
  is_active: 1, apply_tags: '["Newsletter","Website lead"]', add_to_list_id: 42, marketing_optin: 1,
});

/* ── the real routes, served ───────────────────────────────────────────── */

const realDeps = { ...formsDeps };
let server;
let base;
let pushes;
let logs;

function wire(db, { payload = payloadOf(), pluginAnswer } = {}) {
  pushes = [];
  logs = [];
  formsDeps.getServicesPool = async () => db;
  formsDeps.pushSiteSubscriptionConfig = (pool, site, opts) => pushSiteSubscriptionConfig(pool, site, {
    ...opts,
    getEntitlements: async () => payload,
    log: (m) => logs.push(m),
    push: async (s, body) => {
      pushes.push({ site: s, body });
      return pluginAnswer || { ok: true, status: 200, data: { ...body } };
    },
  });
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/arion/sites/:siteId/forms', (req, _res, next) => { req.tenant = { tenantId: TENANT }; next(); }, formsRouter);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  Object.assign(formsDeps, realDeps);
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => subscriptionPushed.clear());

async function post(body) {
  const res = await fetch(`${base}/arion/sites/${SITE}/forms/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

/* ── the switch never erases the outcomes ──────────────────────────────── */

test('a switch flip ({ form_id, is_active }) turns the form off and keeps every outcome', async () => {
  const db = fakeDb({ configs: [OUTCOMES()] });
  wire(db);
  const r = await post({ form_id: 'contact-7', is_active: false });
  assert.equal(r.status, 200);
  const row = db.configs[0];
  const before = OUTCOMES();
  assert.equal(Number(row.is_active), 0, 'switched off');
  for (const col of ['form_name', 'form_type', 'field_map', 'apply_tags', 'add_to_list_id', 'marketing_optin']) {
    assert.deepEqual(row[col], before[col], `${col} kept`);
  }
  assert.equal(r.body.data.config_id, 'cfg-1', 'the stored row id, not a fresh one');
  assert.equal(r.body.data.is_active, false);
  assert.equal(r.body.data.created, false);
});

test('and back on again, still keeping the outcomes', async () => {
  const start = { ...OUTCOMES(), is_active: 0 };
  const db = fakeDb({ configs: [start] });
  wire(db);
  const r = await post({ form_id: 'contact-7', is_active: true });
  assert.equal(r.status, 200);
  assert.equal(Number(db.configs[0].is_active), 1);
  assert.equal(db.configs[0].apply_tags, OUTCOMES().apply_tags);
  assert.equal(db.configs[0].add_to_list_id, 42);
});

test('a key that IS sent is written, even as null (the outcomes editor can clear a list)', async () => {
  const db = fakeDb({ configs: [OUTCOMES()] });
  wire(db);
  await post({ form_id: 'contact-7', add_to_list_id: null, apply_tags: ['Quote'] });
  assert.equal(db.configs[0].add_to_list_id, null);
  assert.equal(db.configs[0].apply_tags, '["Quote"]');
  assert.equal(Number(db.configs[0].is_active), 1, 'is_active not sent -> kept');
  assert.equal(db.configs[0].form_type, 'newsletter', 'form_type not sent -> kept');
});

test('a new form saved with only { form_id, is_active } takes the old defaults', async () => {
  const db = fakeDb();
  wire(db);
  const r = await post({ form_id: 'wpforms-12', is_active: true });
  assert.equal(r.status, 200);
  assert.equal(db.configs.length, 1);
  assert.equal(db.configs[0].form_type, 'contact');
  assert.equal(Number(db.configs[0].is_active), 1);
  assert.equal(db.configs[0].apply_tags, null);
  assert.equal(r.body.data.created, true);
  assert.equal(r.body.data.config_id, db.configs[0].config_id);
});

test('is_active 0 is OFF (the old route read anything but false as on)', async () => {
  const db = fakeDb();
  wire(db);
  await post({ form_id: 'f-0', is_active: 0 });
  assert.equal(Number(db.configs[0].is_active), 0);
});

test('is_active that is not a yes or a no is refused, and nothing is written', async () => {
  const db = fakeDb();
  wire(db);
  const r = await post({ form_id: 'f-1', is_active: 'maybe' });
  assert.equal(r.status, 400);
  assert.equal(db.configs.length, 0);
});

test('configWrite: a switch-only body sets is_active and nothing else', () => {
  const w = configWrite({ form_id: 'x', is_active: false });
  assert.equal(w.setIsActive, true);
  assert.equal(w.isActive, 0);
  for (const flag of ['setFormName', 'setFormType', 'setFieldMap', 'setApplyTags', 'setAddToList', 'setMarketingOptin']) {
    assert.equal(w[flag], false, flag);
  }
  assert.equal(bitFrom('true'), true);
  assert.equal(bitFrom('false'), false);
  assert.equal(bitFrom('yes'), null);
});

/* ── every save tells the website ──────────────────────────────────────── */

test('SPARK owned and a form switched on -> ia_spark_capture true, with the ARION tier', async () => {
  const db = fakeDb();
  wire(db, { payload: payloadOf({ arion: node(true, 'pro') }) });
  const r = await post({ form_id: 'contact-7', is_active: true });
  assert.equal(pushes.length, 1, 'one push per save');
  assert.deepEqual(pushes[0].body, { ia_spark_capture: true, ia_tier: 'pro' });
  assert.equal(pushes[0].site.site_id, SITE);
  assert.equal(r.body.data.website.pushed, true);
  assert.equal(r.body.data.website.spark_capture, true);
  assert.equal(r.body.data.website.tier, 'pro');
});

test('SPARK NOT in the subscription -> ia_spark_capture false even with the form switched on', async () => {
  const db = fakeDb();
  wire(db, { payload: payloadOf({ spark: node(false) }) });
  const r = await post({ form_id: 'contact-7', is_active: true });
  assert.equal(pushes[0].body.ia_spark_capture, false);
  assert.equal(r.body.data.website.capture_reason, 'spark_not_owned');
});

test('SPARK undecided (platform-api could not say) -> false, never true', async () => {
  for (const payload of [payloadOf({ spark: node(true, 'pro', false) }), null]) {
    const db = fakeDb();
    wire(db, { payload });
    await post({ form_id: 'contact-7', is_active: true });
    assert.equal(pushes[0].body.ia_spark_capture, false);
  }
});

test('SPARK owned but the last form switched off -> capture stays ON (SPARK features follow SPARK, the form rule lives server-side)', async () => {
  const db = fakeDb({ configs: [OUTCOMES()] });
  wire(db);
  const r = await post({ form_id: 'contact-7', is_active: false });
  assert.equal(pushes[0].body.ia_spark_capture, true);
  assert.equal(r.body.data.website.capture_reason, 'on_no_form_switched_on_yet');
});

test('a downgrade reaches the site: ARION lite is pushed even when the site held pro', async () => {
  const db = fakeDb({ site: { ...SITE_ROW, arion_tier: 'pro' } });
  wire(db, { payload: payloadOf({ arion: node(true, 'lite') }) });
  await post({ form_id: 'contact-7', is_active: true });
  assert.equal(pushes[0].body.ia_tier, 'lite');
});

test('ARION owned with no tier -> nothing pushed for the tier, and it is logged', async () => {
  const db = fakeDb();
  wire(db, { payload: payloadOf({ arion: node(true, null) }) });
  const r = await post({ form_id: 'contact-7', is_active: true });
  assert.equal(Object.prototype.hasOwnProperty.call(pushes[0].body, 'ia_tier'), false);
  assert.equal(r.body.data.website.tier_reason, 'arion_tier_missing');
  assert.ok(logs.some((l) => /ia_tier not pushed \(arion_tier_missing\)/.test(l)), logs.join('\n'));
});

test('ARION not owned -> no tier and no capture', async () => {
  const db = fakeDb();
  wire(db, { payload: payloadOf({ arion: node(false) }) });
  await post({ form_id: 'contact-7', is_active: true });
  assert.deepEqual(pushes[0].body, { ia_spark_capture: false });
});

test('a plugin without the route (404) or no site row never costs the save', async () => {
  let db = fakeDb();
  wire(db, { pluginAnswer: { ok: false, status: 404, error: 'not_found' } });
  let r = await post({ form_id: 'contact-7', is_active: true });
  assert.equal(r.status, 200);
  assert.equal(db.configs.length, 1, 'saved');
  assert.equal(r.body.data.website.outcome, 'plugin_too_old');

  db = fakeDb({ site: null });
  wire(db);
  r = await post({ form_id: 'contact-7', is_active: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.website.outcome, 'site_not_found');
  assert.equal(pushes.length, 0);
});

test('a plugin that reads back a different value is "not_held", not ok', async () => {
  const db = fakeDb();
  wire(db, { pluginAnswer: { ok: true, status: 200, data: { ia_spark_capture: false, ia_tier: 'pro' } } });
  const r = await post({ form_id: 'contact-7', is_active: true });
  assert.equal(r.body.data.website.outcome, 'not_held');
  assert.equal(r.body.data.website.pushed, false);
});

/* ── the pure decision ─────────────────────────────────────────────────── */

test('pluginTierFrom / sparkCaptureFrom / subscriptionConfigBody', () => {
  assert.deepEqual(pluginTierFrom(payloadOf({ arion: node(true, 'Business') })), { tier: 'business', reason: 'arion_tier' });
  assert.deepEqual(pluginTierFrom(payloadOf({ arion: node(true, 'enterprise') })), { tier: 'business', reason: 'arion_tier' });
  assert.deepEqual(pluginTierFrom(payloadOf({ arion: node(true, 'platinum') })), { tier: null, reason: 'arion_tier_missing' });
  assert.deepEqual(pluginTierFrom(payloadOf({ arion: node(true, 'pro', false) })), { tier: null, reason: 'arion_undecided' });
  assert.deepEqual(pluginTierFrom(null), { tier: null, reason: 'arion_undecided' });
  assert.deepEqual(pluginTierFrom(payloadOf({ arion: node(false, 'pro') })), { tier: null, reason: 'arion_not_owned' },
    'a tier word left on a node ARION is not owned for is never pushed');
  assert.equal(sparkCaptureFrom(payloadOf(), 2).capture, true);
  assert.equal(sparkCaptureFrom(payloadOf(), 0).capture, true, 'SPARK owned with no form switched on yet still keeps its SPARK features on the site');
  assert.equal(sparkCaptureFrom(payloadOf(), 0).reason, 'on_no_form_switched_on_yet');
  assert.equal(sparkCaptureFrom(payloadOf({ spark: node(false) }), 2).capture, false);
  assert.equal(sparkCaptureFrom(payloadOf({ arion: node(false) }), 2).capture, false);
  assert.equal(sparkCaptureFrom(payloadOf({ arion: node(true, 'pro', false) }), 2).capture, true,
    'ARION undecided does not take SPARK capture away');
  assert.deepEqual(subscriptionConfigBody({ payload: payloadOf({ arion: node(true, 'standard') }), activeForms: 1 }).body,
    { ia_spark_capture: true, ia_tier: 'standard' });
});

/* ── GET /seen ─────────────────────────────────────────────────────────── */

test('GET /seen: one row per form, the switch OFF until a config row says on', async () => {
  const seenRows = [
    { form_id: 'contact-7', form_type: 'contact', form_name: 'Contact us', submissions: 12, last_submitted_at: '2026-10-10T12:00:00Z', config_id: 'cfg-1', is_active: true },
    { form_id: 'wpforms-12', form_type: 'quote', form_name: null, submissions: 3, last_submitted_at: '2026-10-09T12:00:00Z', config_id: null, is_active: null },
    { form_id: null, form_type: 'contact', form_name: null, submissions: 1, last_submitted_at: '2026-10-01T12:00:00Z', config_id: null, is_active: null },
    { form_id: 'newsletter-1', form_type: 'newsletter', form_name: 'Newsletter', submissions: 0, last_submitted_at: null, config_id: 'cfg-2', is_active: false },
  ];
  const db = fakeDb({ seenRows });
  wire(db);
  const res = await fetch(`${base}/arion/sites/${SITE}/forms/seen`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.length, 4);
  assert.deepEqual(body.data.map((f) => f.is_active), [true, false, false, false]);
  assert.deepEqual(body.data.map((f) => f.can_switch), [true, true, false, true]);
  assert.equal(body.data[0].submissions, 12);
  assert.equal(body.data[3].config_id, 'cfg-2');
  const q = db.queries.find((x) => x.q === SEEN_FORMS_SQL);
  assert.ok(q, 'the route ran the seen-forms query');
  assert.equal(q.inputs.tenantId, TENANT);
  assert.equal(q.inputs.siteId, SITE);
  assert.match(SEEN_FORMS_SQL, /FULL OUTER JOIN cfg/, 'a form set up before its first submission is listed too');
  assert.match(SEEN_FORMS_SQL, /tenant_id = @tenantId AND site_id = @siteId[\s\S]*tenant_id = @tenantId AND site_id = @siteId/,
    'both sources are read for this business and this site only');
  assert.deepEqual(publicSeenForm({ form_id: 'x', config_id: 'c', is_active: 1 }).is_active, true);
});

test('GET /forms (submissions) and GET /config still answer as before', async () => {
  const db = fakeDb();
  db.request = ((orig) => () => {
    const r = orig();
    const q = r.query;
    r.query = async (text) => (/COUNT\(\*\) AS total/.test(text) ? { recordset: [{ total: 0 }] } : q(text));
    return r;
  })(db.request);
  wire(db);
  const a = await fetch(`${base}/arion/sites/${SITE}/forms`);
  assert.equal(a.status, 200);
  assert.deepEqual((await a.json()).meta, { total: 0, page: 1, per_page: 25 });
  const b = await fetch(`${base}/arion/sites/${SITE}/forms/config`);
  assert.equal(b.status, 200);
});

/* ── the settings screen and the daily tick ────────────────────────────── */

test('the settings-screen push fires once per ten minutes per site', () => {
  const calls = [];
  const deps = { payload: payloadOf(), push: async (s, body) => { calls.push(body); return { ok: true, data: body }; }, log: () => {} };
  assert.equal(syncSubscriptionConfigSoon(fakeDb(), SITE_ROW, deps), true);
  assert.equal(syncSubscriptionConfigSoon(fakeDb(), SITE_ROW, deps), false, 'second call inside ten minutes does nothing');
});

test('the daily tick: one subscription answer per business, every connected site pushed', async () => {
  const site2 = { ...SITE_ROW, site_id: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', domain: 'two.example.test' };
  const db = fakeDb({ sites: [SITE_ROW, site2], configs: [OUTCOMES()] });
  let asked = 0;
  const bodies = [];
  const summary = await runSubscriptionConfigTick(db, () => {}, {
    getEntitlements: async () => { asked++; return payloadOf({ arion: node(true, 'lite') }); },
    push: async (s, body) => { bodies.push([s.site_id, body]); return { ok: true, data: body }; },
  });
  assert.equal(asked, 1, 'asked once for the business');
  assert.equal(summary.sites, 2);
  assert.equal(summary.pushed, 2);
  assert.equal(summary.tier_pushed, 2);
  assert.equal(summary.capture_on, 2, 'every site of a business with SPARK captures; the per-form rule is enforced where the inquiry crosses into SPARK');
  assert.deepEqual(bodies[0], [SITE, { ia_spark_capture: true, ia_tier: 'lite' }]);
  assert.deepEqual(bodies[1][1], { ia_spark_capture: true, ia_tier: 'lite' });
});

/* ── the wire ──────────────────────────────────────────────────────────── */

test('pushSubscriptionConfig posts both options to the plugin route with the site token', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, ia_spark_capture: true, ia_tier: 'pro' }) };
  };
  const r = await pushSubscriptionConfig(SITE_ROW, { ia_spark_capture: true, ia_tier: 'pro' }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.match(seen[0].url, /^https:\/\/example\.test\/wp-json\/intelligent-analytics\/v1\/subscription-config\?/);
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers['X-Arion-Site-Token'], 'tok');
  assert.deepEqual(JSON.parse(seen[0].init.body), { ia_spark_capture: true, ia_tier: 'pro' });

  await pushSubscriptionConfig(SITE_ROW, { ia_spark_capture: 'yes' }, { fetchImpl });
  assert.deepEqual(JSON.parse(seen[1].init.body), { ia_spark_capture: false }, 'only a real true is true; no tier key when none');
});

/* ── skeptic pass (11 Oct 2026): holes found after 09bcbdc ─────────────── */

test('a NEW form saved with outcomes only (no is_active) is OFF: saving outcomes never turns SPARK delivery on', async () => {
  const db = fakeDb();
  wire(db);
  const r = await post({ form_id: 'wpforms-30', apply_tags: ['Quote'], add_to_list_id: 7 });
  assert.equal(r.status, 200);
  assert.equal(db.configs.length, 1);
  assert.equal(Number(db.configs[0].is_active), 0, 'off until the business turns it on');
  assert.equal(db.configs[0].apply_tags, '["Quote"]');
  assert.equal(r.body.data.is_active, false);
  assert.equal(pushes[0].body.ia_spark_capture, true, 'the site keeps its SPARK features (SPARK is owned); this form stays off for delivery because its row is off');
  assert.equal(configWrite({ form_id: 'x' }).isActive, 0);
});

test('the row read from GET /config, posted back with is_active flipped, keeps the field map and tags exactly', async () => {
  const db = fakeDb({ configs: [OUTCOMES()] });
  wire(db);
  const echoed = { ...OUTCOMES(), is_active: false };
  delete echoed.tenant_id; delete echoed.site_id;
  const r = await post(echoed);
  assert.equal(r.status, 200);
  const row = db.configs[0];
  assert.equal(Number(row.is_active), 0);
  assert.equal(row.field_map, OUTCOMES().field_map, 'JSON text is stored as the same JSON, not encoded twice');
  assert.equal(row.apply_tags, OUTCOMES().apply_tags, 'JSON text tags are kept, not wiped');
  assert.equal(row.add_to_list_id, 42);
  assert.equal(Number(row.marketing_optin), 1);
});

test('field_map or apply_tags that cannot be read is refused and nothing is written', async () => {
  const db = fakeDb({ configs: [OUTCOMES()] });
  wire(db);
  for (const bad of [{ apply_tags: 'Newsletter' }, { apply_tags: { a: 1 } }, { field_map: 'not json' }, { field_map: [1, 2] }]) {
    const r = await post({ form_id: 'contact-7', is_active: false, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.doesNotMatch(r.body.error.message, /tenant/i);
  }
  assert.deepEqual(db.configs[0], OUTCOMES(), 'the stored row is untouched');
  assert.equal(pushes.length, 0);
});

test('marketing_optin "false" is off, not on', () => {
  assert.equal(configWrite({ form_id: 'x', marketing_optin: 'false' }).marketingOptin, 0);
  assert.equal(configWrite({ form_id: 'x', marketing_optin: true }).marketingOptin, 1);
});

test('a plugin on the first 2.0.3 build (no /subscription-config) still gets both options through /site/options', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    if (/\/subscription-config\?/.test(url)) return { ok: false, status: 404, text: async () => '{"code":"rest_no_route"}' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, tier: 'lite', spark_capture: false, plugin_version: '2.0.3' }) };
  };
  const r = await pushSubscriptionConfig(SITE_ROW, { ia_spark_capture: false, ia_tier: 'lite' }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.via, 'site/options');
  assert.match(seen[1].url, /\/wp-json\/intelligent-analytics\/v1\/site\/options\?/);
  assert.deepEqual(seen[1].body, { ia_spark_capture: false, ia_tier: 'lite' });
  assert.equal(r.data.ia_spark_capture, false, 'spark_capture read back under the /subscription-config name');
  assert.equal(r.data.ia_tier, 'lite');

  // And through the real decision: a site that read back a different capture is not_held.
  const db = fakeDb({ configs: [OUTCOMES()] });
  const lying = async (url) => (/\/subscription-config\?/.test(url)
    ? { ok: false, status: 404, text: async () => '' }
    : { ok: true, status: 200, text: async () => JSON.stringify({ tier: 'pro', spark_capture: false }) });
  const out = await pushSiteSubscriptionConfig(db, SITE_ROW, {
    payload: payloadOf(), log: () => {},
    push: (s, body, o) => pushSubscriptionConfig(s, body, { ...o, fetchImpl: lying }),
  });
  assert.deepEqual(out.body, { ia_spark_capture: true, ia_tier: 'pro' });
  assert.equal(out.outcome, 'not_held');
});

test('a plugin older than 2.0.3 (refuses both routes) is plugin_too_old, not a fault', async () => {
  for (const second of [
    { ok: false, status: 404, text: async () => '' },
    { ok: false, status: 400, text: async () => JSON.stringify({ error: 'We do not set "ia_spark_capture" on your website.', code: 'not_in_whitelist' }) },
  ]) {
    const fetchImpl = async (url) => (/\/subscription-config\?/.test(url) ? { ok: false, status: 404, text: async () => '' } : second);
    const db = fakeDb();
    const logged = [];
    const out = await pushSiteSubscriptionConfig(db, SITE_ROW, {
      payload: payloadOf(), log: (m) => logged.push(m),
      push: (s, body, o) => pushSubscriptionConfig(s, body, { ...o, fetchImpl }),
    });
    assert.equal(out.outcome, 'plugin_too_old');
    assert.ok(!logged.some((l) => /push /.test(l)), logged.join('\n'));
  }
});

test('the delete routes never say "tenant" to a business', async () => {
  const app = express();
  app.use(express.json());
  app.use('/arion/sites/:siteId/forms', (req, _res, next) => { req.tenant = {}; next(); }, formsRouter);
  const srv = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const at = `http://127.0.0.1:${srv.address().port}/arion/sites/${SITE}/forms`;
    const a = await fetch(`${at}/submissions/abc`, { method: 'DELETE' });
    const b = await fetch(`${at}/submissions/bulk-delete`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ids":["a"]}' });
    for (const res of [a, b]) {
      assert.equal(res.status, 401);
      const text = await res.text();
      assert.doesNotMatch(text, /tenant/i, text);
      assert.match(text, /which business/);
    }
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});
