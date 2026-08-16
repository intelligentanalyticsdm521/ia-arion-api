#!/usr/bin/env node
/**
 * Bring IA's own site (intelligentanalyticsdm.com) to parity with the 3 client
 * sites: Wordfence→Shield swap, IA plugin v1.3.1 (Shield reader) deploy, Rank
 * Math focus-keyword backfill, and drop stale wp_wf* tables. Same safe patterns
 * as the per-site scripts (Shield-first; SFTP + server php -l gate; backfill
 * only missing keywords).
 */
import fs from 'node:fs';
import { runWpCli, runSshCommand, uploadFileViaSftp, checkWpInstallExists } from '../lib/hostingerSsh.js';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

const DOMAIN = 'intelligentanalyticsdm.com';
const SHIELD = 'wp-simple-firewall';
const WF = 'wordfence';
const LOCAL_PLUGIN = 'C:/dev/iadm/intelligent-analytics - WP Plugin/intelligent-analytics.php';

const isInstalled = async (s) => { try { await runWpCli(DOMAIN, `plugin is-installed ${s}`); return true; } catch { return false; } };
const isActive = async (s) => { try { await runWpCli(DOMAIN, `plugin is-active ${s}`); return true; } catch { return false; } };
const stripHtml = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/\[[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim();
const cleanKw = (s) => (s || '').toLowerCase().replace(/["'\r\n]/g, '').replace(/[^a-z0-9 \-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);

async function main() {
  console.log(`== FINISH IA OWN SITE: ${DOMAIN} ==`);
  if (!(await checkWpInstallExists(DOMAIN))) { console.log('FATAL: WP not reachable on this SSH host — IA site may be on a different account.'); process.exit(2); }

  // ── 1. Shield-first swap ──
  console.log('\n[1] Wordfence → Shield');
  const wfBefore = await isInstalled(WF);
  if (!(await isActive(SHIELD))) { await runWpCli(DOMAIN, `plugin install ${SHIELD} --activate --force`); }
  const shieldActive = await isActive(SHIELD);
  console.log(`  shield active=${shieldActive} (wf was installed=${wfBefore})`);
  if (shieldActive && wfBefore) {
    try { await runWpCli(DOMAIN, `plugin deactivate ${WF}`); } catch {}
    try { await runWpCli(DOMAIN, `plugin delete ${WF}`); } catch {}
  }
  console.log(`  wordfence installed after=${await isInstalled(WF)}`);

  // ── 2. Plugin v1.3.1 deploy (SFTP → server php -l → swap) ──
  console.log('\n[2] Deploy IA plugin v1.3.1');
  const buf = fs.readFileSync(LOCAL_PLUGIN);
  const plugdir = ((await runWpCli(DOMAIN, `eval "echo WP_PLUGIN_DIR;"`)).stdout || '').trim();
  const target = `${plugdir}/intelligent-analytics/intelligent-analytics.php`;
  const tmp = `${target}.new`;
  await uploadFileViaSftp(buf, tmp);
  const lint = ((await runSshCommand(`php -l '${tmp}' 2>&1`)).stdout || '');
  if (!/No syntax errors detected/.test(lint)) { console.log(`  LINT FAIL — live file untouched: ${lint.slice(0,200)}`); await runSshCommand(`rm -f '${tmp}'`).catch(()=>{}); }
  else {
    await runSshCommand(`cp -f '${target}' '${target}.bak-20260705' && mv -f '${tmp}' '${target}'`);
    const ver = ((await runWpCli(DOMAIN, 'plugin get intelligent-analytics --field=version')).stdout || '').trim();
    console.log(`  php -l OK, swapped. plugin version=${ver}, active=${await isActive('intelligent-analytics')}`);
  }

  // ── 3. Rank Math keyword backfill (missing only) ──
  console.log('\n[3] Rank Math keyword backfill');
  const kv = new SecretClient('https://kv-iadm-prod.vault.azure.net/', new DefaultAzureCredential());
  let key = null;
  for (const n of ['ANTHROPIC-API-KEY', 'ANTHROPIC-KEY']) { try { const s = await kv.getSecret(n); if (s?.value) { key = s.value.trim(); break; } } catch {} }
  let written = 0, skipped = 0, failed = 0, total = 0;
  if (!key) { console.log('  ANTHROPIC key not found — skipping keyword backfill'); }
  else {
    const list = JSON.parse(((await runWpCli(DOMAIN, `post list --post_type=page,post --post_status=publish --fields=ID,post_title --format=json`)).stdout || '[]'));
    total = list.length;
    for (const p of list) {
      try {
        let existing = ''; try { existing = ((await runWpCli(DOMAIN, `post meta get ${p.ID} rank_math_focus_keyword`)).stdout || '').trim(); } catch {}
        if (existing) { skipped++; continue; }
        let content = ''; try { content = stripHtml(((await runWpCli(DOMAIN, `post get ${p.ID} --field=post_content`)).stdout || '')).slice(0, 600); } catch {}
        let kw = '';
        try {
          const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
            body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 24, messages: [{ role: 'user', content: `Write ONE Rank Math SEO focus keyword (2-4 words, lowercase, no punctuation) for this page on ${DOMAIN}. Return ONLY the phrase.\n\nTitle: ${p.post_title}\nExcerpt: ${content || '(minimal)'}` }] }) });
          if (res.ok) { const j = await res.json(); kw = cleanKw(j?.content?.[0]?.text || ''); }
        } catch {}
        if (!kw) kw = cleanKw(p.post_title);
        if (!kw) { failed++; continue; }
        await runWpCli(DOMAIN, `post meta update ${p.ID} rank_math_focus_keyword '${kw}'`);
        written++; console.log(`  #${p.ID} "${(p.post_title||'').slice(0,36)}" → "${kw}"`);
      } catch (e) { failed++; }
    }
    for (const c of ['litespeed-purge all', 'cache flush']) { try { await runWpCli(DOMAIN, c); } catch {} }
  }
  console.log(`  keywords: written=${written} skipped=${skipped} failed=${failed} (of ${total})`);

  // ── 4. Drop stale wp_wf* tables ──
  console.log('\n[4] Drop stale Wordfence tables');
  const prefix = ((await runWpCli(DOMAIN, 'config get table_prefix')).stdout || 'wp_').trim();
  const wtabs = (((await runWpCli(DOMAIN, `db query "SHOW TABLES LIKE '${prefix}wf%'" --skip-column-names`)).stdout || '').trim()).split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if (wtabs.length) { await runWpCli(DOMAIN, `db query "DROP TABLE IF EXISTS ${wtabs.join(', ')}"`); console.log(`  dropped ${wtabs.length} tables`); }
  else console.log('  no wp_wf* tables — clean');

  console.log('\n== IA site done ==');
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
