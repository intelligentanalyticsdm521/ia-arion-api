// The Google refresh token, sealed at rest (security finding 2026-10-08).
//
// lib/gbpTokenAtRest.js seals the token stored in arion.site.gbp_oauth_token_ref
// (and gsc_oauth_token_ref) under GBP_TOKEN_KEY, reads clear legacy values as
// they are, and fails closed on a sealed value it cannot open.
// scripts/encrypt-gbp-tokens.mjs rewrites the clear rows. Every value here is
// made up; no database, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  seal, open, isSealed, tokenKey, forStore, storeGoogleRefreshToken, siteRefreshToken, siteSearchToken,
  hasSiteToken, legacyReads, resetLegacyReads, resetStoreWarning, GbpTokenUnreadable, UNREADABLE_WORDS, SEALED_PREFIX,
} from '../lib/gbpTokenAtRest.js';
import { runEncrypt, shapeOf } from '../scripts/encrypt-gbp-tokens.mjs';
import { readGbpIntake } from '../lib/gbpIntake.js';
import { reviewsApi } from '../lib/gbpFake.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = () => crypto.randomBytes(32).toString('base64');
const MADE_UP = '1//made-up-refresh-value-for-a-test-only-0123456789abcdefghijklmnop';

/* ── seal / open ────────────────────────────────────────────────────────── */

test('seal then open gives the same token back, in the enc:v1:<iv>:<tag>:<ciphertext> shape', () => {
  const env = { GBP_TOKEN_KEY: KEY() };
  const sealed = seal(MADE_UP, env);
  assert.match(sealed, /^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.ok(isSealed(sealed));
  assert.equal(sealed.includes(MADE_UP), false, 'the clear token is not inside the sealed value');
  assert.equal(open(sealed, env), MADE_UP);
  assert.notEqual(seal(MADE_UP, env), sealed, 'a fresh iv every time');
  // Room in the widened column (migration 074) even for a long token.
  assert.ok(seal('1//' + 'x'.repeat(512), env).length < 1000);
});

test('open fails CLOSED on a tampered value, a wrong key, a missing key or a malformed value, and never hands back ciphertext', () => {
  const env = { GBP_TOKEN_KEY: KEY() };
  const sealed = seal(MADE_UP, env);
  const [iv, tag, ct] = sealed.slice(SEALED_PREFIX.length).split(':');
  const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  const bad = [
    [`${SEALED_PREFIX}${iv}:${tag}:${flip(ct)}`, env, 'tampered ciphertext'],
    [`${SEALED_PREFIX}${iv}:${flip(tag)}:${ct}`, env, 'tampered tag'],
    [`${SEALED_PREFIX}${flip(iv)}:${tag}:${ct}`, env, 'tampered iv'],
    [sealed, { GBP_TOKEN_KEY: KEY() }, 'wrong key'],
    [sealed, {}, 'missing key'],
    [sealed, { GBP_TOKEN_KEY: 'c2hvcnQ=' }, 'a key that is not 32 bytes'],
    [`${SEALED_PREFIX}abc`, env, 'malformed'],
    [`${SEALED_PREFIX}${iv}:${tag}:`, env, 'empty ciphertext'],
  ];
  for (const [value, e, label] of bad) {
    assert.throws(() => open(value, e), (err) => err instanceof GbpTokenUnreadable && err.message === UNREADABLE_WORDS, label);
  }
  // The words an owner may read: plain, no setting name, no key, no exception text.
  assert.doesNotMatch(UNREADABLE_WORDS, /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|tenant|agent|aes|gcm|decrypt|cipher|key/i);
});

test('a clear (legacy) value is returned as it is and counted; empty is null and not counted', () => {
  resetLegacyReads();
  const env = { GBP_TOKEN_KEY: KEY() };
  assert.equal(open(MADE_UP, env), MADE_UP);
  assert.equal(open('dev-fake', {}), 'dev-fake', 'works before the key exists');
  assert.equal(legacyReads(), 2);
  assert.equal(open(null, env), null);
  assert.equal(open('   ', env), null);
  assert.equal(open(seal(MADE_UP, env), env), MADE_UP);
  assert.equal(legacyReads(), 2, 'neither empty nor sealed values count as legacy');
});

test('a key that is set but malformed is never treated as unset', () => {
  assert.equal(tokenKey({}), null);
  assert.throws(() => tokenKey({ GBP_TOKEN_KEY: 'bm90LWEta2V5' }), GbpTokenUnreadable);
  assert.throws(() => forStore(MADE_UP, { GBP_TOKEN_KEY: 'bm90LWEta2V5' }, { warn() {} }), GbpTokenUnreadable);
});

/* ── the write path ─────────────────────────────────────────────────────── */

function capturePool() {
  const calls = [];
  return {
    calls,
    request() {
      const self = { inputs: {}, input(k, _t, v) { self.inputs[k] = v; return self; }, async query(text) { calls.push({ text, inputs: self.inputs }); return { rowsAffected: [1] }; } };
      return self;
    },
  };
}

test('the connect callback stores the SEALED token when the key is set', async () => {
  const env = { GBP_TOKEN_KEY: KEY() };
  const warns = [];
  const pool = capturePool();
  await storeGoogleRefreshToken(pool, { tenantId: 't', siteId: 's', refreshToken: MADE_UP }, env, { warn: (m) => warns.push(m) });
  assert.equal(pool.calls.length, 1);
  const stored = pool.calls[0].inputs.refreshToken;
  assert.ok(isSealed(stored), 'sealed at rest');
  assert.equal(open(stored, env), MADE_UP);
  assert.match(pool.calls[0].text, /SET gbp_oauth_token_ref = @refreshToken/);
  assert.equal(warns.length, 0);
});

test('without the key the token is stored as it is today, with ONE warning per process', async () => {
  resetStoreWarning();
  const warns = [];
  const log = { warn: (m) => warns.push(m) };
  const pool = capturePool();
  await storeGoogleRefreshToken(pool, { tenantId: 't', siteId: 's', refreshToken: MADE_UP }, {}, log);
  await storeGoogleRefreshToken(pool, { tenantId: 't', siteId: 's2', refreshToken: MADE_UP }, {}, log);
  assert.equal(pool.calls[0].inputs.refreshToken, MADE_UP);
  assert.equal(pool.calls[1].inputs.refreshToken, MADE_UP);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /unsealed/);
  assert.equal(warns[0].includes(MADE_UP), false, 'the warning never carries the token');
});

