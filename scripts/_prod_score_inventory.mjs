#!/usr/bin/env node
/**
 * READ-ONLY inventory for the prod client scoring run (Brandon 2026-07-25):
 * which real monthly series exist per tenant, so the scoring script only
 * queries columns that actually exist. NO writes of any kind.
 */
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';

const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net',
  database: 'iadm_services',
  options: { encrypt: true },
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();

const q = async (label, query) => {
  try {
    const r = await pool.request().query(query);
    console.log(`\n### ${label} (${r.recordset.length} rows)`);
    console.table(r.recordset.slice(0, 40));
    return r.recordset;
  } catch (e) {
    console.log(`\n### ${label}\n[ERR] ${e.message}`);
    return [];
  }
};

try {
  // 1. Active real tenants
  const tenants = await q('active tenants', `
    SELECT t.tenant_id, t.name, t.created_at, s.site_id, s.domain
    FROM core.tenants t
    LEFT JOIN arion.site s ON s.tenant_id = t.tenant_id
    WHERE t.is_test = 0 AND t.status = 'ACTIVE'
    ORDER BY t.created_at`);

  // 2. Column inventories for the candidate source tables
  for (const tbl of [
    ['lumen', 'contact'], ['lumen', 'campaign'], ['lumen', 'campaign_recipient'],
    ['oliver', 'invoice'], ['oliver', 'job'], ['oliver', 'quote'],
    ['arion', 'gsc_data'], ['arion', 'site_pagespeed_snapshot'], ['arion', 'gbp_profile'],
    ['arion', 'gbp_review'], ['arion', 'site_page_view_daily'],
  ]) {
    await q(`columns ${tbl[0]}.${tbl[1]}`, `
      SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = '${tbl[0]}' AND TABLE_NAME = '${tbl[1]}' ORDER BY ORDINAL_POSITION`);
  }

  // 3. Row counts + date ranges per tenant for each source
  const ids = tenants.map((t) => `'${t.tenant_id}'`).join(',');
  if (ids) {
    await q('lumen.contact volume', `
      SELECT tenant_id, COUNT(*) n, MIN(created_at) first_row, MAX(created_at) last_row
      FROM lumen.contact WHERE tenant_id IN (${ids}) GROUP BY tenant_id`);
    await q('lumen.campaign volume', `
      SELECT tenant_id, COUNT(*) n, MIN(created_at) first_row, MAX(created_at) last_row
      FROM lumen.campaign WHERE tenant_id IN (${ids}) GROUP BY tenant_id`);
    await q('oliver.invoice volume', `
      SELECT tenant_id, COUNT(*) n, MIN(created_at) first_row, MAX(created_at) last_row
      FROM oliver.invoice WHERE tenant_id IN (${ids}) GROUP BY tenant_id`);
    await q('oliver.job volume', `
      SELECT tenant_id, COUNT(*) n, MIN(created_at) first_row, MAX(created_at) last_row
      FROM oliver.job WHERE tenant_id IN (${ids}) GROUP BY tenant_id`);
    await q('oliver.quote volume', `
      SELECT tenant_id, COUNT(*) n, MIN(created_at) first_row, MAX(created_at) last_row
      FROM oliver.quote WHERE tenant_id IN (${ids}) GROUP BY tenant_id`);
    await q('arion.gsc_data volume by site', `
      SELECT g.site_id, COUNT(*) n, MIN(g.[date]) first_row, MAX(g.[date]) last_row
      FROM arion.gsc_data g GROUP BY g.site_id`);
    await q('arion.site_pagespeed_snapshot volume', `
      SELECT site_id, COUNT(*) n, MIN(created_at) first_row, MAX(created_at) last_row
      FROM arion.site_pagespeed_snapshot GROUP BY site_id`);
    await q('arion.gbp_review volume', `
      SELECT tenant_id, COUNT(*) n FROM arion.gbp_review GROUP BY tenant_id`);
    await q('arion.site_page_view_daily volume', `
      SELECT site_id, COUNT(*) n, MIN([date]) first_row, MAX([date]) last_row
      FROM arion.site_page_view_daily GROUP BY site_id`);
  }
} finally {
  await pool.close();
}
