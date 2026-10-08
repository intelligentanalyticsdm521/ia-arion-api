/**
 * The website check — any agency's custom action (contract
 * CONTRACT_ARGUS_CHAT_PLAYBOOKS_2026-10-07.md §E, tests §G.2).
 *
 * Fakes stand in for PageSpeed, the website, the blob store and the caller's
 * callback. The SSRF tests talk to real sockets on 127.0.0.1 with a fake DNS.
 * The report tests paint REAL PDFs with pdfkit (no browser: production has none)
 * and read the words back out of them.
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
 *   (fixes of 7 Oct 2026) A3c-e IPv6 as bytes, R1-2 robots matcher, H1-4 HTML
 *   scanner and entities, C1-2 contact check, B1-3 robots-blocked report,
 *   W1-2 report words, L1 stable links, S1-4 slots and the cap, T1-3 lost
 *   runs, D1-2 daily limit, K1 signed run id, P1-2 caller re-registration.
 *   (fixes of 8 Oct 2026) H5-H8 one-walk tag reader and forms, H9 the 512 KB
 *   page cap, H10 the 4 KB attribute cap, R3 the robots path cap, E1-E4 true
 *   failure sentences, E5 "tomorrow" in the daily-limit words.
 *   (8 Oct 2026, the PDF without a browser) F1 "Prepared by <agency>" on the
 *   paper, F2 the findings on the paper, F3 no playwright in the report module.
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
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

import { sign, verify } from '../lib/audit/signature.js';
import { AuditNotConfigured, callerKey, encryptSecret, decryptSecret, planCallerUpsert, upsertCaller, CallerChangeRefused } from '../lib/audit/callers.js';
import { safeFetch, checkUrl, isBlockedAddress, SafeFetchRefused } from '../lib/audit/safeFetch.js';
import { parseRobots, isAllowed } from '../lib/audit/robots.js';
import { pageChecks, securityHeaderChecks, contactChecks, anchorsOf, attrsOf, MAX_HTML, MAX_TAG, MAX_TAGS } from '../lib/audit/checks.js';
import { crawl, normaliseSiteUrl, urlKey } from '../lib/audit/crawl.js';
import { scoreAudit, bandSentence, SPEED_WORDS, ROBOTS_BLOCKED_SENTENCE } from '../lib/audit/score.js';
import { renderReportHtml, renderPdf, brandColours } from '../lib/audit/report.js';
import { mintLinks, hashKey, linksFor } from '../lib/audit/links.js';
import { STALE } from '../lib/audit/runs.js';
import { createAuditRunner, PLAIN } from '../lib/audit/runner.js';
import { createAuditRouter, WORDS } from '../routes/audit.js';
import { createSiteAuditsRouter } from '../routes/arion/siteAudits.js';

const REPO = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const TEST_KEY = crypto.randomBytes(32).toString('base64');
const SECRET = 'test-secret-0123456789abcdef0123456789';
const PUBLIC_IP = '93.184.216.34';
/**
 * Run `fnSource` (an async (repoRootUrl) => result function, as text) in a
 * worker thread. Rejects when it is not finished by `ms`: a synchronous
 * runaway (catastrophic regex backtracking) cannot be interrupted in this
 * thread, so timing tests run their work over there.
 */
