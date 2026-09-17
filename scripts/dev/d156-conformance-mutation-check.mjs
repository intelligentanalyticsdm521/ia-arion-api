/**
 * Mutation check for the D-156 CONFORMANCE pass (arion-api).
 *
 *   node scripts/dev/d156-conformance-mutation-check.mjs
 *
 * A green test proves nothing until you have made it fail on purpose
 * (memory: feedback_mutation_test_your_guards). Each mutation below breaks ONE
 * of the guards this pass added, runs the test file that should notice, and
 * restores the source. A mutation nothing notices is reported as a HOLE — the
 * guard is decorative, and the next person is told so rather than reassured.
 *
 * The guards, by the audit row each one closes:
 *   M1  point 1  — `alignItems` reaches the website
 *   M2  point 1  — an author who turns wrapping OFF is obeyed
 *   M8  point 1  — a wrap set for ONE DEVICE reaches that device
 *   M3  point 1  — `props.html_tag` reaches the website
 *   M4  point 11 — both form paths type a submission identically
 *   M5  point 7  — a product lock is not a plan lock
 *   M6  point 1  — every key we publish is one the page engine has (the pin)
 *   M7  point 7  — "we could not ask" does not lock a paying client out
 *   M9  point 8  — the sentence promises only what the publish will do
 *
 * Run 2026-09-17: all eight RED, then restored. M2 and M8 were written the
 * other way round at first and M8 came back a HOLE — the desktop default was
 * rescuing the per-device read, and the test could not tell the two apart
 * until the per-device assertion became its own test. That is the harness
 * doing its job on the harness.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'M1 the box\'s ALIGN is dropped on the way to the website',
    file: 'lib/websiteBuilder/elementorTree.js',
    from: "    if (s.alignItems && ALIGN_WORDS[s.alignItems]) out.align = ALIGN_WORDS[s.alignItems];",
    to: '    // the align the author set is dropped, as it was before this pass',
    test: 'test/website-container-controls.test.mjs',
    expects: 'align items did not reach the website',
  },
  {
    name: 'M2 wrapping OFF is silently ignored (absent means the row default)',
    file: 'lib/websiteBuilder/elementorTree.js',
    from: "    if (base.layout === 'row' && base.wrap === undefined) base.wrap = 'nowrap';",
    to: '    // a row that says nothing about wrapping is left to the emitter',
    test: 'test/website-container-controls.test.mjs',
    expects: 'an author who turns WRAPPING OFF is obeyed',
  },
  {
    name: 'M8 a wrap set FOR PHONES is dropped',
    file: 'lib/websiteBuilder/elementorTree.js',
    from: "    if (s.wrap !== undefined) out.wrap = s.wrap ? 'wrap' : 'nowrap';",
    to: "    if (s.wrap === 'never') out.wrap = 'nowrap';",
    test: 'test/website-container-controls.test.mjs',
    expects: 'a wrap set for phones did not reach the website',
  },
  {
    name: 'M3 a box\'s TAG never reaches the page',
    file: 'lib/websiteBuilder/elementorTree.js',
    from: "    ...(node.htmlTag && HTML_TAGS.includes(String(node.htmlTag)) ? { html_tag: String(node.htmlTag) } : {}),",
    to: '    // no html_tag, as before this pass',
    test: 'test/website-container-controls.test.mjs',
    expects: 'the box\'s tag did not reach the website',
  },
  {
    name: 'M4 the tree path stops typing a form (the two doors disagree again)',
    file: 'lib/websiteBuilder/elementorWidgets.js',
    from: '      ...formPurposeSettings(p[FORM_PURPOSE_KEY] ?? p.purpose, p[CSS_CLASSES_KEY]),',
    to: '      // the widget path writes no purpose at all, as before this pass',
    test: 'test/website-conformance-d156.test.mjs',
    expects: 'the two form paths disagree',
  },
  {
    name: 'M5 a product lock collapses into the plan lock',
    file: 'lib/websiteBuilder/elementorWidgets.js',
    from: "  return row.tier === PRO ? 'tier' : 'ownership';",
    to: "  return 'tier';",
    test: 'test/website-conformance-d156.test.mjs',
    expects: 'a product lock arrived as a plan lock',
  },
  {
    name: 'M6 a key the page engine does not have is published',
    file: 'lib/websiteBuilder/elementorTree.js',
    from: "    flex_gap: px(24),",
    to: "    flex_gap: px(24),\n    flex_gutter: px(24),",
    test: 'test/website-container-controls.test.mjs',
    expects: 'the page engine\'s container has no such control',
  },
  {
    name: 'M9 the pane promises a swap the publish will refuse',
    file: 'lib/websiteBuilder/elementorWidgets.js',
    from: '  return row.fallbackFires ? !!row.fallbackFires(ctx) : true;',
    to: '  return true;',
    test: 'test/website-conformance-d156.test.mjs',
    expects: 'the sentence promises a swap that will not happen',
  },
  {
    name: 'M7 a failed ownership query locks a paying client out',
    file: 'lib/websiteBuilder/elementorWidgets.js',
    from: '  return answer && answer.known ? (answer.owned || []) : null;',
    to: '  return (answer && answer.owned) || [];',
    test: 'test/website-conformance-d156.test.mjs',
    expects: 'locks NOTHING',
  },
];

let holes = 0;
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8');
  /* THE FILE'S OWN LINE ENDINGS. These repos are CRLF on disk and the
     mutations above are written with \n, so comparing them literally would
     SKIP a check and report a guard as stale when the guard is fine. */
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
