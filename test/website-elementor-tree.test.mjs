/**
 * test/website-elementor-tree.test.mjs — containers at any depth, and the plan.
 *
 * D-156 / D-157. Brandon's sentence is the acceptance row:
 *
 *   "Header, drag that into this box and it's now its own section inside the
 *    box, then a text field under it with Pick One, then cards … custom cards
 *    where they just type the card headers, add a price, and description inside
 *    the cards, or product cards where they can directly load products/services
 *    from their actual OLIVER Product Catalog."
 *
 * What this file pins:
 *   1. TREE — a box inside a box inside a box comes out as containers, at the
 *      depth it went in, with the engine's own settings keys.
 *   2. ROUND TRIP — what we publish reads back as the tree we sent.
 *   3. THE PLAN — every widget declares what it needs; a Lite business gets a
 *      real card drawn out of free widgets and is TOLD; a Standard one gets
 *      the paid widget; a widget with no fallback is refused by name.
 *   4. BRANDON'S SENTENCE — built as a tree and asserted as an outline.
 *
 * MUTATION CHECKS — each made red on purpose on 2026-09-17, then restored:
 *   M1 `treeToElementor` always passes depth 0 to children
 *        → "a box inside a box keeps its depth" red (isInner wrong at depth 1)
 *   M2 `resolveWidget` ignores `allowPro` (never swaps)
 *        → "a Lite business gets the card as free widgets" red
 *   M3 `lockSentence` returns null for a pro widget on Lite
 *        → "the lock says what the business gets instead" red
 *   M4 `styleToSettings` drops the phone layer
 *        → "a phone override reaches the page" red
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  treeToElementor, pageToElementor, elementorToTree, elementorToPage,
  documentToTree, styleToSettings, settingsToStyle, layoutToSettings, outline,
  NODE_MARKER, WIDGET_MARKER,
} from '../lib/websiteBuilder/elementorTree.js';
import {
  ELEMENTOR_WIDGETS, listWidgetKinds, widgetTier, proWidgetKinds, iaWidgetKinds,
  lockSentence, resolveWidget, UnsupportedWidgetError, PRO_LOCK_SENTENCE,
} from '../lib/websiteBuilder/elementorWidgets.js';

/* ── the page Brandon described ───────────────────────────────────────────
 * A box, with a heading and a line of text in it, then a row of two cards:
 * one the author typed, one loaded from their own catalogue.                */
const CHOOSE_YOUR_PLAN = {
  id: 'sec1',
  type: 'container',
  layout: 'column',
  label: 'Choose your plan',
  children: [
    { id: 'h1', type: 'widget', kind: 'heading', props: { text: 'Choose your plan', level: 'h2' } },
    { id: 'p1', type: 'widget', kind: 'paragraph', props: { text: 'Pick one' } },
    {
      id: 'row1',
      type: 'container',
      layout: 'row',
      children: [
        {
          id: 'c1',
          type: 'widget',
          kind: 'card',
          props: {
            heading: 'Garden tidy', price: '£120', period: 'month',
            description: 'Every fortnight, April to October.',
            features_list: [{ item_text: 'Lawn cut' }, { item_text: 'Edges done' }],
            button_text: 'Choose this', show_ribbon: true, ribbon_preset: 'recommended',
          },
        },
        {
          id: 'c2',
          type: 'widget',
          kind: 'catalog_card',
          props: {
            _ia_source: 'oliver:catalogue',
            _ia_selection: { offering_id: 'svc-441', price_id: 'pr-441' },
            refresh: 'live',
            on_empty: 'hide',
            overrides: { heading: 'Full maintenance', button_text: 'Choose this' },
          },
        },
      ],
    },
  ],
};

const PRO = { allowPro: true, iaWidgets: ['ia_product_cards'], seed: 'walk' };
const LITE = { allowPro: false, iaWidgets: ['ia_product_cards'], seed: 'walk' };

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
   1. Containers, at any depth
   ══════════════════════════════════════════════════════════════════════════ */

