#!/usr/bin/env node
/** READ-ONLY: platform roles in dev — who is founder-team? */
import 'dotenv/config';
import sql from 'mssql';
const [devHost, devPort] = (process.env.SQL_SERVER || 'localhost').split(',');
const dev = await new sql.ConnectionPool({
  server: devHost, port: Number(devPort || 1433), database: 'iadm_platform',
  user: process.env.SQL_USER, password: process.env.SQL_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true },
}).connect();
const cols = (await dev.request().query(`
  SELECT c.name FROM sys.columns c WHERE c.object_id = OBJECT_ID('core.user_platform_roles') ORDER BY column_id`)).recordset.map(r => r.name);
console.log('user_platform_roles cols:', cols.join(','));
const rows = (await dev.request().query(`
  SELECT r.*, u.email, u.full_name FROM core.user_platform_roles r
  JOIN core.users u ON u.user_id = r.user_id`)).recordset;
for (const r of rows) console.log(JSON.stringify(r));
await dev.close();
