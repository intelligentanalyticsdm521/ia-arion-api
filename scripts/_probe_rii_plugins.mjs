#!/usr/bin/env node
/**
 * Diagnostic: SSH into Rolling In It WP root and dump installed plugins.
 * Reuses lib/hostingerSsh.js helpers.
 */
import { runSshCommand, runWpCli } from '../lib/hostingerSsh.js';

const DOMAIN = 'rollinginitllc.com';

async function main() {
  console.log(`[probe] domain=${DOMAIN}`);

  // 1) Confirm WP install exists at expected path
  try {
    const dirRes = await runSshCommand(`[ -d ~/domains/${DOMAIN}/public_html ] && echo IA_WP_EXISTS || echo IA_WP_MISSING`);
    console.log('[probe] wp dir:', dirRes.stdout.trim());
  } catch (e) {
    console.error('[probe] dir check failed:', e.message);
    process.exit(2);
  }

  // 2) wp core version
  try {
    const verRes = await runWpCli(DOMAIN, 'core version');
    console.log('[probe] wp core version:', verRes.stdout.trim());
  } catch (e) {
    console.error('[probe] wp core version failed:', e.message.slice(0, 400));
  }

  // 3) wp plugin list
  try {
    const listRes = await runWpCli(DOMAIN, 'plugin list --format=json');
    console.log('[probe] plugin list (raw):');
    console.log(listRes.stdout);
    try {
      const arr = JSON.parse(listRes.stdout);
      console.log(`\n[probe] PARSED ${arr.length} plugins:`);
      for (const p of arr) {
        console.log(`  - ${p.name.padEnd(35)} status=${p.status.padEnd(12)} version=${p.version || '?'} update=${p.update || ''}`);
      }
    } catch (parseErr) {
      console.warn('[probe] could not parse JSON:', parseErr.message);
    }
  } catch (e) {
    console.error('[probe] plugin list failed:', e.message.slice(0, 600));
  }

  // 4) wp theme list
  try {
    const themeRes = await runWpCli(DOMAIN, 'theme list --format=json');
    console.log('\n[probe] theme list (raw):');
    console.log(themeRes.stdout);
  } catch (e) {
    console.error('[probe] theme list failed:', e.message.slice(0, 400));
  }

  // 5) Specifically check critical plugin slugs
  const critical = ['elementor', 'elementor-pro', 'wordfence', 'seo-by-rank-math', 'ewww-image-optimizer', 'intelligent-analytics', 'hello-elementor'];
  console.log('\n[probe] Critical plugin presence checks:');
  for (const slug of critical) {
    try {
      const r = await runWpCli(DOMAIN, `plugin is-installed ${slug}`);
      console.log(`  ${slug.padEnd(30)} INSTALLED (exit 0)`);
    } catch (e) {
      const code = e.exitCode ?? e.code;
      console.log(`  ${slug.padEnd(30)} NOT_INSTALLED (exit ${code})`);
    }
  }

  // 6) Check option values that pluginStack writes
  console.log('\n[probe] IA brand options:');
  for (const opt of ['blogname', 'ia_brand_primary_color', 'ia_brand_secondary_color', 'ia_brand_accent_color', 'elementor_pro_license_key']) {
    try {
      const r = await runWpCli(DOMAIN, `option get ${opt}`);
      const val = (r.stdout || '').trim();
      const masked = opt.includes('license') ? (val ? `${val.slice(0, 4)}…(${val.length})` : '(empty)') : val;
      console.log(`  ${opt.padEnd(35)} = ${masked || '(empty)'}`);
    } catch (e) {
      console.log(`  ${opt.padEnd(35)} ERR: ${(e.message || '').slice(0, 120)}`);
    }
  }

  // 7) EWWW option samples
  console.log('\n[probe] EWWW options (expect 10 / 10 / 1 / 1 / 1 / 82 / 0):');
  for (const opt of ['ewww_image_optimizer_jpg_level', 'ewww_image_optimizer_png_level', 'ewww_image_optimizer_webp', 'ewww_image_optimizer_webp_for_cdn', 'ewww_image_optimizer_metadata_remove', 'ewww_image_optimizer_jpg_quality', 'ewww_image_optimizer_lazy_load']) {
    try {
      const r = await runWpCli(DOMAIN, `option get ${opt}`);
      console.log(`  ${opt.padEnd(40)} = ${(r.stdout || '').trim() || '(empty)'}`);
    } catch (e) {
      console.log(`  ${opt.padEnd(40)} ERR: ${(e.message || '').slice(0, 120)}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL:', e); process.exit(1); });