test('routes/oauth.js stores the token only through storeGoogleRefreshToken', () => {
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'oauth.js'), 'utf8');
  assert.match(src, /await storeGoogleRefreshToken\(pool, \{ tenantId, siteId, refreshToken \}\)/);
});

/* ── the readers ────────────────────────────────────────────────────────── */

test('siteRefreshToken / siteSearchToken open sealed values; the search token prefers its own column', () => {
  const env = { GBP_TOKEN_KEY: KEY() };
  const site = { gbp_oauth_token_ref: seal(MADE_UP, env), gsc_oauth_token_ref: null };
  assert.equal(siteRefreshToken(site, env), MADE_UP);
  assert.equal(siteSearchToken(site, env), MADE_UP);
  assert.equal(siteSearchToken({ ...site, gsc_oauth_token_ref: seal('1//other-made-up', env) }, env), '1//other-made-up');
  assert.equal(siteRefreshToken({ gbp_oauth_token_ref: null }, env), null);
  assert.equal(hasSiteToken(site), true);
  assert.equal(hasSiteToken({}), false);
});

function intakePool(row) {
  return { request() { const self = { input() { return self; }, async query() { return { recordset: [row] }; } }; return self; } };
}
const INTAKE_SITE = '11111111-2222-4333-8444-555555555555';

