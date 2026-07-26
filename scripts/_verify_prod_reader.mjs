#!/usr/bin/env node
/** READ-ONLY: exercise getArionMetrics' PROD path for Briarwood — the exact
 *  payload the app serves on Aug 6. Prints detail report ids + item counts. */
import 'dotenv/config';
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';
import { getArionMetrics } from '../lib/arionMetrics.js';

process.env.ARION_DEMO_DATA = 'false'; // force the prod path locally

const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net', database: 'iadm_services',
  options: { encrypt: true },
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();
try {
  const site = (await pool.request().query(`
    SELECT * FROM arion.site WHERE site_id = '46F87A02-49E0-475C-8D4A-C88D536A0E7E'`)).recordset[0];
  const out = await getArionMetrics(pool, site, 13);
  console.log(`source: ${out.source} · metrics: ${Object.keys(out.metrics).length} keys · benchmarks: ${Object.keys(out.benchmarks || {}).length}`);
  console.log('\nDETAIL REPORTS (real line items):');
  for (const [id, rep] of Object.entries(out.detail || {})) {
    const sample = rep.items[0];
    const extras = sample?.extra ? ` · sample extra: ${JSON.stringify(sample.extra)}` : '';
    console.log(`  ${id.padEnd(26)} ${String(rep.items.length).padStart(3)} items · section ${rep.section}${extras ? `\n${' '.repeat(4)}${sample.name}${extras}` : ''}`);
  }
} finally { await pool.close(); }
