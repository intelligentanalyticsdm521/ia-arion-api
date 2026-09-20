// test/website-builder-f3-deep.test.js
//
// WAVE 2: the eight everyday widgets, and what each one really PUBLISHES.
//
// A settings key the page engine does not have is dropped silently, and a
// setting the emitter never writes is a control the author changed for nothing.
// Both of those were true here this morning:
//
//   · `divider`'s row was `settings: () => ({ style: 'solid' })` — it took no
//     props at all, so a divider's colour, weight, width, alignment and the
//     words in the middle of it never left the Portal;
//   · `button`'s row read `p.href`, a key the Portal has never written, so
//     every published button had an empty link;
//   · `spacer`'s row read `p.height`, the key our own definition stopped
//     writing at D-165;
//   · `icon_box` published `position: 'top'` and `title_size: 'h3'` as
//     CONSTANTS;
//   · `alert` read `p.dismissible`, which nothing stores.
//
// So every test below EXECUTES the emitter and reads the settings object back.
// Nothing here asserts that a row exists.
//
// `website-widget-map.test.mjs` already checks, for every row, that each key is
// a control the engine really has and that a select's value is one the control
// offers — against `test/fixtures/elementor-widget-controls.json`, machine-cut
// from the 2026-09-17 scrape of a real Elementor install. This file is the
// other half: that the author's value ARRIVES.
//
// ── MUTATIONS (run against the real source, seen red, restored) ─────────
//   · deep.js  pick(p,'link','url','href') → p.href
//        → "a button saved as label/url/colour publishes all three" RED. That
//          IS the old defect: every published button had an empty link.
//   · deep.js  the divider's weight → the literal slider(1)
//        → "divider · weight reaches the page" RED.
//   · deep.js  responsive() stops reading the _tablet and _mobile twins
//        → "a per-device value is published for the device it was set on" RED.
//   · deep.js  the spacer's pick(p,'space','height') → p.space
//        → "a spacer saved as height keeps its gap" RED.
//   · deep.js  the alert's show_dismiss default removed
//        → "an alert nobody has touched still shows its dismiss button" RED.
//   · deep.js  the legacy Outline skin removed
//        → "a button saved with the old Outline style publishes a border" RED.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { EMITTERS } from '../lib/websiteBuilder/families/f3-buttons-icons-panels/emitters.js';

const CTX = { seed: 'f3d', nodeId: 'f3d-1', allowPro: true };
const emit = (kind, props) => EMITTERS[kind].settings(props || {}, CTX);

const DEEP = ['button', 'icon', 'icon_box', 'list', 'social_links', 'alert', 'divider', 'spacer'];

/* ═══════════════════════════════════════════════════════════════════════════
   1. EVERY CONTROL REACHES THE PUBLISHED PAGE
   ═════════════════════════════════════════════════════════════════════════ */

/**
 * kind → { control: [what the author set, what must be published] }.
 *
 * The expectation is the VALUE, in the shape Elementor stores it: a slider is
 * `{ unit, size, sizes }`, a dimensions control is four sides, a switcher is
 * the string "yes". Asserting the shape as well as the number is the point —
 * a bare `18` where Elementor wants a slider is a setting the engine drops.
 */
