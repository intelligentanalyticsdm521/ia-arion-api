#!/usr/bin/env node
/**
 * exercise-site-audit-dev.mjs — run the website check for real on dev.
 *
 * PART 1 (always): the audit in this process against the dev WordPress
 * fixture (default http://localhost:8084): robots, crawl, checks, score, the
 * branded report and a real PDF painted by Playwright. The PDF is written to a
 * temp folder; the path, the score and the plain summary are printed.
 *
 * PART 2 (--server): the whole signed path through the running arion-api
 * (default http://localhost:4003), exactly as a calling agency would use it:
 *   a throwaway caller row (random key id, secret and owner id) -> signed ping
 *   -> signed run -> the callback arrives at a local listener and its signature
 *   is checked -> GET of the visitor link (application/pdf, starts %PDF) ->
 *   a wrong key is refused -> the rows and the blob are deleted (--keep keeps them).
 *   The server needs AUDIT_CALLER_KEY (the same value as this repo's .env),
 *   AUDIT_ALLOW_LOCAL=true and ARION_PUBLIC_BASE_URL, and migration 067.
 *
 * DEV ONLY. Refuses when WEBSITE_SITE_NAME is set or the SQL server is not
 * localhost. Speed is "not measured" for a local site: Google cannot reach it.
 *
 * --owner-tenant <id> registers the throwaway caller for that business (a dev
 * fixture business with ARION, e.g. the one VITE_DEV_TENANT pins) and also reads
 * GET /arion/audit/runs and its /file as that business through dev auth;
 * --other-tenant <id> (another dev business with ARION) proves it cannot see them.
 *
 *   node scripts/dev/exercise-site-audit-dev.mjs [--url http://localhost:8084] [--server] [--api http://localhost:4003] [--owner-tenant <id> [--other-tenant <id>]] [--keep]
 */
import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import sql from 'mssql';
import { BlobServiceClient } from '@azure/storage-blob';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const SITE = arg('url', 'http://localhost:8084');
const API = arg('api', 'http://localhost:4003').replace(/\/+$/, '');
const WITH_SERVER = argv.includes('--server');
const KEEP = argv.includes('--keep');

if (process.env.WEBSITE_SITE_NAME) { console.error('This is a dev script and this machine looks like App Service. Stopping.'); process.exit(1); }
process.env.AUDIT_ALLOW_LOCAL = 'true'; // this process only: lets the in-process crawl read the local fixture

const { crawl, normaliseSiteUrl } = await import('../../lib/audit/crawl.js');
const { safeFetch } = await import('../../lib/audit/safeFetch.js');
const { scoreAudit } = await import('../../lib/audit/score.js');
const { renderReportHtml, renderPdf } = await import('../../lib/audit/report.js');
const { sign, verify } = await import('../../lib/audit/signature.js');
const { upsertCaller, callerKey } = await import('../../lib/audit/callers.js');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(os.tmpdir(), 'site-audit-dev', stamp);
fs.mkdirSync(outDir, { recursive: true });
const business = { name: 'Dev Agency (exercise)', phone: '(555) 010-0000', website: 'https://agency.example', colours: { primary: '#0f5c8c', text: '#111827' } };

// ---- PART 1 ---------------------------------------------------------------
console.log(`\n=== Part 1: the audit in this process, against ${SITE} ===`);
const url = normaliseSiteUrl(SITE);
const started = Date.now();
const facts = await crawl(url, { fetch: (u, o) => safeFetch(u, o) });
const result = scoreAudit({ crawl: facts });
const html = renderReportHtml({ business, visitor: { business: null }, url, result });
const pdf = await renderPdf(html);
const pdfPath = path.join(outDir, 'website-audit.pdf');
fs.writeFileSync(pdfPath, pdf);
fs.writeFileSync(path.join(outDir, 'website-audit.html'), html);
console.log(`pages read: ${facts.pages.length} (${facts.pages.map((p) => new URL(p.url).pathname).join(', ')})`);
console.log(`robots: ${facts.robots.present ? 'present' : 'none'}${facts.robots.blocked ? ', asks us not to read pages' : ''}; sitemap: ${facts.sitemapPresent ? 'yes' : 'no'}; broken links: ${facts.linkChecks.broken.length} of ${facts.linkChecks.checked} checked`);
console.log(`score: ${result.score} — ${result.sentence}`);
for (const s of result.sections) console.log(`  ${s.label.padEnd(26)} ${String(s.score ?? '—').padStart(3)}  ${s.verdict}`);
console.log(`summary: ${result.summary_plain}`);
console.log(`PDF: ${pdfPath} (${pdf.length} bytes, starts ${pdf.subarray(0, 5).toString('latin1')}) in ${Date.now() - started} ms`);
if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') { console.error('FAIL: the file is not a PDF'); process.exit(1); }

