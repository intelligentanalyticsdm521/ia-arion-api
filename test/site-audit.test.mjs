/**
 * The website check — any agency's custom action (contract
 * CONTRACT_ARGUS_CHAT_PLAYBOOKS_2026-10-07.md §E, tests §G.2).
 *
 * Fakes stand in for PageSpeed, the website, the blob store and the caller's
 * callback. The SSRF tests talk to real sockets on 127.0.0.1 with a fake DNS.
 * One test paints a REAL PDF with Playwright and reads the words back out of it.
 *
 * Mutation map (scripts/dev/site-audit-mutation-check.mjs breaks each guard and
 * requires the named test here to go red):
 *   A1 signature compare   -> "a body signed with another secret is refused"
 *   A2 replay window       -> "a request signed 10 minutes ago is refused"
 *   A3 SSRF private refusal-> "a website on a private address is refused"
 *   A4 redirect hop check  -> "a redirect to a private address is refused at the hop"
 *   A5 robots              -> "robots disallow-all skips the page checks"
 *   A6 one per day         -> "one audit per website per day"
 *   A7 key compare/expiry  -> "file links: ..." tests
 *   A8 no paid SEO import  -> "no lib/audit file imports the paid SEO or intelligence code"
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import express from 'express';
import { Readable } from 'node:stream';

import { sign, verify } from '../lib/audit/signature.js';
import { AuditNotConfigured, callerKey, encryptSecret, decryptSecret } from '../lib/audit/callers.js';
import { safeFetch, checkUrl, isBlockedAddress, SafeFetchRefused } from '../lib/audit/safeFetch.js';
import { parseRobots, isAllowed } from '../lib/audit/robots.js';
import { pageChecks, securityHeaderChecks, contactChecks } from '../lib/audit/checks.js';
import { crawl, normaliseSiteUrl, urlKey } from '../lib/audit/crawl.js';
import { scoreAudit, bandSentence, SPEED_WORDS, ROBOTS_BLOCKED_SENTENCE } from '../lib/audit/score.js';
import { renderReportHtml, renderPdf, brandColours } from '../lib/audit/report.js';
import { mintLinks, hashKey } from '../lib/audit/links.js';
import { createAuditRunner, PLAIN } from '../lib/audit/runner.js';
import { createAuditRouter, WORDS } from '../routes/audit.js';
import { createSiteAuditsRouter } from '../routes/arion/siteAudits.js';

const REPO = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const TEST_KEY = crypto.randomBytes(32).toString('base64');
const SECRET = 'test-secret-0123456789abcdef0123456789';
const PUBLIC_IP = '93.184.216.34';

/** DNS twin: every *.example name is public unless the map says otherwise. */
function fakeLookup(map = {}) {
  return async (host) => {
    if (map[host]) return [].concat(map[host]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    if (/\.example$/.test(host)) return [{ address: PUBLIC_IP, family: 4 }];
    const err = new Error('ENOTFOUND'); err.code = 'ENOTFOUND'; throw err;
  };
}

// ---------------------------------------------------------------------------
// An in-memory twin of lib/audit/runs.js
// ---------------------------------------------------------------------------
function memoryRepo() {
  const runs = new Map();
  const callers = new Map();
  const r = {
    runs, callers,
    async getRun(id) { return runs.get(id) || null; },
    async findByExternal(c, e) { return [...runs.values()].find((x) => x.caller_id === c && x.external_run_id === e) || null; },
    async findDoneToday(c, u, d) {
      return [...runs.values()].filter((x) => x.caller_id === c && x.url_key === u && x.audit_day === d
        && ['done', 'callback_failed'].includes(x.status) && x.blob_path).pop() || null;
    },
    async countToday(c, d) { return [...runs.values()].filter((x) => x.caller_id === c && x.audit_day === d).length; },
    async insertRun(p) {
      const dup = await r.findByExternal(p.caller_id, p.external_run_id);
      if (dup) return { run_id: dup.run_id, inserted: false };
      const run_id = crypto.randomUUID();
      runs.set(run_id, { callback_attempts: 0, created_at: new Date(), ...p, run_id });
      return { run_id, inserted: true };
    },
    async markRunning(id) { const x = runs.get(id); if (!x || x.status !== 'queued') return false; x.status = 'running'; return true; },
    async markDone(id, p) { Object.assign(runs.get(id), p, { status: 'done', error_plain: null, finished_at: new Date() }); },
    async markFailed(id, e) { Object.assign(runs.get(id), { status: 'failed', error_plain: e, finished_at: new Date() }); },
    async setLinks(id, p) { const x = runs.get(id); x.visitor_key_hash = p.visitor_key_hash; x.owner_key_hash = p.owner_key_hash; x.visitor_link_expires_at = p.visitor_link_expires_at; },
    async recordCallback(id, { attempts, lastError = null, callbackFailed = false }) {
      const x = runs.get(id); x.callback_attempts = attempts; x.callback_last_error = lastError; if (callbackFailed) x.status = 'callback_failed';
    },
    async listForOwner(t) { return [...runs.values()].filter((x) => callers.get(x.caller_id)?.owner_tenant_id === t); },
    async getForOwner(t, id) { const x = runs.get(id); return x && callers.get(x.caller_id)?.owner_tenant_id === t ? x : null; },
  };
  return r;
}

function makeCaller(repo, over = {}) {
  const env = { AUDIT_CALLER_KEY: TEST_KEY };
  const caller = {
    caller_id: crypto.randomUUID(), key_id: `wfk_${crypto.randomBytes(6).toString('hex')}`, label: 'Agency under test',
    owner_tenant_id: crypto.randomUUID(), status: 'active', daily_limit: 50, ...encryptSecret(SECRET, env), ...over,
  };
  repo.callers.set(caller.caller_id, caller);
  return caller;
}

async function listen(app) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

/** The audit router on a real port, with fakes behind it. */
async function auditApp({ now = () => Date.now(), env = { AUDIT_CALLER_KEY: TEST_KEY, ARION_PUBLIC_BASE_URL: 'https://audit.example' }, openPdf } = {}) {
  const repo = memoryRepo();
  const started = [];
  const app = express();
  app.use('/audit', createAuditRouter({
    repo,
    runner: { start: async (id, opts) => { started.push({ id, opts }); } },
    findCaller: async (k) => [...repo.callers.values()].find((c) => c.key_id === k && c.status === 'active') || null,
    secretOf: (c) => decryptSecret(c, env),
    openPdf: openPdf || (async () => Readable.from([Buffer.from('%PDF-1.4 fake')])),
    lookup: fakeLookup(),
    env,
    now,
    log: { error() {} },
  }));
  const l = await listen(app);
  return { ...l, repo, started };
}

function runBody(over = {}) {
  return {
    type: 'run',
    run_id: crypto.randomUUID(),
    action: { name: 'any tool name' },
    business: { name: 'Northwind Gardens', website: 'https://northwind.example', phone: '(555) 010-2000', logo_url: null, colours: { primary: '#0a7d4f', text: '#102030' } },
    visitor: { name: 'Sam Test', business: 'Sam Test Plumbing', website: 'samtest.example', email: 'sam@example.test' },
    callback_url: 'https://lumen.example/api/v1/chat-actions/runs/x/result',
    sent_at: new Date().toISOString(),
    ...over,
  };
}

async function post(base, caller, body, { secret = SECRET, at = Date.now(), key = caller?.key_id } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetch(`${base}/audit/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workflow-Key': key || '', 'X-Workflow-Signature': sign(raw, secret, at) },
    body: raw,
  });
  return { status: res.status, json: await res.json() };
}

// ---------------------------------------------------------------------------
describe('signature', () => {
  test('a good signature passes', () => {
    assert.deepEqual(verify(Buffer.from('{"a":1}'), sign('{"a":1}', SECRET), SECRET), { ok: true });
  });
  test('a body signed with another secret is refused', () => {
    assert.deepEqual(verify(Buffer.from('{"a":1}'), sign('{"a":1}', 'another-secret-entirely-000000'), SECRET), { ok: false, error: 'bad_signature' });
  });
  test('a changed body is refused', () => {
    assert.equal(verify(Buffer.from('{"a":2}'), sign('{"a":1}', SECRET), SECRET).error, 'bad_signature');
  });
  test('a request signed 10 minutes ago is refused', () => {
    const t = Date.now() - 10 * 60 * 1000;
    assert.deepEqual(verify(Buffer.from('x'), sign('x', SECRET, t), SECRET), { ok: false, error: 'stale_signature' });
  });
  test('a missing or malformed header is refused', () => {
    assert.equal(verify(Buffer.from('x'), '', SECRET).error, 'bad_signature');
    assert.equal(verify(Buffer.from('x'), 't=1,v1=zz', SECRET).error, 'bad_signature');
  });
});

describe('caller secrets (vault guard)', () => {
  test('AuditNotConfigured on App Service without the key', () => {
    assert.throws(() => callerKey({ WEBSITE_SITE_NAME: 'app-arion-api-prod' }), AuditNotConfigured);
    assert.throws(() => encryptSecret(SECRET, { WEBSITE_SITE_NAME: 'x' }), AuditNotConfigured);
  });
  test('AuditNotConfigured on a laptop without the key too (no placeholder key)', () => {
    assert.throws(() => callerKey({}), AuditNotConfigured);
    assert.throws(() => callerKey({ AUDIT_CALLER_KEY: Buffer.from('short').toString('base64') }), AuditNotConfigured);
  });
  test('the secret is stored encrypted and comes back exactly', () => {
    const env = { AUDIT_CALLER_KEY: TEST_KEY };
    const enc = encryptSecret(SECRET, env);
    assert.ok(!enc.secret_ciphertext.includes(SECRET) && !Buffer.from(enc.secret_ciphertext, 'base64').toString('utf8').includes(SECRET));
    assert.equal(decryptSecret(enc, env), SECRET);
    assert.throws(() => decryptSecret({ ...enc, secret_tag: Buffer.alloc(16).toString('base64') }, env));
  });
});

// ---------------------------------------------------------------------------
describe('POST /audit/runs', () => {
  test('unknown key -> 401 unknown_key', async () => {
    const a = await auditApp();
    try {
      const r = await post(a.base, null, runBody(), { key: 'wfk_nobody' });
      assert.equal(r.status, 401);
      assert.equal(r.json.error, 'unknown_key');
    } finally { await a.close(); }
  });

  test('bad and stale signatures -> 401', async () => {
    const a = await auditApp();
    try {
      const c = makeCaller(a.repo);
      assert.equal((await post(a.base, c, runBody(), { secret: 'wrong-secret-wrong-secret-0000' })).json.error, 'bad_signature');
      assert.equal((await post(a.base, c, runBody(), { at: Date.now() - 600_000 })).json.error, 'stale_signature');
      assert.equal(a.repo.runs.size, 0, 'nothing was queued');
    } finally { await a.close(); }
  });

  test('ping answers with the tool name', async () => {
    const a = await auditApp();
    try {
      const c = makeCaller(a.repo);
      const r = await post(a.base, c, { type: 'ping', run_id: null, action: { name: 'x' }, sent_at: new Date().toISOString() });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { status: 'ok', name: 'Website check' });
    } finally { await a.close(); }
  });

  test('without the caller key the tool answers 503 in plain words', async () => {
    const a = await auditApp({ env: { WEBSITE_SITE_NAME: 'app-arion-api-prod' } });
    try {
      const c = makeCaller(a.repo);
      const r = await post(a.base, c, runBody());
      assert.equal(r.status, 503);
      assert.equal(r.json.message, WORDS.notConfigured);
    } finally { await a.close(); }
  });

  test('a run is accepted, queued once and started', async () => {
    const a = await auditApp();
    try {
      const c = makeCaller(a.repo);
      const body = runBody();
      const r = await post(a.base, c, body);
      assert.equal(r.status, 202);
      assert.deepEqual(r.json, { status: 'accepted' });
      await new Promise((res) => setImmediate(res));
      assert.equal(a.started.length, 1);
      const row = [...a.repo.runs.values()][0];
      assert.equal(row.status, 'queued');
      assert.equal(row.url, 'https://samtest.example/');
      assert.equal(row.url_key, 'samtest.example');
      const v = JSON.parse(row.visitor_json);
      assert.deepEqual(Object.keys(v).sort(), ['business', 'website'], 'only the website and business name of the visitor are kept');
      assert.equal(JSON.parse(row.business_json).colours.primary, '#0a7d4f');
    } finally { await a.close(); }
  });

  test('idempotent by external run id: the same run asked twice is one run', async () => {
    const a = await auditApp();
    try {
      const c = makeCaller(a.repo);
      const body = runBody();
      await post(a.base, c, body);
      const again = await post(a.base, c, { ...body, sent_at: new Date().toISOString() });
      assert.equal(again.status, 202);
      assert.equal(a.repo.runs.size, 1);
      await new Promise((res) => setImmediate(res));
      assert.equal(a.started.length, 1, 'started once');
    } finally { await a.close(); }
  });

  test('one audit per website per day: the second ask gets the same report under new links', async () => {
    const a = await auditApp();
    try {
      const c = makeCaller(a.repo);
      const first = runBody();
      await post(a.base, c, first);
      const row = [...a.repo.runs.values()][0];
      Object.assign(row, { status: 'done', score: 71, summary_plain: 'Three things.', blob_path: 'site-audits/a/b/website-audit.pdf' });
      const second = await post(a.base, c, runBody({ visitor: { website: 'https://SamTest.example/' } }));
      assert.equal(second.status, 200);
      assert.equal(second.json.status, 'done');
      assert.equal(second.json.score, 71);
      assert.match(second.json.file_url, /^https:\/\/audit\.example\/audit\/files\/[0-9a-f-]{36}\?k=/);
      assert.notEqual(second.json.file_url, second.json.owner_file_url);
      assert.equal(a.repo.runs.size, 2, 'a row of its own');
      await new Promise((res) => setImmediate(res));
      assert.equal(a.started.length, 1, 'no second crawl');
    } finally { await a.close(); }
  });

  test('daily limit: over it, the run fails in plain words and nothing is queued', async () => {
    const a = await auditApp();
    try {
      const c = makeCaller(a.repo, { daily_limit: 1 });
      await post(a.base, c, runBody());
      const r = await post(a.base, c, runBody({ visitor: { website: 'other.example' } }));
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { status: 'failed', error: WORDS.dailyLimit });
      assert.equal(a.repo.runs.size, 1);
    } finally { await a.close(); }
  });

  test('a missing website, business name or a non-https callback is a 400', async () => {
    const a = await auditApp();
    try {
      const c = makeCaller(a.repo);
      assert.equal((await post(a.base, c, runBody({ visitor: { email: 'x@y.test' } }))).status, 400);
      assert.equal((await post(a.base, c, runBody({ business: { name: '' } }))).status, 400);
      assert.equal((await post(a.base, c, runBody({ callback_url: 'http://lumen.example/cb' }))).status, 400);
      assert.equal((await post(a.base, c, runBody({ callback_url: 'https://10.0.0.4/cb' }))).status, 400);
      assert.equal(a.repo.runs.size, 0);
    } finally { await a.close(); }
  });
});

// ---------------------------------------------------------------------------
describe('file links', () => {
  async function withDoneRun(nowMs) {
    const a = await auditApp({ now: () => nowMs() });
    const c = makeCaller(a.repo);
    const links = mintLinks('https://audit.example', 'x', Date.now());
    const run_id = crypto.randomUUID();
    a.repo.runs.set(run_id, {
      run_id, caller_id: c.caller_id, status: 'done', blob_path: 'site-audits/c/r/website-audit.pdf',
      business_json: JSON.stringify({ name: 'Northwind Gardens' }),
      visitor_key_hash: links.visitor_key_hash, owner_key_hash: links.owner_key_hash, visitor_link_expires_at: links.visitor_link_expires_at,
    });
    const keyOf = (u) => new URL(u).searchParams.get('k');
    return { a, run_id, visitorKey: keyOf(links.file_url), ownerKey: keyOf(links.owner_file_url) };
  }

  test('file links: the visitor key opens the PDF inline within 30 days', async () => {
    let now = Date.now();
    const { a, run_id, visitorKey } = await withDoneRun(() => now);
    try {
      const res = await fetch(`${a.base}/audit/files/${run_id}?k=${visitorKey}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/pdf');
      assert.match(res.headers.get('content-disposition'), /^inline; filename="website-audit\.pdf"$/);
      assert.equal(res.headers.get('cache-control'), 'private, max-age=0');
      assert.ok(Buffer.from(await res.arrayBuffer()).toString('latin1').startsWith('%PDF'));
    } finally { await a.close(); }
  });

  test('file links: visitor key 410 after 30 days, naming the business', async () => {
    let now = Date.now() + 31 * 24 * 3600 * 1000;
    const { a, run_id, visitorKey } = await withDoneRun(() => now);
    try {
      const res = await fetch(`${a.base}/audit/files/${run_id}?k=${visitorKey}`);
      assert.equal(res.status, 410);
      assert.match(await res.text(), /This link has expired\. Ask Northwind Gardens for a fresh copy\./);
    } finally { await a.close(); }
  });

  test('file links: owner key has no expiry', async () => {
    let now = Date.now() + 400 * 24 * 3600 * 1000;
    const { a, run_id, ownerKey } = await withDoneRun(() => now);
    try {
      const res = await fetch(`${a.base}/audit/files/${run_id}?k=${ownerKey}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/pdf');
    } finally { await a.close(); }
  });

  test('file links: wrong key 404 (and a malformed one, and another run\'s key)', async () => {
    let now = Date.now();
    const { a, run_id, ownerKey } = await withDoneRun(() => now);
    try {
      const wrong = crypto.randomBytes(32).toString('base64url');
      assert.equal((await fetch(`${a.base}/audit/files/${run_id}?k=${wrong}`)).status, 404);
      assert.equal((await fetch(`${a.base}/audit/files/${run_id}?k=short`)).status, 404);
      assert.equal((await fetch(`${a.base}/audit/files/${crypto.randomUUID()}?k=${ownerKey}`)).status, 404);
      const page = await (await fetch(`${a.base}/audit/files/${run_id}?k=${wrong}`)).text();
      assert.match(page, /This link isn(?:'|&#39;)t right/);
    } finally { await a.close(); }
  });

  test('only key hashes are kept', () => {
    const l = mintLinks('https://audit.example', 'r1');
    const k = new URL(l.file_url).searchParams.get('k');
    assert.equal(l.visitor_key_hash, hashKey(k));
    assert.ok(!JSON.stringify({ a: l.visitor_key_hash, b: l.owner_key_hash }).includes(k));
  });
});

// ---------------------------------------------------------------------------
describe('SSRF guard', () => {
  test('private, loopback, link-local, CGNAT, ULA and multicast addresses are blocked', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1']) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
    for (const ip of [PUBLIC_IP, '8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.equal(isBlockedAddress(ip), false, ip);
  });

  test('a website on a private address is refused', async () => {
    await assert.rejects(checkUrl('https://intranet.example/', { lookup: fakeLookup({ 'intranet.example': '10.0.0.5' }), env: {} }),
      (e) => e instanceof SafeFetchRefused && e.code === 'not_public');
    await assert.rejects(checkUrl('http://169.254.169.254/latest/meta-data', { env: {} }), (e) => e.code === 'not_public');
  });

  test('a name that answers one public and one private address is refused', async () => {
    await assert.rejects(checkUrl('https://split.example/', { lookup: fakeLookup({ 'split.example': [PUBLIC_IP, '192.168.0.9'] }), env: {} }),
      (e) => e.code === 'not_public');
  });

  test('a public address passes; odd ports, credentials and other schemes do not', async () => {
    const ok = await checkUrl('https://shop.example/', { lookup: fakeLookup(), env: {} });
    assert.equal(ok.address, PUBLIC_IP);
    await assert.rejects(checkUrl('https://shop.example:8443/', { lookup: fakeLookup(), env: {} }), (e) => e.code === 'not_public');
    await assert.rejects(checkUrl('https://u:p@shop.example/', { lookup: fakeLookup(), env: {} }), (e) => e.code === 'bad_url');
    await assert.rejects(checkUrl('file:///etc/passwd', { env: {} }), (e) => e.code === 'bad_url');
  });

  test('the local exception needs AUDIT_ALLOW_LOCAL and only covers loopback', async () => {
    await assert.rejects(checkUrl('http://127.0.0.1:8084/', { env: {} }), (e) => e.code === 'not_public');
    const ok = await checkUrl('http://127.0.0.1:8084/', { env: { AUDIT_ALLOW_LOCAL: 'true' } });
    assert.equal(ok.address, '127.0.0.1');
    await assert.rejects(checkUrl('http://10.0.0.1/', { env: { AUDIT_ALLOW_LOCAL: 'true' } }), (e) => e.code === 'not_public');
  });

  test('on App Service the local exception is refused', async () => {
    await assert.rejects(checkUrl('http://127.0.0.1:8084/', { env: { AUDIT_ALLOW_LOCAL: 'true', WEBSITE_SITE_NAME: 'app-arion-api-prod' } }),
      (e) => e.code === 'not_public');
  });

  test('https only (the callback): plain http to a public host is refused', async () => {
    await assert.rejects(checkUrl('http://lumen.example/cb', { httpsOnly: true, lookup: fakeLookup(), env: {} }), (e) => e.code === 'not_https');
  });

  describe('against a real local server', () => {
    const env = { AUDIT_ALLOW_LOCAL: 'true' };
    let srv;
    test('setup', async () => {
      const app = express();
      app.get('/redirect-private', (req, res) => res.redirect(302, 'http://internal.example/admin'));
      app.get('/loop', (req, res) => res.redirect(302, '/loop'));
      app.get('/page', (req, res) => res.type('html').send('<html><title>ok</title></html>'));
      app.get('/hop', (req, res) => res.redirect(301, '/page'));
      app.get('/image', (req, res) => res.type('png').send(Buffer.alloc(10)));
      app.get('/huge', (req, res) => res.type('html').send('x'.repeat(3 * 1024 * 1024)));
      srv = await listen(app);
    });
    test('a redirect to a private address is refused at the hop', async () => {
      await assert.rejects(
        safeFetch(`${srv.base}/redirect-private`, { env, lookup: fakeLookup({ 'internal.example': '10.20.30.40' }) }),
        (e) => e instanceof SafeFetchRefused && e.code === 'not_public' && /internal\.example/.test(e.detail),
      );
    });
    test('a safe redirect is followed and recorded', async () => {
      const r = await safeFetch(`${srv.base}/hop`, { env, htmlOnly: true });
      assert.equal(r.status, 200);
      assert.equal(r.url, `${srv.base}/page`);
      assert.deepEqual(r.redirects, [`${srv.base}/page`]);
    });
    test('more than 3 redirects is refused', async () => {
      await assert.rejects(safeFetch(`${srv.base}/loop`, { env }), (e) => e.code === 'too_many_redirects');
    });
    test('non-html is refused for pages', async () => {
      await assert.rejects(safeFetch(`${srv.base}/image`, { env, htmlOnly: true }), (e) => e.code === 'not_html');
    });
    test('the body cap stops a huge page', async () => {
      await assert.rejects(safeFetch(`${srv.base}/huge`, { env, htmlOnly: true }), (e) => e.code === 'too_big');
    });
    test('teardown', async () => { await srv.close(); });
  });
});

// ---------------------------------------------------------------------------
describe('robots', () => {
  test('our own group beats "*", the longest rule wins and Allow wins a tie', () => {
    const p = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: ARGUS-Audit\nDisallow: /private\nAllow: /private/ok\nSitemap: https://s.example/sm.xml');
    assert.equal(isAllowed(p, '/'), true);
    assert.equal(isAllowed(p, '/private/x'), false);
    assert.equal(isAllowed(p, '/private/ok/y'), true);
    assert.deepEqual(p.sitemaps, ['https://s.example/sm.xml']);
    const star = parseRobots('User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\nDisallow: /*.pdf$');
    assert.equal(isAllowed(star, '/wp-admin/x'), false);
    assert.equal(isAllowed(star, '/wp-admin/admin-ajax.php'), true);
    assert.equal(isAllowed(star, '/files/a.pdf'), false);
    assert.equal(isAllowed(star, '/files/a.pdf?x'), true);
    assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow:'), '/'), true, 'an empty Disallow allows everything');
  });
});

// ---------------------------------------------------------------------------
// A fake website for crawl / runner tests
// ---------------------------------------------------------------------------
const HOME_HTML = `<!doctype html><html><head>
<title>Sam Test Plumbing | Fast local plumbers</title>
<meta name="description" content="Family plumbers serving the whole county since 1998. Same-day repairs, fair work.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="canonical" href="https://samtest.example/">
<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Plumber","name":"Sam Test"},{"@type":"WebSite"}]}</script>
</head><body>
<h1>Plumbing done right</h1>
<img src="/a.jpg" alt="van"><img src="/b.jpg">
<a href="/about">About</a> <a href="/contact">Contact us</a> <a href="/missing">Old page</a>
<a href="https://elsewhere.example/">Partner</a> <a href="/brochure.pdf">Brochure</a> <a href="mailto:hi@samtest.example">Email</a>
<a href="tel:+15550102000">(555) 010-2000</a> <a href="/private/area">Staff</a>
</body></html>`;
const ABOUT_HTML = '<html><head><title>About</title></head><body><h1>About</h1><h1>Again</h1><a href="/">Home</a></body></html>';
const CONTACT_HTML = '<html><head><title>Contact Sam Test Plumbing</title><meta name="description" content="short"></head><body><h1>Contact</h1><form></form></body></html>';

function fakeSite({ robots = 'User-agent: *\nDisallow: /private\n', counter = {} } = {}) {
  return async (url, opts = {}) => {
    const u = new URL(url);
    const key = `${opts.method || 'GET'} ${u.protocol}//${u.host}${u.pathname}`;
    counter[key] = (counter[key] || 0) + 1;
    const html = (b) => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(b), url });
    if (u.protocol === 'http:') return { status: 301, headers: { location: `https://${u.host}${u.pathname}` }, body: Buffer.alloc(0), url };
    if (u.host !== 'samtest.example') throw new SafeFetchRefused('unreachable', 'not in the fake');
    switch (u.pathname) {
      case '/robots.txt': return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(robots), url };
      case '/': return { ...html(HOME_HTML), headers: { 'content-type': 'text/html', 'strict-transport-security': 'max-age=1', 'x-content-type-options': 'nosniff' } };
      case '/about': return html(ABOUT_HTML);
      case '/contact': return html(CONTACT_HTML);
      case '/sitemap.xml': return { status: 404, headers: {}, body: Buffer.alloc(0), url };
      default: return { status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('nope'), url };
    }
  };
}

