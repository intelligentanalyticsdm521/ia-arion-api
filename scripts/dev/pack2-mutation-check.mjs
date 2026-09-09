#!/usr/bin/env node
/**
 * pack2-mutation-check.mjs — break every ARION pack 2 guard on purpose and
 * prove the thing that is supposed to catch it goes RED.
 *
 * A green check proves nothing until you have made it fail
 * (memory: feedback_mutation_test_your_guards). Each mutation below edits one
 * file, runs the check that owns that guard, requires it to FAIL, then puts the
 * file back and proves it is byte-identical to what it was.
 *
 * ⚠ Dev only, and it needs everything the two verifiers need: the dev
 * WordPress container on plugin >= 1.7.4 and, for the route mutations,
 * arion-api on the given port with DEV_AUTH=1.
 *
 *   node scripts/dev/pack2-mutation-check.mjs [--only code|plugin]
 *
 * ⚠ A plugin mutation is DESTRUCTIVE to the fixture while it runs: each mutant
 * breaks the guard whose job is to stop the verifier's destructive step. The
 * sweep finishes by running the clean verifier again and telling you whether
 * the fixture came back.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

/**
 * PHP inside the container reads the plugin through a bind mount and through
 * opcache, and neither notices a write on the Windows host instantly. Without
 * this pause a mutant is sometimes still running the ORIGINAL code, everything
 * passes, and the sweep reports a guard as unprotected when it is not. Found
 * by two mutations that "missed" and then caught on a re-run.
 */
