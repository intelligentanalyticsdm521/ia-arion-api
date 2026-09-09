/**
 * ARION pack 2b — the list-item binding form.
 * ---------------------------------------------------------------------------
 * Pack 2 taught the editor pricing, team and stats and guessed how the curated
 * library draws them. The guess was wrong on all three: the library does not
 * draw a list as one widget per item, it draws a CARD — a container with
 * several widgets inside it — so 40 blueprints were refused (D-83).
 *
 * These tests hold the second shape: `repeat:'container'`, one card per item
 * with named roles inside it. They are all pure — no site, no database, no
 * network — and the live half is `scripts/_dev_verify_pack2b.mjs`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  CODECS, COMPOSED_PARTS, BINDINGS, ROLE_MARKER, ROLE_REVIEW_MARKER,
  decodeStatNumber, encodeStatNumber,
  extractFields, applyFields, validateFields, reduceToSectionList,
  itemFieldsFor, roleReviewFor, swapItemRoles, collectRoles, sectionKindMeta,
} from '../lib/websiteBuilder/sectionSchema.js';
import {
  findItemGroup, assignRoles, stampLibrarySection, mapLibrarySection,
} from '../lib/websiteBuilder/libraryAdapter.js';
import {
  fillPricingFromCatalogue, neutraliseSampleWords, neverInventValues, SAMPLE_WORD_PROMPTS,
} from '../lib/websiteBuilder/libraryCatalog.js';

/* ==========================================================================
 * Fixtures — drawn the way the curated library actually draws these.
 * ======================================================================== */

let seq = 0;
const id = () => `n${++seq}`;

const w = (widgetType, settings) => ({ id: id(), elType: 'widget', widgetType, settings });
const box = (elements, settings = {}) => ({ id: id(), elType: 'container', settings, elements });

const heading = (title, size = 'h3') => w('heading', { title, header_size: size });
const editor = (html) => w('text-editor', { editor: html });
const button = (text, url = '#') => w('button', { text, link: { url } });
const image = (url) => w('image', { image: { url, id: '' } });
/** The one URL every picture in the curated library actually points at. */
const PLACEHOLDER = 'https://azure-coyote-795824.hostingersite.com/wp-content/plugins/elementor/assets/images/placeholder.png';

/** `heading + heading + text-editor + text-editor + button`, ×n, in a row. */
function pricingSection({ cards = 3, headline = 'Simple, honest pricing' } = {}) {
  const names = ['Starter', 'Growth', 'Scale', 'Enterprise'];
  const prices = ['$0', '$49', '$149', '$499'];
  return box([
    heading(headline, 'h2'),
    box(Array.from({ length: cards }, (_, i) => box([
      heading(names[i] || `Plan ${i + 1}`, 'h4'),
      heading(prices[i] || '$0', 'h2'),
      editor('<p> /mo</p>'),
      editor(`<p>✓ First thing<br>✓ Second thing</p>`),
      button('Get Started'),
    ]))),
  ]);
}

function teamSection({ cards = 3 } = {}) {
  const names = ['Brandon', 'Alex', 'Sam'];
  return box([
    heading('Meet the team', 'h2'),
    box(Array.from({ length: cards }, (_, i) => box([
      image(PLACEHOLDER),
      heading(names[i] || `Person ${i + 1}`, 'h5'),
      editor('<p>Founder &amp; Lead</p>'),
    ]))),
  ]);
}

function statsSection({ cards = 4 } = {}) {
  const numbers = ['15+', '200+', '98%', '40%'];
  const labels = ['years building', 'clients served', 'client retention', 'faster reporting'];
  return box([
    heading('By the numbers', 'h2'),
    box(Array.from({ length: cards }, (_, i) => box([
      heading(numbers[i] || '1', 'h1'),
      editor(`<p>${labels[i] || 'a thing'}</p>`),
    ]))),
  ]);
}

function testimonialsSection({ cards = 3 } = {}) {
  return box([
    heading('What clients say', 'h2'),
    box(Array.from({ length: cards }, (_, i) => box([
      editor(`<p>“Quote number ${i + 1}, which is quite a long sentence.”</p>`),
      heading(`Person ${i + 1}`, 'h5'),
      editor('<p>Operations Lead</p>'),
    ]))),
  ]);
}

const BRAND = { email: 'owner@example.invalid' };

function stamp(kind, node, blueprintId = `${kind}.fixture.v1`) {
  return stampLibrarySection(node, { kind, blueprintId, brand: BRAND });
}

/* ==========================================================================
 * 1. The two new codecs
 * ======================================================================== */

test('a "what is included" list survives being read and written back', () => {
  const src = '<p>✓ First thing<br>✓ Second thing<br>✓ Third</p>';
  const lines = CODECS.html_lines.decode(src);
  assert.deepEqual(lines, ['✓ First thing', '✓ Second thing', '✓ Third']);
  assert.equal(CODECS.html_lines.encode(lines), src);
});

test('a list drawn as bullet points reads as the same lines', () => {
  assert.deepEqual(
    CODECS.html_lines.decode('<ul><li>One</li><li>Two</li></ul>'),
    ['One', 'Two'],
  );
});

test('an empty list is an empty list, not a line of nothing', () => {
  assert.deepEqual(CODECS.html_lines.decode('<p></p>'), []);
  assert.equal(CODECS.html_lines.encode([]), '<p></p>');
});