describe('checks on fixture HTML', () => {
  test('title/description length, H1 count, alt, canonical, viewport, JSON-LD types', () => {
    const c = pageChecks(HOME_HTML);
    assert.equal(c.title, 'Sam Test Plumbing | Fast local plumbers');
    assert.equal(c.titleOk, true);
    assert.equal(c.descriptionOk, true);
    assert.equal(c.h1Count, 1);
    assert.equal(c.imagesWithoutAlt, 1);
    assert.equal(c.canonical, true);
    assert.equal(c.viewport, true);
    assert.deepEqual(c.jsonLdTypes.sort(), ['Plumber', 'WebSite']);
    assert.equal(c.hasBusinessSchema, true);
    const about = pageChecks(ABOUT_HTML);
    assert.equal(about.titleOk, false, '"About" is under 10 characters');
    assert.equal(about.description, '');
    assert.equal(about.h1Count, 2);
    assert.equal(about.canonical, false);
    assert.equal(about.viewport, false);
    assert.equal(pageChecks(CONTACT_HTML).descriptionOk, false, 'a 5-character description is too short');
    assert.equal(pageChecks('<html><head><title>x</title><!-- <h1>not counted</h1> --></head><body><script>"<h1>"</script></body></html>').h1Count, 0);
  });

  test('security headers (CSP frame-ancestors counts as the frame protection)', () => {
    assert.deepEqual(securityHeaderChecks({ 'Strict-Transport-Security': 'max-age=1', 'content-security-policy': "frame-ancestors 'self'" }),
      { hsts: true, csp: true, nosniff: false, frame: true, referrer: false });
  });

  test('contact signals', () => {
    assert.deepEqual(contactChecks(HOME_HTML), { telLink: true, phoneShown: true, contactLink: true });
    assert.deepEqual(contactChecks('<p>Call 515-555-0142</p>'), { telLink: false, phoneShown: true, contactLink: false });
  });

  test('typed websites are normalised; the day key ignores case and the trailing slash', () => {
    assert.equal(normaliseSiteUrl('example.com'), 'https://example.com/');
    assert.equal(normaliseSiteUrl('  http://Example.com/shop/ '), 'http://example.com/shop/');
    assert.equal(normaliseSiteUrl('not a site'), null);
    assert.equal(normaliseSiteUrl('javascript:alert(1)'), null);
    assert.equal(urlKey('https://WWW.Example.com/shop/'), 'www.example.com/shop');
  });
});