test('a reader (the listing intake) hands Google the OPENED token, and refuses a sealed one it cannot open in plain words', async () => {
  const saved = process.env.GBP_TOKEN_KEY;
  const key = KEY();
  process.env.GBP_TOKEN_KEY = key;
  try {
    const row = { site_id: INTAKE_SITE, gbp_connected: 1, gbp_oauth_token_ref: seal(MADE_UP, { GBP_TOKEN_KEY: key }), gbp_location_name: 'accounts/1/locations/2', status: 'active' };
    const seen = [];
    const deps = {
      fetchPerformance: async (tok) => { seen.push(tok); return { data: {} }; },
      summarizePerformance: () => ({ calls: 1, websiteClicks: 1 }),
      fetchQuestions: async (tok) => { seen.push(tok); return { questions: [] }; },
    };
    const r = await readGbpIntake(intakePool(row), INTAKE_SITE, { deps });
    assert.equal(r.ok, true);
    assert.deepEqual(seen, [MADE_UP, MADE_UP]);

    process.env.GBP_TOKEN_KEY = KEY(); // the wrong key
    seen.length = 0;
    const refused = await readGbpIntake(intakePool(row), INTAKE_SITE, { deps });
    assert.equal(refused.ok, false);
    assert.equal(refused.message, UNREADABLE_WORDS);
    assert.equal(seen.length, 0, 'nothing was sent to Google');
  } finally {
    if (saved === undefined) delete process.env.GBP_TOKEN_KEY; else process.env.GBP_TOKEN_KEY = saved;
  }
});

test('the dev fake still answers, with the legacy dev value and with a sealed one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbp-fake-'));
  const file = path.join(dir, 'reviews.json');
  fs.writeFileSync(file, JSON.stringify({ 'locations/dev-fake': { reviews: [{ reviewId: 'r1', starRating: 5, comment: 'Great' }], replies: [] } }));
  const api = reviewsApi({ ARION_GBP_FAKE_FILE: file });
  assert.equal(api.fake, true);
  const env = { GBP_TOKEN_KEY: KEY() };
  for (const stored of ['dev-fake', seal('dev-fake', env)]) {
    const data = await api.fetchReviews(siteRefreshToken({ gbp_oauth_token_ref: stored }, env), 'locations/dev-fake');
    assert.equal(data.reviews.length, 1);
    assert.equal(data.reviews[0].reviewId, 'r1');
  }
  const posted = await api.replyToReview(siteRefreshToken({ gbp_oauth_token_ref: 'dev-fake' }, env), 'locations/dev-fake', 'r1', 'Thank you!');
  assert.equal(posted.reply.comment, 'Thank you!');
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ── the rewrite script ─────────────────────────────────────────────────── */

const G = (n) => `0000000${n}-aaaa-4bbb-8ccc-00000000000${n}`;

/** A fake arion.site that speaks the script's SQL, with transactions. */
function fakeSitePool(rows, faults = {}) {
  const table = new Map(rows.map((r) => [r.site_id, { ...r }]));
  const log = [];
  const run = (text, inputs, tx) => {
    log.push({ text: text.replace(/\s+/g, ' ').trim(), tx: !!tx });
    if (/COL_LENGTH/.test(text)) return { recordset: [{ gbp: 1000, gsc: 1000 }] };
    let m;
    if ((m = /SELECT (\w+) AS v FROM arion\.site/.exec(text))) {
      const row = (tx ? tx.view : table).get(inputs.s);
      if (row && faults.readBack && tx && tx.wrote) return { recordset: [{ v: 'something else' }] };
      return { recordset: row ? [{ v: row[m[1]] }] : [] };
    }
    if ((m = /UPDATE arion\.site SET (\w+) = @new WHERE site_id = @s AND \1 = @old/.exec(text))) {
      const row = tx.view.get(inputs.s);
      if (!row || row[m[1]] !== inputs.old || faults.raced) return { rowsAffected: [0] };
      row[m[1]] = inputs.new;
      tx.wrote = true;
      return { rowsAffected: [1] };
    }
    if (/SELECT site_id, tenant_id, gbp_oauth_token_ref, gsc_oauth_token_ref/.test(text)) {
      return { recordset: [...table.values()].filter((r) => (r.gbp_oauth_token_ref != null || r.gsc_oauth_token_ref != null) && (!inputs.site || r.site_id === inputs.site)) };
    }
    throw new Error(`unexpected SQL: ${text}`);
  };
  const request = (tx) => { const self = { inputs: {}, input(k, _t, v) { self.inputs[k] = v; return self; }, async query(text) { return run(text, self.inputs, tx); } }; return self; };
  const pool = {
    table, log,
    request: () => request(null),
    transaction() {
      const tx = {
        state: 'new',
        async begin() { tx.view = new Map([...table].map(([k, v]) => [k, { ...v }])); tx.state = 'open'; },
        request: () => request(tx),
        async commit() { for (const [k, v] of tx.view) table.set(k, v); tx.state = 'committed'; pool.commits += 1; },
        async rollback() { tx.state = 'rolled back'; },
      };
      return tx;
    },
    commits: 0,
  };
  return pool;
}

