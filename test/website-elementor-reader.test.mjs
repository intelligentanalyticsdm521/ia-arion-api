/**
 * THE REVERSE OF THE EMITTER — every page opens, and opening one changes nothing.
 * ---------------------------------------------------------------------------
 * Brandon, 2026-09-22, on the Website → Pages screen: *"then I can't actually
 * edit anything."* Every page on a client's real website is Elementor work done
 * ON THE SITE. The builder could read our own stamp and nothing else, so those
 * pages came back "Custom section — built on the site", locked, with Edit
 * greyed out.
 *
 * What has to hold now:
 *
 *  1. Every row of the widget catalogue that the reader offers is a FIXED
 *     POINT: settings → props → settings loses nothing an author set. A row
 *     that cannot be is not offered — it reads OPAQUE, and says so in its own
 *     file with `read: false`.
 *  2. A widget we have no row for is KEPT. It draws a placeholder, it cannot be
 *     edited, and it is written back byte for byte.
 *  3. A container, a legacy `section` and a legacy `column` all read as our
 *     container, and their children read with them.
 *  4. THE ONE THAT MATTERS: open a real page off the dev WordPress, change
 *     nothing, save — and `_elementor_data` is byte for byte what it was.
 *  5. Change ONE heading and only that heading's node differs.
 *
 * ── THE REAL BYTES ────────────────────────────────────────────────────────
 * `test/fixtures/website-real-elementor-pages.json` was read off the dev
 * fixture WordPress (localhost:8084) with the site token on 2026-09-22, not
 * hand-written. "Our workshop" is FIVE hand-built Elementor sections and
 * nothing else — the page the fixture notes call "every page on the five real
 * sites looks like this". The dev site's **Privacy Policy** page carries NO
 * `_elementor_data` at all (it is a plain WordPress draft), so it is in the
 * fixture as the empty case and "Our workshop" is the one with real bytes on
 * it. Said out loud rather than quietly swapped.
 *
 * ── MUTATIONS RUN (each applied, seen red, restored) ──────────────────────
 *  M1  `writeSection`: return the rebuilt node instead of the original when a
 *      block is unchanged            → "a page opened and saved is byte for
 *      byte what it was" goes red on Our workshop.
 *  M2  `elementorReader.readNode`: drop the opaque branch and return null
 *                                    → "a widget we cannot name is never lost".
 *  M3  `applyFields`: delete the `readsAsForeign` guard
 *                                    → "somebody else's section is never
 *                                       patched through an archetype".
 *  M4  `sectionSchema` heading field: remove `also: ['title']`
 *                                    → "editing one heading changes that one".
 *  M5  `unwrap`: return the link object instead of its url
 *                                    → the fixed-point row goes red on button.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ELEMENTOR_WIDGETS } from '../lib/websiteBuilder/elementorWidgets.js';
import { FAMILIES } from '../lib/websiteBuilder/families/index.js';
import {
  OPAQUE_KIND, BLOCK_ID_KEY, BLOCK_EL_KEY, OPAQUE_TYPE_KEY,
  kindOfWidgetType, readWidgetProps, readNode, readSectionBlocks, writeSection,
  genericRead, unwrap, indexById, KIND_OF_WIDGET_TYPE,
} from '../lib/websiteBuilder/elementorReader.js';
import {
  reduceToSectionList, applyFields, readsAsForeign, isForeignSection,
  readForeignFields, applyForeignFields, blockKindAllowed,
} from '../lib/websiteBuilder/sectionSchema.js';
import { layoutStyleFromSettings } from '../lib/websiteBuilder/elementorTree.js';

const REAL = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), 'test', 'fixtures', 'website-real-elementor-pages.json'), 'utf8'));

const CTX = { allowPro: true, iaWidgets: null, emailTo: 'hello@fernbrook.test' };

/* ══════════════════════════════════════════════════════════════════════════
   1. EVERY WIDGET THE FAMILIES PUBLISH ROUND-TRIPS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * A props bag that answers every key with one probe value.
 *
 * Seeding props any other way would mean a hand-written example per widget for
 * eighty-eight widgets, which is eighty-eight more chances to write the example
 * that makes the test pass. A Proxy answers whatever the emitter asks for, so
 * every branch that reads a prop is exercised with something.
 */
