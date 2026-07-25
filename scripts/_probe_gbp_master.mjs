#!/usr/bin/env node
/** READ-ONLY: (1) stored gbp_location_name shapes + a Performance API retry
 *  with the locations/... tail; (2) master service-account GSC visibility. */
import 'dotenv/config';
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';
import { getAccessToken } from '../lib/googleBusiness.js';
import { probeGoogleFootprint } from '../lib/iaMasterGoogle.js';

const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net', database: 'iadm_services',
  options: { encrypt: true },
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();
const sites = (await pool.request().query(`
  SELECT domain, gbp_oauth_token_ref, gbp_location_name FROM arion.site WHERE domain IS NOT NULL`)).recordset;
await pool.close();

for (const s of sites) {
  console.log(`\n── ${s.domain} · gbp_location_name = ${s.gbp_location_name || '—'}`);
  if (!s.gbp_location_name || !s.gbp_oauth_token_ref) continue;
  const tok = await getAccessToken(s.gbp_oauth_token_ref);
  if (!tok?.access_token) { console.log('  refresh failed'); continue; }
  const tail = s.gbp_location_name.match(/locations\/[^/]+$/)?.[0] || s.gbp_location_name;
  const params = new URLSearchParams();
  params.append('dailyMetrics', 'CALL_CLICKS');
  params.append('dailyRange.start_date.year', '2026');
  params.append('dailyRange.start_date.month', '6');
  params.append('dailyRange.start_date.day', '1');
  params.append('dailyRange.end_date.year', '2026');
  params.append('dailyRange.end_date.month', '7');
  params.append('dailyRange.end_date.day', '20');
  const r = await fetch(`https://businessprofileperformance.googleapis.com/v1/${tail}:fetchMultiDailyMetricsTimeSeries?${params}`, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  const body = await r.text();
  console.log(`  perf API [${tail}] → ${r.status} ${body.slice(0, 200)}`);
}

// Master account GSC visibility (Briarwood fix path)
try {
  const fp = await probeGoogleFootprint('briarwoodsmiles.com');
  console.log('\nmaster footprint briarwoodsmiles.com:', JSON.stringify(fp).slice(0, 400));
} catch (e) {
  console.log('\nmaster footprint failed:', e.message.slice(0, 200));
}
