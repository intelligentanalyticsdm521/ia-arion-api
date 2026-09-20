// test/website-builder-f1-words.test.mjs — what the f1-words family PUBLISHES.
//
// BUILDER_FULL_WIDGET_PLAN_2026-09-19 §C.1 step 4 and step 7. The family test
// on this side asks two things, and both of them are about a live website:
//
//   1. every row is a real Elementor widget, by Elementor's own slug;
//   2. every SETTINGS KEY an emitter produces exists on that widget. A key the
//      page engine does not have is dropped silently on publish — the author
//      changes a colour, the toast says Published, and the live page does not
//      move. That is `reference_catch_swallow_report_success` wearing a
//      different hat, and it is the one failure this file exists to stop.
//
// The key lists are machine-cut from BUILDER_WIDGET_CATALOG_2026-09-17.pro.json
// into test/fixtures/f1-words-settings-keys.json — a copy of the scrape, not a
// hand-written list, so nobody can widen it by typing.
//
// ── MUTATION CHECK (run, not assumed) ──────────────────────────────────────
// 2026-09-19: added `blockquote_colour: ''` to the blockquote emitter →
// "every key an emitter publishes is a key the widget has" went red naming
// `blockquote_colour`; removed it → green. Changed `read-more`'s widgetType to
// `read_more` → "every row publishes a real Elementor widget" went red; put it
// back → green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMITTERS, choice, slider, switchOn } from '../lib/websiteBuilder/families/f1-words/emitters.js';
import { FAMILY_EMITTERS, FAMILY_OF_KIND } from '../lib/websiteBuilder/families/index.js';
import { ELEMENTOR_WIDGETS, FREE, PRO } from '../lib/websiteBuilder/elementorWidgets.js';
import { SETTINGS_NOT_CONTROLS } from './fixtures/widget-controls-input.mjs';
import { NODE_MARKER } from '../lib/websiteBuilder/elementorTree.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEYS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'f1-words-settings-keys.json'), 'utf8'));

/* TWELVE since wave 2. `heading`, `paragraph`, `html`, `shortcode` and
   `menu_anchor` had rows in `elementorWidgets.js` publishing one to three
   settings each, and `menu_anchor` had no row at all when wave 1 looked.
   `mergeEmitters(FAMILY_EMITTERS, LEGACY_WIDGETS)` gives the family's row the
   page; `shadowedLegacyKinds()` prints the leftovers for the lander. */
const KINDS = [
  'heading', 'paragraph', 'html', 'shortcode', 'menu_anchor',
  'blockquote', 'animated_headline', 'text_path', 'table_of_contents',
  'code_highlight', 'read_more', 'sidebar',
];

/** Every key, including the ones nested under a group control's own prefix. */
function keysOf(settings) {
  return Object.keys(settings || {});
}

test('the family publishes the twelve widgets it builds, and only those', () => {
  assert.deepEqual(Object.keys(EMITTERS).sort(), [...KINDS].sort());
});

test('every kind reaches the one index, from this folder', () => {
  for (const kind of KINDS) {
    assert.equal(FAMILY_OF_KIND[kind], 'f1-words', kind);
    assert.equal(FAMILY_EMITTERS[kind], EMITTERS[kind], kind);
    assert.equal(ELEMENTOR_WIDGETS[kind], EMITTERS[kind], `${kind} is not spread into the catalogue`);
  }
});

test('every row publishes a real Elementor widget, by Elementor\'s own slug', () => {
  for (const [kind, row] of Object.entries(EMITTERS)) {
    assert.ok(KEYS.widgets[row.widgetType],
      `${kind}: "${row.widgetType}" is not a widget in the 2026-09-17 catalogue`);
  }
});

