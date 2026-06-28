import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';
const cred = new DefaultAzureCredential();
const tok = await cred.getToken('https://database.windows.net/.default');
const cfg = (db) => ({ server: 'sql-iadm-prod-cus.database.windows.net', database: db, options: { encrypt: true }, authentication: { type: 'azure-active-directory-access-token', options: { token: tok.token } } });

const sp = await sql.connect(cfg('iadm_services'));
const a = await sp.request().query(`SELECT COUNT(*) c FROM core.tenants`);
console.log('iadm_services.core.tenants count:', a.recordset[0].c);

const b = await sp.request().query(`SELECT TOP 10 tenant_id, name FROM core.tenants`);
console.log('All tenants:'); for (const r of b.recordset) console.log('  ', r.tenant_id, '|', r.name);

const c = await sp.request().query(`SELECT TOP 1 tenant_id, name FROM core.tenants WHERE tenant_id = '12839687-67FA-4144-A152-1219D1A64901'`);
console.log('Rolling In It in iadm_services.core.tenants:', c.recordset);

// Check what FK arion.site has
const fk = await sp.request().query(`
  SELECT fk.name AS fk_name, OBJECT_NAME(fk.parent_object_id) AS parent_table,
         OBJECT_NAME(fk.referenced_object_id) AS ref_table,
         OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS ref_schema
  FROM sys.foreign_keys fk
  WHERE OBJECT_NAME(fk.parent_object_id) = 'site'
    AND OBJECT_SCHEMA_NAME(fk.parent_object_id) = 'arion'`);
console.log('arion.site FKs:'); for (const r of fk.recordset) console.log('  ', r);

await sp.close();