test('a hand-drawn number splits into the number and what is around it', () => {
  assert.deepEqual(decodeStatNumber('15+'), { prefix: '', value: '15', suffix: '+' });
  assert.deepEqual(decodeStatNumber('$2.5M'), { prefix: '$', value: '2.5', suffix: 'M' });
  assert.deepEqual(decodeStatNumber('98%'), { prefix: '', value: '98', suffix: '%' });
  assert.deepEqual(decodeStatNumber('Fast'), { prefix: '', value: 'Fast', suffix: '' });
});

test('the space either side of a number is kept, so "Under 24 hrs" comes back whole', () => {
  const parts = decodeStatNumber('Under 24 hrs');
  assert.deepEqual(parts, { prefix: 'Under ', value: '24', suffix: ' hrs' });
  assert.equal(encodeStatNumber(parts), 'Under 24 hrs');
});

test('every part codec round-trips every number the library actually uses', () => {
  for (const raw of ['15+', '200+', '98%', '40%', '$1,500', '24/7', '3.5x']) {
    assert.equal(COMPOSED_PARTS.stat_number.encode(COMPOSED_PARTS.stat_number.decode(raw)), raw, raw);
  }
});

/* ==========================================================================
 * 2. Finding the cards — structure only, no content read
 * ======================================================================== */

test('the repeating cards are found, and the section headline is not one of them', () => {
  const group = findItemGroup(pricingSection({ cards: 3 }));
  assert.ok(group);
  assert.equal(group.items.length, 3);
  assert.equal(group.signature, 'heading,heading,text-editor,text-editor,button');
});

test('one card is not a list', () => {
  // `testimonials.single-large.v1` — a single quote drawn as a section. There
  // is nothing here to add to or take away from, so it is not offered.
  const node = box([box([editor('<p>“One quote.”</p>'), heading('Sarah K.', 'h5')])]);
  assert.equal(findItemGroup(node), null);
});

test('two cards drawn differently from each other are not a list', () => {
  // `testimonials.stat-quote.v1` — a statistic beside a quote. Same two widget
  // types, opposite order, completely different meaning.
  const node = box([box([
    box([heading('98%', 'h1'), editor('<p>client retention</p>')]),
    box([editor('<p>“A quote.”</p>'), heading('Mike R.', 'h5')]),
  ])]);
  assert.equal(findItemGroup(node), null);
});

test('an intro block drawn like a card does not steal the list', () => {
  // `stats.split-text.v1` — an intro of heading+text beside four cards of
  // heading+text. The four win, and the intro's heading is left for the
  // section headline.
  const node = box([
    box([heading('Numbers that matter', 'h2'), editor('<p>Fifteen years.</p>')]),
    box(Array.from({ length: 4 }, () => box([heading('15+', 'h1'), editor('<p>years</p>')]))),
  ]);
  const group = findItemGroup(node);
  assert.equal(group.items.length, 4);
});

test('with two possible lists in one layout, the longer one is the list', () => {
  // A two-card intro row above a four-card band, drawn identically. Both are
  // uniform groups; the four are the list and the two are decoration.
  const pair = (n) => box(Array.from({ length: n }, () => box([heading('15+', 'h1'), editor('<p>years</p>')])));
  const group = findItemGroup(box([heading('Numbers', 'h2'), pair(2), pair(4)]));
  assert.equal(group.items.length, 4);
  // and the other way round in the document, so it is the SIZE that decides
  const other = findItemGroup(box([heading('Numbers', 'h2'), pair(4), pair(2)]));
  assert.equal(other.items.length, 4);
});

test('a card nested two deep is still one card', () => {
  // `team.list-rows.v1` — each row is a picture container beside a text one.
  const row = () => box([box([image('https://x.invalid/p.png')]), box([heading('Brandon', 'h5'), editor('<p>Founder</p>')])]);
  const node = box([heading('The team', 'h2'), box([row(), row(), row()])]);
  const group = findItemGroup(node);
  assert.equal(group.items.length, 3);
  assert.equal(group.signature, 'image,heading,text-editor');
});

/* ==========================================================================
 * 3. The role rules — and the flag when they had to guess
 * ======================================================================== */

const rolesOf = (kind, widgets) => {
  const { assign, review } = assignRoles(kind, widgets);
  return { roles: widgets.map((x) => assign.get(x) || null), review };
};

test('on a price card the heading with the money on it is the price', () => {
  const ws = [heading('Starter', 'h4'), heading('$49', 'h2'), editor('<p> /mo</p>'), editor('<p>✓ A<br>✓ B</p>'), button('Go')];
  const { roles, review } = rolesOf('pricing', ws);
  assert.deepEqual(roles, ['name', 'price', 'period', 'features', 'cta']);
  assert.equal(review.length, 0);
});

test('the price can be drawn first and it is still the price', () => {
  const ws = [heading('$49', 'h2'), heading('Starter', 'h4')];
  const { roles, review } = rolesOf('pricing', ws);
  assert.deepEqual(roles, ['price', 'name']);
  assert.equal(review.length, 0);
});

test('when neither heading says a price, we go by the order AND we say so', () => {
  // `pricing.2col-simple.v1` really is drawn "Project / Fixed".
  const ws = [heading('Project', 'h4'), heading('Fixed', 'h2')];
  const { roles, review } = rolesOf('pricing', ws);
  assert.deepEqual(roles, ['name', 'price']);
  assert.equal(review.length, 1);
  assert.deepEqual(review[0].roles, ['name', 'price']);
  assert.match(review[0].why, /order/i);
});

test('the bulleted block is what is included, however short it is', () => {
  // `pricing.feature-checklist.v1` draws an EMPTY period and a one-line list.
  const ws = [editor('<p></p>'), editor('<p>✓ Basics</p>')];
  const { roles, review } = rolesOf('pricing', ws);
  assert.deepEqual(roles, ['period', 'features']);
  assert.equal(review.length, 0);
});

