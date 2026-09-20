/**
 * test/website-builder-families-f6-money.test.js — f6-money reaches a LIVE SITE.
 *
 * B-168 §C.1. `website-builder-families.test.js` asks the contract every
 * family keeps; this file is f6-money's own and asks the things only this
 * family can answer:
 *
 *   · the four rows publish Elementor's own slugs, at the Pro tier;
 *   · `price_list` was MOVED, not re-invented — its kind is unchanged and it
 *     still reads the spelling pages published before the move are wearing;
 *   · a site with no Pro widgets gets the real words out of FREE ones, and a
 *     payment button refuses BY NAME rather than publishing a dead button.
 *
 * MUTATION CHECKS — run, then restored (2026-09-19):
 *   1. `price_list`'s legacy `items[]` reader deleted → "a page published
 *      before the move keeps its rows" went red with an empty repeater.
 *   2. the old `price_list` row put back in `elementorWidgets.js` → "the family
 *      row is the one that publishes" went red, because the old row won the
 *      spread and dropped every new setting.
 *   3. `payFallback`'s `if (!url) return null` turned into `return button` →
 *      "a payment button refuses rather than publishing a dead button" went
 *      red.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EMITTERS } from '../lib/websiteBuilder/families/f6-money/emitters.js';
import { ELEMENTOR_WIDGETS, resolveWidget } from '../lib/websiteBuilder/elementorWidgets.js';

const CTX = { seed: 'f6', nodeId: 'n1', allowPro: true };

const TABLE = {
  heading: 'Seasonal plan', heading_tag: 'h3', sub_heading: 'Eight visits',
  currency_symbol: 'dollar', price: '1250', period: 'per season',
  features_list: [{ item_text: 'Spring clean-up' }],
  button_text: 'Choose', link: { url: 'https://example.test/plan' },
  footer_additional_info: 'Prices hold for 30 days.',
  show_ribbon: 'yes', ribbon_title: 'Most chosen',
};

describe('f6-money publishes Elementor\'s four money widgets', () => {
  test('one row per widget, each one Elementor\'s own slug at the Pro tier', () => {
    assert.deepEqual(Object.keys(EMITTERS).sort(),
      ['paypal_button', 'price_list', 'price_table', 'stripe_button']);
    for (const [kind, row] of Object.entries(EMITTERS)) {
      assert.equal(row.tier, 'pro', kind);
      assert.equal(typeof row.settings, 'function', kind);
      assert.equal(typeof row.fallback, 'function', kind);
    }
  });

  test('THE FAMILY ROW IS THE ONE THAT PUBLISHES', () => {
    // `ELEMENTOR_WIDGETS` spreads FAMILY_EMITTERS first, so a surviving copy
    // of an old row WINS and silently drops every setting the rebuilt panel
    // writes. The old `price_list` was deleted in the same commit that added
    // this family — replace means delete — and this is what says so.
    for (const kind of Object.keys(EMITTERS)) {
      assert.equal(ELEMENTOR_WIDGETS[kind], EMITTERS[kind],
        `${kind}: an older copy of this row is still in elementorWidgets.js and is winning`);
    }
  });

  test('the Price Table publishes the author\'s words on the page engine\'s own keys', () => {
    const s = EMITTERS.price_table.settings(TABLE, CTX);
    assert.equal(s.heading, 'Seasonal plan');
    assert.equal(s.sub_heading, 'Eight visits');
    assert.equal(s.heading_tag, 'h3');
    assert.equal(s.price, '1250');
    assert.equal(s.period, 'per season');
    assert.deepEqual(s.features_list, [{ _id: 'f0', item_text: 'Spring clean-up' }]);
    assert.equal(s.button_text, 'Choose');
    assert.equal(s.link.url, 'https://example.test/plan');
    assert.equal(s.show_ribbon, 'yes');
    assert.equal(s.ribbon_title, 'Most chosen');
  });

  test('a ribbon that is OFF publishes no ribbon keys at all', () => {
    // Publishing `show_ribbon: ''` beside a `ribbon_title` is how a card ends
    // up with an invisible banner that the next re-publish turns back on.
    const s = EMITTERS.price_table.settings({ ...TABLE, show_ribbon: '' }, CTX);
    assert.equal('show_ribbon' in s, false);
    assert.equal('ribbon_title' in s, false);
  });

  test('a colour nobody chose is not published as an empty colour', () => {
    // An empty string on a colour control overrides the site's own theme with
    // nothing, which is how a published band comes out unstyled.
    const s = EMITTERS.price_table.settings(TABLE, CTX);
    for (const k of ['header_bg_color', 'heading_color', 'price_color', 'button_text_color']) {
      assert.equal(k in s, false, `${k} was published with no value behind it`);
    }
  });

  test('PRICE LIST WAS MOVED: a page published before the move keeps its rows', () => {
    // The row this family replaced read `items[{name, description, price}]`.
    const old = EMITTERS.price_list.settings({
      items: [{ name: 'Mowing', price: '$65', description: 'Weekly' }],
    }, CTX);
    assert.deepEqual(old.price_list.map((r) => [r.title, r.price, r.item_description]),
      [['Mowing', '$65', 'Weekly']]);
    // …and Elementor's own spelling, which is what the rebuilt panel writes.
    const now = EMITTERS.price_list.settings({
      price_list: [{ title: 'Aeration', price: '$180', item_description: 'Once a year' }],
    }, CTX);
    assert.deepEqual(now.price_list.map((r) => [r.title, r.price, r.item_description]),
      [['Aeration', '$180', 'Once a year']]);
  });

  test('the payment buttons publish what is being sold, and no processor glyph', () => {
    const pp = EMITTERS.paypal_button.settings({
      email: 'pay@example.test', product_name: 'Deposit', product_price: '250',
      quantity: 2, text: 'Pay the deposit',
    }, CTX);
    assert.equal(pp.email, 'pay@example.test');
    assert.equal(pp.product_price, 250);
    assert.equal(pp.quantity, 2);
    assert.equal(pp.text, 'Pay the deposit');
    assert.deepEqual(pp.selected_icon, { value: '', library: '' },
      'Elementor defaults this to the PayPal glyph; a processor\'s logo goes on a '
      + 'business\'s page only if the business puts it there');
    const st = EMITTERS.stripe_button.settings({ stripe_product_price: '99.50' }, CTX);
    assert.equal(st.stripe_product_price, 99.5);
    assert.deepEqual(st.selected_icon, { value: '', library: '' });
  });

  test('a value the control does not offer becomes the control\'s own default', () => {
    const s = EMITTERS.price_table.settings({ heading_tag: 'marquee', currency_symbol: 'doubloon' }, CTX);
    assert.equal(s.heading_tag, 'h3');
    assert.equal(s.currency_symbol, '');
    const l = EMITTERS.price_list.settings({ title_tag: 'blink', image_size_size: 'huge' }, CTX);
    assert.equal(l.title_tag, 'span');
    assert.equal(l.image_size_size, 'thumbnail');
  });
});

describe('f6-money on a site with no Pro widgets', () => {
  test('a Price Table becomes the same offer, out of FREE widgets', () => {
    const node = EMITTERS.price_table.fallback(TABLE, CTX);
    const flat = JSON.stringify(node);
    assert.ok(flat.includes('Seasonal plan'));
    assert.ok(flat.includes('Spring clean-up'));
    assert.ok(flat.includes('Most chosen'), 'the ribbon\'s words go on the page as words');
    assert.ok(!flat.includes('price-table'), 'the fallback must not publish the paid widget');
    for (const t of JSON.parse(flat).elements.map((e) => e.widgetType)) {
      assert.ok(['heading', 'text-editor', 'icon-list', 'button'].includes(t), t);
    }
  });

  test('nothing typed publishes nothing, rather than an empty bordered box', () => {
    assert.equal(EMITTERS.price_table.fallback({}, CTX), null);
    assert.equal(EMITTERS.price_list.fallback({}, CTX), null);
  });

  test('a payment button refuses rather than publishing a dead button', () => {
    assert.equal(EMITTERS.paypal_button.fallback({ text: 'Pay' }, CTX), null);
    assert.equal(EMITTERS.stripe_button.fallback({ text: 'Pay' }, CTX), null);
    // …and, where the business has its own payment page, it sends people there.
    const node = EMITTERS.stripe_button.fallback(
      { text: 'Pay the deposit', redirect_after_success: { url: 'https://example.test/pay' } }, CTX);
    assert.equal(node.widgetType, 'button');
    assert.equal(node.settings.link.url, 'https://example.test/pay');
    assert.equal(node.settings.text, 'Pay the deposit');
  });

  test('a Lite site is REFUSED BY NAME for a payment button with nowhere to send people', () => {
    // The one that matters: `resolveWidget` is what the publish path calls, and
    // a refusal the client reads beats a button that looks live and is not.
    // `allowPro: false` is how a site says its plan carries no Pro widgets.
    const lite = { seed: 'f6', allowPro: false };
    assert.throws(() => resolveWidget('paypal_button', { text: 'Pay' }, lite),
      (e) => e.code === 'WIDGET_NOT_ON_PLAN' && e.kind === 'paypal_button');
    // …and the same site DOES get the price table, because its fallback has
    // real words to publish.
    const swapped = resolveWidget('price_table', TABLE, lite);
    assert.equal(swapped.swapped.kind, 'price_table');
    assert.ok(JSON.stringify(swapped.node).includes('Seasonal plan'));
  });

  test('a site that HAS Pro publishes the paid widget itself', () => {
    const pro = resolveWidget('price_table', TABLE, { seed: 'f6', allowPro: true });
    assert.equal(pro.node.widgetType, 'price-table');
    assert.equal(pro.swapped, null);
    assert.equal(pro.node.settings._ia_widget, 'price_table');
  });
});
