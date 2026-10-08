/**
 * plugin.selfUpdate — tells a site to run its IA plugin update check now.
 *
 * IA plugin 2.0.1 answers POST /wp-json/intelligent-analytics/v1/updates/self
 * (site token or admin) with the result of its own update check. This pins the
 * client line: the right path, a POST, the site token header, no body fields.
 * fetch is replaced, so nothing leaves the process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { plugin } from '../lib/pluginClient.js';

const SITE = Object.freeze({ site_id: 's1', domain: 'fernbrook.invalid', site_token_raw: 'raw-token-abc' });

test('plugin.selfUpdate POSTs /updates/self with the site token and answers the check result', async (t) => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ checked_at: '2026-10-08T00:00:00+00:00', action: 'up_to_date', details: '' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  t.after(() => { globalThis.fetch = realFetch; });

  assert.equal(typeof plugin.selfUpdate, 'function', 'plugin.selfUpdate is missing');
  const r = await plugin.selfUpdate(SITE);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://fernbrook.invalid/wp-json/intelligent-analytics/v1/updates/self');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['X-Arion-Site-Token'], 'raw-token-abc');
  assert.equal(calls[0].init.body, '{}');
  assert.equal(r.ok, true);
  assert.equal(r.data.action, 'up_to_date');
});
