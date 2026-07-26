#!/usr/bin/env node
/** READ-ONLY: what tenants + memberships exist in the LOCAL dev platform DB,
 *  and do the 4 real prod tenant GUIDs exist there? */
import 'dotenv/config';
import sql from 'mssql';

const [devHost, devPort] = (process.env.SQL_SERVER || 'localhost').split(',');
const local = await new sql.ConnectionPool({
  server: devHost, port: devPort ? Number(devPort) : 1433,
  database: process.env.PLATFORM_SQL_DATABASE || 'iadm_platform',
  user: process.env.SQL_USER, password: process.env.SQL_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true },
}).connect();

const tables = (await local.request().query(`
  SELECT s.name + '.' + t.name AS tbl FROM sys.tables t
  JOIN sys.schemas s ON s.schema_id = t.schema_id
  WHERE t.name LIKE '%tenant%' OR t.name LIKE '%user%' ORDER BY 1`)).recordset.map(r => r.tbl);
console.log('tenant/user tables:', tables.join(', '));

const tenantTbl = tables.find(t => /^core\.tenants?$/.test(t));
if (!tenantTbl) { console.log('NO core.tenant(s) table found'); process.exit(0); }

const cols = (await local.request().query(`
  SELECT c.name FROM sys.columns c
  JOIN sys.tables t ON t.object_id = c.object_id
  JOIN sys.schemas s ON s.schema_id = t.schema_id
  WHERE s.name + '.' + t.name = '${tenantTbl}'`)).recordset.map(r => r.name);
console.log(`${tenantTbl} columns:`, cols.join(', '));

const nameCol = cols.find(c => /name/i.test(c)) || cols[1];
const rows = (await local.request().query(`
  SELECT TOP 30 tenant_id, ${nameCol} AS nm FROM ${tenantTbl} ORDER BY ${nameCol}`)).recordset;
console.log(`\n${tenantTbl} (${rows.length} shown):`);
for (const r of rows) console.log(`  ${r.tenant_id}  ${r.nm}`);

const PROD = {
  '8C9527B9-8999-4B31-A306-F3D4CCC39FBD': 'IA',
  '45E93346-DBA9-48D5-802B-A4E09A1B03A9': 'Briarwood',
  '777C1093-F725-424B-8293-E6881190C40C': 'MWAG',
  '12839687-67FA-4144-A152-1219D1A64901': 'RII',
};
console.log('\nprod tenant GUIDs present in dev?');
for (const [id, label] of Object.entries(PROD)) {
  const hit = (await local.request().query(`
    SELECT COUNT(*) n FROM ${tenantTbl} WHERE tenant_id = '${id}'`)).recordset[0].n;
  console.log(`  ${label.padEnd(10)} ${id}  ${hit ? 'YES' : 'no'}`);
}
await local.close();
