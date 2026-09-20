/**
 * D-165 §11.13.3 — ONE TABLE, TESTED AGAINST THE MACHINE FILE.
 *
 * "arion maps every standard kind to Elementor's widgetType 1:1 with
 * Elementor's own settings keys (the catalogue machine file is the key list;
 * one table, tested against the machine file)."
 *
 * So this suite never asks "does the emitter do what I think it does". It
 * asks the page engine's own registry, through the extract
 * `test/fixtures/elementor-widget-controls.json`, which
 * `scripts/dev/extract-widget-controls.mjs` writes and REFUSES to write for a
 * key the engine does not have. Three questions, in order:
 *
 *   1. every kind §11.13.3 names has a row, and the row publishes the engine's
 *      own widget name;
 *   2. every settings key that row can emit is a control that widget really
 *      has, and every value it can emit is one that control really offers;
 *   3. the plan and the ownership gates answer the three states of §11.12 —
 *      offered, not on the plan, needs a product — and silence locks nothing.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  ELEMENTOR_WIDGETS, WIDGET_KIND_ALIASES, canonicalKind, listWidgetKinds,
  resolveWidget, widgetCatalog, lockSentence, UnsupportedWidgetError,
  PRO_LOCK_SENTENCE_NO_FALLBACK, NEEDS_SWITCHING_ON_SENTENCE,
  IA_SOURCES, FREE, PRO,
} from '../lib/websiteBuilder/elementorWidgets.js';
import { MAXIMAL_WIDGET_PROPS, WIDGET_CTX, SETTINGS_NOT_CONTROLS }
  from './fixtures/widget-controls-input.mjs';

const PIN = JSON.parse(readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'elementor-widget-controls.json'), 'utf8'));

/** §11.13.3's standard set, in the shared vocabulary's own spellings. */
const STANDARD_SET = {
  heading: 'heading',
  paragraph: 'text-editor',
  image: 'image',
  button: 'button',
  divider: 'divider',
  spacer: 'spacer',
  icon: 'icon',
  list: 'icon-list',
  icon_box: 'icon-box',
  image_box: 'image-box',
  testimonial: 'testimonial',
  star_rating: 'star-rating',
  alert: 'alert',
  social_links: 'social-icons',
};

/** The website's extras — §11.13.3's "Elementor's whole free panel". */
const WEBSITE_EXTRAS = {
  video: 'video',
  map: 'google_maps',
  counter: 'counter',
  progress_bar: 'progress',
  /* CHANGED 2026-09-19 (b168/f4-moving-deep). These two used to read
     `tabs: 'tabs'` and `accordion: 'accordion'`, and that was plan section
     B.2's open defect written down as an expectation: in the real editor
     `tabs` and `accordion` are BOTH `show_in_panel: false` — deprecated
     widgets nobody can add any more — and the tiles a person sees named Tabs
     and Accordion are `nested-tabs` and `nested-accordion`. The family now
     publishes the nested tree, from a live capture of what Elementor itself
     writes (elementor-reference/widgets/_g4_nested_tree.json), so the map says
     so. They are NESTED elements and therefore build a `node()` rather than
     `settings()`, which is why the two exceptions below exist. */
  tabs: 'nested-tabs',
  accordion: 'nested-accordion',
  toggle: 'toggle',
  image_carousel: 'image-carousel',
  gallery: 'image-gallery',
  html: 'html',
  shortcode: 'shortcode',
  menu_anchor: 'menu-anchor',
};

/** The paid panel §11.13.3 names by name. */
const PRO_SET = [
  'form', 'posts', 'pro_gallery', 'slides', 'card', 'price_list', 'call_to_action',
  'flip_box', 'countdown', 'testimonial_carousel', 'nav_menu', 'loop_grid',
  /* B-168 F5: `pro_reviews` is gone and `reviews` IS Elementor's Reviews now
     - no Portal kind was ever called pro_reviews. Media Carousel joins the
     paid panel with it. */
  'reviews', 'media_carousel',
];

/** The IA website widgets of §11.13.3, and whether the plugin registers one. */
const IA_REGISTERED = ['ia_mega_menu', 'ia_mobile_menu', 'ia_posts', 'ia_oliver_invoice', 'ia_social_links'];
const IA_NEW = ['product_cards', 'ia_reviews', 'book_now', 'ia_form', 'newsletter_signup', 'hours_location'];

