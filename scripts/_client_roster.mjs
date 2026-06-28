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
  // First: re-set Brandon's site to ready
  const reset = await pool.request().query(`
    UPDATE arion.site SET status_phase = 'ready', updated_at = SYSDATETIMEOFFSET()
    WHERE domain = 'intelligentanalyticsdm.com' AND status_phase <> 'ready'
  `);
  console.log(`[reset] Brandon site → ready, rows affected: ${reset.rowsAffected[0]}\n`);

  // Distinct tenants only
  const tenants = await pool.request().query(`
    SELECT
      t.tenant_id, t.name, t.full_name, t.created_at,
      s.domain, s.status_phase AS arion_phase, s.plugin_version,
      at.[plan] AS arion_plan,
      CASE WHEN at.stripe_subscription_id IS NOT NULL THEN 1 ELSE 0 END AS arion_subbed,
      CASE WHEN ots.stripe_account_id IS NOT NULL THEN 1 ELSE 0 END AS oliver_connected
    FROM core.tenants t
    LEFT JOIN arion.site s ON s.tenant_id = t.tenant_id
    LEFT JOIN arion.tenant at ON at.tenant_id = t.tenant_id
    LEFT JOIN oliver.tenant_settings ots ON ots.tenant_id = t.tenant_id
    WHERE t.is_test = 0 AND t.status = 'ACTIVE'
    ORDER BY t.created_at DESC
  `);
  console.log(`=== ${tenants.recordset.length} distinct active tenants ===`);
  console.table(tenants.recordset);

  // CRM accounts (Brandon's clients tracked but maybe not yet separate tenants)
  const crm = await pool.request().query(`
    SELECT la.id, la.name AS crm_account, la.domain AS crm_domain,
           la.tenant_id AS belongs_to_tenant,
           t.name AS belongs_to_tenant_name
    FROM lumen.account la
    LEFT JOIN core.tenants t ON t.tenant_id = la.tenant_id
    WHERE la.is_archived = 0
    ORDER BY la.created_at DESC
  `);
  console.log(`\n=== ${crm.recordset.length} CRM accounts (lumen.account) ===`);
  console.table(crm.recordset);
} finally {
  await pool.close();
}
