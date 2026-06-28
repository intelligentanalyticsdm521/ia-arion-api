import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';

const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net',
  database: 'iadm_services',
  options: { encrypt: true },
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } }
}).connect();

const TENANT = '12839687-67FA-4144-A152-1219D1A64901';
const MESSAGE_IDS = [
  '9c809006-1a3b-44ef-a46c-e8a8fd0c6432',
  '83718458-56e3-40a8-9f33-ae9e2c715b6d',
  '0e9772d9-ac9f-410e-beb4-3ebcd4d555f4',
];

try {
  // 1. Does spark.email_send exist?
  console.log('=== Does spark.email_send table exist? ===');
  const t1 = await pool.request().query(`
    SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_NAME LIKE 'email_send%' OR (TABLE_SCHEMA='spark' AND TABLE_NAME LIKE '%email%')
    ORDER BY TABLE_SCHEMA, TABLE_NAME
  `);
  console.table(t1.recordset);

  // 2. Check lumen.email_event rows for those message_ids
  console.log('\n=== lumen.email_event rows for given message_ids ===');
  const t2 = await pool.request().query(`
    SELECT id, tenant_id, contact_id, message_id, event_type, campaign_id, template_id, occurred_at
    FROM lumen.email_event
    WHERE message_id IN ('${MESSAGE_IDS.join("','")}')
    ORDER BY occurred_at DESC
  `);
  console.table(t2.recordset);

  // 3. All lumen.email_event rows for Rolling In It tenant
  console.log('\n=== lumen.email_event for Rolling In It tenant (latest 20) ===');
  const t3 = await pool.request().input('tid', sql.NVarChar, TENANT).query(`
    SELECT TOP 20 id, message_id, event_type, campaign_id, template_id, occurred_at
    FROM lumen.email_event
    WHERE tenant_id = @tid
    ORDER BY occurred_at DESC
  `);
  console.table(t3.recordset);

  // 4. lumen.campaign rows for tenant
  console.log('\n=== lumen.campaign rows for Rolling In It tenant ===');
  const t4 = await pool.request().input('tid', sql.NVarChar, TENANT).query(`
    SELECT TOP 20 id, name, type, status, subject, from_email, sent_at, total_recipients, total_sent, created_at
    FROM lumen.campaign
    WHERE tenant_id = @tid
    ORDER BY ISNULL(sent_at, created_at) DESC
  `);
  console.table(t4.recordset);

  // 5. Check lumen.email_event columns
  console.log('\n=== lumen.email_event schema ===');
  const t5 = await pool.request().query(`
    SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA='lumen' AND TABLE_NAME='email_event'
  `);
  console.table(t5.recordset);

  // 6. lumen.campaign_recipient for tenant
  console.log('\n=== lumen.campaign_recipient counts for tenant ===');
  const t6 = await pool.request().input('tid', sql.NVarChar, TENANT).query(`
    SELECT TOP 20 cr.campaign_id, c.name, c.type, cr.contact_id, cr.status, cr.sent_at
    FROM lumen.campaign_recipient cr
    LEFT JOIN lumen.campaign c ON c.id = cr.campaign_id AND c.tenant_id = cr.tenant_id
    WHERE cr.tenant_id = @tid
    ORDER BY cr.sent_at DESC
  `);
  console.table(t6.recordset);
} catch (e) {
  console.error('ERR:', e.message);
} finally {
  await pool.close();
}
