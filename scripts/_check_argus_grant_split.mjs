/** READ-ONLY. The Stripe pack-purchase webhook writes lumen.argus_credit_grant;
 *  the metering balance check (oliver-api lib/argus/creditLedger.js) reads
 *  oliver.argus_credit_grant. If both exist with different contents, a client
 *  can buy credits, see them in the header badge, and still be refused. */
import { prodPool } from './_prodsql.mjs';
const pool = await prodPool('iadm_services');
const q = async (s) => (await pool.request().query(s)).recordset;
for (const [schema, note] of [['lumen', 'written by the Stripe pack webhook + read by the header badge'],
                              ['oliver', 'read by the metering balance check']]) {
  const ex = (await q(`SELECT n=COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='${schema}' AND TABLE_NAME='argus_credit_grant'`))[0].n;
  if (!ex) { console.log(`${schema}.argus_credit_grant : (does not exist)   -- ${note}`); continue; }
  const rows = (await q(`SELECT n=COUNT(*), credits=ISNULL(SUM(credits),0) FROM ${schema}.argus_credit_grant`))[0];
  console.log(`${schema}.argus_credit_grant : ${rows.n} grants, ${rows.credits} credits   -- ${note}`);
}
await pool.close(); process.exit(0);
