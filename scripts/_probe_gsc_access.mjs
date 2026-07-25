#!/usr/bin/env node
/**
 * READ-ONLY: can each prod site's stored Google refresh token reach GSC?
 * Prints scopes + resolved property + a 30-day summary. Token values are
 * NEVER printed.
 */
import 'dotenv/config';
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';
import { getAccessToken } from '../lib/googleBusiness.js';
import { resolveGscProperty } from '../lib/googleServices.js';

const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net', database: 'iadm_services',
  options: { encrypt: true },
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();

const sites = (await pool.request().query(`
  SELECT site_id, domain, gbp_oauth_token_ref, gsc_oauth_token_ref, gsc_site_url, ga4_property_id
  FROM arion.site WHERE domain IS NOT NULL`)).recordset;
await pool.close();

for (const s of sites) {
  const ref = s.gsc_oauth_token_ref || s.gbp_oauth_token_ref;
  console.log(`\n── ${s.domain} ──`);
  console.log(`  token refs: gsc=${!!s.gsc_oauth_token_ref} gbp=${!!s.gbp_oauth_token_ref} · gsc_site_url=${s.gsc_site_url || '—'} · ga4_property_id=${s.ga4_property_id || '—'}`);
  if (!ref) { console.log('  NO TOKEN — skip'); continue; }
  const tok = await getAccessToken(ref);
  if (!tok?.access_token) { console.log('  refresh FAILED'); continue; }
  console.log(`  refresh OK · scopes: ${tok.scope || '(not reported)'}`);
  try {
    const prop = s.gsc_site_url || await resolveGscProperty(tok.access_token, s.domain);
    console.log(`  GSC property: ${prop}`);
    const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(prop)}/searchAnalytics/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ startDate: '2026-06-24', endDate: '2026-07-24', dimensions: [], rowLimit: 1 }),
    });
    const body = await r.json();
    if (!r.ok) { console.log(`  GSC query ${r.status}: ${JSON.stringify(body).slice(0, 180)}`); continue; }
    const row = body.rows?.[0];
    console.log(`  GSC 30d: clicks=${row?.clicks ?? 0} impressions=${row?.impressions ?? 0} avgPos=${row?.position?.toFixed?.(1) ?? '—'}`);
  } catch (e) { console.log(`  GSC error: ${e.message.slice(0, 180)}`); }
}
