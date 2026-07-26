#!/usr/bin/env node
/** DEV-ONLY: fixture memberships for the 3 real client tenants so the
 *  dev-auth seam can resolve a member identity. Idempotent. */
import 'dotenv/config';
import sql from 'mssql';
const TENANTS = [
  '45E93346-DBA9-48D5-802B-A4E09A1B03A9',
  '777C1093-F725-424B-8293-E6881190C40C',
  '12839687-67FA-4144-A152-1219D1A64901',
];
const [h, p] = (process.env.SQL_SERVER || 'localhost').split(',');
const pool = await new sql.ConnectionPool({
  server: h, port: Number(p || 1433), database: 'iadm_platform',
  user: process.env.SQL_USER, password: process.env.SQL_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true },
}).connect();
for (const t of TENANTS) {
  const r = await pool.request().query(`
    INSERT INTO core.tenant_users (tenant_user_id, tenant_id, user_id, status, created_at, username)
    SELECT NEWID(), '${t}', u.user_id, 'active', SYSUTCDATETIME(), u.email
    FROM core.users u
    WHERE NOT EXISTS (SELECT 1 FROM core.tenant_users tu WHERE tu.tenant_id = '${t}' AND tu.user_id = u.user_id)`);
  console.log(t, 'memberships +', r.rowsAffected[0]);
}
await pool.close();
