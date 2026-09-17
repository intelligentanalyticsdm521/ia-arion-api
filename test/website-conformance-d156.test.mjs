/**
 * test/website-conformance-d156.test.mjs — closing the conformance audit.
 *
 * D156_CONFORMANCE_AUDIT_2026-09-17.md, the arion-api rows:
 *
 *   point 7  — three widget states, one gate, no vendor name, never "locked".
 *              The third state ("needs a product this business does not have")
 *              was not wired: `sectionCatalog` answered `pro | free` only, so
 *              a plan lock and a product lock arrived as the same thing at the
 *              only surface a client reads.
 *   point 8  — the free form on Lite. The presence gate is right and stays;
 *              what is missing is the plugin's `[ia_form]`, specced in
 *              D156_CONFORMANCE_HANDOFF_2026-09-17.md under "Plugin release
 *              D-159".
 *   point 11 — `form_css_class`. TWO form paths typed a submission
 *              differently, and neither wrote the class into the markup.
 *
 * MUTATIONS — each made red on purpose on 2026-09-17, then restored; the
 * harness is scripts/dev/d156-conformance-mutation-check.mjs.
 */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  widgetCatalog, lockSentence, lockReason, resolveWidget, widgetTier,
  swapWillFire, ELEMENTOR_WIDGETS,
  ownedProductsFrom, productsNeeded, cardProps, bindingProps, boundCardValues, IA_SOURCES,
  PRO_LOCK_SENTENCE, NEEDS_SWITCHING_ON_SENTENCE, notOwnedSentence,
  UnsupportedWidgetError,
} from '../lib/websiteBuilder/elementorWidgets.js';
import { sectionCatalog } from '../lib/websiteBuilder/sectionSchema.js';
import { blockToElementorSection } from '../lib/websiteBuilder/elementorAdapter.js';
import {
  formPurposeSettings, formPurposeOf, FORM_PURPOSE_KEY, FORM_PURPOSE_CLASS_KEY, CSS_CLASSES_KEY,
} from '../lib/websiteBuilder/formPurpose.js';

/* ══════════════════════════════════════════════════════════════════════════
   7. Three states, three sentences
   ══════════════════════════════════════════════════════════════════════════ */

/** A Lite business that does not own OLIVER. */
const LITE_NO_OLIVER = { allowPro: false, iaWidgets: ['ia_product_cards'], ownedProducts: [] };
/** A Standard business that does own it. */
const STANDARD_OLIVER = { allowPro: true, iaWidgets: ['ia_product_cards'], ownedProducts: ['oliver'] };

const rowFor = (catalogue, kind) => catalogue.find((r) => r.kind === kind);

