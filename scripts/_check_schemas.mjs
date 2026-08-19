/** READ-ONLY. Where does ARGUS product data actually live? */
import { prodPool } from './_prodsql.mjs';
const pool = await prodPool('iadm_services');
const q = async (s) => (await pool.request().query(s)).recordset;

console.log('tables currently IN the argus schema:');
const inArgus = await q(`SELECT t.name, rows=SUM(p.rows)
  FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
  JOIN sys.partitions p ON p.object_id=t.object_id AND p.index_id IN (0,1)
  WHERE s.name='argus' GROUP BY t.name ORDER BY t.name`);
console.log(inArgus.map(r => `  argus.${r.name} (${r.rows} rows)`).join('\n') || '  (none)');

console.log('\nARGUS product tables living OUTSIDE the argus schema:');
const outside = await q(`SELECT tbl=s.name+'.'+t.name, rows=SUM(p.rows)
  FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
  JOIN sys.partitions p ON p.object_id=t.object_id AND p.index_id IN (0,1)
  WHERE s.name <> 'argus' AND (t.name LIKE '%argus%' OR t.name = 'ai_call_audit')
  GROUP BY s.name, t.name ORDER BY tbl`);
console.log(outside.map(r => `  ${r.tbl} (${r.rows} rows)`).join('\n') || '  (none)');
await pool.close(); process.exit(0);
