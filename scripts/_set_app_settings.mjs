#!/usr/bin/env node
/**
 * _set_app_settings.mjs — read or set App Service / Function App settings.
 *
 * Written because ARION_API_BASE_URL was never set on func-iadm-arion-prod, so
 * the insights snapshot timer took its "not set — skipping" branch on every run
 * and EVERY external integration went dark: GA4, GSC, GBP, PageSpeed and SE
 * Ranking all stopped at the July manual backfill and nothing anywhere said so.
 *
 * Merges into the existing settings — a PUT to appsettings REPLACES the whole
 * collection, so anything not sent is deleted. This reads first, merges, then
 * writes, and prints what changed.
 *
 * Uses the management plane via an `az` token (the Python `az` CLI itself fails
 * TLS against the AVG root cert on this machine; Node's stack does not).
 *
 * Usage:
 *   node scripts/_set_app_settings.mjs <appName>                    # show
 *   node scripts/_set_app_settings.mjs <appName> KEY=VALUE [...] --apply
 */
import { execSync } from 'node:child_process';

const app = process.argv[2];
const APPLY = process.argv.includes('--apply');
const pairs = process.argv.slice(3).filter((a) => a.includes('=') && !a.startsWith('--'));
if (!app) { console.error('usage: node scripts/_set_app_settings.mjs <appName> [KEY=VALUE ...] [--apply]'); process.exit(1); }

const token = execSync('az account get-access-token --resource https://management.azure.com --query accessToken -o tsv',
  { encoding: 'utf8', maxBuffer: 10 << 20 }).trim();
const sub = execSync('az account show --query id -o tsv', { encoding: 'utf8' }).trim();
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const sites = await (await fetch(
  `https://management.azure.com/subscriptions/${sub}/providers/Microsoft.Web/sites?api-version=2023-01-01`,
  { headers: H })).json();
const site = (sites.value || []).find((s) => s.name === app);
if (!site) { console.error(`no App Service named ${app}`); process.exit(1); }

const cur = await (await fetch(`https://management.azure.com${site.id}/config/appsettings/list?api-version=2023-01-01`,
  { method: 'POST', headers: H })).json();
const props = { ...(cur.properties || {}) };

const mask = (k, v) => (/KEY|SECRET|PASSWORD|TOKEN|CONNECTION/i.test(k) ? `SET (${String(v).length} chars)` : v);

if (!pairs.length) {
  console.log(`${app} — ${Object.keys(props).length} settings`);
  for (const k of Object.keys(props).sort()) console.log(`  ${k.padEnd(38)} ${mask(k, props[k])}`);
  process.exit(0);
}

console.log(`${app}`);
let changed = 0;
for (const p of pairs) {
  const i = p.indexOf('=');
  const k = p.slice(0, i), v = p.slice(i + 1);
  const before = props[k];
  if (before === v) { console.log(`  ${k.padEnd(30)} unchanged`); continue; }
  console.log(`  ${k.padEnd(30)} ${before == null ? '(not set)' : mask(k, before)}  ->  ${mask(k, v)}`);
  props[k] = v;
  changed++;
}
if (!changed) { console.log('\nnothing to change'); process.exit(0); }
if (!APPLY) { console.log('\nDRY RUN — re-run with --apply.'); process.exit(0); }

const put = await fetch(`https://management.azure.com${site.id}/config/appsettings?api-version=2023-01-01`,
  { method: 'PUT', headers: H, body: JSON.stringify({ properties: props }) });
if (!put.ok) { console.error(`PUT failed ${put.status}: ${(await put.text()).slice(0, 300)}`); process.exit(1); }
console.log(`\napplied — ${Object.keys(props).length} settings retained`);
