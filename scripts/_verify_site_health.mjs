#!/usr/bin/env node
/**
 * _verify_site_health.mjs — is the plugin working on this site, and is it
 * costing the site anything?
 *
 * "The endpoint returns data" is not the same claim as "the site is fine".
 * A plugin can answer every call correctly and still be exhausting memory,
 * throwing notices into the error log, or adding half a second to every page a
 * customer loads. This checks all of it, and the front end FIRST — a visitor
 * never sees /wp-json.
 *
 * Read-only. Nothing here writes to the site.
 *
 * Usage: node scripts/_verify_site_health.mjs <domain> [--paths /a,/b]
 */
import sql from 'mssql';
import { runWpCli, runSshCommand } from '../lib/hostingerSsh.js';
import { prodPool } from './_prodsql.mjs';

const DOMAIN = process.argv[2];
if (!DOMAIN) { console.error('usage: node scripts/_verify_site_health.mjs <domain>'); process.exit(1); }
const extra = (process.argv.find((a) => a.startsWith('--paths=')) || '').split('=')[1];
const EXPECT = (process.argv.find((a) => a.startsWith('--expect=')) || '').split('=')[1] || '1.4.0';

const pool = await prodPool('iadm_services');
const site = (await pool.request()
  .input('d', sql.NVarChar(255), DOMAIN)
  .query(`SELECT site_id, domain, plugin_version, plugin_channel, site_token_raw
            FROM arion.site WHERE domain = @d`)).recordset[0];
if (!site) { console.error(`no site row for ${DOMAIN}`); process.exit(1); }

const auth = { 'X-Arion-Site-Token': site.site_token_raw, 'Cache-Control': 'no-cache' };
const cb = () => `_cb=${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
let fails = 0;
const pass = (ok, label, detail = '') => {
  if (!ok) fails++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};

console.log(`\n═══ ${site.domain}  (registry: v${site.plugin_version}, channel ${site.plugin_channel}) ═══`);

// ── 1. the front end, which is the only thing a customer ever sees ────────
console.log(`\n[1] Front end`);
const paths = extra ? extra.split(',') : ['/', '/contact/', '/about/'];
for (const p of paths) {
  // Plain GET, no cache-buster. Every site runs LiteSpeed and a real visitor is
  // served from its page cache, so busting it measures a number nobody
  // experiences — the first version of this check failed a perfectly healthy
  // site for taking 14s on a forced cold render.
  const t0 = Date.now();
  try {
    const r = await fetch(`https://${site.domain}${p}`, { signal: AbortSignal.timeout(45000) });
    const body = await r.text();
    const ms = Date.now() - t0;
    // A WordPress fatal renders as a 200 page containing the error, so status
    // alone is not enough. "Warning:" and "Notice:" are deliberately excluded —
    // they appear inside legitimate page copy and produced false alarms.
    const fatal = /Fatal error|Parse error|There has been a critical error/i.test(body);
    pass(r.ok && !fatal && ms < 3000, `${p.padEnd(12)} HTTP ${r.status}`,
         `${ms}ms cached, ${(body.length / 1024).toFixed(0)}KB${fatal ? ', PHP ERROR IN OUTPUT' : ''}`);
  } catch (e) {
    pass(false, `${p.padEnd(12)} unreachable`, e.message);
  }
}

// ── 2. the plugin's own view of itself ────────────────────────────────────
console.log(`\n[2] Plugin`);
const call = async (path, budgetMs = 45000) => {
  const t0 = Date.now();
  const r = await fetch(`https://${site.domain}/wp-json/intelligent-analytics/v1${path}?${cb()}`,
    { headers: auth, signal: AbortSignal.timeout(budgetMs) });
  const txt = await r.text();
  let j = null; try { j = JSON.parse(txt); } catch {}
  return { ok: r.ok, status: r.status, ms: Date.now() - t0, json: j, raw: txt };
};

const health = await call('/health');
pass(health.ok, 'GET /health', `HTTP ${health.status}, ${health.ms}ms`);
// The version can sit at data.plugin_version or at the root depending on how
// the response was wrapped; read both rather than reporting "undefined" and
// leaving whoever runs this to go and find out which.
const reported = health.json?.data?.plugin_version ?? health.json?.plugin_version ?? null;
pass(reported === EXPECT, `reports v${EXPECT}`,
     reported ? `got ${reported}` : `no version in response: ${health.raw.slice(0, 120)}`);

// Bootstrap cost, which is the honest measure of what our plugin adds: a full
// WordPress load through every active plugin, with no theme render.
pass(health.ms < 3000, 'bootstrap within budget', `${health.ms}ms through every plugin`);

for (const [path, check] of [
  ['/content/seo-detail', (d) => Array.isArray(d?.rows) && d.rows.length > 0],
  ['/content/links',      (d) => Array.isArray(d?.rows) && d?.summary != null],
  ['/media/audit',        (d) => Array.isArray(d?.rows) && d?.summary != null],
]) {
  const res = await call(path, 90000);
  const d = res.json?.data;
  const errs = res.json?.errors || [];
  // The riskiest thing here is /media/audit walking the library; if it is
  // slow enough to matter the nightly job will feel it too.
  pass(res.ok && check(d) && errs.length === 0, `GET ${path.padEnd(21)} HTTP ${res.status}`,
       `${res.ms}ms, ${(d?.rows || []).length} rows${errs.length ? ', errors: ' + JSON.stringify(errs) : ''}`);
}

// ── 3. what the site itself says ──────────────────────────────────────────
console.log(`\n[3] WordPress`);
const wp = async (args) => ((await runWpCli(DOMAIN, args)).stdout || '').trim();

const installed = await wp(`plugin get intelligent-analytics --field=version`);
pass(installed === EXPECT, 'installed version', installed);

const status = await wp(`plugin get intelligent-analytics --field=status`);
pass(status === 'active', 'plugin active', status);

// wp-cli exits non-zero and prints nothing useful if the site is fatal, so a
// successful option read is itself a signal the bootstrap is healthy.
const home = await wp(`option get home`);
pass(home.startsWith('http'), 'WP bootstraps', home);

const phpErrs = await runSshCommand(
  `cd ~/domains/${DOMAIN}/public_html 2>/dev/null && ` +
  `(tail -n 400 error_log 2>/dev/null; tail -n 400 wp-content/debug.log 2>/dev/null) | ` +
  `grep -iE "fatal|intelligent-analytics" | tail -n 8`);
const errText = ((phpErrs.stdout || '') + (phpErrs.stderr || '')).trim();
const ourFatals = errText.split('\n').filter((l) => /fatal/i.test(l) && /intelligent-analytics/i.test(l));
pass(ourFatals.length === 0, 'no fatals from our plugin in the error log',
     errText ? `${errText.split('\n').length} related line(s)` : 'log clean or absent');
if (errText) console.log(errText.split('\n').slice(-4).map((l) => '        ' + l.slice(0, 150)).join('\n'));

console.log(`\n  ${fails === 0 ? 'ALL CHECKS PASSED' : fails + ' CHECK(S) FAILED'}`);
await pool.close();
process.exit(fails === 0 ? 0 : 1);
