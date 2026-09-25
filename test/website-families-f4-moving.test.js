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
import { ELEMENTOR_WIDGETS, resolveWidget, shadowedLegacyKinds } from '../lib/websiteBuilder/elementorWidgets.js';

/* ONE copy of the machine truth. It lives in the Portal because that is where
   the catalogue was turned into a fixture; a second copy here is a second
   answer to "what keys does this widget have". */
const KEYS_CANDIDATES = [
  /* the served checkout, once b168/seams has landed on it */
  'Portal-septa',
  /* the seam's own worktree, and this family's, while the branch is in flight */
  'Portal-septa-b168s',
  'Portal-septa-b168f4',
  'Portal-septa-b168g4',
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

test('the family publishes six rows, each one a real Elementor widget', () => {
  assert.deepEqual(Object.keys(EMITTERS).sort(),
    ['accordion', 'counter', 'progress_bar', 'progress_tracker', 'star_rating', 'tabs']);
  for (const [kind, row] of Object.entries(EMITTERS)) {
    assert.ok(row.widgetType, `${kind}: no widgetType`);
    /* EXACTLY ONE of settings() and node(). A NESTED element (Tabs,
       Accordion) has to build its own tree, because its panels are child
       containers; everything else produces settings. A row with both has two
       answers and `website-elementor-tree.test.mjs` refuses it. */
    const two = [typeof row.settings === 'function', typeof row.node === 'function'];
    assert.equal(two.filter(Boolean).length, 1,
      `${kind}: a row has settings(props, ctx) OR node(props, ctx), never both and never neither`);
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

/* ══════════════════════════════════════════════════════════════════════════
   WAVE 2 (b168/f4-moving-deep, 2026-09-19)

   Five widgets went from thin to Elementor's own panel, so five emitters had
   to grow with them. Everything below EXECUTES the real row — nothing here
   reads source and agrees with it.
   ══════════════════════════════════════════════════════════════════════════ */

/** Every key a NESTED row's own widget node emits, checked like any other. */
function assertNodeKeys(kind, props, ctx = { seed: 'g4', nodeId: 'n1' }) {
  const row = EMITTERS[kind];
  assert.ok(row && typeof row.node === 'function', `${kind}: no node(props, ctx)`);
  const tree = row.node(props, ctx);
  assert.ok(tree, `${kind}: node() refused a widget that has panels`);
  const widget = SETTINGS_KEYS.widgets[row.widgetType];
  assert.ok(widget && widget.keys.length,
    `${row.widgetType}: the machine file reports no controls, so nothing can be checked`);
  const legal = new Set(widget.keys);
  const bad = Object.keys(tree.settings)
    .filter((k) => !legal.has(k) && !legal.has(k.replace(/_(tablet|mobile)$/, '')));
  assert.deepEqual(bad, [], `${kind} -> ${row.widgetType}: keys the page engine does not have, `
    + `so they are dropped on publish and the author's change does nothing: ${bad.join(', ')}`);
  return tree;
}

/* -- Counter ------------------------------------------------------------- */

test('every Style control the Counter panel offers reaches the page', () => {
  const out = EMITTERS.counter.settings({
    title_position: 'before', title_horizontal_alignment: 'left', number_alignment: 'right',
    title_gap: 6, number_color: '#0C4A60', typography_number_font_size: 40,
    typography_number_font_weight: '700', title_color: '#334155',
    typography_title_font_size: 14, typography_title_font_weight: '500',
    duration: 1500, thousand_separator_char: '.',
  });
  assert.equal(out.title_position, 'before');
  // OUR left/right become ELEMENTOR'S start/end. One translation, here.
  assert.equal(out.title_horizontal_alignment, 'start');
  assert.equal(out.number_alignment, 'end');
  assert.deepEqual(out.title_gap, { unit: 'px', size: 6, sizes: [] });
  assert.equal(out.number_color, '#0C4A60');
  assert.deepEqual(out.typography_number_font_size, { unit: 'px', size: 40, sizes: [] });
  assert.equal(out.typography_number_font_weight, '700');
  assert.equal(out.duration, 1500);
  assert.equal(out.thousand_separator_char, '.');
  assertKeys('counter', {
    title_position: 'before', title_horizontal_alignment: 'left', number_alignment: 'right',
    title_gap: 6, number_color: '#0C4A60', typography_number_font_size: 40,
    typography_number_font_weight: '700', title_color: '#334155',
    typography_title_font_size: 14, typography_title_font_weight: '500',
    duration: 1500, thousand_separator_char: '.',
  });
});

test('a typography SIZE without its popover toggle is a size the engine ignores', () => {
  /* MUTATION: drop the `typography` line out of typo() in emitters.js and this
     goes red - run 2026-09-19, then restored. Elementor's group control only
     applies a custom size when its own toggle says 'custom'. */
  const sized = EMITTERS.counter.settings({ typography_number_font_size: 40 });
  assert.equal(sized.typography_number_typography, 'custom');
  const bare = EMITTERS.counter.settings({});
  assert.equal('typography_number_typography' in bare, false,
    'a toggle published with nothing to toggle overrides the site theme with nothing');
  assert.equal('typography_number_font_size' in bare, false);
});

test('a Separator the control does not offer is never handed to the engine', () => {
  assert.equal(
    EMITTERS.counter.settings({ thousand_separator_char: 'sparkle' }).thousand_separator_char, '');
});

/* -- Progress Bar -------------------------------------------------------- */

test('every Style control the Progress Bar panel offers reaches the page', () => {
  const props = {
    percent: 72, title_color: '#334155', typography_font_size: 15, typography_font_weight: '600',
    bar_color: '#0C4A60', bar_bg_color: '#E2E8F0', bar_height: 18, bar_border_radius: 9,
    bar_inline_color: '#FFFFFF', bar_inner_typography_font_size: 11,
  };
  const out = EMITTERS.progress_bar.settings(props);
  assert.equal(out.bar_color, '#0C4A60');
  assert.equal(out.bar_bg_color, '#E2E8F0');
  assert.deepEqual(out.bar_height, { unit: 'px', size: 18, sizes: [] });
  assert.deepEqual(out.bar_border_radius, { unit: 'px', size: 9, sizes: [] });
  assert.equal(out.bar_inline_color, '#FFFFFF');
  assert.equal(out.typography_typography, 'custom');
  assert.equal(out.bar_inner_typography_typography, 'custom');
  assertKeys('progress_bar', props);
});

/* -- Rating -------------------------------------------------------------- */

test('the Rating panel Style controls reach BOTH widgets, under each widget keys', () => {
  const props = {
    rating_value: 4, rating_scale: 5, icon_color: '#F59E0B',
    icon_unmarked_color: '#E2E8F0', icon_size: 22, icon_gap: 4, rating_icon: 'eicon-star',
  };
  const modern = EMITTERS.star_rating.settings(props, MODERN_SITE);
  assert.equal(modern.icon_color, '#F59E0B');
  assert.equal(modern.icon_unmarked_color, '#E2E8F0');
  assert.deepEqual(modern.icon_size, { unit: 'px', size: 22, sizes: [] });
  assert.deepEqual(modern.icon_gap, { unit: 'px', size: 4, sizes: [] });
  assert.deepEqual(modern.rating_icon, { value: 'eicon-star', library: 'eicons' });
  assertModernRatingKeys(props);

  /* The SAME author settings, on a site that still has the old widget: the
     same four values under the old widget's own key names. Sending
     `icon_gap` there would be dropped in silence. */
  const legacy = EMITTERS.star_rating.settings(props, SILENT_SITE);
  assert.equal(legacy.stars_color, '#F59E0B');
  assert.equal(legacy.stars_unmarked_color, '#E2E8F0');
  assert.deepEqual(legacy.icon_space, { unit: 'px', size: 4, sizes: [] });
  assert.equal('icon_gap' in legacy, false);
  assertKeys('star_rating', props);
});

/* -- Tabs, as Elementor's NESTED widget ---------------------------------- */

const TWO_TABS = {
  tabs: [
    { tab_title: 'What we do', tab_content: 'We clear it before six.' },
    { tab_title: 'What it costs', tab_content: 'Per push, billed monthly.' },
  ],
};

test('Tabs publishes the REAL nested widget, with a container per panel', () => {
  /* The shape is not invented: it is a live capture of what Elementor's own
     editor wrote, 2026-09-19 -
     overnight-report/elementor-reference/widgets/_g4_nested_tree.json. */
  const tree = assertNodeKeys('tabs', TWO_TABS);
  assert.equal(tree.widgetType, 'nested-tabs', 'still publishing the deprecated widget');
  assert.deepEqual(tree.settings.tabs,
    [{ _id: 't0', tab_title: 'What we do' }, { _id: 't1', tab_title: 'What it costs' }]);
  assert.equal(tree.elements.length, 2, 'a nested tab with no container cannot be opened');
  for (const [i, boxNode] of tree.elements.entries()) {
    assert.equal(boxNode.elType, 'container');
    assert.equal(boxNode.settings.content_width, 'full');
    assert.equal(boxNode.settings._title, TWO_TABS.tabs[i].tab_title);
    assert.equal(boxNode.elements[0].widgetType, 'text-editor');
    assert.match(boxNode.elements[0].settings.editor, /clear it before six|billed monthly/);
  }
});

test('the words an author typed cannot become markup on a published page', () => {
  const tree = EMITTERS.tabs.node(
    { tabs: [{ tab_title: 'x', tab_content: '<script>steal()</script>' }] }, { nodeId: 'n' });
  assert.ok(!tree.elements[0].elements[0].settings.editor.includes('<script>'),
    'words an author typed reached a live page as markup');
});

test('every Style control the Tabs panel offers reaches the page', () => {
  const tree = assertNodeKeys('tabs', {
    ...TWO_TABS,
    tabs_direction: 'inline-end', tabs_justify_horizontal: 'center', tabs_width: 30,
    title_alignment: 'center', tabs_title_space_between: 8, tabs_title_spacing: 12,
    tabs_title_background_color_color: '#F1F5F9', tabs_title_border_color: '#CBD5E1',
    tabs_title_background_color_active_color: '#0C4A60',
    title_text_color: '#334155', title_text_color_active: '#0C4A60',
    title_typography_font_size: 16, title_typography_font_weight: '600',
    box_background_color_color: '#FFFFFF', box_border_color: '#E2E8F0', box_padding: 16,
  });
  const s = tree.settings;
  assert.equal(s.tabs_direction, 'inline-end');
  assert.deepEqual(s.tabs_width, { unit: '%', size: 30, sizes: [] });
  /* A BACKGROUND group only paints when its TYPE is classic, and a BORDER
     group only draws when its type is set. Sending the colour alone is the
     silent drop this whole pass is about. */
  assert.equal(s.tabs_title_background_color_background, 'classic');
  assert.equal(s.tabs_title_background_color_color, '#F1F5F9');
  assert.equal(s.tabs_title_border_border, 'solid');
  assert.equal(s.tabs_title_border_color, '#CBD5E1');
  assert.equal(s.box_border_border, 'solid');
  assert.deepEqual(s.box_padding,
    { unit: 'px', top: '16', right: '16', bottom: '16', left: '16', isLinked: true });
  assert.equal(s.title_typography_typography, 'custom');
});

test('a Direction the control does not offer is never handed to the engine', () => {
  assert.equal(
    EMITTERS.tabs.node({ ...TWO_TABS, tabs_direction: 'diagonal' }, {}).settings.tabs_direction,
    'block-start');
});

test('a Tabs with no tabs is REFUSED by name, not published as an empty strip', () => {
  assert.equal(EMITTERS.tabs.node({ tabs: [] }, {}), null);
  assert.throws(() => resolveWidget('tabs', { tabs: [] }, {}),
    (e) => e.code === 'WIDGET_NOT_ON_PLAN');
});

/* -- Accordion, as Elementor's NESTED widget ----------------------------- */

const TWO_ITEMS = {
  tabs: [
    { tab_title: 'Do you salt?', tab_content: 'Yes, and it is in the price.' },
    { tab_title: 'When do you come?', tab_content: 'Before six.' },
  ],
};

test('Accordion publishes the REAL nested widget, under Elementor own key names', () => {
  const tree = assertNodeKeys('accordion', TWO_ITEMS);
  assert.equal(tree.widgetType, 'nested-accordion');
  /* OUR stored key is `tabs`/`tab_title`. ELEMENTOR'S is `items`/`item_title`.
     The translation happens HERE and nowhere else, so the database keeps the
     id every stored page and shipped template carries. */
  assert.deepEqual(tree.settings.items,
    [{ _id: 'a0', item_title: 'Do you salt?' }, { _id: 'a1', item_title: 'When do you come?' }]);
  assert.equal('tabs' in tree.settings, false, 'our own key rode along to a widget without it');
  assert.equal(tree.elements.length, 2);
  assert.equal(tree.elements[0].settings._title, 'Do you salt?');
  assert.match(tree.elements[0].elements[0].settings.editor, /in the price/);
});

test('an accordion stored under the OLDER spelling still publishes its rows', () => {
  /* `items: [{ question, answer }]` is what the deleted legacy row read, and
     a page saved through it is still in the database. */
  const tree = EMITTERS.accordion.node(
    { items: [{ question: 'Do you salt?', answer: 'Yes.' }] }, { nodeId: 'n' });
  assert.deepEqual(tree.settings.items, [{ _id: 'a0', item_title: 'Do you salt?' }]);
  assert.match(tree.elements[0].elements[0].settings.editor, /Yes\./);
});

test('every Style control the Accordion panel offers reaches the page', () => {
  const tree = assertNodeKeys('accordion', {
    ...TWO_ITEMS,
    accordion_item_title_position_horizontal: 'left', accordion_item_title_icon_position: 'right',
    title_tag: 'h4', faq_schema: true, default_state: 'all_collapsed',
    accordion_item_title_space_between: 6, accordion_item_title_distance_from_content: 4,
    accordion_background_normal_color: '#FFFFFF', accordion_border_normal_color: '#E2E8F0',
    normal_title_color: '#334155', active_title_color: '#0C4A60',
    title_typography_font_size: 16, title_typography_font_weight: '600',
    normal_icon_color: '#64748B', icon_spacing: 10,
    content_background_color: '#F8FAFC', content_border_color: '#E2E8F0', content_padding: 12,
  });
  const s = tree.settings;
  assert.equal(s.accordion_item_title_position_horizontal, 'start');
  assert.equal(s.accordion_item_title_icon_position, 'end');
  assert.equal(s.title_tag, 'h4');
  assert.equal(s.faq_schema, 'yes');
  assert.equal(s.default_state, 'all_collapsed');
  assert.equal(s.accordion_background_normal_background, 'classic');
  assert.equal(s.accordion_border_normal_border, 'solid');
  assert.equal(s.content_background_background, 'classic');
  assert.deepEqual(s.content_padding,
    { unit: 'px', top: '12', right: '12', bottom: '12', left: '12', isLinked: true });
  assert.equal(s.normal_icon_color, '#64748B');
});

test('an Accordion with no rows is REFUSED by name', () => {
  assert.equal(EMITTERS.accordion.node({}, {}), null);
});

test('the DEPRECATED widgets are gone from the catalogue for good', () => {
  /* In the live editor `tabs` and `accordion` are both `show_in_panel: false`
     - nobody can add either one any more. We were publishing them. The rows
     were DELETED from elementorWidgets.js in the same pass rather than left
     to be shadowed, and this is what says so. */
  assert.equal(ELEMENTOR_WIDGETS.tabs.widgetType, 'nested-tabs');
  assert.equal(ELEMENTOR_WIDGETS.accordion.widgetType, 'nested-accordion');
  for (const kind of ['tabs', 'accordion']) {
    assert.equal(typeof ELEMENTOR_WIDGETS[kind].settings, 'undefined',
      `${kind} still has a flat settings() - the deprecated row came back`);
  }
  /* AND THE ROW IS REALLY GONE FROM THE FILE, not merely out-ranked.
     `mergeEmitters` makes the family win, so the two assertions above stay
     green even with the old row back in elementorWidgets.js - measured, on
     2026-09-19, by putting it back and watching this test pass. A row left
     behind is a second answer waiting for the next merge to reorder, and
     `shadowedLegacyKinds()` is the lander's own delete list, so asking it is
     the guard that actually guards. */
  assert.deepEqual(shadowedLegacyKinds().filter((k) => k === 'tabs' || k === 'accordion'), [],
    'the deprecated row is still in elementorWidgets.js - delete it, do not let the merge hide it');
});
