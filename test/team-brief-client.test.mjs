// test/team-brief-client.test.mjs — T16: the Business Brief client
// (lib/team/brief.js briefFor). FAILS CLOSED: any non-200, a throw, a body
// that isn't the Brief's shape, or a missing setting is { ok: false }; a good
// answer is passed through exactly as platform-api sent it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { briefFor } from '../lib/team/brief.js';

const T = '11111111-2222-4333-8444-555555555555';
const ENV = { PLATFORM_API_URL: 'http://platform.test/', PLATFORM_INTERNAL_TOKEN: 's3cret' };
const BRIEF = { tenantId: T, version: 7, saved_at: '2026-10-02T14:10:00.000Z', fields: { services: { set: true, value: [{ name: 'Mowing' }] }, competitors: { set: false } }, borrowed: { businessName: 'Example Lawn Co' } };
const quiet = { error() {}, warn() {}, log() {} };
const answer = (status, body) => async () => ({ status, ok: status === 200, json: async () => (typeof body === 'function' ? body() : body) });

test('a 200 with the Brief is passed through, and the request carries the token to the right place', async () => {
  let seen;
  const r = await briefFor(T.toUpperCase(), { env: ENV, log: quiet, fetchImpl: async (url, opts) => { seen = { url, opts }; return answer(200, BRIEF)(); } });
  assert.deepEqual(r, { ok: true, brief: BRIEF });
  assert.equal(seen.url, `http://platform.test/internal/business-brief/${T}`);
  assert.equal(seen.opts.headers['x-internal-token'], 's3cret');
  assert.ok(seen.opts.signal, 'a timeout is set');
});

test('a non-200 is ok:false', async () => {
  for (const status of [401, 404, 500, 503]) {
    const r = await briefFor(T, { env: ENV, log: quiet, fetchImpl: answer(status, { error: 'x' }) });
    assert.equal(r.ok, false, String(status));
    assert.match(r.error, new RegExp(`HTTP ${status}`));
  }
});

test('a throw (unreachable, timeout) is ok:false', async () => {
  const r = await briefFor(T, { env: ENV, log: quiet, fetchImpl: async () => { throw new Error('The operation was aborted due to timeout'); } });
  assert.equal(r.ok, false);
  assert.match(r.error, /unreachable/);
});

test('a body that is not the Brief is ok:false, never a guess', async () => {
  for (const body of [null, {}, { version: '7', fields: {} }, { version: 7 }]) {
    assert.equal((await briefFor(T, { env: ENV, log: quiet, fetchImpl: answer(200, body) })).ok, false, JSON.stringify(body));
  }
  assert.equal((await briefFor(T, { env: ENV, log: quiet, fetchImpl: answer(200, () => { throw new Error('bad json'); }) })).ok, false);
});

test('no setting for where platform-api is, or its token, is ok:false and nothing is asked', async () => {
  let asked = false;
  const fetchImpl = async () => { asked = true; return answer(200, BRIEF)(); };
  assert.equal((await briefFor(T, { env: {}, log: quiet, fetchImpl })).ok, false);
  assert.equal((await briefFor(T, { env: { PLATFORM_API_URL: 'http://x' }, log: quiet, fetchImpl })).ok, false);
  assert.equal((await briefFor('', { env: ENV, log: quiet, fetchImpl })).ok, false);
  assert.equal(asked, false);
});

test('version 0 with nothing set is a true answer (ok:true), not an error', async () => {
  const empty = { tenantId: T, version: 0, saved_at: null, fields: { services: { set: false } }, borrowed: { businessName: null } };
  assert.deepEqual(await briefFor(T, { env: ENV, log: quiet, fetchImpl: answer(200, empty) }), { ok: true, brief: empty });
});
