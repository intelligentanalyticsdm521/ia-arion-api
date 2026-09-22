/**
 * DOES A CONTROL WE OFFER DO, ON THE LIVE PAGE, WHAT ELEMENTOR'S DOES?
 * ---------------------------------------------------------------------------
 * Brandon: *"making sure the edits actually do what they need to in
 * Elementor."* A read-only scorer answered it on 2026-09-22 and the answer was
 * 42.8% — 125 rows, 52 of them WRONG: a control that did something on our
 * canvas and nothing at all on the published page
 * (`overnight-report/BUILDER_WEBSITE_FUNCTIONAL_PARITY_2026-09-22.md`).
 *
 * Forty of the 52 were ONE routing decision. `buildContentWidget` read
 *
 *     if (!CONTENT_BLOCK_KINDS[raw] && ELEMENTOR_WIDGETS[canonicalKind(raw)])
 *
 * so Heading, Text Editor, Button, Image, Divider and Spacer — the six every
 * page is made of — went AWAY from their family emitter and into a nine-row
 * codec that publishes three or four fields each. Divider's is `fields: {}`.
 *
 * Every row below is one of that sheet's rows, asserted on the settings this
 * server actually publishes. Where the fix was in a family file the row names
 * it, because the next person to read the sheet needs to find the code.
 *
 * ── DRIVEN, NOT ONLY ASSERTED ─────────────────────────────────────────────
 * The same six widgets, the same container and the same 33/33/33 structure
 * were published to the dev WordPress (localhost:8084) and read back with
 * `getComputedStyle` at 1440 and 375: an H1 stays an h1 at 44px/800 in
 * rgb(192,57,43); a dashed 6px divider in rgb(142,68,173); a Spacer 77px wide
 * and 20px on a phone; a container 420px tall in rgb(234,244,239); three cells
 * side by side at 1440 and stacked at 375. 14 of 14.
 *
 * ── MUTATIONS (each applied, seen red, restored) ──────────────────────────
 *  M1  put the `!` back in `buildContentWidget`'s emitter branch
 *        → "the six everyday widgets go through their emitter" red.
 *  M2  `headingTag`: drop the "a tag under `level` is a tag" branch
 *        → "an H1 stays an h1" red.
 *  M3  `applySectionStyle`: delete `typography_typography` again when the
 *      heading font is empty
 *        → "the heading font control owns the font family alone" red.
 *  M4  `withColumnWidths`: return the kids untouched
 *        → "the structure the author picked publishes as columns" red.
 *  M5  `html()`: drop the array branch
 *        → "a Text Editor's paragraphs publish as paragraphs" red.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyFields, applySectionStyle, buildContentWidget, extractFields,
} from '../lib/websiteBuilder/sectionSchema.js';
import { ELEMENTOR_WIDGETS } from '../lib/websiteBuilder/elementorWidgets.js';

const CTX = { allowPro: true, iaWidgets: null, emailTo: 'hello@fernbrook.test' };

const emptySection = () => ({
  id: 'sec', elType: 'container',
  settings: { _title: 'ia:content:scratch:blk', _ia_field_section: 'content.blocks' },
  elements: [],
});

/** Publish one block and hand back the node it became. */
function publish(block, section = emptySection()) {
  const out = applyFields(section, 'content', { layout: 1, blocks: [{ col: 0, ...block }] }, CTX);
  let found = null;
  const walk = (n) => {
    if (n.elType === 'widget' && !found) found = n;
    (n.elements || []).forEach(walk);
  };
  (out.elements || []).forEach(walk);
  return found;
}

/* ══════════════════════════════════════════════════════════════════════════
   W-1 · THE ROOT CAUSE — the six everyday widgets reach their emitter
   ══════════════════════════════════════════════════════════════════════════ */

