#!/usr/bin/env node
/**
 * Retroactive plugin install for Rolling In It (rollinginitllc.com).
 *
 * Scope (per Brandon 2026-06-24 retro request):
 *   1. Install + activate Elementor Pro (paid, from arion-api blob via gated URL).
 *   2. Install + activate Wordfence (free, from wp.org).
 *   3. Verify RankMath + EWWW already installed (Brandon set up by hand). Skip
 *      install if present; flag if missing.
 *   4. Flush LiteSpeed + WP object caches.
 *   5. Snapshot wp plugin list --format=json and write a structured PASS/FAIL
 *      run log to OneDrive session sync.
 *
 * Uses the existing lib/hostingerSsh.js helpers (which already pull
 * ARION-HOSTINGER-SSH-{HOST,PORT,USER,PRIVATE-KEY-PEM} from KV and rehydrate
 * the single-line PEM into proper line-broken OpenSSH format — that IS the
 * "fixKey()" pattern earlier scripts use).
 *
 * Auth model for Elementor Pro download:
 *   The Pro zip lives in the private stiadmprod blob container behind the
 *   arion-api gated endpoint /plugin/paid/elementor-pro?token=<code>. We mint
 *   a fresh 7-day provision code first so the remote box's curl can pull it.
 *
 * License activation:
 *   The Elementor Pro license key is in KV under secret name `elementor-pro`.
 *   We write it to wp_options.elementor_pro_license_key (which Elementor reads
 *   on admin_init) and best-effort try `wp elementor-pro license activate`.
 *
 * Usage:
 *   cd C:/dev/iadm/arion-api
 *   node scripts/_retro_install_rii_elementor_pro_wordfence.mjs
 *
 * Exit code:
 *   0 = all PASS
 *   1 = one or more FAIL (run log still written)
 *   2 = fatal (SSH connect / KV / SQL) — run log written when possible
 */

import fs from 'node:fs';
import path from 'node:path';
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { runSshCommand, runWpCli, checkWpInstallExists } from '../lib/hostingerSsh.js';
import { createProvisionCode } from '../lib/provisionCodes.js';

// ────────────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────────────
const TENANT_ID = '12839687-67FA-4144-A152-1219D1A64901';
const SITE_ID   = '4E3B2AE2-4133-4813-84AA-4196661ED6F9';
const DOMAIN    = 'rollinginitllc.com';

const KV_URI = process.env.KEY_VAULT_URI || 'https://kv-iadm-prod.vault.azure.net/';
const ARION_API_BASE = (process.env.ARION_API_BASE_URL
  || 'https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net').replace(/\/+$/, '');

const LOG_PATH = 'C:/Users/brand/OneDrive/Desktop/Claude Code Session Sync/ROLLING_IN_IT_PLUGIN_RETRO_LOG.md';

const TARGETS = [
  { slug: 'elementor',     mode: 'wporg',  required: true,  note: 'Free Elementor base — required for Pro' },
  { slug: 'elementor-pro', mode: 'blob',   required: true,  note: 'Paid Pro addon, blob via arion-api' },
  { slug: 'wordfence',     mode: 'wporg',  required: true,  note: 'Free Wordfence Security' },
  { slug: 'seo-by-rank-math', mode: 'verify_only', required: false, note: 'Brandon set up by hand' },
  { slug: 'ewww-image-optimizer', mode: 'verify_only', required: false, note: 'Brandon set up by hand' },
];

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────
const cred = new DefaultAzureCredential();
const kv = new SecretClient(KV_URI, cred);

const runEvents = [];
function logEvent(level, msg, extra) {
  const e = { ts: new Date().toISOString(), level, msg };
  if (extra) e.extra = extra;
  runEvents.push(e);
  const prefix = level === 'ERROR' ? '[ERR ]' : level === 'WARN' ? '[WARN]' : '[INFO]';
  console.log(`${prefix} ${msg}${extra ? ' ' + JSON.stringify(extra).slice(0, 400) : ''}`);
}

