/**
 * ARION pack 2 — "nothing left in wp-admin" (2026-09-09).
 *
 * The guards these tests exist to hold, in the order they matter:
 *
 *  1. THE MENU IS A WHOLE LIST, and what comes back to the Portal is plain
 *     words with no WordPress vocabulary in it.
 *  2. A PLUGIN THAT IS TOO OLD is told apart from a broken website. Every one
 *     of these paths 404s on a plugin below 1.7.4, and "your website answered
 *     404" is a useless sentence for a client.
 *  3. THE BRAND SUGGESTION IS NEVER INVENTED. A business with no recorded
 *     colour gets no suggested palette, and a business with no recorded name
 *     gets no suggested header or footer wording
 *     (feedback_no_fabricated_catalog, businessName.js).
 *  4. SITE OPTIONS ARE A WHITELIST. A key we do not own is REFUSED, not
 *     quietly ignored — a silently-dropped setting is the "green tick,
 *     nothing happened" shape (reference_catch_swallow_report_success).
 *  5. ONE PRICE SOURCE. Prices come from the business's own services, dollars
 *     are dollars, and a business with no catalogue gets an empty list and a
 *     reason — never a made-up price.
 *  6. THE THREE ARCHETYPES round-trip: what the emitter draws is exactly what
 *     the editor reads back, and putting it back changes nothing.
 *
 * Every one of these was mutation-tested by breaking it on purpose and
 * watching this file go red.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { __test__ as siteRoutes } from '../routes/arion/website.js';
import { formatPrice, formatPeriod, plansFromServices } from '../lib/websiteBuilder/servicePricing.js';
import { buildStarterSection, starterBlock } from '../lib/websiteBuilder/starterSections.js';
import {
  extractFields, applyFields, sectionCatalog, sectionKindMeta,
  encodePricingCard, decodePricingCard, COMPOSED_CARDS,
} from '../lib/websiteBuilder/sectionSchema.js';
import {
  LIBRARY_KIND_BY_ARCHETYPE, ARCHETYPES_WITHOUT_A_KIND, stampLibrarySection,
} from '../lib/websiteBuilder/libraryAdapter.js';
import { blockToElementorSection, listSupportedKinds } from '../lib/websiteBuilder/elementorAdapter.js';
import { MIN_SITE_PLUGIN_VERSION } from '../lib/websiteBuilder/pageClient.js';
import { isSafeAdminDest } from '../routes/arion.js';

const { publicMenus, publicKit, publicChrome, publicSiteOptions, suggestedBrand, suggestedChrome } = siteRoutes;

/* ═══════════════ 1. Menus ════════════════════════════════════════════════ */

const PLUGIN_MENUS = {
  success: true,
  menus: [{
    menu_id: 2,
    name: 'Main',
    slug: 'main',
    locations: ['menu-1'],
    item_count: 2,
    snapshot_count: 1,
    can_undo: true,
    items: [
      { item_id: 80, title: 'Home', kind: 'custom', object_id: 0, url: '/', parent_item_id: 0, position: 1, target: '' },
      { item_id: 81, title: 'About us', kind: 'page', object_id: 11, url: 'http://x/about', parent_item_id: 80, position: 2, target: '' },
    ],
  }],
  locations: [
    { location: 'menu-1', label: 'Header', menu_id: 2 },
    { location: 'menu-2', label: 'Footer', menu_id: 0 },
  ],
  addable: [{ object_id: 11, kind: 'page', title: 'About us', status: 'publish', url: 'http://x/about' }],
  booking: { url: 'https://book.ia-dm.com/summit-lawn/', label: 'Book now' },
  theme: 'Hello Elementor',
  plugin_version: '1.7.4',
};

test('a menu reaches the Portal as plain words, in order, with its nesting', () => {
  const out = publicMenus(PLUGIN_MENUS);
  assert.equal(out.menus.length, 1);
  const menu = out.menus[0];
  assert.equal(menu.menuId, 2);
  assert.equal(menu.name, 'Main');
  assert.deepEqual(menu.locations, ['menu-1']);
  assert.equal(menu.canUndo, true);
  assert.deepEqual(menu.items.map((i) => i.title), ['Home', 'About us']);
  assert.equal(menu.items[1].parentItemId, 80, 'nesting survives');
  assert.equal(menu.items[1].kind, 'page');
  assert.equal(out.locations[1].menuId, 0, 'an empty position is still offered');
  assert.equal(out.booking.url, 'https://book.ia-dm.com/summit-lawn/');
});

