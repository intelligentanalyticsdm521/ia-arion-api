#!/usr/bin/env node
/**
 * PROD DATA — live PageSpeed Insights run for all four sites (Brandon
 * 2026-07-25: Briarwood's PSI is decent and it wasn't in the score at all).
 * Writes current-month psi_* + Core Web Vitals rows to arion.metric_monthly
 * (scores/averages are valid mid-month; the monthly timer continues them).
 * PSI history is not backfillable — it starts accruing now.
 *
 * Run from C:\dev\iadm\arion-api:  node scripts/_backfill_psi_prod.mjs
 */
import 'dotenv/config';
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';
import { mergeMetricRows } from '../lib/insightsSnapshot.js';

const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net', database: 'iadm_services',
  options: { encrypt: true }, requestTimeout: 120000,
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();

const ym = new Date().toISOString().slice(0, 7);
// Same secret the arion-func pagespeedRunner uses (env GOOGLE_API_KEY, KV
// fallback GOOGLE-PAGESPEED-API-KEY). Value never printed.
let KEY = process.env.GOOGLE_API_KEY || process.env.PAGESPEED_API_KEY || '';
if (!KEY) {
  try {
    const { SecretClient } = await import('@azure/keyvault-secrets');
    const { DefaultAzureCredential } = await import('@azure/identity');
    const kv = new SecretClient('https://kv-iadm-prod.vault.azure.net/', new DefaultAzureCredential());
    KEY = (await kv.getSecret('GOOGLE-PAGESPEED-API-KEY'))?.value?.trim() || '';
    if (KEY) console.log('[key] PSI key from KV');
  } catch { /* keyless attempt below */ }
}

async function psi(domain, strategy, attempt = 1) {
  const url = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
  url.searchParams.set('url', `https://${domain}`);
  url.searchParams.set('strategy', strategy);
  for (const c of ['performance', 'accessibility', 'best-practices', 'seo']) url.searchParams.append('category', c);
  if (KEY) url.searchParams.set('key', KEY);
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) {
    const body = (await r.text()).slice(0, 150);
    // Lighthouse throws transient 500s — same retry the arion-func runner
    // needed (up to 3 attempts).
    if (r.status >= 500 && attempt < 3) {
      await new Promise((res) => setTimeout(res, 5000 * attempt));
      return psi(domain, strategy, attempt + 1);
    }
    throw new Error(`PSI ${strategy} ${r.status}: ${body}`);
  }
  return r.json();
}

try {
  const sites = (await pool.request().query(`
    SELECT site_id, tenant_id, domain FROM arion.site WHERE domain IS NOT NULL`)).recordset;

  for (const site of sites) {
    try {
      const [mobile, desktop] = [await psi(site.domain, 'mobile'), await psi(site.domain, 'desktop')];
      const cat = (res, c) => {
        const s = res?.lighthouseResult?.categories?.[c]?.score;
        return s != null ? Math.round(s * 100) : null;
      };
      const crux = (res, k) => res?.loadingExperience?.metrics?.[k]?.percentile ?? null;
      const rows = [];
      const push = (key, value) => { if (value != null && isFinite(value)) rows.push({ ym, source: 'psi', key, value }); };
      push('psi_mobile_perf', cat(mobile, 'performance'));
      push('psi_desktop_perf', cat(desktop, 'performance'));
      push('psi_accessibility', cat(mobile, 'accessibility'));
      push('psi_best_practices', cat(mobile, 'best-practices'));
      push('psi_seo', cat(mobile, 'seo'));
      push('lcp_ms', crux(mobile, 'LARGEST_CONTENTFUL_PAINT_MS'));
      push('inp_ms', crux(mobile, 'INTERACTION_TO_NEXT_PAINT'));
      const cls = crux(mobile, 'CUMULATIVE_LAYOUT_SHIFT_SCORE');
      if (cls != null) push('cls', cls / 100); // CrUX reports CLS ×100
      const lcp = crux(mobile, 'LARGEST_CONTENTFUL_PAINT_MS');
      if (lcp != null) push('cwv_pass', lcp <= 2500 ? 100 : 0);
      const n = await mergeMetricRows(pool, site, rows);
      console.log(`${site.domain}: mobile perf ${cat(mobile, 'performance')} / desktop ${cat(desktop, 'performance')} / a11y ${cat(mobile, 'accessibility')} / bp ${cat(mobile, 'best-practices')} / seo ${cat(mobile, 'seo')} → ${n} row(s)`);
    } catch (e) {
      console.log(`${site.domain}: PSI failed — ${e.message.slice(0, 160)}`);
    }
  }
} finally {
  await pool.close();
}
