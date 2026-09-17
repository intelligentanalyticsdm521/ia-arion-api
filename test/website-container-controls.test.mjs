/**
 * test/website-container-controls.test.mjs — the container dialect, PINNED to
 * the page engine's own registry.
 *
 * D-156 conformance, audit points 1 and 12. Stream D read the engine's source
 * once and wrote the keys down; nothing then held the emitter to them, and the
 * emitter quietly dropped three things an author could set (`alignItems`,
 * `wrap`, `props.html_tag`) while `node.width` meant two different things at
 * once. Those are exactly the faults a pin catches and a hand-written
 * expectation does not.
 *
 * WHAT IS PINNED
 *   1. every settings key we can publish for a container is a control the
 *      page engine has — per-device keys on a control that IS per-device;
 *   2. every VALUE we can emit for a select or a choose is one that control
 *      offers;
 *   3. everything `ContainerLayout` can hold SURVIVES a publish — the
 *      assertion that would have caught all three losses;
 *   4. the two keys we deliberately do not read as layout are recorded as
 *      decisions rather than holes.
 *
 * The fixture is `test/fixtures/elementor-container-controls.json`, extracted
 * from `BUILDER_WIDGET_CATALOG_2026-09-17.pro.json` by
 * `scripts/dev/extract-container-controls.mjs` — which refuses to write a
 * fixture for a key the engine does not have, so regenerating cannot bless a
 * made-up key.
 *
 * MUTATIONS — each made red on purpose on 2026-09-17, then restored (see
 * scripts/dev/d156-conformance-mutation-check.mjs).
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  treeToElementor, layoutToSettings, layoutFromStyle, documentToTree, elementorToPage,
} from '../lib/websiteBuilder/elementorTree.js';
import {
  MAXIMAL_CONTAINER, MAXIMAL_GRID, SETTINGS_NOT_CONTROLS, emittedContainerSettings,
} from './fixtures/container-controls-input.mjs';

const PIN = JSON.parse(readFileSync(
  path.join(process.cwd(), 'test', 'fixtures', 'elementor-container-controls.json'), 'utf8',
));
const CONTROLS = PIN.controls;
const DEVICE_SUFFIX = /_(tablet|mobile)$/;
const REGENERATE = 'If the change is intended, run: node scripts/dev/extract-container-controls.mjs '
  + '— and read the diff.';

const PRO = { allowPro: true, seed: 'pin' };

/** The control a key belongs to: itself, or its base when it is a device key. */
function controlFor(key) {
  if (CONTROLS[key]) return CONTROLS[key];
  const base = key.replace(DEVICE_SUFFIX, '');
  const c = CONTROLS[base];
  return (c && c.responsive && base !== key) ? c : null;
}

/* ══════════════════════════════════════════════════════════════════════════
   1. Every key we publish is a control the page engine has
   ══════════════════════════════════════════════════════════════════════════ */