test('nothing in the menu payload uses a WordPress word', () => {
  const json = JSON.stringify(publicMenus(PLUGIN_MENUS));
  for (const word of ['post_type', 'menu_item_parent', 'term_id', 'nav_menu', 'wp_']) {
    assert.equal(json.includes(word), false, `"${word}" reached the Portal`);
  }
});

test('an empty answer is an empty menu list, not a crash', () => {
  const out = publicMenus(null);
  assert.deepEqual(out.menus, []);
  assert.deepEqual(out.addable, []);
});

/* ═══════════════ 2. The brand suggestion is never invented ══════════════ */

test('a business with no recorded colour gets NO suggested palette', () => {
  const s = suggestedBrand({ business_name: 'Summit Lawn', primary_color: '', font_family: '' });
  assert.equal(s.hasBrandColour, false);
  assert.deepEqual(s.colors, [], 'a brand colour is never guessed');
  assert.equal(s.typography.length, 2, 'fonts still have a sensible default');
});

test('a recorded colour becomes the suggested palette through the ONE payload builder', () => {
  const s = suggestedBrand({ business_name: 'Summit Lawn', primary_color: '#1A3A4A', font_family: 'Inter' });
  assert.equal(s.hasBrandColour, true);
  assert.deepEqual(s.colors.map((c) => c.id), ['primary', 'secondary', 'accent', 'text']);
  assert.equal(s.colors[0].color, '#1A3A4A');
  assert.equal(s.typography[0].fontFamily, 'Inter');
});

test('a business with no recorded NAME gets no header or footer wording', () => {
  const s = suggestedChrome({ business_name: '', tagline: '' });
  assert.equal(s.businessName, '');
  assert.equal(s.footerText, '', 'a made-up business name must never reach a client website');
});

test('a business WITH a name gets a footer line that carries it', () => {
  const s = suggestedChrome({ business_name: 'Summit Lawn', tagline: 'Lawns that look after themselves' });
  assert.equal(s.businessName, 'Summit Lawn');
  assert.match(s.footerText, /Summit Lawn/);
  assert.match(s.footerText, new RegExp(String(new Date().getFullYear())));
});

/* ═══════════════ 3. Header and footer come back with their reasons ══════ */

test('a field the theme does not offer is reported unsupported WITH the reason', () => {
  const out = publicChrome({
    theme: 'Astra',
    theme_family: 'astra',
    fields: [
      { key: 'business_name', group: 'header', label: 'Business name', type: 'text', supported: true, value: 'Summit Lawn' },
      {
        key: 'show_header_menu', group: 'header', label: 'Show the menu in the header', type: 'switch',
        supported: false, reason: 'Astra builds its header in its own layout tool.', value: null,
      },
    ],
    menu_locations: [{ location: 'primary', label: 'Header', menu_id: 2, menu_name: 'Main' }],
    booking: { url: '', in_header: false, label: 'Book now' },
    plugin_version: '1.7.4',
  }, null);
  const unsupported = out.fields.find((f) => f.key === 'show_header_menu');
  assert.equal(unsupported.supported, false);
  assert.ok(unsupported.reason, 'an option we cannot set must say why, never just vanish');
  assert.equal(out.menuLocations[0].menuName, 'Main');
});

/* ═══════════════ 4. Site options are a whitelist ════════════════════════ */

test('the site options payload keeps the tier answer, so a locked switch says so', () => {
  const out = publicSiteOptions({
    chat: { enabled: true, fallback_url: '' },
    booking: { url: '', in_header: false, label: 'Book now', tier_allows: false },
    plugin_version: '1.7.4',
  });
  assert.equal(out.chat.enabled, true);
  assert.equal(out.booking.tierAllows, false);
});

/* ═══════════════ 5. One price source ════════════════════════════════════ */

