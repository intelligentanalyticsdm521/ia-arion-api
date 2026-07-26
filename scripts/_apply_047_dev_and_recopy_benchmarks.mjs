#!/usr/bin/env node
/** DEV-ONLY: apply migration 047 to the local dev services DB, then re-copy
 *  the full prod benchmark set (incl. tier/model rows). Prod read-only. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';

const [devHost, devPort] = (process.env.SQL_SERVER || 'localhost').split(',');
const dev = await new sql.ConnectionPool({
  server: devHost, port: Number(devPort || 1433),
  database: process.env.SERVICES_SQL_DATABASE || 'iadm_services',
  user: process.env.SQL_USER, password: process.env.SQL_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true },
}).connect();
const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const prod = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net', database: 'iadm_services',
  options: { encrypt: true },
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();

const migration = readFileSync(new URL('../db/migrations/047_benchmark_tiers.sql', import.meta.url), 'utf8');
await dev.request().batch(migration);
console.log('047 applied to dev');

const cols = (await prod.request().query(`
  SELECT c.name FROM sys.columns c
  WHERE c.object_id = OBJECT_ID('arion.ia_insights_benchmark')
    AND c.column_id NOT IN (SELECT column_id FROM sys.identity_columns WHERE object_id = c.object_id)
  ORDER BY c.column_id`)).recordset.map((r) => r.name);
console.log('columns:', cols.join(','));

await dev.request().query(`DELETE FROM arion.ia_insights_benchmark`);
const rs = (await prod.request().query(`SELECT ${cols.join(',')} FROM arion.ia_insights_benchmark`)).recordset;
const tbl = rs.toTable('arion.ia_insights_benchmark');
tbl.create = false;
await dev.request().bulk(tbl);
const byTier = {};
for (const r of rs) byTier[r.tier || 'null'] = (byTier[r.tier || 'null'] || 0) + 1;
console.log(`re-copied ${rs.length} benchmark rows:`, JSON.stringify(byTier));
await dev.close(); await prod.close();
