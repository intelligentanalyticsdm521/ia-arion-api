/**
 * Mutation check for D-156 stream D (the container dialect + the plan gate).
 *
 *   node scripts/dev/d156-stream-d-mutation-check.mjs
 *
 * A green test proves nothing until you have made it fail on purpose
 * (memory: feedback_mutation_test_your_guards). Each mutation below breaks ONE
 * guard, runs the test file that should notice, and restores the source. A
 * mutation that leaves the suite green is reported as a HOLE — the guard is
 * decorative and the next person is told so rather than reassured.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const MUTATIONS = [
  {
    name: 'M1 every container is emitted at depth 0',
    file: 'lib/websiteBuilder/elementorTree.js',
    from: 'elements: children.map((c) => treeToElementor(c, ctx, depth + 1)),',
    to: 'elements: children.map((c) => treeToElementor(c, ctx, 0)),',
    test: 'test/website-elementor-tree.test.mjs',
    expects: 'a box inside a box keeps its depth',
  },
  {
    name: 'M2 resolveWidget ignores the plan',
    file: 'lib/websiteBuilder/elementorWidgets.js',
    from: '  const sentence = lockSentence(kind, ctx);',
    to: '  const sentence = null;',
    test: 'test/website-elementor-tree.test.mjs',
    expects: 'a Lite business gets the card as free widgets',
  },
  {
    name: 'M3 the lock says nothing',
    file: 'lib/websiteBuilder/elementorWidgets.js',
    from: "  if (row.tier === PRO && !allowPro) {\n    return row.fallback ? PRO_LOCK_SENTENCE : PRO_LOCK_SENTENCE_NO_FALLBACK;\n  }",
    to: '  if (row.tier === PRO && !allowPro) {\n    return null;\n  }',
    test: 'test/website-elementor-tree.test.mjs',
    expects: 'the lock says what the business gets instead',
  },
  {
    name: 'M4 the phone override is dropped',
    file: 'lib/websiteBuilder/elementorTree.js',
    from: "  layer(style.phone, '_mobile');",
    to: '  // layer(style.phone)',
    test: 'test/website-elementor-tree.test.mjs',
    expects: 'a phone override reaches the page',
  },
  {
    name: 'M5 the legacy emitters come back',
    file: 'lib/websiteBuilder/elementorAdapter.js',
    from: 'export function listSupportedKinds() {',
    to: "export function legacyHero() { return { elType: 'section', elements: [] }; }\nexport function listSupportedKinds() {",
    test: 'test/website-container-dialect.test.mjs',
    expects: 'the legacy emitters are GONE',
  },
];

let holes = 0;
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.from)) {
    console.log(`SKIP  ${m.name} — the line it mutates has moved, so this check is stale`);
    holes += 1;
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to), 'utf8');
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