test('with nothing to go on, the longer block is what is included AND we say so', () => {
  const ws = [editor('<p>per month</p>'), editor('<p>Everything you need to get going today</p>')];
  const { roles, review } = rolesOf('pricing', ws);
  assert.deepEqual(roles, ['period', 'features']);
  assert.equal(review.length, 1);
  assert.deepEqual(review[0].roles.slice().sort(), ['features', 'period']);
});

test('the text in quotation marks is the quote, not the job title', () => {
  const ws = [editor('<p>Operations Lead</p>'), editor('<p>“They were quick.”</p>'), heading('Sarah K.', 'h5')];
  const { roles, review } = rolesOf('testimonials', ws);
  assert.deepEqual(roles, ['role', 'quote', 'attribution']);
  assert.equal(review.length, 0);
});

test('a quote with no quotation marks falls back to length AND we say so', () => {
  const ws = [editor('<p>They were quick and the work was good all the way through.</p>'), editor('<p>Owner</p>')];
  const { roles, review } = rolesOf('testimonials', ws);
  assert.deepEqual(roles, ['quote', 'role']);
  assert.equal(review.length, 1);
});

test('the vendor’s grey placeholder never reaches a client’s page', () => {
  // Every image in the curated library is Elementor's own placeholder file.
  const res = stamp('team', teamSection());
  const members = extractFields(res.node, 'team').members;
  assert.equal(members.every((m) => m.photo_url === ''), true);
  assert.equal(/placeholder\.png/.test(JSON.stringify(res.node)), false);
  // …and with no picture there is nothing to describe, so the section saves.
  assert.equal(validateFields('team', extractFields(res.node, 'team')).ok, true);
});

test('a person card needs no guessing at all — the widget type answers it', () => {
  const ws = [image('https://x.invalid/p.png'), heading('Brandon', 'h5'), editor('<p>Founder</p>')];
  const { roles, review } = rolesOf('team', ws);
  assert.deepEqual(roles, ['photo', 'name', 'role']);
  assert.equal(review.length, 0);
});

/* ==========================================================================
 * 4. Stamp -> read -> write -> read
 * ======================================================================== */

for (const [kind, make, list] of [
  ['pricing', pricingSection, 'plans'],
  ['team', teamSection, 'members'],
  ['stats', statsSection, 'stats'],
  ['testimonials', testimonialsSection, 'testimonials'],
]) {
  test(`a hand-drawn ${kind} layout is claimed, read and written back unchanged`, () => {
    const res = stamp(kind, make());
    assert.equal(res.ok, true, res.detail);
    const before = extractFields(res.node, kind);
    assert.ok(Array.isArray(before[list]) && before[list].length >= 2);
    assert.ok(before.headline, 'the section keeps a headline of its own');

    // Writing back exactly what we read changes nothing at all.
    const same = applyFields(res.node, kind, before);
    assert.deepEqual(extractFields(same, kind), before);
    assert.equal(JSON.stringify(same), JSON.stringify(res.node));
  });

  test(`editing one field of one ${kind} card leaves the rest of the layout alone`, () => {
    const res = stamp(kind, make());
    const before = extractFields(res.node, kind);
    // Not `value` on a stats card: that one is half of a composed number, and
    // changing it deliberately keeps the "+" that was already after it.
    const skip = new Set(['value', 'prefix', 'suffix', 'photo_url', 'photo_id']);
    const key = Object.keys(before[list][0])
      .find((k) => !skip.has(k) && typeof before[list][0][k] === 'string' && before[list][0][k]);
    const patched = applyFields(res.node, kind, {
      [list]: before[list].map((item, i) => (i === 0 ? { ...item, [key]: 'CHANGED' } : item)),
    });
    const after = extractFields(patched, kind);
    assert.equal(after[list][0][key], 'CHANGED');
    assert.equal(after[list].length, before[list].length, 'no card was dropped');
    assert.deepEqual(after[list].slice(1), before[list].slice(1), 'the other cards are untouched');
    assert.equal(after.headline, before.headline);
  });

  test(`the ${kind} section reads as editable through the ordinary page path`, () => {
    const res = stamp(kind, make());
    const [entry] = reduceToSectionList([res.node]);
    assert.equal(entry.editable, true);
    assert.equal(entry.kind, kind);
    assert.ok(entry.itemFields?.[list]?.length);
  });
}

test('adding a card clones the last one, so the new one has the same design', () => {
  const res = stamp('pricing', pricingSection({ cards: 2 }));
  const before = extractFields(res.node, 'pricing');
  const node = applyFields(res.node, 'pricing', {
    plans: [...before.plans, {
      name: 'Platinum', price: '$999', period: '/yr', features: ['✓ All of it'],
      cta_text: 'Buy', cta_href: '/book', offering_id: 'off-7',
    }],
  });
  const after = extractFields(node, 'pricing');
  assert.equal(after.plans.length, 3);
  assert.equal(after.plans[2].name, 'Platinum');
  assert.equal(after.plans[2].price, '$999');
  assert.deepEqual(after.plans[2].features, ['✓ All of it']);
  // The new card carries the offering id, which is the whole reason a price is
  // never matched on a name the client can change.
  assert.equal(after.plans[2].offering_id, 'off-7');
  // …and it is a real Elementor card, not a stub.
  assert.equal(after.plans[0].cta_text, before.plans[0].cta_text);
});

