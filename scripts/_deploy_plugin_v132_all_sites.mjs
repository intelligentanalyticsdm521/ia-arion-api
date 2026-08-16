#!/usr/bin/env node
/**
 * Deploy IA plugin v1.3.2 (Shield reader + Shield detection in health-pulse &
 * admin dashboard) to ALL 4 sites. Pushes the 3 changed files via SFTP with a
 * per-file server `php -l` gate + backup; only swaps a file in if it lints.
 */
import fs from 'node:fs';
import { runWpCli, runSshCommand, uploadFileViaSftp, checkWpInstallExists } from '../lib/hostingerSsh.js';

const BASE = 'C:/dev/iadm/intelligent-analytics - WP Plugin';
const FILES = [
  { local: `${BASE}/intelligent-analytics.php`,               rel: 'intelligent-analytics.php' },
  { local: `${BASE}/includes/class-ia-health-pulse.php`,      rel: 'includes/class-ia-health-pulse.php' },
  { local: `${BASE}/includes/class-ia-admin.php`,             rel: 'includes/class-ia-admin.php' },
];
const SITES = ['rollinginitllc.com', 'briarwoodsmiles.com', 'midwestagservices.com', 'intelligentanalyticsdm.com'];

const bufs = FILES.map(f => ({ ...f, buf: fs.readFileSync(f.local) }));
const results = [];

for (const domain of SITES) {
  const r = { domain, status: 'UNKNOWN', files: [] };
  try {
    if (!(await checkWpInstallExists(domain))) { r.status = 'FATAL — not reachable'; results.push(r); console.log(`${domain}: FATAL not reachable`); continue; }
    const plugdir = ((await runWpCli(domain, `eval "echo WP_PLUGIN_DIR;"`)).stdout || '').trim();
    const root = `${plugdir}/intelligent-analytics`;
    let allOk = true;
    for (const f of bufs) {
      const target = `${root}/${f.rel}`;
      const tmp = `${target}.new`;
      await uploadFileViaSftp(f.buf, tmp);
      const lint = ((await runSshCommand(`php -l '${tmp}' 2>&1`)).stdout || '');
      if (!/No syntax errors detected/.test(lint)) {
        allOk = false; r.files.push(`${f.rel}: LINT_FAIL`); await runSshCommand(`rm -f '${tmp}'`).catch(()=>{});
        console.log(`  ${domain} ${f.rel}: LINT FAIL — ${lint.slice(0,150)}`);
        continue;
      }
      await runSshCommand(`cp -f '${target}' '${target}.bak-20260705b' 2>/dev/null; mv -f '${tmp}' '${target}'`);
      r.files.push(`${f.rel}: ok`);
    }
    const ver = ((await runWpCli(domain, 'plugin get intelligent-analytics --field=version')).stdout || '').trim();
    const active = await runWpCli(domain, 'plugin is-active intelligent-analytics').then(() => 'active').catch(() => 'INACTIVE');
    await runWpCli(domain, 'cache flush').catch(()=>{});
    r.version = ver; r.active = active;
    r.status = (allOk && active === 'active') ? 'PASS' : 'CHECK';
    console.log(`${domain}: ${r.status} v${ver} active=${active} [${r.files.join(', ')}]`);
  } catch (e) { r.status = 'FATAL'; r.err = (e.message||'').slice(0,200); console.log(`${domain}: FATAL ${r.err}`); }
  results.push(r);
}
console.log('\n════ SUMMARY ════');
for (const r of results) console.log(`  ${r.domain.padEnd(28)} [${String(r.status).padEnd(16)}] v${r.version||'?'} active=${r.active||'?'}`);
process.exit(results.some(r => !String(r.status).startsWith('PASS')) ? 1 : 0);
