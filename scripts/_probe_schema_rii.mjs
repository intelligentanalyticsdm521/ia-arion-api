import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';
const cred = new DefaultAzureCredential();
const tok = await cred.getToken('https://database.windows.net/.default');
const cfg = (db) => ({ server: 'sql-iadm-prod-cus.database.windows.net', database: db, options: { encrypt: true }, authentication: { type: 'azure-active-directory-access-token', options: { token: tok.token } } });
const sp = await sql.connect(cfg('iadm_services'));

// 1) arion.site columns
const a = await sp.request().query(`
  SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'arion' AND TABLE_NAME = 'site'
    AND (COLUMN_NAME LIKE 'se_ranking%' OR COLUMN_NAME LIKE 'domain%'
         OR COLUMN_NAME LIKE 'primary%' OR COLUMN_NAME IN ('site_id', 'tenant_id', 'arion_tier', 'seo_addon_tier', 'questionnaire_json'))
  ORDER BY ORDINAL_POSITION`);
console.log('arion.site columns:');
for (const r of a.recordset) console.log('  ', r.COLUMN_NAME, r.DATA_TYPE, r.CHARACTER_MAXIMUM_LENGTH);

// 2) Rolling In It site row
const r = await sp.request().query(`
  SELECT site_id, tenant_id, domain, arion_tier, seo_addon_tier,
         se_ranking_project_id, se_ranking_audit_id
  FROM arion.site WHERE site_id = '4E3B2AE2-4133-4813-84AA-4196661ED6F9'`);
console.log('\nRolling In It site row:', JSON.stringify(r.recordset[0], null, 2));

// 3) integrations schema
const t = await sp.request().query(`
  SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = 'integrations' AND TABLE_NAME = 'tenant_integration_configs'
  ORDER BY ORDINAL_POSITION`);
console.log('\nintegrations.tenant_integration_configs columns:');
for (const c of t.recordset) console.log('  ', c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH, c.IS_NULLABLE);

const p = await sp.request().query(`SELECT * FROM integrations.providers`);
console.log('\nproviders:'); for (const r of p.recordset) console.log('  ', JSON.stringify(r));

const acc = await sp.request().query(`SELECT TOP 50 * FROM integrations.integration_accounts`);
console.log('\nintegration_accounts:'); for (const r of acc.recordset) console.log('  ', JSON.stringify(r));

const cfgs = await sp.request().query(`SELECT * FROM integrations.tenant_integration_configs WHERE tenant_id = '12839687-67FA-4144-A152-1219D1A64901'`);
console.log('\nCONFIGS for Rolling In It tenant:');
for (const c of cfgs.recordset) console.log('  ', JSON.stringify(c, null, 2));

await sp.close();
