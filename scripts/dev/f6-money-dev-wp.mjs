/**
 * Publish a page holding ALL FOUR of f6-money's widgets to the dev WordPress,
 * read `_elementor_data` back off the site, and prove the settings survived.
 *
 *   node scripts/dev/f6-money-dev-wp.mjs            # a Standard plan (Pro on)
 *   node scripts/dev/f6-money-dev-wp.mjs --lite     # ARION Lite (fallbacks)
 *
 * B-168 §C.1, and the same reason `tree-roundtrip-dev-wp.mjs` exists: a unit
 * test proves our emitter produced the settings we meant, and it cannot prove
 * the WEBSITE kept them. The page engine's own writer, its sanitiser and its
 * renderer are all between us and a visitor, and a settings key the engine
 * does not have is dropped SILENTLY — the author changes a price and the live
 * page does not move, with a green toast over it.
 *
 * Nothing here is a test double. It writes to the dev fixture site on
 * localhost:8084 and to nothing else (memory: no real client data in dev).
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import {
  writePageSections, fetchPages, fetchPageSections, createPage,
} from '../../lib/websiteBuilder/pageClient.js';
import { pageToElementor, documentToTree, outline } from '../../lib/websiteBuilder/elementorTree.js';

const DEV = 'C:/dev/iadm/dev-stack/wordpress';
const site = {
  site_id: readFileSync(`${DEV}/.site-id`, 'utf8').trim(),
  domain: 'localhost:8084',
  site_token_raw: readFileSync(`${DEV}/.site-token`, 'utf8').trim(),
};

const lite = process.argv.includes('--lite');
const ctx = { allowPro: !lite, iaWidgets: [], seed: 'f6-money-2026-09-19' };

/* THE PAGE — one container holding the family's four, with real words in
   every control a person actually uses. */
const DOC = {
  v: 2,
  settings: {},
  sections: [{
    id: 'f6-sec',
    label: 'What it costs',
    layout: 1,
    style: { padding: { top: 48, right: 20, bottom: 48, left: 20 } },
    columns: [{
      id: 'f6-col',
      widgets: [
        { id: 'f6-h', kind: 'heading', props: { text: 'What it costs', level: 'h2', align: 'center' } },
        {
          id: 'f6-table',
          kind: 'price_table',
          props: {
            heading: 'Seasonal plan', sub_heading: 'Eight visits a season', heading_tag: 'h3',
            currency_symbol: 'pound', price: '1250', currency_format: ',',
            period: 'per season', sale: 'yes', original_price: '1400',
            features_list: [{ item_text: 'Spring clean-up' }, { item_text: 'Two fertiliser rounds' }],
            button_text: 'Choose this plan', link: { url: 'https://example.test/plan' },
            footer_additional_info: 'Prices hold for 30 days.',
            show_ribbon: 'yes', ribbon_title: 'Most chosen', ribbon_horizontal_position: 'left',
          },
        },
        {
          id: 'f6-list',
          kind: 'price_list',
          props: {
            price_list: [
              { title: 'Mowing', price: '65', item_description: 'Weekly, April to October' },
              { title: 'Aeration', price: '180', item_description: 'Once a year' },
            ],
            title_tag: 'h4', description_tag: 'p', image_size_size: 'medium',
          },
        },
        {
          id: 'f6-paypal',
          kind: 'paypal_button',
          props: {
            email: 'pay@example.test', type: 'checkout', product_name: 'Season deposit',
            product_price: '250', quantity: 1, currency: 'USD',
            text: 'Pay the deposit', align: 'center',
            redirect_after_success: { url: 'https://example.test/thanks' },
          },
        },
        {
          id: 'f6-stripe',
          kind: 'stripe_button',
          props: {
            product_name: 'Season deposit', stripe_product_price: '250',
            stripe_currency: 'USD', stripe_quantity: 1,
            text: 'Pay the deposit', align: 'center',
            redirect_after_success: { url: 'https://example.test/thanks' },
          },
        },
      ],
    }],
  }],
};

const TREE = documentToTree(DOC);
const { data, swapped } = pageToElementor(TREE, ctx);
console.log(`plan: ${lite ? 'ARION Lite' : 'ARION Standard'}`);
console.log(outline(TREE[0]).join('\n'));
if (swapped.length) console.log('swapped for the plan:', swapped.map((s) => `${s.nodeId}=${s.kind}`).join(', '));