const PHP_SETTLE_MS = 9000;
const sleep = (ms) => execFileSync(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`], { stdio: 'ignore' });

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ONLY = arg('only', 'all');

const ARION = 'C:/dev/iadm/arion-api-septa-arion2';
const PORTAL = 'C:/dev/iadm/Portal-septa-arion2';
const PLUGIN = 'C:/dev/iadm/ia-plugin-septa-arion2/intelligent-analytics.php';

let caught = 0;
let missed = 0;

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** Run a command; true when it SUCCEEDED. */
function run(cmd, args, cwd) {
  try {
    execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

const checkers = {
  arionUnit: () => run('npm', ['test', '--silent'], ARION),
  arionPack2: () => run(process.execPath, ['--test', 'test/arion-pack2-site.test.mjs'], ARION),
  portalPack2: () => run(process.execPath, ['--import', './scripts/test-ts-loader.mjs', '--test', 'test/arion-pack2-ui.test.mjs'], PORTAL),
  live: () => run(process.execPath, ['scripts/_dev_verify_pack2.mjs'], ARION),
  routes: () => run(process.execPath, ['scripts/_dev_verify_pack2_routes.mjs'], ARION),
};

/**
 * @param {{name:string,file:string,from:string,to:string,checker:keyof checkers,group:'code'|'plugin'}} m
 */
function mutate(m) {
  if (ONLY !== 'all' && ONLY !== m.group) return;
  const before = fs.readFileSync(m.file, 'utf8');
  const beforeSha = sha(m.file);
  const count = before.split(m.from).length - 1;
  if (count !== 1) {
    console.log(`  SKIP  ${m.name} — the line to break was found ${count} times`);
    missed += 1;
    return;
  }
  fs.writeFileSync(m.file, before.replace(m.from, m.to));
  if (m.group === 'plugin') sleep(PHP_SETTLE_MS);
  let stillGreen;
  try {
    stillGreen = checkers[m.checker]();
  } finally {
    fs.writeFileSync(m.file, before);
    if (m.group === 'plugin') sleep(PHP_SETTLE_MS);
  }
  const restored = sha(m.file) === beforeSha;
  if (stillGreen) {
    missed += 1;
    console.log(`  MISSED  ${m.name} — the guard was broken and everything still passed`);
  } else {
    caught += 1;
    console.log(`  caught  ${m.name}`);
  }
  if (!restored) {
    missed += 1;
    console.log(`  ⚠ NOT RESTORED: ${m.file}`);
  }
}

console.log('\n=== ARION pack 2: breaking each guard on purpose ===\n');

/* ══════════════ code guards ══════════════════════════════════════════ */
if (ONLY === 'all' || ONLY === 'code') {
  console.log('-- arion-api --');

  mutate({
    group: 'code', checker: 'arionPack2',
    name: 'no price is no price (formatPrice must not read null as zero)',
    file: `${ARION}/lib/websiteBuilder/servicePricing.js`,
    from: "  if (unitAmount === null || unitAmount === undefined || unitAmount === '') return '';",
    to: "  // MUTANT",
  });

  mutate({
    group: 'code', checker: 'arionPack2',
    name: 'unit_amount is DOLLARS (reading it as cents)',
    file: `${ARION}/lib/websiteBuilder/servicePricing.js`,
    from: '  const n = Number(unitAmount);\n  if (!Number.isFinite(n) || n < 0) return \'\';',
    to: '  const n = Number(unitAmount) / 100;\n  if (!Number.isFinite(n) || n < 0) return \'\';',
  });

  mutate({
    group: 'code', checker: 'arionPack2',
    name: 'a brand colour is never invented when none is on file',
    file: `${ARION}/routes/arion/website.js`,
    from: '  if (!primary) {\n    return {\n      hasBrandColour: false,\n      colors: [],',
    to: "  if (!primary) {\n    return {\n      hasBrandColour: false,\n      colors: [{ id: 'primary', title: 'Primary', color: '#2D9CDB' }],",
  });

  mutate({
    group: 'code', checker: 'arionPack2',
    name: 'a business with no recorded name gets no footer wording',
    file: `${ARION}/routes/arion/website.js`,
    from: "    footerText: known ? `© ${new Date().getFullYear()} ${name}. All rights reserved.` : '',",
    to: "    footerText: `© ${new Date().getFullYear()} ${name || 'Your Business'}. All rights reserved.`,",
  });

  mutate({
    group: 'code', checker: 'arionPack2',
    name: 'a menu item carries its nesting to the Portal',
    file: `${ARION}/routes/arion/website.js`,
    from: '        parentItemId: Number(i.parent_item_id) || 0,',
    to: '        parentItemId: 0,',
  });

  mutate({
    group: 'code', checker: 'arionPack2',
    name: 'a pricing card round-trips (breaking the encoder)',
    file: `${ARION}/lib/websiteBuilder/sectionSchema.js`,
    from: '    `<p class="ia-plan-summary">${escapeHtml(item?.summary)}</p>`,',
    to: '    `<p>${escapeHtml(item?.summary)}</p>`,',
  });

  mutate({
    group: 'code', checker: 'arionPack2',
    name: 'a take-one step must not eat the last widget an all-step needs',
    file: `${ARION}/lib/websiteBuilder/libraryAdapter.js`,
    from: '    if (laterAllNeeds && candidates.length <= 1) continue;',
    to: '    // MUTANT',
  });

  mutate({
    group: 'code', checker: 'arionUnit',
    name: 'the header and footer say where they moved to',
    file: `${ARION}/lib/websiteBuilder/libraryAdapter.js`,
    from: "  header:  'Your header is not part of a page",
    to: "  header:  'Not available. (Your header is not part of a page",
  });

  mutate({
    group: 'code', checker: 'arionPack2',
    name: 'the wp-admin deep link accepts an admin screen and nothing else',
    file: `${ARION}/routes/arion.js`,
    from: '  return /^[a-z0-9_-]+\\.php(\\?[A-Za-z0-9_\\-=&%.,+]*)?$/.test(d);',
    to: '  return true;',
  });

  console.log('\n-- Portal --');

  mutate({
    group: 'code', checker: 'portalPack2',
    name: 'moving a menu row re-points every parent',
    file: `${PORTAL}/src/arion/utils/menuListState.ts`,
    from: '  return repoint(rows, next);\n}\n\nexport function removeMenuRow',
    to: '  return next;\n}\n\nexport function removeMenuRow',
  });

  mutate({
    group: 'code', checker: 'portalPack2',
    name: 'removing a parent brings its children back out',
    file: `${PORTAL}/src/arion/utils/menuListState.ts`,
    from: '    const stillThere = moved.has(original.parentIndex);',
    to: '    const stillThere = true;',
  });

  mutate({
    group: 'code', checker: 'portalPack2',
    name: 'the WP Admin user-management lie stays gone',
    file: `${PORTAL}/src/arion/pages/website/WebsiteSettings.tsx`,
    from: '            Whoever you invite to this account can change your website from here. There is no second',
    to: '            User management is available through WP Admin. There is no second',
  });

  mutate({
    group: 'code', checker: 'portalPack2',
    name: 'the WP Admin button is IA staff only',
    file: `${PORTAL}/src/arion/components/ArionPageHeader.tsx`,
    from: '      {isFounder && (',
    to: '      {true && (',
  });

  mutate({
    group: 'code', checker: 'portalPack2',
    name: 'an option the design does not offer is shown with its reason',
    file: `${PORTAL}/src/arion/pages/website/WebsiteDesign.tsx`,
    from: '    if (!f.supported) {',
    to: '    if (false) {',
  });

  mutate({
    group: 'code', checker: 'portalPack2',
    name: 'blog posts have their own list',
    file: `${PORTAL}/src/arion/pages/website/WebsitePages.tsx`,
    from: '        {livePosts.map(row)}',
    to: '        {[].map(row)}',
  });
}

/* ══════════════ plugin guards, against the real container ════════════ */
if (ONLY === 'all' || ONLY === 'plugin') {
  console.log('\n-- the plugin, against the dev WordPress --');

  mutate({
    group: 'plugin', checker: 'live',
    name: 'a menu link has to be somewhere a browser can go',
    file: PLUGIN,
    from: "\t\tif ( preg_match( '#^https?://#i', $u ) ) return true;",
    to: "\t\tif ( true ) return true;",
  });

  mutate({
    group: 'plugin', checker: 'live',
    name: 'a menu is validated BEFORE the snapshot, so a refusal changes nothing',
    file: PLUGIN,
    from: "\t\t\t$valid = self::ia_validate_menu_items( $body['items'] );",
    to: "\t\t\t$valid = true;",
  });

  mutate({
    group: 'plugin', checker: 'live',
    name: 'the plugin knows the three new section kinds',
    file: PLUGIN,
    from: "\t\t\t// ARION pack 2.\r\n\t\t\t'pricing', 'team', 'stats',",
    to: "\t\t\t// MUTANT",
  });

  mutate({
    group: 'plugin', checker: 'live',
    name: 'a category is resolved to a term, not handed over as a name',
    file: PLUGIN,
    from: "\t\t\t\t$term_ids = self::ia_terms_by_name( $names, $taxonomy );",
    to: "\t\t\t\t$term_ids = $names;",
  });

  mutate({
    group: 'plugin', checker: 'live',
    name: "Elementor's own kit mirror cannot turn a name change into a 500",
    file: PLUGIN,
    from: "\t\ttry {\r\n\t\t\tupdate_option( $name, $value );\r\n\t\t} catch ( \\Throwable $e ) {",
    to: "\t\tupdate_option( $name, $value );\r\n\t\tif ( false ) { } elseif ( false ) {",
  });

  mutate({
    group: 'plugin', checker: 'live',
    name: 'the header and footer whitelist refuses a key we do not own',
    file: PLUGIN,
    from: "\t\t\tif ( ! isset( $fields[ $key ] ) ) {\r\n\t\t\t\t// A key we do not own is REFUSED, never quietly ignored: the",
    to: "\t\t\tif ( false ) {\r\n\t\t\t\t// A key we do not own is REFUSED, never quietly ignored: the",
  });

  mutate({
    group: 'plugin', checker: 'live',
    name: 'the site-options whitelist refuses a key we do not own',
    file: PLUGIN,
    from: "\t\t\tif ( ! in_array( (string) $key, $allowed, true ) ) {",
    to: "\t\t\tif ( false ) {",
  });

  mutate({
    group: 'plugin', checker: 'live',
    name: 'a colour has to be a colour',
    file: PLUGIN,
    from: "\t\treturn is_string( $v ) && (bool) preg_match( '/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/', trim( $v ) );",
    to: "\t\treturn is_string( $v );",
  });

  mutate({
    group: 'plugin', checker: 'live',
    name: 'a kit setting is read back from the meta we wrote, not a request cache',
    file: PLUGIN,
    from: "\t\t\tif ( array_key_exists( $name, $settings ) ) return $settings[ $name ];",
    to: "\t\t\tif ( false ) return $settings[ $name ];",
  });
}

console.log(`\n=== ${caught} caught, ${missed} missed ===\n`);
if (ONLY === 'all' || ONLY === 'plugin') {
  console.log('Re-running the clean verifier to prove the fixture came back...');
  const green = checkers.live();
  console.log(green ? '  the dev website is back the way it was' : '  ⚠ the dev website did NOT come back clean — re-run start-dev-wp.ps1 -Reseed');
  if (!green) process.exit(1);
}
process.exit(missed === 0 ? 0 : 1);
