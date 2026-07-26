#!/usr/bin/env node
/** Exercise getArionMetrics against the LOCAL DEV DB for all 4 real sites —
 *  the exact payloads Brandon's dev walk will render. */
import 'dotenv/config';
import sql from 'mssql';
import { getArionMetrics } from '../lib/arionMetrics.js';

process.env.ARION_DEMO_DATA = 'false';

const [devHost, devPort] = (process.env.SQL_SERVER || 'localhost').split(',');
const pool = await new sql.ConnectionPool({
  server: devHost, port: Number(devPort || 1433),
  database: process.env.SERVICES_SQL_DATABASE || 'iadm_services',
  user: process.env.SQL_USER, password: process.env.SQL_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true },
}).connect();

const sites = (await pool.request().query(`
  SELECT * FROM arion.site WHERE domain IN
  ('briarwoodsmiles.com','intelligentanalyticsdm.com','midwestagservices.com','rollinginitllc.com')
  ORDER BY domain`)).recordset;

for (const site of sites) {
  const out = await getArionMetrics(pool, site, 13);
  const reports = Object.entries(out.detail || {});
  console.log(`\n═══ ${site.domain} — source=${out.source} · ${Object.keys(out.metrics).length} metric keys · ${Object.keys(out.benchmarks || {}).length} benchmark keys · ${reports.length} DETAIL REPORTS ═══`);
  for (const [id, rep] of reports) {
    console.log(`  ${id.padEnd(28)} ${String(rep.items.length).padStart(3)} items · section=${rep.section}`);
  }
}
await pool.close();
