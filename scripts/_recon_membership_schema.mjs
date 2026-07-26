#!/usr/bin/env node
/** READ-ONLY recon: column lists for the tables the dev-provision copy will
 *  touch, in BOTH dev and prod, plus Brandon's user rows + prod memberships. */
import 'dotenv/config';
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';

const [devHost, devPort] = (process.env.SQL_SERVER || 'localhost').split(',');
const devPlat = await new sql.ConnectionPool({
  server: devHost, port: Number(devPort || 1433), database: 'iadm_platform',
  user: process.env.SQL_USER, password: process.env.SQL_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true },
}).connect();
const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const auth = { type: 'azure-active-directory-access-token', options: { token: token.token } };
const prodPlat = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net', database: 'iadm_platform',
  options: { encrypt: true }, authentication: auth,
}).connect();

const TABLES = ['core.tenants','core.tenant_services','core.services','core.tenant_users','core.consultant_grant','core.users'];
for (const tbl of TABLES) {
  for (const [envName, pool] of [['dev', devPlat], ['prod', prodPlat]]) {
    const [sch, name] = tbl.split('.');
    const cols = (await pool.request().query(`
      SELECT c.name FROM sys.columns c
      JOIN sys.tables t ON t.object_id = c.object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = '${sch}' AND t.name = '${name}' ORDER BY c.column_id`)).recordset.map(r => r.name);
    console.log(`${envName.padEnd(4)} ${tbl}: ${cols.length ? cols.join(',') : '── MISSING ──'}`);
  }
}

const EMAIL = 'intelligentanalyticsdm@gmail.com';
for (const [envName, pool] of [['dev', devPlat], ['prod', prodPlat]]) {
  const u = (await pool.request().input('e', sql.NVarChar, EMAIL).query(`
    SELECT TOP 5 user_id, email FROM core.users WHERE email = @e OR email LIKE '%brandon%' OR email LIKE '%sheriff%'`)).recordset;
  console.log(`\n${envName} users matching:`, JSON.stringify(u));
  if (u.length) {
    const m = (await pool.request().input('uid', sql.UniqueIdentifier, u[0].user_id).query(`
      SELECT tenant_id, user_id FROM core.tenant_users WHERE user_id = @uid`)).recordset;
    console.log(`${envName} tenant_users for ${u[0].email}:`, JSON.stringify(m));
    try {
      const g = (await pool.request().input('uid2', sql.UniqueIdentifier, u[0].user_id).query(`
        SELECT * FROM core.consultant_grant WHERE consultant_user_id = @uid2`)).recordset;
      console.log(`${envName} consultant_grant rows: ${g.length}`, JSON.stringify(g).slice(0, 500));
    } catch (e) { console.log(`${envName} consultant_grant query failed: ${e.message.split('\n')[0]}`); }
  }
}
await devPlat.close(); await prodPlat.close();
