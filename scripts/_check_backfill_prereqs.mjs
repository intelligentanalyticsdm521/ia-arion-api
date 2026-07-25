#!/usr/bin/env node
/** READ-ONLY: prod prerequisites for the insights backfill. */
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';
const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net', database: 'iadm_services',
  options: { encrypt: true },
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();
const t = await pool.request().query(`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='metric_monthly'`);
console.log('metric_monthly exists in prod:', t.recordset.length > 0);
const ix = await pool.request().query(`
  SELECT i.name, i.is_unique FROM sys.indexes i
  JOIN sys.tables tb ON tb.object_id=i.object_id
  JOIN sys.schemas s ON s.schema_id=tb.schema_id
  WHERE s.name='arion' AND tb.name='se_ranking_position_history' AND i.name IS NOT NULL`);
console.log('indexes on se_ranking_position_history:', JSON.stringify(ix.recordset));
const engines = await pool.request().query(`
  SELECT site_id, site_engine_id, COUNT(*) n FROM arion.se_ranking_position_history
  GROUP BY site_id, site_engine_id`);
console.log('engine ids already captured:', JSON.stringify(engines.recordset));
await pool.close();
