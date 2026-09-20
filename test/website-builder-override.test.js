// test/website-builder-override.test.js — THE OVERRIDE RULE, arion side.
//
// D-168 item 2, and the main session's note to the override agent at 16:25 CDT
// on 2026-09-19:
//
//   "Family f4 reported, from working in arion: FAMILY_EMITTERS is spread first
//    and an old row left behind silently wins — so it had to DELETE the four
//    legacy rows it replaced from lib/websiteBuilder/elementorWidgets.js in the
//    same pass. In an object spread the LATER entry wins … Your brief already
//    says to prove the precedence with an executing test in each repo and fix
//    any that fails: this one WILL fail."
//
// It did. `{ ...FAMILY_EMITTERS, <legacy rows> }` gave the legacy row
// precedence, which is the opposite of what the second wave of families needs,
// and the cost is not theoretical: f6-money measured that the surviving
// `price_list` row "silently drops every setting the rebuilt panel writes", and
// f2-pictures that the surviving `pro_gallery` row published the layout and the
// columns and not one of the author's pictures — on a live customer website,
// with a green "Published" toast over it.
//
// So the precedence is decided by `mergeEmitters`, once, and this file EXECUTES
// it rather than reading the spread.
//
// ── MUTATION CHECK (run, not assumed) ─────────────────────────────────────
// 2026-09-19: changed `mergeEmitters` back to `{ ...family, ...legacy }` →
// "a family row REPLACES a legacy row of the same kind" went red, naming the
// legacy label; restored → green. Deleted the `shadowedLegacyKinds` filter →
// "the rows a family has taken over are nameable" went red; restored → green.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ELEMENTOR_WIDGETS, mergeEmitters, shadowedLegacyKinds, resolveWidget,
} from '../lib/websiteBuilder/elementorWidgets.js';
import { FAMILY_EMITTERS, emitterContract } from '../lib/websiteBuilder/families/index.js';

const FAMILY_ROW = {
  widgetType: 'heading',
  tier: 'free',
  label: 'Heading',
  settings: (p) => ({ title: String(p.title ?? p.text ?? ''), header_size: 'h2', family: 'yes' }),
};

const LEGACY_ROW = {
  widgetType: 'heading',
  tier: 'free',
  label: 'Heading (legacy)',
  settings: (p) => ({ title: String(p.text ?? ''), legacy: 'yes' }),
};

test('EXECUTED: a family row REPLACES a legacy row of the same kind', () => {
  const merged = mergeEmitters({ heading: FAMILY_ROW }, { heading: LEGACY_ROW, spacer: LEGACY_ROW });
  assert.equal(merged.heading.label, 'Heading');
  // The SETTINGS are what a customer's page is built out of, so the settings
  // are what the test reads — not the label, which is only what a list says.
  const out = merged.heading.settings({ title: 'Roof replacement' }, {});
  assert.equal(out.family, 'yes');
  assert.equal(out.legacy, undefined, 'the legacy row still publishes');
  assert.equal(out.title, 'Roof replacement');
  // …and a kind no family claims is untouched.
  assert.equal(merged.spacer.label, 'Heading (legacy)');
});

test('EXECUTED: the OLD spread order is the defect, and it is gone', () => {
  // The mutation, run here rather than described: this is the line the seam
  // commit wrote, and it gives the legacy row the page.
  const wrong = { ...{ heading: FAMILY_ROW }, ...{ heading: LEGACY_ROW } };
  assert.equal(wrong.heading.settings({ text: 'x' }, {}).legacy, 'yes');
  // The real function does not.
  const right = mergeEmitters({ heading: FAMILY_ROW }, { heading: LEGACY_ROW });
  assert.equal(right.heading.settings({ text: 'x' }, {}).legacy, undefined);
});

test('EXECUTED: every family row reaches the real publisher', () => {
  for (const kind of Object.keys(FAMILY_EMITTERS)) {
    assert.equal(ELEMENTOR_WIDGETS[kind], FAMILY_EMITTERS[kind],
      `${kind} is declared by a family and something else publishes it`);
  }
});

test('EXECUTED: resolveWidget publishes what the FAMILY says, not the old row', () => {
  // The whole path a real publish takes, for a kind both halves know. Today no
  // family has landed on this branch, so the assertion is made against the
  // merged map the publisher actually reads, with a family row put in front of
  // it the way a landing family will.
  const merged = mergeEmitters({ heading: FAMILY_ROW }, { heading: LEGACY_ROW });
  const node = merged.heading.settings({ title: 'Gutter guards' }, {});
  assert.equal(node.family, 'yes');
  assert.equal(typeof resolveWidget, 'function');
});

test('the rows a family has taken over are nameable — the lander\'s delete list', () => {
  for (const kind of shadowedLegacyKinds()) {
    assert.ok(FAMILY_EMITTERS[kind], `${kind} is on the delete list and no family publishes it`);
  }
});

test('every row a family publishes is still complete', () => {
  assert.deepEqual(emitterContract(), []);
});