describe('a box is published in the page engine\'s own words', () => {
  test('every settings key the emitter can produce is one the container element has', () => {
    for (const key of emittedContainerSettings(MAXIMAL_CONTAINER)) {
      if (SETTINGS_NOT_CONTROLS.includes(key)) continue;
      assert.ok(controlFor(key),
        `we publish \`${key}\` and the page engine's container has no such control. ${REGENERATE}`);
    }
  });

  test('a grid\'s own four keys are the engine\'s own four', () => {
    const s = layoutToSettings(MAXIMAL_GRID, 1);
    for (const key of ['grid_columns_grid', 'grid_rows_grid', 'grid_gaps', 'grid_auto_flow']) {
      assert.ok(CONTROLS[key], `\`${key}\` is not a control the container has. ${REGENERATE}`);
      assert.ok(key in s, `a grid stopped emitting \`${key}\``);
    }
    assert.equal(s.flex_direction, undefined, 'a grid emitted a flex key');
  });

  test('a per-device key is only written on a control that IS per-device', () => {
    for (const key of emittedContainerSettings(MAXIMAL_CONTAINER)) {
      if (!DEVICE_SUFFIX.test(key) || CONTROLS[key]) continue;
      const base = key.replace(DEVICE_SUFFIX, '');
      assert.ok(CONTROLS[base]?.responsive,
        `\`${key}\` overrides \`${base}\` on a device, and \`${base}\` is not a per-device control`);
    }
  });

  test('every value we can emit for a select or a choose is one it offers', () => {
    // The emitter's closed tables, exercised through the emitter itself rather
    // than transcribed — a table that grew a word nobody offered would pass a
    // transcription and fail this.
    const cases = [
      [{ layout: 'row' }, 'flex_direction'],
      [{ layout: 'column' }, 'flex_direction'],
      [{ layout: 'grid' }, 'container_type'],
      [{ layout: 'row', justify: 'flex-start' }, 'flex_justify_content'],
      [{ layout: 'row', justify: 'center' }, 'flex_justify_content'],
      [{ layout: 'row', justify: 'flex-end' }, 'flex_justify_content'],
      [{ layout: 'row', justify: 'space-between' }, 'flex_justify_content'],
      [{ layout: 'row', align: 'flex-start' }, 'flex_align_items'],
      [{ layout: 'row', align: 'center' }, 'flex_align_items'],
      [{ layout: 'row', align: 'flex-end' }, 'flex_align_items'],
      [{ layout: 'row', align: 'stretch' }, 'flex_align_items'],
      [{ layout: 'row', wrap: 'wrap' }, 'flex_wrap'],
      [{ layout: 'row', wrap: 'nowrap' }, 'flex_wrap'],
      [{ layout: 'column', width: 'full' }, 'content_width'],
      [{ layout: 'column' }, 'content_width'],
      ...['div', 'header', 'footer', 'main', 'article', 'section', 'aside']
        .map((tag) => [{ layout: 'column', htmlTag: tag }, 'html_tag']),
    ];
    for (const [node, key] of cases) {
      const value = layoutToSettings(node, 1)[key];
      assert.notEqual(value, undefined, `\`${key}\` was not emitted for ${JSON.stringify(node)}`);
      const offered = controlFor(key).options;
      assert.ok(Array.isArray(offered), `\`${key}\` has no options in the machine file. ${REGENERATE}`);
      assert.ok(offered.includes(value), `\`${key}\` does not offer "${value}"`);
    }
  });

  test('a word the page engine does not offer is not published at all', () => {
    // `layoutFromStyle`'s tables are closed, so junk out of a document never
    // reaches a website: an author cannot be shown a layout the site cannot
    // draw, and a hand-edited row cannot publish `justify: "middle"`.
    const junk = layoutFromStyle(
      { direction: 'sideways', justify: 'middle', alignItems: 'nowhere', wrap: true },
      { html_tag: 'script' },
    );
    assert.equal(junk.layout, undefined);
    assert.equal(junk.justify, undefined);
    assert.equal(junk.align, undefined);
    assert.equal(junk.htmlTag, undefined);
    const s = layoutToSettings({ layout: 'row', justify: 'middle', align: 'nowhere', htmlTag: 'script' }, 1);
    assert.equal(s.flex_justify_content, undefined);
    assert.equal(s.html_tag, undefined);
    assert.equal(s.flex_align_items, 'stretch', 'a row keeps its own default');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   2. Everything a box can hold SURVIVES a publish — audit point 1
   ══════════════════════════════════════════════════════════════════════════ */

describe('what the author set reaches the website', () => {
  /** The document the Portal writes: a box inside a column, layout in `style`. */
  const docWith = (style, props = {}) => ({
    v: 2,
    settings: {},
    sections: [{
      id: 's1',
      label: 'Choose your plan',
      layout: 1,
      columns: [{
        id: 'col1',
        widgets: [{
          id: 'b1', kind: 'container', props, style,
          children: [{ id: 'h1', kind: 'heading', props: { text: 'Hello' } }],
        }],
      }],
    }],
  });

  const boxSettings = (style, props) => {
    const tree = documentToTree(docWith(style, props));
    return treeToElementor(tree[0], PRO, 0).elements[0].settings;
  };

  test('EVERY key ContainerLayout can hold survives — the three that did not', () => {
    const s = boxSettings(
      { direction: 'row', justify: 'center', alignItems: 'center', wrap: true, gap: 20, minHeight: 300 },
      { html_tag: 'section' },
    );
    assert.equal(s.flex_direction, 'row');
    assert.equal(s.flex_justify_content, 'center');
    // These three were dropped on the way to a website while the canvas, the
    // PDF and the email all honoured them (audit point 1).
    assert.equal(s.flex_align_items, 'center', 'align items did not reach the website');
    assert.equal(s.flex_wrap, 'wrap', 'wrap did not reach the website');
    assert.equal(s.html_tag, 'section', 'the box\'s tag did not reach the website');
    assert.equal(s.flex_gap.size, 20);
    assert.equal(s.min_height.size, 300);
  });

  test('an author who turns WRAPPING OFF is obeyed — not the row default', () => {
    // The inspector's tick box deletes the key when it is cleared, so "no key"
    // is the canvas's `nowrap` and must publish as `nowrap`. This is the half
    // of point 1 that a "carry the value when present" fix would have missed.
    assert.equal(boxSettings({ direction: 'row', wrap: true }).flex_wrap, 'wrap');
    assert.equal(boxSettings({ direction: 'row', wrap: false }).flex_wrap, 'nowrap');
    assert.equal(boxSettings({ direction: 'row' }).flex_wrap, 'nowrap');
  });

  test('a phone override reaches the website on the engine\'s own suffix', () => {
    const s = boxSettings({
      direction: 'row',
      alignItems: 'start',
      phone: { direction: 'column', alignItems: 'stretch' },
      tablet: { justify: 'center' },
    });
    assert.equal(s.flex_align_items, 'flex-start');
    assert.equal(s.flex_direction_mobile, 'column');
    assert.equal(s.flex_align_items_mobile, 'stretch');
    assert.equal(s.flex_justify_content_tablet, 'center');
  });

  test('a wrap set FOR ONE DEVICE reaches the website on that device', () => {
    // The desktop answer is not copied onto the phone, and a phone's own "no"
    // is not dropped. Per-device is where point 1's losses were.
    const s = boxSettings({ direction: 'row', wrap: true, tablet: { wrap: true }, phone: { wrap: false } });
    assert.equal(s.flex_wrap_mobile, 'nowrap', 'a wrap set for phones did not reach the website');
    assert.equal(s.flex_wrap_tablet, 'wrap', 'a wrap set for tablets did not reach the website');
  });

  test('a row STACKS on a phone, because the canvas stacks it there', () => {
    // render.ts: `.bx-box-row { flex-direction: column !important }` under the
    // 720px container query. One document cannot read stacked in the builder
    // and side-by-side on the website.
    assert.equal(boxSettings({ direction: 'row' }).flex_direction_mobile, 'column');
    // ...and an author who says something else for phones still wins.
    assert.equal(boxSettings({ direction: 'row', phone: { direction: 'row' } }).flex_direction_mobile, 'row');
  });

  test('a section\'s own alignment travels too, not only a box inside one', () => {
    const doc = {
      v: 2,
      settings: {},
      sections: [{
        id: 's1',
        style: { alignItems: 'center', wrap: true },
        props: { html_tag: 'main' },
        children: [{ id: 'w', type: 'widget', kind: 'heading', props: { text: 'Hi' } }],
      }],
    };
    const s = treeToElementor(documentToTree(doc)[0], PRO, 0).settings;
    assert.equal(s.flex_align_items, 'center');
    assert.equal(s.html_tag, 'main');
  });

  test('and it reads back as what was sent — both halves of the round trip', () => {
    const tree = documentToTree(docWith(
      { direction: 'row', justify: 'center', alignItems: 'center', wrap: false },
      { html_tag: 'section' },
    ));
    const published = treeToElementor(tree[0], PRO, 0);
    const [back] = elementorToPage([published]);
    const box = back.children[0];
    assert.equal(box.layout, 'row');
    assert.equal(box.justify, 'center');
    assert.equal(box.align, 'center');
    assert.equal(box.wrap, 'nowrap');
    assert.equal(box.htmlTag, 'section');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   3. The keys we deliberately do NOT use as layout
   ══════════════════════════════════════════════════════════════════════════ */

describe('the decisions on the record', () => {
  test('`width` is content width and nothing else; a flex size has its own key', () => {
    assert.ok(CONTROLS.content_width);
    assert.ok(CONTROLS._flex_size);
    const boxed = layoutToSettings({ layout: 'column', width: 'full' }, 0);
    assert.equal(boxed.content_width, 'full');
    assert.equal('_flex_size' in boxed, false);
  });

  test('`min_height` has one home — §11.8\'s style, per device, never a layout key', () => {
    assert.ok(CONTROLS.min_height);
    const l = layoutToSettings({ layout: 'column', minHeight: 300 }, 1);
    assert.equal('min_height' in l, false, 'min_height grew a second home');
  });

  test('the fixture says where it came from and how to rebuild it', () => {
    // A fixture nobody can regenerate is a fixture nobody dares change.
    const header = PIN._comment.join(' ');
    assert.match(header, /BUILDER_WIDGET_CATALOG_2026-09-17\.pro\.json/);
    assert.match(header, /extract-container-controls\.mjs/);
    assert.equal(PIN.element, 'container');
    assert.equal(PIN.pro, true);
    assert.ok(PIN.elementor_version, 'the fixture does not say which engine version it is from');
  });
});
