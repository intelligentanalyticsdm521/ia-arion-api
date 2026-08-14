#!/usr/bin/env node
/**
 * Force a PHP-FPM OPcache reset on each site by dropping a tiny web-accessible
 * PHP file (random name), fetching it over HTTPS so opcache_reset() runs in the
 * FPM worker (not CLI), then deleting it immediately. Needed because SFTP-updating
 * a plugin file doesn't recompile if OPcache has validate_timestamps off.
 */
import { runSshCommand, uploadFileViaSftp, runWpCli } from '../lib/hostingerSsh.js';
// Sites come from argv so this can be pointed at ONE site. Resetting opcache on
// a client site is harmless but pointless when only our own canary changed.
const SITES = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!SITES.length) { console.error('usage: node scripts/_force_opcache_reset.mjs <domain> [domain ...]'); process.exit(1); }
const rand = Math.random().toString(36).slice(2, 10);
const name = `ia-oc-${rand}.php`;
const php = "<?php header('Content-Type: text/plain'); if(function_exists('opcache_reset')){ echo opcache_reset()?'OPCACHE_RESET_OK':'RESET_FALSE'; } else { echo 'NO_OPCACHE'; }";
for (const domain of SITES) {
  try {
    const abspath = ((await runWpCli(domain, `eval "echo untrailingslashit(ABSPATH);"`)).stdout || '').trim();
    if (!abspath.startsWith('/')) { console.log(`${domain}: bad ABSPATH ${abspath}`); continue; }
    const remote = `${abspath}/${name}`;
    await uploadFileViaSftp(Buffer.from(php, 'utf8'), remote);
    let txt = '';
    try {
      const res = await fetch(`https://${domain}/${name}`, { signal: AbortSignal.timeout(20000) });
      txt = (await res.text()).trim().slice(0, 60);
    } catch (e) { txt = 'FETCH_ERR ' + (e.message || ''); }
    await runSshCommand(`rm -f '${remote}'`).catch(() => {});
    console.log(`${domain}: ${txt}`);
  } catch (e) { console.log(`${domain}: ERR ${(e.message || '').slice(0, 120)}`); }
}
console.log('done');