function probe(value) {
  return new Proxy({}, {
    get: (_t, k) => (typeof k === 'symbol' ? undefined : value),
    has: () => true,
    ownKeys: () => [],
  });
}
const PROBES = { word: 'zz1', number: '3', on: 'yes', date: '2026-12-25 10:00' };

/** Empty to Elementor: absent, blank, a slider with no size, four blank sides. */
function isEmpty(v) {
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') {
    if ('size' in v && (v.size === '' || v.size == null)) return true;
    if ('top' in v) return ['top', 'right', 'bottom', 'left'].every((k) => String(v[k] ?? '') === '');
    if ('url' in v && !v.url && !v.id) return true;
  }
  return false;
}

/** Same to the page engine: equal, or the same number spelled two ways. */
function sameSetting(a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) return true;
  const na = Number(a); const nb = Number(b);
  return Number.isFinite(na) && Number.isFinite(nb)
    && String(a).trim() !== '' && String(b ?? '').trim() !== '' && na === nb;
}

/** Every row the READER offers — the ones a page can actually come back as. */
function offeredRows() {
  return Object.entries(ELEMENTOR_WIDGETS).filter(([kind, row]) => (
    typeof row?.settings === 'function'
    && row.read !== false
    && kindOfWidgetType(row.widgetType) === kind
  ));
}

