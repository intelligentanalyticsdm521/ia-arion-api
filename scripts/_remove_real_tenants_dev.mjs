#!/usr/bin/env node
/**
 * DEV CLEANUP (Brandon 2026-07-26): remove ALL real-client data that
 * _provision_real_tenants_dev.mjs copied into the LOCAL dev DBs. Real client
 * data lives in prod only; dev is the fixture world. Scores on prod data
 * come from the read-only scripts (_prod_client_scores.mts /
 * _verify_prod_reader.mjs), never from a local copy.
 *
 * Keeps arion.ia_insights_benchmark — researched INDUSTRY reference data
 * (no client identifiers); dev needs it for the benchmark ladder.
 */
import 'dotenv/config';
import sql from 'mssql';

const TENANTS = [
  '8C9527B9-8999-4B31-A306-F3D4CCC39FBD', // IA
  '45E93346-DBA9-48D5-802B-A4E09A1B03A9', // Briarwood
  '777C1093-F725-424B-8293-E6881190C40C', // MWAG
  '12839687-67FA-4144-A152-1219D1A64901', // RII
];
const SITES = [
  '46F87A02-49E0-475C-8D4A-C88D536A0E7E',
  '64C43F2F-B4FE-40C2-B023-0F06F7D275FA',
  'CFE34569-780C-4548-8F06-CFC27EBC69B7',
  '4E3B2AE2-4133-4813-84AA-4196661ED6F9',
];
const T = TENANTS.map((x) => `'${x}'`).join(',');
const TL = TENANTS.map((x) => `'${x.toLowerCase()}'`).join(',');
const S = SITES.map((x) => `'${x}'`).join(',');

const [h, p] = (process.env.SQL_SERVER || 'localhost').split(',');
const cfg = (database) => ({
  server: h, port: Number(p || 1433), database,
  user: process.env.SQL_USER, password: process.env.SQL_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true },
});
const svc = await new sql.ConnectionPool(cfg(process.env.SERVICES_SQL_DATABASE || 'iadm_services')).connect();
const plat = await new sql.ConnectionPool(cfg('iadm_platform')).connect();

const run = async (pool, label, q) => {
  try {
    const r = await pool.request().query(q);
    console.log(`  ${label}: ${r.rowsAffected.reduce((a, b) => a + b, 0)} rows deleted`);
  } catch (e) { console.log(`  ${label}: SKIPPED (${e.message.split('\n')[0]})`); }
};

console.log('services DB:');
await run(svc, 'arion.metric_monthly', `DELETE FROM arion.metric_monthly WHERE site_id IN (${S})`);
await run(svc, 'arion.site', `DELETE FROM arion.site WHERE site_id IN (${S})`);
await run(svc, 'lumen.tenant_settings', `DELETE FROM lumen.tenant_settings WHERE LOWER(tenant_id) IN (${TL})`);

console.log('platform DB:');
await run(plat, 'core.engagement_alert', `DELETE FROM core.engagement_alert WHERE tenant_id IN (${T})`);
await run(plat, 'core.tenant_actas_log', `DELETE FROM core.tenant_actas_log WHERE tenant_id IN (${T})`);
await run(plat, 'core.consultant_grant', `DELETE FROM core.consultant_grant WHERE client_tenant_id IN (${T})`);
await run(plat, 'core.tenant_users', `DELETE FROM core.tenant_users WHERE tenant_id IN (${T})`);
await run(plat, 'core.tenant_services', `DELETE FROM core.tenant_services WHERE tenant_id IN (${T})`);
await run(plat, 'core.tenants', `DELETE FROM core.tenants WHERE tenant_id IN (${T})`);

// Verify NOTHING real-client remains.
console.log('\nverify:');
for (const [pool, q, label] of [
  [svc, `SELECT COUNT(*) n FROM arion.metric_monthly WHERE site_id IN (${S})`, 'metric rows'],
  [svc, `SELECT COUNT(*) n FROM arion.site WHERE site_id IN (${S})`, 'site rows'],
  [plat, `SELECT COUNT(*) n FROM core.tenants WHERE tenant_id IN (${T})`, 'tenant rows'],
  [plat, `SELECT COUNT(*) n FROM core.tenant_users WHERE tenant_id IN (${T})`, 'membership rows'],
]) {
  const r = await pool.request().query(q);
  console.log(`  ${label} remaining: ${r.recordset[0].n}`);
}
await svc.close(); await plat.close();
console.log('\nDONE — dev is fixture-only again.');