const PUBLISHED = {
  button: {
    button_type: ['danger', 'danger'],
    text: ['Book a call', 'Book a call'],
    link: ['https://example.test/b', { url: 'https://example.test/b', is_external: '', nofollow: '' }],
    size: ['xl', 'xl'],
    icon_align: ['row-reverse', 'row-reverse'],
    icon_indent: [14, { unit: 'px', size: 14, sizes: [] }],
    align: ['justify', 'justify'],
    typography_font_size: [27, { unit: 'px', size: 27, sizes: [] }],
    typography_font_weight: ['800', '800'],
    typography_text_transform: ['uppercase', 'uppercase'],
    button_text_color: ['#112233', '#112233'],
    background_color: ['#445566', '#445566'],
    border_border: ['dashed', 'dashed'],
    border_width: [7, { unit: 'px', top: 7, right: 7, bottom: 7, left: 7, isLinked: true }],
    border_color: ['#778899', '#778899'],
    border_radius: [19, { unit: 'px', top: 19, right: 19, bottom: 19, left: 19, isLinked: true }],
    text_padding: [12, { unit: 'px', top: 12, right: 24, bottom: 12, left: 24, isLinked: false }],
    hover_color: ['#aabbcc', '#aabbcc'],
    button_background_hover_color: ['#ddeeff', '#ddeeff'],
  },
  icon: {
    view: ['framed', 'framed'],
    shape: ['square', 'square'],
    link: ['https://example.test/i', { url: 'https://example.test/i', is_external: '', nofollow: '' }],
    align: ['end', 'end'],
    primary_color: ['#123456', '#123456'],
    secondary_color: ['#654321', '#654321'],
    size: [64, { unit: 'px', size: 64, sizes: [] }],
    icon_padding: [33, { unit: 'px', size: 33, sizes: [] }],
    rotate: [45, { unit: 'deg', size: 45, sizes: [] }],
    border_width: [9, { unit: 'px', top: 9, right: 9, bottom: 9, left: 9, isLinked: true }],
  },
  icon_box: {
    view: ['stacked', 'stacked'],
    shape: ['square', 'square'],
    title_text: ['Fast response', 'Fast response'],
    description_text: ['Within one hour.', 'Within one hour.'],
    title_size: ['h1', 'h1'],
    position: ['inline-end', 'inline-end'],
    content_vertical_alignment: ['middle', 'middle'],
    text_align: ['end', 'end'],
    icon_space: [37, { unit: 'px', size: 37, sizes: [] }],
    title_bottom_space: [29, { unit: 'px', size: 29, sizes: [] }],
    primary_color: ['#0a0b0c', '#0a0b0c'],
    secondary_color: ['#0d0e0f', '#0d0e0f'],
    icon_size: [51, { unit: 'px', size: 51, sizes: [] }],
    rotate: [30, { unit: 'deg', size: 30, sizes: [] }],
    title_color: ['#abcdef', '#abcdef'],
    description_color: ['#fedcba', '#fedcba'],
  },
  list: {
    view: ['inline', 'inline'],
    link_click: ['inline', 'inline'],
    space_between: [17, { unit: 'px', size: 17, sizes: [] }],
    icon_align: ['center', 'center'],
    divider: [true, 'yes'],
    divider_style: ['dashed', 'dashed'],
    divider_weight: [5, { unit: 'px', size: 5, sizes: [] }],
    divider_color: ['#020304', '#020304'],
    icon_color: ['#050607', '#050607'],
    icon_size: [31, { unit: 'px', size: 31, sizes: [] }],
    text_indent: [23, { unit: 'px', size: 23, sizes: [] }],
    text_color: ['#080910', '#080910'],
  },
  social_links: {
    shape: ['square', 'square'],
    columns: ['3', '3'],
    align: ['right', 'right'],
    icon_color: ['custom', 'custom'],
    icon_primary_color: ['#101112', '#101112'],
    icon_secondary_color: ['#131415', '#131415'],
    icon_size: [26, { unit: 'px', size: 26, sizes: [] }],
    icon_spacing: [18, { unit: 'px', size: 18, sizes: [] }],
    row_gap: [22, { unit: 'px', size: 22, sizes: [] }],
    image_border_border: ['dotted', 'dotted'],
    image_border_color: ['#161718', '#161718'],
    hover_primary_color: ['#191a1b', '#191a1b'],
    hover_secondary_color: ['#1c1d1e', '#1c1d1e'],
  },
  alert: {
    alert_type: ['danger', 'danger'],
    alert_title: ['Mind the gap', 'Mind the gap'],
    alert_description: ['Wider than it looks', 'Wider than it looks'],
    background: ['#1f2021', '#1f2021'],
    border_color: ['#222324', '#222324'],
    'border_left-width': [12, { unit: 'px', size: 12, sizes: [] }],
    title_color: ['#252627', '#252627'],
    alert_title_font_size: [23, { unit: 'px', size: 23, sizes: [] }],
    alert_title_font_weight: ['300', '300'],
    description_color: ['#282930', '#282930'],
    alert_description_font_size: [11, { unit: 'px', size: 11, sizes: [] }],
    dismiss_icon_size: [28, { unit: 'px', size: 28, sizes: [] }],
    dismiss_icon_normal_color: ['#313233', '#313233'],
  },
  divider: {
    style: ['dashed', 'dashed'],
    width: [42, { unit: '%', size: 42, sizes: [] }],
    align: ['right', 'right'],
    look: ['line_text', 'line_text'],
    text: ['In between', 'In between'],
    html_tag: ['h4', 'h4'],
    color: ['#343536', '#343536'],
    weight: [8, { unit: 'px', size: 8, sizes: [] }],
    gap: [34, { unit: 'px', size: 34, sizes: [] }],
    text_color: ['#373839', '#373839'],
    typography_font_size: [26, { unit: 'px', size: 26, sizes: [] }],
    typography_font_weight: ['700', '700'],
    text_align: ['left', 'left'],
    text_spacing: [16, { unit: 'px', size: 16, sizes: [] }],
    icon_view: ['stacked', 'stacked'],
    icon_size: [40, { unit: 'px', size: 40, sizes: [] }],
    primary_color: ['#404142', '#404142'],
    icon_align: ['right', 'right'],
    icon_spacing: [24, { unit: 'px', size: 24, sizes: [] }],
  },
  spacer: {
    space: [123, { unit: 'px', size: 123, sizes: [] }],
  },
};