const ROWS = () => [
  { site_id: G(1), tenant_id: G(9), gbp_oauth_token_ref: MADE_UP, gsc_oauth_token_ref: null },
  { site_id: G(2), tenant_id: G(9), gbp_oauth_token_ref: '1//second-made-up-value-abcdefghijklmnopqrstuvwxyz', gsc_oauth_token_ref: '1//second-made-up-value-abcdefghijklmnopqrstuvwxyz' },
  { site_id: G(3), tenant_id: G(8), gbp_oauth_token_ref: '', gsc_oauth_token_ref: null },
];

/** No token, sealed or clear, ever reaches the output. */
function assertNoTokenShapes(lines) {
  const text = lines.join('\n');
  assert.equal(text.includes('1//'), false, 'a clear token prefix in the output');
  assert.doesNotMatch(text, /[A-Za-z0-9+/=]{21,}/, 'a base64 blob in the output');
}

test('the dry run prints only site_id, tenant_id and the shape, never a value, and changes nothing', async () => {
  const pool = fakeSitePool(ROWS());
  const env = { GBP_TOKEN_KEY: KEY() };
  const sealedRow = { site_id: G(4), tenant_id: G(8), gbp_oauth_token_ref: seal('1//already-sealed-made-up', env), gsc_oauth_token_ref: null };
  pool.table.set(G(4), sealedRow);
  const before = JSON.stringify([...pool.table]);
  const lines = [];
  const s = await runEncrypt({ pool, env, apply: false, out: (l) => lines.push(l) });
  assertNoTokenShapes(lines);
  assert.equal(JSON.stringify([...pool.table]), before);
  assert.equal(pool.log.some((q) => /UPDATE/.test(q.text)), false);
  assert.ok(lines.some((l) => l === `site_id=${G(1)} tenant_id=${G(9)} gbp=legacy gsc=empty`), lines.join('\n'));
  assert.ok(lines.some((l) => l === `site_id=${G(4)} tenant_id=${G(8)} gbp=sealed gsc=empty`));
  assert.equal(s.legacy, 3);
  assert.equal(s.sealed, 1);
});

test('--apply seals every legacy value in its own transaction, verifies it opens back, and a second run finds 0 legacy', async () => {
  const pool = fakeSitePool(ROWS());
  const env = { GBP_TOKEN_KEY: KEY() };
  const lines = [];
  const s = await runEncrypt({ pool, env, apply: true, out: (l) => lines.push(l) });
  assertNoTokenShapes(lines);
  assert.equal(s.changed, 3);
  assert.equal(s.failed, 0);
  assert.equal(pool.commits, 3, 'one commit per value');
  const r1 = pool.table.get(G(1));
  const r2 = pool.table.get(G(2));
  assert.ok(isSealed(r1.gbp_oauth_token_ref));
  assert.equal(open(r1.gbp_oauth_token_ref, env), MADE_UP);
  assert.equal(open(r2.gsc_oauth_token_ref, env), '1//second-made-up-value-abcdefghijklmnopqrstuvwxyz');
  assert.equal(pool.table.get(G(3)).gbp_oauth_token_ref, '', 'an empty value is left alone');
  assert.ok(pool.log.filter((q) => /UPDATE/.test(q.text)).every((q) => q.tx), 'every write is inside a transaction');

  const again = await runEncrypt({ pool, env, apply: true, out: () => {} });
  assert.equal(again.legacy, 0);
  assert.equal(again.changed, 0);
});

