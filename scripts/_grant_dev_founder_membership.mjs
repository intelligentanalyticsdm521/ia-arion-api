#!/usr/bin/env node
/** DEV-ONLY: make every dev user a member of the IA tenant (the default
 *  FOUNDER_TENANT_ID) so the founder switch-tenant widget works in dev,
 *  same as Brandon's prod experience. Idempotent. */
import 'dotenv/config';
import sql from 'mssql';
const IA = '8C9527B9-8999-4B31-A306-F3D4CCC39FBD';
const [devHost, devPort] = (process.env.SQL_SERVER || 'localhost').split(',');
const dev = await new sql.ConnectionPool({
  server: devHost, port: Number(devPort || 1433), database: 'iadm_platform',
  user: process.env.SQL_USER, password: process.env.SQL_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true },
}).connect();
const r = await dev.request().query(`
  INSERT INTO core.tenant_users (tenant_user_id, tenant_id, user_id, status, created_at, username)
  SELECT NEWID(), '${IA}', u.user_id, 'active', SYSUTCDATETIME(), u.email
  FROM core.users u
  WHERE NOT EXISTS (SELECT 1 FROM core.tenant_users tu WHERE tu.tenant_id = '${IA}' AND tu.user_id = u.user_id)`);
console.log(`IA-tenant memberships inserted: ${r.rowsAffected[0]}`);
await dev.close();