test('the tier words are the catalogue\'s own two, so a rename cannot drift', () => {
  assert.equal(FREE, 'free');
  assert.equal(PRO, 'pro');
  const tiers = Object.fromEntries(Object.entries(EMITTERS).map(([k, r]) => [k, r.tier]));
  assert.deepEqual(tiers, {
    heading: FREE,
    paragraph: FREE,
    html: FREE,
    shortcode: FREE,
    menu_anchor: FREE,
    blockquote: PRO,
    animated_headline: PRO,
    text_path: FREE,
    table_of_contents: PRO,
    code_highlight: PRO,
    read_more: FREE,
    sidebar: FREE,
  });
});

/**
 * THE ONE THAT MATTERS: every key, on real props AND on empty ones.
 *
 * Both, because an emitter that only behaves when the author filled every field
 * is an emitter that breaks on the first widget somebody drops and does not
 * touch.
 */
const FILLED = {
  blockquote: {
    blockquote_skin: 'boxed', blockquote_content: 'They showed up on time.', author_name: 'A. Customer',
    alignment: 'center', content_text_color: '#111111', author_text_color: '#666666',
    border_color: '#0C4A60', border_width: 4, box_background_color: '#F8FAFC', box_padding: 20,
    quote_text_color: '#0C4A60', quote_size: 40,
  },
  animated_headline: {
    headline_style: 'rotate', animation_type: 'slide', marker: 'underline',
    before_text: 'Our work is', highlighted_text: 'Reliable', rotating_text: 'Better\nBigger',
    after_text: 'every week', loop: true, link: 'https://example.test/x', tag: 'h2',
  },
  text_path: {
    text: 'Summit season', path: 'arc', custom_path: '', link: 'https://example.test/y',
    align: 'center', text_path_direction: 'ltr', show_path: true, size: 480, start_point: 10,
    text_color_normal: '#111111', path_fill_normal: 'none',
    stroke_color_normal: '#E8178A', stroke_width_normal: 2,
  },
  table_of_contents: {
    title: 'On this page', html_tag: 'h3', headings_by_tags: ['h2', 'h3'], marker_view: 'bullets',
    no_headings_message: 'Nothing yet.', word_wrap: true, minimize_box: true, minimized_on: 'mobile',
    hierarchical_view: true, collapse_subitems: false,
    background_color: '#FFFFFF', border_color: '#E2E8F0', border_width: 1,
  },
  code_highlight: {
    language: 'php', code: '<?php echo 1;', line_numbers: true, copy_to_clipboard: true,
    highlight_lines: '2,5-7', word_wrap: true, theme: 'dark', font_size: 14,
  },
  read_more: { link_text: 'Read the rest' },
  sidebar: { sidebar: 'sidebar-1' },
  /* Wave 2 — every control the rebuilt panel offers, filled, because the whole
     point of this check is that a key the page engine does not have is dropped
     silently and the author's change does nothing on the live page. */
  heading: {
    text: 'Winter is coming', header_size: 'h1', size: 'xl', link: 'https://example.test/x',
    align: 'center', align_tablet: 'start', align_mobile: 'end',
    title_color: '#B45309', title_hover_color: '#0EA5E9', title_hover_color_transition_duration: 0.3,
    typography_text_transform: 'uppercase', typography_font_style: 'italic',
    typography_text_decoration: 'underline', typography_word_spacing: 4,
    text_stroke_text_stroke: 2, text_stroke_stroke_color: '#123456',
    text_shadow_text_shadow_horizontal: 3, text_shadow_text_shadow_vertical: 4,
    text_shadow_text_shadow_blur: 6, text_shadow_text_shadow_color: '#0F172A',
    blend_mode: 'multiply',
  },
  paragraph: {
    text: 'We cleared forty lots this week.',
    align: 'center', align_tablet: 'start', text_color: '#111111',
    text_columns: '2', text_columns_mobile: '1', column_gap: 24, paragraph_spacing: 20,
    link_color: '#0EA5E9', link_hover_color: '#1D4ED8', link_hover_color_transition_duration: 0.2,
    typography_text_transform: 'capitalize', typography_font_style: 'italic',
    typography_text_decoration: 'none', typography_word_spacing: 3,
    text_shadow_text_shadow_blur: 8,
    drop_cap: 'yes', drop_cap_view: 'framed', drop_cap_primary_color: '#B45309',
    drop_cap_secondary_color: '#0F172A', drop_cap_size: 5, drop_cap_space: 12,
    drop_cap_border_radius: 40, drop_cap_border_width: 3,
    drop_cap_typography_text_transform: 'uppercase', drop_cap_typography_font_style: 'italic',
  },
  html: { html: '<p style="margin:0">Mine</p>' },
  shortcode: { shortcode: '[ia_book_now]' },
  menu_anchor: { anchor: 'our prices#' },
};