test('removing a card removes the whole card, not just its words', () => {
  const res = stamp('team', teamSection({ cards: 3 }));
  const before = extractFields(res.node, 'team');
  const node = applyFields(res.node, 'team', { members: before.members.slice(0, 1) });
  assert.equal(extractFields(node, 'team').members.length, 1);
  // The container went with it: nothing is left holding an empty card.
  assert.equal(JSON.stringify(node).match(/_ia_field/g).length,
    JSON.stringify(res.node).match(/_ia_field/g).length - 2);
});

test('a number typed as 12 with a + after it comes back as 12+', () => {
  const res = stamp('stats', statsSection());
  const node = applyFields(res.node, 'stats', {
    stats: [{ value: '12', prefix: '', suffix: '+', label: 'Years' }],
  });
  const after = extractFields(node, 'stats');
  assert.deepEqual(after.stats[0], { prefix: '', value: '12', suffix: '+', label: 'Years' });
  // and on the page it is one heading that reads "12+"
  assert.match(JSON.stringify(node), /"title":"12\+"/);
});

/* ==========================================================================
 * 5. A box with nowhere to go is not offered
 * ======================================================================== */

test('a layout with no star rating does not offer a star rating box', () => {
  const res = stamp('testimonials', testimonialsSection());
  const fields = itemFieldsFor(res.node, 'testimonials');
  assert.deepEqual(fields.testimonials.slice().sort(), ['attribution', 'quote', 'role']);
  assert.equal(fields.testimonials.includes('rating'), false);
});

test('a price card drawn without a "how often" line does not offer one', () => {
  // `pricing.cards-icon.v1` — an icon-box carries the name and the price
  // together, and there is no separate period.
  const node = box([
    heading('Choose what fits', 'h2'),
    box(Array.from({ length: 3 }, () => box([
      w('icon-box', { title_text: 'Starter', description_text: '$0/mo' }),
      editor('<p>✓ One<br>✓ Two</p>'),
      button('Go'),
    ]))),
  ]);
  const res = stamp('pricing', node);
  assert.equal(res.ok, true, res.detail);
  const fields = itemFieldsFor(res.node, 'pricing');
  assert.equal(fields.plans.includes('period'), false);
  assert.equal(fields.plans.includes('name'), true);
  assert.equal(fields.plans.includes('price'), true);
});

test('our own sections say nothing about item fields, so nothing changes for them', () => {
  const scratch = { id: 'x', elType: 'container', settings: { _title: 'ia:hero:scratch:-' }, elements: [] };
  const [entry] = reduceToSectionList([scratch]);
  assert.equal(entry.itemFields, null);
  assert.equal(entry.roleReview, null);
});

/* ==========================================================================
 * 6. "Check this" — the flag, and the one tap that answers it
 * ======================================================================== */

function ambiguousPricing() {
  return box([
    heading('Two ways to work with us', 'h2'),
    box([1, 2].map(() => box([
      heading('Project', 'h4'),
      heading('Fixed', 'h2'),
      editor('<p>per month</p>'),
      editor('<p>Everything you need to get going today</p>'),
      button('Start'),
    ]))),
  ]);
}

test('a guessed role is written on the section, not left to look like a decision', () => {
  const res = stamp('pricing', ambiguousPricing());
  assert.equal(res.ok, true, res.detail);
  const review = roleReviewFor(res.node);
  assert.equal(review.length, 2);
  const pairs = review.map((r) => r.roles.slice().sort().join('|')).sort();
  assert.deepEqual(pairs, ['features|period', 'name|price']);
  for (const r of review) {
    assert.equal(r.list, 'plans');
    assert.ok(r.why.length > 20, 'the reason is a sentence, not a code');
    assert.ok(r.fields.length >= 2, 'it names the boxes the client can see');
  }
});

test('one tap swaps the two over on EVERY card, not just the first', () => {
  const res = stamp('pricing', ambiguousPricing());
  const before = extractFields(res.node, 'pricing');
  assert.equal(before.plans[0].name, 'Project');
  assert.equal(before.plans[0].price, 'Fixed');

  const swapped = swapItemRoles(res.node, 'pricing', 'plans', 'name', 'price');
  assert.equal(swapped.ok, true);
  assert.equal(swapped.swapped, 2, 'both cards');
  const after = extractFields(swapped.node, 'pricing');
  assert.equal(after.plans[0].name, 'Fixed');
  assert.equal(after.plans[0].price, 'Project');
  assert.equal(after.plans[1].name, 'Fixed');
});

test('answering a "check this" clears that one and leaves the other standing', () => {
  const res = stamp('pricing', ambiguousPricing());
  const swapped = swapItemRoles(res.node, 'pricing', 'plans', 'name', 'price');
  const left = roleReviewFor(swapped.node);
  assert.equal(left.length, 1);
  assert.deepEqual(left[0].roles.slice().sort(), ['features', 'period']);

  const both = swapItemRoles(swapped.node, 'pricing', 'plans', 'period', 'features');
  assert.equal(roleReviewFor(both.node), null);
  assert.equal(both.node.settings[ROLE_REVIEW_MARKER], undefined);
});

test('a swap moves the two markers and NOTHING else about the layout', () => {
  const res = stamp('pricing', ambiguousPricing());
  const swapped = swapItemRoles(res.node, 'pricing', 'plans', 'name', 'price');
  const strip = (n) => JSON.stringify(n, (k, v) => (k === ROLE_MARKER || k === ROLE_REVIEW_MARKER ? undefined : v));
  assert.equal(strip(swapped.node), strip(res.node));
});

