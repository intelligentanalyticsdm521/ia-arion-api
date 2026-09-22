/**
 * test/website-content-vocabulary.test.mjs — ONE vocabulary for what a website
 * page may hold.
 *
 * THE DEFECT (B-168, 2026-09-19). The website builder's left panel offers the
 * eight families' widgets. A "Words and pictures" section holding any of them
 * could not be SAVED: `validateFields` asked `CONTENT_BLOCK_KINDS`, a
 * hand-written nine-row table, and refused everything else by name —
 * *We do not have a part called "icon_box"*. The real vocabulary is
 * `ELEMENTOR_WIDGETS`, 88 rows fed by `families/&#42;/emitters.js`. Two
 * vocabularies for one concern, and the narrow one was the gate.
 *
 * What this file pins:
 *   1. THE GATE IS THE MERGED VOCABULARY, not a copy of it — the allowed set
 *      is exactly `CONTENT_BLOCK_KINDS ∪ {container} ∪ ELEMENTOR_WIDGETS`, so a
 *      private list cannot grow back beside it.
 *   2. A FAMILY KIND IS ACCEPTED, and a kind NOTHING can emit is still refused
 *      by name, in the same plain sentence.
 *   3. BUILD THEN READ BACK, as EQUALITY, for ten widgets from six families
 *      plus a nested box — what the author saved is what they reopen.
 *   4. THE REAL WIDGET ARRIVES — each block publishes under the page engine's
 *      own `widgetType`, through its emitter and not through a second table.
 *   5. A BOX SURVIVES, with its layout and at depth, and its children come
 *      back INSIDE it rather than a second time at the top level.
 *   6. A WIDGET THIS SITE CANNOT DRAW IS REFUSED BY NAME, never swallowed.
 *
 * MUTATION CHECKS, written down so the next person can re-run them
 * (each one done, seen red, restored — 2026-09-19):
 *   · make `blockKindAllowed` ask only CONTENT_BLOCK_KINDS  → "a family kind
 *     is accepted" red, "the gate IS the merged vocabulary" red
 *   · make `blockKindAllowed` return true for everything     → "a kind nothing
 *     can emit is refused BY NAME" red
 *   · drop `_ia_props` from `buildEmittedWidget`             → "read back" red
 *   · let `readContentBlocks` descend past a stamped node    → "a box's
 *     children come back INSIDE it" red
 *   · make `buildEmittedWidget` publish `spec.widget`        → "the real widget
 *     arrives" red
 *   · swallow `UnsupportedWidgetError` in `buildEmittedWidget`  → "refused by
 *     name" red
 *   · make the nine read only their own field names           → "a <kind> the
 *     PANEL wrote reaches the website" red, six of them
 *   · drop `_ia_props` from the nine                          → "the panel gets
 *     its OWN keys back" red
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateFields, applyFields, extractFields, reduceToSectionList,
  blockKindAllowed, listAllowedBlockKinds, listContentBlockKinds,
  CONTENT_BLOCK_KINDS, BLOCK_MARKER, PROPS_MARKER,
  CONTAINER_BLOCK_KIND, BLOCK_CHILDREN_KEY, BLOCK_STYLE_KEY, MAX_BLOCK_DEPTH,
} from '../lib/websiteBuilder/sectionSchema.js';
import { blockToElementorSection } from '../lib/websiteBuilder/elementorAdapter.js';
import {
  ELEMENTOR_WIDGETS, listWidgetKinds, proWidgetKinds, swapWillFire,
} from '../lib/websiteBuilder/elementorWidgets.js';

const BRAND = Object.freeze({
  businessName: 'Summit Lawn & Landscape',
  email: 'hello@summit.invalid',
  primaryColor: '#1f7a3f',
});

/** An empty free section, exactly as "add a Words and pictures section" makes one. */
const emptySection = () => blockToElementorSection({
  kind: 'content', block: { layout: 1, blocks: [] }, brand: BRAND, seedId: 't', blockId: 't',
});

const CTX = Object.freeze({ allowPro: true, iaWidgets: null, emailTo: BRAND.email });

function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  fn(node);
  (node.elements || []).forEach((child) => walk(child, fn));
}