describe('the standard set maps one for one onto the page engine', () => {
  for (const [kind, widgetType] of Object.entries({ ...STANDARD_SET, ...WEBSITE_EXTRAS })) {
    test(`${kind} publishes “${widgetType}”`, () => {
      const row = ELEMENTOR_WIDGETS[kind];
      assert.ok(row, `§11.13.3 names ${kind} and there is no row for it`);
      assert.equal(row.widgetType, widgetType);
      /* A nested element builds a tree, so it has `node()` and no
         `settings()`; everything else is the other way round. Asserted here
         so "it has neither" cannot pass as "it is nested". */
      assert.equal(typeof (row.settings || row.node), 'function', `${kind} draws nothing`);
      assert.equal(row.tier, FREE, `${kind} is a free widget on every website on earth`);
      assert.ok(PIN.widgets[widgetType], `${widgetType} is not in the machine-file extract`);
    });
  }

  test('Elementor’s spelling reaches the kind we store, and never doubles a row', () => {
    for (const [slug, stored] of Object.entries(WIDGET_KIND_ALIASES)) {
      assert.ok(ELEMENTOR_WIDGETS[stored], `${slug} points at a kind that has no row`);
      assert.ok(!ELEMENTOR_WIDGETS[slug], `${slug} is BOTH an alias and a row — two answers for one widget`);
      assert.equal(canonicalKind(slug), stored,
        `canonicalKind("${slug}") must answer "${stored}" — otherwise Elementor's own spelling `
        + 'reaches no row at all and the widget is refused as unknown');
    }
  });

  test('a value the control does not offer is never handed to the engine', () => {
    /* The engine DROPS a select value it does not offer, so passing one
       through is a setting the author watched us accept and the page never
       got. Every guarded control answers its own default instead. */
    const wild = { view: 'sparkly', shape: 'trapezoid', type: 'exuberant', align: 'sideways',
      position: 'behind', direction: 'diagonal', navigation: 'telepathy' };
    for (const [kind, key, expected] of [
      ['icon', 'view', 'default'],
      ['icon', 'shape', 'circle'],
      ['alert', 'alert_type', 'info'],
      ['social_links', 'align', 'center'],
      ['social_links', 'shape', 'rounded'],
      ['testimonial', 'testimonial_image_position', 'aside'],
      ['testimonial', 'testimonial_alignment', 'center'],
      /* `tabs` is gone from this list, and not because the guard weakened:
         Elementor's `nested-tabs` has no `type` control at all. Its direction
         control is `tabs_direction`, it is guarded the same way, and the
         family's own test drives it with "diagonal" and reads back
         "block-start". See test/website-families-f4-moving.test.js. */
      ['image_carousel', 'navigation', 'both'],
    ]) {
      const emitted = ELEMENTOR_WIDGETS[kind].settings(wild, WIDGET_CTX);
      assert.equal(emitted[key], expected,
        `${kind}.${key} passed a value the control does not offer straight through`);
      const pin = PIN.widgets[ELEMENTOR_WIDGETS[kind].widgetType].controls[key];
      if (pin.options) {
        assert.ok(pin.options.includes(emitted[key]),
          `${kind}.${key} fell back to "${emitted[key]}", which the control does not offer either`);
      }
    }
  });

  test('the paid panel is present, priced, and not quietly free', () => {
    for (const kind of PRO_SET) {
      const row = ELEMENTOR_WIDGETS[kind];
      assert.ok(row, `§11.13.3 names the paid ${kind} and there is no row for it`);
      assert.equal(row.tier, PRO, `${kind} must need a plan above Lite`);
    }
  });
});

describe('every key the emitter writes is a control the page engine has', () => {
  for (const [kind, row] of Object.entries(ELEMENTOR_WIDGETS)) {
    if (row.node || !row.settings) continue;
    const pin = PIN.widgets[row.widgetType];
    if (!pin) continue; // recorded in PIN.unregistered and asserted below.
    test(`${kind} → ${row.widgetType}`, () => {
      const emitted = row.settings(MAXIMAL_WIDGET_PROPS, WIDGET_CTX);
      for (const [key, value] of Object.entries(emitted)) {
        if (SETTINGS_NOT_CONTROLS.includes(key)) continue;
        const control = pin.controls[key];
        assert.ok(control, `${row.widgetType} has no control called “${key}”`);
        // A select's VALUE has to be one the control offers, or the engine
        // drops it and the author watched us accept a setting that did nothing.
        if (control.options && typeof value === 'string' && value !== '') {
          assert.ok(control.options.includes(value),
            `${row.widgetType}.${key} cannot be “${value}” — it offers ${control.options.join(' / ')}`);
        }
        // A repeater's ROW keys have to be the repeater's own fields.
        if (control.repeater_fields && Array.isArray(value) && value.length) {
          for (const field of Object.keys(value[0])) {
            assert.ok(control.repeater_fields.includes(field),
              `${row.widgetType}.${key} rows have no field called “${field}”`);
          }
        }
      }
    });
  }

  test('a widget of ours the plugin has not registered still draws something', () => {
    for (const row of PIN.unregistered) {
      assert.equal(row.hasFallback, true,
        `${row.kind} publishes ${row.widgetType}, which no site registers, and has no fallback — `
        + 'a visitor would get an empty space where a price should be');
    }
  });
});