test('every key an emitter publishes is a key the widget has', () => {
  for (const [kind, row] of Object.entries(EMITTERS)) {
    const legal = new Set(KEYS.widgets[row.widgetType].keys);
    for (const props of [FILLED[kind], {}, undefined]) {
      const bad = keysOf(row.settings(props || {}, {})).filter((k) => {
        if (legal.has(k)) return false;
        return !legal.has(k.replace(/_(tablet|mobile)$/, ''));
      });
      assert.deepEqual(bad, [],
        `${kind} → ${row.widgetType}: the page engine has no ${bad.join(', ')}, so it is dropped `
        + 'on publish and the author\'s change does nothing on the live page');
    }
  }
});

test('no emitter throws on a widget nobody filled in', () => {
  for (const [kind, row] of Object.entries(EMITTERS)) {
    assert.doesNotThrow(() => row.settings({}, {}), kind);
    assert.doesNotThrow(() => row.settings(undefined || {}, undefined), kind);
  }
});

/* ── The words themselves reach the page ───────────────────────────────── */

test('the blockquote carries the quote, the author and the skin', () => {
  const s = EMITTERS.blockquote.settings(FILLED.blockquote, {});
  assert.equal(s.blockquote_content, 'They showed up on time.');
  assert.equal(s.author_name, 'A. Customer');
  assert.equal(s.blockquote_skin, 'boxed');
});

test('the blockquote NEVER publishes a tweet button', () => {
  const s = EMITTERS.blockquote.settings({ ...FILLED.blockquote, tweet_button: 'yes' }, {});
  assert.equal('tweet_button' in s, false, 'a tweet button reached a client\'s live page');
  assert.equal(JSON.stringify(s).toLowerCase().includes('tweet'), false);
});

test('a testimonial\'s spelling publishes too, so converting one loses nothing', () => {
  const s = EMITTERS.blockquote.settings({ quote: 'Tidy work.', attribution: 'R. Smith' }, {});
  assert.equal(s.blockquote_content, 'Tidy work.');
  assert.equal(s.author_name, 'R. Smith');
});

test('an unknown skin publishes Elementor\'s own default, never the author\'s typo', () => {
  assert.equal(EMITTERS.blockquote.settings({ blockquote_skin: 'sparkle' }, {}).blockquote_skin, 'border');
  assert.equal(EMITTERS.animated_headline.settings({ tag: 'marquee' }, {}).tag, 'h3');
  assert.equal(EMITTERS.text_path.settings({ path: 'zigzag' }, {}).path, 'wave');
  assert.equal(EMITTERS.code_highlight.settings({ theme: 'neon' }, {}).theme, 'default');
  assert.equal(EMITTERS.table_of_contents.settings({ minimized_on: 'watch' }, {}).minimized_on, 'tablet');
});

test('a switch publishes the return value when on and nothing when off', () => {
  const on = EMITTERS.code_highlight.settings({ line_numbers: true, copy_to_clipboard: true }, {});
  assert.equal(on.line_numbers, 'line-numbers');
  assert.equal(on.copy_to_clipboard, 'copy-to-clipboard');
  const off = EMITTERS.code_highlight.settings({ line_numbers: false, copy_to_clipboard: false }, {});
  assert.equal(off.line_numbers, '');
  assert.equal(off.copy_to_clipboard, '');
  assert.equal(switchOn(true), 'yes');
  assert.equal(switchOn(''), '');
});