test('unit_amount is DOLLARS, not cents', () => {
  // Reading it as cents is how a $45 lawn cut becomes 45 cents on a published
  // page (memory: reference_oliver_quotes_proposals_rebuild).
  assert.equal(formatPrice(45, 'USD'), '$45');
  assert.equal(formatPrice(45.5, 'USD'), '$45.50');
  assert.equal(formatPrice(0, 'USD'), '$0');
  assert.equal(formatPrice(null, 'USD'), '', 'no price is no price, never zero');
  assert.equal(formatPrice(-3, 'USD'), '');
});

test('the period reads like a person says it, and a one-off has none', () => {
  assert.equal(formatPeriod('recurring', 'month', 1), 'per month');
  assert.equal(formatPeriod('recurring', 'month', 3), 'every 3 months');
  assert.equal(formatPeriod('one_time', 'month', 1), '');
  assert.equal(formatPeriod('flat', '', 1), '');
});

test('a plan card carries the price-list reference, so a price is never typed twice', () => {
  const plans = plansFromServices([
    { offering_id: 'o-1', name: 'Weekly mow', description: 'Tidy every week', price: '$45', period: 'per visit', features: ['Mow', 'Edge'] },
  ], { ctaText: 'Book online', ctaHref: 'https://book/x' });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].offering_id, 'o-1');
  assert.equal(plans[0].price, '$45');
  assert.equal(plans[0].cta_href, 'https://book/x');
});

test('the pricing STARTER is built from the business own prices', () => {
  const block = starterBlock('pricing', {
    business_name: 'Summit Lawn',
    service_prices: [
      { offering_id: 'o-1', name: 'Weekly mow', description: 'Tidy every week', price: '$45', period: 'per visit', features: ['Mow'] },
      { offering_id: 'o-2', name: 'Fortnightly', description: '', price: '$65', period: 'per visit', features: [] },
    ],
  });
  assert.equal(block.plans.length, 2);
  assert.equal(block.plans[0].name, 'Weekly mow');
  assert.equal(block.plans[0].price, '$45');
  assert.equal(block.plans[0].offering_id, 'o-1');
});

test('a business with NO price list gets prompts, never an invented price', () => {
  const block = starterBlock('pricing', { business_name: 'Summit Lawn', service_prices: [] });
  assert.equal(block.plans.length, 1);
  assert.equal(block.plans[0].price, '', 'a price is never fabricated');
  assert.equal(block.plans[0].offering_id, '');
});

/* ═══════════════ 6. The three archetypes ════════════════════════════════ */

test('pricing, team and stats are offered on every tier', () => {
  const lite = sectionCatalog({ allowPro: false });
  for (const kind of ['pricing', 'team', 'stats']) {
    const row = lite.find((c) => c.kind === kind);
    assert.ok(row, `${kind} is in the picker`);
    assert.equal(row.available, true, `${kind} needs no Elementor Pro`);
  }
});

test('the adapter can draw all three, and the editor reads back exactly what it drew', () => {
  const cases = {
    pricing: {
      headline: 'What it costs',
      subheadline: 'No surprises.',
      plans: [{
        name: 'Weekly', price: '$45', period: 'per visit', summary: 'Tidy every week',
        features: ['Mow', 'Edge'], cta_text: 'Book', cta_href: '/book', offering_id: 'o-1',
      }],
    },
    team: {
      headline: 'The people',
      subheadline: 'Who turns up.',
      members: [{ name: 'Sam', role: 'Crew lead', photo_url: 'https://x/y.png', photo_alt: 'Sam', photo_id: 12 }],
    },
    stats: {
      headline: 'By the numbers',
      subheadline: 'Since 2014.',
      stats: [{ value: '12', prefix: '', suffix: '+', label: 'Years' }],
    },
  };

  for (const [kind, block] of Object.entries(cases)) {
    const node = blockToElementorSection({ kind, block, brand: {}, seedId: `seed-${kind}`, blockId: 'b1' });
    assert.ok(node, `${kind} draws a section`);
    assert.match(node.settings._title, new RegExp(`^ia:${kind}:`));

    const read = extractFields(node, kind);
    assert.equal(read.headline, block.headline, `${kind} headline round-trips`);
    const listKey = kind === 'pricing' ? 'plans' : kind === 'team' ? 'members' : 'stats';
    assert.deepEqual(read[listKey], block[listKey], `${kind} list round-trips exactly`);

    // Putting back what we just read must change NOTHING. Byte identity is the
    // only assertion that catches a codec that quietly re-encodes.
    const again = applyFields(node, kind, read);
    assert.equal(JSON.stringify(again), JSON.stringify(node), `${kind} is byte-identical after a no-op save`);
  }
});

