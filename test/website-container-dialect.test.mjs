/**
 * test/website-container-dialect.test.mjs — ONE layout dialect.
 *
 * BUILDER_PLATFORM_SCOPE_2026-09-15 §2:
 *   "The two ARION layout dialects (legacy section/column from the adapter,
 *    flex containers from the library) must become one before a canvas can
 *    show both kinds of section side by side. Recommendation: containers."
 *
 * What this file pins:
 *   1. GOLDENS — the whole Elementor node every section kind emits, diffed
 *      against a checked-in fixture. A change to the dialect is then a
 *      reviewable diff instead of a page that looks wrong on somebody's live
 *      website a week later. Rebuild with
 *      `node scripts/dev/build-container-goldens.mjs`.
 *   2. ROUND TRIP — fields → Elementor → fields, as EQUALITY, for every kind.
 *   3. NO-OP SAVE — reading a page and saving it back changes not one byte.
 *   4. LEGACY IMPORT — a page built in the old dialect still reads, still
 *      patches, and still keeps its structure. Five live client sites carry
 *      those pages.
 *
 * MUTATION CHECKS, written down so the next person can re-run them:
 *   · change `content_width: 'boxed'` in sectionContainer   → "goldens" red
 *   · make cardWidth() always return 100                    → "goldens" red
 *   · drop `_ia_field` from the services icon-box            → "round trip" red
 *   · make buildContentWidget ignore `previous`              → "keeps ids" red
 *   · re-add a legacy `elType: 'section'` emitter to the adapter → "GONE" red
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  blockToElementorSection, listSupportedKinds,
} from '../lib/websiteBuilder/elementorAdapter.js';
import { CONTAINER_EMITTERS, cardWidth, listContainerKinds } from '../lib/websiteBuilder/containerEmitters.js';
import {
  extractFields, applyFields, validateFields, reduceToSectionList,
  listSectionKinds, CONTENT_BLOCK_KINDS, listContentBlockKinds,
  readContentBlocks, countColumns, BLOCK_MARKER, COLUMN_MARKER,
} from '../lib/websiteBuilder/sectionSchema.js';
import { starterBlock, buildStarterSection } from '../lib/websiteBuilder/starterSections.js';
import { GOLDEN_BRAND, GOLDEN_BLOCKS } from './fixtures/container-golden-inputs.mjs';

const GOLDENS = JSON.parse(
  readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'container-goldens.json'), 'utf8'),
);

/**
 * A page of each OLD shape, frozen as data.
 *
 * D-156 deleted the legacy `section` -> `column` -> `widget` emitters: nothing
 * had called them since 2026-09-16 and a rebuild deletes the old system in the
 * same pass. What the five live client sites need is not the emitters — it is
 * that their pages still read, still patch and still re-publish untouched, and
 * a page is DATA. `scripts/dev/capture-legacy-pages.mjs` wrote this file from
 * the emitters on the last commit that had them.
 */
const LEGACY = JSON.parse(
  readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'legacy-page-goldens.json'), 'utf8'),
);
const clone = (v) => JSON.parse(JSON.stringify(v));

const KINDS = listContainerKinds();

function emit(kind) {
  const block = GOLDEN_BLOCKS[kind] || starterBlock(kind, GOLDEN_BRAND);
  return blockToElementorSection({
    kind, block, brand: GOLDEN_BRAND, seedId: `golden-${kind}`, blockId: 'golden',
  });
}

function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  (node.elements || []).forEach((c) => walk(c, fn));
}

function elTypesOn(node) {
  const seen = new Set();
  walk(node, (n) => { if (n.elType) seen.add(n.elType); });
  return [...seen].sort();
}

/* ══════════════════════════════════════════════════════════════════════════
   1. One dialect
   ══════════════════════════════════════════════════════════════════════════ */

