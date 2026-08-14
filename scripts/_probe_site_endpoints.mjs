#!/usr/bin/env node
/**
 * _probe_site_endpoints.mjs — call the IA plugin's own REST API on a site and
 * show what each endpoint actually returns. Read-only.
 *
 * Written because "the endpoint exists" and "the endpoint returns something a
 * report can be built on" are different claims, and only one of them is worth
 * building against.
 *
 * Auth mirrors arion-api/lib/pluginClient.js buildPluginAuth(): the site token
 * is PRIMARY, the WP app password is the legacy fallback, and both are sent
 * when available because older plugin builds only accept the second.
 *
 * Usage: node scripts/_probe_site_endpoints.mjs <domain> [path ...]
 */
import sql from 'mssql';
import { prodPool } from './_prodsql.mjs';

const DOMAIN = process.argv[2];
// Git Bash rewrites a bare /content/links argument into a Windows path before
// node ever sees it, so accept the un-slashed form too and normalise.
const GROUPS = 'content|media|security|performance|onboarding|plugins|updates|provision|pages|forms';
const PATHS = process.argv.slice(3)
  .filter((a) => !a.startsWith('--'))
  .map((a) => {
    const norm = a.replace(/\\/g, '/');
    const m = norm.match(new RegExp(`(?:${GROUPS})/[a-z0-9-]+$`, 'i'));
    // A bare word like "health" is a top-level endpoint; a two-part path keeps
    // its group. Either way we rebuild it rather than trusting what arrived.
    return '/' + (m ? m[0] : norm.split('/').filter(Boolean).pop() || norm);
  });
if (!DOMAIN) { console.error('usage: node scripts/_probe_site_endpoints.mjs <domain> [/path ...]'); process.exit(1); }

const DEFAULTS = ['/health', '/status', '/performance/cron', '/content/seo-detail', '/content/links', '/media/audit'];
const paths = PATHS.length ? PATHS : DEFAULTS;

const pool = await prodPool('iadm_services');
const s = (await pool.request()
  .input('d', sql.NVarChar(255), DOMAIN)
  .query(`SELECT site_id, domain, plugin_version, plugin_channel, site_token_raw, wp_app_password_ref
            FROM arion.site WHERE domain = @d`)).recordset[0];
if (!s) { console.error(`no site row for ${DOMAIN}`); process.exit(1); }

const headers = { Accept: 'application/json' };
if (s.site_token_raw) headers['X-Arion-Site-Token'] = s.site_token_raw;

console.log(`${s.domain} — plugin v${s.plugin_version} on channel ${s.plugin_channel}\n`);

const summarise = (v, depth = 0) => {
  if (v == null) return 'null';
  if (Array.isArray(v)) {
    if (!v.length) return '[] (empty)';
    return `[${v.length}] e.g. ${JSON.stringify(v[0]).slice(0, 260)}`;
  }
  if (typeof v === 'object') {
    if (depth > 0) return JSON.stringify(v).slice(0, 200);
    return Object.entries(v).map(([k, x]) => `    ${k}: ${summarise(x, depth + 1)}`).join('\n');
  }
  return JSON.stringify(v);
};

for (const p of paths) {
  // Cache-buster: LiteSpeed will happily serve a cached REST response, which
  // makes a freshly deployed endpoint look like it was never deployed.
  const url = `https://${s.domain}/wp-json/intelligent-analytics/v1${p}?_cb=${process.pid}${Math.round(process.uptime() * 1000)}`;
  try {
    const ctl = AbortSignal.timeout(45000);
    const r = await fetch(url, { headers, signal: ctl });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch {}
    console.log(`${p}  →  HTTP ${r.status}`);
    if (!r.ok) { console.log(`    ${txt.slice(0, 220)}\n`); continue; }
    if (j?.errors?.length) console.log(`    ERRORS: ${JSON.stringify(j.errors)}`);
    console.log(summarise(j?.data ?? j));
    console.log('');
  } catch (e) {
    console.log(`${p}  →  FAILED  ${e.message}\n`);
  }
}

await pool.close();
