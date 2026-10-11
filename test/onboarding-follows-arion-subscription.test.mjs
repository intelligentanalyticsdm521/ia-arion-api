/**
 * The signed-in ARION setup routes follow the business's ARION subscription
 * (Brandon, 11 Oct 2026: "If they don't have the subscription you don't get
 * any features").
 *
 * /onboarding/runner (hosting, AI website builder, SE Ranking seeding, plugin
 * install, WordPress editor user), /onboarding/google-oauth and
 * /onboarding/bing-oauth (Google Analytics, Search Console, Business Profile
 * and Bing properties made through the IA master accounts) were mounted with
 * sign-in only. A business whose ARION had ended could still start every one.
 *
 * Runs the REAL middleware in front of the REAL routers, with platform-api
 * stubbed. The requests are shaped so a router that is reached answers before
 * it touches a database (a missing field is a 400), which proves whether the
 * gate let it through:
 *   ARION not in the subscription -> 403 with the reason; the router never runs
 *   undecided -> a step that starts something is held (503); a status read
 *                carries on
 *   ARION in the subscription -> the router runs as before
 * And index.js mounts the gate in front of all three routers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { requireArionSubscription, ARION_SUBSCRIPTION_WORDS } from '../middleware/requireArionSubscription.js';
import runnerRouter from '../routes/onboarding/runner.js';
import googleRouter from '../routes/onboarding/google-oauth.js';
import bingRouter from '../routes/onboarding/bing-oauth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T1 = 'a1111111-1111-4111-8111-111111111111';

const arion = (owned, decided = true) => async () => ({
  tenant_id: T1, decided, products: { arion: { owned, tier: owned ? 'pro' : null, decided } },
});
const unreachable = async () => null;

async function call(getEntitlements, { mount, router, method = 'POST', url, body }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.tenant = { tenantId: T1 }; next(); });
  app.use(mount, requireArionSubscription({ getEntitlements }), router);
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${mount}${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

// Each is answered by the router itself, before any database, when it is reached.
const STARTS = [
  { name: 'hosting', mount: '/onboarding/runner', router: runnerRouter, url: '/hostinger-provision', body: { tenant_id: T1 } },
  { name: 'AI website builder', mount: '/onboarding/runner', router: runnerRouter, url: '/ai-website-builder', body: { tenant_id: T1 } },
  { name: 'SE Ranking keywords', mount: '/onboarding/runner', router: runnerRouter, url: '/seo-keywords-seed', body: { tenant_id: T1 } },
  { name: 'Google properties', mount: '/onboarding/google-oauth', router: googleRouter, url: '/auto-provision', body: { tenant_id: T1 } },
  { name: 'Bing properties', mount: '/onboarding/bing-oauth', router: bingRouter, url: '/auto-provision', body: { tenant_id: T1 } },
];

test('ARION not in the subscription: every setup step is refused with the reason, and the router never runs', async () => {
  for (const s of STARTS) {
    const r = await call(arion(false), s);
    assert.equal(r.status, 403, s.name);
    assert.equal(r.body.error.code, 'ARION_NOT_IN_SUBSCRIPTION', s.name);
    assert.equal(r.body.error.message, ARION_SUBSCRIPTION_WORDS.OFF, s.name);
    assert.match(r.body.error.message, /ARION is not in this business's subscription/);
  }
});

test('ARION undecided: a step that starts something is held and nothing is started', async () => {
  for (const getEntitlements of [unreachable, arion(true, false)]) {
    for (const s of STARTS) {
      const r = await call(getEntitlements, s);
      assert.equal(r.status, 503, s.name);
      assert.equal(r.body.error.code, 'SUBSCRIPTION_UNCONFIRMED', s.name);
      assert.equal(r.body.error.message, ARION_SUBSCRIPTION_WORDS.HELD);
    }
  }
});

test('ARION undecided: a status read carries on (never lock a business out of its own progress)', async () => {
  let reached = 0;
  const probe = express.Router();
  probe.get('/status/:siteId', (_req, res) => { reached++; res.json({ ok: true }); });
  const r = await call(unreachable, { mount: '/onboarding/google-oauth', router: probe, method: 'GET', url: '/status/s1' });
  assert.equal(r.status, 200);
  assert.equal(reached, 1);
});

test('ARION in the subscription: the router runs as before', async () => {
  for (const s of STARTS) {
    const r = await call(arion(true), s);
    assert.equal(r.status, 400, `${s.name}: reached the router (it asks for the missing site)`);
    assert.equal(r.body.error.code, 'VALIDATION_ERROR', s.name);
  }
});

test('index.js puts the gate in front of all three setup routers', () => {
  const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  for (const [mount, router] of [
    ['/onboarding/runner', 'onboardingRunnerRouter'],
    ['/onboarding/google-oauth', 'onboardingGoogleOauthRouter'],
    ['/onboarding/bing-oauth', 'onboardingBingOauthRouter'],
  ]) {
    const re = new RegExp(`app\\.use\\(\\s*'${mount.replace(/\//g, '\\/')}',[^;]*?tenantResolution,\\s*requireArionSubscription\\(\\),\\s*${router},\\s*\\);`);
    assert.match(src, re, `${mount} is mounted behind requireArionSubscription()`);
  }
});
