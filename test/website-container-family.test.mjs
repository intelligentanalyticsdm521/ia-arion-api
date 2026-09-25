/**
 * test/website-container-family.test.mjs — the box the author built is the box
 * the website gets.
 *
 * B-168, family F0. `website-container-controls.test.mjs` pins that every key
 * we publish is a real control of the page engine's container element. This
 * file asserts the other half, which a pin cannot: that each control the
 * author can now set on a box actually ARRIVES, with the value they chose, on
 * the key the engine reads.
 *
 * The two together are what stops the defect this family exists to close —
 * audit point 1, "a control the author can see, whose value is stored, and
 * which is silently dropped on the way to a website".
 *
 * ── MUTATION CHECKS: each RUN, seen red, restored (2026-09-19) ─────────────
 *  a. `containerStyleSettings`: write `background_colour` instead of
 *     `background_color` → the PIN goes red naming the key (it is not a
 *     control) and "a classic background reaches the website" goes red here.
 *  b. `styleToSettings layer()`: put `overflow${suffix}` back → the extract
 *     script REFUSES to write the fixture ("the page engine's `overflow` is
 *     not per-device"), which is how the real defect was found.
 *  c. `flexItemSettings`: drop the full-width guard → "one Elementor control,
 *     two of our questions" goes red, because Advanced ▸ Size overwrote the
 *     Layout ▸ Width the author typed.
 *  d. `layoutToSettings`: publish `layout` instead of `node.direction` → "the
 *     exact arrow the author picked" goes red.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  containerStyleSettings, documentToTree, layoutToSettings, layoutFromStyle,
  styleToSettings, treeToElementor,
} from '../lib/websiteBuilder/elementorTree.js';
import { EMITTERS as CONTAINER_FAMILY } from '../lib/websiteBuilder/families/container/emitters.js';

const PRO = { allowPro: true, seed: 'f0' };

/** The document the Portal writes: a box in a column, its layout in `style`. */
function boxSettings(style, props = {}) {
  const doc = {
    v: 2,
    settings: {},
    sections: [{
      id: 's1',
      label: 'Section',
      layout: 1,
      columns: [{
        id: 'c1',
        widgets: [{
          id: 'b1', kind: 'container', props, style,
          children: [{ id: 'h1', kind: 'heading', props: { text: 'Hello' } }],
        }],
      }],
    }],
  };
  return treeToElementor(documentToTree(doc)[0], PRO, 0).elements[0].settings;
}

describe('the container family publishes through the tree writer, not a widget row', () => {
  test('its emitter map is empty, and that is the design', () => {
    // A container has no `widgetType` and holds children, so it cannot be a row
    // in a map whose contract is `{ widgetType, tier, label, settings() }`.
    // The folder's own file says so in words; this says it in a test.
    assert.deepEqual(CONTAINER_FAMILY, {});
  });
});