describe('the new IA widgets publish free widgets, stamped with where they came from', () => {
  const CTX = {
    ...WIDGET_CTX,
    iaWidgets: IA_REGISTERED,
    ownedProducts: ['oliver', 'lumen', 'arion'],
  };
  const PROPS = {
    cards: [{ heading: 'Snow & ice', price: '185', description: 'Every two inches.' }],
    items: [{ quote: 'Out before we opened.', author: 'A customer', platform: 'Google' }],
    label: 'Book now', url: 'https://example.test/book',
    title: 'Stay in touch', description: 'One email a month.', button_text: 'Sign up',
    name: 'Marshalltown depot', address: '1200 Prairie Ave', hours: [{ day: 'Mon', opens: '7 to 5' }],
  };

  for (const kind of IA_NEW) {
    test(`${kind} is one of ours, drawn out of free widgets`, () => {
      const { node } = resolveWidget(kind, PROPS, CTX);
      assert.ok(node, `${kind} published nothing`);
      assert.equal(node.settings._ia_widget, kind, 'the node must say which of ours it is');
      assert.ok(String(node.settings._ia_source || '').includes(':'),
        `${kind} published without an _ia_source, so a re-publish cannot refresh it`);
      // Nothing inside may be a PAID widget: the whole point is Lite renders it.
      const types = [];
      (function walk(n) {
        if (n.elType === 'widget') types.push(n.widgetType);
        for (const kid of n.elements || []) walk(kid);
      }(node));
      for (const t of types) {
        assert.ok(PIN.widgets[t] || t === 'shortcode',
          `${kind} published “${t}”, which is not a widget the engine has`);
      }
    });
  }

  test('a composition is never refused for a widget the plugin has not registered', () => {
    // The plugin registers NONE of the new six, and that must not matter:
    // a composition is free widgets, which every site already has.
    for (const kind of IA_NEW) {
      assert.equal(lockSentence(kind, { ...CTX, iaWidgets: [] }), null,
        `${kind} was refused because the plugin has not registered something it does not need`);
    }
  });

  test('a form that cannot send is never drawn', () => {
    assert.throws(
      () => resolveWidget('ia_form', PROPS, { ...CTX, iaShortcodes: [] }),
      (e) => e instanceof UnsupportedWidgetError && /not published/.test(e.message),
    );
  });

  test('the four new binding markers are markers, never table names', () => {
    for (const marker of Object.values(IA_SOURCES)) {
      assert.ok(marker === 'document' || /^(oliver|lumen):[a-z_]+$/.test(marker),
        `“${marker}” does not read as a marker`);
    }
  });
});

describe('the three states of §11.12, and silence locks nothing', () => {
  const OWNS_ALL = { allowPro: true, iaWidgets: IA_REGISTERED, ownedProducts: ['oliver', 'lumen', 'arion'] };

  test('on Standard everything is offered except the widget no site registers', () => {
    const locked = widgetCatalog(OWNS_ALL).filter((r) => !r.available);
    /* `catalog_card` publishes `ia_product_cards`, which the plugin has not
       registered — the one row PIN.unregistered records. It is refused with
       the "we will switch it on" sentence and it PUBLISHES a fallback, so a
       visitor still reads a real price. Everything else is offered. */
    assert.deepEqual(locked.map((r) => r.kind), ['catalog_card'],
      `locked on a plan that carries everything: ${locked.map((r) => r.kind).join(', ')}`);
    assert.equal(locked[0].unavailableReason, NEEDS_SWITCHING_ON_SENTENCE);
    assert.equal(locked[0].hasFallback, true);
  });

  test('on Lite the paid panel is refused BY NAME, with a reason of its own', () => {
    const rows = widgetCatalog({ ...OWNS_ALL, allowPro: false });
    for (const kind of PRO_SET) {
      const row = rows.find((r) => r.kind === kind);
      assert.equal(row.available, false, `${kind} is paid and was offered on Lite`);
      assert.equal(row.reason, 'tier');
      assert.ok(row.unavailableReason.startsWith('Available on ARION Standard'), row.unavailableReason);
      assert.ok(!/elementor/i.test(row.unavailableReason), 'no vendor name on a client screen');
    }
    // and nothing FREE is caught by the plan gate
    for (const kind of Object.keys(STANDARD_SET)) {
      assert.equal(rows.find((r) => r.kind === kind).available, true, `${kind} is free and was locked`);
    }
  });

  test('a widget with no fallback says so, and does not promise a box of words', () => {
    assert.equal(lockSentence('posts', { ...OWNS_ALL, allowPro: false }), PRO_LOCK_SENTENCE_NO_FALLBACK);
  });

  test('a REGISTERED IA widget the site has not switched on says exactly that', () => {
    assert.equal(lockSentence('ia_posts', { ...OWNS_ALL, iaWidgets: [] }), NEEDS_SWITCHING_ON_SENTENCE);
  });

  test('a product the business does not own is named, not hinted at', () => {
    const s = lockSentence('ia_reviews', { ...OWNS_ALL, ownedProducts: ['arion'] });
    assert.match(s, /Needs LUMEN/);
  });

  test('"we could not ask" locks nothing', () => {
    // ownedProducts null and iaWidgets null = the query failed. A client who
    // pays for a product must never be told they do not have it.
    for (const kind of listWidgetKinds()) {
      const s = lockSentence(kind, { allowPro: true, iaWidgets: null, ownedProducts: null });
      assert.equal(s, null, `${kind} was locked on silence`);
    }
  });
});