const TITLE = 'B-168 f6-money check';
const pages = await fetchPages(site);
if (!pages.ok) { console.error('could not list pages:', pages); process.exit(1); }
let page = (pages.data?.pages || []).find((p) => p.title === TITLE);
if (!page) {
  const made = await createPage(site, { title: TITLE, type: 'page', sections: [] });
  if (!made.ok || !made.data?.page_id) { console.error('could not create the page:', made); process.exit(1); }
  page = { page_id: made.data.page_id, title: TITLE };
}
console.log(`page: ${page.title} (${page.page_id})`);

const wrote = await writePageSections(site, page.page_id, {
  sections: data.map((node) => ({ node })), status: 'publish',
});
if (!wrote.ok || wrote.data?.success === false) { console.error('write refused:', wrote); process.exit(1); }

const read = await fetchPageSections(site, page.page_id);
if (!read.ok) { console.error('read-back refused:', read); process.exit(1); }
const live = typeof read.data?.elementor_data === 'string'
  ? JSON.parse(read.data.elementor_data)
  : (read.data?.elementor_data || []);

/** Every widget node the SITE handed back, by our own `_ia_node` stamp. */
const bySource = {};
(function walk(nodes) {
  for (const n of nodes || []) {
    const id = n?.settings?._ia_node;
    if (id) bySource[id] = n;
    walk(n?.elements);
  }
}(live));

console.log('read back off the site:', JSON.stringify(
  Object.entries(bySource).map(([id, n]) => [id, n.widgetType || n.elType])));

if (!lite) {
  /* WHAT THE PAGE ENGINE KEPT. Read off the SITE, never off what we sent. */
  const t = bySource['f6-table'];
  assert.ok(t, 'the price table never came back off the site');
  assert.equal(t.widgetType, 'price-table');
  for (const [k, v] of Object.entries({
    heading: 'Seasonal plan', sub_heading: 'Eight visits a season', heading_tag: 'h3',
    currency_symbol: 'pound', price: '1250', period: 'per season',
    sale: 'yes', button_text: 'Choose this plan',
    footer_additional_info: 'Prices hold for 30 days.',
    show_ribbon: 'yes', ribbon_title: 'Most chosen', ribbon_horizontal_position: 'left',
  })) {
    assert.equal(t.settings[k], v, `price-table.${k} did not survive the website: ${JSON.stringify(t.settings[k])}`);
  }
  assert.equal(t.settings.features_list?.length, 2, 'the features list came back short');
  assert.equal(t.settings.features_list[0].item_text, 'Spring clean-up');

  const l = bySource['f6-list'];
  assert.equal(l.widgetType, 'price-list');
  assert.equal(l.settings.price_list?.length, 2);
  assert.equal(l.settings.price_list[0].title, 'Mowing');
  assert.equal(l.settings.price_list[0].price, '65');
  assert.equal(l.settings.title_tag, 'h4');

  const pp = bySource['f6-paypal'];
  assert.equal(pp.widgetType, 'paypal-button');
  assert.equal(pp.settings.email, 'pay@example.test');
  assert.equal(pp.settings.text, 'Pay the deposit');
  assert.equal(pp.settings.product_price, 250);
  assert.deepEqual(pp.settings.selected_icon, { value: '', library: '' },
    'a processor glyph reached the live page');

  const st = bySource['f6-stripe'];
  assert.equal(st.widgetType, 'stripe-button');
  assert.equal(st.settings.stripe_product_price, 250);

  console.log('\nALL FOUR SURVIVED THE WEBSITE, with the author\'s settings.');
} else {
  /* ON LITE the two price widgets publish their FALLBACK, and the payment
     buttons refuse by name rather than publishing a dead button. */
  const swappedIds = swapped.map((s) => s.nodeId);
  console.log('\nswapped on Lite:', JSON.stringify(swappedIds));
  const flat = JSON.stringify(live);
  assert.ok(flat.includes('Seasonal plan'), 'the Lite visitor must still read the real offer');
  assert.ok(flat.includes('Spring clean-up'));
  assert.ok(!flat.includes('"price-table"'), 'a Lite site must not publish the paid widget');
  console.log('ON LITE: the words are on the page, out of free widgets.');
}