test('two roles that are not two of the same kind of widget cannot be swapped', () => {
  const res = stamp('pricing', ambiguousPricing());
  assert.deepEqual(swapItemRoles(res.node, 'pricing', 'plans', 'name', 'cta'), { ok: false, reason: 'unknown_roles' });
  assert.deepEqual(swapItemRoles(res.node, 'pricing', 'plans', 'name', 'nonsense'), { ok: false, reason: 'unknown_roles' });
});

test('a swap on a section that has no such cards changes nothing', () => {
  const plain = { id: 'x', elType: 'container', settings: { _title: 'ia:pricing:scratch:-' }, elements: [] };
  assert.equal(swapItemRoles(plain, 'pricing', 'plans', 'name', 'price').ok, false);
});

test('a clear layout raises no flag at all — the client is not asked for nothing', () => {
  assert.equal(roleReviewFor(stamp('pricing', pricingSection()).node), null);
  assert.equal(roleReviewFor(stamp('team', teamSection()).node), null);
  assert.equal(roleReviewFor(stamp('stats', statsSection()).node), null);
  assert.equal(roleReviewFor(stamp('testimonials', testimonialsSection()).node), null);
});

/* ==========================================================================
 * 7. The founding rule still holds
 * ======================================================================== */

test('a button inside a card the editor could not read still fails the blueprint', () => {
  // Perfectly readable cards, and then a second button off to the side that
  // no role names. A button whose words and destination nobody can change is a
  // reason to open WordPress, which is the hatch this feature exists to close.
  const node = pricingSection();
  node.elements.push(button('Talk to sales', 'https://example.invalid/sales'));
  const res = stamp('pricing', node);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unmapped_control');
});

test('a layout with no list in it is refused, and the refusal says why', () => {
  const node = box([heading('One plan', 'h2'), heading('$199', 'h1'), editor('<p>a month</p>')]);
  const res = stamp('pricing', node);
  assert.equal(res.ok, false);
  assert.match(res.detail, /no list in it/i);
});

test('a layout whose every heading is inside a card is refused, and says why', () => {
  const node = box([box(Array.from({ length: 3 }, () => box([heading('15+', 'h1'), editor('<p>years</p>')])))]);
  const res = stamp('stats', node);
  assert.equal(res.ok, false);
  assert.match(res.detail, /nowhere to put the section/i);
});

test('a role whose markup we would rewrite is left unclaimed rather than stamped', () => {
  // A period drawn with a link inside it. Our encoder writes plain `<p>` back,
  // so stamping it would delete the client's link on their first save.
  const node = box([
    heading('Prices', 'h2'),
    box([1, 2].map(() => box([
      heading('Starter', 'h4'),
      heading('$49', 'h2'),
      editor('<p>per <a href="/terms">month</a></p>'),
      editor('<p>✓ One<br>✓ Two</p>'),
      button('Go'),
    ]))),
  ]);
  const res = stamp('pricing', node);
  assert.equal(res.ok, true, res.detail);
  const fields = itemFieldsFor(res.node, 'pricing');
  assert.equal(fields.plans.includes('period'), false, 'the linked line is not offered as a box');
  assert.equal(fields.plans.includes('features'), true);
  // and the widget really is untouched
  const cards = res.node.elements[1].elements;
  const roles = [...collectRoles(cards[0]).keys()].sort();
  assert.deepEqual(roles, ['cta', 'features', 'name', 'price']);
});

test('a layout offered in the picker is a layout that can be SAVED', () => {
  // A picture with no description is refused on save ("Describe the
  // photograph"), and that refusal does not say "cannot be empty" — which is
  // the only thing the pickability gate used to look for. So a layout like
  // this reached the picker, the client added it, and Save would not go
  // through. It is refused up front now, with the reason it will be refused.
  const node = box([
    heading('Meet the team', 'h2'),
    box([1, 2].map(() => box([
      image('https://a-real-photo.example.invalid/brandon.jpg'),
      heading('Brandon', 'h5'),
      editor('<p>Founder</p>'),
    ]))),
  ]);
  const res = stamp('team', node);
  assert.equal(res.ok, false);
  assert.match(res.detail, /Describe the photograph/);
});

test('a list is never bound twice, so what the client edits is never a coin toss', () => {
  // The old one-widget-per-item step is still in the plan for layouts drawn
  // our way. Left ungated it would ALSO claim spare text-editors on a layout
  // whose cards were already claimed, and then two bindings would both fill
  // `plans` — the last one read wins, which is not an answer.
  // A team layout drawn as cards, with a spare `image-box` beside them — the
  // widget the OLD team binding claims one-per-person. Nothing else stops it:
  // unlike the composed card bindings there is no markup round trip to fail.
  const node = teamSection();
  node.elements.push(w('image-box', { title_text: 'Awarded 2025', description_text: 'Best local firm' }));
  const res = stamp('team', node);
  assert.equal(res.ok, true, res.detail);
  assert.equal(res.stamped.filter((b) => b.startsWith('team.member')).length, 1,
    `one binding fills the list, got ${JSON.stringify(res.stamped)}`);
  const members = extractFields(res.node, 'team').members;
  assert.equal(members.length, 3);
  assert.equal(members[0].name, 'Brandon');
});

test('a claimed card is still a section every required field can be filled on', () => {
  for (const [kind, make] of [['pricing', pricingSection], ['team', teamSection], ['stats', statsSection], ['testimonials', testimonialsSection]]) {
    const res = stamp(kind, make());
    const check = validateFields(kind, extractFields(res.node, kind));
    assert.equal(check.ok, true, `${kind}: ${JSON.stringify(check.errors)}`);
  }
});

