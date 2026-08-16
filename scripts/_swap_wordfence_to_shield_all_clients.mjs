#!/usr/bin/env node
/**
 * Wordfence -> Shield Security swap on all 3 live client sites.
 *
 * Per Brandon 2026-07-05 (STANDING_DECISIONS SD-001/SD-002): Wordfence's full
 * features need a per-site Wordfence account; without it Wordfence shows a
 * "your site is vulnerable / scan incomplete" banner that BLOCKS launch and
 * corrupts our security score. Remove Wordfence, install Shield Security
 * (wp.org slug `wp-simple-firewall`).
 *
 * SAFETY ORDERING (important): install + ACTIVATE Shield FIRST and verify it,
 * THEN deactivate + delete Wordfence. The site is never left without an active
 * security plugin. Each site is isolated (try/catch) — one failure does not
 * touch the others. Preflight confirms the WP install is reachable on the
 * connected Hostinger SSH host before any change.
 *
 * Uses lib/hostingerSsh.js (pulls ARION-HOSTINGER-SSH-* from KV, runs wp-cli
 * over SSH). Same mechanism as _retro_install_rii_elementor_pro_wordfence.mjs.
 *
 * Usage:  cd C:/dev/iadm/arion-api && node scripts/_swap_wordfence_to_shield_all_clients.mjs
 * Exit:   0 = all sites PASS, 1 = one or more FAIL/FATAL.
 */

import fs from 'node:fs';
import path from 'node:path';
import { runWpCli, checkWpInstallExists } from '../lib/hostingerSsh.js';

const SHIELD_SLUG = 'wp-simple-firewall';   // Shield Security (wp.org)
const WF_SLUG = 'wordfence';

const SITES = [
  { name: 'Rolling In It',        domain: 'rollinginitllc.com'  },
  { name: 'Briarwood Dental',     domain: 'briarwoodsmiles.com' },
  { name: 'Midwest Ag Services',  domain: 'midwestagservices.com' },
];

const LOG_PATH = 'C:/Users/brand/OneDrive/Desktop/Claude Code Session Sync/WORDFENCE_TO_SHIELD_SWAP_LOG.md';
const events = [];
function log(level, msg, extra) {
  const line = `${new Date().toISOString()} [${level}] ${msg}${extra ? ' ' + JSON.stringify(extra).slice(0, 400) : ''}`;
  events.push(line);
  console.log(line);
}

async function wp(domain, cmd) { return runWpCli(domain, cmd); }
async function isInstalled(domain, slug) { try { await wp(domain, `plugin is-installed ${slug}`); return true; } catch { return false; } }
async function isActive(domain, slug) { try { await wp(domain, `plugin is-active ${slug}`); return true; } catch { return false; } }

