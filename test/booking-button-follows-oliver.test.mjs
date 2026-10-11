/**
 * The website's "Book now" button follows the OLIVER subscription
 * (FEATURES row 17, 11 Oct 2026).
 *
 * Runs the real code with the database, platform-api and the plugin stubbed:
 *   - brandContext.resolveBookingTarget: OLIVER decided not owned -> decided ''
 *     (the button comes off); undecided -> NOT decided (nothing is pushed);
 *     owned with an active booking page -> the address, as before.
 *   - lib/bookingButtonSync.runBookingButtonSyncTick (the daily push):
 *     pushes '' when OLIVER ended, pushes the address when owned, pushes
 *     nothing when undecided.
 *   - routes/arion/pages.js syncBookingButton (the editor-open push): an
 *     undecided answer is not pushed.
 *   - routes/submit.js /public/provision-codes/redeem (the provisioning push):
 *     booking_url '' when OLIVER is not owned, absent when undecided (the plugin
 *     keeps what it had), the address when owned.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { resolveBookingTarget, BOOKING_WORDS } from '../lib/websiteBuilder/brandContext.js';
import { runBookingButtonSyncTick } from '../lib/bookingButtonSync.js';
import { __test__ as pagesInternals } from '../routes/arion/pages.js';
import submitRouter, { submitDeps } from '../routes/submit.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const SITE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const oliver = (owned, decided = true) => async () => ({
  tenant_id: TENANT, decided,
  products: { oliver: { owned, tier: owned ? 'pro' : null, decided }, arion: { owned: true, decided: true } },
});
const unreachable = async () => null;

function fakePool({ hasPage = true, sites = [] } = {}) {
  const calls = [];
  const request = () => {
    const r = {
      input() { return r; },
      async query(text) {
        calls.push(String(text));
        if (/FROM oliver\.booking_page/.test(text)) return { recordset: hasPage ? [{ has_page: 1 }] : [] };
        if (/FROM arion\.site\b[\s\S]*site_token_raw IS NOT NULL OR/.test(text)) return { recordset: sites };
        if (/UPDATE arion\.site[\s\S]*OUTPUT inserted\.site_id/.test(text)) return { recordset: [{ site_id: SITE, tenant_id: TENANT, arion_tier: 'pro', domain: null }] };
        return { recordset: [] };
      },
    };
    return r;
  };
  return { request, calls };
}

const slug = async () => 'fernbrook';

/* ── the decision ──────────────────────────────────────────────────────── */

