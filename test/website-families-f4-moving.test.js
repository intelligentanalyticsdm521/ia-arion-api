// test/website-families-f4-moving.test.js — what the f4-moving family
// publishes to a real website, checked against the page engine's own controls.
//
// B-168 §C.1 step 4 and step 7. The Portal owns the tile; this file owns the
// half that reaches a customer's live site, and the one failure it exists to
// catch is the quiet one: a settings key the page engine does not have is
// DROPPED on publish, the toast says Published, and the author's change did
// nothing (reference_catch_swallow_report_success, the recurring shape).
//
// The legal key list is machine truth — the Portal's
// test/fixtures/WIDGET_SETTINGS_KEYS.json, cut from
// BUILDER_WIDGET_CATALOG_2026-09-17.{elementor,pro}.json. It is read from the
// served Portal checkout so there is ONE copy of it, not a second that drifts.
//
// ── MUTATION CHECKS (run, not assumed), 2026-09-19 ─────────────────────────
//  · counter emitting `thousand_separators` (the real key is singular) ->
//    "keys the page engine does not have" went red naming it; restored.
//  · star_rating sending legacyStars() whichever name the site has - the
//    defect this row was moved to fix - went red on rating_value; restored.
//  · putting a `counter` row back into elementorWidgets.js -> both this file
//    and website-builder-families.test.js went red, because the old row wins
//    the spread and the family row would never run; removed again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EMITTERS } from '../lib/websiteBuilder/families/f4-moving/emitters.js';
import { ELEMENTOR_WIDGETS, resolveWidget } from '../lib/websiteBuilder/elementorWidgets.js';

/* ONE copy of the machine truth. It lives in the Portal because that is where
   the catalogue was turned into a fixture; a second copy here is a second
   answer to "what keys does this widget have". */
const KEYS_CANDIDATES = [
  /* the served checkout, once b168/seams has landed on it */
  'Portal-septa',
  /* the seam's own worktree, and this family's, while the branch is in flight */
  'Portal-septa-b168s',
  'Portal-septa-b168f4',
].map((d) => path.join('C:', 'dev', 'iadm', d, 'test', 'fixtures', 'WIDGET_SETTINGS_KEYS.json'));
const KEYS_FILE = KEYS_CANDIDATES.find((p) => fs.existsSync(p)) || KEYS_CANDIDATES[0];
const HAVE_KEYS = fs.existsSync(KEYS_FILE);
const SETTINGS_KEYS = HAVE_KEYS ? JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')) : null;

/** Every key this emitter produced exists on the widget it claims to be. */
function assertKeys(kind, props = {}, ctx = {}) {
  const row = EMITTERS[kind];
  assert.ok(row, `${kind}: no row in this family`);
  if (!HAVE_KEYS) {
    /* SAY SO RATHER THAN PASS. An assertion against a list we could not read
       is a green tick that means nothing. */
    assert.fail(`WIDGET_SETTINGS_KEYS.json was not found at ${KEYS_FILE}, so no key `
      + 'could be checked. Point this at the served Portal checkout and run again.');
  }
  const widget = SETTINGS_KEYS.widgets[row.widgetType];
  assert.ok(widget, `${row.widgetType}: not an Elementor widget in the machine file`);
  assert.ok(widget.keys.length, `${row.widgetType}: the catalogue reports no controls, so `
    + 'nothing can be checked against it');
  const legal = new Set(widget.keys);
  const emitted = Object.keys(row.settings(props, ctx));
  const bad = emitted.filter((k) => !legal.has(k) && !legal.has(k.replace(/_(tablet|mobile)$/, '')));
  assert.deepEqual(bad, [], `${kind} → ${row.widgetType}: keys the page engine does not have, `
    + `so they are dropped on publish and the author's change does nothing: ${bad.join(', ')}`);
  assert.ok(emitted.length, `${kind}: published a widget with no settings at all`);
  return row;
}

test('the family publishes four rows, each one a real Elementor widget', () => {
  assert.deepEqual(Object.keys(EMITTERS).sort(),
    ['counter', 'progress_bar', 'progress_tracker', 'star_rating']);
  for (const [kind, row] of Object.entries(EMITTERS)) {
    assert.ok(row.widgetType, `${kind}: no widgetType`);
    assert.equal(typeof row.settings, 'function', `${kind}: no settings(props, ctx)`);
    assert.ok(row.tier && row.label, `${kind}: no tier or label`);
  }
});

test('every key every row emits is one the page engine really has', () => {
  assertKeys('counter', { starting_number: 0, ending_number: 250, prefix: '$', suffix: '+', title: 'Jobs done' });
  assertKeys('progress_bar', { title: 'Site prep', percent: 72, inner_text: 'nearly there' });
  // BOTH names, because the two widgets have different controls.
  assertKeys('star_rating', { rating_scale: 5, rating: 4.5, align: 'center', title: 'Reviews' });
  assertModernRatingKeys({ rating_scale: 5, rating: 4.5, align: 'center', stars_color: '#F59E0B' });
  assertKeys('progress_tracker', {
    type: 'circular', relative_to: 'selector', selector: '.entry', percentage: true,
    direction: 'rtl', percentage_position: 'rtl', align: 'center',
    horizontal_color_color: '#0C4A60', horizontal_background_color_color: '#E2E8F0',
    horizontal_height: 12, circular_size: 140, circular_width: 10,
    circular_color: '#0C4A60', circular_background_color: '#E2E8F0', percentage_color: '#475569',
  });
});