test('--apply rolls back, and never commits, a value whose row changed under it or that does not read back the same', async () => {
  const env = { GBP_TOKEN_KEY: KEY() };
  const WHY = { raced: 'the row changed while it was being sealed', readBack: 'the value read back did not open to the same token' };
  for (const fault of ['raced', 'readBack']) {
    const pool = fakeSitePool([ROWS()[0]], { [fault]: true });
    const lines = [];
    const s = await runEncrypt({ pool, env, apply: true, out: (l) => lines.push(l) });
    assert.equal(s.changed, 0, fault);
    assert.equal(s.failed, 1, fault);
    assert.equal(pool.commits, 0, fault);
    assert.equal(pool.table.get(G(1)).gbp_oauth_token_ref, MADE_UP, `${fault}: the stored value is untouched`);
    assert.ok(lines.some((l) => l.includes(`gbp not sealed: ${WHY[fault]}; nothing was changed for this value`)), lines.join(' | '));
    assertNoTokenShapes(lines);
  }
});

test('--apply refuses without GBP_TOKEN_KEY and touches nothing', async () => {
  const pool = fakeSitePool(ROWS());
  await assert.rejects(runEncrypt({ pool, env: {}, apply: true, out: () => {} }), /GBP_TOKEN_KEY is not set/);
  assert.equal(pool.log.length, 0);
  assert.equal(shapeOf(pool.table.get(G(1)).gbp_oauth_token_ref), 'legacy');
});

const SCRIPT = path.join(ROOT, 'scripts', 'encrypt-gbp-tokens.mjs');
function runCli(args, env) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gbp-enc-')); // no .env here
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { cwd, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 }) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

test('the command line refuses --apply without the key, and a non-local server without --confirm-server, before it connects', () => {
  const noKey = runCli(['--apply'], { SQL_SERVER: 'localhost,1433' });
  assert.equal(noKey.code, 1);
  assert.match(noKey.out, /Refusing --apply: GBP_TOKEN_KEY is not set/);

  const remote = runCli([], { SQL_SERVER: 'sql-made-up.example.net' });
  assert.equal(remote.code, 1);
  assert.match(remote.out, /--confirm-server sql-made-up\.example\.net/);

  const badKey = runCli(['--apply'], { SQL_SERVER: 'localhost', GBP_TOKEN_KEY: 'bm90LWEta2V5' });
  assert.equal(badKey.code, 1);
  assert.match(badKey.out, /not 32 bytes/);
});

/* ── the guard: no reader can slip past open() ─────────────────────────── */

/** The code of a JS file with comments and string / template text removed (template ${} expressions kept). */
function codeOnly(src) {
  let out = '';
  let i = 0;
  let lastSig = '';
  let word = '';
  let inTemplate = false;
  const tpl = [];
  const n = src.length;
  const KW = /^(return|typeof|case|in|of|void|delete|throw|new|else|yield|await|do)$/;
  const regexOk = () => lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig) || KW.test(word);
  while (i < n) {
    const c = src[i];
    if (inTemplate) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { inTemplate = false; i += 1; out += '``'; lastSig = '`'; word = ''; continue; }
      if (c === '$' && src[i + 1] === '{') { tpl.push(0); inTemplate = false; i += 2; out += ' '; lastSig = '{'; word = ''; continue; }
      if (c === '\n') out += '\n';
      i += 1;
      continue;
    }
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; out += src.slice(i, end).replace(/[^\n]/g, ''); i = end; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      i = j + 1; out += '""'; lastSig = '"'; word = '';
      continue;
    }
    if (c === '`') { inTemplate = true; i += 1; continue; }
    if (c === '/' && regexOk()) {
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== '\n') {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (cls) { if (ch === ']') cls = false; } else if (ch === '[') cls = true; else if (ch === '/') break;
        j += 1;
      }
      j += 1;
      while (j < n && /[a-z]/i.test(src[j])) j += 1;
      i = j; out += '/r/'; lastSig = '/'; word = '';
      continue;
    }
    if (tpl.length) {
      if (c === '{') tpl[tpl.length - 1] += 1;
      else if (c === '}') {
        if (tpl[tpl.length - 1] === 0) { tpl.pop(); inTemplate = true; i += 1; continue; }
        tpl[tpl.length - 1] -= 1;
      }
    }
    out += c;
    if (/[\w$]/.test(c)) { word = (/[\w$]/.test(src[i - 1] || '') ? word : '') + c; lastSig = 'w'; } else if (!/\s/.test(c)) { lastSig = c; word = ''; }
    i += 1;
  }
  return { code: out, clean: !inTemplate && tpl.length === 0 };
}

