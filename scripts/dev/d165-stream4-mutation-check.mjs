/**
 * Mutation check for D-165 stream 4 (arion-api).
 *
 *   node scripts/dev/d165-stream4-mutation-check.mjs
 *
 * A green test proves nothing until you have made it fail on purpose
 * (memory: feedback_mutation_test_your_guards). Each mutation breaks ONE of
 * the guards this pass added, runs the test that should notice, and restores
 * the file. A mutation nothing notices is a HOLE, and it is reported as one.
 *
 * The six:
 *   M1  the alias table stops resolving, so Elementor's own spelling 404s
 *   M2  a widget publishes a name the page engine does not have
 *   M3  a select passes a value the control does not offer
 *   M4  a composition is gated on a plugin widget it does not need
 *   M5  the Lite gate stops refusing the paid panel
 *   M6  a form with nowhere to send is published anyway
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: "M1 Elementor's own spelling no longer reaches the kind we store",
    file: 'lib/websiteBuilder/elementorWidgets.js',
    from: "  return WIDGET_KIND_ALIASES[k] || k;",
    to: '  return k;',
    test: 'test/website-widget-map.test.mjs',
    expects: 'reaches no row at all',
  },
  {
    name: 'M2 a standard kind publishes a widget name the page engine has never had',
    file: 'lib/websiteBuilder/elementorWidgets.js',
    from: "    widgetType: 'icon-box', tier: FREE, label: 'Icon with words',",
    to: "    widgetType: 'icon-box-v2', tier: FREE, label: 'Icon with words',",
    test: 'test/website-widget-map.test.mjs',
    expects: 'icon_box publishes',
  },
  {
    name: 'M3 a select hands the engine a value the control does not offer',
    file: 'lib/websiteBuilder/elementorWidgets.js',
    from: "function choice(value, allowed, dflt) {\n  const v = String(value == null ? '' : value).toLowerCase().trim();\n  const hit = allowed.find((a) => a === v);\n  return hit === undefined ? dflt : hit;\n}",
    to: "function choice(value, allowed, dflt) {\n  const v = String(value == null ? '' : value).toLowerCase().trim();\n  return v || dflt;\n}",
    test: 'test/website-widget-map.test.mjs',
    expects: 'passed a value the control does not offer straight through',
  },
  {
    name: 'M4 a composition is refused because the plugin has not registered something it does not need',
    file: 'lib/websiteBuilder/elementorWidgets.js',
    from: '  if (product && !row.node && Array.isArray(iaWidgets) && !iaWidgets.includes(row.widgetType)) {',
    to: '  if (product && Array.isArray(iaWidgets) && !iaWidgets.includes(row.widgetType)) {',
    test: 'test/website-widget-map.test.mjs',
    expects: 'refused because the plugin has not registered',
  },
  {
    name: 'M5 the plan gate stops refusing the paid panel on Lite',
    file: 'lib/websiteBuilder/elementorWidgets.js',
    from: '  if (row.tier === PRO && !allowPro) {',
    to: '  if (false && row.tier === PRO && !allowPro) {',
    test: 'test/website-widget-map.test.mjs',
    expects: 'is paid and was offered on Lite',
  },
  {
    name: 'M6 a form with nowhere to send is published anyway',
    file: 'lib/websiteBuilder/elementorWidgets.js',
    from: "      if (!Array.isArray(ctx.iaShortcodes) || !ctx.iaShortcodes.includes('ia_form')) return null;",
    to: '      // published whatever the site can do with it',
    test: 'test/website-widget-map.test.mjs',
    expects: 'a form that cannot send is never drawn',
  },
];

let holes = 0;
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8');
  /* THE FILE'S OWN LINE ENDINGS — these repos are CRLF on disk and the
     mutations are written with \n, so a literal compare would SKIP the check
     and report a working guard as stale. */
  const eol = original.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const from = m.from.split('\n').join(eol);
  const to = m.to.split('\n').join(eol);
  if (!original.includes(from)) {
    console.log(`SKIP  ${m.name} — the line it mutates has moved, so this check is stale`);
    holes += 1;
    continue;
  }
  writeFileSync(m.file, original.replace(from, to), 'utf8');
  let output = '';
  let failed = false;
  try {
    output = execFileSync(process.execPath, ['--test', m.test], { encoding: 'utf8' });
  } catch (err) {
    failed = true;
    output = `${err.stdout || ''}${err.stderr || ''}`;
  } finally {
    writeFileSync(m.file, original, 'utf8');
  }
  const noticed = failed && output.includes(m.expects);
  console.log(`${noticed ? 'RED ' : 'HOLE'}  ${m.name} → "${m.expects}"`);
  if (!noticed) holes += 1;
}

console.log(holes === 0
  ? `\nAll ${MUTATIONS.length} mutations were caught, and every file was restored.`
  : `\n${holes} mutation(s) went unnoticed — those guards do not guard.`);
process.exit(holes === 0 ? 0 : 1);
