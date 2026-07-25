#!/usr/bin/env node
/** E2E-proves the monthly tick path: runFullInsightsSnapshot against prod
 *  (recent-2-months refresh, MERGE-idempotent — same writes as the backfill). */
import 'dotenv/config';
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';
import { runFullInsightsSnapshot } from '../lib/insightsSnapshot.js';

const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net', database: 'iadm_services',
  options: { encrypt: true }, requestTimeout: 120000,
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();
try {
  const summary = await runFullInsightsSnapshot(pool, (m) => console.log(`  · ${m}`));
  console.log(JSON.stringify(summary, null, 2));
} finally { await pool.close(); }