test('the guard\'s scanner keeps code, drops SQL text and comments, and keeps ${} expressions', () => {
  const src = [
    "const a = site.gbp_oauth_token_ref; // a code read",
    "const q = `SELECT s.gbp_oauth_token_ref FROM arion.site WHERE x = ${site.gsc_oauth_token_ref}`;",
    "const r = /['`]/.test(x) ? 'gbp_oauth_token_ref' : \"gbp_oauth_token_ref\";",
    "/* gbp_oauth_token_ref */ const { gbp_oauth_token_ref: t } = row;",
  ].join('\n');
  const { code, clean } = codeOnly(src);
  assert.equal(clean, true);
  const hits = code.match(/\b(gbp|gsc)_oauth_token_ref\b/g) || [];
  assert.deepEqual(hits, ['gbp_oauth_token_ref', 'gsc_oauth_token_ref', 'gbp_oauth_token_ref'], code);
});

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : jsFiles(p);
    return /\.(m?js)$/.test(e.name) ? [p] : [];
  });
}

test('no file in lib/ or routes/ reads or writes the token columns except lib/gbpTokenAtRest.js', () => {
  const HOME = path.join(ROOT, 'lib', 'gbpTokenAtRest.js');
  const files = [...jsFiles(path.join(ROOT, 'lib')), ...jsFiles(path.join(ROOT, 'routes'))];
  assert.ok(files.length > 50, 'the scan reached lib/ and routes/');
  assert.ok(files.includes(HOME));
  const offenders = [];
  for (const f of files) {
    if (f === HOME) continue;
    const src = fs.readFileSync(f, 'utf8');
    const { code, clean } = codeOnly(src);
    assert.equal(clean, true, `the scanner lost its place in ${path.relative(ROOT, f)}`);
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    code.split('\n').forEach((line, k) => {
      if (/\b(gbp|gsc)_oauth_token_ref\b/.test(line)) offenders.push(`${rel}:${k + 1} reads the column directly (use siteRefreshToken / siteSearchToken / hasSiteToken)`);
    });
    // A store from anywhere else (a SET col = @value) skips the seal; only clearing it (= NULL) is allowed.
    src.split('\n').forEach((line, k) => {
      if (/\b(gbp|gsc)_oauth_token_ref\s*=(?!\s*NULL\b)/i.test(line)) offenders.push(`${rel}:${k + 1} writes the column directly (use storeGoogleRefreshToken)`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('the known readers go through the helper (presence, not just absence)', () => {
  const uses = {
    'routes/arion.js': /siteRefreshToken\(site\)/,
    'routes/arion/reviewReplies.js': /fetchReviews\(siteRefreshToken\(row\)/,
    'routes/arion/intelligence.js': /siteSearchToken\(site\)/,
    'lib/gbpReplyRunner.js': /replyToReview\(siteRefreshToken\(site\)/,
    'lib/gbpIntake.js': /siteRefreshToken\(site\)/,
    'lib/insightsSnapshot.js': /siteSearchToken\(site\)/,
    'routes/oauth.js': /storeGoogleRefreshToken\(pool/,
  };
  for (const [f, re] of Object.entries(uses)) assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), re, f);
});
