#!/usr/bin/env node
/**
 * _set_plugin_channel.mjs — move a site back onto a release channel.
 *
 * A site parked on `staging` for a canary run and left there stops following
 * `latest` forever, which is the same divergence the staging process exists to
 * prevent. Putting it back is part of finishing the release, not an afterthought.
 *
 * Usage: node scripts/_set_plugin_channel.mjs <domain> <latest|staging> [--apply]
 */
import sql from 'mssql';
import { prodPool } from './_prodsql.mjs';

const [DOMAIN, CHANNEL] = process.argv.slice(2);
const APPLY = process.argv.includes('--apply');
if (!DOMAIN || !['latest', 'staging'].includes(CHANNEL)) {
  console.error('usage: node scripts/_set_plugin_channel.mjs <domain> <latest|staging> [--apply]');
  process.exit(1);
}

const pool = await prodPool('iadm_services');
const s = (await pool.request().input('d', sql.NVarChar(255), DOMAIN)
  .query(`SELECT domain, plugin_channel, plugin_version FROM arion.site WHERE domain = @d`)).recordset[0];
if (!s) { console.error(`no site row for ${DOMAIN}`); process.exit(1); }

console.log(`${s.domain}: ${s.plugin_channel} -> ${CHANNEL}  (running v${s.plugin_version})`);
if (!APPLY) { console.log('DRY RUN — re-run with --apply.'); await pool.close(); process.exit(0); }

await pool.request()
  .input('d', sql.NVarChar(255), DOMAIN)
  .input('c', sql.NVarChar(32), CHANNEL)
  .query(`UPDATE arion.site SET plugin_channel = @c WHERE domain = @d`);
console.log('done');
await pool.close();