/* ==========================================================================
 * 8. The one price source
 * ======================================================================== */

const PRICED_BRAND = {
  ...BRAND,
  booking_href: 'https://book.example.invalid/summit',
  service_prices: [
    { offering_id: 'off-1', name: 'Weekly mow', price: '$45', period: 'per week', description: 'Cut, edge and blow.', features: ['Cut', 'Edge'] },
    { offering_id: 'off-2', name: 'Spring clean-up', price: '$220', period: '', description: 'One visit.', features: [] },
  ],
};

test('a curated price layout arrives with the business’s own prices, not the library’s', () => {
  const res = stamp('pricing', pricingSection({ cards: 3 }));
  const before = extractFields(res.node, 'pricing');
  assert.equal(before.plans[0].price, '$0', 'the blueprint really does carry a sample price');

  const filled = fillPricingFromCatalogue(res.node, PRICED_BRAND);
  const after = extractFields(filled, 'pricing');
  assert.equal(after.plans.length, 2, 'only the services that exist');
  assert.equal(after.plans[0].name, 'Weekly mow');
  assert.equal(after.plans[0].price, '$45');
  assert.equal(after.plans[0].period, 'per week');
  assert.equal(after.plans[0].offering_id, 'off-1');
  assert.equal(after.plans[0].cta_href, 'https://book.example.invalid/summit');
  // No sample price survives anywhere on the section.
  assert.equal(/\$149|\$49\b/.test(JSON.stringify(filled)), false);
});

test('a business with no price list gets prompts, never an invented number', () => {
  const filled = fillPricingFromCatalogue(stamp('pricing', pricingSection()).node, BRAND);
  const after = extractFields(filled, 'pricing');
  assert.equal(after.plans.length, 1);
  assert.equal(after.plans[0].price, '');
  assert.equal(/\$\d/.test(JSON.stringify(after.plans)), false);
});

test('the layout decides how many cards there are — we never grow it', () => {
  const many = {
    ...BRAND,
    service_prices: Array.from({ length: 6 }, (_, i) => ({ offering_id: `o${i}`, name: `S${i}`, price: `$${i + 1}`, period: '', features: [] })),
  };
  const filled = fillPricingFromCatalogue(stamp('pricing', pricingSection({ cards: 2 })).node, many);
  assert.equal(extractFields(filled, 'pricing').plans.length, 2);
});

/* ==========================================================================
 * 9. The vocabulary is data, and the plugin mirrors it
 * ======================================================================== */

test('every role names a widget type the schema can actually write to', () => {
  for (const [bindingId, binding] of Object.entries(BINDINGS)) {
    if (binding.repeat !== 'container') continue;
    assert.ok(binding.list, `${bindingId} names the list it fills`);
    for (const [roleKey, role] of Object.entries(binding.roles || {})) {
      const where = `${bindingId}.${roleKey}`;
      assert.ok(role.widget || role.on === 'container', `${where} says where it lives`);
      assert.ok(role.fields || role.part, `${where} says what it holds`);
      if (role.part) assert.ok(COMPOSED_PARTS[role.part.codec], `${where} names a real part codec`);
      for (const spec of Object.values(role.fields || {})) {
        assert.ok(spec.setting, `${where} names a setting`);
        if (spec.codec) assert.ok(CODECS[spec.codec], `${where} names a real codec`);
      }
    }
  }
});

test('the four list kinds all have a card binding and it is the one the plan uses', () => {
  for (const kind of ['pricing', 'team', 'stats', 'testimonials']) {
    const found = Object.entries(BINDINGS).filter(([bid, b]) => b.repeat === 'container' && bid.startsWith(`${kind}.`));
    assert.equal(found.length, 1, `${kind} has exactly one card binding`);
  }
});

test('the thing that builds a section for the client is the thing that fills the prices', () => {
  // `fillPricingFromCatalogue` tested on its own proves the fill; this proves
  // it is WIRED, which is the half that actually reaches a client's page.
  const src = catalogSource();
  const body = src.slice(src.indexOf('export async function buildLibrarySection'));
  assert.match(body, /const node = neverInventValues\(mapped\.node, mapped\.kind, brand\);/);
  assert.match(body, /return \{ ok: true, node, kind: mapped\.kind \}/,
    'and the filled node is the one handed back, not the unfilled one');
  // ...and the never-invent step is where pricing is decided, still.
  assert.match(src, /if \(kind === 'pricing'\) return fillPricingFromCatalogue\(node, brand\);/);
});

test('mapLibrarySection carries the kind and the review through to the caller', () => {
  const res = mapLibrarySection({
    archetype: 'pricing', blueprintId: 'pricing.fixture.v1',
    sectionJson: ambiguousPricing(), brand: BRAND,
  });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'pricing');
  assert.ok(roleReviewFor(res.node));
});

/* ==========================================================================
 * 10. D-93 — a name, a quote and a number are not sample copy either
 *
 * The library's own words for these three archetypes are claims about a
 * PERSON, a CUSTOMER or a NUMBER: "Sarah K., Operations Lead" said something
 * glowing, "Brandon" is the Founder, the business has "15+ years building".
 * They come out and prompts go in, through the same never-invent step the
 * prices go through. The other five archetypes keep their sample copy, which
 * is the business's own words to edit and has been walked that way since June.
 * ======================================================================== */

/** Read a source file the way this repo is checked out — CRLF, normalised. */
function readSource(rel) {
  return fs.readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}
function catalogSource() {
  return readSource('../lib/websiteBuilder/libraryCatalog.js');
}