async function getServicesPool() {
  const tok = await cred.getToken('https://database.windows.net/.default');
  return await sql.connect({
    server: 'sql-iadm-prod-cus.database.windows.net',
    database: 'iadm_services',
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-access-token', options: { token: tok.token } },
  });
}

/** Check `wp plugin is-installed <slug>` — exit 0 = installed, non-zero = missing. */
async function isPluginInstalled(slug) {
  try {
    await runWpCli(DOMAIN, `plugin is-installed ${slug}`);
    return true;
  } catch (_err) {
    return false;
  }
}

/** Check `wp plugin is-active <slug>` — exit 0 = active, non-zero = inactive or missing. */
async function isPluginActive(slug) {
  try {
    await runWpCli(DOMAIN, `plugin is-active ${slug}`);
    return true;
  } catch (_err) {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Per-plugin install actions
// ────────────────────────────────────────────────────────────────────────────

/** Install + activate a free wp.org plugin. Idempotent (wp-cli swallows "already installed"). */
async function installWpOrgPlugin(slug) {
  const result = { slug, mode: 'wporg', status: 'UNKNOWN', already_installed: false, already_active: false, output: '', error: null };
  try {
    result.already_installed = await isPluginInstalled(slug);
    result.already_active    = await isPluginActive(slug);
    if (result.already_active) {
      result.status = 'PASS';
      result.output = 'already installed + active — no-op';
      logEvent('INFO', `${slug}: already installed + active`);
      return result;
    }
    const res = await runWpCli(DOMAIN, `plugin install ${slug} --activate --force`);
    result.output = (res.stdout || '').slice(0, 800);
    // Re-verify active state.
    if (await isPluginActive(slug)) {
      result.status = 'PASS';
      logEvent('INFO', `${slug}: installed + activated`, { stdout_tail: result.output.slice(-200) });
    } else {
      result.status = 'FAIL';
      result.error = 'plugin install completed but is-active still false';
      logEvent('ERROR', `${slug}: install ran but plugin not active`, { output: result.output });
    }
  } catch (err) {
    result.status = 'FAIL';
    result.error = (err.stderr || err.message || '').toString().slice(0, 600);
    logEvent('ERROR', `${slug}: install failed`, { error: result.error });
  }
  return result;
}

/**
 * Install Elementor Pro via the arion-api gated /plugin/paid/elementor-pro
 * endpoint. Caller passes the minted provision code; we curl-download to a
 * tempfile on the remote box, size-check, install from local file, then
 * write the license key option and best-effort run the activate CLI.
 */
async function installElementorPro(provisionCode) {
  const result = { slug: 'elementor-pro', mode: 'blob', status: 'UNKNOWN', already_installed: false, already_active: false, output: '', error: null, license: { option_written: false, cli_activate: false, cli_activate_error: null } };
  const tmpPath = `/tmp/ia-elementor-pro-${Date.now()}.zip`;
  try {
    result.already_active = await isPluginActive('elementor-pro');
    if (result.already_active) {
      // Brandon's retro intent says "install" but if it's already active we
      // still want to refresh the license. Don't redownload — just re-write
      // the option key.
      logEvent('INFO', 'elementor-pro: already active — refreshing license only');
      result.already_installed = true;
    } else {
      // 1. Preflight HEAD probe of arion-api gated URL.
      const url = `${ARION_API_BASE}/plugin/paid/elementor-pro?token=${encodeURIComponent(provisionCode)}`;
      const safeUrl = url.replace(/'/g, `'\\''`);
      const probeRes = await runSshCommand(`curl -sS -o /dev/null -w '%{http_code}' -I '${safeUrl}' || echo curl_err`);
      const probeStatus = ((probeRes.stdout || '') + (probeRes.stderr || '')).trim().slice(-3);
      logEvent('INFO', 'elementor-pro: blob preflight', { http: probeStatus });
      if (probeStatus === '404') throw new Error('blob_missing: arion-api returned 404 (plugins/elementor-pro/elementor-pro-latest.zip not uploaded)');
      if (probeStatus === '401' || probeStatus === '403') throw new Error(`token_invalid_or_expired: arion-api ${probeStatus}`);
      if (!/^2\d\d$/.test(probeStatus)) logEvent('WARN', `elementor-pro: preflight non-2xx ${probeStatus} — attempting download anyway`);

      // 2. Download to tempfile.
      const dlRes = await runSshCommand(`curl -sS --fail-with-body --retry 2 --retry-delay 2 -o ${tmpPath} -w '%{http_code}' '${safeUrl}'`);
      const dlStatus = ((dlRes.stdout || '') + '').trim().slice(-3);
      if (!/^2\d\d$/.test(dlStatus)) {
        const peek = await runSshCommand(`head -c 400 ${tmpPath} 2>/dev/null || true`).catch(() => ({ stdout: '' }));
        throw new Error(`download_failed: HTTP ${dlStatus} body=${(peek.stdout || '').slice(0, 300)}`);
      }

      // 3. Size check — legit Pro zip is ~3.8MB; reject < 100KB.
      const sizeRes = await runSshCommand(`stat -c%s ${tmpPath} 2>/dev/null || wc -c < ${tmpPath}`);
      const sizeBytes = Number((sizeRes.stdout || '').trim().split(/\s+/)[0] || '0');
      logEvent('INFO', `elementor-pro: zip size ${sizeBytes} bytes`);
      if (sizeBytes < 100 * 1024) throw new Error(`size_check_failed: zip is only ${sizeBytes} bytes (expected >100KB)`);

      // 4. wp plugin install from local file.
      const installRes = await runWpCli(DOMAIN, `plugin install ${tmpPath} --activate --force`);
      result.output = (installRes.stdout || '').slice(0, 800);

      // 5. Verify is-active.
      if (!(await isPluginActive('elementor-pro'))) {
        throw new Error('install ran but plugin not active');
      }
      logEvent('INFO', 'elementor-pro: installed + activated', { stdout_tail: result.output.slice(-200) });
      result.already_installed = true;

      // Cleanup tempfile (best-effort).
      runSshCommand(`rm -f ${tmpPath}`).catch(() => {});
    }

    // 6. License activation. KV secret name is literal 'elementor-pro' per
    //    pluginStack.js spec.
    try {
      const lic = await kv.getSecret('elementor-pro');
      const licenseKey = (lic.value || '').trim();
      if (!licenseKey) throw new Error('KV secret elementor-pro returned empty value');
      // Write the option (this is the authoritative path — Elementor picks it up
      // on next admin_init regardless of CLI activate outcome).
      const escaped = licenseKey.replace(/'/g, `'\\''`);
      await runWpCli(DOMAIN, `option update elementor_pro_license_key '${escaped}'`);
      result.license.option_written = true;
      logEvent('INFO', 'elementor-pro: license option written', { key_prefix: licenseKey.slice(0, 4), key_len: licenseKey.length });
      // Best-effort CLI activate. CLI was added in Pro 3.20 and renamed in 4.x;
      // soft-fail because the option write is what matters.
      try {
        const actRes = await runWpCli(DOMAIN, `elementor-pro license activate '${escaped}'`);
        result.license.cli_activate = true;
        logEvent('INFO', 'elementor-pro: CLI license activate succeeded', { stdout: (actRes.stdout || '').slice(0, 200) });
      } catch (cliErr) {
        result.license.cli_activate_error = (cliErr.stderr || cliErr.message || '').toString().slice(0, 300);
        logEvent('WARN', 'elementor-pro: CLI license activate failed (option write succeeded — non-fatal)', { error: result.license.cli_activate_error });
      }
    } catch (licErr) {
      result.error = `license activation failed: ${(licErr.message || '').slice(0, 300)}`;
      logEvent('ERROR', 'elementor-pro: license activation failed', { error: result.error });
      result.status = 'FAIL';
      return result;
    }

    result.status = 'PASS';
  } catch (err) {
    result.status = 'FAIL';
    result.error = (err.stderr || err.message || '').toString().slice(0, 600);
    logEvent('ERROR', 'elementor-pro: install failed', { error: result.error });
    // Best-effort cleanup.
    runSshCommand(`rm -f ${tmpPath}`).catch(() => {});
  }
  return result;
}

/** Verify-only mode — Brandon already set this up. PASS if installed (active or not), FAIL if missing. */
async function verifyExisting(slug) {
  const result = { slug, mode: 'verify_only', status: 'UNKNOWN', already_installed: false, already_active: false, error: null };
  try {
    result.already_installed = await isPluginInstalled(slug);
    result.already_active = await isPluginActive(slug);
    if (result.already_installed) {
      result.status = 'PASS';
      logEvent('INFO', `${slug}: verified present`, { active: result.already_active });
    } else {
      result.status = 'FAIL';
      result.error = 'expected pre-installed by Brandon but wp plugin is-installed returned non-zero';
      logEvent('ERROR', `${slug}: NOT installed (expected pre-installed)`);
    }
  } catch (err) {
    result.status = 'FAIL';
    result.error = (err.message || '').slice(0, 300);
  }
  return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Run-log writer
// ────────────────────────────────────────────────────────────────────────────
function writeRunLog({ results, listJson, listParsed, cacheFlush, fatalError, overallStatus, provisionCodeMasked, startedAt, finishedAt }) {
  const lines = [];
  lines.push('# Rolling In It — retroactive plugin install run log');
  lines.push('');
  lines.push(`- **Domain**: ${DOMAIN}`);
  lines.push(`- **Tenant ID**: ${TENANT_ID}`);
  lines.push(`- **Site ID**: ${SITE_ID}`);
  lines.push(`- **Script**: \`arion-api/scripts/_retro_install_rii_elementor_pro_wordfence.mjs\``);
  lines.push(`- **Started**: ${startedAt}`);
  lines.push(`- **Finished**: ${finishedAt}`);
  lines.push(`- **Overall**: **${overallStatus}**`);
  if (provisionCodeMasked) lines.push(`- **Provision code (masked)**: ${provisionCodeMasked} (7-day TTL)`);
  lines.push('');
  lines.push('## Per-plugin result');
  lines.push('');
  lines.push('| Plugin | Mode | Status | Was-installed | Was-active | Notes |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of results) {
    const note = (r.error ? r.error : (r.output ? r.output.split('\n').filter(Boolean).slice(-2).join(' / ') : '')).replace(/\|/g, '\\|').slice(0, 200);
    lines.push(`| \`${r.slug}\` | ${r.mode} | **${r.status}** | ${r.already_installed ? 'yes' : 'no'} | ${r.already_active ? 'yes' : 'no'} | ${note} |`);
  }
  lines.push('');
  if (results.find((r) => r.slug === 'elementor-pro')) {
    const ep = results.find((r) => r.slug === 'elementor-pro');
    lines.push('## Elementor Pro license');
    lines.push('');
    lines.push(`- **option_written** (\`elementor_pro_license_key\`): ${ep.license?.option_written ? 'yes' : 'no'}`);
    lines.push(`- **CLI activate**: ${ep.license?.cli_activate ? 'yes' : 'no'}${ep.license?.cli_activate_error ? ' — soft-fail OK: ' + ep.license.cli_activate_error.slice(0, 200) : ''}`);
    lines.push('');
  }
  lines.push('## Cache flush');
  lines.push('');
  if (cacheFlush) {
    lines.push(`- **litespeed-purge all**: ${cacheFlush.litespeed.ok ? 'OK' : 'FAIL'} — ${cacheFlush.litespeed.note}`);
    lines.push(`- **wp cache flush**: ${cacheFlush.wpcache.ok ? 'OK' : 'FAIL'} — ${cacheFlush.wpcache.note}`);
  } else {
    lines.push('- (skipped — fatal error before this step)');
  }
  lines.push('');
  lines.push('## Final `wp plugin list` snapshot');
  lines.push('');
  if (listParsed && Array.isArray(listParsed)) {
    lines.push('| name | status | version | update |');
    lines.push('|---|---|---|---|');
    for (const p of listParsed) {
      lines.push(`| \`${p.name}\` | ${p.status} | ${p.version || '?'} | ${p.update || ''} |`);
    }
  } else if (listJson) {
    lines.push('```json');
    lines.push(listJson.slice(0, 6000));
    lines.push('```');
  } else {
    lines.push('(no list captured)');
  }
  lines.push('');
  if (fatalError) {
    lines.push('## Fatal error');
    lines.push('');
    lines.push('```');
    lines.push(fatalError.slice(0, 2000));
    lines.push('```');
    lines.push('');
  }
  lines.push('## Event log');
  lines.push('');
  lines.push('```');
  for (const e of runEvents) {
    lines.push(`${e.ts} [${e.level}] ${e.msg}${e.extra ? ' ' + JSON.stringify(e.extra).slice(0, 400) : ''}`);
  }
  lines.push('```');
  lines.push('');

  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.writeFileSync(LOG_PATH, lines.join('\n'), 'utf8');
    console.log(`[retro-rii] run log written: ${LOG_PATH}`);
  } catch (writeErr) {
    console.error(`[retro-rii] FAILED to write run log: ${writeErr.message}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────
async function main() {
  const startedAt = new Date().toISOString();
  logEvent('INFO', `start tenant=${TENANT_ID} site=${SITE_ID} domain=${DOMAIN}`);

  let pool, provisionCode, provisionCodeMasked;
  let listJson = null, listParsed = null, cacheFlush = null;
  let fatalError = null;
  const results = [];

  try {
    // 0. Pre-flight: confirm WP install exists at expected path.
    const wpExists = await checkWpInstallExists(DOMAIN);
    if (!wpExists) throw new Error(`WP install missing at ~/domains/${DOMAIN}/public_html — aborting`);
    logEvent('INFO', 'WP install directory confirmed');

    // 1. Mint a fresh 7-day provision code (for /plugin/paid/elementor-pro auth).
    pool = await getServicesPool();
    const codeRes = await createProvisionCode(pool, {
      tenantId: TENANT_ID, siteId: SITE_ID, createdBy: 'retro_install_rii', ttlDays: 7,
    });
    provisionCode = codeRes.code;
    provisionCodeMasked = `${provisionCode.slice(0, 8)}…(${provisionCode.length})`;
    logEvent('INFO', 'minted provision code', { masked: provisionCodeMasked });

    // 2. Process each target in order.
    for (const t of TARGETS) {
      logEvent('INFO', `── ${t.slug} (${t.mode}) — ${t.note}`);
      if (t.mode === 'wporg') {
        results.push(await installWpOrgPlugin(t.slug));
      } else if (t.mode === 'blob' && t.slug === 'elementor-pro') {
        results.push(await installElementorPro(provisionCode));
      } else if (t.mode === 'verify_only') {
        results.push(await verifyExisting(t.slug));
      } else {
        results.push({ slug: t.slug, mode: t.mode, status: 'FAIL', error: 'unhandled mode' });
      }
    }

    // 3. Cache flush — both LiteSpeed and core. Both soft-fail.
    cacheFlush = { litespeed: { ok: false, note: '' }, wpcache: { ok: false, note: '' } };
    try {
      const r = await runWpCli(DOMAIN, 'litespeed-purge all');
      cacheFlush.litespeed.ok = true;
      cacheFlush.litespeed.note = (r.stdout || '').trim().slice(0, 200) || 'OK';
      logEvent('INFO', 'litespeed-purge all OK', { stdout: cacheFlush.litespeed.note });
    } catch (e) {
      cacheFlush.litespeed.note = (e.stderr || e.message || '').toString().slice(0, 200);
      logEvent('WARN', 'litespeed-purge all failed (non-fatal)', { error: cacheFlush.litespeed.note });
    }
    try {
      const r = await runWpCli(DOMAIN, 'cache flush');
      cacheFlush.wpcache.ok = true;
      cacheFlush.wpcache.note = (r.stdout || '').trim().slice(0, 200) || 'OK';
      logEvent('INFO', 'wp cache flush OK', { stdout: cacheFlush.wpcache.note });
    } catch (e) {
      cacheFlush.wpcache.note = (e.stderr || e.message || '').toString().slice(0, 200);
      logEvent('WARN', 'wp cache flush failed (non-fatal)', { error: cacheFlush.wpcache.note });
    }

    // 4. Live-verify plugin list — snapshot AFTER all changes.
    try {
      const listRes = await runWpCli(DOMAIN, 'plugin list --format=json');
      listJson = listRes.stdout || '';
      try {
        listParsed = JSON.parse(listJson);
        logEvent('INFO', `plugin list captured: ${listParsed.length} plugins`);
        // Cross-check the target slugs against the live list.
        for (const r of results) {
          const live = listParsed.find((p) => p.name === r.slug);
          if (!live) {
            logEvent('WARN', `${r.slug}: NOT in live plugin list (post-install verify)`);
            if (r.status === 'PASS' && r.mode !== 'verify_only') {
              r.status = 'FAIL';
              r.error = (r.error ? r.error + ' | ' : '') + 'post-install verify: slug missing from wp plugin list';
            }
          } else {
            // For wporg + blob installs, "active" is the bar.
            if (r.mode !== 'verify_only' && live.status !== 'active' && live.status !== 'must-use') {
              logEvent('WARN', `${r.slug}: live status=${live.status} (expected active)`);
              if (r.status === 'PASS') {
                r.status = 'FAIL';
                r.error = (r.error ? r.error + ' | ' : '') + `post-install verify: live status=${live.status}`;
              }
            }
            r.verified_live_version = live.version;
            r.verified_live_status = live.status;
          }
        }
      } catch (parseErr) {
        logEvent('WARN', `plugin list JSON parse failed: ${parseErr.message}`);
      }
    } catch (e) {
      logEvent('ERROR', 'plugin list capture failed', { error: (e.message || '').slice(0, 300) });
    }
  } catch (err) {
    fatalError = (err.stack || err.message || String(err)).slice(0, 2000);
    logEvent('ERROR', 'FATAL', { error: fatalError });
  } finally {
    if (pool) { try { await pool.close(); } catch (_) {} }
  }

  // Compute overall.
  const finishedAt = new Date().toISOString();
  const anyFail = results.some((r) => r.status === 'FAIL');
  const overallStatus = fatalError ? 'FATAL' : (anyFail ? 'FAIL' : 'PASS');

  writeRunLog({ results, listJson, listParsed, cacheFlush, fatalError, overallStatus, provisionCodeMasked, startedAt, finishedAt });

  // Console summary.
  console.log('\n══════════════════════════════════════════════════════════');
  console.log('   FINAL SUMMARY');
  console.log('══════════════════════════════════════════════════════════');
  console.log(`Overall: ${overallStatus}`);
  for (const r of results) {
    const live = r.verified_live_version ? ` live=${r.verified_live_status} v${r.verified_live_version}` : '';
    console.log(`  ${r.slug.padEnd(28)} [${r.status.padEnd(4)}] ${r.mode}${live}${r.error ? '  err=' + r.error.slice(0, 120) : ''}`);
  }
  if (cacheFlush) {
    console.log(`  litespeed-purge all          [${cacheFlush.litespeed.ok ? 'OK  ' : 'FAIL'}]`);
    console.log(`  wp cache flush               [${cacheFlush.wpcache.ok ? 'OK  ' : 'FAIL'}]`);
  }
  console.log('══════════════════════════════════════════════════════════');

  if (fatalError) process.exit(2);
  if (anyFail) process.exit(1);
  process.exit(0);
}

main().catch((e) => {
  console.error('UNCAUGHT FATAL:', e);
  // Best-effort write a log even on uncaught.
  try {
    writeRunLog({
      results: [],
      listJson: null,
      listParsed: null,
      cacheFlush: null,
      fatalError: (e.stack || e.message || String(e)).slice(0, 2000),
      overallStatus: 'FATAL',
      provisionCodeMasked: null,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
  } catch (_) {}
  process.exit(2);
});