describe('crawl', () => {
  test('same host only, robots honoured, assets skipped, broken links found', async () => {
    const counter = {};
    const r = await crawl('https://samtest.example/', { fetch: fakeSite({ counter }) });
    const urls = r.pages.map((p) => p.url);
    assert.deepEqual(urls, ['https://samtest.example/', 'https://samtest.example/about', 'https://samtest.example/contact']);
    assert.ok(!counter['GET https://samtest.example/private/area'], 'robots Disallow is honoured');
    assert.ok(!counter['GET https://elsewhere.example/'] && !counter['HEAD https://elsewhere.example/'], 'other hosts are never fetched');
    assert.ok(!Object.keys(counter).some((k) => k.includes('brochure.pdf')), 'assets are skipped');
    assert.deepEqual(r.linkChecks.broken, ['https://samtest.example/missing']);
    assert.equal(r.httpsRedirect, true);
    assert.equal(r.sitemapPresent, false);
    assert.equal(r.homepage.security.hsts, true);
    assert.equal(r.robots.blocked, false);
  });

  test('never more than 10 pages', async () => {
    const many = `<html><head><title>Home page title here</title></head><body>${Array.from({ length: 40 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join('')}</body></html>`;
    const fetchFake = async (url, opts = {}) => {
      const u = new URL(url);
      if (u.pathname === '/robots.txt') return { status: 404, headers: {}, body: Buffer.alloc(0), url };
      if (opts.method === 'HEAD') return { status: 200, headers: {}, body: Buffer.alloc(0), url };
      return { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(u.pathname === '/' ? many : '<html><title>a page title</title></html>'), url };
    };
    const r = await crawl('https://big.example/', { fetch: fetchFake });
    assert.equal(r.pages.length, 10);
  });

  test('robots disallow-all skips the page checks', async () => {
    const counter = {};
    const r = await crawl('https://samtest.example/', { fetch: fakeSite({ robots: 'User-agent: *\nDisallow: /\n', counter }) });
    assert.equal(r.robots.blocked, true);
    assert.equal(r.pages.length, 0);
    assert.ok(!counter['GET https://samtest.example/'], 'the home page content is not read');
    assert.ok(counter['HEAD https://samtest.example/'], 'only its headers');
    const s = scoreAudit({ crawl: r, psiMobile: { scores: { performance: 70, seo: 90 }, metrics: {}, opportunities: [] } });
    assert.deepEqual(s.notes, [ROBOTS_BLOCKED_SENTENCE]);
    assert.equal(s.sections.find((x) => x.key === 'leads').score, null);
    assert.notEqual(s.sections.find((x) => x.key === 'trust').score, null, 'security is still checked');
  });
});

