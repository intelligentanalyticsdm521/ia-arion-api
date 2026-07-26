#!/usr/bin/env node
/**
 * DEV-ONLY provisioning (2026-07-26): make the real-data IA Insights reports
 * walkable in the LOCAL dev portal.
 *
 * PROD is opened READ-ONLY (SELECTs only — no write statement ever runs on
 * the prod pools). All writes go to localhost dev DBs. Idempotent — safe to
 * re-run.
 *
 * What it does:
 *  1. iadm_platform: MERGE the 4 real tenants (Stripe/pending ids nulled),
 *     map tenant_services by service_key, grant every member of the dev
 *     agency tenant (The Software Company) a consultant_grant to each real
 *     tenant — the same view-as model Brandon uses in prod.
 *  2. iadm_services: MERGE arion.site (4 rows, same GUIDs), replace
 *     arion.metric_monthly rows for those sites (~13.4k), replace
 *     arion.ia_insights_benchmark with the prod set (113 rows), copy
 *     lumen.tenant_settings rows for the 4 tenants (benchmark ladder needs
 *     service_category).
 */
import 'dotenv/config';
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';

const TENANTS = {
  '8C9527B9-8999-4B31-A306-F3D4CCC39FBD': 'Intelligent Analytics',
  '45E93346-DBA9-48D5-802B-A4E09A1B03A9': 'Briarwood Smiles',
  '777C1093-F725-424B-8293-E6881190C40C': 'MWAG',
  '12839687-67FA-4144-A152-1219D1A64901': 'RII',
};
const TENANT_IDS = Object.keys(TENANTS);
const SITE_IDS = [
  '46F87A02-49E0-475C-8D4A-C88D536A0E7E', // briarwoodsmiles.com
  '64C43F2F-B4FE-40C2-B023-0F06F7D275FA', // intelligentanalyticsdm.com
  'CFE34569-780C-4548-8F06-CFC27EBC69B7', // midwestagservices.com
  '4E3B2AE2-4133-4813-84AA-4196661ED6F9', // rollinginitllc.com
];
const DEV_AGENCY_TENANT = '0A6E0C00-0000-4000-8000-00000000A6E0'; // The Software Company

const [devHost, devPort] = (process.env.SQL_SERVER || 'localhost').split(',');
const devCfg = (database) => ({
  server: devHost, port: Number(devPort || 1433), database,
  user: process.env.SQL_USER, password: process.env.SQL_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true },
  requestTimeout: 120000,
});
const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const prodCfg = (database) => ({
  server: 'sql-iadm-prod-cus.database.windows.net', database,
  options: { encrypt: true }, requestTimeout: 120000,
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
});

const devPlat = await new sql.ConnectionPool(devCfg('iadm_platform')).connect();
const devSvc  = await new sql.ConnectionPool(devCfg(process.env.SERVICES_SQL_DATABASE || 'iadm_services')).connect();
const prodPlat = await new sql.ConnectionPool(prodCfg('iadm_platform')).connect();
const prodSvc  = await new sql.ConnectionPool(prodCfg('iadm_services')).connect();

const idList = (ids) => ids.map((x) => `'${x}'`).join(',');

/** Columns both sides share, minus identity/computed on the dev side. */
async function copyableColumns(devPool, prodPool, schema, table) {
  const q = (isDev) => `
    SELECT c.name, ic.column_id AS is_identity, cc.column_id AS is_computed
    FROM sys.columns c
    JOIN sys.tables t ON t.object_id = c.object_id
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
    LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
    WHERE s.name = '${schema}' AND t.name = '${table}' ORDER BY c.column_id`;
  const dev = (await devPool.request().query(q(true))).recordset;
  const prod = (await prodPool.request().query(q(false))).recordset.map((r) => r.name);
  return dev.filter((c) => !c.is_identity && !c.is_computed && prod.includes(c.name)).map((c) => c.name);
}

