/**
 * READ-ONLY. Answers the "0 rows in lumen.ai_call_audit" ticket definitively:
 * is the recorder broken, or has ARGUS credit spend simply never been switched
 * on in production? The wrapper refuses every metered call before it runs
 * unless lumen.argus_platform_config has spend_enabled = 'true' — and that
 * check is fail-closed and swallows its error, so a missing TABLE, a missing
 * ROW and a deliberate "off" all look identical from outside.
 */
import { prodPool } from './_prodsql.mjs';

const pool = await prodPool('iadm_services');
const q = async (s) => (await pool.request().query(s)).recordset;

const cfgTable = (await q(`SELECT n=COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA='lumen' AND TABLE_NAME='argus_platform_config'`))[0].n;
console.log('lumen.argus_platform_config exists :', cfgTable ? 'YES' : 'NO  <-- gate can never open');
if (cfgTable) {
  const rows = await q(`SELECT [key],[value] FROM lumen.argus_platform_config`);
  console.log('config rows                       :', JSON.stringify(rows));
  const se = rows.find((r) => r.key === 'spend_enabled');
  console.log("spend_enabled === 'true'          :",
    se && String(se.value).toLowerCase() === 'true' ? 'YES' : `NO (value=${se ? JSON.stringify(se.value) : 'ROW MISSING'})`);
}

const auditTable = (await q(`SELECT n=COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA='lumen' AND TABLE_NAME='ai_call_audit'`))[0].n;
console.log('lumen.ai_call_audit exists        :', auditTable ? 'YES' : 'NO');
if (auditTable) {
  console.log('audit rows                        :', (await q(`SELECT n=COUNT(*) FROM lumen.ai_call_audit`))[0].n);
  const byModel = await q(`SELECT TOP 10 model, provider, n=COUNT(*) FROM lumen.ai_call_audit GROUP BY model, provider ORDER BY COUNT(*) DESC`);
  if (byModel.length) console.log('by model                          :', JSON.stringify(byModel));
}

// Credits are being consumed somewhere even with no audit trail — that gap is
// the actual margin blind spot the ticket describes.
try {
  const use = await q(`SELECT n=COUNT(*) FROM oliver.argus_credit_use`);
  console.log('oliver.argus_credit_use rows      :', JSON.stringify(use[0]));
  const cols = await q(`SELECT COLUMN_NAME c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='oliver' AND TABLE_NAME='argus_credit_use'`);
  console.log('  its columns                     :', cols.map(r=>r.c).join(', '));
} catch (e) { console.log('oliver.argus_credit_use           : n/a (' + e.message.slice(0, 60) + ')'); }

await pool.close();
process.exit(0);