// ---------------------------------------------------------------------------
const JARGON = /\b(LCP|CLS|INP|FCP|TTFB|TBT|Lighthouse|PageSpeed|PSI|SEO|DOM|HTTP|HSTS|CSP|JSON|schema\.org|canonical|viewport|robots\.txt|crawl|SERanking|Google API)\b/i;

describe('score bands and sentences', () => {
  test('bands', () => {
    assert.equal(bandSentence(80), 'This is in good shape.');
    assert.equal(bandSentence(79), 'This is holding you back a little.');
    assert.equal(bandSentence(50), 'This is holding you back a little.');
    assert.equal(bandSentence(49), 'This is likely costing you visitors.');
  });

  test('no jargon in any sentence, and the slow-phone sentence is concrete', async () => {
    const r = await crawl('https://samtest.example/', { fetch: fakeSite() });
    const psi = {
      scores: { performance: 34, seo: 82 },
      metrics: { lcp: { value: 6200 } },
      opportunities: Object.keys(SPEED_WORDS).map((id) => ({ id, title: 'Eliminate render-blocking resources (Lighthouse)' })).concat([{ id: 'something-new', title: 'Reduce LCP' }]),
    };
    const s = scoreAudit({ crawl: r, psiMobile: psi, psiDesktop: psi });
    const sentences = [s.sentence, s.summary_plain, ...s.sections.flatMap((x) => [x.verdict, ...x.findings]), ...Object.values(SPEED_WORDS)];
    for (const line of sentences) assert.doesNotMatch(line, JARGON, line);
    const speed = s.sections.find((x) => x.key === 'speed');
    assert.equal(speed.score, 34);
    assert.equal(speed.findings[0], 'Your phone visitors wait about 6 seconds before they see your page. Most people leave after 3.');
    assert.ok(speed.findings.length <= 3);
    assert.equal(s.topFindings.length, 3);
    assert.ok(s.summary_plain.length <= 500);
    const google = s.sections.find((x) => x.key === 'google');
    assert.ok(google.findings.some((f) => /1 of your 3 pages has no description, so Google writes its own\./.test(f)), google.findings.join(' | '));
    assert.ok(s.score > 0 && s.score < 100);
  });

  test('speed not measured: no score and says so; overall uses what was measured', async () => {
    const r = await crawl('https://samtest.example/', { fetch: fakeSite() });
    const s = scoreAudit({ crawl: r });
    const speed = s.sections.find((x) => x.key === 'speed');
    assert.equal(speed.score, null);
    assert.equal(speed.verdict, "We couldn't measure speed this time.");
    assert.equal(typeof s.score, 'number');
  });
});