test('OLIVER not in the subscription -> decided, no address, the reason names OLIVER', async () => {
  const pool = fakePool();
  const t = await resolveBookingTarget(pool, TENANT, { getEntitlements: oliver(false), tenantSlug: slug });
  assert.deepEqual(t, { decided: true, href: '', reason: BOOKING_WORDS.OLIVER_OFF });
  assert.match(t.reason, /OLIVER is not in this business's subscription/);
  assert.equal(pool.calls.length, 0, 'no booking-page read for a business without OLIVER');
});

test('OLIVER undecided (node or platform-api) -> NOT decided, so nothing may be pushed', async () => {
  for (const getEntitlements of [oliver(true, false), unreachable]) {
    const t = await resolveBookingTarget(fakePool(), TENANT, { getEntitlements, tenantSlug: slug });
    assert.equal(t.decided, false);
    assert.equal(t.href, '');
  }
});

test('OLIVER owned with an active booking page -> the address, as before', async () => {
  const t = await resolveBookingTarget(fakePool(), TENANT, { getEntitlements: oliver(true), tenantSlug: slug });
  assert.equal(t.decided, true);
  assert.match(t.href, /\/fernbrook\/$/);
});

test('OLIVER owned, no active booking page -> decided, no address', async () => {
  const t = await resolveBookingTarget(fakePool({ hasPage: false }), TENANT, { getEntitlements: oliver(true), tenantSlug: slug });
  assert.deepEqual(t, { decided: true, href: '', reason: BOOKING_WORDS.NO_PAGE });
});

/* ── the daily push ────────────────────────────────────────────────────── */

async function tick(getEntitlements, opts = {}) {
  const site = { site_id: SITE, tenant_id: TENANT, domain: 'example.test', site_token_raw: 'tok' };
  const pool = fakePool({ sites: [site], hasPage: opts.hasPage ?? true });
  const pushes = [];
  const summary = await runBookingButtonSyncTick(pool, () => {}, {
    resolve: (p, t) => resolveBookingTarget(p, t, { getEntitlements, tenantSlug: slug }),
    push: async (s, body) => { pushes.push({ site: s.site_id, ...body }); return { ok: true }; },
  });
  return { summary, pushes };
}

test('daily push: OLIVER ended -> the site is told an EMPTY booking address (button off)', async () => {
  const { summary, pushes } = await tick(oliver(false));
  assert.deepEqual(pushes, [{ site: SITE, bookingUrl: '' }]);
  assert.equal(summary.cleared, 1);
});

test('daily push: OLIVER undecided -> nothing is pushed, the site keeps what it had', async () => {
  const { summary, pushes } = await tick(unreachable);
  assert.deepEqual(pushes, []);
  assert.equal(summary.held, 1);
});

test('daily push: OLIVER owned with a booking page -> the address is pushed, as before', async () => {
  const { summary, pushes } = await tick(oliver(true));
  assert.equal(pushes.length, 1);
  assert.match(pushes[0].bookingUrl, /\/fernbrook\/$/);
  assert.equal(summary.pointed, 1);
});

/* ── the editor-open push ──────────────────────────────────────────────── */

test('editor push: an undecided answer is never pushed; a decided empty one is', () => {
  const { syncBookingButton, bookingPushed } = pagesInternals;
  bookingPushed.clear();
  const site = { site_id: 'editor-1', domain: 'example.test' };
  syncBookingButton(site, '', { decided: false });
  assert.equal(bookingPushed.has('editor-1'), false, 'undecided: no push');
  syncBookingButton(site, '', { decided: true });
  assert.equal(bookingPushed.get('editor-1').href, '', 'OLIVER ended: the empty address is pushed');
  bookingPushed.clear();
});

/* ── the provisioning push ─────────────────────────────────────────────── */

const real = { ...submitDeps };
let server;
let base;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/', submitRouter);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  Object.assign(submitDeps, real);
  await new Promise((resolve) => server.close(resolve));
});

async function redeem(getEntitlements) {
  const pool = fakePool();
  submitDeps.getServicesPool = async () => pool;
  submitDeps.redeemProvisionCode = async () => ({ ok: true, code_row: { tenant_id: TENANT, site_id: SITE } });
  submitDeps.firePlatformEvent = async () => 'evt';
  submitDeps.resolveBookingTarget = (p, t) => resolveBookingTarget(p, t, { getEntitlements, tenantSlug: slug });
  const res = await fetch(`${base}/public/provision-codes/redeem`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'ABCD-EFGH' }),
  });
  return { status: res.status, body: await res.json() };
}

test('provisioning: OLIVER not owned -> booking_url is sent EMPTY (a stale button comes off)', async () => {
  const r = await redeem(oliver(false));
  assert.equal(r.status, 200);
  assert.ok(Object.prototype.hasOwnProperty.call(r.body.data, 'booking_url'));
  assert.equal(r.body.data.booking_url, '');
});

test('provisioning: OLIVER undecided -> no booking_url at all (the plugin keeps what it had)', async () => {
  const r = await redeem(unreachable);
  assert.equal(r.status, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(r.body.data, 'booking_url'), false);
});

test('provisioning: OLIVER owned with a booking page -> the address, as before', async () => {
  const r = await redeem(oliver(true));
  assert.equal(r.status, 200);
  assert.match(r.body.data.booking_url, /\/fernbrook\/$/);
});
