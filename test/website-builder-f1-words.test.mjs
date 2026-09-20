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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEYS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'f1-words-settings-keys.json'), 'utf8'));

const KINDS = [
  'blockquote', 'animated_headline', 'text_path', 'table_of_contents',
  'code_highlight', 'read_more', 'sidebar',
];

/** Every key, including the ones nested under a group control's own prefix. */
function keysOf(settings) {
  return Object.keys(settings || {});
}

test('the family publishes the seven widgets it builds, and only those', () => {
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