describe('containers are the only dialect we emit', () => {
  test('every section kind has a container emitter, and the adapter uses it', () => {
    assert.deepEqual(listSupportedKinds(), KINDS.slice().sort());
    // Every kind the section schema declares can actually be BUILT. A kind in
    // the catalogue with no emitter is a section a client can choose and then
    // never get.
    assert.deepEqual(listSectionKinds().slice().sort(), KINDS.slice().sort());
  });

  test('not one emitted node is a legacy section or column', () => {
    for (const kind of KINDS) {
      const types = elTypesOn(emit(kind));
      assert.deepEqual(types, ['container', 'widget'], `${kind} emitted ${types.join('/')}`);
    }
  });

  test('the top node is a container, never inner, and carries its ia: handle', () => {
    for (const kind of KINDS) {
      const node = emit(kind);
      assert.equal(node.elType, 'container', kind);
      assert.equal(node.isInner, false, kind);
      assert.match(node.settings._title, new RegExp(`^ia:${kind}:`), kind);
    }
  });

  test('the legacy emitters are GONE — one dialect means one way to draw a page', async () => {
    const adapter = await import('../lib/websiteBuilder/elementorAdapter.js');
    assert.equal(adapter.legacyBlockToElementorSection, undefined);
    assert.equal(adapter.__test__.LEGACY_ADAPTERS, undefined);
    const src = readFileSync(
      path.join(process.cwd(), 'lib', 'websiteBuilder', 'elementorAdapter.js'), 'utf8');
    assert.ok(!/elType: 'section'/.test(src), 'a legacy section emitter came back');
    assert.ok(!/elType: 'column'/.test(src), 'a legacy column emitter came back');
    // And the old pages are still here, as data, still in the old shape.
    assert.ok(Object.keys(LEGACY).length >= 11);
    assert.deepEqual(elTypesOn(LEGACY.hero), ['column', 'section', 'widget']);
  });

  test('a row of cards gets a width that lets four sit on one line', () => {
    assert.equal(cardWidth(1), 100);
    assert.equal(cardWidth(2), 48);
    assert.equal(cardWidth(3), 31);
    assert.ok(cardWidth(4) * 4 <= 100, 'four cards fit');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   2. Goldens
   ══════════════════════════════════════════════════════════════════════════ */

describe('golden fixtures — one per section kind', () => {
  test('the fixture file covers every kind and nothing else', () => {
    assert.deepEqual(Object.keys(GOLDENS).sort(), KINDS.slice().sort());
  });

  for (const kind of KINDS) {
    test(`${kind} emits exactly the golden JSON`, () => {
      assert.deepEqual(
        emit(kind),
        GOLDENS[kind],
        `${kind} drifted. If the change is intended, run: node scripts/dev/build-container-goldens.mjs`,
      );
    });
  }

  test('emitting twice from one seed is byte-identical — Elementor revisions do not churn', () => {
    for (const kind of KINDS) {
      assert.equal(JSON.stringify(emit(kind)), JSON.stringify(emit(kind)), kind);
    }
  });

  test('a business with no colour publishes the platform neutral, never IA navy or gold', () => {
    const node = blockToElementorSection({
      kind: 'hero', block: GOLDEN_BLOCKS.hero, brand: { email: 'x@y.invalid' }, seedId: 's', blockId: 'b',
    });
    const colours = [];
    walk(node, (n) => {
      for (const [k, v] of Object.entries(n.settings || {})) {
        if (/color/i.test(k) && typeof v === 'string' && v.startsWith('#')) colours.push(v.toUpperCase());
      }
    });
    assert.ok(colours.length > 0, 'the hero has a background colour at all');
    for (const c of colours) {
      assert.notEqual(c, '#1A3A4A', 'IA navy reached a client page');
      assert.notEqual(c, '#FEC82C', 'IA gold reached a client page');
      assert.notEqual(c, '#EF6C33', 'the retired IA orange reached a client page');
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   3. The round trip — as equality
   ══════════════════════════════════════════════════════════════════════════ */

describe('model → Elementor → model', () => {
  for (const kind of KINDS) {
    test(`${kind}: what we read back is what we wrote`, () => {
      const node = emit(kind);
      const fields = extractFields(node, kind);
      const again = extractFields(applyFields(node, kind, fields), kind);
      assert.deepEqual(again, fields, kind);
    });
  }

  /**
   * ASSERT PRESENCE, NOT JUST ABSENCE (memory: feedback_assert_presence_not_just_absence).
   *
   * The equality test above passes when a field is missing from BOTH sides —
   * which is exactly what happens if an emitter forgets an `_ia_field` stamp.
   * Proven: removing the services stamp left "what we read back is what we
   * wrote" green. So every list and every headline the input actually carried
   * has to COME BACK.
   */
  test('every value the block carried is readable again — a dropped stamp cannot hide here', () => {
    const expectations = {
      hero: { headline: 1, subheadline: 1, cta_text: 1 },
      services: { headline: 1, services: 3 },
      testimonials: { headline: 1, testimonials: 2 },
      cta: { headline: 1, primary_cta_text: 1, secondary_cta_text: 1 },
      about: { headline: 1, story_paragraphs: 2, values: 2 },
      faq: { headline: 1, faqs: 2 },
      gallery: { headline: 1, images: 2 },
      pricing: { headline: 1, plans: 2 },
      team: { headline: 1, members: 2 },
      stats: { headline: 1, stats: 2 },
      contact: { headline: 1, contact_methods: 2, form_fields: 5, form_purpose: 1 },
      content: { blocks: 9 },
    };
    assert.deepEqual(Object.keys(expectations).sort(), KINDS.slice().sort());
    for (const [kind, wanted] of Object.entries(expectations)) {
      const fields = extractFields(emit(kind), kind);
      for (const [key, count] of Object.entries(wanted)) {
        const value = fields[key];
        assert.notEqual(value, undefined, `${kind}.${key} did not come back at all`);
        if (Array.isArray(value)) assert.equal(value.length, count, `${kind}.${key} came back with ${value.length}`);
        else assert.ok(String(value).trim().length > 0, `${kind}.${key} came back empty`);
      }
    }
  });

  test('a no-op save changes NOT ONE BYTE of the page', () => {
    const tree = KINDS.map((k) => emit(k));
    const before = JSON.stringify(tree);
    const list = reduceToSectionList(tree);
    const after = list.map((s) => (s.editable ? applyFields(s.node, s.kind, s.fields) : s.node));
    assert.equal(JSON.stringify(after), before);
  });

  test('every kind reduces to an EDITABLE row — no section we built is locked', () => {
    const list = reduceToSectionList(KINDS.map((k) => emit(k)));
    for (const row of list) {
      assert.equal(row.editable, true, `${row.kind || row.handle} came back locked: ${row.reason}`);
    }
  });

  test('what the reduction produces always validates — read then save cannot fail on its own output', () => {
    for (const kind of KINDS) {
      const [entry] = reduceToSectionList([emit(kind)]);
      const out = validateFields(kind, entry.fields);
      assert.equal(out.ok, true, `${kind}: ${JSON.stringify(out.errors)}`);
    }
  });

  test('an unstamped section is carried back byte for byte and never claims a kind', () => {
    const handBuilt = {
      id: 'hand01', elType: 'container',
      settings: { _title: 'Awards strip (built on the site)', container_type: 'flex' },
      elements: [{ id: 'hw1', elType: 'widget', widgetType: 'heading', settings: { title: 'County Build Awards 2025' } }],
      isInner: false,
    };
    const [row] = reduceToSectionList([handBuilt]);
    assert.equal(row.kind, null);
    assert.equal(row.editable, false);
    assert.equal(row.reason, 'custom');
    assert.equal(row.label, 'Custom section — built on the site');
    assert.equal(JSON.stringify(row.node), JSON.stringify(handBuilt));
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   4. Legacy pages still work
   ══════════════════════════════════════════════════════════════════════════ */

describe('a page built in the old dialect is still readable and still editable', () => {
  const legacyKinds = Object.keys(LEGACY);

  for (const kind of legacyKinds) {
    test(`${kind}: the legacy node reads back through the ordinary path`, () => {
      const node = clone(LEGACY[kind]);
      const fields = extractFields(node, kind);
      const again = extractFields(applyFields(node, kind, fields), kind);
      assert.deepEqual(again, fields, kind);
    });
  }

  test('editing a legacy page keeps it in the legacy dialect — we never silently rewrite a live page', () => {
    const node = clone(LEGACY.services);
    const fields = extractFields(node, 'services');
    const patched = applyFields(node, 'services', { ...fields, headline: 'Changed' });
    assert.equal(patched.elType, 'section');
    assert.ok(elTypesOn(patched).includes('column'));
    assert.equal(extractFields(patched, 'services').headline, 'Changed');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   5. The free section
   ══════════════════════════════════════════════════════════════════════════ */

describe('the free section — words, pictures, buttons, video', () => {
  test('every block kind the builder offers has a codec here', () => {
    assert.deepEqual(listContentBlockKinds(), [
      'heading', 'paragraph', 'list', 'image', 'button', 'video', 'map', 'divider', 'spacer',
    ]);
    for (const [kind, spec] of Object.entries(CONTENT_BLOCK_KINDS)) {
      assert.ok(spec.widget, `${kind} names an Elementor widget`);
      assert.ok(spec.label, `${kind} has a label a person can read`);
      assert.ok(spec.defaults && typeof spec.defaults === 'object', `${kind} has defaults`);
    }
  });

  test('columns survive: a block put in column 2 comes back in column 2', () => {
    const node = emit('content');
    const blocks = readContentBlocks(node);
    assert.equal(countColumns(node), 2);
    assert.deepEqual(
      blocks.filter((b) => b.col === 1).map((b) => b.kind),
      ['image', 'button', 'divider', 'spacer', 'video', 'map'],
    );
  });

  test('a paragraph can become a heading without a second editor', () => {
    const node = emit('content');
    const fields = extractFields(node, 'content');
    const i = fields.blocks.findIndex((b) => b.kind === 'paragraph');
    const next = fields.blocks.map((b, j) => (j === i ? { kind: 'heading', text: 'Now a heading', level: 'h3', align: 'left', col: b.col } : b));
    const out = extractFields(applyFields(node, 'content', { ...fields, blocks: next }), 'content');
    assert.equal(out.blocks[i].kind, 'heading');
    assert.equal(out.blocks[i].text, 'Now a heading');
    assert.equal(out.blocks[i].level, 'h3');
  });

  test('editing the words KEEPS the Elementor ids — an edit must not churn the page', () => {
    const node = emit('content');
    const fields = extractFields(node, 'content');
    const idsOf = (n) => { const out = []; walk(n, (x) => { if (x.elType === 'widget') out.push(x.id); }); return out; };
    const before = idsOf(node);
    const patched = applyFields(node, 'content', {
      ...fields,
      blocks: fields.blocks.map((b) => (b.kind === 'heading' ? { ...b, text: 'Edited' } : b)),
    });
    assert.deepEqual(idsOf(patched), before);
  });

  test('changing from three columns to one keeps every block — nothing is dropped', () => {
    const node = emit('content');
    const fields = extractFields(node, 'content');
    const one = applyFields(node, 'content', {
      layout: 1,
      blocks: fields.blocks.map((b) => ({ ...b, col: 0 })),
    });
    assert.equal(countColumns(one), 1);
    assert.equal(readContentBlocks(one).length, fields.blocks.length);
  });

  test('a block kind we have never heard of is refused BY NAME, never published', () => {
    const out = validateFields('content', { layout: 1, blocks: [{ kind: 'carousel_3000', col: 0 }] });
    assert.equal(out.ok, false);
    assert.match(out.errors[0].message, /carousel_3000/);
  });

  test('a layout that is not 1, 2 or 3 is refused', () => {
    assert.equal(validateFields('content', { layout: 7, blocks: [] }).ok, false);
    for (const n of [1, 2, 3]) assert.equal(validateFields('content', { layout: n, blocks: [] }).ok, true);
  });

  test('an EMPTY free section is still ours — it does not come back as somebody else\'s work', () => {
    const empty = blockToElementorSection({
      kind: 'content', block: { layout: 1, blocks: [] }, brand: GOLDEN_BRAND, seedId: 'e', blockId: 'e',
    });
    const [row] = reduceToSectionList([empty]);
    assert.equal(row.kind, 'content');
    assert.equal(row.editable, true);
    assert.deepEqual(row.fields.blocks, []);
    assert.equal(row.fields.layout, 1);
    // Every section carries its own look, so the toolbar's background, padding
    // and heading font publish rather than only changing the canvas.
    assert.deepEqual(Object.keys(row.fields.style).sort(), ['background', 'headingFont', 'padding']);
  });

  test('a bullet list round-trips AS a list, not as a paragraph with line breaks', () => {
    const node = emit('content');
    const fields = extractFields(node, 'content');
    const list = fields.blocks.find((b) => b.kind === 'list');
    assert.deepEqual(list.items, ['Two-inch trigger', 'Salt on every visit', 'Photos on completion']);
    const patched = applyFields(node, 'content', fields);
    let html = '';
    walk(patched, (n) => { if (n.settings?.[BLOCK_MARKER] === 'list') html = n.settings.editor; });
    assert.match(html, /^<ul><li>/);
  });

  test('every content widget carries both stamps, and every column carries its index', () => {
    const node = emit('content');
    let widgets = 0;
    walk(node, (n) => {
      if (n.elType !== 'widget') return;
      widgets += 1;
      assert.equal(n.settings._ia_field, 'content.blocks');
      assert.ok(CONTENT_BLOCK_KINDS[n.settings[BLOCK_MARKER]], `unknown block stamp ${n.settings[BLOCK_MARKER]}`);
    });
    assert.equal(widgets, 9);
    const cols = [];
    walk(node, (n) => { if (n.settings?.[COLUMN_MARKER] != null) cols.push(n.settings[COLUMN_MARKER]); });
    assert.deepEqual(cols, [0, 1]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   6. Adding a section
   ══════════════════════════════════════════════════════════════════════════ */

describe('add a section', () => {
  test('every kind can be added, and what comes back is editable', () => {
    for (const kind of KINDS) {
      const built = buildStarterSection(kind, GOLDEN_BRAND);
      assert.equal(built.ok, true, `${kind}: ${built.message}`);
      const [row] = reduceToSectionList([built.node]);
      assert.equal(row.editable, true, kind);
      assert.equal(row.kind, kind);
      assert.deepEqual(elTypesOn(built.node), ['container', 'widget'], kind);
    }
  });

  test('a contact section with nowhere to send enquiries is REFUSED, not published dead', () => {
    const built = buildStarterSection('contact', { business_name: 'No Email Ltd' });
    assert.equal(built.ok, false);
    assert.equal(built.code, 'form_recipient_missing');
    assert.match(built.message, /notification email/i);
  });
});
