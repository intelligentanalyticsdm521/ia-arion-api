#!/usr/bin/env node
/**
 * _apply_migration.mjs — apply one migration file to dev and prod.
 *
 * The deploy pipeline runs migrations AFTER the code deploy, so an additive
 * migration the new code depends on has to be applied ahead of the push or the
 * first requests hit columns that do not exist yet.
 *
 * Splits on GO, runs each batch, then prints the resulting columns so the
 * result is verified rather than assumed.
 *
 * Usage: node scripts/_apply_migration.mjs db/migrations/050_x.sql [--prod-only]
 */
import fs from 'node:fs';
import 'dotenv/config';
import sql from 'mssql';
import { prodPool } from './_prodsql.mjs';

const FILE = process.argv[2];
if (!FILE || !fs.existsSync(FILE)) {
  console.error('usage: node scripts/_apply_migration.mjs <path-to-.sql> [--prod-only]');
  process.exit(1);
}
const batches = fs.readFileSync(FILE, 'utf8')
  .split(/^\s*GO\s*$/mi).map((b) => b.trim()).filter(Boolean);

// Report what the file actually created, not "no errors".
const TABLES = [...new Set(
  (fs.readFileSync(FILE, 'utf8').match(/OBJECT_ID\('([\w.]+)'/g) || [])
    .map((m) => m.replace(/OBJECT_ID\('/, '').replace(/'/, ''))
)];

async function run(label, pool) {
  for (const b of batches) await pool.request().batch(b);
  for (const t of TABLES) {
    const r = await pool.request().query(
      `SELECT n = (SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('${t}'))`);
    console.log(`  ${label}  ${t.padEnd(28)} ${r.recordset[0].n} columns`);
  }
  await pool.close();
}

console.log(`applying ${FILE} (${batches.length} batch(es))`);

if (!process.argv.includes('--prod-only')) {
  await run('dev ', await sql.connect({
    server: (process.env.SQL_SERVER || 'localhost').split(',')[0],
    port: Number((process.env.SQL_SERVER || '').split(',')[1] || 1433),
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    database: process.env.SERVICES_SQL_DATABASE || 'iadm_services',
    options: { encrypt: false, trustServerCertificate: true },
  }));
}
await run('prod', await prodPool('iadm_services'));
console.log('done');
