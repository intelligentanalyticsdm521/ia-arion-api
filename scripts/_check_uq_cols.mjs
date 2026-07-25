#!/usr/bin/env node
/** READ-ONLY: columns of UQ_pos_history_daily. */
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';
const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net', database: 'iadm_services',
  options: { encrypt: true },
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();
const r = await pool.request().query(`
  SELECT ic.key_ordinal, c.name
  FROM sys.indexes i
  JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id
  JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id
  WHERE i.name='UQ_pos_history_daily' ORDER BY ic.key_ordinal`);
console.log(JSON.stringify(r.recordset));
await pool.close();
