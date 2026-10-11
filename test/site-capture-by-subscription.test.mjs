/**
 * Website capture follows the subscription (Brandon, 11 Oct 2026).
 *
 * Runs the REAL routes in routes/submit.js (forms, bookings, site events, the
 * beacon) through express, with the database, platform-api, the SPARK contact
 * writer and the event writer stubbed through `submitDeps`. For each route:
 *
 *   ARION decided not owned  -> 403 arion_not_enabled, nothing written
 *                               (the beacon answers ok and stores nothing)
 *   SPARK decided not owned  -> ARION record + event written, NO SPARK row
 *   SPARK undecided          -> ARION record + event written, NO SPARK row (held)
 *   SPARK owned, form not set up (no active site_form_config row) -> NO SPARK row
 *   SPARK owned + form set up -> works as before: contact, activity, tags,
 *                               list and opt-in written
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import sql from 'mssql';

import submitRouter, { submitDeps } from '../routes/submit.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const SITE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CONTACT_UUID = '99999999-8888-7777-6666-555555555555';

const real = { ...submitDeps };
let server;
let base;
let state;

/* ── the stubs ─────────────────────────────────────────────────────────── */

function payloadFor({ arion = true, spark = true, sparkDecided = true, arionDecided = true } = {}) {
  return {
    tenant_id: TENANT,
    decided: sparkDecided && arionDecided,
    products: {
      arion: { owned: arion, tier: arion ? 'pro' : null, decided: arionDecided },
      spark: { owned: spark, tier: spark ? 'standard' : null, decided: sparkDecided },
      oliver: { owned: false, tier: null, decided: true },
    },
  };
}

function recorder(kind) {
  const r = {
    input() { return r; },
    async query(text) {
      state.sql.push({ kind, text: String(text) });
      if (/FROM arion\.site_form_config/.test(text)) return { recordset: state.formConfig ? [state.formConfig] : [] };
      if (/SELECT tenant_id FROM arion\.site WHERE site_id/.test(text)) return { recordset: [{ tenant_id: TENANT }] };
      return { recordset: [], rowsAffected: [1] };
    },
  };
  return r;
}

const fakeTx = {
  async begin() { state.tx.push('begin'); },
  async commit() { state.tx.push('commit'); },
  async rollback() { state.tx.push('rollback'); },
  request() { return recorder('tx'); },
};
const fakePool = {
  request() { return recorder('pool'); },
  transaction() { return fakeTx; },
};

// The activity / tag / list / opt-in writes use `new sql.Request(transaction)`;
// record what they would have run instead of opening a connection.
const realQuery = sql.Request.prototype.query;

before(async () => {
  sql.Request.prototype.query = async function query(text) {
    state.sql.push({ kind: 'sqlRequest', text: String(text) });
    return { recordset: [], rowsAffected: [1] };
  };
  submitDeps.getServicesPool = async () => fakePool;
  submitDeps.requireSiteToken = (req, _res, next) => {
    req.site = { site_id: SITE, tenant_id: TENANT, arion_tier: 'pro', domain: 'example.test' };
    req.tenant = { tenantId: TENANT };
    next();
  };
  submitDeps.getEntitlements = async () => state.payload;
  submitDeps.upsertSparkContact = async (_tx, args) => { state.upserts.push(args); return CONTACT_UUID; };
  submitDeps.firePlatformEvent = async (_tx, evt) => { state.events.push(evt); return 'evt-1'; };

  const app = express();
  app.use(express.json());
  app.use('/', submitRouter);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  sql.Request.prototype.query = realQuery;
  Object.assign(submitDeps, real);
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  state = { payload: payloadFor(), formConfig: null, sql: [], tx: [], upserts: [], events: [] };
});

const ACTIVE_CONFIG = { form_type: 'quote', apply_tags: '["Quote request"]', add_to_list_id: 7, marketing_optin: 1 };

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const sparkSql = () => state.sql.filter((s) => /lumen\./.test(s.text));
const wrote = (re) => state.sql.some((s) => re.test(s.text));

const FORM = { form_id: 'contact-1', email: 'pat@example.test', first_name: 'Pat', last_name: 'Lee', message: 'Hi' };
const BOOKING = { form_id: 'book-1', email: 'pat@example.test', first_name: 'Pat', service_type: 'Lawn', address_line_1: '1 Main St' };
const SITE_EVENT = { event_type: 'form.submitted', form_id: 'contact-1', email: 'pat@example.test', first_name: 'Pat' };

