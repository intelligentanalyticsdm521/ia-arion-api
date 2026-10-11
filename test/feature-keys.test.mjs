/**
 * Every feature key arion-api names is in the catalog (scope 2.4).
 *
 *   1. lib/featureKeys.js namedFeatureKeys() holds every key the gates name.
 *   2. Every one of them is in test/fixtures/feature-keys.json (this repo's
 *      copy of platform-api's seed keys; platform-api
 *      scripts/_check-feature-keys.mjs diffs the copy against the seed).
 *   3. A source scan: every key literal in a gate (requireFeature('...'),
 *      key: '...' in a route map, *_FEATURE = '...') is in that list, so a
 *      gate added later cannot name a key the check does not know about.
 *   4. The startup check RUNS against a stubbed platform-api and logs the
 *      keys the catalog lacks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { namedFeatureKeys, checkFeatureKeysAtStartup } from '../lib/featureKeys.js';
import { fixtureKeys } from './helpers/feature-fakes.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(m?js)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('the fixture is a copy of the catalog keys ({count, keys})', () => {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'feature-keys.json'), 'utf8'));
  assert.equal(j.count, j.keys.length);
  assert.ok(j.keys.length > 300);
  assert.equal(new Set(j.keys).size, j.keys.length, 'no duplicates');
});

test('every key arion-api gates on is in the catalog copy', () => {
  const have = new Set(fixtureKeys());
  const named = namedFeatureKeys();
  assert.ok(named.length >= 25, `named ${named.length}`);
  const missing = named.filter((k) => !have.has(k));
  assert.deepEqual(missing, [], `not in test/fixtures/feature-keys.json: ${missing.join(', ')}`);
});

test('every key literal in a gate in the source is in namedFeatureKeys()', () => {
  const named = new Set(namedFeatureKeys());
  const found = new Map();
  // Everywhere: a requireFeature / featureDecision call or a *_FEATURE constant.
  const PATTERNS = [
    /requireFeature\(\s*'([a-z0-9_]+)'/g,
    /featureDecision\([^,()\n]+,\s*'([a-z0-9_]+)'/g,
    /_FEATURE\s*=\s*'([a-z0-9_]+)'/g,
  ];
  // In middleware/ (where the route maps live): every `key: '<product>_...'`.
  const MAP_KEY = /\bkey:\s*'((?:arion|my_brand|spark|oliver|stella|argus|forge|consulting|portal)_[a-z0-9_]+)'/g;
  for (const f of [...sourceFiles(path.join(ROOT, 'lib')), ...sourceFiles(path.join(ROOT, 'middleware')), ...sourceFiles(path.join(ROOT, 'routes')), path.join(ROOT, 'index.js')]) {
    const text = fs.readFileSync(f, 'utf8');
    const pats = path.relative(ROOT, f).startsWith('middleware') ? [...PATTERNS, MAP_KEY] : PATTERNS;
    for (const re of pats) for (const m of text.matchAll(re)) found.set(m[1], path.relative(ROOT, f));
  }
  assert.ok(found.size >= 25, `the scan found ${found.size} keys; is it still looking in the right places?`);
  const stray = [...found].filter(([k]) => !named.has(k)).map(([k, f]) => `${k} (${f})`);
  assert.deepEqual(stray, [], `gate keys not in lib/featureKeys.js: ${stray.join(', ')}`);
});

test('startup check: logs every named key the catalog lacks, at error', async () => {
  const errors = []; const logs = [];
  const log = { error: (m) => errors.push(m), log: (m) => logs.push(m), warn: () => {} };
  const keys = namedFeatureKeys();
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, token: opts.headers['x-internal-token'] });
    return { ok: true, status: 200, json: async () => ({ catalog_version: 'v1', count: keys.length - 1, features: keys.slice(1).map((key) => ({ key })) }) };
  };
  const r = await checkFeatureKeysAtStartup({ env: { PLATFORM_API_URL: 'http://platform.test', PLATFORM_INTERNAL_TOKEN: 'shh' }, fetchImpl, log });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/internal\/feature-catalog$/);
  assert.equal(calls[0].token, 'shh');
  assert.deepEqual(r.missing, [keys[0]]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], new RegExp(keys[0]));
});

test('startup check: all present -> one info line; unconfigured or unreachable -> a warning, never a throw', async () => {
  const logs = []; const warns = [];
  const log = { error: () => { throw new Error('no error expected'); }, log: (m) => logs.push(m), warn: (m) => warns.push(m) };
  const all = async () => ({ ok: true, status: 200, json: async () => ({ features: namedFeatureKeys().map((key) => ({ key })) }) });
  const env = { PLATFORM_API_URL: 'http://platform.test', PLATFORM_INTERNAL_TOKEN: 'shh' };
  assert.deepEqual((await checkFeatureKeysAtStartup({ env, fetchImpl: all, log })).missing, []);
  assert.equal(logs.length, 1);
  assert.equal((await checkFeatureKeysAtStartup({ env: {}, log })).checked, false);
  assert.equal((await checkFeatureKeysAtStartup({ env, fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, log })).checked, false);
  assert.equal((await checkFeatureKeysAtStartup({ env, fetchImpl: async () => ({ ok: false, status: 503 }), log })).checked, false);
  assert.equal(warns.length, 3);
});

test('the startup check is called once when the app starts listening', () => {
  const index = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const listen = index.slice(index.indexOf('app.listen('));
  assert.match(listen, /checkFeatureKeysAtStartup\(\)/);
});
