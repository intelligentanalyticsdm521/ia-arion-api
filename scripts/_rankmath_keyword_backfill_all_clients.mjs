#!/usr/bin/env node
/**
 * Rank Math focus-keyword backfill for all 3 live client sites.
 *
 * Per STANDING_DECISIONS SD-003 (Option B — Claude API). For every published
 * page/post that has NO rank_math_focus_keyword yet, generate one focus keyword
 * from the page title + content (+ business context inferred from the domain)
 * via the Claude API, and write it to post meta `rank_math_focus_keyword` via
 * wp-cli over SSH. Existing keywords are left untouched (backfill only).
 *
 * Usage:  node scripts/_rankmath_keyword_backfill_all_clients.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { runWpCli } from '../lib/hostingerSsh.js';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';

const KV_URI = process.env.KEY_VAULT_URI || 'https://kv-iadm-prod.vault.azure.net/';
const kv = new SecretClient(KV_URI, new DefaultAzureCredential());
const MODEL = 'claude-haiku-4-5-20251001';

const SITES = [
  { name: 'Rolling In It',       domain: 'rollinginitllc.com'   },
  { name: 'Briarwood Dental',    domain: 'briarwoodsmiles.com'  },
  { name: 'Midwest Ag Services', domain: 'midwestagservices.com' },
];

const LOG_PATH = 'C:/Users/brand/OneDrive/Desktop/Claude Code Session Sync/RANKMATH_KEYWORD_BACKFILL_LOG.md';
const events = [];
const log = (lvl, m, x) => { const l = `${new Date().toISOString()} [${lvl}] ${m}${x ? ' ' + JSON.stringify(x).slice(0, 300) : ''}`; events.push(l); console.log(l); };

let ANTHROPIC_KEY = null;
async function getKey() {
  for (const n of ['ANTHROPIC-API-KEY', 'ANTHROPIC-KEY', 'anthropic-api-key']) {
    try { const s = await kv.getSecret(n); if (s?.value) { log('INFO', `KV key from ${n}`); return s.value.trim(); } } catch {}
  }
  throw new Error('ANTHROPIC key not found in KV');
}

function stripHtml(s) { return (s || '').replace(/<[^>]+>/g, ' ').replace(/\[[^\]]+\]/g, ' ').replace(/\s+/g, ' ').trim(); }
function cleanKw(s) { return (s || '').toLowerCase().replace(/["'\r\n]/g, '').replace(/[^a-z0-9 \-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60); }

async function genKeyword(domain, title, snippet) {
  const prompt =
`You write Rank Math SEO focus keywords for a local business website (${domain}).
Output EXACTLY ONE focus keyword phrase (2-4 words), lowercase, no punctuation, no quotes, that best captures this page for local search. Return ONLY the phrase.

Page title: ${title}
Content excerpt: ${snippet || '(minimal)'}`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 24, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return cleanKw(j?.content?.[0]?.text || '');
}

async function processSite(site) {
  const r = { name: site.name, domain: site.domain, status: 'UNKNOWN', total: 0, written: 0, skipped_existing: 0, failed: 0, items: [], error: null };
  try {
    log('INFO', `── ${site.name} (${site.domain})`);
    let list = [];
    try {
      const res = await runWpCli(site.domain, `post list --post_type=page,post --post_status=publish --fields=ID,post_title,post_type --format=json`);
      list = JSON.parse(res.stdout || '[]');
    } catch (e) { r.status = 'FATAL'; r.error = `post list failed: ${(e.message || '').slice(0, 200)}`; log('ERROR', r.error); return r; }
    r.total = list.length;
    log('INFO', `${site.domain}: ${r.total} published pages/posts`);

    for (const p of list) {
      const id = p.ID;
      try {
        let existing = '';
        try { existing = (await runWpCli(site.domain, `post meta get ${id} rank_math_focus_keyword`)).stdout?.trim() || ''; } catch { existing = ''; }
        if (existing) { r.skipped_existing++; continue; }

        let content = '';
        try { content = stripHtml((await runWpCli(site.domain, `post get ${id} --field=post_content`)).stdout || '').slice(0, 600); } catch {}

        let kw = '';
        try { kw = await genKeyword(site.domain, p.post_title, content); } catch (e) { log('WARN', `${site.domain} #${id}: gen failed, fallback to title`, { e: (e.message || '').slice(0, 120) }); }
        if (!kw) kw = cleanKw(p.post_title);
        if (!kw) { r.failed++; r.items.push({ id, title: p.post_title, kw: '(none)', result: 'FAIL-empty' }); continue; }

        await runWpCli(site.domain, `post meta update ${id} rank_math_focus_keyword '${kw}'`);
        r.written++;
        r.items.push({ id, type: p.post_type, title: p.post_title, kw });
        log('INFO', `${site.domain} #${id} "${(p.post_title||'').slice(0,40)}" → "${kw}"`);
      } catch (e) {
        r.failed++;
        r.items.push({ id, title: p.post_title, result: 'FAIL', err: (e.message || '').slice(0, 150) });
        log('WARN', `${site.domain} #${id}: write failed`, { e: (e.message || '').slice(0, 150) });
      }
    }
    // flush caches so Rank Math recomputes
    for (const c of ['litespeed-purge all', 'cache flush']) { try { await runWpCli(site.domain, c); } catch {} }
    r.status = r.failed === 0 ? 'PASS' : (r.written > 0 ? 'PARTIAL' : 'FAIL');
    log('INFO', `${site.domain}: ${r.status} — written=${r.written} skipped=${r.skipped_existing} failed=${r.failed}`);
  } catch (err) {
    r.status = 'FATAL'; r.error = (err.message || String(err)).slice(0, 300); log('ERROR', `${site.domain}: FATAL ${r.error}`);
  }
  return r;
}

async function main() {
  const started = new Date().toISOString();
  ANTHROPIC_KEY = await getKey();
  const results = [];
  for (const s of SITES) results.push(await processSite(s));

  const L = ['# Rank Math focus-keyword backfill — run log', `\n- Started: ${started}\n- Finished: ${new Date().toISOString()}`, '\n## Per-site\n', '| Site | Domain | Status | Total | Written | Skipped(existing) | Failed |', '|---|---|---|---|---|---|---|'];
  for (const r of results) L.push(`| ${r.name} | ${r.domain} | **${r.status}** | ${r.total} | ${r.written} | ${r.skipped_existing} | ${r.failed} |`);
  for (const r of results) {
    L.push(`\n### ${r.name} — keywords written`);
    L.push('| Post ID | Type | Title | Focus keyword |', '|---|---|---|---|');
    for (const it of r.items.filter(i => i.kw && i.kw !== '(none)')) L.push(`| ${it.id} | ${it.type || ''} | ${(it.title||'').replace(/\|/g,'\\|').slice(0,60)} | ${it.kw} |`);
  }
  L.push('\n## Event log\n```', events.join('\n'), '```');
  try { fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }); fs.writeFileSync(LOG_PATH, L.join('\n'), 'utf8'); console.log(`\n[rankmath] log written: ${LOG_PATH}`); } catch (e) { console.error('log write failed', e.message); }

  console.log('\n════════ SUMMARY ════════');
  for (const r of results) console.log(`  ${r.name.padEnd(24)} [${r.status.padEnd(7)}] written=${r.written} skipped=${r.skipped_existing} failed=${r.failed} (of ${r.total})`);
  process.exit(results.some(r => r.status === 'FATAL' || r.status === 'FAIL') ? 1 : 0);
}
main().catch(e => { console.error('UNCAUGHT', e); process.exit(1); });