/**
 * Every sample word the curated library actually ships for these three, read
 * off the library export and pinned into the fixtures above. If one of these
 * is on an adopted section, a client is looking at somebody else's claim.
 */
const LIBRARY_SAMPLE_WORDS = [
  'Sarah', 'Mike', 'Dana', 'Tom', 'Operations Lead', 'RetailCo',
  'Brandon', 'Alex', 'Sam', 'Founder', 'Software Engineer', 'Data Analyst',
  '15', '200', '98', '40', 'years building', 'clients served', 'client retention',
];

function heroSection() {
  return box([
    heading('Build something people remember', 'h1'),
    editor('<p>One line that says what you do and who for.</p>'),
    button('Get started', '#contact'),
  ]);
}

function aboutSection() {
  return box([
    heading('About the business', 'h2'),
    editor('<p>A supporting line.</p>'),
    editor('<p>How it started.</p><p>What we do today.</p>'),
    w('icon-box', { title_text: 'We turn up', description_text: 'Every time, on the day we said.' }),
  ]);
}

/** Two text blocks, neither of them quoted — so the roles are a guess. */
function ambiguousTestimonials() {
  return box([
    heading('In their words', 'h2'),
    box([1, 2].map(() => box([
      editor('<p>They turned our reporting around in a fortnight and it has stayed that way.</p>'),
      heading('Sarah K.', 'h5'),
      editor('<p>Operations Lead</p>'),
    ]))),
  ]);
}

test('a curated quote layout arrives asking who said it, not quoting somebody else’s customer', () => {
  const res = stamp('testimonials', testimonialsSection());
  const before = extractFields(res.node, 'testimonials');
  assert.match(before.testimonials[0].role, /Operations Lead/, 'the blueprint really does carry a sample job title');

  const node = neutraliseSampleWords(res.node, 'testimonials');
  const after = extractFields(node, 'testimonials');
  assert.equal(after.testimonials.length, before.testimonials.length,
    'the layout still has the cards its author drew');
  for (const item of after.testimonials) {
    assert.equal(item.quote, 'What they said');
    assert.equal(item.attribution, 'Who said it');
    assert.equal(item.role, 'Their job or company');
  }
  // The section's OWN heading is copy about the business, and it stays.
  assert.equal(after.headline, 'What clients say');
});

test('a curated team layout arrives asking for a name, not naming one of ours', () => {
  const res = stamp('team', teamSection());
  const before = extractFields(res.node, 'team');
  assert.equal(before.members[0].name, 'Brandon', 'the blueprint really does carry a sample name');

  const node = neutraliseSampleWords(res.node, 'team');
  const after = extractFields(node, 'team');
  assert.equal(after.members.length, 3);
  for (const item of after.members) {
    assert.equal(item.name, 'Name');
    assert.equal(item.role, 'Role');
    assert.equal(item.photo_url, '', 'and the photograph is still empty, as pack 2b left it');
  }
  assert.equal(after.headline, 'Meet the team');
});

test('a curated numbers band arrives EMPTY, because a number is a claim and a nought is one too', () => {
  const res = stamp('stats', statsSection());
  const before = extractFields(res.node, 'stats');
  assert.equal(before.stats[0].value, '15', 'the blueprint really does carry a sample number');
  assert.equal(before.stats[0].suffix, '+');

  const node = neutraliseSampleWords(res.node, 'stats');
  const after = extractFields(node, 'stats');
  assert.equal(after.stats.length, 4);
  for (const item of after.stats) {
    assert.equal(item.value, '', 'the number itself');
    assert.equal(item.prefix, '', 'and whatever was in front of it');
    assert.equal(item.suffix, '', 'and whatever was after it');
    assert.equal(item.label, 'What this counts');
  }
  assert.equal(after.headline, 'By the numbers');
});

test('an empty number is written out as NOTHING — not a nought, not NaN, not undefined', () => {
  // The serialised section is what reaches the website, so that is what is
  // asserted on: the heading the number lived in is empty, and no arithmetic
  // leaked into it on the way (memory: feedback_assert_presence_not_just_absence).
  const node = neutraliseSampleWords(stamp('stats', statsSection()).node, 'stats');
  const numbers = [];
  const walk = (n) => {
    if (n?.settings?.[ROLE_MARKER] === 'number') numbers.push(n.settings.title);
    (n?.elements || []).forEach(walk);
  };
  walk(node);
  assert.equal(numbers.length, 4, 'every card still has its number widget');
  for (const title of numbers) assert.equal(title, '', JSON.stringify(title));
  assert.equal(/NaN|undefined|"0"/.test(JSON.stringify(node)), false, JSON.stringify(node).slice(0, 300));
});

test('and the website is never handed a numbers band with nothing in it', () => {
  // The other half of the same promise. An empty number cannot publish: the
  // save refuses it in the client's own words until they type their own.
  const node = neutraliseSampleWords(stamp('stats', statsSection()).node, 'stats');
  const check = validateFields('stats', extractFields(node, 'stats'));
  assert.equal(check.ok, false);
  assert.ok(check.errors.every((e) => /The number cannot be empty\./.test(e.message)),
    JSON.stringify(check.errors));
  assert.equal(/elementor|wordpress|widget|theme|plugin/i.test(JSON.stringify(check.errors)), false,
    'and it says so without naming anybody’s software');
});