describe('1. every widget the reader offers is a fixed point', () => {
  test('props → settings → props → settings loses nothing an author set', () => {
    const lost = [];
    for (const [kind, row] of offeredRows()) {
      for (const [name, value] of Object.entries(PROBES)) {
        const first = row.settings(probe(value), CTX);
        const read = readWidgetProps({ elType: 'widget', widgetType: row.widgetType, settings: first });
        assert.ok(read, `${kind}: the reader does not offer its own widget type`);
        assert.equal(read.kind, kind, `${kind}: read back as ${read.kind}`);
        const again = row.settings(read.props, CTX);
        for (const key of Object.keys(first)) {
          if (isEmpty(first[key])) continue;
          if (!sameSetting(first[key], again[key])) {
            lost.push(`${kind}.${key} (${name}): ${JSON.stringify(first[key])} → ${JSON.stringify(again[key])}`);
          }
        }
      }
    }
    assert.deepEqual(lost, [], `these widgets lose an author's setting on a re-publish:\n${lost.join('\n')}`);
  });

  test('every family is covered — no family sits this out', () => {
    const offered = new Set(offeredRows().map(([kind]) => kind));
    const uncovered = [];
    for (const [family, map] of FAMILIES) {
      const kinds = Object.keys(map || {});
      if (!kinds.length) continue;
      if (!kinds.some((k) => offered.has(k))) uncovered.push(family);
    }
    assert.deepEqual(uncovered, [], `no widget of these families round-trips: ${uncovered.join(', ')}`);
  });

  test('a row that cannot be read back says so, and is never offered', () => {
    // `catalog_card`'s props are the shared BINDING section and its settings
    // are a fetch instruction. There is no inverse, and a guessed one would
    // turn a card that follows the client's catalogue into one with last
    // month's prices typed into it. It declares `read: false`.
    assert.equal(ELEMENTOR_WIDGETS.catalog_card.read, false);
    assert.equal(readWidgetProps({
      elType: 'widget', widgetType: 'ia_product_cards', settings: { ia_source: 'oliver:catalogue' },
    }), null, 'a row that declared itself unreadable is not read anyway');
  });

  test('two kinds on one widget type resolve to the plain one, every time', () => {
    assert.equal(KIND_OF_WIDGET_TYPE['price-table'], 'price_table');
    assert.equal(ELEMENTOR_WIDGETS.card.widgetType, 'price-table', 'the pair still exists');
  });

  test('a composition has no settings to read, so it is not offered', () => {
    // `tabs` and `accordion` build a TREE of child containers; there is no
    // settings object their props can be read back out of.
    for (const kind of ['tabs', 'accordion']) {
      assert.equal(typeof ELEMENTOR_WIDGETS[kind].settings, 'undefined', `${kind} is still a composition`);
      assert.notEqual(KIND_OF_WIDGET_TYPE[ELEMENTOR_WIDGETS[kind].widgetType], kind);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   2. THE SHAPES ELEMENTOR WRAPS ITS VALUES IN
   ══════════════════════════════════════════════════════════════════════════ */

describe('2. the engine’s own wrappers, unwrapped', () => {
  test('a link becomes its address, because that is what an emitter takes', () => {
    assert.equal(unwrap({ url: 'https://a.test', is_external: '', nofollow: '' }), 'https://a.test');
  });
  test('a slider becomes its number, and a blank one stays blank', () => {
    assert.equal(unwrap({ unit: 'px', size: 24, sizes: [] }), 24);
    assert.equal(unwrap({ unit: 'px', size: '', sizes: [] }), '');
  });
  test('four equal sides become one number; four blank sides are NOT zero', () => {
    assert.equal(unwrap({ unit: 'px', top: '8', right: '8', bottom: '8', left: '8', isLinked: true }), 8);
    assert.equal(unwrap({ unit: 'px', top: '', right: '', bottom: '', left: '', isLinked: true }), '');
    // Four different sides are a layout we cannot say in one number, so the
    // object is handed back whole and the emitters take it (f3's `dims`).
    const odd = { unit: 'px', top: '8', right: '16', bottom: '8', left: '16', isLinked: false };
    assert.deepEqual(unwrap(odd), odd);
  });
  test('a picture and an icon keep their shape, because their emitters read it', () => {
    assert.deepEqual(unwrap({ url: 'a.png', id: 12 }), { url: 'a.png', id: 12 });
    assert.deepEqual(unwrap({ value: 'fas fa-star', library: 'fa-solid' }), { value: 'fas fa-star', library: 'fa-solid' });
  });
  test('our own keys never reach an emitter as props', () => {
    const props = genericRead({
      title: 'Keep', _ia_w: 'heading', _ia_props: { a: 1 }, _ia_field: 'content.blocks',
      _ia_col: 0, __globals__: {}, __dynamic__: {},
    });
    assert.deepEqual(props, { title: 'Keep' });
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   3. A WIDGET WE CANNOT NAME IS KEPT, DRAWN AND NEVER LOST
   ══════════════════════════════════════════════════════════════════════════ */

/* A REAL widget somebody's website really has and this server has no row for.
   `woocommerce-product-add-to-cart` is WooCommerce's, registered by a plugin we
   do not ship and cannot emit. If a row for it is ever written, this fixture
   stops being an unknown and the first assertion below says so by name rather
   than quietly passing. */
const UNKNOWN = Object.freeze({
  id: 'unk1', elType: 'widget', widgetType: 'woocommerce-product-add-to-cart',
  settings: { product_id: '9', _skin: 'default', quantity: '3', nested: { deep: [1, 2, { x: 'y' }] } },
});

describe('3. the opaque passthrough', () => {
  test('a widget with no row reads as opaque, and says what it is', () => {
    assert.equal(kindOfWidgetType('woocommerce-product-add-to-cart'), null,
      'a row for this widget now exists - pick another unknown for this fixture');
    const block = readNode(UNKNOWN, {});
    assert.equal(block.kind, OPAQUE_KIND);
    assert.equal(block[OPAQUE_TYPE_KEY], 'woocommerce-product-add-to-cart');
    assert.equal(block[BLOCK_ID_KEY], 'unk1');
    // Nothing of its settings is carried into the block: we could not read
    // them, and a block carrying settings it cannot edit is a block somebody
    // will one day try to write back.
    assert.deepEqual(Object.keys(block).sort(), ['__id', '__widgetType', 'kind']);
  });

  test('it is a kind a save is ALLOWED to carry', () => {
    // Refusing it would refuse every save of every page that has one, which is
    // most real pages.
    assert.equal(blockKindAllowed(OPAQUE_KIND), true);
  });

  test('BYTE FOR BYTE: an opaque widget is written back as the node it was read from', () => {
    const section = {
      id: 's1', elType: 'container', settings: { _title: 'Theirs' },
      elements: [JSON.parse(JSON.stringify(UNKNOWN))],
    };
    const before = JSON.stringify(section);
    const fields = readForeignFields(section);
    assert.equal(fields.blocks[0].kind, OPAQUE_KIND);
    const out = applyForeignFields(section, fields, CTX);
    assert.equal(JSON.stringify(out), before);
    // ...and it is the SAME OBJECT, not a copy that happens to match.
    assert.equal(out.elements[0], section.elements[0]);
  });

  test('an opaque block with no node behind it is dropped, never invented', () => {
    const section = { id: 's1', elType: 'container', settings: {}, elements: [] };
    const out = applyForeignFields(section, {
      blocks: [{ kind: OPAQUE_KIND, [BLOCK_ID_KEY]: 'ghost', [OPAQUE_TYPE_KEY]: 'woocommerce-product-add-to-cart' }],
    }, CTX);
    assert.deepEqual(out.elements, []);
  });

  test('the rest of the page is still editable around it', () => {
    const section = {
      id: 's1', elType: 'container', settings: {},
      elements: [
        JSON.parse(JSON.stringify(UNKNOWN)),
        { id: 'h1', elType: 'widget', widgetType: 'heading', settings: { title: 'Ours to change', header_size: 'h2' } },
      ],
    };
    const fields = readForeignFields(section);
    assert.deepEqual(fields.blocks.map((b) => b.kind), [OPAQUE_KIND, 'heading']);
    fields.blocks[1].title = 'Changed';
    const out = applyForeignFields(section, fields, CTX);
    assert.equal(out.elements[0], section.elements[0], 'the one we cannot read did not move');
    assert.equal(out.elements[1].settings.title, 'Changed');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   4. CONTAINERS, AND THE OLD section / column DIALECT
   ══════════════════════════════════════════════════════════════════════════ */

describe('4. a box is a box, whatever the engine calls it', () => {
  test('a container reads back its arranging in the words the builder edits', () => {
    const style = layoutStyleFromSettings({
      container_type: 'flex', content_width: 'full', flex_direction: 'row',
      flex_justify_content: 'space-between', flex_align_items: 'center', flex_wrap: 'wrap',
      width: { unit: '%', size: 80, sizes: [] },
      flex_direction_mobile: 'column',
    });
    assert.equal(style.direction, 'row');
    assert.equal(style.contentWidth, 'full');
    assert.equal(style.justify, 'between', 'OUR word, never the engine’s CSS value');
    assert.equal(style.alignItems, 'center');
    assert.equal(style.wrap, true);
    assert.equal(style.width, 80);
    assert.equal(style.phone.direction, 'column');
  });

  test('a grid reads as a grid, with its columns and rows', () => {
    const style = layoutStyleFromSettings({
      container_type: 'grid',
      grid_columns_grid: { unit: 'fr', size: 3, sizes: [] },
      grid_rows_grid: { unit: 'fr', size: 2, sizes: [] },
      grid_auto_flow: 'column',
    });
    assert.equal(style.direction, 'grid');
    assert.equal(style.columns, 3);
    assert.equal(style.rows, 2);
    assert.equal(style.autoFlow, 'column');
  });

  test('a setting the page does not carry is never invented', () => {
    assert.equal(layoutStyleFromSettings({}), null);
    assert.equal(layoutStyleFromSettings({ flex_direction: 'sideways' }), null, 'a word the engine has not got');
  });

  test('a legacy section and column read as our boxes, with their children', () => {
    const legacy = {
      id: 'sec', elType: 'section', settings: { _title: 'Theirs', structure: '20' },
      elements: [{
        id: 'col', elType: 'column', settings: { _column_size: 100 },
        elements: [{ id: 'h', elType: 'widget', widgetType: 'heading', settings: { title: 'Hello' } }],
      }],
    };
    const blocks = readSectionBlocks(legacy, {});
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].kind, 'container');
    assert.equal(blocks[0][BLOCK_EL_KEY], 'column');
    assert.equal(blocks[0].__children[0].kind, 'heading');
    assert.equal(blocks[0].__children[0].title, 'Hello');
  });

  test('a legacy column keeps its OWN settings when a child changes', () => {
    // Elementor's old column element has none of the flexbox container's
    // layout keys. Writing ours onto it would publish keys the element does
    // not have — dropped silently, and the author's change would do nothing.
    const legacy = {
      id: 'sec', elType: 'section', settings: {},
      elements: [{
        id: 'col', elType: 'column', settings: { _column_size: 100, _inline_size: 50 },
        elements: [{ id: 'h', elType: 'widget', widgetType: 'heading', settings: { title: 'Hello', header_size: 'h2' } }],
      }],
    };
    const fields = readForeignFields(legacy);
    fields.blocks[0].__children[0].title = 'Changed';
    const out = applyForeignFields(legacy, fields, CTX);
    assert.deepEqual(out.elements[0].settings, { _column_size: 100, _inline_size: 50 });
    assert.equal(out.elements[0].elType, 'column');
    assert.equal(out.elements[0].elements[0].settings.title, 'Changed');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   5. REAL PAGES OFF THE DEV WORDPRESS — the promise, on real bytes
   ══════════════════════════════════════════════════════════════════════════ */

describe('5. a real page, read and written back', () => {
  const pages = Object.entries(REAL.pages);

  for (const [key, page] of pages) {
    test(`${key}: every section opens — not one is locked`, () => {
      const list = reduceToSectionList(page.elementor_data);
      assert.equal(list.length, page.elementor_data.length);
      for (const entry of list) {
        assert.equal(entry.editable, true, `${entry.label} came back locked`);
        assert.equal(entry.reason, null);
        assert.ok(entry.fields, `${entry.label} came back with no fields`);
      }
    });

    test(`${key}: THE PROMISE — open it, change nothing, save: byte for byte`, () => {
      const before = JSON.stringify(page.elementor_data);
      const list = reduceToSectionList(page.elementor_data);
      const after = list.map((s) => applyFields(s.node, s.kind, s.fields, CTX));
      assert.equal(JSON.stringify(after), before,
        `${key}: pressing Publish without a change would have changed the live site`);
    });
  }

  test('Our workshop is what Brandon was looking at: five sections, all built on the site', () => {
    const page = REAL.pages['our-workshop'];
    assert.equal(page.elementor_data.length, 5);
    for (const node of page.elementor_data) {
      assert.equal(isForeignSection(node), true);
      assert.equal(readsAsForeign(node), true);
      assert.match(String(node.settings._title), /built in Elementor/);
    }
    // Before B-168 every one of those five was `editable: false`, and the
    // Pages screen said "Built on the website itself" with Edit greyed out.
    const list = reduceToSectionList(page.elementor_data);
    assert.equal(list.filter((s) => s.editable).length, 5);
  });

  test('their widgets come back as widgets, and what we cannot name stays opaque', () => {
    const list = reduceToSectionList(REAL.pages['our-workshop'].elementor_data);
    const kinds = [];
    const walk = (b) => {
      kinds.push(b.kind);
      (b.__children || []).forEach(walk);
    };
    list.forEach((s) => s.fields.blocks.forEach(walk));
    // Read off the real page: headings, paragraphs, a button, a bullet list, a
    // form and a video, all inside the old section/column boxes.
    for (const want of ['container', 'heading', 'paragraph', 'button', 'list', 'video']) {
      assert.ok(kinds.includes(want), `${want} did not come back off the real page (got ${[...new Set(kinds)].join(', ')})`);
    }
    assert.ok(!kinds.includes('paragraph_unreadable'));
  });

  test('CHANGE ONE HEADING: that node changes and NOTHING else does', () => {
    const page = JSON.parse(JSON.stringify(REAL.pages['our-workshop'].elementor_data));
    const list = reduceToSectionList(page);
    // The first heading on the page, wherever it is.
    let target = null;
    const hunt = (b) => {
      if (!target && b.kind === 'heading') target = b;
      (b.__children || []).forEach(hunt);
    };
    list.forEach((s) => s.fields.blocks.forEach(hunt));
    assert.ok(target, 'the real page has a heading');
    const was = target.title;
    assert.ok(was, 'and it has words');
    target.title = 'Our workshop, renamed';

    const after = list.map((s) => applyFields(s.node, s.kind, s.fields, CTX));

    const titles = [];
    const walk = (n) => {
      if (n?.widgetType === 'heading') titles.push(n.settings.title);
      (n?.elements || []).forEach(walk);
    };
    after.forEach(walk);
    assert.ok(titles.includes('Our workshop, renamed'), 'the change reached the page');
    assert.ok(!titles.includes(was), 'and the old words are gone');

    /* EVERY OTHER NODE IS UNTOUCHED. A box that HOLDS the changed heading
       necessarily differs — its `elements` array has a different child in it —
       so the rule is stated the way it is actually meant: no node's own
       SETTINGS changed but the one heading's, and no widget node changed at
       all but that one. A blanket "nothing differs" would have to exempt the
       ancestors and would then be exempting the thing it is checking. */
    const beforeIndex = indexById({ elements: REAL.pages['our-workshop'].elementor_data });
    const damaged = [];
    const check = (n) => {
      const prior = beforeIndex.get(String(n.id));
      if (prior && n !== target) {
        const isTheHeading = n.elType === 'widget' && n.settings?.title === 'Our workshop, renamed';
        if (!isTheHeading) {
          if (JSON.stringify(prior.settings) !== JSON.stringify(n.settings)) damaged.push(`${n.id}: settings`);
          if (n.elType === 'widget' && JSON.stringify(prior) !== JSON.stringify(n)) damaged.push(`${n.id}: widget`);
          if ((prior.elements || []).length !== (n.elements || []).length) damaged.push(`${n.id}: children lost`);
        }
      }
      (n.elements || []).forEach(check);
    };
    after.forEach(check);
    assert.deepEqual(damaged, [], `these nodes changed and should not have: ${damaged.join(', ')}`);
  });

  test('the dev site’s Privacy Policy carries no Elementor data at all', () => {
    // Said out loud rather than quietly swapped for a page that suited the
    // test: on this fixture site Privacy Policy is a plain WordPress draft.
    // "Our workshop" is the page with real Elementor bytes on it.
    assert.deepEqual(REAL.pages['privacy-policy'].elementor_data, []);
    assert.deepEqual(reduceToSectionList(REAL.pages['privacy-policy'].elementor_data), []);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   6. THE TWO DEAD ENDS ARE GONE
   ══════════════════════════════════════════════════════════════════════════ */

describe('6. nothing comes back locked any more', () => {
  test('"Custom section — built on the site" is not a sentence this server can say', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'lib', 'websiteBuilder', 'sectionSchema.js'), 'utf8');
    const live = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!live.includes('Custom section'), 'still in the code');
    assert.ok(!live.includes("'no_field_markers'"), 'the third dead end is still here');
    assert.ok(!live.includes("reason: 'tree'"), 'the tree dead end is still here');
  });

  test('ONE predicate decides how a section is read AND how it is written', () => {
    // Two answers would mean a section read as blocks and written through an
    // archetype, which puts a page back as something it is not.
    const routes = fs.readFileSync(path.join(process.cwd(), 'routes', 'arion', 'pages.js'), 'utf8');
    assert.match(routes, /readsAsForeign\(node\)/);
    const schema = fs.readFileSync(path.join(process.cwd(), 'lib', 'websiteBuilder', 'sectionSchema.js'), 'utf8');
    assert.match(schema, /if \(readsAsForeign\(node\)\)/, 'the reader asks it');
    assert.match(schema, /readsAsForeign\(section\)/, 'and so does applyFields');
  });

  test('ADOPTION IS DELETED — there is nothing left to adopt', () => {
    for (const gone of [
      'lib/websiteBuilder/adoption.js',
      'lib/websiteBuilder/adoptionStore.js',
      'lib/websiteBuilder/sectionPreview.js',
      'test/site-builder-adoption.test.mjs',
    ]) {
      assert.equal(fs.existsSync(path.join(process.cwd(), ...gone.split('/'))), false, `${gone} is still here`);
    }
    const routes = fs.readFileSync(path.join(process.cwd(), 'routes', 'arion', 'pages.js'), 'utf8');
    const live = routes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!live.includes('adopt'), 'an adoption route or field is still live');
  });
});