describe('the Layout tab reaches the website', () => {
  test('the exact arrow the author picked, not just row or column', () => {
    // MUTATION d.
    assert.equal(boxSettings({ direction: 'row-reverse' }).flex_direction, 'row-reverse');
    assert.equal(boxSettings({ direction: 'column-reverse' }).flex_direction, 'column-reverse');
    assert.equal(boxSettings({ direction: 'row' }).flex_direction, 'row');
    // …and a caller that never heard of the reverses publishes what it always did.
    assert.equal(layoutToSettings({ layout: 'row' }, 1).flex_direction, 'row');
  });

  test('all six ways of spreading things out', () => {
    for (const [ours, theirs] of [
      ['start', 'flex-start'], ['center', 'center'], ['end', 'flex-end'],
      ['between', 'space-between'], ['around', 'space-around'], ['evenly', 'space-evenly'],
    ]) {
      assert.equal(boxSettings({ direction: 'row', justify: ours }).flex_justify_content, theirs, ours);
    }
  });

  test('content width and the number beside it are two questions, two keys', () => {
    const boxed = boxSettings({ contentWidth: 'boxed', width: 1140 });
    assert.equal(boxed.content_width, 'boxed');
    assert.equal(boxed.boxed_width.size, 1140);
    assert.equal(boxed.boxed_width.unit, 'px');
    const full = boxSettings({ contentWidth: 'full', width: 80 });
    assert.equal(full.content_width, 'full');
    assert.equal(full.width.size, 80);
    assert.equal(full.width.unit, '%');
  });

  test('one Elementor control, two of our questions — the author\'s number wins', () => {
    // MUTATION c. A full-width box's Layout ▸ Width and its Advanced ▸ Size are
    // the SAME engine control (`width`). Advanced used to be written second and
    // overwrote the number the author typed into the Layout tab.
    const s = boxSettings({ contentWidth: 'full', width: 80, selfWidth: 48 });
    assert.equal(s.width.size, 80, 'Advanced ▸ Size overwrote Layout ▸ Width');
    assert.equal(s._flex_size, 'custom', 'the word beside it was not written');
  });

  test('the two gaps are the engine\'s own gaps control, and the chain is one key', () => {
    const linked = boxSettings({ direction: 'row', gap: 20 }).flex_gap;
    assert.equal(linked.column, '20');
    assert.equal(linked.row, '20', 'a linked chain means one number for both');
    assert.equal(linked.isLinked, true);
    const split = boxSettings({ direction: 'row', gap: 20, rowGap: 8 }).flex_gap;
    assert.equal(split.column, '20');
    assert.equal(split.row, '8');
    assert.equal(split.isLinked, false);
  });

  test('a grid says how many rows and which way it fills', () => {
    const s = boxSettings({ direction: 'grid', columns: 4, rows: 2, autoFlow: 'column' });
    assert.equal(s.container_type, 'grid');
    assert.equal(s.grid_columns_grid.size, 4);
    assert.equal(s.grid_rows_grid.size, 2);
    assert.equal(s.grid_auto_flow, 'column');
  });

  test('overflow reaches the website, and only once', () => {
    const s = boxSettings({ overflow: 'hidden', tablet: { overflow: 'auto' } });
    assert.equal(s.overflow, 'hidden');
    // MUTATION b. The engine's `overflow` is not per device, and a `_tablet`
    // twin of a control that has none is dropped silently on publish.
    assert.equal(s.overflow_tablet, undefined);
  });
});

describe('the Style tab reaches the website', () => {
  test('a classic background, with its picture and how it sits', () => {
    // MUTATION a.
    const s = boxSettings({
      background: {
        type: 'classic', color: '#F4F7F8', image: 'https://example.invalid/bg.png',
        position: 'top center', repeat: 'no-repeat', size: 'cover',
      },
    });
    assert.equal(s.background_background, 'classic');
    assert.equal(s.background_color, '#F4F7F8');
    assert.equal(s.background_image.url, 'https://example.invalid/bg.png');
    assert.equal(s.background_position, 'top center');
    assert.equal(s.background_repeat, 'no-repeat');
    assert.equal(s.background_size, 'cover');
  });

  test('a gradient, a film and a slideshow each reach their own keys', () => {
    const g = containerStyleSettings({
      background: { type: 'gradient', color: '#000', colorB: '#fff', gradient: 'radial', angle: 45 },
    });
    assert.equal(g.background_background, 'gradient');
    assert.equal(g.background_color_b, '#fff');
    assert.equal(g.background_gradient_type, 'radial');
    assert.equal(g.background_gradient_angle.size, 45);
    const v = containerStyleSettings({ background: { type: 'video', videoUrl: 'https://v/f.mp4' } });
    assert.equal(v.background_video_link, 'https://v/f.mp4');
    const sl = containerStyleSettings({ background: { type: 'slideshow', images: ['https://a.png'] } });
    assert.equal(sl.background_slideshow_gallery[0].url, 'https://a.png');
  });

  test('the overlay carries its opacity and its blend mode', () => {
    const s = boxSettings({
      overlay: { type: 'classic', color: '#0B1C24', opacity: 0.4, blend: 'multiply' },
    });
    assert.equal(s.background_overlay_background, 'classic');
    assert.equal(s.background_overlay_color, '#0B1C24');
    assert.equal(s.background_overlay_opacity.size, 0.4);
    assert.equal(s.overlay_blend_mode, 'multiply');
  });

  test('both shape dividers, with Flip, Invert and Bring to Front', () => {
    const s = boxSettings({
      shapeTop: { shape: 'waves', color: '#fff', height: 80, width: 120, flip: true, invert: true, aboveContent: true },
      shapeBottom: { shape: 'tilt', color: '#eee' },
    });
    assert.equal(s.shape_divider_top, 'waves');
    assert.equal(s.shape_divider_top_color, '#fff');
    assert.equal(s.shape_divider_top_height.size, 80);
    assert.equal(s.shape_divider_top_width.size, 120);
    assert.equal(s.shape_divider_top_flip, 'yes');
    // The reference calls it Invert and stores it as `_negative`.
    assert.equal(s.shape_divider_top_negative, 'yes');
    assert.equal(s.shape_divider_top_above_content, 'yes');
    assert.equal(s.shape_divider_bottom, 'tilt');
  });
});

