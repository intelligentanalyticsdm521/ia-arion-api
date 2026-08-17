/**
 * S-6 STEP — ARGUS schema grants for the credit-metering consolidation.
 * RUN AT DEPLOY (Phase 5, Brandon present), immediately AFTER pre-applying
 * LUMEN migrations 131+132 to prod and BEFORE pushing code.
 *
 * Why: verified 2026-08-17 (read-only) — only app-arion-api-prod holds any
 * permission on SCHEMA::argus (SELECT+INSERT, no UPDATE). The repointed code
 * in oliver-api / LUMEN-API / arion-func writes argus.* on every metered
 * call, badge lookup, webhook grant, and auto-topoff pass; without these
 * grants all of it 500s. Same failure class as the STELLA read-only grant.
 *
 * Idempotent: GRANT is additive; re-runs are no-ops. Guarded per principal.
 * Usage: node scripts/_apply_argus_grants_prod.mjs
 */
import { prodPool } from "./_prodsql.mjs";

const GRANTS = [
  // [principal, permissions] — EXECUTE covers argus.sp_balance (arion + oliver
  // read balance through it / through creditLedger; EXECUTE on the schema is
  // harmless for the others and future-proofs new procs).
  ["app-oliver-api-prod",  "SELECT, INSERT, UPDATE, EXECUTE"],
  ["app-lumen-api-prod",   "SELECT, INSERT, UPDATE, EXECUTE"],
  ["app-arion-api-prod",   "SELECT, INSERT, UPDATE, EXECUTE"],
  ["func-iadm-arion-prod", "SELECT, INSERT, UPDATE, EXECUTE"],
];

const pool = await prodPool("iadm_services");
for (const [principal, perms] of GRANTS) {
  const exists = (await pool.request().query(
    `SELECT 1 AS x FROM sys.database_principals WHERE name = N'${principal}'`
  )).recordset.length;
  if (!exists) {
    console.log(`SKIP  ${principal} — principal not found`);
    continue;
  }
  await pool.request().query(`GRANT ${perms} ON SCHEMA::argus TO [${principal}]`);
  console.log(`GRANT ${perms.padEnd(32)} → ${principal}`);
}

console.log("\nverify:");
const v = await pool.request().query(`
  SELECT pr.name, pe.permission_name, pe.state_desc
    FROM sys.database_permissions pe
    JOIN sys.database_principals pr ON pr.principal_id = pe.grantee_principal_id
    JOIN sys.schemas s ON s.schema_id = pe.major_id AND pe.class = 3
   WHERE s.name = 'argus'
   ORDER BY pr.name, pe.permission_name`);
console.table(v.recordset);
process.exit(0);