describe('the eight everyday widgets publish what the author set', () => {
  for (const kind of DEEP) {
    for (const [key, [set, expected]] of Object.entries(PUBLISHED[kind])) {
      test(`${kind} · ${key} reaches the page`, () => {
        const out = emit(kind, { [key]: set });
        assert.deepEqual(out[key], expected,
          `${kind}.${key}: the author set ${JSON.stringify(set)} and the page got ${JSON.stringify(out[key])}`);
      });
    }
  }

  test('…and a control nobody touched publishes nothing an author did not ask for', () => {
    /* Elementor's own rule: an empty slider size is the engine's default. A row
       that published a number here would override a theme's own styling with a
       value nobody chose, which is the other half of the same defect. */
    assert.equal(emit('button', {}).typography_font_size, undefined);
    assert.deepEqual(emit('icon', {}).size, undefined);
    assert.equal(emit('divider', {}).text_color, '');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. PER DEVICE
   ═════════════════════════════════════════════════════════════════════════ */

describe('a per-device value is published for the device it was set on', () => {
  test('the button’s Position, on all three screens', () => {
    const out = emit('button', { align: 'left', align_tablet: 'center', align_mobile: 'justify' });
    assert.equal(out.align, 'left');
    assert.equal(out.align_tablet, 'center');
    assert.equal(out.align_mobile, 'justify');
  });

  test('a screen the author never touched is LEFT OUT, so Elementor’s inheritance still works', () => {
    const out = emit('button', { align: 'center' });
    assert.equal(out.align, 'center');
    assert.ok(!('align_tablet' in out), 'an empty tablet twin would override the desktop value with nothing');
    assert.ok(!('align_mobile' in out));
  });

  test('a slider twin keeps its unit and its shape', () => {
    const out = emit('icon', { size: 40, size_mobile: 20 });
    assert.deepEqual(out.size, { unit: 'px', size: 40, sizes: [] });
    assert.deepEqual(out.size_mobile, { unit: 'px', size: 20, sizes: [] });
  });

  test('the spacer, whose ONE control is per-device', () => {
    const out = emit('spacer', { space: 80, space_tablet: 40, space_mobile: 20 });
    assert.deepEqual(out.space, { unit: 'px', size: 80, sizes: [] });
    assert.deepEqual(out.space_tablet, { unit: 'px', size: 40, sizes: [] });
    assert.deepEqual(out.space_mobile, { unit: 'px', size: 20, sizes: [] });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. A DOCUMENT SAVED BEFORE TODAY STILL PUBLISHES
   ═════════════════════════════════════════════════════════════════════════ */

describe('the stored props never moved, so an old page still publishes right', () => {
  test('a button saved as label/url/colour publishes all three', () => {
    const out = emit('button', { label: 'Accept', url: 'https://old.test/a', colour: '#FF00FF' });
    assert.equal(out.text, 'Accept');
    assert.equal(out.link.url, 'https://old.test/a');
    assert.equal(out.background_color, '#FF00FF');
  });

  test('a button saved with the old Outline style publishes a border, not a solid fill', () => {
    const out = emit('button', { label: 'Ask', style: 'outline' });
    assert.equal(out.border_border, 'solid');
    assert.deepEqual(out.border_width, { unit: 'px', top: 2, right: 2, bottom: 2, left: 2, isLinked: true });
  });

  test('a list saved as plain strings publishes every row', () => {
    const out = emit('list', { items: ['Alpha', 'Beta'] });
    assert.equal(out.icon_list.length, 2);
    assert.equal(out.icon_list[0].text, 'Alpha');
    assert.equal(out.icon_list[1].selected_icon.value, 'fas fa-check');
  });

  test('a list saved as Elementor’s repeater keeps each row’s own icon and link', () => {
    const out = emit('list', {
      icon_list: [{ text: 'Row', selected_icon: { value: 'fas fa-star', library: 'fa-solid' }, link: 'https://e.test/r' }],
    });
    assert.equal(out.icon_list[0].selected_icon.value, 'fas fa-star');
    assert.equal(out.icon_list[0].link.url, 'https://e.test/r');
  });

  test('a spacer saved as `height` keeps its gap', () => {
    assert.deepEqual(emit('spacer', { height: 96 }).space, { unit: 'px', size: 96, sizes: [] });
  });

  test('an icon box saved with the old top/left/right position publishes Elementor’s spelling', () => {
    assert.equal(emit('icon_box', { position: 'left' }).position, 'inline-start');
    assert.equal(emit('icon_box', { position: 'right' }).position, 'inline-end');
    assert.equal(emit('icon_box', { position: 'top' }).position, 'block-start');
  });

  test('an icon saved with the old left/right alignment publishes start/end', () => {
    assert.equal(emit('icon', { align: 'left' }).align, 'start');
    assert.equal(emit('icon', { align: 'right' }).align, 'end');
  });

  test('a social row saved as `links` still publishes its accounts', () => {
    const out = emit('social_links', { links: [{ social: 'youtube', link: 'https://old.test/y' }] });
    assert.equal(out.social_icon_list.length, 1);
    assert.equal(out.social_icon_list[0].social_icon.value, 'fab fa-youtube');
    assert.equal(out.social_icon_list[0].link.url, 'https://old.test/y');
  });

  test('a divider saved as `line` or `space_only` publishes what it meant', () => {
    assert.equal(emit('divider', { style: 'line' }).style, 'solid');
    assert.deepEqual(emit('divider', { style: 'space_only' }).weight, { unit: 'px', size: 0, sizes: [] });
  });

  test('an alert nobody has touched still shows its dismiss button, as Elementor’s does', () => {
    assert.equal(emit('alert', {}).show_dismiss, 'show');
    assert.equal(emit('alert', { show_dismiss: false }).show_dismiss, '');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. NOTHING MADE UP
   ═════════════════════════════════════════════════════════════════════════ */

describe('a value the control does not offer never reaches the page', () => {
  test('a select falls back to the engine’s own default, never the author’s string', () => {
    assert.equal(emit('button', { size: 'enormous' }).size, 'sm');
    assert.equal(emit('divider', { style: 'curly' }).style, 'solid');
    assert.equal(emit('icon', { view: 'glowing' }).view, 'default');
    assert.equal(emit('alert', { alert_type: 'panic' }).alert_type, 'info');
  });

  test('a colour that is not a colour is dropped rather than published broken', () => {
    assert.equal(emit('button', { background_color: 'javascript:alert(1)' }).background_color, '');
    assert.equal(emit('alert', { background: 'drop table' }).background, '');
  });

  test('a number that is not a number becomes the engine’s own empty slider', () => {
    assert.deepEqual(emit('icon', { size: 'big' }).size, { unit: 'px', size: '', sizes: [] });
    assert.deepEqual(emit('spacer', { space: 'lots' }).space, { unit: 'px', size: '', sizes: [] });
  });
});