describe('the Advanced tab reaches the website', () => {
  test('Order is `custom` plus the number, not a number in a picker', () => {
    // FOUND BY THE PIN, 2026-09-19: `_flex_order` is a CHOOSE offering
    // start | end | custom, so a number written into it published a value the
    // control does not have and the author's order did nothing on the page.
    const s = boxSettings({ order: 2 });
    assert.equal(s._flex_order, 'custom');
    assert.equal(s._flex_order_custom, '2');
  });

  test('align self, position and z-index', () => {
    const s = boxSettings({ alignSelf: 'center', position: 'absolute', zIndex: 5 });
    assert.equal(s._flex_align_self, 'center');
    assert.equal(s.position, 'absolute');
    assert.equal(s.z_index, 5);
  });

  test('the author\'s own name, classes and CSS', () => {
    const s = boxSettings({ cssId: 'prices', cssClasses: 'tight two-up', customCss: 'selector { color: red }' });
    assert.equal(s._element_id, 'prices');
    assert.equal(s.css_classes, 'tight two-up');
    assert.equal(s.custom_css, 'selector { color: red }');
  });

  test('sticky, and which screens it sticks on — in the engine\'s device words', () => {
    const s = boxSettings({ sticky: 'top', stickyOn: ['desktop', 'phone'], stickyOffset: 16 });
    assert.equal(s.sticky, 'top');
    // Our `phone` is the engine's `mobile`, translated on the way out and only
    // here, as every other name in this module is.
    assert.deepEqual(s.sticky_on, ['desktop', 'mobile']);
    assert.equal(s.sticky_offset, 16);
    assert.equal(boxSettings({}).sticky, undefined);
  });

  test('the three Hide switches are three flags, one per screen', () => {
    const s = boxSettings({ hidden: true, tablet: { hidden: true }, phone: { hidden: true } });
    assert.equal(s.hide_desktop, 'hidden-desktop');
    assert.equal(s.hide_tablet, 'hidden-tablet');
    assert.equal(s.hide_mobile, 'hidden-mobile');
  });
});

describe('a word the page engine does not offer is not published at all', () => {
  test('junk out of a hand-edited document reaches nothing', () => {
    const s = boxSettings({
      overflow: 'scroll', position: 'everywhere', sticky: 'middle',
      background: { type: 'hologram', color: '#fff' },
      overlay: { type: 'classic', blend: 'sparkle' },
      shapeTop: { shape: 'unicorn', color: '#fff' },
      alignSelf: 'nowhere',
    });
    for (const key of [
      'overflow', 'position', 'sticky', 'background_background',
      'overlay_blend_mode', 'shape_divider_top', '_flex_align_self',
    ]) {
      assert.equal(s[key], undefined, `\`${key}\` published a value the engine does not offer`);
    }
  });

  test('a WIDGET is never given a container-only key', () => {
    // A key the element does not have is dropped silently on publish, so the
    // container's own controls are written for a box and for nothing else.
    const asWidget = styleToSettings({
      overflow: 'hidden', background: { type: 'classic', color: '#fff' },
      customCss: 'x', sticky: 'top', cssClasses: 'a',
    });
    for (const key of ['overflow', 'background_background', 'custom_css', 'sticky', 'css_classes']) {
      assert.equal(asWidget[key], undefined, `a widget was given the container's \`${key}\``);
    }
  });
});

describe('what a published page says, read back', () => {
  test('a box read off a live site keeps the gap the author set, both shapes', () => {
    // We WRITE the engine's `gaps` object; a page published before B-168
    // carries a slider's `{ size }`. Both have to come back, or a round trip
    // loses the author's gap.
    const s = boxSettings({ direction: 'row', gap: 20, rowGap: 8 });
    const back = layoutFromStyle({ direction: 'row' }, {});
    assert.equal(back.layout, 'row');
    assert.equal(s.flex_gap.column, '20');
    assert.equal(s.flex_gap.row, '8');
  });
});