/** Every stamped block on a built section, top level only, in page order. */
function stampedTop(section) {
  const out = [];
  const descend = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.settings?.[BLOCK_MARKER]) { out.push(n); return; }
    (n.elements || []).forEach(descend);
  };
  descend(section);
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   1. THE GATE
   ══════════════════════════════════════════════════════════════════════════ */

describe('1. the gate asks the ONE merged vocabulary', () => {
  test('the allowed set IS the union — legacy nine, the box, every emitter', () => {
    /* `opaque` joined the union on 2026-09-22 (B-168). It is the one block
       kind that is not a widget anybody can emit: it is a widget somebody
       built on their own website that we have no row for, kept on the page and
       written back byte for byte. It has to be ALLOWED or every save of every
       page that has one would be refused — which is most real pages. */
    const expected = [...new Set([
      ...listContentBlockKinds(), CONTAINER_BLOCK_KIND, 'opaque', ...listWidgetKinds(),
    ])].sort();
    assert.deepEqual(listAllowedBlockKinds(), expected);
    // And it is bigger than the nine by a lot, which is the whole point.
    assert.ok(listAllowedBlockKinds().length > 50,
      `only ${listAllowedBlockKinds().length} kinds allowed — the families are not reaching the gate`);
  });

  test('EVERY widget the families publish is a block a free section may hold', () => {
    const refused = listWidgetKinds().filter((kind) => !blockKindAllowed(kind));
    assert.deepEqual(refused, [], `these can be emitted but not saved: ${refused.join(', ')}`);
  });

  test('a family kind is ACCEPTED where it used to be refused by name', () => {
    for (const kind of ['icon_box', 'accordion', 'counter', 'testimonial', 'blockquote', 'call_to_action']) {
      assert.ok(ELEMENTOR_WIDGETS[kind], `${kind} has no emitter, so this test is asking the wrong thing`);
      const out = validateFields('content', { layout: 1, blocks: [{ kind, col: 0 }] });
      assert.equal(out.ok, true, `${kind} was refused: ${JSON.stringify(out.errors)}`);
    }
  });

  test('a kind NOTHING can emit is refused BY NAME, in the same plain sentence', () => {
    const out = validateFields('content', { layout: 1, blocks: [{ kind: 'carousel_3000', col: 0 }] });
    assert.equal(out.ok, false);
    assert.equal(out.errors[0].field, 'blocks[0].kind');
    assert.equal(out.errors[0].message, 'We do not have a part called "carousel_3000".');
    assert.equal(blockKindAllowed('carousel_3000'), false);
    assert.equal(blockKindAllowed(''), false);
    assert.equal(blockKindAllowed(null), false);
  });

  test('a kind nothing can emit is refused INSIDE a box too, at its own path', () => {
    const out = validateFields('content', {
      layout: 1,
      blocks: [{
        kind: CONTAINER_BLOCK_KIND, col: 0,
        [BLOCK_CHILDREN_KEY]: [{ kind: 'heading' }, { kind: 'carousel_3000' }],
      }],
    });
    assert.equal(out.ok, false);
    assert.equal(out.errors[0].field, `blocks[0].${BLOCK_CHILDREN_KEY}[1].kind`);
    assert.match(out.errors[0].message, /carousel_3000/);
  });

  test('only a box may hold other parts, and boxes do not nest forever', () => {
    const notABox = validateFields('content', {
      layout: 1, blocks: [{ kind: 'heading', col: 0, [BLOCK_CHILDREN_KEY]: [{ kind: 'heading' }] }],
    });
    assert.equal(notABox.ok, false);
    assert.match(notABox.errors[0].message, /Only a box can hold other parts/);

    let deep = { kind: 'heading' };
    for (let i = 0; i < MAX_BLOCK_DEPTH + 2; i += 1) {
      deep = { kind: CONTAINER_BLOCK_KIND, [BLOCK_CHILDREN_KEY]: [deep] };
    }
    const tooDeep = validateFields('content', { layout: 1, blocks: [{ ...deep, col: 0 }] });
    assert.equal(tooDeep.ok, false);
    assert.match(tooDeep.errors[0].message, new RegExp(`nested up to ${MAX_BLOCK_DEPTH} deep`));
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   2. TEN WIDGETS, SIX FAMILIES, ONE NESTED BOX — saved, and reopened
   ══════════════════════════════════════════════════════════════════════════ */

/* The ten the drive uses, plus the box. Every one of them was refused before
   this change; `heading` and `image` are here because a mixed section is the
   real case, and they still take the legacy codec path. */
const BLOCKS = () => ([
  { kind: 'heading', col: 0, text: 'Summit Lawn & Landscape', level: 'h2', align: 'center' },
  { kind: 'paragraph', col: 0, text: ['We mow, we plough, we show up.'] },
  { kind: 'image', col: 0, url: 'https://x.invalid/lawn.jpg', alt: 'A cut lawn', id: 12, caption: '' },
  { kind: 'button', col: 0, label: 'Get a quote', href: '/quote', align: 'center' },
  { kind: 'icon_box', col: 0, title: 'Weekly mowing', description: 'Every Tuesday.', icon: 'leaf', view: 'stacked', shape: 'circle' },
  { kind: 'accordion', col: 0, items: [{ title: 'Do you salt?', content: 'Every visit.' }] },
  { kind: 'counter', col: 0, ending_number: 240, prefix: '', suffix: '+', title: 'Lawns cut' },
  { kind: 'testimonial', col: 0, content: 'Best crew in town.', name: 'Dana R.', title: 'Homeowner', position: 'aside' },
  { kind: 'blockquote', col: 0, quote: 'Grass does not cut itself.', author: 'Brandon' },
  { kind: 'call_to_action', col: 0, title: 'Book the spring clean-up', description: 'Slots go fast.', button: 'Book now', link: '/book' },
  {
    kind: CONTAINER_BLOCK_KIND, col: 0,
    [BLOCK_STYLE_KEY]: { direction: 'row', justify: 'center', gap: 16 },
    [BLOCK_CHILDREN_KEY]: [
      { kind: 'heading', text: 'Inside the box', level: 'h3', align: 'left' },
      { kind: 'alert', title: 'Heads up', description: 'We plough after two inches.', alert_type: 'info' },
    ],
  },
]);

/** What the page engine calls each of them. Read off the emitters, not guessed. */
const WIDGET_TYPES = Object.freeze({
  heading: 'heading',
  paragraph: 'text-editor',
  image: 'image',
  button: 'button',
  icon_box: 'icon-box',
  accordion: 'nested-accordion',
  counter: 'counter',
  testimonial: 'testimonial',
  blockquote: 'blockquote',
  call_to_action: 'call-to-action',
});

describe('2. ten widgets from six families, saved and reopened', () => {
  const built = () => applyFields(emptySection(), 'content', { layout: 1, blocks: BLOCKS() }, CTX);

  test('the whole page saves — nothing in it is refused', () => {
    const out = validateFields('content', { layout: 1, blocks: BLOCKS() });
    assert.equal(out.ok, true, JSON.stringify(out.errors));
  });

  test('the REAL widget arrives: each block publishes under the engine\'s own widgetType', () => {
    const nodes = stampedTop(built());
    assert.equal(nodes.length, BLOCKS().length);
    // The STAMP says which of ours each node is, and it has to be the kind the
    // author dragged — not `paragraph`, which is what the old table answered
    // for every widget it had never heard of.
    assert.deepEqual(nodes.map((n) => n.settings[BLOCK_MARKER]), BLOCKS().map((b) => b.kind));
    for (const node of nodes) {
      const kind = node.settings[BLOCK_MARKER];
      if (kind === CONTAINER_BLOCK_KIND) { assert.equal(node.elType, 'container'); continue; }
      assert.equal(node.elType, 'widget');
      assert.equal(node.widgetType, WIDGET_TYPES[kind], `${kind} published as ${node.widgetType}`);
      assert.equal(node.settings._ia_field, 'content.blocks');
    }
  });

  test('READ BACK: every widget and every value the author set comes back', () => {
    const back = extractFields(built(), 'content');
    assert.equal(back.layout, 1);
    assert.deepEqual(back.blocks.map((b) => b.kind), BLOCKS().map((b) => b.kind));
    for (const sent of BLOCKS()) {
      const got = back.blocks.find((b) => b.kind === sent.kind);
      for (const [key, value] of Object.entries(sent)) {
        if (key === 'kind' || key === 'col') continue;
        assert.deepEqual(got[key], value, `${sent.kind}.${key} did not survive the round trip`);
      }
    }
  });

  test('a family widget carries its props beside its settings, which is HOW it comes back', () => {
    const iconBox = stampedTop(built()).find((n) => n.settings[BLOCK_MARKER] === 'icon_box');
    assert.deepEqual(iconBox.settings[PROPS_MARKER], {
      title: 'Weekly mowing', description: 'Every Tuesday.', icon: 'leaf', view: 'stacked', shape: 'circle',
    });
    // And the page-engine settings are still the truth the website draws from.
    assert.equal(iconBox.settings.title_text, 'Weekly mowing');
  });

  test('SAVING WHAT YOU REOPENED CHANGES NOTHING — the no-op save', () => {
    const once = built();
    const back = extractFields(once, 'content');
    const twice = applyFields(once, 'content', back, CTX);
    assert.deepEqual(extractFields(twice, 'content'), back);
    // Ids do not churn either: an edit that changed nothing must not rewrite
    // every Elementor id on somebody's live page.
    const ids = (s) => { const out = []; walk(s, (n) => { if (n.id) out.push(n.id); }); return out; };
    assert.deepEqual(ids(twice), ids(once));
  });

  test('the section is still OURS and still editable after a family widget lands in it', () => {
    const [row] = reduceToSectionList([built()]);
    assert.equal(row.kind, 'content');
    assert.equal(row.editable, true);
    assert.equal(row.fields.blocks.length, BLOCKS().length);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   3. THE BOX
   ══════════════════════════════════════════════════════════════════════════ */

describe('3. a box, and what is inside it', () => {
  const withBox = (children, style = { direction: 'row' }) => applyFields(
    emptySection(), 'content',
    { layout: 1, blocks: [{ kind: CONTAINER_BLOCK_KIND, col: 0, [BLOCK_STYLE_KEY]: style, [BLOCK_CHILDREN_KEY]: children }] },
    CTX,
  );

  test('a box publishes as a real container, arranged the way the author arranged it', () => {
    const node = stampedTop(withBox([{ kind: 'heading', text: 'Hi', level: 'h3', align: 'left' }]))[0];
    assert.equal(node.elType, 'container');
    assert.equal(node.isInner, true);
    assert.equal(node.settings.container_type, 'flex');
    assert.equal(node.settings.flex_direction, 'row');
    assert.equal(node.elements.length, 1);
    assert.equal(node.elements[0].widgetType, 'heading');
  });

  test("a box's children come back INSIDE it, not a second time at the top level", () => {
    const section = withBox([
      { kind: 'heading', text: 'Inside', level: 'h3', align: 'left' },
      { kind: 'icon_box', title: 'Salt', description: 'Every visit.' },
    ]);
    const back = extractFields(section, 'content');
    assert.deepEqual(back.blocks.map((b) => b.kind), [CONTAINER_BLOCK_KIND]);
    assert.deepEqual(
      back.blocks[0][BLOCK_CHILDREN_KEY].map((b) => b.kind),
      ['heading', 'icon_box'],
    );
    assert.equal(back.blocks[0][BLOCK_CHILDREN_KEY][1].title, 'Salt');
  });

  test('a box inside a box inside a box survives, with the widget at the bottom', () => {
    const deep = {
      kind: CONTAINER_BLOCK_KIND, col: 0, [BLOCK_STYLE_KEY]: { direction: 'column' },
      [BLOCK_CHILDREN_KEY]: [{
        kind: CONTAINER_BLOCK_KIND, [BLOCK_STYLE_KEY]: { direction: 'row' },
        [BLOCK_CHILDREN_KEY]: [{
          kind: CONTAINER_BLOCK_KIND,
          [BLOCK_CHILDREN_KEY]: [{ kind: 'counter', ending_number: 7, title: 'Trucks' }],
        }],
      }],
    };
    assert.equal(validateFields('content', { layout: 1, blocks: [deep] }).ok, true);
    const back = extractFields(applyFields(emptySection(), 'content', { layout: 1, blocks: [deep] }, CTX), 'content');
    const bottom = back.blocks[0][BLOCK_CHILDREN_KEY][0][BLOCK_CHILDREN_KEY][0][BLOCK_CHILDREN_KEY][0];
    assert.equal(bottom.kind, 'counter');
    assert.equal(bottom.ending_number, 7);
    assert.equal(bottom.title, 'Trucks');
  });

  test('a box keeps its own layout across the round trip', () => {
    const style = { direction: 'row', justify: 'between', alignItems: 'center', wrap: true };
    const back = extractFields(withBox([{ kind: 'heading', text: 'x' }], style), 'content');
    assert.deepEqual(back.blocks[0][BLOCK_STYLE_KEY], style);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   4. WHAT THIS SITE CANNOT DRAW
   ══════════════════════════════════════════════════════════════════════════ */

describe('4. a widget this site cannot draw is refused BY NAME', () => {
  /** A paid widget with NO fallback — the one shape that has to refuse. */
  const noFallback = proWidgetKinds().find((k) => !swapWillFire(ELEMENTOR_WIDGETS[k], { allowPro: false }));

  test('there IS such a widget, or this whole section is testing nothing', () => {
    assert.ok(noFallback, 'every Pro widget has a fallback — re-read the catalogue before deleting this');
  });

  test('a plan without the paid add-on gets the sentence, not a silent blank', () => {
    assert.throws(
      () => applyFields(emptySection(), 'content',
        { layout: 1, blocks: [{ kind: noFallback, col: 0 }] },
        { allowPro: false, iaWidgets: null }),
      (err) => {
        assert.equal(err.code, 'WIDGET_NOT_ON_PLAN');
        assert.match(err.message, /ARION Standard and above/);
        // And it says WHICH widget, because a page with eleven things on it
        // needs more than 'something here is not on your plan'.
        assert.ok(err.message.startsWith(`${ELEMENTOR_WIDGETS[noFallback].label}: `), err.message);
        assert.doesNotMatch(err.message, /Elementor/i);
        return true;
      },
    );
  });

  test('and the SAME widget publishes fine on a plan that has it', () => {
    const node = stampedTop(applyFields(emptySection(), 'content',
      { layout: 1, blocks: [{ kind: noFallback, col: 0 }] }, CTX))[0];
    assert.equal(node.settings[BLOCK_MARKER], noFallback);
    assert.equal(node.widgetType || node.elType, ELEMENTOR_WIDGETS[noFallback].widgetType || 'container');
  });

  test('a box too deep to publish throws rather than quietly losing what is inside it', () => {
    let deep = { kind: 'heading', text: 'bottom' };
    for (let i = 0; i < MAX_BLOCK_DEPTH + 2; i += 1) {
      deep = { kind: CONTAINER_BLOCK_KIND, [BLOCK_CHILDREN_KEY]: [deep] };
    }
    assert.throws(
      () => applyFields(emptySection(), 'content', { layout: 1, blocks: [{ ...deep, col: 0 }] }, CTX),
      (err) => err.code === 'WIDGET_NOT_ON_PLAN' && /nested up to/.test(err.message),
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   5. THE NINE STILL BEHAVE — nothing above changed what already worked
   ══════════════════════════════════════════════════════════════════════════ */

describe('5. the legacy nine are untouched', () => {
  test('their table is still the nine, and each still has its codec', () => {
    assert.deepEqual(listContentBlockKinds(), [
      'heading', 'paragraph', 'list', 'image', 'button', 'video', 'map', 'divider', 'spacer',
    ]);
    for (const spec of Object.values(CONTENT_BLOCK_KINDS)) assert.ok(spec.widget && spec.defaults);
  });

  test('a paragraph can still become a heading, and keeps its Elementor id', () => {
    const before = applyFields(emptySection(), 'content',
      { layout: 1, blocks: [{ kind: 'paragraph', col: 0, text: ['Hello'] }] }, CTX);
    const id = stampedTop(before)[0].id;
    const after = applyFields(before, 'content',
      { layout: 1, blocks: [{ kind: 'heading', col: 0, text: 'Hello', level: 'h3', align: 'left' }] }, CTX);
    const node = stampedTop(after)[0];
    assert.equal(node.id, id);
    assert.equal(node.settings[BLOCK_MARKER], 'heading');
  });

  /* ── THE PANEL'S SPELLING, on the nine ────────────────────────────────
   * Found by DRIVING it against the dev website, 2026-09-19: a Button dropped
   * from the widget panel published with no words on it. The panel's controls
   * are the page engine's names (`text`, `link`, `image`, `space`,
   * `header_size`, `icon_list`); these nine were written before the panel and
   * their fields are ours (`label`, `href`, `url`, `height`, `level`, `items`).
   * Same defect as the gate, one layer down. */
  const PANEL_SPELLING = [
    ['button', { text: 'Get a quote', link: '/quote' }, (s) => {
      assert.equal(s.text, 'Get a quote');
      assert.equal(s.link.url, '/quote');
    }],
    ['image', { image: { url: 'https://x.invalid/a.jpg', id: 44 }, alt: 'A lawn' }, (s) => {
      assert.equal(s.image.url, 'https://x.invalid/a.jpg');
      assert.equal(s.image.id, 44);
    }],
    ['video', { youtube_url: 'https://youtu.be/abc' }, (s) => assert.equal(s.youtube_url, 'https://youtu.be/abc')],
    ['spacer', { space: 96 }, (s) => assert.equal(Number(s.space.size), 96)],
    ['heading', { text: 'Hi', header_size: 'h3' }, (s) => {
      assert.equal(s.title, 'Hi');
      assert.equal(s.header_size, 'h3');
    }],
    ['list', { icon_list: [{ text: 'One' }, { text: 'Two' }] }, (s) => {
      assert.equal(s.editor, '<ul><li>One</li><li>Two</li></ul>');
    }],
  ];

  for (const [kind, props, check] of PANEL_SPELLING) {
    test(`a ${kind} the PANEL wrote reaches the website with its values`, () => {
      const node = stampedTop(applyFields(emptySection(), 'content',
        { layout: 1, blocks: [{ kind, col: 0, ...props }] }, CTX))[0];
      check(node.settings);
    });
  }

  test('and the panel gets its OWN keys back, not ours — one answer, never two', () => {
    const blocks = [
      { kind: 'button', col: 0, text: 'Get a quote', link: '/quote' },
      { kind: 'spacer', col: 0, space: 96 },
    ];
    const back = extractFields(applyFields(emptySection(), 'content', { layout: 1, blocks }, CTX), 'content');
    assert.deepEqual(back.blocks, blocks);
    // Not both spellings: a stale `label` beside a fresh `text` is an edit the
    // next save would quietly throw away.
    assert.equal('label' in back.blocks[0], false);
    assert.equal('height' in back.blocks[1], false);
  });

  test('a page published BEFORE this change still reads, through the codec', () => {
    const built = applyFields(emptySection(), 'content',
      { layout: 1, blocks: [{ kind: 'button', col: 0, label: 'Old', href: '/old', align: 'left' }] }, CTX);
    // Strip the props stamp — which is exactly what an older page has.
    walk(built, (n) => { if (n.settings?.[PROPS_MARKER]) delete n.settings[PROPS_MARKER]; });
    const back = extractFields(built, 'content');
    assert.deepEqual(back.blocks, [{ kind: 'button', label: 'Old', href: '/old', align: 'left', col: 0 }]);
  });

  test('a divider keeps its own `style` prop — the reserved keys cannot collide', () => {
    const back = extractFields(applyFields(emptySection(), 'content',
      { layout: 1, blocks: [{ kind: 'divider', col: 0 }, { kind: 'progress_bar', col: 0, title: 'Spring', percent: 60 }] },
      CTX), 'content');
    assert.equal(back.blocks[0].kind, 'divider');
    assert.equal(back.blocks[1].title, 'Spring');
    assert.equal(back.blocks[1].percent, 60);
  });
});