test('a slider publishes Elementor\'s own shape, and an empty size when nobody set one', () => {
  assert.deepEqual(slider(4), { unit: 'px', size: 4, sizes: [] });
  assert.deepEqual(slider(''), { unit: 'px', size: '', sizes: [] });
  assert.deepEqual(slider(10, '%'), { unit: '%', size: 10, sizes: [] });
});

test('the contents widget publishes WHICH heading sizes to look for, never our own list', () => {
  const s = EMITTERS.table_of_contents.settings({ headings_by_tags: ['h2', 'H3', 'div', 'nonsense'] }, {});
  assert.deepEqual(s.headings_by_tags, ['h2', 'h3']);
  assert.deepEqual(EMITTERS.table_of_contents.settings({}, {}).headings_by_tags, ['h2', 'h3', 'h4', 'h5', 'h6']);
  assert.equal('entries' in s, false, 'the emitter published a list the page must find for itself');
});

test('choice refuses a value the engine would ignore', () => {
  assert.equal(choice('x', ['a', 'b'], 'a'), 'a');
  assert.equal(choice('b', ['a', 'b'], 'a'), 'b');
});

/* ══════════════════════════════════════════════════════════════════════════
   WAVE 2 — the five everyday widgets, published
   ══════════════════════════════════════════════════════════════════════════

   The key check above says a key is LEGAL. These say the right key carries the
   right value, because a heading that publishes `header_size: 'h2'` when the
   author chose H1 passes a key check and is wrong on the page. */

const settingsOf = (kind, props) => EMITTERS[kind].settings(props || {}, {});

test('wave 2: a widget nobody touched publishes almost nothing', () => {
  /* Elementor treats a missing key and an empty one the same way, and forty
     empty keys per heading is forty rows of `_elementor_data` a person reading
     it has to skip. */
  assert.deepEqual(settingsOf('heading', {}), { title: '', header_size: 'h2' });
  assert.deepEqual(settingsOf('paragraph', {}), { editor: '<p></p>' });
  assert.deepEqual(settingsOf('html', {}), { html: '' });
  assert.deepEqual(settingsOf('shortcode', {}), { shortcode: '' });
  assert.deepEqual(settingsOf('menu_anchor', {}), { anchor: '' });
});

test('Heading publishes the words and the tag from EITHER spelling', () => {
  assert.equal(settingsOf('heading', { text: 'Stored' }).title, 'Stored');
  assert.equal(settingsOf('heading', { title: 'Elementor' }).title, 'Elementor');
  assert.equal(settingsOf('heading', { text: 'Stored', title: 'Elementor' }).title, 'Stored');
  assert.equal(settingsOf('heading', { header_size: 'h4' }).header_size, 'h4');
  assert.equal(settingsOf('heading', { level: 'Page title' }).header_size, 'h1');
  assert.equal(settingsOf('heading', { level: 'Sub-section' }).header_size, 'h3');
  assert.equal(settingsOf('heading', { header_size: 'nonsense' }).header_size, 'h2');
});

test('Heading: every Style control reaches the page under Elementor\'s own key', () => {
  const s = settingsOf('heading', FILLED.heading);
  assert.equal(s.size, 'xl');
  assert.deepEqual(s.link, { url: 'https://example.test/x', is_external: '', nofollow: '' });
  assert.equal(s.align, 'center');
  assert.equal(s.align_tablet, 'start');
  assert.equal(s.align_mobile, 'end');
  assert.equal(s.title_color, '#B45309');
  assert.equal(s.title_hover_color, '#0EA5E9');
  assert.deepEqual(s.title_hover_color_transition_duration, { unit: 's', size: 0.3, sizes: [] });
  assert.equal(s.blend_mode, 'multiply');
  /* The popover toggles. Without them Elementor writes no CSS for the group at
     all, so the author's Transform would publish and never paint. */
  assert.equal(s.typography_typography, 'custom');
  assert.equal(s.typography_text_transform, 'uppercase');
  assert.equal(s.typography_font_style, 'italic');
  assert.equal(s.typography_text_decoration, 'underline');
  assert.deepEqual(s.typography_word_spacing, { unit: 'px', size: 4, sizes: [] });
  assert.equal(s.text_stroke_text_stroke_type, 'yes');
  assert.deepEqual(s.text_stroke_text_stroke, { unit: 'px', size: 2, sizes: [] });
  assert.equal(s.text_stroke_stroke_color, '#123456');
  assert.equal(s.text_shadow_text_shadow_type, 'yes');
  assert.deepEqual(s.text_shadow_text_shadow,
    { horizontal: 3, vertical: 4, blur: 6, color: '#0F172A' });
});

