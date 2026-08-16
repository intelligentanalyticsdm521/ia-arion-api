import { prodPool } from './_prodsql.mjs';
const pool = await prodPool('iadm_services');
const TABLES = [
  'lumen.contact', 'lumen.campaign', 'lumen.email_event', 'lumen.segment',
  'lumen.automation', 'lumen.contact_activity',
  'oliver.invoice', 'oliver.job', 'oliver.quote', 'oliver.service_offering',
  'oliver.service_subscription', 'oliver.worker',
];
for (const t of TABLES) {
  const r = await pool.request().query(`
    SELECT c.name FROM sys.columns c WHERE c.object_id = OBJECT_ID('${t}') ORDER BY c.column_id`);
  console.log(`${t}: ${r.recordset.map((x) => x.name).join(', ')}`);
  console.log('');
}
await pool.close();