function timedInWorker(fnSource, ms) {
  return new Promise((resolve, reject) => {
    const w = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      (${fnSource})(workerData.root).then((out) => parentPort.postMessage({ out }), (e) => parentPort.postMessage({ error: String(e && e.stack || e) }));`,
    { eval: true, workerData: { root: pathToFileURL(`${REPO}/`).href } });
    const timer = setTimeout(() => { w.terminate(); reject(new Error(`still running after ${ms} ms`)); }, ms);
    w.once('message', (m) => { clearTimeout(timer); w.terminate(); if (m.error) reject(new Error(m.error)); else resolve(m); });
    w.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
}


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
    async insertRun(p, { dailyLimit = null } = {}) {
      // No await between the count and the insert: the same one-step promise
      // the SQL repo keeps with its per-caller, per-day lock.
      const dup = [...runs.values()].find((x) => x.caller_id === p.caller_id && x.external_run_id === p.external_run_id);
      if (dup) return { run_id: dup.run_id, inserted: false };
      if (dailyLimit != null) {
        const used = [...runs.values()].filter((x) => x.caller_id === p.caller_id && x.audit_day === p.audit_day && !x.copied_from_run_id).length;
        if (used >= dailyLimit) return { overLimit: true, inserted: false, run_id: null };
      }
      const run_id = crypto.randomUUID();
      runs.set(run_id, { callback_attempts: 0, run_attempts: 0, created_at: new Date(), ...p, run_id });
      return { run_id, inserted: true };
    },
    async markRunning(id) {
      const x = runs.get(id); if (!x || x.status !== 'queued') return false;
      Object.assign(x, { status: 'running', started_at: new Date(), run_attempts: (x.run_attempts || 0) + 1 }); return true;
    },
    async reviveStale(id, { failPlain, stale = STALE } = {}) {
      const x = runs.get(id); if (!x) return null;
      const now = Date.now();
      const runningOld = x.status === 'running' && x.started_at && now - new Date(x.started_at).getTime() > stale.runningSeconds * 1000;
      if (runningOld && (x.run_attempts || 0) >= stale.maxAttempts) { Object.assign(x, { status: 'failed', error_plain: failPlain, finished_at: new Date() }); return 'failed'; }
      if (runningOld) { Object.assign(x, { status: 'queued', started_at: null }); return 'restart'; }
      if (x.status === 'queued' && now - new Date(x.created_at).getTime() > stale.queuedSeconds * 1000) return 'restart';
      return null;
    },
    async listStale({ stale = STALE } = {}) {
      const now = Date.now();
      return [...runs.values()].filter((x) => (x.status === 'queued' && now - new Date(x.created_at).getTime() > stale.queuedSeconds * 1000)
        || (x.status === 'running' && x.started_at && now - new Date(x.started_at).getTime() > stale.runningSeconds * 1000)).map((x) => x.run_id);
    },
    async markDone(id, p) { Object.assign(runs.get(id), p, { status: 'done', error_plain: null, finished_at: new Date() }); },
    async markFailed(id, e) { Object.assign(runs.get(id), { status: 'failed', error_plain: e, finished_at: new Date() }); },
    async setLinks(id, p) { const x = runs.get(id); if (x.visitor_key_hash || x.owner_key_hash) return; x.visitor_key_hash = p.visitor_key_hash; x.owner_key_hash = p.owner_key_hash; x.visitor_link_expires_at = p.visitor_link_expires_at; },
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

  test('re-registering a key id cannot quietly move it to another business or switch it back on', async () => {
    const owner = crypto.randomUUID();
    const existing = { key_id: 'wfk_abcd', owner_tenant_id: owner.toUpperCase(), status: 'active' };
    assert.equal(planCallerUpsert(null, { ownerTenantId: owner }).action, 'insert');
    assert.equal(planCallerUpsert(existing, { ownerTenantId: owner }).action, 'update', 'same owner (any case): replace the secret');
    const moved = planCallerUpsert(existing, { ownerTenantId: crypto.randomUUID() });
    assert.ok(moved.refuse instanceof CallerChangeRefused && moved.refuse.code === 'owner_change');
    assert.match(moved.refuse.message, /Nothing was changed\. Re-run with --move-owner/);
    assert.equal(planCallerUpsert(existing, { ownerTenantId: crypto.randomUUID(), moveOwner: true }).ownerChanged, true);
    const off = { ...existing, status: 'revoked' };
    assert.equal(planCallerUpsert(off, { ownerTenantId: owner }).refuse.code, 'inactive');
    assert.equal(planCallerUpsert(off, { ownerTenantId: owner, reactivate: true }).action, 'update');

    // upsertCaller itself refuses before it writes anything.
    const queries = [];
    const pool = { request() { const r = { input() { return r; }, async query(text) { queries.push(text); return { recordset: [existing] }; } }; return r; } };
    await assert.rejects(upsertCaller(pool, { keyId: 'wfk_abcd', label: 'x', ownerTenantId: crypto.randomUUID(), secret: SECRET }, { AUDIT_CALLER_KEY: TEST_KEY }),
      (e) => e instanceof CallerChangeRefused && e.code === 'owner_change');
    assert.equal(queries.length, 1, 'only the read ran');
    assert.doesNotMatch(queries[0], /UPDATE|INSERT/);
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
      assert.deepEqual(r.json, { status: 'failed', error: WORDS.dailyLimit });      assert.match(WORDS.dailyLimit, /Reply to this visitor yourself/, 'it says what to do');

      assert.equal(a.repo.runs.size, 1);
    } finally { await a.close(); }
  });


  test('a repeat ask of a delivered run answers with the same links, and the old links keep working', async () => {
    const env = { AUDIT_CALLER_KEY: TEST_KEY, ARION_PUBLIC_BASE_URL: 'https://audit.example' };
    const a = await auditApp({ env });
    try {
      const c = makeCaller(a.repo);
      const body = runBody();
      await post(a.base, c, body);
      const row = [...a.repo.runs.values()][0];
      // What the runner writes when the audit finishes.
      const first = mintLinks(a.base, row.run_id, Date.now(), env);
      Object.assign(row, { status: 'done', score: 64, summary_plain: 'Two things.', blob_path: 'site-audits/a/b/website-audit.pdf',
        visitor_key_hash: first.visitor_key_hash, owner_key_hash: first.owner_key_hash, visitor_link_expires_at: first.visitor_link_expires_at });
      const opens = async (u) => (await fetch(`${a.base}${new URL(u).pathname}${new URL(u).search}`)).status;
      assert.equal(await opens(first.owner_file_url), 200);
      for (const status of ['done', 'callback_failed']) {
        row.status = status;
        const again = await post(a.base, c, { ...body, sent_at: new Date().toISOString() });
        assert.equal(again.status, 200);
        assert.equal(again.json.status, 'done');
        assert.equal(new URL(again.json.owner_file_url).search, new URL(first.owner_file_url).search, `${status}: the same owner link`);
        assert.equal(new URL(again.json.file_url).search, new URL(first.file_url).search, `${status}: the same visitor link`);
        assert.equal(row.owner_key_hash, first.owner_key_hash, 'the stored hash is untouched');
        assert.equal(await opens(first.owner_file_url), 200, `${status}: the lead's link still opens`);
        assert.equal(await opens(first.file_url), 200, `${status}: the emailed link still opens`);
      }
    } finally { await a.close(); }
  });

  test('a same-website copy gets links of its own and the first run keeps its links', async () => {
    const env = { AUDIT_CALLER_KEY: TEST_KEY, ARION_PUBLIC_BASE_URL: 'https://audit.example' };
    const a = await auditApp({ env });
    try {
      const c = makeCaller(a.repo);
      await post(a.base, c, runBody());
      const row = [...a.repo.runs.values()][0];
      const first = mintLinks(a.base, row.run_id, Date.now(), env);
      Object.assign(row, { status: 'done', score: 70, summary_plain: 'x', blob_path: 'site-audits/a/b/website-audit.pdf',
        visitor_key_hash: first.visitor_key_hash, owner_key_hash: first.owner_key_hash, visitor_link_expires_at: first.visitor_link_expires_at });
      const copy = await post(a.base, c, runBody());
      assert.equal(copy.json.status, 'done');
      assert.notEqual(copy.json.owner_file_url, first.owner_file_url);
      const copyRow = [...a.repo.runs.values()].find((x) => x.run_id !== row.run_id);
      assert.equal(copyRow.copied_from_run_id, row.run_id, 'marked as a copy');
      assert.equal((await fetch(`${a.base}${new URL(first.owner_file_url).pathname}${new URL(first.owner_file_url).search}`)).status, 200);
      assert.equal((await fetch(`${a.base}${new URL(copy.json.owner_file_url).pathname}${new URL(copy.json.owner_file_url).search}`)).status, 200);
    } finally { await a.close(); }
  });

  test('a burst of runs cannot go over the daily limit', async () => {
    const a = await auditApp();
    try {
      const c = makeCaller(a.repo, { daily_limit: 2 });
      const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => post(a.base, c, runBody({ visitor: { website: `site${i}.example` } }))));
      assert.equal(answers.filter((r) => r.status === 202).length, 2);
      assert.equal(answers.filter((r) => r.json.error === WORDS.dailyLimit).length, 4);
      assert.equal(a.repo.runs.size, 2, 'nothing over the limit was written');
    } finally { await a.close(); }
  });

  test('same-website copies do not use up the daily limit', async () => {
    const a = await auditApp();
    try {
      const c = makeCaller(a.repo, { daily_limit: 2 });
      await post(a.base, c, runBody());
      Object.assign([...a.repo.runs.values()][0], { status: 'done', score: 70, summary_plain: 'x', blob_path: 'site-audits/a/b/website-audit.pdf' });
      for (let i = 0; i < 3; i++) assert.equal((await post(a.base, c, runBody())).json.status, 'done');
      const other = await post(a.base, c, runBody({ visitor: { website: 'other.example' } }));
      assert.equal(other.status, 202, 'one real check so far, so a second one runs');
    } finally { await a.close(); }
  });

  test('a run lost to a restart is started again when the caller asks again', async () => {
    const a = await auditApp();
    try {
      const c = makeCaller(a.repo);
      const ask = async (over) => {
        const body = runBody();
        await post(a.base, c, body);
        const row = [...a.repo.runs.values()].find((x) => x.external_run_id === body.run_id);
        Object.assign(row, over);
        a.started.length = 0;
        const again = await post(a.base, c, { ...body, sent_at: new Date().toISOString() });
        await new Promise((r) => setImmediate(r));
        return { again, row };
      };
      const minutesAgo = (m) => new Date(Date.now() - m * 60_000);
      // Fresh and queued: still waiting its turn, left alone.
      let r = await ask({});
      assert.equal(r.again.status, 202);
      assert.equal(a.started.length, 0, 'a fresh run is not started twice');
      // Queued for 2 minutes: nobody has it.
      r = await ask({ created_at: minutesAgo(2) });
      assert.equal(r.again.status, 202);
      assert.deepEqual(a.started.map((x) => x.id), [r.row.run_id]);
      // Running for 10 minutes on its first start: queued again and started.
      r = await ask({ status: 'running', started_at: minutesAgo(10), run_attempts: 1 });
      assert.equal(r.row.status, 'queued');
      assert.deepEqual(a.started.map((x) => x.id), [r.row.run_id]);
      // Running for 10 minutes on its second start: failed in plain words, not looped.
      r = await ask({ status: 'running', started_at: minutesAgo(10), run_attempts: 2 });
      assert.deepEqual(r.again.json, { status: 'failed', error: PLAIN.noReport });
      assert.equal(r.row.status, 'failed');
      assert.equal(a.started.length, 0);
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
    const run_id = crypto.randomUUID();
    const links = mintLinks('https://audit.example', run_id, Date.now(), { AUDIT_CALLER_KEY: TEST_KEY });
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
    const l = mintLinks('https://audit.example', 'r1', Date.now(), { AUDIT_CALLER_KEY: TEST_KEY });
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

  test('IPv4 written as IPv6 (the hex form the URL parser makes) is refused', async () => {
    // new URL('http://[::ffff:127.0.0.1]/') has hostname [::ffff:7f00:1]: test what the parser really hands over.
    const typed = ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:169.254.169.254]/', 'http://[::ffff:a9fe:a9fe]/', 'https://[::ffff:10.0.0.5]/',
      'http://[::127.0.0.1]/', 'http://[::7f00:1]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://[64:ff9b:1::7f00:1]/', 'http://[2002:7f00:1::]/',
      'http://[2001::1]/', 'http://[2001:db8::1]/', 'http://[100::1]/', 'http://[fec0::1]/'];
    for (const t of typed) {
      const url = normaliseSiteUrl(t);
      assert.ok(url, `${t} is accepted as a website, so the guard must stop it`);
      await assert.rejects(checkUrl(url, { env: {} }), (e) => e instanceof SafeFetchRefused && e.code === 'not_public', t);
    }
    for (const ip of ['::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:a00:5', '::7f00:1', '64:ff9b::a9fe:a9fe', '2002:7f00:1::']) assert.equal(isBlockedAddress(ip), true, ip);
    // Presence: a public IPv6 site still passes.
    assert.equal((await checkUrl('http://[2606:4700::1111]/', { env: {} })).address, '2606:4700::1111');
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
    let hits = 0;
    test('setup', async () => {
      const app = express();
      app.get('/redirect-private', (req, res) => res.redirect(302, 'http://internal.example/admin'));
      app.get('/redirect-mapped-metadata', (req, res) => res.redirect(302, 'http://[::ffff:169.254.169.254]/latest/meta-data'));
      app.get('/redirect-mapped-private', (req, res) => res.redirect(302, 'https://[::ffff:10.0.0.5]/'));
      app.get('/internal-only', (req, res) => { hits += 1; res.type('html').send('<title>INTERNAL-ONLY</title>'); });
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
    test('a redirect to a hex-mapped metadata or private address is refused at the hop', async () => {
      for (const p of ['/redirect-mapped-metadata', '/redirect-mapped-private']) {
        await assert.rejects(safeFetch(`${srv.base}${p}`, { env }), (e) => e instanceof SafeFetchRefused && e.code === 'not_public' && /->/.test(e.detail), p);
      }
    });
    test('a typed [::ffff:127.0.0.1] website never connects to the loopback server', async () => {
      const port = new URL(srv.base).port;
      hits = 0;
      await assert.rejects(safeFetch(`http://[::ffff:127.0.0.1]:${port}/internal-only`, { env: {} }),
        (e) => e.code === 'not_public' && /::ffff:7f00:1 ->/.test(e.detail), 'refused for its ADDRESS, not only its port');
      assert.equal(hits, 0, 'the internal page was never reached');
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

describe('robots cannot freeze the server', () => {
  test('a pathological robots rule against a 5,000-character path finishes in under 50 ms', async () => {
    // In a worker with a hard deadline: a backtracking matcher would block
    // this thread for minutes, and the test must go red rather than hang.
    const { out } = await timedInWorker(`async (root) => {
      const { parseRobots, isAllowed } = await import(root + 'lib/audit/robots.js');
      const rules = ['/*a*a*a*a*a*a*b', '/*aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab', '/' + '*a'.repeat(200) + '*b$'];
      const p = parseRobots(['User-agent: *', ...rules.map((r) => 'Disallow: ' + r)].join(String.fromCharCode(10)));
      const t0 = performance.now();
      const answers = [isAllowed(p, '/' + 'a'.repeat(60)), isAllowed(p, '/' + 'a'.repeat(5000))];
      return { ms: performance.now() - t0, answers, rules: p.rules.length, presence: isAllowed(p, '/xaaaaaab') };
    }`, 10_000);
    assert.equal(out.rules, 3, 'the rules were read');
    assert.deepEqual(out.answers, [true, true]);
    assert.ok(out.ms < 50, `the checks took ${out.ms.toFixed(1)} ms`);
    assert.equal(out.presence, false, 'the same rules still match a path they should');
  });

  test('rules are capped: no more than 500 per group, none longer than 1,000 characters', () => {
    const many = Array.from({ length: 900 }, (_, i) => `Disallow: /r${i}`).join('\n');
    assert.equal(parseRobots(`User-agent: *\n${many}`).rules.length, 500);
    assert.equal(parseRobots(`User-agent: *\nDisallow: /${'x'.repeat(1200)}`).rules.length, 0);
  });

  test('the wildcard matcher agrees with the common robots dialect', () => {
    const cases = [
      ['/fish', '/fish', true], ['/fish', '/fish.html', true], ['/fish', '/Fish', false], ['/fish*', '/fishheads/x', true],
      ['/*.php', '/index.php', true], ['/*.php', '/folder/x.php?y', true], ['/*.php$', '/x.php', true], ['/*.php$', '/x.php?y', false],
      ['/fish*.php', '/fish/salmon.php', true], ['/fish*.php', '/Fish.PHP', false], ['/a*b*c', '/axxbyyc', true], ['/a*b*c', '/axxcyyb', false],
      ['/$', '/', true], ['/$', '/x', false], ['*/private', '/x/private/y', true], ['/a*', '/a', true], ['/a**b$', '/aqqb', true],
      ['/ab*ab$', '/abab', true], ['/ab*ab$', '/ab', false],
    ];
    for (const [rule, path, want] of cases) {
      const p = parseRobots(`User-agent: *\nDisallow: ${rule}`);
      assert.equal(!isAllowed(p, path), want, `${rule} vs ${path}`);
    }
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

describe('robots path cap', () => {
  test('a path longer than any page address is cut before it is matched (500 hostile rules, 500 KB paths)', async () => {
    // Without the cap, each rule scans the whole path: about 150 ms per check
    // for one 500 KB link, and a page can hold many of them.
    const { out } = await timedInWorker(`async (root) => {
      const { parseRobots, isAllowed, MAX_PATH_LENGTH, MAX_RULES } = await import(root + 'lib/audit/robots.js');
      const NL = String.fromCharCode(10);
      const rules = Array.from({ length: MAX_RULES }, (_, i) => 'Disallow: /*' + 'a'.repeat(990) + 'b' + i);
      const p = parseRobots(['User-agent: *', ...rules].join(NL));
      const paths = ['a', 'c', 'd'].map((x) => '/' + x.repeat(500 * 1024));
      const t0 = performance.now();
      const answers = paths.map((x) => isAllowed(p, x));
      const ms = performance.now() - t0;
      const late = parseRobots(['User-agent: *', 'Disallow: /*secret'].join(NL));
      return { ms, answers, rules: p.rules.length, cap: MAX_PATH_LENGTH,
        pastCap: isAllowed(late, '/' + 'x'.repeat(MAX_PATH_LENGTH) + 'secret'),
        insideCap: isAllowed(late, '/x/secret') };
    }`, 20_000);
    assert.equal(out.rules, 500, 'the rules were read');
    assert.deepEqual(out.answers, [true, true, true]);
    assert.ok(out.ms < 50, `three checks took ${out.ms.toFixed(1)} ms`);
    assert.equal(out.pastCap, true, `only the first ${out.cap} characters of a path are matched`);
    assert.equal(out.insideCap, false, 'a rule still matches inside the cap');
  });
});

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

  test('contact: a Facebook icon, a search box or a /notebooks link is not a way to get in touch', () => {
    for (const html of [
      '<a href="https://facebook.com/acme">Facebook</a>',
      '<form role="search" action="/"><input type="search" name="s"><button>Go</button></form>',
      '<form action="/search"><input type="text" name="q"></form>',
      '<a href="/notebooks">Our notebooks</a>',
      '<a href="/blog/quotes-we-love">Read</a>',
      '<a href="https://www.facebook.com/booking.page">Like us</a>',
    ]) assert.equal(contactChecks(html).contactLink, false, html);
  });

  test('contact: real ways to get in touch still count (presence)', () => {
    for (const html of [
      '<a href="/contact-us">Say hi</a>',
      '<a href="/contact/">Reach us</a>',
      '<a href="/book-online">Times</a>',
      '<a href="/request-a-quote.html">Pricing</a>',
      '<a href="mailto:hi@x.example">Email</a>',
      '<a href="#form">Get in touch</a>',
      '<a href="/start">Book now</a>',
      '<form action="/send"><input type="email" name="e"></form>',
      '<form action="/send"><textarea name="m"></textarea></form>',
      '<form action="/send"><input type="tel" name="p"></form>',
    ]) assert.equal(contactChecks(html).contactLink, true, html);
  });

  test('typed websites are normalised; the day key ignores case and the trailing slash', () => {
    assert.equal(normaliseSiteUrl('example.com'), 'https://example.com/');
    assert.equal(normaliseSiteUrl('  http://Example.com/shop/ '), 'http://example.com/shop/');
    assert.equal(normaliseSiteUrl('not a site'), null);
    assert.equal(normaliseSiteUrl('javascript:alert(1)'), null);
    assert.equal(urlKey('https://WWW.Example.com/shop/'), 'www.example.com/shop');
  });
});

describe('hostile HTML cannot freeze the server', () => {
  for (const unit of ['<!--', '<a href=x>', '<script>', '<title>', '<meta', '<']) {
    test(`2 MB of ${JSON.stringify(unit)} is checked in under 500 ms`, async () => {
      // In a worker with a hard deadline: a lazy "opener ... closer" regex
      // rescans to the end of the page per opener and would block this thread.
      const { out } = await timedInWorker(`async (root) => {
        const { pageChecks, contactChecks, anchorsOf, jsonLdTypes } = await import(root + 'lib/audit/checks.js');
        const unit = ${JSON.stringify(unit)};
        const html = unit.repeat(Math.ceil(2 * 1024 * 1024 / unit.length));
        const t0 = performance.now();
        pageChecks(html); contactChecks(html); anchorsOf(html); jsonLdTypes(html);
        return { ms: performance.now() - t0 };
      }`, 20_000);
      assert.ok(out.ms < 500, `took ${out.ms.toFixed(0)} ms`);
    });
  }

  // Reviewer finding, 7 Oct 2026: a page of start tags that never finish, with
  // ONE '>' inside the 512 KB cap, made every opener reach the same far '>' and
  // re-read that huge "tag" (174 s for 256 KB). Unclosed forms re-read the rest
  // of the page once each (30 s for 512 KB). Each check must finish in under
  // 500 ms, and a drift probe must never see the thread held for 100 ms.
  for (const [unit, closeOne] of [['<meta ', true], ['<img ', true], ['<link ', true], ['<input ', true], ['<form>', false], ['<form><input type=text ', true]]) {
    test(`512 KB of ${JSON.stringify(unit)}${closeOne ? " with one '>'" : ''} is checked in under 500 ms and never holds the thread 100 ms`, async () => {
      const { out } = await timedInWorker(`async (root) => {
        const { pageChecks, contactChecks, anchorsOf, jsonLdTypes, MAX_HTML } = await import(root + 'lib/audit/checks.js');
        const unit = ${JSON.stringify(unit)};
        let html = unit.repeat(Math.floor((MAX_HTML - 1) / unit.length));
        if (${closeOne}) html += '>';
        if (html.length > MAX_HTML) throw new Error('the closing > must sit inside the cap');
        let last = performance.now();
        let worst = 0;
        const probe = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 5); last = now; }, 5);
        const breathe = () => new Promise((r) => setTimeout(r, 15));
        const ms = {};
        await breathe();
        for (const [name, fn] of Object.entries({ pageChecks, contactChecks, anchorsOf, jsonLdTypes })) {
          const t0 = performance.now();
          fn(html);
          ms[name] = performance.now() - t0;
          await breathe();
        }
        clearInterval(probe);
        return { ms, worst, size: html.length };
      }`, 20_000);
      for (const [name, v] of Object.entries(out.ms)) assert.ok(v < 500, `${name} took ${v.toFixed(0)} ms on ${out.size} characters`);
      assert.ok(out.worst < 100, `the thread was held for ${out.worst.toFixed(0)} ms`);
    });
  }

  test('a hostile home page through the real crawl and safeFetch never holds the thread 100 ms', async () => {
    const { out } = await timedInWorker(`async (root) => {
      const http = require('node:http');
      const { crawl } = await import(root + 'lib/audit/crawl.js');
      const { safeFetch } = await import(root + 'lib/audit/safeFetch.js');
      const { MAX_HTML } = await import(root + 'lib/audit/checks.js');
      const pages = { '/': '<meta '.repeat(Math.floor((MAX_HTML - 1) / 6)) + '>', '/forms': '<form>'.repeat(Math.floor(MAX_HTML / 6)) };
      const server = http.createServer((req, res) => {
        const body = pages[req.url];
        if (body == null) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no'); return; }
        res.writeHead(200, { 'content-type': 'text/html' }); res.end(body);
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const base = 'http://127.0.0.1:' + server.address().port;
      const fetch = (u, o = {}) => safeFetch(u, { ...o, env: { AUDIT_ALLOW_LOCAL: 'true' } });
      let last = performance.now();
      let worst = 0;
      const probe = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last - 5); last = now; }, 5);
      const runs = [];
      for (const p of ['/', '/forms']) {
        const t0 = performance.now();
        const r = await crawl(base + p, { fetch });
        runs.push({ path: p, ms: performance.now() - t0, pages: r.pages.length, status: r.pages[0] && r.pages[0].status });
      }
      clearInterval(probe);
      server.close();
      return { runs, worst };
    }`, 30_000);
    for (const r of out.runs) {
      assert.equal(r.pages, 1, `the hostile page ${r.path} was read`);
      assert.equal(r.status, 200);
    }
    assert.ok(out.worst < 100, `the thread was held for ${out.worst.toFixed(0)} ms (${JSON.stringify(out.runs)})`);
  });

  test('only the first 512 KB of a page is read', () => {
    const late = `${' '.repeat(MAX_HTML)}<title>A title past the cap</title><h1>Late</h1><a href="tel:5155550142">Call</a><form><textarea></textarea></form>`;
    const c = pageChecks(late);
    assert.equal(c.title, '', 'a title past 512 KB is not read');
    assert.equal(c.h1Count, 0);
    assert.deepEqual(anchorsOf(late), []);
    assert.deepEqual(contactChecks(late), { telLink: false, phoneShown: false, contactLink: false });
    // Presence: the same page inside the cap is read.
    assert.equal(pageChecks(late.trimStart()).title, 'A title past the cap');
    assert.equal(contactChecks(late.trimStart()).contactLink, true);
  });

  test('a tag whose quote never closes stops at 4 KB, and attrsOf reads at most 4 KB of one tag', () => {
    const broken = `<img src="a.jpg>${' '.repeat(MAX_TAG + 100)}<h1>Real heading</h1>`;
    assert.equal(pageChecks(broken).h1Count, 1, 'the heading after the broken tag is still read');
    assert.equal(pageChecks(broken).imageCount, 1);
    assert.deepEqual(attrsOf(`<img ${' '.repeat(MAX_TAG)} alt=x>`), {}, 'an attribute past 4 KB is not read');
    assert.deepEqual(attrsOf('<img alt=x>'), { alt: 'x' });
  });

  test(`at most ${MAX_TAGS.toLocaleString('en-US')} tags of one page are read`, () => {
    const html = '<img src=x>'.repeat(MAX_TAGS + 500);
    assert.equal(pageChecks(html).imageCount, MAX_TAGS);
    assert.equal(pageChecks('<img src=x>'.repeat(30)).imageCount, 30, 'an ordinary page counts every image');
  });

  test('the tag reader keeps what a browser keeps', () => {
    // A '>' inside a quoted value does not end the tag; a tag that never ends stops at the next '<'.
    assert.deepEqual(attrsOf('<meta name="description" content="Fast > slow, always" />'), { name: 'description', content: 'Fast > slow, always' });
    const c = pageChecks('<meta name="description" content="Fast > slow, always and every time, for every customer we have"><meta name=viewport content="width=device-width"'
      + '<link rel="Canonical" href="/x"><img src=a alt><img src=b><h1 title="a>b">x</h1>');
    assert.equal(c.description, 'Fast > slow, always and every time, for every customer we have');
    assert.equal(c.viewport, true, 'an unfinished tag still counts, up to the next tag');
    assert.equal(c.canonical, true);
    assert.equal(c.imageCount, 2);
    assert.equal(c.imagesWithoutAlt, 1, 'a bare alt is an alt');
    assert.equal(c.h1Count, 1);
    assert.equal(contactChecks('<form><input type="Email "></form>').contactLink, true);
    assert.equal(contactChecks('<form><input type=text></form><input type=email>').contactLink, false, 'a box outside any form is not a form');
    assert.equal(contactChecks('<form><input type=text><form role=search><input type=email>').contactLink, false, 'an unclosed form ends where the next form starts');
    assert.equal(contactChecks('<form><input type=text><form><textarea>').contactLink, true);
  });

  test('the scanner still reads what it should (presence)', () => {
    const html = '<html><head><TITLE>Sam &amp; Co plumbing</TITLE><!-- <h1>hidden</h1> --><script>"<a href=/no>no</a>"</script></head>'
      + '<body><H1>Hi</H1><a href="/x">X <b>bold</b></a><A HREF=/y>Y</A><abbr>not a link</abbr><img src=a.jpg></body></html>';
    const c = pageChecks(html);
    assert.equal(c.title, 'Sam & Co plumbing');
    assert.equal(c.h1Count, 1, 'the commented-out heading is not counted');
    assert.equal(c.imagesWithoutAlt, 1);
    assert.deepEqual(anchorsOf(html), [{ href: '/x', text: 'X bold' }, { href: '/y', text: 'Y' }]);
    assert.equal(pageChecks('<!-- never closed <h1>x</h1>').h1Count, 0, 'an unclosed comment runs to the end, as a browser reads it');
  });

  test('a huge numeric entity on the home page does not break the check', async () => {
    assert.equal(pageChecks('<title>&#99999999;</title>').title, '�');
    assert.equal(pageChecks('<title>&#xD800; ok</title>').title, '� ok');
    assert.equal(pageChecks('<title>A &#65; &#x41;</title>').title, 'A A A', 'ordinary entities still decode');
    const home = HOME_HTML.replace('<title>Sam Test Plumbing', '<title>&#99999999; Sam Test Plumbing');
    const base = fakeSite();
    const r = await crawl('https://samtest.example/', { fetch: async (url, o) => (new URL(url).pathname === '/' && (o?.method || 'GET') === 'GET' ? { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(home), url } : base(url, o)) });
    assert.equal(r.pages[0].status, 200);
    assert.match(r.pages[0].checks.title, /Sam Test Plumbing/);
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
  test('robots disallow-all: the report scores only speed and security, as its note says', async () => {
    const counter = {};
    const r = await crawl('https://samtest.example/', { fetch: fakeSite({ robots: 'User-agent: *\nDisallow: /\n', counter }) });
    assert.ok(!counter['HEAD https://samtest.example/sitemap.xml'] && !counter['GET https://samtest.example/sitemap.xml'], 'the sitemap is not fetched');
    const s = scoreAudit({ crawl: r, psiMobile: { scores: { performance: 70, seo: 90 }, metrics: { lcp: { value: 4100 } }, opportunities: [{ id: 'server-response-time' }] } });
    assert.deepEqual(s.notes, [ROBOTS_BLOCKED_SENTENCE]);
    assert.deepEqual(s.sections.filter((x) => x.score != null).map((x) => x.key), ['speed', 'trust'], 'exactly the sections the note names');
    const every = [...s.sections.flatMap((x) => x.findings), ...s.topFindings, s.summary_plain];
    assert.ok(!every.some((f) => /sitemap|description|main heading|phones/i.test(f)), every.join(' | '));
    // Presence: what WAS checked is still reported.
    assert.ok(s.topFindings.some((f) => /wait about 4 seconds/.test(f)), s.topFindings.join(' | '));
    assert.ok(s.topFindings.some((f) => /missing 3 of 5/.test(f)), s.topFindings.join(' | '));
  });

  test('robots disallowing the start page itself: that page is not read', async () => {
    const counter = {};
    const r = await crawl('https://samtest.example/private/area', { fetch: fakeSite({ counter }) });
    assert.equal(r.robots.blocked, true);
    assert.ok(!counter['GET https://samtest.example/private/area'], 'the disallowed start page is not fetched');
    assert.equal(r.pages.length, 0);
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
/**
 * The words pdfkit painted into a PDF (the same reading as oliver-api's
 * test/proposal-pdf-data-table.test.mjs): inflate each content stream, take the
 * hex strings of every TJ between BT and ET, and decode them as the standard
 * fonts' WinAnsi (windows-1252) bytes. One space between text objects.
 */
function pdfText(buf) {
  const s = buf.toString('latin1');
  const winAnsi = new TextDecoder('windows-1252');
  let out = '';
  for (const m of s.matchAll(/stream\r?\n/g)) {
    const start = m.index + m[0].length;
    const end = s.indexOf('endstream', start);
    if (end < 0) continue;
    const raw = Buffer.from(s.slice(start, end), 'latin1');
    let stream;
    try { stream = zlib.inflateSync(raw).toString('latin1'); } catch { stream = raw.toString('latin1'); }
    for (const bt of stream.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) {
      for (const h of bt[1].matchAll(/<([0-9a-fA-F]*)>/g)) out += winAnsi.decode(Buffer.from(h[1], 'hex'));
      out += ' ';
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


  test('report words stay true at the edges', () => {
    const one = { score: 90, sentence: 'This is in good shape.', sections: [], topFindings: ['Only one thing.'], notes: [] };
    const html1 = renderReportHtml({ business: { name: 'Northwind Gardens' }, url: 'https://samtest.example/', result: one });
    assert.match(html1, /<h2>The thing to fix first<\/h2>/);
    assert.doesNotMatch(html1, /three things/);
    const html2 = renderReportHtml({ business: { name: 'Northwind Gardens' }, url: 'https://samtest.example/', result: { ...one, topFindings: ['a', 'b'] } });
    assert.match(html2, /<h2>The two things to fix first<\/h2>/);
    const html3 = renderReportHtml({ business: { name: 'Northwind Gardens' }, url: 'https://samtest.example/', result: { ...one, topFindings: ['a', 'b', 'c'] } });
    assert.match(html3, /<h2>The three things to fix first<\/h2>/);

    const speedAt = (ms) => scoreAudit({ crawl: null, psiMobile: { scores: { performance: 60 }, metrics: { lcp: { value: ms } }, opportunities: [] } })
      .sections.find((x) => x.key === 'speed').findings[0];
    assert.equal(speedAt(2600), 'Your phone visitors wait about 3 seconds before they see your page.');
    assert.equal(speedAt(3600), 'Your phone visitors wait about 4 seconds before they see your page. Most people leave after 3.');

    const trust = scoreAudit({ crawl: { homepage: { https: true, security: { hsts: true } }, httpsRedirect: true, robots: {} } })
      .sections.find((x) => x.key === 'trust').findings;
    assert.deepEqual(trust, ['Your site is missing 4 of 5 standard browser protections that keep visitors safe.']);
  });
  test('a visitor business name with markup is escaped', async () => {
    const html = renderReportHtml({ business, visitor: { business: '<script>alert(1)</script>' }, url: 'https://samtest.example/', result: await result() });
    assert.doesNotMatch(html, /<script>alert/);
  });

  test('the report module paints its PDF without a browser: it does not import playwright', () => {
    const src = fs.readFileSync(path.join(REPO, 'lib/audit/report.js'), 'utf8');
    const imports = [...src.matchAll(/(?:\bimport\s[^'";]*?from\s*|\bimport\s*\(?\s*|\bexport\s[^'";]*?from\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
    assert.ok(imports.includes('pdfkit'), 'the import scan read the imports (pdfkit is there)');
    for (const i of imports) assert.doesNotMatch(i, /playwright|puppeteer|chromium/i, `report.js imports ${i}`);
    assert.doesNotMatch(src, /\bchromium\s*\.\s*launch|\.pdf\s*\(\s*\{\s*format/, 'no browser launch or page.pdf() call');
  });

  test('a real PDF from pdfkit: one Letter page with the score, the sections, three findings and "Prepared by" the agency', async () => {
    const res = await result();
    const findings = ["Visitors can't see a phone number on your home page.", "There's no clear way to get in touch from your home page.", 'Your site is slow on phones, where most of your visitors are.'];
    const withThree = { ...res, topFindings: findings };
    const pdf = await renderPdf({ business, visitor: { business: 'Sam Test Plumbing' }, url: 'https://samtest.example/', result: withThree, now: new Date('2026-10-07T12:00:00Z') });
    assert.ok(Buffer.isBuffer(pdf));
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    const bytes = pdf.toString('latin1');
    assert.equal((bytes.match(/\/Type\s*\/Page\b/g) || []).length, 1, 'one page');
    assert.match(bytes, /\/MediaBox\s*\[0 0 612 792\]/, 'Letter size');
    assert.doesNotMatch(bytes, /PDFKit|HeadlessChrome|Skia|Playwright/i, 'no tool or vendor name in the file');
    const text = squash(pdfText(pdf));
    for (const words of ['Website check for Sam Test Plumbing', 'Prepared by Northwind Gardens', '(555) 010-2000', 'northwind.example', 'Speed', 'Found on Google',
      'Trust & security', 'Works on phones', 'Turns visitors into leads', String(res.score), res.sentence, 'The three things to fix first', ...findings, '7 October 2026']) {
      assert.ok(text.includes(squash(words)), `"${words}" is not on the PDF`);
    }
    // The score words unchanged: every section's verdict is the band sentence the HTML prints.
    for (const s of res.sections) assert.ok(text.includes(squash(s.verdict)), `the verdict "${s.verdict}" is not on the PDF`);
    await assert.rejects(renderPdf('<p>x</p>'), /not HTML/, 'an HTML string is refused rather than painted as nothing');
  });

  test('a long report runs onto a second page and still ends "Prepared by" the agency', async () => {
    const res = await result();
    const notes = Array.from({ length: 40 }, (_, i) => `Note ${i + 1}: this sentence is long enough to take up most of one line on the page.`);
    const pdf = await renderPdf({ business, url: 'https://samtest.example/', result: { ...res, notes } });
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
    assert.ok(pages >= 2, `${pages} page(s)`);
    const text = squash(pdfText(pdf));
    assert.ok(text.includes(squash('Note 40:')), 'the last note is on the paper');
    assert.ok(text.indexOf(squash('Note 40:')) < text.lastIndexOf(squash('Prepared by Northwind Gardens')), '"Prepared by" comes after the last note');
  });
});

// ---------------------------------------------------------------------------
describe('runner', () => {
  function setup({ callbackStatus = () => 200, site = fakeSite(), renderPdfFn = async () => Buffer.from('%PDF-1.4 fake'), pagespeed, sleepFn, storePdfFn, runCapMs } = {}) {
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
      env: { AUDIT_CALLER_KEY: TEST_KEY },
      ...(runCapMs ? { runCapMs } : {}),
      pagespeed: pagespeed || (async (url, strategy) => ({ strategy, scores: { performance: strategy === 'mobile' ? 55 : 80, seo: 90 }, metrics: { lcp: { value: 3900 } }, opportunities: [{ id: 'server-response-time' }] })),
      renderPdf: renderPdfFn,
      storePdf: storePdfFn || (async ({ callerId, runId }) => `site-audits/${callerId}/${runId}/website-audit.pdf`),
      sleep: async (ms) => { sleeps.push(ms); if (sleepFn) await sleepFn(ms); },
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
    assert.equal(body.status, 'done');    assert.equal(body.kind, 'result', 'the signed body says what it is');
    assert.equal(body.run_id, row.external_run_id, 'the signed body names the run, so it cannot be replayed onto another');

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
    assert.deepEqual(JSON.parse(t.callbacks[0].opts.body), { kind: 'result', run_id: row.external_run_id, status: 'failed', error: PLAIN.unreachable });
  });

  test('a website that answered is never told "we couldn\'t reach" it: 404 home page, not a web page, too big, redirect loop', async () => {
    const homeAnswers = {
      homeError: () => ({ status: 404, headers: { 'content-type': 'text/html' }, body: Buffer.from('Not found') }),
      notHtml: () => { throw new SafeFetchRefused('not_html', 'application/pdf'); },
      tooBig: () => { throw new SafeFetchRefused('too_big', '3000000 > 2097152'); },
      redirectLoop: () => { throw new SafeFetchRefused('too_many_redirects', 'https://samtest.example/'); },
    };
    const base = fakeSite();
    for (const [want, answer] of Object.entries(homeAnswers)) {
      const t = setup({ site: async (url, o = {}) => (new URL(url).pathname === '/' && (o.method || 'GET') === 'GET' ? { url, ...answer() } : base(url, o)) });
      const id = await t.queue();
      await t.runner.runNow(id);
      const row = t.repo.runs.get(id);
      assert.equal(row.status, 'failed', want);
      assert.equal(row.error_plain, PLAIN[want], want);
      assert.notEqual(row.error_plain, PLAIN.unreachable, `${want}: we did reach the website`);
      assert.equal(JSON.parse(t.callbacks[0].opts.body).error, PLAIN[want], `${want}: the caller is told the same words`);
    }
    // Plain words: no codes, no numbers a business owner would not know.
    for (const k of ['homeError', 'notHtml', 'tooBig', 'redirectLoop']) {
      assert.doesNotMatch(PLAIN[k], /\b(?:404|500|HTML|HTTP|redirect|UTC)\b/i, k);
    }
    assert.equal(new Set(Object.values(PLAIN)).size, Object.keys(PLAIN).length, 'every failure has its own sentence');
  });

  test('the daily-limit words say "tomorrow", not a time zone', () => {
    assert.match(WORDS.dailyLimit, /tomorrow/);
    assert.doesNotMatch(WORDS.dailyLimit, /UTC|midnight|GMT/i);
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


  const until = async (cond, ms = 3000) => {
    const t0 = Date.now();
    while (!cond()) {
      if (Date.now() - t0 > ms) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  test('a run waiting on a callback retry holds no audit slot', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const t = setup({ callbackStatus: () => 503, sleepFn: () => gate });
    const first = await t.queue();
    const p1 = t.runner.start(first);
    await until(() => t.sleeps.length === 1);
    assert.equal(t.repo.runs.get(first).status, 'done', 'the audit itself finished');
    assert.equal(t.runner.semaphore.active, 0, 'the back-off before the second callback holds no slot');
    // Another business's audit runs straight away.
    const second = await t.queue();
    t.runner.start(second);
    await until(() => t.repo.runs.get(second).status === 'done');
    release();
    const out = await p1;
    assert.equal(out.delivered, false);
  });

  test('the cap stops the audit: no PDF is stored, and the slot is held until it has stopped', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const fetched = [];
    const base = fakeSite();
    const site = async (url, opts) => {
      const path = new URL(url).pathname;
      fetched.push(path);
      if (path === '/about') await gate; // a slow page
      return base(url, opts);
    };
    let stored = 0;
    let painted = 0;
    const t = setup({ site, runCapMs: 50, storePdfFn: async () => { stored += 1; return 'site-audits/x/y/website-audit.pdf'; }, renderPdfFn: async () => { painted += 1; return Buffer.from('%PDF'); } });
    const id = await t.queue();
    const done = t.runner.start(id);
    await until(() => t.callbacks.length === 1);
    assert.equal(t.repo.runs.get(id).status, 'failed');
    assert.equal(t.repo.runs.get(id).error_plain, PLAIN.tooSlow);
    assert.equal(JSON.parse(t.callbacks[0].opts.body).error, PLAIN.tooSlow);
    assert.equal(t.runner.semaphore.active, 1, 'the slot is kept while the audit is still in its slow step');
    const seen = fetched.length;
    release();
    await done;
    await until(() => t.runner.semaphore.active === 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(stored, 0, 'no orphan PDF');
    assert.equal(painted, 0, 'no PDF painted after the cap');
    assert.ok(!fetched.slice(seen).includes('/contact'), `no new page was read after the cap (${fetched.slice(seen).join(', ')})`);
  });

  test('the sweep restarts lost runs and fails ones out of starts', async () => {
    const t = setup();
    const lost = await t.queue();
    Object.assign(t.repo.runs.get(lost), { created_at: new Date(Date.now() - 5 * 60_000) });
    const dead = await t.queue({ status: 'running' });
    Object.assign(t.repo.runs.get(dead), { started_at: new Date(Date.now() - 30 * 60_000), run_attempts: 2 });
    const out = await t.runner.sweep({ base: 'https://audit.example' });
    assert.deepEqual(out.map(([, what]) => what).sort(), ['failed', 'restart']);
    await until(() => t.repo.runs.get(lost).status === 'done');
    assert.equal(t.repo.runs.get(dead).status === 'failed' || t.repo.runs.get(dead).status === 'callback_failed', true);
    assert.equal(t.repo.runs.get(dead).error_plain, PLAIN.noReport);
    await until(() => t.callbacks.length === 2);
    const bodies = t.callbacks.map((cb) => JSON.parse(cb.opts.body));
    assert.ok(bodies.some((b) => b.run_id === t.repo.runs.get(dead).external_run_id && b.status === 'failed'), 'the caller is told');
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
  'db/migrations/067_site_audit.sql', 'db/migrations/068_site_audit_attempts_and_copies.sql',
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
