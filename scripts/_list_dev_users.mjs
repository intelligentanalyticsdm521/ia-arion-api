#!/usr/bin/env node
/** READ-ONLY: all users + memberships in the LOCAL dev platform DB. */
import 'dotenv/config';
import sql from 'mssql';
const [devHost, devPort] = (process.env.SQL_SERVER || 'localhost').split(',');
const dev = await new sql.ConnectionPool({
  server: devHost, port: Number(devPort || 1433), database: 'iadm_platform',
  user: process.env.SQL_USER, password: process.env.SQL_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true },
}).connect();
const users = (await dev.request().query(`
  SELECT u.user_id, u.email, u.full_name, u.status,
         (SELECT COUNT(*) FROM core.tenant_users tu WHERE tu.user_id = u.user_id) AS memberships
  FROM core.users u ORDER BY u.created_at`)).recordset;
console.log(`dev core.users — ${users.length} rows:`);
for (const u of users) console.log(`  ${u.user_id}  ${String(u.email).padEnd(45)} ${String(u.full_name || '').padEnd(22)} ${u.status}  memberships=${u.memberships}`);
const tu = (await dev.request().query(`
  SELECT tu.tenant_id, t.name, tu.user_id, tu.status FROM core.tenant_users tu
  LEFT JOIN core.tenants t ON t.tenant_id = tu.tenant_id`)).recordset;
console.log(`\ndev core.tenant_users — ${tu.length} rows:`);
for (const r of tu) console.log(`  tenant=${r.tenant_id} (${r.name})  user=${r.user_id}  ${r.status}`);
const cg = (await dev.request().query(`SELECT * FROM core.consultant_grant`)).recordset;
console.log(`\ndev core.consultant_grant — ${cg.length} rows`);
for (const g of cg) console.log(`  consultant=${g.consultant_user_id} client=${g.client_tenant_id} active=${g.is_active}`);
await dev.close();