// ---------------------------------------------------------------------------
/** The text Chromium painted into a PDF: inflate the streams, read each font's ToUnicode map. */
function pdfText(buf) {
  const s = buf.toString('latin1');
  const objs = new Map();
  for (const m of s.matchAll(/(\d+) 0 obj([\s\S]*?)endobj/g)) {
    const body = m[2];
    const si = body.indexOf('stream');
    let dict = body;
    let stream = null;
    if (si >= 0) {
      dict = body.slice(0, si);
      const start = m.index + m[0].indexOf(m[2]) + si + 'stream'.length + (body[si + 6] === '\r' ? 2 : 1);
      const end = s.indexOf('endstream', start);
      const raw = buf.subarray(start, end);
      try { stream = /FlateDecode/.test(dict) ? zlib.inflateSync(raw).toString('latin1') : raw.toString('latin1'); } catch { stream = ''; }
    }
    objs.set(m[1], { dict, stream });
  }
  const cmapOf = (text) => {
    const map = new Map();
    for (const b of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const p of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(parseInt(p[1], 16), Buffer.from(p[2], 'hex').swap16().toString('utf16le'));
    }
    for (const b of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const p of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        const lo = parseInt(p[1], 16); const hi = parseInt(p[2], 16); const dst = parseInt(p[3], 16);
        for (let c = lo; c <= hi; c++) map.set(c, String.fromCodePoint(dst + (c - lo)));
      }
    }
    return map;
  };
  const fontMaps = new Map(); // resource name -> cmap
  for (const { dict } of objs.values()) {
    const fonts = /\/Font\s*<<([^>]*)>>/.exec(dict);
    if (!fonts) continue;
    for (const f of fonts[1].matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) {
      const fontObj = objs.get(f[2]);
      const tu = fontObj && /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(fontObj.dict);
      if (tu && objs.get(tu[1])?.stream) fontMaps.set(f[1], cmapOf(objs.get(tu[1]).stream));
    }
  }
  let out = '';
  for (const { stream } of objs.values()) {
    if (!stream || !/\bBT\b/.test(stream)) continue;
    let cmap = null;
    for (const t of stream.matchAll(/\/(\w+)\s+[\d.]+\s+Tf|<([0-9a-fA-F]*)>|\bET\b/g)) {
      if (t[1]) cmap = fontMaps.get(t[1]) || null;
      else if (t[2] !== undefined && cmap) for (let i = 0; i + 4 <= t[2].length; i += 4) out += cmap.get(parseInt(t[2].slice(i, i + 4), 16)) ?? '';
      else if (t[0] === 'ET') out += ' ';
    }
  }
  return out;
}
const squash = (x) => String(x).replace(/\s+/g, '');