if (!WITH_SERVER) {
  console.log('\n(Part 2 skipped — pass --server to run the signed path through the arion-api on :4003.)');
  process.exit(0);
}

// ---- PART 2 ---------------------------------------------------------------
console.log(`\n=== Part 2: the signed path through ${API} ===`);
const health = await fetch(`${API}/health`).then((r) => r.status).catch(() => 0);
if (health !== 200) { console.error(`FAIL: ${API}/health answered ${health || 'nothing'} — start the dev stack first.`); process.exit(2); }
try { callerKey(); } catch (err) { console.error(`FAIL: ${err.message}`); process.exit(2); }

const [host, port] = String(process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER || '').split(',');
if (!/^(localhost|127\.0\.0\.1)$/i.test(host.trim())) { console.error(`FAIL: SQL server is ${host}, not localhost. Stopping.`); process.exit(1); }
const pool = await new sql.ConnectionPool({
  server: host.trim(), port: Number(port || 1433), database: process.env.SERVICES_SQL_DATABASE || 'iadm_services',
  user: process.env.SQL_USER, password: process.env.SQL_PASSWORD, options: { encrypt: false, trustServerCertificate: true },
}).connect();
const tables = await pool.request().query(`SELECT OBJECT_ID('arion.site_audit_caller','U') a, OBJECT_ID('arion.site_audit_run','U') b`);
if (!tables.recordset[0].a || !tables.recordset[0].b) { console.error('FAIL: migration 067 is not applied on dev.'); process.exit(2); }

const keyId = `wfk_dev${crypto.randomBytes(6).toString('hex')}`;
const secret = crypto.randomBytes(24).toString('base64url');
const ownerTenant = arg('owner-tenant', crypto.randomUUID());
const callerId = await upsertCaller(pool, { keyId, label: 'Exercise caller (dev)', ownerTenantId: ownerTenant, secret, dailyLimit: 5, createdBy: 'exercise-site-audit-dev.mjs' });
const stored = await pool.request().input('id', sql.UniqueIdentifier, callerId).query('SELECT secret_ciphertext FROM arion.site_audit_caller WHERE caller_id=@id');
console.log(`caller ${keyId} registered; the stored secret is ${stored.recordset[0].secret_ciphertext.includes(secret) ? 'IN CLEAR (FAIL)' : 'encrypted'}`);

let failures = 0;
const check = (ok, words) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${words}`); if (!ok) failures += 1; };

async function signedPost(body) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${API}/audit/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workflow-Key': keyId, 'X-Workflow-Signature': sign(raw, secret) }, body: raw });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// The callback listener.
let resolveCallback;
const callbackArrived = new Promise((r) => { resolveCallback = r; });
const listener = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const sig = verify(raw, req.headers['x-workflow-signature'], secret);
    res.writeHead(sig.ok ? 200 : 401, { 'Content-Type': 'application/json' }).end(JSON.stringify(sig.ok ? { ok: true } : { error: sig.error }));
    resolveCallback({ sig, headers: req.headers, body: JSON.parse(raw.toString('utf8') || '{}') });
  });
});
await new Promise((r) => listener.listen(0, '127.0.0.1', r));
const callbackUrl = `http://127.0.0.1:${listener.address().port}/result`;

