import 'dotenv/config';
import sql from 'mssql';
import { getArionMetrics } from '../lib/arionMetrics.js';
process.env.ARION_DEMO_DATA='false';
const [h,p]=(process.env.SQL_SERVER||'localhost').split(',');
const pool=await new sql.ConnectionPool({server:h,port:Number(p||1433),database:'iadm_services',user:process.env.SQL_USER,password:process.env.SQL_PASSWORD,options:{encrypt:false,trustServerCertificate:true}}).connect();
const sites=(await pool.request().query(`SELECT * FROM arion.site WHERE domain LIKE '%example.com' ORDER BY domain`)).recordset;
for(const s of sites){
  const out=await getArionMetrics(pool,s,13);
  const reports=Object.entries(out.detail||{});
  console.log(`\n${s.domain} — source=${out.source} · ${Object.keys(out.metrics).length} metric keys · ${reports.length} detail reports`);
  console.log('  sessions:', (out.metrics.ga_sessions||[]).slice(-4).join(' → '));
  console.log('  gsc_clicks:', (out.metrics.gsc_clicks||[]).slice(-4).join(' → '));
  for(const [id,r] of reports.slice(0,4)) console.log(`   ${id.padEnd(26)} ${String(r.items.length).padStart(3)} items`);
}
await pool.close();
