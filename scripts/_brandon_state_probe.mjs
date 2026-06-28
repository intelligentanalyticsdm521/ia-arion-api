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
  const TENANT = '8C9527B9-8999-4B31-A306-F3D4CCC39FBD';

  // 1. Find any onboarding-completion-style columns across schemas
  console.log('=== 1. Columns that look like onboarding completion ===');
  const cols = await pool.request().query(`
    SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE COLUMN_NAME LIKE '%onboard%' OR COLUMN_NAME LIKE '%finished%' OR COLUMN_NAME LIKE '%completed%' OR COLUMN_NAME LIKE '%activated%'
    ORDER BY TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
  `);
  console.table(cols.recordset);

  // 2. Look at signup_intent / signup_session / tenant_invitations for Brandon
  console.log('\n=== 2. Brandon signup_intent + tenant_invitations ===');
  try {
    const si = await pool.request().query(`SELECT TOP 5 * FROM core.signup_intent WHERE tenant_id='${TENANT}' ORDER BY created_at DESC`);
    console.log('signup_intent:'); console.table(si.recordset);
  } catch (e) { console.log('signup_intent skip:', e.message); }
  try {
    const ti = await pool.request().query(`SELECT TOP 5 * FROM core.tenant_invitations WHERE tenant_id='${TENANT}' ORDER BY created_at DESC`);
    console.log('tenant_invitations:'); console.table(ti.recordset);
  } catch (e) { console.log('tenant_invitations skip:', e.message); }
  try {
    const ss = await pool.request().query(`SELECT TOP 3 session_pk, tenant_id, site_id, submitted_at, questionnaire_submitted_at FROM arion.signup_session WHERE tenant_id='${TENANT}' ORDER BY created_at DESC`);
    console.log('arion.signup_session:'); console.table(ss.recordset);
  } catch (e) { console.log('signup_session skip:', e.message); }

  // 3. Brand voice / brand profile storage
  console.log('\n=== 3. Brand voice / brand profile tables ===');
  const bv = await pool.request().query(`
    SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE COLUMN_NAME LIKE '%brand%' OR COLUMN_NAME LIKE '%voice%' OR COLUMN_NAME LIKE '%tone%'
    ORDER BY TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME
  `);
  console.table(bv.recordset);

  // 4. If lumen.brand_voice_profile exists, show its rows for Brandon
  try {
    const bvp = await pool.request().query(`SELECT TOP 3 * FROM lumen.brand_voice_profile WHERE tenant_id='${TENANT}'`);
    console.log('\nlumen.brand_voice_profile rows for Brandon:'); console.table(bvp.recordset);
  } catch (e) { console.log('\nlumen.brand_voice_profile probe skip:', e.message); }

  // 5. What "Continue setup" banner reads — check command/get-started state
  console.log('\n=== 5. Any "continue setup" / onboarding state for Brandon ===');
  try {
    const lc = await pool.request().query(`SELECT * FROM core.tenant_lifecycle_config WHERE tenant_id='${TENANT}'`);
    console.log('tenant_lifecycle_config:'); console.table(lc.recordset);
  } catch (e) {}
  try {
    const tos = await pool.request().query(`SELECT * FROM oliver.tenant_onboarding_state WHERE tenant_id='${TENANT}'`);
    console.log('oliver.tenant_onboarding_state:'); console.table(tos.recordset);
  } catch (e) {}
  try {
    const ti2 = await pool.request().query(`SELECT tenant_id, email, role, finished_at, activated_at, welcome_token IS NOT NULL AS has_token FROM core.tenant_invitations WHERE tenant_id='${TENANT}'`);
    console.log('tenant_invitations (focused):'); console.table(ti2.recordset);
  } catch (e) {}

} finally { await pool.close(); }