describe('our tree becomes the page engine\'s tree', () => {
  test('not one node is a legacy section or column, at any depth', () => {
    const node = treeToElementor(CHOOSE_YOUR_PLAN, PRO);
    assert.deepEqual(elTypesOn(node), ['container', 'widget']);
  });

  test('a box inside a box keeps its depth, and only the top one is an outer band', () => {
    const three = {
      id: 'a', type: 'container', layout: 'column',
      children: [{
        id: 'b', type: 'container', layout: 'row',
        children: [{
          id: 'c', type: 'container', layout: 'column',
          children: [{ id: 'h', type: 'widget', kind: 'heading', props: { text: 'Three deep' } }],
        }],
      }],
    };
    const node = treeToElementor(three, PRO);
    assert.equal(node.isInner, false);
    assert.equal(node.elements[0].isInner, true);
    assert.equal(node.elements[0].elements[0].isInner, true);
    assert.equal(node.elements[0].elements[0].elements[0].widgetType, 'heading');
    assert.deepEqual(outline(three), [
      'container(column)',
      '  container(row)',
      '    container(column)',
      '      widget(heading)',
    ]);
  });

  test('a row says row and a column says column, in the engine\'s own words', () => {
    const node = treeToElementor(CHOOSE_YOUR_PLAN, PRO);
    assert.equal(node.settings.container_type, 'flex');
    assert.equal(node.settings.flex_direction, 'column');
    const row = node.elements[2];
    assert.equal(row.settings.flex_direction, 'row');
    assert.equal(row.settings.flex_align_items, 'stretch');
    // A row the author said nothing about wrapping does not carry a wrap at
    // all — the page engine's own default then applies, which is the same
    // `nowrap` the canvas draws. `flex_wrap: 'wrap'` used to be hardcoded
    // here, which silently contradicted an author who turned wrapping off
    // (audit point 1).
    assert.equal(row.settings.flex_wrap, undefined);
    // ...and a row stacks on a phone, because the canvas stacks it there.
    assert.equal(row.settings.flex_direction_mobile, 'column');
  });

  test('a grid asks for the grid controls, not the flex ones', () => {
    const s = layoutToSettings({ layout: 'grid', columns: 3 }, 1);
    assert.equal(s.container_type, 'grid');
    assert.equal(s.grid_columns_grid.size, 3);
    assert.ok(s.grid_gaps, 'a grid has its own gap control');
    assert.equal(s.flex_direction, undefined);
  });

  test('only the outer band gets the page\'s own padding — an inner box is not indented twice', () => {
    assert.ok(layoutToSettings({ layout: 'column' }, 0).padding);
    assert.equal(layoutToSettings({ layout: 'column' }, 1).padding, undefined);
  });

  test('emitting twice from one seed is byte-identical — the page\'s history does not churn', () => {
    const a = JSON.stringify(treeToElementor(CHOOSE_YOUR_PLAN, PRO));
    const b = JSON.stringify(treeToElementor(CHOOSE_YOUR_PLAN, PRO));
    assert.equal(a, b);
  });

  test('a node that is neither a box nor a widget is refused BY NAME, never published', () => {
    assert.throws(
      () => treeToElementor({ id: 'x', type: 'doodad' }, PRO),
      (e) => e instanceof UnsupportedWidgetError && /doodad/.test(e.message),
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   2. Style
   ══════════════════════════════════════════════════════════════════════════ */

describe('the author\'s styling reaches the page', () => {
  test('a phone override reaches the page, on the engine\'s own suffix', () => {
    const s = styleToSettings({
      padding: { top: 64, right: 20, bottom: 64, left: 20 },
      phone: { padding: { top: 24, right: 12, bottom: 24, left: 12 } },
    });
    assert.equal(s.padding.top, '64');
    assert.equal(s.padding_mobile.top, '24');
  });

  test('a style nobody set writes nothing — an empty background does not paint over a picture', () => {
    assert.deepEqual(styleToSettings(undefined), {});
    assert.deepEqual(styleToSettings({}), {});
    assert.equal('background_color' in styleToSettings({ radius: 8 }), false);
  });

  test('style survives the round trip', () => {
    const style = {
      padding: { top: 40, right: 16, bottom: 40, left: 16 },
      background: '#F4F7F8',
      radius: 12,
      border: { style: 'solid', width: 1, color: '#CBD5E1' },
      shadow: 'soft',
      phone: { padding: { top: 16, right: 8, bottom: 16, left: 8 } },
    };
    const back = settingsToStyle(styleToSettings(style));
    assert.deepEqual(back.padding, style.padding);
    assert.equal(back.background, '#F4F7F8');
    assert.equal(back.radius, 12);
    assert.equal(back.shadow, 'soft');
    assert.deepEqual(back.phone.padding, style.phone.padding);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   3. Read it back
   ══════════════════════════════════════════════════════════════════════════ */

describe('what we publish reads back as the tree we sent', () => {
  test('every node carries our own id, so the page can be read back', () => {
    const node = treeToElementor(CHOOSE_YOUR_PLAN, PRO);
    const ids = [];
    walk(node, (n) => { if (n.settings?.[NODE_MARKER]) ids.push(n.settings[NODE_MARKER]); });
    assert.deepEqual(ids.sort(), ['c1', 'c2', 'h1', 'p1', 'row1', 'sec1']);
  });

  test('every widget says which of ours it is', () => {
    const node = treeToElementor(CHOOSE_YOUR_PLAN, PRO);
    const kinds = [];
    walk(node, (n) => { if (n.settings?.[WIDGET_MARKER]) kinds.push(n.settings[WIDGET_MARKER]); });
    assert.deepEqual(kinds, ['heading', 'paragraph', 'card', 'catalog_card']);
  });

  test('the outline of the page we read back is the outline of the page we sent', () => {
    const { data } = pageToElementor([CHOOSE_YOUR_PLAN], PRO);
    const back = elementorToPage(data);
    assert.deepEqual(outline(back[0]), outline(CHOOSE_YOUR_PLAN));
  });

  test('a page somebody built on the site itself reads as boxes, never as an error', () => {
    const handBuilt = {
      id: 'x1', elType: 'section', settings: { structure: '20' },
      elements: [{
        id: 'x2', elType: 'column', settings: { _column_size: 50 },
        elements: [{ id: 'x3', elType: 'widget', widgetType: 'heading', settings: { title: 'Awards' } }],
      }],
    };
    const tree = elementorToTree(handBuilt);
    assert.equal(tree.type, 'container');
    assert.equal(tree.children[0].children[0].kind, 'heading');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   4. The plan
   ══════════════════════════════════════════════════════════════════════════ */

describe('every widget declares what plan it needs', () => {
  test('there is no widget without a tier, and no tier we do not recognise', () => {
    for (const kind of listWidgetKinds()) {
      const tier = widgetTier(kind);
      assert.ok(tier, `${kind} has no tier`);
      assert.ok(tier === 'free' || tier === 'pro' || tier.startsWith('ia:'), `${kind}: ${tier}`);
      assert.ok(ELEMENTOR_WIDGETS[kind].widgetType, `${kind} names no page widget`);
      /* D-165: a row either writes one widget's settings, or BUILDS a tree of
         free widgets (`node`) — §11.13.3's compositions. Exactly one of the
         two, because a row with both has two answers to "what gets
         published" and a row with neither publishes nothing. */
      const row = ELEMENTOR_WIDGETS[kind];
      const ways = [typeof row.settings === 'function', typeof row.node === 'function'].filter(Boolean);
      assert.equal(ways.length, 1, `${kind} must have exactly one of settings() and node()`);
    }
  });

  test('a kind we have never heard of answers null, never "free"', () => {
    assert.equal(widgetTier('carousel_3000'), null);
    assert.throws(() => resolveWidget('carousel_3000', {}, PRO), /carousel_3000/);
  });

  test('the paid ones are the paid ones, and ours are ours', () => {
    /* D-165 §11.13.3 — the whole paid panel is offered and refused by name on
       Lite, and the IA list is the one the section names. Both lists are read
       off the catalogue rather than typed anywhere else. */
    /* LANDED (B-168): the eight families each brought Elementor's own paid
       widgets with them, so this list is now the offer file's
       `website.elementor_pro` as far as the publisher has emitters for it.
       Elementor's own Reviews is `reviews` now, not `pro_reviews` - family F5
       gave it Elementor's id and the IA twin keeps `ia_reviews`. Read off the
       catalogue, never typed anywhere else. */
    assert.deepEqual(proWidgetKinds(), [
      'animated_headline', 'archive_posts', 'author_box', 'blockquote', 'call_to_action',
      'card', 'code_highlight', 'countdown', 'facebook_embed', 'facebook_page', 'flip_box',
      'form', 'hotspot', 'login', 'loop_grid', 'lottie', 'media_carousel', 'nav_menu',
      'paypal_button', 'portfolio', 'post_comments', 'post_info', 'post_navigation',
      'posts', 'price_list', 'price_table', 'pro_gallery', 'progress_tracker', 'reviews',
      'search', 'share_buttons', 'sitemap', 'slides', 'stripe_button', 'table_of_contents',
      'taxonomy_filter', 'template', 'testimonial_carousel', 'theme_archive_title',
      'theme_page_title', 'theme_post_excerpt', 'theme_post_featured_image',
      'theme_post_title', 'theme_site_logo', 'theme_site_title', 'video_playlist',
    ]);
    assert.deepEqual(iaWidgetKinds().map((w) => `${w.kind}:${w.product}`), [
      'book_now:oliver', 'catalog_card:oliver', 'hours_location:lumen',
      'ia_form:lumen', 'ia_mega_menu:arion', 'ia_mobile_menu:arion',
      'ia_oliver_invoice:oliver', 'ia_posts:arion', 'ia_reviews:lumen',
      'ia_social_links:arion', 'newsletter_signup:lumen', 'product_cards:oliver',
    ]);
  });

  test('a Standard business gets the paid card widget itself', () => {
    const { node, swapped } = resolveWidget('card', { heading: 'Garden tidy', price: '£120' }, PRO);
    assert.equal(node.widgetType, 'price-table');
    assert.equal(node.settings.heading, 'Garden tidy');
    assert.equal(swapped, null);
    assert.equal(lockSentence('card', PRO), null);
  });

  test('a Lite business gets the card as free widgets — the visitor still reads the price', () => {
    const { node, swapped } = resolveWidget('card', {
      heading: 'Garden tidy', price: '£120', period: 'month', description: 'Fortnightly',
      features_list: [{ item_text: 'Lawn cut' }],
    }, LITE);
    assert.equal(node.elType, 'container', 'the card is still a box');
    const types = [];
    walk(node, (n) => { if (n.elType === 'widget') types.push(n.widgetType); });
    assert.deepEqual(types, ['heading', 'heading', 'text-editor', 'icon-list', 'button']);
    const words = JSON.stringify(node);
    assert.ok(words.includes('Garden tidy'), 'the title reached the page');
    assert.ok(words.includes('£120'), 'the price reached the page');
    assert.ok(words.includes('Lawn cut'), 'the bullet reached the page');
    assert.equal(swapped.kind, 'card');
    assert.equal(swapped.reason, 'pro');
  });

  test('the lock says what the business gets instead, in plain words and with no vendor name', () => {
    const s = lockSentence('card', LITE);
    assert.equal(s, PRO_LOCK_SENTENCE);
    assert.match(s, /ARION Standard/);
    assert.ok(!/elementor/i.test(s), 'a vendor name reached a client sentence');
    assert.ok(!/upgrade/i.test(s), 'the sentence orders the client about');
  });

  test('a form a website cannot send with is REFUSED, never drawn', () => {
    // A picture of a form is worse than no form. The only fallback is one the
    // SITE told us it has — presence of a marker, never absence
    // (`reference_absence_based_guards_fail_open`).
    assert.throws(
      () => resolveWidget('form', { fields: [] }, LITE),
      (e) => e instanceof UnsupportedWidgetError && /ARION Standard/.test(e.message),
    );
    // Even a site that answers with SOME shortcodes, but not ours.
    assert.throws(
      () => resolveWidget('form', { fields: [] }, { ...LITE, iaShortcodes: ['ia_book_now'] }),
      (e) => e instanceof UnsupportedWidgetError,
    );
    // And when it does have ours, the Lite site gets a form that works.
    const { node: shortcode, swapped } = resolveWidget(
      'form', { emailTo: 'owner@shop.invalid' }, { ...LITE, iaShortcodes: ['ia_form'] },
    );
    assert.equal(shortcode.widgetType, 'shortcode');
    assert.match(shortcode.settings.shortcode, /^\[ia_form /);
    assert.match(shortcode.settings.shortcode, /owner@shop\.invalid/);
    assert.equal(swapped.kind, 'form');
    // And on a plan that has it, it is the real widget with the real recipient.
    const { node } = resolveWidget('form', { fields: [{ label: 'Name' }] }, { ...PRO, emailTo: 'owner@shop.invalid' });
    assert.equal(node.widgetType, 'form');
    assert.equal(node.settings.email_to, 'owner@shop.invalid');
  });

  test('a product card whose widget the website has not got falls back with the same words', () => {
    const ctx = { allowPro: true, iaWidgets: [], seed: 'x' };
    const { node, swapped } = resolveWidget('catalog_card', {
      _ia_selection: { offering_id: 'svc-1' }, overrides: { heading: 'Full maintenance' },
    }, ctx);
    assert.equal(node.elType, 'container');
    assert.ok(JSON.stringify(node).includes('Full maintenance'));
    assert.equal(swapped.reason, 'ia:oliver');
  });

  test('a page published on Lite reports every swap — a publish never claims a success it did not have', () => {
    const { data, swapped } = pageToElementor([CHOOSE_YOUR_PLAN], LITE);
    assert.deepEqual(swapped.map((s) => s.nodeId), ['c1']);
    assert.deepEqual(elTypesOn(data[0]), ['container', 'widget']);
    // ...and on Standard, nothing is swapped at all.
    assert.deepEqual(pageToElementor([CHOOSE_YOUR_PLAN], PRO).swapped, []);
  });
});

describe('the catalogue gate — what BUILDER_WIDGET_CATALOG_2026-09-17 asks of the dialect', () => {
  test('E.3.3 — a child says how it SITS in its parent, on the flex-item keys the engine uses', () => {
    const node = treeToElementor({
      id: 'r', type: 'container', layout: 'row',
      children: [{
        id: 'c', type: 'container', layout: 'column',
        flex_size: 48, flex_grow: 0, alignSelf: 'stretch', children: [],
      }],
    }, PRO);
    const child = node.elements[0];
    assert.equal(child.settings._flex_size, 'custom');
    assert.equal(child.settings.width.size, 48);
    assert.equal(child.settings._flex_grow, 0);
    assert.equal(child.settings._flex_align_self, 'stretch');
    // A node that says nothing about how it sits writes none of them.
    assert.equal('width' in node.settings, false);
    assert.equal('_flex_size' in node.settings, false);
  });

  test('`width` MEANS ONE THING — content width, never a flex size', () => {
    // Two meanings on one key (audit point 1): `layoutToSettings` read
    // `node.width` as boxed-or-full and `flexItemSettings` read the same field
    // as a percentage, so `width: 48` on a top-level node was both at once.
    const boxed = treeToElementor({ id: 'b', type: 'container', layout: 'column', width: 'full', children: [] }, PRO);
    assert.equal(boxed.settings.content_width, 'full');
    assert.equal('_flex_size' in boxed.settings, false, 'a content width became a flex size');
    const sized = treeToElementor({
      id: 'r', type: 'container', layout: 'row',
      children: [{ id: 'c', type: 'widget', kind: 'heading', props: { text: 'Hi' }, flex_size: 30 }],
    }, PRO);
    // A WIDGET has no `width` control; it says the same thing on the keys its
    // own Advanced tab carries (catalogue A.1).
    assert.equal(sized.elements[0].settings._element_width, 'initial');
    assert.equal(sized.elements[0].settings._element_custom_width.size, 30);
    assert.equal('width' in sized.elements[0].settings, false);
  });

  test('E.3.5 — the raw HTML widget exists, because it is the most-used one on the estate', () => {
    const { node } = resolveWidget('html', { html: '<p>Typed by the client</p>' }, PRO);
    assert.equal(node.widgetType, 'html');
    assert.equal(node.settings.html, '<p>Typed by the client</p>');
    assert.equal(widgetTier('html'), 'free');
  });

  test('E.3.6 — every widget carries a stamp, or it publishes once and is never editable again', () => {
    const node = treeToElementor(CHOOSE_YOUR_PLAN, PRO);
    walk(node, (n) => {
      if (n.elType !== 'widget' && n.elType !== 'container') return;
      assert.ok(n.settings[NODE_MARKER], `a node published with no stamp: ${n.widgetType || 'container'}`);
    });
  });

  test("a page we published does not read back as another person's work", async () => {
    const { reduceToSectionList } = await import('../lib/websiteBuilder/sectionSchema.js');
    const { data } = pageToElementor([CHOOSE_YOUR_PLAN], PRO);
    const [row] = reduceToSectionList(data);
    assert.equal(row.reason, 'tree');
    assert.notEqual(row.label, 'Custom section — built on the site');
    // Somebody else's really is somebody else's.
    const [theirs] = reduceToSectionList([{ id: 'x', elType: 'container', settings: { _title: 'Awards' }, elements: [] }]);
    assert.equal(theirs.reason, 'custom');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   5. Brandon's sentence
   ══════════════════════════════════════════════════════════════════════════ */

describe("Brandon's sentence, as a tree", () => {
  test('a heading in a box, a line of text under it, then a row of two cards', () => {
    assert.deepEqual(outline(CHOOSE_YOUR_PLAN), [
      'container(column)',
      '  widget(heading)',
      '  widget(paragraph)',
      '  container(row)',
      '    widget(card)',
      '    widget(catalog_card)',
    ]);
  });

  test('the typed card carries the words the author typed', () => {
    const node = treeToElementor(CHOOSE_YOUR_PLAN, PRO);
    const card = node.elements[2].elements[0];
    assert.equal(card.settings.heading, 'Garden tidy');
    assert.equal(card.settings.price, '£120');
    assert.deepEqual(card.settings.features_list.map((f) => f.item_text), ['Lawn cut', 'Edges done']);
    assert.equal(card.settings.show_ribbon, 'yes');
  });

  test('the product card is bound to the catalogue item, not to a copy of its words', () => {
    const node = treeToElementor(CHOOSE_YOUR_PLAN, PRO);
    const card = node.elements[2].elements[1];
    assert.equal(card.widgetType, 'ia_product_cards');
    assert.deepEqual(card.settings.ia_item_ids, ['svc-441']);
    assert.equal(card.settings.ia_show_price, 'yes');
    assert.equal(card.settings.ia_title_override, 'Full maintenance');
    // F.2's own words, so a client learns the Binding section once.
    assert.equal(card.settings.ia_source, 'oliver:catalogue');
    assert.equal(card.settings.ia_price_id, 'pr-441');
    assert.equal(card.settings.ia_refresh, 'live');
    assert.equal(card.settings.ia_on_empty, 'hide');
  });

  test('one card can be removed and the other duplicated — every element stands alone', () => {
    const fewer = {
      ...CHOOSE_YOUR_PLAN,
      children: CHOOSE_YOUR_PLAN.children.map((c) => (c.id === 'row1'
        ? { ...c, children: [c.children[0], { ...c.children[0], id: 'c1b' }] }
        : c)),
    };
    const node = treeToElementor(fewer, PRO);
    assert.equal(node.elements[2].elements.length, 2);
    assert.deepEqual(
      node.elements[2].elements.map((e) => e.settings[NODE_MARKER]), ['c1', 'c1b'],
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   6. The Portal's document
   ══════════════════════════════════════════════════════════════════════════ */

describe('the builder\'s own document reads as a tree', () => {
  test('a one-column section is a box of widgets', () => {
    const doc = {
      v: 2,
      settings: {},
      sections: [{
        id: 's1', label: 'Intro', layout: 1, width: 'wide', padding: 24, theme: 'paper',
        columns: [{ id: 'col1', widgets: [{ id: 'w1', kind: 'heading', props: { text: 'Hello' } }] }],
      }],
    };
    assert.deepEqual(outline(documentToTree(doc)[0]), ['container(column)', '  widget(heading)']);
  });

  test('a two-column section is a row of two boxes', () => {
    const doc = {
      v: 2,
      settings: {},
      sections: [{
        id: 's1', layout: 2, width: 'wide', padding: 24, theme: 'paper',
        columns: [
          { id: 'a', widgets: [{ id: 'w1', kind: 'heading', props: { text: 'Left' } }] },
          { id: 'b', widgets: [{ id: 'w2', kind: 'paragraph', props: { text: 'Right' } }] },
        ],
      }],
    };
    assert.deepEqual(outline(documentToTree(doc)[0]), [
      'container(column)',
      '  container(row)',
      '    container(column)',
      '      widget(heading)',
      '    container(column)',
      '      widget(paragraph)',
    ]);
  });

  test('A CONTAINER WIDGET AT DEPTH becomes a nested Elementor container', () => {
    /* INTEGRATION, 2026-09-17. The Portal's engine puts a box INSIDE a column,
       as a widget whose kind is `container` with its children on the node and
       its layout in `style` — Brandon's sentence: "Header, drag that into this
       box and it's now its own section inside the box, then a text field under
       it, then cards". `documentToTree` has to read that, or a page published
       from the new builder would come out as a flat list.

       The layout is translated HERE and only here: `style.direction` becomes
       Elementor's `flex_direction`, which is why the Portal never has to speak
       Elementor at all. */
    const doc = {
      v: 2,
      settings: {},
      sections: [{
        id: 's1', label: 'Choose your plan', layout: 1, width: 'wide', padding: 24, theme: 'paper',
        columns: [{
          id: 'col1',
          widgets: [{
            id: 'b1', kind: 'container', props: {},
            style: { direction: 'column', gap: 20 },
            children: [
              { id: 'h1', kind: 'heading', props: { text: 'Choose your plan' } },
              { id: 'p1', kind: 'paragraph', props: { text: 'Pick one' } },
              {
                id: 'r1', kind: 'container', props: {},
                style: { direction: 'row', gap: 16, justify: 'between' },
                children: [
                  { id: 'c1', kind: 'card', props: { title: 'Garden tidy', price: '120' } },
                  { id: 'c2', kind: 'card', props: { title: 'Full maintenance', price: '240' } },
                ],
              },
            ],
          }],
        }],
      }],
    };
    const tree = documentToTree(doc);
    assert.deepEqual(outline(tree[0]), [
      'container(column)',
      '  container(column)',
      '    widget(heading)',
      '    widget(paragraph)',
      '    container(row)',
      '      widget(card)',
      '      widget(card)',
    ]);
    // …and the row's layout reached Elementor's own settings, once.
    const row = tree[0].children[0].children[2];
    assert.equal(row.layout, 'row');
    assert.equal(row.justify, 'space-between');
    const settings = layoutToSettings(row, 2);
    assert.equal(settings.flex_direction, 'row');
    assert.equal(settings.flex_justify_content, 'space-between');
  });

  test('a section that already nests is taken as it is — ONE reader, before and after', () => {
    const doc = { v: 2, settings: {}, sections: [{ id: 's1', layout: 'column', children: CHOOSE_YOUR_PLAN.children }] };
    assert.deepEqual(outline(documentToTree(doc)[0]), outline(CHOOSE_YOUR_PLAN));
  });
});
