// Inspect arion.signup_session columns + recent rows
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

async function main() {
  const credential = new DefaultAzureCredential();
  const tokenRes = await credential.getToken('https://database.windows.net/.default');
  const pool = await sql.connect({
    server: 'sql-iadm-prod-cus.database.windows.net',
    database: 'iadm_services',
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-access-token', options: { token: tokenRes.token } },
  });
  const cols = await pool.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='signup_session'
    ORDER BY ORDINAL_POSITION
  `);
  console.log('arion.signup_session columns:');
  for (const c of cols.recordset) console.log('  ', c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE);

  const rows = await pool.request().query(`
    SELECT TOP 10 *
    FROM arion.signup_session
    ORDER BY created_at DESC
  `);
  console.log('\nRecent rows (' + rows.recordset.length + '):');
  for (const r of rows.recordset) {
    console.log('  pk=' + r.session_pk + ' stripe=' + (r.stripe_session_id || '-') + ' tenant=' + r.tenant_id + ' site=' + r.site_id + ' email=' + r.email);
    console.log('     submitted_at=' + (r.submitted_at?.toISOString?.() || r.submitted_at || '-'));
  }

  // arion.site columns
  const cols2 = await pool.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA='arion' AND TABLE_NAME='site'
    ORDER BY ORDINAL_POSITION
  `);
  console.log('\narion.site columns:');
  for (const c of cols2.recordset) console.log('  ', c.COLUMN_NAME, c.DATA_TYPE, c.IS_NULLABLE);

  await pool.close();
}
main().catch(e => { console.error(e); process.exit(1); });