describe('report', () => {
  const business = { name: 'Northwind Gardens', phone: '(555) 010-2000', website: 'https://northwind.example/', colours: { primary: '#0a7d4f', text: '#102030', accent: 'red; background:url(x)' } };

  async function result() {
    const r = await crawl('https://samtest.example/', { fetch: fakeSite() });
    return scoreAudit({ crawl: r, psiMobile: { scores: { performance: 41, seo: 80 }, metrics: { lcp: { value: 5100 } }, opportunities: [{ id: 'modern-image-formats' }] } });
  }

  test('report HTML carries business.name and the colours, refuses odd colours, and names no one else', async () => {
    const html = renderReportHtml({ business, visitor: { business: 'Sam Test Plumbing' }, url: 'https://samtest.example/', result: await result(), now: new Date('2026-10-07T12:00:00Z') });
    assert.match(html, /Northwind Gardens/);
    assert.match(html, /Prepared by <strong>Northwind Gardens<\/strong> · \(555\) 010-2000 · northwind\.example/);
    assert.match(html, /#0a7d4f/);
    assert.match(html, /#102030/);
    assert.doesNotMatch(html, /url\(x\)/, 'a colour that is not hex is replaced');
    assert.match(html, /Website check for Sam Test Plumbing/);
    assert.match(html, /7 October 2026/);
    assert.doesNotMatch(html, /Intelligent Analytics|intelligentanalyticsdm/i);
    assert.doesNotMatch(html, /\$\s?\d|price|per month/i, 'no price');
    assert.doesNotMatch(html, /Sam Test<|sam@example/, "no visitor's personal details");
    assert.deepEqual(brandColours({ primary: 'javascript:1' }).primary, '#1f2937');
  });

  test('a visitor business name with markup is escaped', async () => {
    const html = renderReportHtml({ business, visitor: { business: '<script>alert(1)</script>' }, url: 'https://samtest.example/', result: await result() });
    assert.doesNotMatch(html, /<script>alert/);
  });

  test('PDF render through an injected renderer seam: the browser is always closed', async () => {
    const events = [];
    const fakeBrowser = {
      async newContext(opts) {
        events.push(`context js=${opts.javaScriptEnabled}`);
        return { async newPage() { return { async route() { events.push('route-all-blocked'); }, async setContent() { events.push('content'); }, async pdf() { return Buffer.from('%PDF-fake'); } }; } };
      },
      async close() { events.push('closed'); },
    };
    const pdf = await renderPdf('<p>x</p>', { launch: async () => fakeBrowser });
    assert.equal(pdf.toString(), '%PDF-fake');
    assert.deepEqual(events, ['context js=false', 'route-all-blocked', 'content', 'closed']);
    const failing = { ...fakeBrowser, async newContext() { throw new Error('boom'); }, async close() { events.push('closed-after-fail'); } };
    await assert.rejects(renderPdf('<p>x</p>', { launch: async () => failing }));
    assert.equal(events.at(-1), 'closed-after-fail');
  });

  test('a real PDF: one Letter page with the score, the five sections and the agency name in it', { timeout: 60_000 }, async () => {
    const res = await result();
    const html = renderReportHtml({ business, visitor: { business: 'Sam Test Plumbing' }, url: 'https://samtest.example/', result: res, now: new Date('2026-10-07T12:00:00Z') });
    const pdf = await renderPdf(html);
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
    assert.equal(pages, 1, 'one page');
    assert.match(pdf.toString('latin1'), /\/MediaBox\s*\[0 0 612 792\]/, 'Letter size');
    const text = squash(pdfText(pdf));
    for (const words of ['Website check for Sam Test Plumbing', 'Northwind Gardens', 'Prepared by', 'Speed', 'Found on Google', 'Trust & security',
      'Works on phones', 'Turns visitors into leads', String(res.score), res.sentence, res.topFindings[0], '7 October 2026']) {
      assert.ok(text.includes(squash(words)), `"${words}" is not on the PDF`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('runner', () => {
  function setup({ callbackStatus = () => 200, site = fakeSite(), renderPdfFn = async () => Buffer.from('%PDF-1.4 fake'), pagespeed } = {}) {
    const repo = memoryRepo();
    const caller = makeCaller(repo);
    const callbacks = [];
    const sleeps = [];
    const fetchAll = async (url, opts = {}) => {
      if (url.startsWith('https://lumen.example/')) {
        callbacks.push({ url, opts });
        const s = callbackStatus(callbacks.length);
        if (s instanceof Error) throw s;
        return { status: s, headers: {}, body: Buffer.from('{"ok":true}'), url };
      }
      return site(url, opts);
    };
    const runner = createAuditRunner({
      repo,
      callerSecret: async (id) => { const c = repo.callers.get(id); return { caller: c, secret: decryptSecret(c, { AUDIT_CALLER_KEY: TEST_KEY }) }; },
      fetch: fetchAll,
      lookup: fakeLookup(),
      env: {},
      pagespeed: pagespeed || (async (url, strategy) => ({ strategy, scores: { performance: strategy === 'mobile' ? 55 : 80, seo: 90 }, metrics: { lcp: { value: 3900 } }, opportunities: [{ id: 'server-response-time' }] })),
      renderPdf: renderPdfFn,
      storePdf: async ({ callerId, runId }) => `site-audits/${callerId}/${runId}/website-audit.pdf`,
      sleep: async (ms) => { sleeps.push(ms); },
      publicBase: 'https://audit.example',
      log: { error() {} },
    });
    const queue = async (over = {}) => {
      const r = await repo.insertRun({
        caller_id: caller.caller_id, external_run_id: crypto.randomUUID(), url: 'https://samtest.example/', url_key: 'samtest.example',
        audit_day: '2026-10-07', status: 'queued', callback_url: 'https://lumen.example/api/v1/chat-actions/runs/x/result',
        business_json: JSON.stringify({ name: 'Northwind Gardens', colours: {} }), visitor_json: JSON.stringify({ business: 'Sam Test Plumbing' }), ...over,
      });
      return r.run_id;
    };
    return { repo, caller, runner, callbacks, sleeps, queue };
  }

  test('a run goes queued -> done, and the callback is signed with the caller secret', async () => {
    const t = setup();
    const id = await t.queue();
    const out = await t.runner.runNow(id);
    const row = t.repo.runs.get(id);
    assert.equal(row.status, 'done');
    assert.equal(typeof row.score, 'number');
    assert.match(row.blob_path, /^site-audits\/[0-9a-f-]+\/[0-9a-f-]+\/website-audit\.pdf$/);
    assert.equal(row.visitor_key_hash.length, 64);
    assert.ok(new Date(row.visitor_link_expires_at).getTime() > Date.now() + 29 * 24 * 3600 * 1000);
    assert.equal(t.callbacks.length, 1);
    const cb = t.callbacks[0];
    assert.equal(cb.opts.httpsOnly, true, 'the callback must be https');
    assert.equal(cb.opts.headers['X-Workflow-Key'], t.caller.key_id);
    assert.equal(cb.opts.headers['X-Workflow-Run'], row.external_run_id);
    assert.deepEqual(verify(Buffer.from(cb.opts.body), cb.opts.headers['X-Workflow-Signature'], SECRET), { ok: true });
    const body = JSON.parse(cb.opts.body);
    assert.equal(body.status, 'done');
    assert.equal(body.score, row.score);
    assert.match(body.file_url, /^https:\/\/audit\.example\/audit\/files\//);
    assert.equal(hashKey(new URL(body.file_url).searchParams.get('k')), row.visitor_key_hash);
    assert.equal(hashKey(new URL(body.owner_file_url).searchParams.get('k')), row.owner_key_hash);
    assert.equal(out.delivered, true);
    assert.equal(row.callback_attempts, 1);
  });

  test('the callback is retried 3 times (0 s, 60 s, 300 s), then callback_failed', async () => {
    const t = setup({ callbackStatus: () => 503 });
    const id = await t.queue();
    const out = await t.runner.runNow(id);
    assert.equal(t.callbacks.length, 3);
    assert.deepEqual(t.sleeps, [60_000, 240_000]);
    const row = t.repo.runs.get(id);
    assert.equal(row.status, 'callback_failed');
    assert.equal(row.callback_attempts, 3);
    assert.match(row.callback_last_error, /503/);
    assert.equal(out.delivered, false);
  });

  test('a 4xx from the caller is final (no retry)', async () => {
    const t = setup({ callbackStatus: () => 409 });
    const id = await t.queue();
    await t.runner.runNow(id);
    assert.equal(t.callbacks.length, 1);
    assert.equal(t.repo.runs.get(id).status, 'callback_failed');
  });

  test('a network error is retried and the second attempt can land', async () => {
    const t = setup({ callbackStatus: (n) => (n === 1 ? Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }) : 200) });
    const id = await t.queue();
    await t.runner.runNow(id);
    assert.equal(t.callbacks.length, 2);
    assert.equal(t.repo.runs.get(id).status, 'done');
  });

  test('a website we cannot reach fails in plain words, and the caller is told', async () => {
    const t = setup({ site: async () => { throw new SafeFetchRefused('unreachable', 'ECONNREFUSED'); } });
    const id = await t.queue();
    await t.runner.runNow(id);
    const row = t.repo.runs.get(id);
    assert.equal(row.status, 'failed');
    assert.equal(row.error_plain, PLAIN.unreachable);
    assert.deepEqual(JSON.parse(t.callbacks[0].opts.body), { status: 'failed', error: PLAIN.unreachable });
  });

  test('a private website fails as "not a public website" and is not retried', async () => {
    let calls = 0;
    const t = setup({ site: async (url) => { if (new URL(url).pathname === '/') calls += 1; throw new SafeFetchRefused('not_public', '10.0.0.1'); } });
    const id = await t.queue();
    await t.runner.runNow(id);
    assert.equal(t.repo.runs.get(id).error_plain, PLAIN.notPublic);
    assert.equal(calls, 1);
  });

  test('a PDF that cannot be painted twice fails as "the report couldn\'t be made"', async () => {
    let paints = 0;
    const t = setup({ renderPdfFn: async () => { paints += 1; throw new Error('chromium gone'); } });
    const id = await t.queue();
    await t.runner.runNow(id);
    assert.equal(paints, 2, 'one retry');
    assert.equal(t.repo.runs.get(id).error_plain, PLAIN.noReport);
  });

  test('both speed tests failing still finishes, with speed not measured', async () => {
    const t = setup({ pagespeed: async () => null });
    const id = await t.queue();
    await t.runner.runNow(id);
    const row = t.repo.runs.get(id);
    assert.equal(row.status, 'done');
    const f = JSON.parse(row.findings_json);
    assert.equal(f.sections.find((s) => s.key === 'speed').verdict, "We couldn't measure speed this time.");
  });

  test('a run that is not queued is left alone (no double run)', async () => {
    const t = setup();
    const id = await t.queue({ status: 'running' });
    assert.deepEqual(await t.runner.runNow(id), { skipped: true });
    assert.equal(t.callbacks.length, 0);
  });

  test('at most two audits at a time', async () => {
    let active = 0; let peak = 0;
    const t = setup({ renderPdfFn: async () => { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 20)); active -= 1; return Buffer.from('%PDF'); } });
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await t.queue());
    await Promise.all(ids.map((id) => t.runner.start(id)));
    assert.equal(peak, 2);
    assert.ok(ids.every((id) => t.repo.runs.get(id).status === 'done'));
  });
});

// ---------------------------------------------------------------------------
describe('owner GET', () => {
  test("only the caller's owner business sees its runs", async () => {
    const repo = memoryRepo();
    const mine = makeCaller(repo);
    const theirs = makeCaller(repo);
    const a = (await repo.insertRun({ caller_id: mine.caller_id, external_run_id: 'a', url: 'https://a.example/', status: 'done', blob_path: 'site-audits/x/y/website-audit.pdf' })).run_id;
    const b = (await repo.insertRun({ caller_id: theirs.caller_id, external_run_id: 'b', url: 'https://b.example/', status: 'done' })).run_id;
    const app = express();
    app.use((req, res, next) => { req.tenant = { tenantId: mine.owner_tenant_id }; next(); });
    app.use('/arion/audit', createSiteAuditsRouter({ repo, openPdf: async () => Readable.from([Buffer.from('%PDF-1.4')]), log: { error() {} } }));
    const l = await listen(app);
    try {
      const list = await (await fetch(`${l.base}/arion/audit/runs`)).json();
      assert.deepEqual(list.data.map((x) => x.run_id), [a]);
      assert.equal(list.data[0].file_path, `/arion/audit/runs/${a}/file`);
      assert.ok(!JSON.stringify(list).includes('key_hash'), 'no key hashes leave');
      assert.equal((await fetch(`${l.base}/arion/audit/runs/${b}`)).status, 404);
      const file = await fetch(`${l.base}/arion/audit/runs/${a}/file`);
      assert.equal(file.status, 200);
      assert.equal(file.headers.get('content-type'), 'application/pdf');
      assert.equal((await fetch(`${l.base}/arion/audit/runs/${b}/file`)).status, 404);
    } finally { await l.close(); }
  });
});

// ---------------------------------------------------------------------------
const AUDIT_FILES = [
  ...fs.readdirSync(path.join(REPO, 'lib/audit')).map((f) => `lib/audit/${f}`),
  'routes/audit.js', 'routes/arion/siteAudits.js', 'scripts/register-audit-caller.mjs', 'scripts/dev/exercise-site-audit-dev.mjs',
  'db/migrations/067_site_audit.sql',
];
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/\s.*$/gm, '')
  .replace(/^\s*--.*$/gm, '');

describe('nothing belongs to one business', () => {
  test('no lib/audit file imports the paid SEO or intelligence code', () => {
    const all = [];
    for (const f of fs.readdirSync(path.join(REPO, 'lib/audit'))) {
      const src = fs.readFileSync(path.join(REPO, 'lib/audit', f), 'utf8');
      // import x from '…', import '…' (side effect only), import('…'), export … from '…', require('…')
      const imports = [...src.matchAll(/(?:\bimport\s[^'";]*?from\s*|\bimport\s*\(?\s*|\bexport\s[^'";]*?from\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
      all.push(...imports);
      for (const i of imports) assert.doesNotMatch(i, /seranking|intelligence|\/seo\b/i, `${f} imports ${i}`);
    }
    // Presence: the scan really read the imports (the runner reuses the free speed test).
    assert.ok(all.includes('../pagespeed.js'), 'the import scan found nothing');
  });

  test('no-hardcoded-business: no business name, address, id or service words in this build', () => {
    for (const rel of AUDIT_FILES) {
      const full = path.join(REPO, rel);
      assert.ok(fs.existsSync(full), `${rel} exists`);
      const src = stripComments(fs.readFileSync(full, 'utf8'));
      assert.doesNotMatch(src, /Intelligent Analytics|intelligentanalyticsdm/i, rel);
      assert.doesNotMatch(src, /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, `${rel} has a UUID literal`);
      assert.doesNotMatch(src, /Web Design|Website audit/, `${rel} has one business's service words`);
    }
  });

  test('the visitor is never texted: no SMS path in this build', () => {
    for (const rel of AUDIT_FILES) {
      const src = stripComments(fs.readFileSync(path.join(REPO, rel), 'utf8'));
      assert.doesNotMatch(src, /smsSender|sendSms|sendText|twilio|from\s+['"][^'"]*sms[^'"]*['"]|require\(\s*['"][^'"]*sms/i, rel);
    }
  });
});

describe('page findings read naturally', () => {
  const page = (over = {}) => ({ checks: { title: 'A good page title', titleOk: true, description: '', descriptionOk: false, h1Ok: true, canonical: true, imagesWithoutAlt: 0, hasBusinessSchema: true, ...over } });
  const google = (pages) => scoreAudit({ crawl: { pages, sitemapPresent: true, homepage: null, robots: {} } }).sections.find((s) => s.key === 'google').findings;
  test('one page read: "Your home page has…"', () => {
    assert.ok(google([page()]).includes('Your home page has no description, so Google writes its own.'));
  });
  test('every page: "All 4 of your pages have…"', () => {
    assert.ok(google([page(), page(), page(), page()]).includes('All 4 of your pages have no description, so Google writes its own.'));
  });
  test('some pages: singular and plural verbs', () => {
    const ok = { description: 'A description long enough to count as a real description for Google.', descriptionOk: true };
    assert.ok(google([page(), page(ok), page(ok)]).includes('1 of your 3 pages has no description, so Google writes its own.'));
    assert.ok(google([page(), page(), page(ok)]).includes('2 of your 3 pages have no description, so Google writes its own.'));
  });
});