test('the thousand separator the old row dropped now reaches the page', () => {
  // The defect this row was moved to fix: the panel offers the switch, the
  // published page ignored it. ASSERT PRESENCE, both ways round.
  assert.equal(EMITTERS.counter.settings({ thousand_separator: false }).thousand_separator, '');
  assert.equal(EMITTERS.counter.settings({ thousand_separator: true }).thousand_separator, 'yes');
  // Absent means ON, because that is Elementor's own default and a stored
  // counter must not change the day we start sending the key.
  assert.equal(EMITTERS.counter.settings({}).thousand_separator, 'yes');
});

test('a percentage is a SLIDER, never a bare number', () => {
  // A bare number against a slider control is dropped by the page engine.
  assert.deepEqual(EMITTERS.progress_bar.settings({ percent: 72 }).percent,
    { unit: '%', size: 72, sizes: [] });
  assert.deepEqual(EMITTERS.progress_bar.settings({ percent: 999 }).percent,
    { unit: '%', size: 100, sizes: [] }, 'a percentage over 100 was passed straight through');
  assert.deepEqual(EMITTERS.progress_bar.settings({ percent: 'nonsense' }).percent,
    { unit: '%', size: 0, sizes: [] }, 'NaN reached a live page');
});

/* A site that TOLD US it registers the new name and not the old one. That is
   the presence test `reference_absence_based_guards_fail_open` asks for: a
   missing answer must not change what we publish. */
const MODERN_SITE = { seed: 't', siteWidgets: ['heading', 'rating'] };
const SILENT_SITE = { seed: 't' };

/** The modern half's keys, against the modern widget's own control list. */
function assertModernRatingKeys(props) {
  const widget = SETTINGS_KEYS.widgets.rating;
  assert.ok(widget && widget.keys.length, 'the machine file has no `rating` controls');
  const legal = new Set(widget.keys);
  const bad = Object.keys(EMITTERS.star_rating.settings(props, MODERN_SITE))
    .filter((k) => !legal.has(k));
  assert.deepEqual(bad, [], `star_rating → rating: keys the page engine does not have: ${bad.join(', ')}`);
}

test('a SILENT site still gets the name and the keys it has always got', () => {
  // The old row asked the right question. What it got wrong was the answer's
  // other half: it sent `star-rating`'s keys whichever widget it named.
  const { node } = resolveWidget('star_rating',
    { rating: 4, rating_scale: 5, title: 'Reviews' }, SILENT_SITE);
  assert.equal(node.widgetType, 'star-rating');
  assert.equal(node.settings.rating, 4);
  assert.equal(node.settings.rating_scale, '5');
  assert.equal(node.settings.title, 'Reviews', "the legacy widget's own title");
});

test('a site on the NEW widget gets the NEW keys — the defect this row fixes', () => {
  // MUTATION: make `settings` return legacyStars(p) unconditionally and this
  // goes red on rating_value; restored. Before the fix, every one of these
  // keys was dropped on publish and the page showed five empty stars.
  const { node } = resolveWidget('star_rating', { rating: 4, rating_scale: 5 }, MODERN_SITE);
  assert.equal(node.widgetType, 'rating');
  assert.deepEqual(node.settings.rating_scale, { unit: 'px', size: 5, sizes: [] });
  assert.equal(node.settings.rating_value, 4);
  assert.equal('rating' in node.settings, false, 'the old key rode along and is dropped');
});

test('ON THE NEW WIDGET A TITLE IS LOST, and this test says so out loud', () => {
  /* NOT a passing test dressed up as one. Elementor's `rating` has no Title
     control, and a row may not both build a tree and produce settings
     (`website-elementor-tree.test.mjs`: "exactly one of settings() and
     node()"), so there is nowhere on this widget for the author's words to
     go. This pins the CURRENT, honest behaviour so that whoever gives the
     panel a Heading + Rating section template has a test to turn green — and
     so that nobody reads the green suite as "the title survives". */
  const { node } = resolveWidget('star_rating',
    { rating: 5, title: 'What our customers say', align: 'center' }, MODERN_SITE);
  assert.equal(node.elType, 'widget');
  assert.equal(node.widgetType, 'rating');
  assert.equal('title' in node.settings, false,
    'if this is now true, the widget grew a title control and the handoff item is done');
  // The legacy widget, which is what client sites actually register, keeps it.
  const legacy = resolveWidget('star_rating',
    { rating: 5, title: 'What our customers say' }, SILENT_SITE).node;
  assert.equal(legacy.settings.title, 'What our customers say');
});

test('an empty colour is NOT published, so the site theme still wins', () => {
  assert.equal('icon_color' in EMITTERS.star_rating.settings({ rating: 3 }, MODERN_SITE), false);
  assert.equal(
    EMITTERS.star_rating.settings({ rating: 3, stars_color: '#F59E0B' }, MODERN_SITE).icon_color,
    '#F59E0B');
});

test('a tracker relative to the whole page never publishes a dead selector', () => {
  const whole = EMITTERS.progress_tracker.settings({ relative_to: 'entire_page', selector: '.left-over' });
  assert.equal('selector' in whole, false);
  const one = EMITTERS.progress_tracker.settings({ relative_to: 'selector', selector: '.entry' });
  assert.equal(one.selector, '.entry');
});

test('Progress Tracker is PAID, and refused by name where the plan has none', () => {
  assert.equal(ELEMENTOR_WIDGETS.progress_tracker.tier, 'pro');
  assert.throws(
    () => resolveWidget('progress_tracker', {}, { allowPro: false }),
    (e) => e.code === 'WIDGET_NOT_ON_PLAN',
    'a site without Pro published something instead of being told');
});

test('the family wins the spread — the old rows really were deleted', () => {
  for (const kind of Object.keys(EMITTERS)) {
    assert.equal(ELEMENTOR_WIDGETS[kind], EMITTERS[kind],
      `${kind}: elementorWidgets.js still has its own row and it overrides this family's`);
  }
});