test('not one of the library’s own sample words survives, and the prompts are all there', () => {
  const cases = [
    ['testimonials', testimonialsSection(), ['What they said', 'Who said it', 'Their job or company']],
    ['team', teamSection(), ['Name', 'Role']],
    ['stats', statsSection(), ['What this counts']],
  ];
  for (const [kind, fixture, wanted] of cases) {
    const node = neutraliseSampleWords(stamp(kind, fixture).node, kind);
    const listKey = sectionKindMeta(kind).fields.find((f) => f.type === 'list').key;
    const items = JSON.stringify(extractFields(node, kind)[listKey]);
    for (const needle of LIBRARY_SAMPLE_WORDS) {
      assert.equal(items.includes(needle), false, kind + ' still says "' + needle + '": ' + items);
    }
    for (const prompt of wanted) {
      assert.ok(items.includes(prompt), kind + ' does not offer the prompt "' + prompt + '": ' + items);
    }
  }
});

test('hero and about keep every word the library wrote, byte for byte', () => {
  for (const [kind, fixture] of [['hero', heroSection()], ['about', aboutSection()]]) {
    const res = stamp(kind, fixture);
    assert.equal(res.ok, true, kind + ': ' + res.detail);
    const out = neverInventValues(res.node, kind, PRICED_BRAND);
    assert.equal(out, res.node, kind + ' came back as a different object');
    assert.equal(JSON.stringify(out), JSON.stringify(res.node), kind + ' changed');
    assert.equal(extractFields(out, kind).headline, extractFields(res.node, kind).headline);
  }
});

test('the table names the three archetypes it is for, and no others', () => {
  assert.deepEqual(Object.keys(SAMPLE_WORD_PROMPTS).sort(), ['stats', 'team', 'testimonials']);
  for (const kind of ['hero', 'about', 'faq', 'contact', 'cta', 'services', 'gallery', 'pricing']) {
    assert.equal(SAMPLE_WORD_PROMPTS[kind], undefined, kind + ' keeps its own sample copy');
  }
});

test('every prompt names a box the edit sheet actually has', () => {
  for (const [kind, prompts] of Object.entries(SAMPLE_WORD_PROMPTS)) {
    const lists = sectionKindMeta(kind).fields.filter((f) => f.type === 'list');
    assert.equal(lists.length, 1, kind + ' keeps its items in exactly one list');
    const keys = lists[0].item.map((s) => s.key);
    for (const field of Object.keys(prompts)) {
      assert.ok(keys.includes(field), kind + '.' + field + ' is not a field of ' + lists[0].key);
    }
  }
});

test('the one never-invent step sends a price layout to the price list and the rest to the prompts', () => {
  const priced = neverInventValues(stamp('pricing', pricingSection()).node, 'pricing', PRICED_BRAND);
  assert.equal(extractFields(priced, 'pricing').plans[0].price, '$45');
  const quotes = neverInventValues(stamp('testimonials', testimonialsSection()).node, 'testimonials', PRICED_BRAND);
  assert.equal(extractFields(quotes, 'testimonials').testimonials[0].quote, 'What they said');
});

/* --- the "check this" swap still puts the right prompt in the right box --- */

test('a swapped role takes its prompt with it', () => {
  const res = stamp('testimonials', ambiguousTestimonials());
  assert.equal(res.ok, true, res.detail);
  assert.ok(roleReviewFor(res.node)?.some((r) => r.roles.includes('quote')), 'the guess was written down');

  const adopted = neutraliseSampleWords(res.node, 'testimonials');
  assert.equal(extractFields(adopted, 'testimonials').testimonials[0].quote, 'What they said');

  const swapped = swapItemRoles(adopted, 'testimonials', 'testimonials', 'quote', 'role');
  assert.equal(swapped.ok, true, swapped.reason);
  assert.equal(swapped.swapped, 2, 'on every card');
  // Without the refresh the two prompts are now in each other's boxes.
  assert.equal(extractFields(swapped.node, 'testimonials').testimonials[0].quote, 'Their job or company');

  const settled = neutraliseSampleWords(swapped.node, 'testimonials', { onlyPrompts: true });
  for (const item of extractFields(settled, 'testimonials').testimonials) {
    assert.equal(item.quote, 'What they said');
    assert.equal(item.role, 'Their job or company');
  }
  assert.equal(roleReviewFor(settled), null, 'and the question is not asked twice');
});

test('a swap never overwrites a word the client typed', () => {
  const adopted = neutraliseSampleWords(stamp('testimonials', ambiguousTestimonials()).node, 'testimonials');
  const typed = applyFields(adopted, 'testimonials', {
    testimonials: extractFields(adopted, 'testimonials').testimonials.map(() => ({
      quote: 'They cleared the whole estate in a morning.', role: 'Owner, Summit Lawn',
    })),
  });
  const swapped = swapItemRoles(typed, 'testimonials', 'testimonials', 'quote', 'role');
  assert.equal(swapped.ok, true);
  const settled = neutraliseSampleWords(swapped.node, 'testimonials', { onlyPrompts: true });
  const item = extractFields(settled, 'testimonials').testimonials[0];
  assert.equal(item.quote, 'Owner, Summit Lawn', 'the swap moved their words, as it always has');
  assert.equal(item.role, 'They cleared the whole estate in a morning.');
});

test('the one tap behind "check this" is wired to the prompt refresh', () => {
  const routes = readSource('../routes/arion/pages.js');
  const body = routes.slice(routes.indexOf("router.post('/sections/roles/swap'"));
  assert.match(body, /neutraliseSampleWords\(swapped\.node, kind, \{ onlyPrompts: true \}\)/);
  assert.match(body, /reduceToSectionList\(\[settled\]\)/,
    'and the refreshed section is the one handed back, not the raw swap');
});
