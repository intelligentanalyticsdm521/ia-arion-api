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
  const CONTACT_ID = 146; // Nathan Dannen, rollinginitllc@gmail.com

  // The 3 welcome emails sent to Rolling In It:
  //   msg 83718458 — already visible as campaign 10 (event id 90)
  //   msg 9c809006 — already visible as campaign 11 (event id 91)
  //   msg 0e9772d9 — ORPHAN (event id 92, campaign_id=NULL)
  // Only msg 0e9772d9 needs a backfilled campaign row.
  const ORPHAN_MSG = '0e9772d9-ac9f-410e-beb4-3ebcd4d555f4';
  const SENT_AT_ORPHAN = '2026-06-25T00:39:03.325Z'; // matches lumen.email_event id=92

  console.log('=== STEP 1 — Insert lumen.campaign row for orphan welcome email ===');
  const camp = await pool.request()
    .input('tenantId', sql.NVarChar, TENANT)
    .input('name', sql.NVarChar, 'Welcome — Rolling In It LLC')
    .input('subject', sql.NVarChar, 'Welcome to Intelligent Analytics, Nathan')
    .input('fromName', sql.NVarChar, 'Intelligent Analytics')
    .input('fromEmail', sql.NVarChar, 'DoNotReply@ia-dm.com')
    .input('sentAt', sql.DateTime2, new Date(SENT_AT_ORPHAN))
    .query(`
      INSERT INTO lumen.campaign
        (tenant_id, name, type, status, subject, from_name, from_email,
         total_recipients, total_sent, sent_at, created_at, updated_at)
      OUTPUT INSERTED.id
      VALUES
        (@tenantId, @name, 'email', 'sent', @subject, @fromName, @fromEmail,
         1, 1, @sentAt, @sentAt, @sentAt)
    `);
  const newCampaignId = camp.recordset[0].id;
  console.log('  -> Inserted lumen.campaign id =', newCampaignId);

  console.log('\n=== STEP 2 — Insert lumen.campaign_recipient ===');
  const cr = await pool.request()
    .input('campaignId', sql.Int, newCampaignId)
    .input('contactId', sql.Int, CONTACT_ID)
    .input('tenantId', sql.NVarChar, TENANT)
    .input('sentAt', sql.DateTime2, new Date(SENT_AT_ORPHAN))
    .input('msgId', sql.NVarChar, ORPHAN_MSG)
    .query(`
      INSERT INTO lumen.campaign_recipient
        (campaign_id, contact_id, tenant_id, status, sent_at, acs_message_id)
      OUTPUT INSERTED.id
      VALUES (@campaignId, @contactId, @tenantId, 'sent', @sentAt, @msgId)
    `);
  console.log('  -> Inserted lumen.campaign_recipient id =', cr.recordset[0].id);

  console.log('\n=== STEP 3 — Backfill lumen.email_event (id=92): set campaign_id + contact_id + template tag ===');
  const upd = await pool.request()
    .input('campaignId', sql.Int, newCampaignId)
    .input('contactId', sql.Int, CONTACT_ID)
    .input('msgId', sql.NVarChar, ORPHAN_MSG)
    .input('tenantId', sql.NVarChar, TENANT)
    .query(`
      UPDATE lumen.email_event
      SET campaign_id = @campaignId,
          contact_id  = @contactId
      WHERE message_id = @msgId AND tenant_id = @tenantId
    `);
  console.log('  -> Updated lumen.email_event rows:', upd.rowsAffected[0]);

  // ----- VERIFICATION -----
  console.log('\n=== VERIFY 1 — All 3 welcome emails now linked to campaign rows ===');
  const v1 = await pool.request().query(`
    SELECT ev.id AS event_id, ev.message_id, ev.campaign_id, ev.occurred_at,
           c.name, c.subject, c.status, c.from_email, c.sent_at AS campaign_sent_at
    FROM lumen.email_event ev
    LEFT JOIN lumen.campaign c ON c.id = ev.campaign_id
    WHERE ev.message_id IN (
      '9c809006-1a3b-44ef-a46c-e8a8fd0c6432',
      '83718458-56e3-40a8-9f33-ae9e2c715b6d',
      '0e9772d9-ac9f-410e-beb4-3ebcd4d555f4'
    )
    ORDER BY ev.occurred_at
  `);
  console.table(v1.recordset);

  console.log('\n=== VERIFY 2 — Simulate GET /api/v1/campaigns response for tenant ===');
  const v2 = await pool.request()
    .input('tenantId', sql.NVarChar, TENANT)
    .query(`
      SELECT c.id, c.name, c.type, c.status, c.subject, c.from_email,
             c.sent_at, c.created_at,
             (SELECT COUNT(*) FROM lumen.campaign_recipient cr WHERE cr.campaign_id = c.id) AS recipient_count
      FROM lumen.campaign c
      WHERE c.tenant_id = @tenantId
      ORDER BY c.created_at DESC
    `);
  console.table(v2.recordset);

  console.log('\n=== VERIFY 3 — campaign_recipient rows for tenant ===');
  const v3 = await pool.request()
    .input('tenantId', sql.NVarChar, TENANT)
    .query(`
      SELECT cr.id, cr.campaign_id, cr.contact_id, cr.status, cr.sent_at, cr.acs_message_id, c.name
      FROM lumen.campaign_recipient cr
      LEFT JOIN lumen.campaign c ON c.id = cr.campaign_id
      WHERE cr.tenant_id = @tenantId
      ORDER BY cr.sent_at DESC
    `);
  console.table(v3.recordset);

  console.log('\n=== DONE ===');
} finally {
  await pool.close();
}