test('four plain boxes become the ONE key Elementor has for a text shadow', () => {
  /* A key Elementor does not have is dropped on publish, so the four controls
     the panel draws cannot be published as four keys. This is the only place
     they are put back together. */
  const s = settingsOf('heading', { text: 'x', text_shadow_text_shadow_blur: 9 });
  assert.deepEqual(s.text_shadow_text_shadow, { horizontal: 0, vertical: 0, blur: 9, color: 'rgba(0,0,0,0.3)' });
  assert.equal('text_shadow_text_shadow_blur' in s, false, 'a key the engine has no control for');
  // …and an untouched shadow publishes nothing at all.
  assert.equal('text_shadow_text_shadow' in settingsOf('heading', { text: 'x' }), false);
});

test('Text Editor publishes the words, the columns and the whole Drop Cap', () => {
  const s = settingsOf('paragraph', FILLED.paragraph);
  assert.equal(s.editor, '<p>We cleared forty lots this week.</p>');
  assert.equal(s.align, 'center');
  assert.equal(s.text_columns, '2');
  assert.equal(s.text_columns_mobile, '1');
  assert.deepEqual(s.column_gap, { unit: 'px', size: 24, sizes: [] });
  assert.deepEqual(s.paragraph_spacing, { unit: 'px', size: 20, sizes: [] });
  assert.equal(s.text_color, '#111111');
  assert.equal(s.link_color, '#0EA5E9');
  assert.equal(s.link_hover_color, '#1D4ED8');
  assert.equal(s.drop_cap, 'yes');
  assert.equal(s.drop_cap_view, 'framed');
  assert.equal(s.drop_cap_primary_color, '#B45309');
  assert.deepEqual(s.drop_cap_size, { unit: 'px', size: 5, sizes: [] });
  assert.deepEqual(s.drop_cap_border_radius, { unit: '%', size: 40, sizes: [] });
  assert.equal(s.drop_cap_border_width.isLinked, true);
  assert.equal(s.drop_cap_border_width.top, '3');
  assert.equal(s.drop_cap_typography_typography, 'custom');
  assert.equal(s.drop_cap_typography_text_transform, 'uppercase');
});

test('the Drop Cap section is not published when the drop cap is off', () => {
  /* Styling a letter nobody can see is how an author turns the cap on a month
     later and finds it in last month's colour. */
  const s = settingsOf('paragraph', {
    text: 'x', drop_cap_view: 'stacked', drop_cap_primary_color: '#B45309',
  });
  assert.equal('drop_cap_view' in s, false);
  assert.equal('drop_cap_primary_color' in s, false);
  assert.equal('drop_cap' in s, false);
});

test('Text Editor keeps markup an author already wrote', () => {
  // A page read back out of WordPress carries `editor` full of real markup.
  assert.equal(settingsOf('paragraph', { editor: '<p>Kept <strong>bold</strong>.</p>' }).editor,
    '<p>Kept <strong>bold</strong>.</p>');
  // …and plain words become a paragraph, escaped, exactly as the legacy row did.
  assert.equal(settingsOf('paragraph', { text: 'a & b' }).editor, '<p>a &amp; b</p>');
});

