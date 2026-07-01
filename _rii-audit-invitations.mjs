// Audit core.tenant_invitations for RII state (post CIAM-user delete)
// Tenant: 12839687-67FA-4144-A152-1219D1A64901
// Email:  rollinginitllc@gmail.com
//
// NOTE: core.tenant_invitations lives in iadm_platform DB (not iadm_services).
// Actual columns are: tenant_invitation_id, tenant_id, email (NOT invitee_email),
// role_key, status, invited_by, invited_at, accepted_at.
// welcome_token / welcome_token_expires_at / consumed_at live on
// oliver.tenant_onboarding_state in iadm_services — included for completeness.

import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

const SERVER = 'sql-iadm-prod-cus.database.windows.net';
const TENANT_ID = '12839687-67FA-4144-A152-1219D1A64901';
const EMAIL = 'rollinginitllc@gmail.com';

async function getToken() {
  const cred = new DefaultAzureCredential();
  const tok = await cred.getToken('https://database.windows.net/.default');
  if (!tok) throw new Error('Failed to acquire AAD token');
  return tok.token;
}

async function connect(database) {
  const token = await getToken();
  return sql.connect({
    server: SERVER,
    database,
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-access-token', options: { token } },
    connectionTimeout: 20000,
    requestTimeout: 20000,
  });
}

async function main() {
  // -------- iadm_platform: core.tenant_invitations --------
  const platform = await connect('iadm_platform');
  let columns, byTenant, byEmail;
  try {
    const colsRes = await platform.request().query(`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'core' AND TABLE_NAME = 'tenant_invitations'
      ORDER BY ORDINAL_POSITION;
    `);
    columns = colsRes.recordset;
    console.log('=== iadm_platform.core.tenant_invitations columns ===');
    for (const c of columns) {
      console.log(`  ${c.COLUMN_NAME} (${c.DATA_TYPE}, nullable=${c.IS_NULLABLE})`);
    }

    const t = await platform.request()
      .input('tid', sql.UniqueIdentifier, TENANT_ID)
      .query(`SELECT * FROM core.tenant_invitations
              WHERE tenant_id = @tid
              ORDER BY invited_at DESC;`);
    byTenant = t.recordset;
    console.log(`\n=== Q1: rows where tenant_id = ${TENANT_ID} (${byTenant.length}) ===`);
    for (const r of byTenant) console.log(JSON.stringify(r, null, 2));

    const e = await platform.request()
      .input('em', sql.NVarChar, EMAIL)
      .query(`SELECT * FROM core.tenant_invitations
              WHERE LOWER(email) = LOWER(@em)
              ORDER BY invited_at DESC;`);
    byEmail = e.recordset;
    console.log(`\n=== Q2: rows where email = ${EMAIL} (${byEmail.length}) ===`);
    for (const r of byEmail) console.log(JSON.stringify(r, null, 2));
  } finally {
    await platform.close();
  }

  // -------- iadm_services: oliver.tenant_onboarding_state (welcome token) --------
  const services = await connect('iadm_services');
  let onboardingState;
  try {
    const os = await services.request()
      .input('tid', sql.UniqueIdentifier, TENANT_ID)
      .query(`
        SELECT tenant_id, onboarded_by_founder, onboarded_by_user_id,
               finished_at, welcome_token, welcome_token_expires_at,
               welcome_sent_at, client_first_login_at, last_saved_at
          FROM oliver.tenant_onboarding_state
         WHERE tenant_id = @tid;
      `);
    onboardingState = os.recordset;
    console.log(`\n=== Q3: oliver.tenant_onboarding_state for tenant (${onboardingState.length}) ===`);
    for (const r of onboardingState) console.log(JSON.stringify(r, null, 2));
  } finally {
    await services.close();
  }

  return { columns, byTenant, byEmail, onboardingState };
}

main()
  .then(r => {
    console.log('\n=== DONE ===');
    console.log(`tenant_query_rows=${r.byTenant.length} email_query_rows=${r.byEmail.length} onboarding_state_rows=${r.onboardingState.length}`);
  })
  .catch(err => {
    console.error('FATAL:', err);
    process.exit(2);
  });