/** Row-by-row upsert keyed on keyCols (small tables). */
async function upsertRows(devPool, schema, table, cols, keyCols, rows, transform) {
  let ins = 0, upd = 0;
  for (const raw of rows) {
    const row = transform ? transform({ ...raw }) : raw;
    const req = devPool.request();
    cols.forEach((c, i) => req.input(`p${i}`, row[c] === undefined ? null : row[c]));
    const where = keyCols.map((k) => `${k} = @p${cols.indexOf(k)}`).join(' AND ');
    const setCols = cols.filter((c) => !keyCols.includes(c));
    const result = await req.query(`
      IF EXISTS (SELECT 1 FROM ${schema}.${table} WHERE ${where})
        BEGIN UPDATE ${schema}.${table} SET ${setCols.map((c) => `${c} = @p${cols.indexOf(c)}`).join(', ')} WHERE ${where}; SELECT 'U' AS op; END
      ELSE
        BEGIN INSERT INTO ${schema}.${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `@p${i}`).join(',')}); SELECT 'I' AS op; END`);
    result.recordset[0].op === 'I' ? ins++ : upd++;
  }
  console.log(`  ${schema}.${table}: ${ins} inserted, ${upd} updated`);
}

/** Bulk copy: SELECT explicit cols from prod, bulk-insert into dev. */
async function bulkCopy(prodPool, devPool, schema, table, cols, whereProd) {
  const rs = (await prodPool.request().query(
    `SELECT ${cols.join(',')} FROM ${schema}.${table}${whereProd ? ` WHERE ${whereProd}` : ''}`)).recordset;
  if (!rs.length) { console.log(`  ${schema}.${table}: nothing to copy`); return 0; }
  const tbl = rs.toTable(`${schema}.${table}`);
  tbl.create = false;
  await devPool.request().bulk(tbl);
  console.log(`  ${schema}.${table}: bulk-inserted ${rs.length} rows`);
  return rs.length;
}

// ─── 1. core.tenants ───
console.log('1) core.tenants');
{
  const cols = await copyableColumns(devPlat, prodPlat, 'core', 'tenants');
  const rows = (await prodPlat.request().query(
    `SELECT ${cols.join(',')} FROM core.tenants WHERE tenant_id IN (${idList(TENANT_IDS)})`)).recordset;
  // IA (agency, may be provider of the others) first so provider FKs resolve.
  rows.sort((a, b) => (a.tenant_id === '8C9527B9-8999-4B31-A306-F3D4CCC39FBD' ? -1 : 1) - (b.tenant_id === '8C9527B9-8999-4B31-A306-F3D4CCC39FBD' ? -1 : 1));
  await upsertRows(devPlat, 'core', 'tenants', cols, ['tenant_id'], rows, (r) => {
    r.saas_stripe_subscription_id = null; r.saas_stripe_customer_id = null;
    r.signup_stripe_session_id = null; r.pending_subscription_schedule_id = null;
    return r;
  });
}

// ─── 2. core.tenant_services (map by service_key) ───
console.log('2) core.tenant_services');
{
  const prodSvcs = (await prodPlat.request().query(`SELECT service_id, service_key FROM core.services`)).recordset;
  const devSvcs = (await devPlat.request().query(`SELECT service_id, service_key FROM core.services`)).recordset;
  const devByKey = new Map(devSvcs.map((s) => [s.service_key, s.service_id]));
  const prodById = new Map(prodSvcs.map((s) => [String(s.service_id).toUpperCase(), s.service_key]));
  const links = (await prodPlat.request().query(
    `SELECT tenant_id, service_id, is_enabled FROM core.tenant_services WHERE tenant_id IN (${idList(TENANT_IDS)})`)).recordset;
  let ins = 0, skip = 0, have = 0;
  for (const l of links) {
    const key = prodById.get(String(l.service_id).toUpperCase());
    const devId = key && devByKey.get(key);
    if (!devId) { skip++; continue; }
    const req = devPlat.request()
      .input('t', l.tenant_id).input('s', devId).input('e', l.is_enabled);
    const r = await req.query(`
      IF NOT EXISTS (SELECT 1 FROM core.tenant_services WHERE tenant_id = @t AND service_id = @s)
        BEGIN INSERT INTO core.tenant_services (tenant_service_id, tenant_id, service_id, is_enabled, created_at)
        VALUES (NEWID(), @t, @s, @e, SYSUTCDATETIME()); SELECT 'I' op; END
      ELSE SELECT 'H' op;`);
    r.recordset[0].op === 'I' ? ins++ : have++;
  }
  console.log(`  linked: ${ins} inserted, ${have} already there, ${skip} skipped (service_key not in dev)`);
}

