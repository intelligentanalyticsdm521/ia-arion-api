// test/website-builder-families.test.js — the ten family folders keep their
// contract on the PUBLISHING side.
//
// BUILDER_FULL_WIDGET_PLAN_2026-09-19 §C.1. What this pins before a single
// widget is written:
//
//   · all ten folders exist and export a map, so no agent has to create one;
//   · a row is COMPLETE — widgetType, tier, label and settings(props, ctx) —
//     because a row without them publishes a node the page engine cannot draw,
//     which is a blank band on a live site with a green toast over it
//     (reference_catch_swallow_report_success);
//   · no two families claim the same kind;
//   · elementorWidgets.js spreads the families AND still has its own rows,
//     which is what "keep them for one release, then delete them" means.
//
// A FAMILY ADDS ITS OWN CASES as it adds widgets, here or beside its folder.
// The settings-key check — every key an emitter produces exists on the
// Elementor widget it claims to be — lives in the Portal, against
// test/fixtures/WIDGET_SETTINGS_KEYS.json, because that is where the machine
// files were turned into a fixture.
//
// ── MUTATION CHECK (run, not assumed) ──────────────────────────────────────
// 2026-09-19: put `{ heading: { widgetType: 'heading' } }` into
// families/f1-words/emitters.js → "every row a family publishes is complete"
// went red naming the missing tier; removed it → green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAMILIES, FAMILY_EMITTERS, emitterContract } from '../lib/websiteBuilder/families/index.js';
import { ELEMENTOR_WIDGETS } from '../lib/websiteBuilder/elementorWidgets.js';

const TEN = [
  'container', 'f1-words', 'f2-pictures', 'f3-buttons-icons-panels', 'f4-moving',
  'f5-sliders-reviews', 'f6-money', 'f7-data-lists', 'f8-contact-furniture', 'ia',
];

test('all ten families are wired into the one index', () => {
  assert.deepEqual(FAMILIES.map(([n]) => n), TEN);
  for (const [name, map] of FAMILIES) assert.equal(typeof map, 'object', name);
});

test('every row a family publishes is complete', () => {
  assert.deepEqual(emitterContract(), []);
});

test('the one index is spread into ELEMENTOR_WIDGETS, and the old rows survive', () => {
  for (const kind of Object.keys(FAMILY_EMITTERS)) {
    assert.equal(ELEMENTOR_WIDGETS[kind], FAMILY_EMITTERS[kind], kind);
  }
  assert.ok(ELEMENTOR_WIDGETS.heading, 'the catalogue lost its own rows');
});