async function swapSite(site) {
  const r = { name: site.name, domain: site.domain, status: 'UNKNOWN',
    wf_before: null, shield_active: null, wf_after: null, before_list: null, after_list: null, steps: [], error: null };
  try {
    log('INFO', `── ${site.name} (${site.domain})`);

    // 0. Preflight — WP install reachable on the connected SSH host?
    if (!(await checkWpInstallExists(site.domain))) {
      r.status = 'FATAL';
      r.error = `WP install not found at ~/domains/${site.domain}/public_html on the connected Hostinger SSH host (may be on a different host/account).`;
      log('ERROR', `${site.domain}: ${r.error}`);
      return r;
    }

    // 1. Baseline snapshot.
    try { r.before_list = JSON.parse((await wp(site.domain, 'plugin list --format=json')).stdout || '[]'); } catch {}
    r.wf_before = await isInstalled(site.domain, WF_SLUG);
    log('INFO', `${site.domain}: wordfence installed=${r.wf_before}`);

    // 2. Install + ACTIVATE Shield FIRST (idempotent).
    if (await isActive(site.domain, SHIELD_SLUG)) {
      log('INFO', `${site.domain}: shield already active`);
    } else {
      const ins = await wp(site.domain, `plugin install ${SHIELD_SLUG} --activate --force`);
      r.steps.push(`shield install: ${(ins.stdout || '').split('\n').filter(Boolean).slice(-1)[0] || 'ran'}`);
    }
    r.shield_active = await isActive(site.domain, SHIELD_SLUG);
    if (!r.shield_active) {
      r.status = 'FAIL';
      r.error = 'Shield install ran but plugin is not active — LEAVING Wordfence in place (no security gap).';
      log('ERROR', `${site.domain}: ${r.error}`);
      return r;
    }
    log('INFO', `${site.domain}: shield active ✓`);

    // 3. Now safe to remove Wordfence.
    if (r.wf_before) {
      try { await wp(site.domain, `plugin deactivate ${WF_SLUG}`); r.steps.push('wordfence deactivated'); } catch (e) { log('WARN', `${site.domain}: wf deactivate soft-fail`, { e: (e.message||'').slice(0,150) }); }
      try { await wp(site.domain, `plugin delete ${WF_SLUG}`); r.steps.push('wordfence deleted'); } catch (e) { log('WARN', `${site.domain}: wf delete soft-fail`, { e: (e.message||'').slice(0,150) }); }
    }
    r.wf_after = await isInstalled(site.domain, WF_SLUG);
    log('INFO', `${site.domain}: wordfence installed after=${r.wf_after}`);

    // 4. Cache flush (both soft-fail).
    for (const c of ['litespeed-purge all', 'cache flush']) { try { await wp(site.domain, c); } catch {} }

    // 5. After snapshot.
    try { r.after_list = JSON.parse((await wp(site.domain, 'plugin list --format=json')).stdout || '[]'); } catch {}

    r.status = (r.shield_active && !r.wf_after) ? 'PASS' : 'FAIL';
    if (r.status === 'FAIL' && !r.error) r.error = `post-verify: shield_active=${r.shield_active} wordfence_still_installed=${r.wf_after}`;
    log(r.status === 'PASS' ? 'INFO' : 'ERROR', `${site.domain}: ${r.status}`);
  } catch (err) {
    r.status = 'FATAL';
    r.error = (err.stderr || err.message || String(err)).slice(0, 500);
    log('ERROR', `${site.domain}: FATAL ${r.error}`);
  }
  return r;
}

async function main() {
  const started = new Date().toISOString();
  const results = [];
  for (const s of SITES) results.push(await swapSite(s));

  // Run log.
  const L = [];
  L.push('# Wordfence → Shield swap — run log');
  L.push(`\n- Started: ${started}\n- Finished: ${new Date().toISOString()}`);
  L.push('\n## Per-site result\n');
  L.push('| Site | Domain | Status | WF before | Shield active | WF after | Notes |');
  L.push('|---|---|---|---|---|---|---|');
  for (const r of results) L.push(`| ${r.name} | ${r.domain} | **${r.status}** | ${r.wf_before} | ${r.shield_active} | ${r.wf_after} | ${(r.error||r.steps.join('; ')||'').replace(/\|/g,'\\|').slice(0,180)} |`);
  L.push('\n## Event log\n```');
  L.push(events.join('\n'));
  L.push('```');
  try { fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }); fs.writeFileSync(LOG_PATH, L.join('\n'), 'utf8'); console.log(`\n[swap] log written: ${LOG_PATH}`); } catch (e) { console.error('log write failed', e.message); }

  console.log('\n════════ SUMMARY ════════');
  for (const r of results) console.log(`  ${r.name.padEnd(24)} [${r.status.padEnd(5)}] shield=${r.shield_active} wf_gone=${r.wf_after === false}${r.error ? '  err=' + r.error.slice(0,120) : ''}`);
  const bad = results.some(r => r.status !== 'PASS');
  process.exit(bad ? 1 : 0);
}

main().catch(e => { console.error('UNCAUGHT', e); process.exit(1); });