/* ── /forms/submit ─────────────────────────────────────────────────────── */

test('forms: ARION not in the subscription -> 403 arion_not_enabled and nothing is written', async () => {
  state.payload = payloadFor({ arion: false });
  state.formConfig = ACTIVE_CONFIG;
  const r = await post('/forms/submit', FORM);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'arion_not_enabled');
  assert.match(r.body.message, /ARION is not in this business's subscription/);
  assert.equal(state.sql.length, 0, 'no SQL at all');
  assert.equal(state.events.length, 0);
  assert.equal(state.upserts.length, 0);
});

test('forms: SPARK not in the subscription -> the ARION record and the event, no SPARK row of any kind', async () => {
  state.payload = payloadFor({ spark: false });
  state.formConfig = ACTIVE_CONFIG; // switched on, but SPARK is not owned
  const r = await post('/forms/submit', FORM);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.spark_capture, 'spark_not_owned');
  assert.ok(wrote(/INSERT INTO arion\.site_form_submission/), 'ARION keeps its own record');
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].eventType, 'arion.form.submitted');
  assert.equal(state.events[0].payload.spark_capture, 'spark_not_owned');
  assert.equal(state.upserts.length, 0, 'no SPARK contact');
  assert.deepEqual(sparkSql(), [], 'no lumen.* write (activity, tags, list, opt-in)');
  assert.deepEqual(state.tx, ['begin', 'commit']);
});

test('forms: SPARK undecided -> held: ARION record and event written, nothing sent to SPARK', async () => {
  state.payload = payloadFor({ sparkDecided: false });
  state.formConfig = ACTIVE_CONFIG;
  const r = await post('/forms/submit', FORM);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.spark_capture, 'held');
  assert.ok(wrote(/INSERT INTO arion\.site_form_submission/));
  assert.equal(state.events.length, 1, 'the event still queues for the processor');
  assert.equal(state.upserts.length, 0);
  assert.deepEqual(sparkSql(), []);
});

test('forms: platform-api unreachable -> ARION collects as before, SPARK held', async () => {
  state.payload = null;
  state.formConfig = ACTIVE_CONFIG;
  const r = await post('/forms/submit', FORM);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.spark_capture, 'held');
  assert.equal(state.upserts.length, 0);
  assert.ok(wrote(/INSERT INTO arion\.site_form_submission/));
});

test('forms: SPARK owned but this form is not set up (no active config row) -> no SPARK row', async () => {
  state.formConfig = null;
  const r = await post('/forms/submit', FORM);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.spark_capture, 'form_not_set_up');
  assert.equal(state.upserts.length, 0);
  assert.deepEqual(sparkSql(), []);
  assert.ok(wrote(/INSERT INTO arion\.site_form_submission/));
});

test('forms: SPARK owned and the form set up -> works as before (contact, activity, tags, list, opt-in)', async () => {
  state.formConfig = ACTIVE_CONFIG;
  const r = await post('/forms/submit', FORM);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.spark_capture, 'on');
  assert.equal(state.upserts.length, 1);
  assert.equal(state.upserts[0].source, 'arion_form');
  assert.equal(state.upserts[0].email, 'pat@example.test');
  assert.ok(wrote(/INSERT INTO lumen\.contact_activity/), 'activity');
  assert.ok(wrote(/MERGE lumen\.tag/), 'tags');
  assert.ok(wrote(/INSERT INTO lumen\.list_contact/), 'list');
  assert.ok(wrote(/SET c\.marketing_optin = 1/), 'opt-in');
  assert.equal(state.events[0].payload.spark_capture, 'on');
  assert.equal(state.events[0].payload.form_type, 'quote', 'the config still names the form type');
});

/* ── /bookings/submit ──────────────────────────────────────────────────── */

test('bookings: ARION not in the subscription -> 403 and nothing written', async () => {
  state.payload = payloadFor({ arion: false });
  const r = await post('/bookings/submit', BOOKING);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'arion_not_enabled');
  assert.equal(state.sql.length, 0);
  assert.equal(state.events.length, 0);
});