describe('a widget is in exactly one of three states, and each says its own thing', () => {
  test('a Lite business without OLIVER: the catalogue card needs a product, and says so', () => {
    const row = rowFor(widgetCatalog(LITE_NO_OLIVER), 'catalog_card');
    assert.equal(row.tier, 'ia:oliver');
    assert.equal(row.available, false);
    assert.equal(row.reason, 'ownership', 'a product lock arrived as a plan lock');
    assert.equal(row.unavailableReason, notOwnedSentence('oliver'));
    assert.match(row.unavailableReason, /OLIVER/, 'the sentence does not name what they would need');
  });

  test('a Standard business WITH OLIVER: the same card is simply offered', () => {
    const row = rowFor(widgetCatalog(STANDARD_OLIVER), 'catalog_card');
    assert.equal(row.tier, 'ia:oliver');
    assert.equal(row.available, true);
    assert.equal(row.reason, null);
    assert.equal(row.unavailableReason, null);
  });

  test('the plan lock and the product lock are DIFFERENT reasons', () => {
    const lite = widgetCatalog(LITE_NO_OLIVER);
    const card = rowFor(lite, 'card');
    const bound = rowFor(lite, 'catalog_card');
    assert.equal(card.reason, 'tier');
    assert.equal(bound.reason, 'ownership');
    assert.notEqual(card.unavailableReason, bound.unavailableReason,
      'two reasons collapsed into one sentence');
    assert.equal(card.unavailableReason, PRO_LOCK_SENTENCE);
  });

  test('a business that owns the product but whose website has not had it switched on', () => {
    // A third cause, on the ownership axis, with its own sentence: this one is
    // OURS to fix, and promising that to somebody who has not bought the
    // product would be a promise nobody can keep.
    const s = lockSentence('catalog_card', { allowPro: true, iaWidgets: [], ownedProducts: ['oliver'] });
    assert.equal(s, NEEDS_SWITCHING_ON_SENTENCE);
    assert.equal(lockReason('catalog_card', { allowPro: true, iaWidgets: [], ownedProducts: ['oliver'] }), 'ownership');
  });

  test('a free widget is offered on every plan, with nothing to say', () => {
    for (const kind of ['heading', 'paragraph', 'list', 'image', 'button', 'html']) {
      const row = rowFor(widgetCatalog(LITE_NO_OLIVER), kind);
      assert.equal(row.tier, 'free', `${kind} is not free`);
      assert.equal(row.available, true, `${kind} was locked on a Lite plan`);
      assert.equal(row.reason, null);
    }
  });

  test('"we could not ask" locks NOTHING — silence is never a refusal', () => {
    // `tenantServiceOwnership` answers { known, owned }. A failed query must
    // not tell a client they do not own a product they pay for.
    assert.equal(ownedProductsFrom({ known: false, owned: [] }), null);
    assert.deepEqual(ownedProductsFrom({ known: true, owned: ['oliver'] }), ['oliver']);
    const unknown = widgetCatalog({ allowPro: true, iaWidgets: ['ia_product_cards'], ownedProducts: null });
    assert.equal(rowFor(unknown, 'catalog_card').available, true);
    assert.equal(rowFor(unknown, 'catalog_card').reason, null);
  });

  test('one ownership question covers every widget that needs a product', () => {
    assert.deepEqual(productsNeeded(), ['oliver']);
  });

  test('no widget sentence names a vendor, and none says the bare word "locked"', () => {
    const sentences = [
      ...widgetCatalog(LITE_NO_OLIVER).map((r) => r.unavailableReason),
      ...widgetCatalog({ allowPro: true, iaWidgets: [], ownedProducts: ['oliver'] }).map((r) => r.unavailableReason),
      NEEDS_SWITCHING_ON_SENTENCE, PRO_LOCK_SENTENCE, notOwnedSentence('oliver'),
    ].filter(Boolean);
    assert.ok(sentences.length >= 3);
    for (const s of sentences) {
      assert.ok(!/elementor|wordpress|wp[- ]admin/i.test(s), `a vendor name reached a client sentence: ${s}`);
      assert.ok(!/\block(ed)?\b/i.test(s), `a sentence says "locked": ${s}`);
      assert.ok(!/upgrade/i.test(s), `a sentence orders the client about: ${s}`);
    }
  });

  test('a SECTION answers in the same three words a widget does', () => {
    const lite = sectionCatalog({ allowPro: false, ownedProducts: [] });
    const contact = rowFor(lite, 'contact');
    assert.equal(contact.tier, 'pro');
    assert.equal(contact.available, false);
    assert.equal(contact.reason, 'tier');
    assert.match(contact.unavailableReason, /ARION Standard/);
    for (const row of lite) {
      assert.ok(['free', 'pro'].includes(row.tier) || row.tier.startsWith('ia:'),
        `a section answered an unknown tier: ${row.tier}`);
      assert.equal(row.available === false, row.reason !== null,
        `${row.kind} is unavailable with no reason, or has a reason and is available`);
    }
  });

  test('the Portal is never asked to work the gate out for itself', () => {
    // Every row carries its own answer, so no caller has to know a tier order.
    for (const row of widgetCatalog(LITE_NO_OLIVER)) {
      assert.ok('available' in row && 'reason' in row && 'unavailableReason' in row && 'tier' in row,
        `${row.kind} is missing part of the answer`);
      assert.equal(row.available, row.unavailableReason === null);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   8. The free form on Lite — the gate stays, by PRESENCE
   ══════════════════════════════════════════════════════════════════════════ */

describe('a form that cannot send is never drawn', () => {
  test('a Lite site that has not told us it has our form is refused BY NAME', () => {
    assert.throws(
      () => resolveWidget('form', { fields: [] }, { allowPro: false, iaShortcodes: null }),
      (e) => e instanceof UnsupportedWidgetError && /ARION Standard/.test(e.message),
    );
    // An empty list is a real answer — "none" — and still refuses.
    assert.throws(
      () => resolveWidget('form', { fields: [] }, { allowPro: false, iaShortcodes: [] }),
      (e) => e instanceof UnsupportedWidgetError,
    );
  });

  test('a Lite site that DOES have it gets a working form, typed the same way', () => {
    const { node, swapped } = resolveWidget(
      'form',
      { _ia_form_purpose: 'quote', emailTo: 'owner@shop.invalid' },
      { allowPro: false, iaShortcodes: ['ia_form'] },
    );
    assert.equal(node.widgetType, 'shortcode');
    assert.match(node.settings.shortcode, /purpose="quote"/);
    assert.equal(node.settings[FORM_PURPOSE_KEY], 'quote');
    assert.equal(swapped.kind, 'form');
  });

  test('the form stays a PAID widget — the fallback is a site fact, not a plan fact', () => {
    assert.equal(widgetTier('form'), 'pro');
  });

  test('THE SENTENCE MATCHES WHAT WE WILL ACTUALLY PUBLISH', () => {
    // The pane used to promise "this is added as a box with a heading, your
    // words and a button" for every paid widget that had a fallback FUNCTION —
    // the form included, whose fallback answers null on a site without our
    // shortcode. So a Lite client was promised a form and the publish refused
    // one. One predicate now answers both.
    const noShortcode = { allowPro: false, iaShortcodes: [] };
    const withShortcode = { allowPro: false, iaShortcodes: ['ia_form'] };
    assert.ok(!/added as/.test(lockSentence('form', noShortcode)),
      'the sentence promises a swap that will not happen');
    assert.equal(lockSentence('form', noShortcode), 'Available on ARION Standard and above.',
      'the sentence promises a swap that will not happen');
    assert.match(lockSentence('form', withShortcode), /our own form/);
    assert.equal(swapWillFire(ELEMENTOR_WIDGETS.form, noShortcode), false);
    assert.equal(swapWillFire(ELEMENTOR_WIDGETS.form, withShortcode), true);
    assert.equal(rowFor(widgetCatalog(noShortcode), 'form').hasFallback, false);
    assert.equal(rowFor(widgetCatalog(withShortcode), 'form').hasFallback, true);
    // And a swapped form is still described as a FORM, never as a box of words.
    assert.ok(!/box with a heading/.test(lockSentence('form', withShortcode)));
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   11. Both form paths type a submission the same way
   ══════════════════════════════════════════════════════════════════════════ */

const BRAND = { business_name: 'Cedar Ridge Plant Services', email: 'owner@cedarridge.test' };
const CONTACT_BLOCK = {
  headline: 'Get a quote within one business day',
  contact_methods: [{ kind: 'phone', label: 'Call us', value: '(319) 555-0142', href: 'tel:+13195550142' }],
  form_config: { fields: ['Name', 'Email', 'Message'], submit_text: 'Send message' },
};

function findForm(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.elType === 'widget' && node.widgetType === 'form') out.push(node);
  (node.elements || []).forEach((n) => findForm(n, out));
  return out;
}

/** The archetype path: a contact SECTION built by containerEmitters. */
const archetypeForm = (purpose) => findForm(blockToElementorSection({
  kind: 'contact', block: { ...CONTACT_BLOCK, form_purpose: purpose }, brand: BRAND, seedId: 's',
}))[0].settings;

/** The tree path: a form WIDGET the author dragged in. */
const treeForm = (purpose) => resolveWidget(
  'form',
  { title: 'Contact', emailTo: BRAND.email, [FORM_PURPOSE_KEY]: purpose, fields: [{ label: 'Name' }] },
  { allowPro: true },
).node.settings;

const PURPOSE_KEYS = [FORM_PURPOSE_KEY, FORM_PURPOSE_CLASS_KEY, CSS_CLASSES_KEY];
const purposeWire = (settings) => Object.fromEntries(PURPOSE_KEYS.map((k) => [k, settings[k]]));

describe('what a form is FOR is written the same way through both doors', () => {
  test('the archetype path and the tree path emit IDENTICAL form typing', () => {
    // The defect: a form placed as a widget and a form placed as a section
    // typed their submissions differently, so a client's enquiries were filed
    // by whichever door they happened to build the form through.
    for (const purpose of ['lead', 'quote', 'booking', 'newsletter']) {
      assert.deepEqual(purposeWire(treeForm(purpose)), purposeWire(archetypeForm(purpose)),
        `the two form paths disagree for "${purpose}"`);
    }
  });

  test('all three keys, together, on both paths', () => {
    for (const settings of [archetypeForm('quote'), treeForm('quote')]) {
      assert.equal(settings[FORM_PURPOSE_KEY], 'quote', 'the purpose itself is not written');
      assert.equal(settings[FORM_PURPOSE_CLASS_KEY], 'ia-quote', 'the legacy alias the plugin reads is not written');
      assert.equal(settings[CSS_CLASSES_KEY], 'ia-form-quote', 'the class never reaches the markup');
    }
  });

  test('the legacy alias is still EXACTLY what the plugin routes on', () => {
    // intelligent-analytics.php process_submission() reads `form_css_class` and
    // matches ia-booking / ia-quote / ia-newsletter / ia-lead / ia-contact. Until
    // the release that reads `_ia_form_purpose` (D-159), changing this value
    // silently re-types every enquiry from every published page.
    const ROUTED = new Set(['ia-booking', 'ia-quote', 'ia-newsletter', 'ia-lead', 'ia-contact']);
    for (const purpose of ['lead', 'contact', 'quote', 'booking', 'newsletter', 'nonsense']) {
      assert.ok(ROUTED.has(formPurposeSettings(purpose)[FORM_PURPOSE_CLASS_KEY]),
        `"${purpose}" produced a class the plugin does not route`);
    }
  });

  test('a form ALREADY published answers through the alias, and is healed on the next save', () => {
    // Presence of our key first, the legacy class second, never the absence of
    // either (`reference_absence_based_guards_fail_open`).
    assert.equal(formPurposeOf({ form_css_class: 'ia-booking' }), 'booking');
    assert.equal(formPurposeOf({ _ia_form_purpose: 'quote', form_css_class: 'ia-lead' }), 'quote');
    assert.equal(formPurposeOf({}), 'lead', 'an untyped form must still file somewhere');
    const healed = formPurposeSettings(formPurposeOf({ form_css_class: 'ia-booking' }));
    assert.equal(healed[FORM_PURPOSE_KEY], 'booking');
    assert.equal(healed[FORM_PURPOSE_CLASS_KEY], 'ia-booking');
  });

  test('the author\'s own CSS classes are kept, and ours is not written twice', () => {
    const s = formPurposeSettings('lead', 'brand-form ia-form-quote');
    assert.equal(s[CSS_CLASSES_KEY], 'brand-form ia-form-lead');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   The shared vocabulary — a card and a binding, spelled one way
   ══════════════════════════════════════════════════════════════════════════ */

describe('a card and a binding are spelled the way the three repos agreed', () => {
  test('the card reads the paid widget\'s own control names', () => {
    const c = cardProps({
      heading: 'Garden tidy', heading_tag: 'h3', description: 'Fortnightly',
      price: '120', currency_symbol: 'pound', period: 'month',
      original_price: '150', sale: true,
      features_list: [{ item_text: 'Lawn cut' }],
      footer_additional_info: 'Cancel any time', button_text: 'Choose this', link: '/quote',
      show_ribbon: true, ribbon_preset: 'best_value',
    });
    assert.equal(c.heading, 'Garden tidy');
    assert.equal(c.period, 'month');
    assert.equal(c.currency.currency_symbol, 'pound');
    assert.equal(c.sale, true);
    assert.deepEqual(c.features_list.map((f) => f.item_text), ['Lawn cut']);
    assert.equal(c.footer_additional_info, 'Cancel any time');
    assert.equal(c.ribbon_title, 'Best value');
  });

  test('a symbol the paid widget does not name by name becomes its own custom symbol', () => {
    assert.deepEqual(cardProps({ heading: 'x', currency_symbol: '£' }).currency,
      { currency_symbol: 'custom', currency_symbol_custom: '£' });
    assert.deepEqual(cardProps({ heading: 'x' }).currency, {});
  });

  test('an OLD-SHAPE card is refused, never published blank', () => {
    // The builder's upgrade-on-open converts `title` / `per` / `was` /
    // `bullets` / `note` / `recommended`. A card that reaches a publish still
    // wearing them came through a door that did not run the upgrade, and a
    // blank card on a live page is a success we did not have.
    assert.throws(
      () => cardProps({ title: 'Garden tidy', per: 'month', bullets: ['Lawn cut'] }),
      (e) => e instanceof UnsupportedWidgetError && /older shape/.test(e.message),
    );
    // And a card with nothing at all is empty, not an error.
    assert.doesNotThrow(() => cardProps({}));
  });

  test('the Binding section is read through F.2\'s own five names', () => {
    const b = bindingProps({
      _ia_source: IA_SOURCES.catalogue,
      _ia_selection: { offering_id: 'svc-1', price_id: 'pr-9', tier: 'standard' },
      refresh: 'snapshot_send',
      on_empty: 'last_snapshot',
      overrides: { heading: 'Typed by the author' },
      _ia_snapshot: { heading: 'Frozen at send', price: '120' },
    });
    assert.equal(b.source, 'oliver:catalogue');
    assert.deepEqual(b.ids, ['svc-1']);
    assert.equal(b.priceId, 'pr-9');
    assert.equal(b.tier, 'standard');
    assert.equal(b.refresh, 'snapshot_send');
    assert.equal(b.on_empty, 'last_snapshot');
    // Override beats snapshot beats nothing — one order, stated once.
    assert.deepEqual(boundCardValues({
      overrides: { heading: 'Typed by the author' },
      _ia_snapshot: { heading: 'Frozen at send', price: '120' },
    }), { heading: 'Typed by the author', price: '120' });
  });

  test('a refresh or an on-empty word we do not know is not carried onto a page', () => {
    const b = bindingProps({ refresh: 'whenever', on_empty: 'explode' });
    assert.equal(b.refresh, 'live');
    assert.equal(b.on_empty, 'hide');
  });

  test('`_ia_source` is a MARKER, the same three strings in all three repos', () => {
    // handoff §3: never a schema object. A stored document that names a table
    // goes stale the day the table moves.
    assert.deepEqual(IA_SOURCES, {
      catalogue: 'oliver:catalogue', location: 'lumen:locations', document: 'document',
    });
    for (const v of Object.values(IA_SOURCES)) {
      assert.ok(!/\./.test(v), `"${v}" looks like a schema object, not a marker`);
    }
    assert.equal(bindingProps({}).source, 'oliver:catalogue');
  });

  test('a cleared SALE does not put a struck-through price back on the page', () => {
    // handoff §6: `sale: false` means do not show `original_price`.
    assert.equal(cardProps({ heading: 'x', original_price: '150', sale: false }).sale, false);
    assert.equal(cardProps({ heading: 'x', original_price: '150' }).sale, true);
    const lite = resolveWidget(
      'card',
      { heading: 'Garden tidy', price: '120', original_price: '150', sale: false },
      { allowPro: false },
    ).node;
    assert.ok(!JSON.stringify(lite).includes('150'), 'the cleared old price reached the page anyway');
    const paid = resolveWidget(
      'card',
      { heading: 'Garden tidy', price: '120', original_price: '150', sale: false },
      { allowPro: true },
    ).node;
    assert.equal(paid.settings.original_price, undefined);
    assert.equal(paid.settings.sale, undefined);
  });

  test('a bound card with nothing frozen and nothing typed is REFUSED, not drawn empty', () => {
    assert.throws(
      () => resolveWidget('catalog_card', { _ia_selection: ['svc-1'] }, { allowPro: true, iaWidgets: [] }),
      (e) => e instanceof UnsupportedWidgetError,
    );
    // With something to say, the visitor reads it.
    const { node } = resolveWidget(
      'catalog_card',
      { _ia_selection: ['svc-1'], _ia_snapshot: { heading: 'Full maintenance', price: '240' } },
      { allowPro: true, iaWidgets: [] },
    );
    assert.ok(JSON.stringify(node).includes('Full maintenance'));
    assert.ok(JSON.stringify(node).includes('240'));
  });
});
