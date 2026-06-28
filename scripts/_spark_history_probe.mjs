import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';

const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net',
  database: 'iadm_services',
  options: { encrypt: true },
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } }
}).connect();

try {
  const TENANT = '12839687-67FA-4144-A152-1219D1A64901';
  const MSGS = [
    '9c809006-1a3b-44ef-a46c-e8a8fd0c6432',
    '83718458-56e3-40a8-9f33-ae9e2c715b6d',
    '0e9772d9-ac9f-410e-beb4-3ebcd4d555f4'
  ];

  console.log('=== 1. lumen.email_event rows for the 3 message_ids ===');
  const evs = await pool.request().query(`
    SELECT id, tenant_id, contact_id, campaign_id, template_id, message_id, event_type, occurred_at
    FROM lumen.email_event
    WHERE message_id IN ('${MSGS.join("','")}')
    ORDER BY occurred_at
  `);
  console.table(evs.recordset);

  console.log('\n=== 2. lumen.campaign rows for tenant ===');
  const camps = await pool.request().query(`
    SELECT id, name, type, status, subject, from_email, total_recipients, total_sent, sent_at, created_at
    FROM lumen.campaign WHERE tenant_id='${TENANT}'
    ORDER BY created_at DESC
  `);
  console.table(camps.recordset);

  console.log('\n=== 3. lumen.campaign_recipient rows for these campaigns ===');
  const cr = await pool.request().query(`
    SELECT cr.id, cr.campaign_id, cr.contact_id, cr.tenant_id, cr.status, cr.sent_at, cr.acs_message_id, c.name
    FROM lumen.campaign_recipient cr
    LEFT JOIN lumen.campaign c ON c.id = cr.campaign_id
    WHERE cr.tenant_id='${TENANT}'
    ORDER BY cr.sent_at DESC
  `);
  console.table(cr.recordset);

  console.log('\n=== 4. lumen.contact rollinginitllc@gmail.com ===');
  const ct = await pool.request().query(`
    SELECT id, tenant_id, first_name, last_name, email
    FROM lumen.contact
    WHERE tenant_id='${TENANT}' AND email='rollinginitllc@gmail.com'
  `);
  console.table(ct.recordset);

  console.log('\n=== 5. lumen.contact for tenant (any rows) ===');
  const cts = await pool.request().query(`
    SELECT TOP 10 id, tenant_id, first_name, last_name, email
    FROM lumen.contact
    WHERE tenant_id='${TENANT}'
  `);
  console.table(cts.recordset);

} finally {
  await pool.close();
}