test('bookings: SPARK not in the subscription -> the booking request and event, no SPARK contact', async () => {
  state.payload = payloadFor({ spark: false });
  state.formConfig = ACTIVE_CONFIG;
  const r = await post('/bookings/submit', BOOKING);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.spark_capture, 'spark_not_owned');
  assert.ok(wrote(/INSERT INTO arion\.site_booking_request/));
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].eventType, 'arion.booking.requested');
  assert.equal(state.upserts.length, 0);
});

test('bookings: SPARK undecided -> held, no SPARK contact', async () => {
  state.payload = payloadFor({ sparkDecided: false });
  state.formConfig = ACTIVE_CONFIG;
  const r = await post('/bookings/submit', BOOKING);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.spark_capture, 'held');
  assert.equal(state.upserts.length, 0);
  assert.equal(state.events.length, 1);
});

test('bookings: SPARK owned, booking form not set up -> no SPARK contact', async () => {
  const r = await post('/bookings/submit', BOOKING);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.spark_capture, 'form_not_set_up');
  assert.equal(state.upserts.length, 0);
});

test('bookings: SPARK owned and the booking form set up -> the SPARK contact with the address, as before', async () => {
  state.formConfig = ACTIVE_CONFIG;
  const r = await post('/bookings/submit', BOOKING);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.spark_capture, 'on');
  assert.equal(state.upserts.length, 1);
  assert.equal(state.upserts[0].source, 'arion_booking');
  assert.equal(state.upserts[0].addressStreet, '1 Main St');
});

/* ── /webhooks/site-event ──────────────────────────────────────────────── */

test('site event: ARION not in the subscription -> 403 and nothing written', async () => {
  state.payload = payloadFor({ arion: false });
  const r = await post('/webhooks/site-event', { event_type: 'plugin.updated', plugin_name: 'x' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'arion_not_enabled');
  assert.equal(state.sql.length, 0);
  assert.equal(state.events.length, 0);
});

test('site event: a form event without SPARK -> the submission and event, no SPARK contact', async () => {
  state.payload = payloadFor({ spark: false });
  state.formConfig = ACTIVE_CONFIG;
  const r = await post('/webhooks/site-event', SITE_EVENT);
  assert.equal(r.status, 200);
  assert.ok(wrote(/INSERT INTO arion\.site_form_submission/));
  assert.equal(state.upserts.length, 0);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].payload.spark_capture, 'spark_not_owned');
});

test('site event: SPARK undecided -> held, the event still queues', async () => {
  state.payload = payloadFor({ sparkDecided: false });
  state.formConfig = ACTIVE_CONFIG;
  const r = await post('/webhooks/site-event', SITE_EVENT);
  assert.equal(r.status, 200);
  assert.equal(state.upserts.length, 0);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].payload.spark_capture, 'held');
});

test('site event: SPARK owned and the form set up -> the SPARK contact, as before', async () => {
  state.formConfig = ACTIVE_CONFIG;
  const r = await post('/webhooks/site-event', SITE_EVENT);
  assert.equal(r.status, 200);
  assert.equal(state.upserts.length, 1);
  assert.equal(state.events[0].payload.spark_capture, 'on');
});

test('site event: a non-form event is untouched by the SPARK rule', async () => {
  state.payload = payloadFor({ spark: false });
  const r = await post('/webhooks/site-event', { event_type: 'plugin.updated', plugin_name: 'Akismet' });
  assert.equal(r.status, 200);
  assert.ok(wrote(/INSERT INTO arion\.site_security_event/));
  assert.equal(state.events.length, 1);
  assert.equal(state.upserts.length, 0);
});

/* ── /webhooks/beacon ──────────────────────────────────────────────────── */

test('beacon: ARION not in the subscription -> ok, nothing stored', async () => {
  state.payload = payloadFor({ arion: false });
  const r = await post('/webhooks/beacon', { site_id: SITE, page_url: 'https://example.test/' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.stored, false);
  assert.equal(wrote(/INSERT INTO arion\.site_page_view/), false);
});

test('beacon: ARION owned -> the page view is stored', async () => {
  const r = await post('/webhooks/beacon', { site_id: SITE, page_url: 'https://example.test/' });
  assert.equal(r.status, 200);
  assert.ok(wrote(/INSERT INTO arion\.site_page_view/));
});

test('beacon: ARION undecided -> stored as before', async () => {
  state.payload = null;
  const r = await post('/webhooks/beacon', { site_id: SITE, page_url: 'https://example.test/' });
  assert.equal(r.status, 200);
  assert.ok(wrote(/INSERT INTO arion\.site_page_view/));
});