describe('W-1 · the six everyday widgets go through their emitter', () => {
  test('a kind ANYTHING can emit is built by the emitter, not by the codec', () => {
    /* ONE KEY PER WIDGET THAT THE CODEC CANNOT PUBLISH. Its table names three
       or four fields each (`heading`: text, level, align) and `divider`'s is
       `fields: {}`; none of the keys below is in it, so each one is proof the
       emitter ran. A count would pass the day somebody widened the codec. */
    for (const [kind, block, key] of [
      ['heading', { kind: 'heading', text: 'H', title_color: '#c0392b' }, 'title_color'],
      ['paragraph', { kind: 'paragraph', text: ['P'], text_color: '#1d4e89' }, 'text_color'],
      ['button', { kind: 'button', label: 'B', background_color: '#0b6e4f' }, 'background_color'],
      ['image', { kind: 'image', url: 'http://x/i.png', image_border_border: 'solid' }, 'image_border_border'],
      ['divider', { kind: 'divider', style: 'dashed', weight: 6 }, 'weight'],
      ['spacer', { kind: 'spacer', space: 77, space_mobile: 20 }, 'space_mobile'],
    ]) {
      const s = publish(block).settings;
      assert.ok(key in s, `${kind} did not publish ${key} — it went through the codec, not its emitter`);
    }
  });

  test('W-m..W-q · a Heading publishes its whole Style tab', () => {
    const s = publish({
      kind: 'heading', text: 'H', header_size: 'h1', title_color: '#c0392b',
      typography_font_size: 44, typography_font_weight: '800',
      typography_text_transform: 'uppercase', blend_mode: 'multiply',
    }).settings;
    assert.equal(s.title_color, '#c0392b');
    assert.equal(s.typography_font_size.size, 44);
    assert.equal(s.typography_font_weight, '800');
    assert.equal(s.typography_text_transform, 'uppercase');
    assert.equal(s.blend_mode, 'multiply');
    // The GROUP'S POPOVER TOGGLE. Elementor writes a widget's typography CSS
    // only when this is on; without it the four above are keys on a page that
    // paint nothing.
    assert.equal(s.typography_typography, 'custom');
  });

  test('W-v..W-aj · a Button publishes all fifteen', () => {
    const s = publish({
      kind: 'button', label: 'B', href: '/x', size: 'sm',
      selected_icon: 'fas fa-arrow-right', icon_align: 'row-reverse', icon_indent: 14,
      typography_font_size: 20, typography_font_weight: '700',
      button_text_color: '#ffffff', background_color: '#0b6e4f',
      hover_color: '#ffd166', button_background_hover_color: '#073b2a',
      border_border: 'solid', border_width: 3, border_color: '#ffd166',
      border_radius: 12, text_padding: 18,
    }).settings;
    assert.equal(s.text, 'B');
    assert.equal(s.size, 'sm');
    assert.equal(s.selected_icon.value, 'fas fa-arrow-right');
    assert.equal(s.icon_align, 'row-reverse');
    assert.equal(s.icon_indent.size, 14);
    assert.equal(s.button_text_color, '#ffffff');
    assert.equal(s.background_color, '#0b6e4f');
    assert.equal(s.hover_color, '#ffd166');
    assert.equal(s.button_background_hover_color, '#073b2a');
    assert.equal(s.border_border, 'solid');
    assert.equal(Number(s.border_width.top), 3);
    assert.equal(s.border_color, '#ffd166');
    assert.equal(Number(s.border_radius.top), 12);
    assert.equal(Number(s.text_padding.top), 18);
  });

  test('W-as..W-ax · a Divider publishes anything at all', () => {
    // Its codec was `fields: {}` — seven controls, nothing published.
    const s = publish({
      kind: 'divider', style: 'dashed', weight: 6, width: 55,
      align: 'left', color: '#8e44ad', gap: 22,
    }).settings;
    assert.equal(s.style, 'dashed');
    assert.equal(s.weight.size, 6);
    assert.equal(s.width.size, 55);
    assert.equal(s.align, 'left');
    assert.equal(s.color, '#8e44ad');
    assert.equal(s.gap.size, 22);
  });

  test('W-ak..W-ar · an Image publishes its resolution, its width and its edge', () => {
    const s = publish({
      kind: 'image', url: 'http://x/i.png', id: 44, image_size: 'medium',
      caption: 'A caption', align: 'end', width: 240,
      image_border_radius: 18, image_border_border: 'solid',
      image_border_width: 4, image_border_color: '#0b6e4f',
    }).settings;
    assert.equal(s.image_size, 'medium');
    assert.equal(s.image.id, 44, 'a library id is a NUMBER — the srcset is keyed on it');
    assert.equal(s.caption_source, 'custom');
    assert.equal(s.align, 'end');
    assert.equal(s.width.size, 240);
    assert.equal(Number(s.image_border_radius.top), 18);
    assert.equal(s.image_border_border, 'solid');
    assert.equal(Number(s.image_border_width.top), 4);
    assert.equal(s.image_border_color, '#0b6e4f');
  });

  test('W-ay · a Spacer publishes its PHONE value too', () => {
    const s = publish({ kind: 'spacer', space: 77, space_mobile: 20 }).settings;
    assert.equal(s.space.size, 77);
    assert.equal(s.space_mobile.size, 20, 'per device, or the phone gets the desktop number');
  });

  test('a Text Editor’s paragraphs publish as paragraphs, not as one comma line', () => {
    // `['One','Two']` is the platform's stored shape and `html()` read it as
    // one value, so it published `<p>One,Two</p>` — with JavaScript's comma.
    const s = publish({ kind: 'paragraph', text: ['One', 'Two'] }).settings;
    assert.equal(s.editor, '<p>One</p><p>Two</p>');
  });

  test('a Bullet list publishes Elementor’s own Icon List', () => {
    const node = publish({ kind: 'list', items: ['One', 'Two'] });
    assert.equal(node.widgetType, 'icon-list', 'the codec published a Text Editor holding a <ul>');
    assert.deepEqual(node.settings.icon_list.map((r) => r.text), ['One', 'Two']);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   W-2 · THE HTML TAG — an H1 stays an h1
   ══════════════════════════════════════════════════════════════════════════ */

describe('W-2 · an H1 stays an h1', () => {
  test('a tag stored under the old `level` key is a tag', () => {
    assert.equal(publish({ kind: 'heading', text: 'H', level: 'h1' }).settings.header_size, 'h1');
    assert.equal(publish({ kind: 'heading', text: 'H', level: 'h3' }).settings.header_size, 'h3');
  });

  test('the engine’s own key still wins when both are there', () => {
    const s = publish({ kind: 'heading', text: 'H', level: 'h2', header_size: 'h1' }).settings;
    assert.equal(s.header_size, 'h1', 'the fresher key is the panel’s, and it wins');
  });

  test('the words the OLD control used still mean what they meant', () => {
    assert.equal(publish({ kind: 'heading', text: 'H', level: 'Page title' }).settings.header_size, 'h1');
    assert.equal(publish({ kind: 'heading', text: 'H', level: 'Sub-section' }).settings.header_size, 'h3');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   THE HEADING-FONT CONTROL OWNS THE FONT FAMILY, AND NOTHING ELSE
   ══════════════════════════════════════════════════════════════════════════ */

describe('a section’s heading font does not switch off its headings’ typography', () => {
  const headingSection = () => ({
    id: 's', elType: 'container', settings: { _title: 'ia:content:scratch:x' },
    elements: [{
      id: 'h', elType: 'widget', widgetType: 'heading',
      settings: {
        title: 'H', header_size: 'h1',
        typography_typography: 'custom',
        typography_font_size: { unit: 'px', size: 44, sizes: [] },
        typography_font_weight: '800',
      },
    }],
  });

  test('an EMPTY heading font leaves the group’s toggle alone', () => {
    /* `extractSectionStyle` sends `headingFont: ''` on EVERY save, because the
       control is optional. It used to delete `typography_typography` — the
       group's popover toggle, which is the only thing that makes Elementor
       write the typography CSS at all — so a heading set to 44px/800 rendered
       at the theme's 40px/700 the moment anything else on the page was saved.
       Driven against the live page before it was found. */
    const out = applySectionStyle(headingSection(), { headingFont: '' });
    const s = out.elements[0].settings;
    assert.equal(s.typography_typography, 'custom');
    assert.equal(s.typography_font_size.size, 44);
    assert.equal(s.typography_font_weight, '800');
    assert.ok(!('typography_font_family' in s), 'the one key this control owns IS cleared');
  });

  test('and when nothing else in the group is left, the toggle goes too', () => {
    const only = {
      id: 's', elType: 'container', settings: {},
      elements: [{
        id: 'h', elType: 'widget', widgetType: 'heading',
        settings: { title: 'H', typography_typography: 'custom', typography_font_family: 'Inter' },
      }],
    };
    const s = applySectionStyle(only, { headingFont: '' }).elements[0].settings;
    assert.ok(!('typography_typography' in s));
    assert.ok(!('typography_font_family' in s));
  });

  test('a font that IS set still reaches every heading', () => {
    const s = applySectionStyle(headingSection(), { headingFont: 'Inter' }).elements[0].settings;
    assert.equal(s.typography_typography, 'custom');
    assert.equal(s.typography_font_family, 'Inter');
    assert.equal(s.typography_font_size.size, 44, 'and it does not trample the rest of the group');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   W-3 · THE STRUCTURE THE AUTHOR PICKED
   ══════════════════════════════════════════════════════════════════════════ */

describe('W-3 · a structure publishes as columns', () => {
  const threeUp = {
    kind: 'container',
    __style: { direction: 'row', gap: 16, columnWidths: [0.34, 0.33, 0.33] },
    __children: [
      { kind: 'container', __children: [{ kind: 'heading', text: 'One' }] },
      { kind: 'container', __children: [{ kind: 'heading', text: 'Two' }] },
      { kind: 'container', __children: [{ kind: 'heading', text: 'Three' }] },
    ],
  };

  test('33/33/33 publishes as a row of three cells at those widths', () => {
    const node = buildContentWidget(threeUp, 'b1', null, CTX, 1);
    assert.equal(node.elType, 'container');
    assert.equal(node.settings.flex_direction, 'row');
    assert.deepEqual(node.elements.map((c) => c.settings.width.size), [34, 33, 33]);
    assert.deepEqual(node.elements.map((c) => c.settings.content_width), ['full', 'full', 'full']);
  });

  test('a cell that states its own width keeps it', () => {
    const held = JSON.parse(JSON.stringify(threeUp));
    held.__children[0].__style = { contentWidth: 'full', width: 60 };
    const node = buildContentWidget(held, 'b1', null, CTX, 1);
    assert.equal(node.elements[0].settings.width.size, 60);
  });

  test('one column is one cell, and nothing is invented', () => {
    const one = { kind: 'container', __style: { direction: 'column' }, __children: [] };
    const node = buildContentWidget(one, 'b1', null, CTX, 1);
    assert.deepEqual(node.elements, []);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   W-4 · THE SECTION'S OWN BOX
   ══════════════════════════════════════════════════════════════════════════ */

describe('W-4 · the whole Container panel reaches the page', () => {
  const BOX = {
    minHeight: 420, contentWidth: 'boxed', width: 700,
    margin: { top: 40, right: 40, bottom: 40, left: 40 },
    padding: { top: 40, right: 40, bottom: 40, left: 40 },
    background: '#EAF4EF',
    border: { style: 'dashed', width: 2, color: '#0B6E4F' },
    radius: 14, shadow: 'strong',
    direction: 'row', gap: 18, justify: 'between', alignItems: 'center', wrap: true,
  };

  test('eleven controls that published nothing at all now publish', () => {
    const s = applyFields(emptySection(), 'content', { layout: 1, blocks: [], box: BOX }, CTX).settings;
    assert.equal(s.min_height.size, 420);
    assert.equal(s.content_width, 'boxed');
    assert.equal(Number(s.margin.top), 40);
    assert.equal(Number(s.padding.top), 40);
    assert.equal(s.background_color, '#EAF4EF');
    assert.equal(s.border_border, 'dashed');
    assert.equal(Number(s.border_width.top), 2);
    assert.equal(s.border_color, '#0B6E4F');
    assert.equal(Number(s.border_radius.top), 14);
    assert.equal(s.box_shadow_box_shadow_type, 'yes');
    assert.equal(s.flex_direction, 'row');
    assert.equal(s.flex_justify_content, 'space-between');
    assert.equal(s.flex_align_items, 'center');
    assert.equal(s.flex_wrap, 'wrap');
    assert.equal(s.flex_gap.column, '18');
  });

  test('it reads back as the same box, so the panel reopens on what is there', () => {
    const written = applyFields(emptySection(), 'content', { layout: 1, blocks: [], box: BOX }, CTX);
    const back = extractFields(written, 'content').box;
    assert.equal(back.minHeight, 420);
    assert.equal(back.contentWidth, 'boxed');
    assert.equal(back.background, '#EAF4EF');
    assert.equal(back.radius, 14);
    assert.equal(back.direction, 'row');
    assert.equal(back.justify, 'between', 'OUR word, never the engine’s CSS value');
    assert.equal(back.alignItems, 'center');
    assert.equal(back.wrap, true);
    assert.equal(back.gap, 18);
  });

  test('NOTHING CHANGED, NOTHING WRITTEN — a no-op box is not re-emitted', () => {
    const written = applyFields(emptySection(), 'content', { layout: 1, blocks: [], box: BOX }, CTX);
    const again = applyFields(written, 'content',
      { layout: 1, blocks: [], box: extractFields(written, 'content').box }, CTX);
    assert.equal(JSON.stringify(again.settings), JSON.stringify(written.settings));
  });

  test('the top-level band’s default padding is never imposed', () => {
    // `layoutToSettings(node, 0)` writes 64/20/64/20. A box that says nothing
    // about padding must not gain one.
    const s = applyFields(emptySection(), 'content',
      { layout: 1, blocks: [], box: { direction: 'column' } }, CTX).settings;
    assert.ok(!s.padding || Number(s.padding.top) !== 64, 'a default the author never asked for');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   W-az · one widget default that was wrong by eighteen times
   ══════════════════════════════════════════════════════════════════════════ */

test('W-az · Social Icons publishes its padding in pixels, not ems', () => {
  const s = ELEMENTOR_WIDGETS.social_links.settings({ icon_padding: 9 }, CTX);
  assert.equal(s.icon_padding.unit, 'px', '9 published as 9em — eighteen times the padding drawn');
  assert.equal(s.icon_padding.size, 9);
});