// ─── 3. consultant grants for every dev agency member ───
console.log('3) core.consultant_grant (view-as for The Software Company members)');
{
  const members = (await devPlat.request().query(
    `SELECT DISTINCT user_id FROM core.tenant_users WHERE tenant_id = '${DEV_AGENCY_TENANT}' AND status = 'active'`)).recordset;
  let ins = 0, have = 0;
  for (const m of members) {
    for (const tid of TENANT_IDS) {
      const r = await devPlat.request().input('u', m.user_id).input('c', tid).query(`
        IF NOT EXISTS (SELECT 1 FROM core.consultant_grant WHERE consultant_user_id = @u AND client_tenant_id = @c AND is_active = 1)
          BEGIN INSERT INTO core.consultant_grant (consultant_grant_id, consultant_user_id, client_tenant_id, role_key, access_level, granted_by_user_id, granted_at, is_active, provider_tenant_id)
          VALUES (NEWID(), @u, @c, 'consultant', 'all', @u, SYSUTCDATETIME(), 1, '${DEV_AGENCY_TENANT}'); SELECT 'I' op; END
        ELSE SELECT 'H' op;`);
      r.recordset[0].op === 'I' ? ins++ : have++;
    }
  }
  console.log(`  grants: ${ins} inserted, ${have} already there (${members.length} agency users × ${TENANT_IDS.length} tenants)`);
}

// ─── 4. arion.site ───
console.log('4) arion.site');
{
  const cols = await copyableColumns(devSvc, prodSvc, 'arion', 'site');
  const rows = (await prodSvc.request().query(
    `SELECT ${cols.join(',')} FROM arion.site WHERE site_id IN (${idList(SITE_IDS)})`)).recordset;
  await upsertRows(devSvc, 'arion', 'site', cols, ['site_id'], rows);
}

// ─── 5. arion.metric_monthly (replace rows for these sites) ───
console.log('5) arion.metric_monthly');
{
  const cols = await copyableColumns(devSvc, prodSvc, 'arion', 'metric_monthly');
  const del = await devSvc.request().query(
    `DELETE FROM arion.metric_monthly WHERE site_id IN (${idList(SITE_IDS)})`);
  console.log(`  cleared ${del.rowsAffected[0]} existing dev rows for these sites`);
  await bulkCopy(prodSvc, devSvc, 'arion', 'metric_monthly', cols, `site_id IN (${idList(SITE_IDS)})`);
}

// ─── 6. arion.ia_insights_benchmark (replace with prod set) ───
console.log('6) arion.ia_insights_benchmark');
{
  const cols = await copyableColumns(devSvc, prodSvc, 'arion', 'ia_insights_benchmark');
  const del = await devSvc.request().query(`DELETE FROM arion.ia_insights_benchmark`);
  console.log(`  cleared ${del.rowsAffected[0]} dev benchmark rows`);
  await bulkCopy(prodSvc, devSvc, 'arion', 'ia_insights_benchmark', cols);
}

// ─── 7. lumen.tenant_settings for the 4 tenants (service_category etc.) ───
console.log('7) lumen.tenant_settings');
{
  const exists = (await devSvc.request().query(`
    SELECT COUNT(*) n FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'lumen' AND t.name = 'tenant_settings'`)).recordset[0].n;
  if (!exists) {
    console.log('  lumen.tenant_settings not in dev services DB — SKIPPED (benchmark ladder will use high-tier defaults)');
  } else {
    const cols = await copyableColumns(devSvc, prodSvc, 'lumen', 'tenant_settings');
    const lcIds = TENANT_IDS.map((t) => `'${t.toLowerCase()}'`).join(',');
    const rows = (await prodSvc.request().query(
      `SELECT ${cols.join(',')} FROM lumen.tenant_settings WHERE LOWER(tenant_id) IN (${lcIds})`)).recordset;
    const keyCol = cols.find((c) => /key|name/i.test(c) && c !== 'tenant_id') || cols[1];
    console.log(`  key column: ${keyCol}; ${rows.length} prod rows`);
    await upsertRows(devSvc, 'lumen', 'tenant_settings', cols, ['tenant_id', keyCol], rows);
  }
}

console.log('\nDONE. Prod was read-only throughout.');
await devPlat.close(); await devSvc.close(); await prodPlat.close(); await prodSvc.close();
