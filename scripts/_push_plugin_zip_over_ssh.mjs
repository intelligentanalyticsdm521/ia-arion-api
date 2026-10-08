// Put IA plugin 2.0.1 on each connected site now, over the platform's own
// Hostinger SSH + wp-cli path (arion-api lib/hostingerSsh.js; credentials come
// from Key Vault inside the helper and are never printed here).
//
//   node push-plugin-2.0.1.mjs            dry run: reads version, status, onboarding flag per site
//   node push-plugin-2.0.1.mjs --apply    uploads the zip, `wp plugin install <zip> --force`,
//                                         keeps the plugin active and the onboarding flag as it was
//
// Why not `--activate`: wp-cli's activate fires the activation hook, which
// resets ia_onboarding_complete to 0 on a live client site. A plain --force
// reinstall leaves the active_plugins option alone, so the plugin stays active
// without the hook, the same as the plugin's own updater path.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { runWpCli, runSshCommand, uploadFileViaSftp } from 'file:///C:/dev/iadm/arion-api-septa/lib/hostingerSsh.js';

const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const ZIP = 'C:/Users/brand/AppData/Local/Temp/claude/C--dev-claude-code/bbef46de-a9df-494a-b525-9e6fc924ecfe/scratchpad/plugin/intelligent-analytics-2.0.1.zip';
const WANT = '2.0.1';
const SITES = [
  'briarwoodsmiles.com',
  'rollinginitllc.com',
  'midwestagservices.com',
  'intelligentanalyticsdm.com',
  'azure-coyote-795824.hostingersite.com',
].filter((d) => !ONLY || d === ONLY);

const buf = fs.readFileSync(ZIP);
const sha = crypto.createHash('sha256').update(buf).digest('hex');
console.log(`[push] zip ${buf.length} bytes sha256=${sha.slice(0, 16)}… want ${WANT} ${APPLY ? 'APPLY' : 'DRY RUN'}`);

const out = (r) => String(r.stdout || '').trim();
async function read(domain) {
  const version = out(await runWpCli(domain, 'plugin get intelligent-analytics --field=version'));
  const status = out(await runWpCli(domain, 'plugin get intelligent-analytics --field=status'));
  let onboarding = '';
  try { onboarding = out(await runWpCli(domain, 'option get ia_onboarding_complete')); } catch { onboarding = '(unset)'; }
  return { version, status, onboarding };
}

const summary = [];
for (const domain of SITES) {
  try {
    const before = await read(domain);
    console.log(`[${domain}] before: v${before.version} ${before.status} onboarding_complete=${before.onboarding}`);
    if (!APPLY) { summary.push(`${domain}: v${before.version} ${before.status}`); continue; }
    if (before.version === WANT) { summary.push(`${domain}: already ${WANT}`); continue; }

    const remote = 'ia-plugin-2.0.1.zip';
    await uploadFileViaSftp(buf, remote);
    const remoteSha = out(await runSshCommand(`sha256sum ~/${remote} | cut -d' ' -f1`));
    if (remoteSha !== sha) throw new Error(`upload sha mismatch (${remoteSha.slice(0, 12)}… vs ${sha.slice(0, 12)}…)`);

    const inst = await runWpCli(domain, `plugin install ~/${remote} --force`);
    console.log(`[${domain}] install: ${out(inst).split('\n').slice(-2).join(' | ')}`);

    const after = await read(domain);
    const fixes = [];
    if (after.status !== 'active' && before.status === 'active') {
      await runWpCli(domain, 'plugin activate intelligent-analytics');
      fixes.push('re-activated');
    }
    const after2 = fixes.length ? await read(domain) : after;
    if (after2.onboarding !== before.onboarding && before.onboarding !== '(unset)') {
      await runWpCli(domain, `option update ia_onboarding_complete ${JSON.stringify(before.onboarding)}`);
      fixes.push(`onboarding flag put back to ${before.onboarding}`);
    }
    await runSshCommand(`rm -f ~/${remote}`);
    const final = fixes.length ? await read(domain) : after2;
    const ok = final.version === WANT && final.status === 'active';
    console.log(`[${domain}] after: v${final.version} ${final.status} onboarding_complete=${final.onboarding}${fixes.length ? ' (' + fixes.join('; ') + ')' : ''} -> ${ok ? 'OK' : 'CHECK'}`);
    summary.push(`${domain}: ${ok ? 'OK' : 'CHECK'} v${final.version} ${final.status}`);
  } catch (e) {
    const msg = String(e && e.message || e).replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[key]').slice(0, 300);
    console.log(`[${domain}] FAILED: ${msg}`);
    summary.push(`${domain}: FAILED (${msg.slice(0, 120)})`);
  }
}
console.log('\n[push] summary');
for (const s of summary) console.log('  ' + s);
process.exit(summary.some((s) => /FAILED|CHECK/.test(s)) ? 1 : 0);