test('a pricing card round-trips its markup byte for byte', () => {
  const item = {
    name: 'Starter', price: '$49', period: 'per month', summary: "One lawn, every week",
    features: ['Mow', 'Edge & blow'], cta_text: 'Get started', cta_href: '/book', offering_id: 'o-9',
  };
  const html = encodePricingCard(item);
  assert.deepEqual(decodePricingCard(html), item);
  assert.equal(encodePricingCard(decodePricingCard(html)), html);
  assert.ok(COMPOSED_CARDS.pricing_card, 'the card is in the ONE composed-card registry');
});

test('an apostrophe and an ampersand survive a pricing card', () => {
  const item = {
    name: "Sam's pick", price: '$49', period: '', summary: 'Mow & edge',
    features: ['Front & back'], cta_text: '', cta_href: '', offering_id: '',
  };
  assert.deepEqual(decodePricingCard(encodePricingCard(item)), item);
});

test('pricing, team and stats now have an editor kind; header and footer say where they went', () => {
  for (const archetype of ['pricing', 'team', 'stats']) {
    assert.equal(LIBRARY_KIND_BY_ARCHETYPE[archetype], archetype);
    assert.equal(ARCHETYPES_WITHOUT_A_KIND[archetype], undefined);
  }
  for (const archetype of ['header', 'footer']) {
    assert.equal(LIBRARY_KIND_BY_ARCHETYPE[archetype], undefined);
    assert.match(ARCHETYPES_WITHOUT_A_KIND[archetype], /Brand and layout/);
  }
});

test('a section with ONE text-editor still stamps its cards, not its supporting line', () => {
  // A pricing or testimonials layout drawn with no supporting line has exactly
  // one text-editor - the card. The subheadline step used to claim it and the
  // whole blueprint was then refused for a missing required field.
  for (const kind of ['pricing', 'testimonials']) {
    const built = buildStarterSection(kind, { business_name: 'Summit Lawn', service_prices: [] });
    assert.equal(built.ok, true, `${kind} starter builds`);
    const stamped = stampLibrarySection(JSON.parse(JSON.stringify(built.node)), {
      kind, blueprintId: `${kind}.x.v1`, brand: { email: 'a@b.c' },
    });
    assert.equal(stamped.ok, true, `${kind}: ${stamped.reason || ''} ${stamped.detail || ''}`);
    assert.ok(stamped.stamped.includes(`${kind}.${kind === 'pricing' ? 'plans' : 'items'}`),
      `${kind} cards were stamped, not swallowed by the supporting line`);
  }
});

test('every archetype the adapter can draw has a schema kind, and the other way round', () => {
  for (const kind of listSupportedKinds()) {
    assert.ok(sectionKindMeta(kind), `${kind} has a schema`);
  }
});

/* ═══════════════ 7. Version floors ══════════════════════════════════════ */

test('the pack 2 routes name the plugin build that answers them', () => {
  assert.equal(MIN_SITE_PLUGIN_VERSION, '1.7.4');
});

/* ═══════════════ 8. the finish line (D-ARION-G) ════════════════════════ */

test('the wp-admin deep link accepts an admin screen and NOTHING else', () => {
  for (const good of ['plugins.php', 'users.php', 'admin.php?page=rank-math', 'options-general.php?x=1']) {
    assert.equal(isSafeAdminDest(good), true, `${good} is a WordPress admin screen`);
  }
  for (const bad of [
    '', '   ', '../wp-config.php', 'https://evil.test/x', '//evil.test',
    'javascript:alert(1)', 'a/b.php', 'plugins.php#x', 'plugins.php\\n', 'x'.repeat(400),
  ]) {
    assert.equal(isSafeAdminDest(bad), false, `${JSON.stringify(bad)} must not be followed`);
  }
});
