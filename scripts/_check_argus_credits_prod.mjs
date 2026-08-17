/** READ-ONLY. Do prod tenants hold any ARGUS credit balance? Decisive for
 *  whether switching spend_enabled to 'true' would start charging people or
 *  simply refuse every AI call with insufficient_credits. */
import { prodPool } from './_prodsql.mjs';
const pool = await prodPool('iadm_services');
const q = async (s) => (await pool.request().query(s)).recordset;

for (const t of ['argus_credit_grant', 'argus_credit_use', 'argus_credit_ledger']) {
  const exists = (await q(`SELECT n=COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='oliver' AND TABLE_NAME='${t}'`))[0].n;
  if (!exists) { console.log(`oliver.${t}: (no such table)`); continue; }
  const n = (await q(`SELECT n=COUNT(*) FROM oliver.${t}`))[0].n;
  console.log(`oliver.${t}: ${n} rows`);
  if (n && t === 'argus_credit_grant') {
    console.log('  grants:', JSON.stringify(await q(`SELECT TOP 5 tenant_id, credits, expires_at FROM oliver.argus_credit_grant ORDER BY credits DESC`)));
  }
}
// Action pricing = what each metered action would cost a client in credits.
const ap = (await q(`SELECT n=COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='lumen' AND TABLE_NAME='argus_action_pricing'`))[0].n;
console.log('lumen.argus_action_pricing:', ap ? (await q(`SELECT n=COUNT(*) FROM lumen.argus_action_pricing`))[0].n + ' actions priced' : '(no such table)');
await pool.close(); process.exit(0);