test('HTML publishes the markup untouched, from either key', () => {
  assert.equal(settingsOf('html', { html: '<p>a & b</p>' }).html, '<p>a & b</p>');
  assert.equal(settingsOf('html', { code: '<b>x</b>' }).html, '<b>x</b>');
});

test('Menu Anchor can be published at all, and its id is one a link can reach', () => {
  /* Wave 1: "no arion emitter at all - it is on the panel and cannot be
     published". The marker is invisible, so an id with a space in it is a menu
     link that goes nowhere and an author who never finds out why. */
  assert.equal(settingsOf('menu_anchor', { anchor: 'prices' }).anchor, 'prices');
  assert.equal(settingsOf('menu_anchor', { anchor: 'our prices#' }).anchor, 'ourprices');
});

test('Shortcode publishes the code exactly as typed', () => {
  assert.equal(settingsOf('shortcode', { shortcode: '[ia_book_now]' }).shortcode, '[ia_book_now]');
});

/* ══════════════════════════════════════════════════════════════════════════
   THE REAL PUBLISH PATH, executed
   ══════════════════════════════════════════════════════════════════════════

   The tests above call one emitter at a time. This runs the whole route a
   Publish press takes — `documentToTree` then `pageToElementor` — over a page
   holding all twelve of this family's widgets, and reads the nodes back. It is
   the same question a real publish to a dev WordPress answers, without needing
   one, and it is the question the key check cannot ask: whether the widget
   survives the tree at all. */

test('EXECUTED: a page holding all twelve publishes as twelve Elementor widgets', async () => {
  const { documentToTree, pageToElementor } = await import('../lib/websiteBuilder/elementorTree.js');
  const doc = {
    sections: [{
      id: 's1', label: 'Everything', layout: 1,
      columns: [{ id: 'c1', widgets: KINDS.map((kind, i) => ({ id: `w${i}`, kind, props: FILLED[kind] || {} })) }],
    }],
  };
  const { data } = pageToElementor(documentToTree(doc), {});
  const found = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.elType === 'widget') found.push(n);
    (n.elements || []).forEach(walk);
  };
  data.forEach(walk);

  const byType = Object.fromEntries(found.map((n) => [n.widgetType, n.settings || {}]));
  for (const kind of KINDS) {
    const wanted = EMITTERS[kind].widgetType;
    assert.ok(byType[wanted], `${kind} did not reach the page as ${wanted}`);
  }

  // …and every key that arrived is a key the page engine has.
  for (const [widgetType, settings] of Object.entries(byType)) {
    const pin = KEYS.widgets[widgetType];
    if (!pin) continue;
    const legal = new Set(pin.keys);
    const bad = Object.keys(settings).filter((k) => {
      if (legal.has(k)) return false;
      if (legal.has(k.replace(/_(tablet|mobile)$/, ''))) return false;
      /* The TREE's own bookkeeping, not a widget control: `_ia_widget` and
         `_ia_node` are how a published page is read back as our document
         (`elementorToTree`), and `SETTINGS_NOT_CONTROLS` in
         test/fixtures/widget-controls-input.mjs is the one list that names
         them. Read from there rather than typed again here. */
      return !SETTINGS_NOT_CONTROLS.includes(k) && k !== NODE_MARKER;
    });
    assert.deepEqual(bad, [], `${widgetType} published ${bad.join(', ')}`);
  }

  // The three that carry the author's actual words, read back off the page.
  assert.equal(byType.heading.title, 'Winter is coming');
  assert.equal(byType.heading.header_size, 'h1');
  assert.equal(byType['text-editor'].drop_cap, 'yes');
  assert.equal(byType.html.html, '<p style="margin:0">Mine</p>');
  assert.equal(byType.shortcode.shortcode, '[ia_book_now]');
  assert.equal(byType['menu-anchor'].anchor, 'ourprices');
  // The tweet button wave 1 refused is still nowhere on the page.
  assert.equal(/tweet/i.test(JSON.stringify(data)), false);
});
