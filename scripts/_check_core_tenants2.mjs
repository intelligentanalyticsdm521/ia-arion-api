import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';
const cred = new DefaultAzureCredential();
const tok = await cred.getToken('https://database.windows.net/.default');
const cfg = (db) => ({ server: 'sql-iadm-prod-cus.database.windows.net', database: db, options: { encrypt: true }, authentication: { type: 'azure-active-directory-access-token', options: { token: tok.token } } });

const sp = await sql.connect(cfg('iadm_services'));
const cols = await sp.request().query(`
  SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'core' AND TABLE_NAME = 'tenants'
  ORDER BY ORDINAL_POSITION`);
console.log('iadm_services.core.tenants columns:');
for (const r of cols.recordset) console.log('  ', r.COLUMN_NAME, r.DATA_TYPE, r.IS_NULLABLE);

const sample = await sp.request().query(`SELECT TOP 5 * FROM core.tenants`);
console.log('\niadm_services.core.tenants sample:');
for (const r of sample.recordset) console.log('  ', JSON.stringify(r));

await sp.close();
