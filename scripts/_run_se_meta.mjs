#!/usr/bin/env node
/** PROD DATA: SE keyword volume/CPC meta → metric_monthly (all sites). */
import 'dotenv/config';
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';
import { pullSeKeywordMeta, mergeMetricRows } from '../lib/insightsSnapshot.js';

const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net', database: 'iadm_services',
  options: { encrypt: true }, requestTimeout: 60000,
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();
try {
  const sites = (await pool.request().query(`
    SELECT site_id, tenant_id, domain, se_ranking_project_id FROM arion.site WHERE se_ranking_project_id IS NOT NULL`)).recordset;
  for (const site of sites) {
    const r = await pullSeKeywordMeta(site, { log: (m) => console.log(`  · ${m}`) });
    const n = r.rows.length ? await mergeMetricRows(pool, site, r.rows) : 0;
    console.log(`${site.domain}: ${r.rows.length} meta rows pulled, ${n} upserted${r.reason ? ` — ${r.reason}` : ''}`);
  }
} finally { await pool.close(); }
