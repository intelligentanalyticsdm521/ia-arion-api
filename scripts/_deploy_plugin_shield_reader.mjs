#!/usr/bin/env node
/**
 * Deploy the updated IA plugin (Shield security reader, v1.3.1) to the 3 live
 * client sites via SFTP — SAFELY: upload to a temp file, `php -l` it on the
 * server, back up the current file, and only swap it in if lint passes. A
 * syntactically broken plugin file would white-screen the live site, so we
 * never overwrite the live file until the new one is verified parseable.
 */
import fs from 'node:fs';
import { runWpCli, runSshCommand, uploadFileViaSftp } from '../lib/hostingerSsh.js';

const LOCAL = 'C:/dev/iadm/intelligent-analytics - WP Plugin/intelligent-analytics.php';
const SITES = [
  { name: 'Rolling In It',       domain: 'rollinginitllc.com'   },
  { name: 'Briarwood Dental',    domain: 'briarwoodsmiles.com'  },
  { name: 'Midwest Ag Services', domain: 'midwestagservices.com' },
];

const buf = fs.readFileSync(LOCAL);
console.log(`local plugin file: ${buf.length} bytes`);
const results = [];

for (const s of SITES) {
  const r = { name: s.name, domain: s.domain, status: 'UNKNOWN', lint: '', notes: [] };
  try {
    console.log(`\n── ${s.name} (${s.domain})`);
    const plugdir = ((await runWpCli(s.domain, `eval "echo WP_PLUGIN_DIR;"`)).stdout || '').trim();
    if (!plugdir || plugdir.indexOf('/') !== 0) throw new Error(`could not resolve WP_PLUGIN_DIR (got: ${plugdir})`);
    const dir = `${plugdir}/intelligent-analytics`;
    const target = `${dir}/intelligent-analytics.php`;
    const tmp = `${dir}/intelligent-analytics.php.new`;
    // 1. upload to temp
    await uploadFileViaSftp(buf, tmp);
    r.notes.push('uploaded temp');
    // 2. lint the temp file on the server
    const lint = await runSshCommand(`php -l '${tmp}' 2>&1`);
    r.lint = ((lint.stdout || '') + (lint.stderr || '')).trim().slice(0, 300);
    if (!/No syntax errors detected/.test(r.lint)) {
      r.status = 'LINT_FAIL — live file untouched';
      await runSshCommand(`rm -f '${tmp}'`).catch(() => {});
      console.log(`  LINT FAIL: ${r.lint}`);
      results.push(r); continue;
    }
    r.notes.push('php -l OK');
    // 3. backup + swap
    await runSshCommand(`cp -f '${target}' '${target}.bak-20260705' && mv -f '${tmp}' '${target}'`);
    r.notes.push('backed up + swapped');
    // 4. verify plugin still active + version
    const active = ((await runWpCli(s.domain, 'plugin is-active intelligent-analytics').then(() => 'active').catch(() => 'INACTIVE')));
    const ver = ((await runWpCli(s.domain, 'plugin get intelligent-analytics --field=version')).stdout || '').trim();
    r.active = active; r.version = ver;
    await runWpCli(s.domain, 'cache flush').catch(() => {});
    r.status = (active === 'active') ? 'PASS' : 'FAIL — plugin inactive after swap';
    console.log(`  ${r.status} — active=${active} version=${ver}`);
  } catch (e) {
    r.status = 'FATAL'; r.notes.push((e.message || String(e)).slice(0, 200));
    console.log(`  FATAL ${e.message}`);
  }
  results.push(r);
}

console.log('\n════════ DEPLOY SUMMARY ════════');
for (const r of results) console.log(`  ${r.name.padEnd(22)} [${r.status.padEnd(28)}] v${r.version || '?'} active=${r.active || '?'}`);
process.exit(results.some(r => !String(r.status).startsWith('PASS')) ? 1 : 0);