const runId = crypto.randomUUID();
try {
  const ping = await signedPost({ type: 'ping', run_id: null, action: { name: 'exercise' }, sent_at: new Date().toISOString() });
  check(ping.status === 200 && ping.json?.status === 'ok', `signed ping -> ${ping.status} ${JSON.stringify(ping.json)}`);
  const unsigned = await fetch(`${API}/audit/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workflow-Key': keyId }, body: '{"type":"ping"}' });
  check(unsigned.status === 401, `unsigned ping -> ${unsigned.status}`);

  const t0 = Date.now();
  const run = await signedPost({
    type: 'run', run_id: runId, action: { name: 'exercise' }, business,
    visitor: { name: 'Exercise Visitor', business: 'Fixture site', website: SITE, email: 'visitor@example.test' },
    conversation: { service: 'exercise', path: 'exercise' }, callback_url: callbackUrl, sent_at: new Date().toISOString(),
  });
  check(run.status === 202 && run.json?.status === 'accepted', `signed run -> ${run.status} ${JSON.stringify(run.json)}`);

  const cb = await Promise.race([callbackArrived, new Promise((r) => setTimeout(() => r(null), 6 * 60 * 1000))]);
  check(Boolean(cb), `callback arrived after ${Math.round((Date.now() - t0) / 1000)} s`);
  if (cb) {
    check(cb.sig.ok, 'the callback signature verifies with the caller secret');
    check(cb.headers['x-workflow-run'] === runId && cb.headers['x-workflow-key'] === keyId, 'X-Workflow-Run / X-Workflow-Key are ours');
    check(cb.body.status === 'done', `callback status ${cb.body.status}${cb.body.error ? ` (${cb.body.error})` : ''}, score ${cb.body.score}`);
    console.log(`  summary: ${cb.body.summary}`);
    if (cb.body.file_url) {
      const f = await fetch(cb.body.file_url);
      const bytes = Buffer.from(await f.arrayBuffer());
      check(f.status === 200 && f.headers.get('content-type') === 'application/pdf' && bytes.subarray(0, 4).toString('latin1') === '%PDF',
        `GET visitor link -> ${f.status} ${f.headers.get('content-type')} ${bytes.length} bytes`);
      fs.writeFileSync(path.join(outDir, 'website-audit-via-server.pdf'), bytes);
      const o = await fetch(cb.body.owner_file_url);
      check(o.status === 200, `GET owner link -> ${o.status}`);
      const wrong = new URL(cb.body.file_url); wrong.searchParams.set('k', crypto.randomBytes(32).toString('base64url'));
      check((await fetch(wrong)).status === 404, 'a wrong key -> 404');
      console.log(`  server PDF: ${path.join(outDir, 'website-audit-via-server.pdf')}`);
    }
    const again = await signedPost({ type: 'run', run_id: crypto.randomUUID(), business, visitor: { website: SITE }, callback_url: callbackUrl });
    check(again.status === 200 && again.json?.status === 'done', `same website again today -> ${again.status} ${again.json?.status} (one audit per website per day)`);
  }
  const rows = await pool.request().input('c', sql.UniqueIdentifier, callerId)
    .query('SELECT run_id, status, score, blob_path, callback_attempts, error_plain FROM arion.site_audit_run WHERE caller_id=@c ORDER BY created_at');
  for (const r of rows.recordset) console.log(`  row: ${r.status} score=${r.score} attempts=${r.callback_attempts} ${r.blob_path || ''} ${r.error_plain || ''}`);
  if (arg('owner-tenant')) {
    const h = { 'x-dev-tenant': ownerTenant };
    const list = await fetch(`${API}/arion/audit/runs`, { headers: h });
    const body = await list.json().catch(() => null);
    const mineRow = body?.data?.find((x) => String(x.run_id).toLowerCase() === String(rows.recordset[0]?.run_id || '').toLowerCase()) || body?.data?.[0];
    check(list.status === 200 && Array.isArray(body?.data) && body.data.length >= 1, `owner GET /arion/audit/runs -> ${list.status}, ${body?.data?.length ?? 0} run(s)`);
    if (mineRow?.file_path) {
      const file = await fetch(`${API}${mineRow.file_path}`, { headers: h });
      const bytes = Buffer.from(await file.arrayBuffer());
      check(file.status === 200 && bytes.subarray(0, 4).toString('latin1') === '%PDF', `owner GET ${mineRow.file_path} -> ${file.status} ${file.headers.get('content-type')}`);
    }
    if (arg('other-tenant')) {
      const other = await fetch(`${API}/arion/audit/runs`, { headers: { 'x-dev-tenant': arg('other-tenant') } });
      const otherBody = await other.json().catch(() => null);
      check(other.status === 200 && !(otherBody?.data || []).some((x) => rows.recordset.some((r) => String(r.run_id).toLowerCase() === String(x.run_id).toLowerCase())),
        `another business (${arg('other-tenant')}) reads its list (${other.status}) and these runs are not in it`);
    }
  }
} finally {
  listener.close();
  if (!KEEP) {
    const blobs = await pool.request().input('c', sql.UniqueIdentifier, callerId)
      .query('SELECT DISTINCT blob_path FROM arion.site_audit_run WHERE caller_id=@c AND blob_path IS NOT NULL');
    if (process.env.STORAGE_CONNECTION_STRING) {
      const container = BlobServiceClient.fromConnectionString(process.env.STORAGE_CONNECTION_STRING).getContainerClient('site-audits');
      for (const b of blobs.recordset) await container.deleteBlob(b.blob_path.replace(/^site-audits\//, '')).catch(() => {});
    }
    await pool.request().input('c', sql.UniqueIdentifier, callerId).query('DELETE FROM arion.site_audit_run WHERE caller_id=@c; DELETE FROM arion.site_audit_caller WHERE caller_id=@c;');
    console.log('rows and blobs removed (pass --keep to leave them)');
  }
  await pool.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
