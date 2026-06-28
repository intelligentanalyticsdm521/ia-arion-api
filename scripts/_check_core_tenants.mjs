import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';
const cred = new DefaultAzureCredential();
const tok = await cred.getToken('https://database.windows.net/.default');
const cfg = (db) => ({ server: 'sql-iadm-prod-cus.database.windows.net', database: db, options: { encrypt: true }, authentication: { type: 'azure-active-directory-access-token', options: { token: tok.token } } });

const sp = await sql.connect(cfg('iadm_services'));
// Is the tenant in iadm_services.core.tenants?
const a = await sp.request().query(`SELECT TOP 5 * FROM core.tenants WHERE tenant_id = '12839687-67FA-4144-A152-1219D1A64901'`);
console.log('iadm_services.core.tenants Rolling In It:', a.recordset);
const b = await sp.request().query(`SELECT TOP 5 tenant_id, business_name FROM core.tenants`);
console.log('iadm_services.core.tenants sample:'); for (const r of b.recordset) console.log('  ', r);
const c = await sp.request().query(`SELECT COUNT(*) c FROM core.tenants`);
console.log('iadm_services.core.tenants count:', c.recordset[0].c);
await sp.close();

const pp = await sql.connect(cfg('iadm_platform'));
const d = await pp.request().query(`SELECT TOP 5 tenant_id, business_name FROM core.tenants WHERE tenant_id = '12839687-67FA-4144-A152-1219D1A64901'`);
console.log('iadm_platform.core.tenants Rolling In It:', d.recordset);
await pp.close();
