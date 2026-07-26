#!/usr/bin/env node
/** READ-ONLY: GA4 truth per site — property reachable? months of data? which
 *  events fire, and do ANY count as key events (conversions)? Settles
 *  "Briarwood GA4 is fine, why can't you find stuff" with facts. */
import 'dotenv/config';
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';
import { getAccessToken } from '../lib/googleBusiness.js';

const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net', database: 'iadm_services',
  options: { encrypt: true },
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();
const sites = (await pool.request().query(`
  SELECT domain, gbp_oauth_token_ref, gsc_oauth_token_ref, ga4_property_id
  FROM arion.site WHERE domain IS NOT NULL`)).recordset;
await pool.close();

for (const s of sites) {
  console.log(`\n── ${s.domain} · GA4 property ${s.ga4_property_id}`);
  const tok = await getAccessToken(s.gsc_oauth_token_ref || s.gbp_oauth_token_ref);
  if (!tok?.access_token) { console.log('  token refresh failed'); continue; }
  const run = async (body) => {
    const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${s.ga4_property_id}:runReport`, {
      method: 'POST', headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`${r.status}: ${(j?.error?.message || '').slice(0, 150)}`);
    return j;
  };
  try {
    const range = { startDate: '2025-04-01', endDate: 'today' };
    const months = await run({ dateRanges: [range], dimensions: [{ name: 'yearMonth' }], metrics: [{ name: 'sessions' }], limit: 30 });
    const ms = (months.rows || []).map((r) => `${r.dimensionValues[0].value}:${r.metricValues[0].value}`);
    console.log(`  months with sessions: ${ms.length} → ${ms.slice(0, 6).join(' ')}${ms.length > 6 ? ' …' : ''}`);
    const ev = await run({ dateRanges: [{ startDate: '2026-04-01', endDate: 'today' }], dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }, { name: 'keyEvents' }], limit: 25 });
    const rows = (ev.rows || []).map((r) => `${r.dimensionValues[0].value}=${r.metricValues[0].value}(key:${r.metricValues[1].value})`);
    console.log(`  events (90d): ${rows.join(' · ')}`);
    const totalKey = (ev.rows || []).reduce((a, r) => a + Number(r.metricValues[1].value), 0);
    console.log(`  TOTAL key events (conversions) 90d: ${totalKey}${totalKey === 0 ? '  ← none configured/firing' : ''}`);
  } catch (e) { console.log(`  GA4 error: ${e.message}`); }
}
