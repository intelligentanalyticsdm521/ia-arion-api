/**
 * Adoption — Phase 3, decision W-5.
 *
 * "Best effort, previewed, opt-in, never silently rewritten." Every assertion
 * below exists to hold one clause of that sentence:
 *
 *   best effort   — the mapper is table-driven over fixture trees that look
 *                   like the ones on the five real sites, and each one names
 *                   the archetype it must land on and the fields it must find.
 *   previewed     — the preview builds a section and renders it, and does not
 *                   touch the tree it was given. Mutation-tested.
 *   opt-in        — a section below the confidence floor, or carrying anything
 *                   the editor cannot re-emit, is NOT offered.
 *   never rewritten silently — the original bytes survive a round trip through
 *                   the adoption record byte for byte.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyseSection, analysePage, buildAdoptedSection, sectionFingerprint,
  applyFixes, previewTools, widgetLabel, carriesContent, readCensus,
  ADOPT_MIN_CONFIDENCE, ADOPT_UNDO_DAYS, ADOPTED_BLUEPRINT,
  __test__ as adoptInternals,
} from '../lib/websiteBuilder/adoption.js';
import { reduceToSectionList, extractFields, validateFields } from '../lib/websiteBuilder/sectionSchema.js';
import { renderAdoptionPreviewHtml } from '../lib/websiteBuilder/sectionPreview.js';
import { blockToElementorSection } from '../lib/websiteBuilder/elementorAdapter.js';
import { __test__ as storeInternals, AdoptionTooBigError } from '../lib/websiteBuilder/adoptionStore.js';
import { __test__ as routeInternals } from '../routes/arion/pages.js';

const { readSectionIndex, publicAdoption } = routeInternals;

const BRAND = Object.freeze({
  business_name: 'Fernbrook Garden Rooms',
  email: 'hello@fernbrook.invalid',
  primary_color: '#1A3A4A',
  services: [],
});

/* ── fixture builders ──────────────────────────────────────────────────── */

let seq = 0;
const nid = () => `fx${(seq += 1).toString(36)}`;
const w = (widgetType, settings) => ({ id: nid(), elType: 'widget', widgetType, settings });
const col = (elements, size = 100) => ({ id: nid(), elType: 'column', settings: { _column_size: size }, elements });
const box = (elements) => ({ id: nid(), elType: 'container', settings: {}, elements });
const sec = (children, settings = {}) => ({ id: nid(), elType: 'section', settings, elements: children, isInner: false });

/** A hero: one big headline over a background picture, one button. */
const HERO = () => sec([col([
  w('heading', { title: 'Garden rooms built to last', header_size: 'h1', align: 'center' }),
  w('text-editor', { editor: '<p>Hand-made in Shropshire, delivered across the Midlands.</p>' }),
  w('button', { text: 'Get a quote', link: { url: 'https://fernbrook.invalid/contact' } }),
])], { background_image: { url: 'https://fernbrook.invalid/hero.jpg', id: 44 }, background_background: 'classic' });

/** Services as Elementor icon-boxes — the commonest shape on a real site. */
const SERVICES_BOXES = () => sec([
  col([w('heading', { title: 'What we build', header_size: 'h2' })]),
  col([w('icon-box', { title_text: 'Garden offices', description_text: 'Insulated, wired, ready to work in.', selected_icon: { value: 'fas fa-briefcase' } })], 33),
  col([w('icon-box', { title_text: 'Garden gyms', description_text: 'Rubber floors and mirrors.', selected_icon: { value: 'fas fa-dumbbell' } })], 33),
  col([w('icon-box', { title_text: 'Studios', description_text: 'Soundproofed to order.', selected_icon: { value: 'fas fa-music' } })], 33),
]);

/** Services as matching columns of heading + paragraph — the Astra shape. */
const SERVICES_COLUMNS = () => sec([
  col([w('heading', { title: 'What we build', header_size: 'h2' })]),
  ...[['Offices', 'Insulated.'], ['Gyms', 'Floored.'], ['Studios', 'Quiet.']]
    .map(([t, d]) => col([w('heading', { title: t, header_size: 'h3' }), w('text-editor', { editor: `<p>${d}</p>` })], 33)),
]);

/** The same, in flexbox containers rather than columns. */
const SERVICES_CONTAINERS = () => sec([box([
  box([w('icon-box', { title_text: 'Offices', description_text: 'Insulated.' })]),
  box([w('icon-box', { title_text: 'Gyms', description_text: 'Floored.' })]),
])]);

const TESTIMONIALS = () => sec([col([
  w('heading', { title: 'What our customers say', header_size: 'h2' }),
  w('text-editor', { editor: '<blockquote><p>Best money we ever spent.</p></blockquote><cite>Ann Patel</cite>' }),
  w('text-editor', { editor: '<blockquote><p>Up in three days.</p></blockquote><cite>Rob Dean</cite>' }),
])]);

const FAQ = () => sec([col([
  w('heading', { title: 'Questions we get asked', header_size: 'h2' }),
  w('accordion', { tabs: [
    { tab_title: 'How long does it take?', tab_content: '<p>About three weeks.</p>' },
    { tab_title: 'Do I need planning permission?', tab_content: '<p>Usually not.</p>' },
  ] }),
])]);

const CONTACT = () => sec([col([
  w('heading', { title: 'Get in touch', header_size: 'h2' }),
  w('icon-list', { icon_list: [
    { text: 'Phone: 01952 000000', selected_icon: { value: 'fas fa-phone' }, link: { url: 'tel:01952000000' } },
  ] }),
  w('form', {
    form_name: 'Quote', form_css_class: 'ia-quote', email_to: 'leads@fernbrook.invalid',
    button_text: 'Send it', form_fields: [{ field_label: 'Name' }, { field_label: 'Email' }, { field_label: 'Message' }],
  }),
])]);

const ABOUT = () => sec([
  col([w('image', { image: { url: 'https://fernbrook.invalid/shop.jpg', id: 12, alt: 'The workshop' } })], 50),
  col([
    w('heading', { title: 'About Fernbrook', header_size: 'h2' }),
    w('text-editor', { editor: '<p>We started in 2009.</p><p>Today we build forty a year.</p>' }),
  ], 50),
]);

/** The same About, with no description on its picture. */
const ABOUT_NO_ALT = () => sec([
  col([w('image', { image: { url: 'https://fernbrook.invalid/shop.jpg', id: 12, alt: '' } })], 50),
  col([
    w('heading', { title: 'About Fernbrook', header_size: 'h2' }),
    w('text-editor', { editor: '<p>We started in 2009.</p><p>Today we build forty a year.</p>' }),
  ], 50),
]);

const GALLERY = () => sec([col([
  w('heading', { title: 'Our work', header_size: 'h2' }),
  w('image-gallery', {
    gallery: [{ url: 'https://fernbrook.invalid/1.jpg', id: 1 }, { url: 'https://fernbrook.invalid/2.jpg', id: 2 }],
    ia_gallery_meta: [{ alt: 'A finished office' }, { alt: 'A garden gym' }],
  }),
])]);

const CTA = () => sec([col([
  w('heading', { title: 'Ready to start?', header_size: 'h2' }),
  w('button', { text: 'Book a survey', link: { url: '/book' } }),
  w('button', { text: 'Call us', link: { url: 'tel:01952000000' } }),
])]);

/** The dev fixture's own hand-built strip: a heading in one column, a line in another. */
const AWARDS = () => sec([
  col([w('heading', { title: 'County Build Awards 2025', header_size: 'h3', align: 'center' })], 50),
  col([w('text-editor', { editor: '<p>Highly commended, small workshop of the year.</p>' })], 50),
], { _title: 'Awards strip (built in Elementor)', structure: '20' });

/** A call to action with a video in it — content the editor has no field for. */
const CTA_WITH_VIDEO = () => sec([col([
  w('heading', { title: 'See one being built', header_size: 'h2' }),
  w('video', { youtube_url: 'https://youtu.be/abc123' }),
  w('button', { text: 'Watch', link: { url: '#' } }),
])]);

/** A hero with a plain divider — nothing a visitor reads, so no blocker. */
const HERO_WITH_DIVIDER = () => sec([col([
  w('heading', { title: 'Garden rooms built to last', header_size: 'h1' }),
  w('divider', { style: 'solid' }),
  w('button', { text: 'Get a quote', link: { url: '/contact' } }),
])]);

/** The same, but the divider has words drawn through it — those ARE content. */
const HERO_WITH_TEXT_DIVIDER = () => sec([col([
  w('heading', { title: 'Garden rooms built to last', header_size: 'h1' }),
  w('divider', { style: 'solid', look: 'line_text', text: 'Est. 2009' }),
  w('button', { text: 'Get a quote', link: { url: '/contact' } }),
])]);

/**
 * Two matching columns and NO heading of its own.
 *
 * This is the fixture the confidence floor is measured against: it matches the
 * services signature weakly (0.64), both cards map cleanly so nothing is left
 * over to refuse it on, and the missing headline drags it under the line. Any
 * looser and a client's two-column band becomes a services row on a guess.
 */
const WEAK_TWO_COLUMN = () => sec([
  col([w('heading', { title: 'Fast', header_size: 'h4' }), w('text-editor', { editor: '<p>Three weeks.</p>' })], 50),
  col([w('heading', { title: 'Local', header_size: 'h4' }), w('text-editor', { editor: '<p>Shropshire.</p>' })], 50),
]);

/* ==========================================================================
 * 1. The mapper, table-driven
 * ======================================================================== */

const TABLE = [
  {
    name: 'a hero — one big headline, a line of support, a button, a background picture',
    make: HERO,
    kind: 'hero',
    adoptable: true,
    fields: {
      headline: 'Garden rooms built to last',
      subheadline: 'Hand-made in Shropshire, delivered across the Midlands.',
      cta_text: 'Get a quote',
      cta_href: 'https://fernbrook.invalid/contact',
      image_url: 'https://fernbrook.invalid/hero.jpg',
      image_id: 44,
    },
  },
  {
    name: 'services as icon-boxes',
    make: SERVICES_BOXES,
    kind: 'services',
    adoptable: true,
    check(a) {
      assert.equal(a.fields.headline, 'What we build');
      assert.deepEqual(a.fields.services.map((s) => s.title), ['Garden offices', 'Garden gyms', 'Studios']);
      assert.equal(a.fields.services[0].icon_name, 'briefcase');
    },
  },
  {
    name: 'services as matching columns of heading and paragraph',
    make: SERVICES_COLUMNS,
    kind: 'services',
    adoptable: true,
    check(a) {
      // The SECTION heading is the headline and the CARD headings are the
      // cards. Getting this the wrong way round reported every card as
      // content we could not carry — the first real bug this file caught.
      assert.equal(a.fields.headline, 'What we build');
      assert.deepEqual(a.fields.services.map((s) => s.title), ['Offices', 'Gyms', 'Studios']);
      assert.deepEqual(a.fields.services.map((s) => s.description), ['Insulated.', 'Floored.', 'Quiet.']);
      assert.deepEqual(a.unmapped, []);
    },
  },
  {
    name: 'services built out of flexbox containers, not columns',
    make: SERVICES_CONTAINERS,
    kind: 'services',
    adoptable: true,
    check(a) {
      assert.deepEqual(a.fields.services.map((s) => s.title), ['Offices', 'Gyms']);
      // No heading anywhere on the section, so one has to be typed before it
      // can be published — and the preview says so rather than inventing one.
      assert.ok(a.needsInput.some((n) => n.field === 'headline'));
    },
  },
  {
    name: 'testimonials written as blockquotes',
    make: TESTIMONIALS,
    kind: 'testimonials',
    adoptable: true,
    check(a) {
      assert.equal(a.fields.headline, 'What our customers say');
      assert.equal(a.fields.testimonials.length, 2);
      assert.equal(a.fields.testimonials[0].quote, 'Best money we ever spent.');
      assert.equal(a.fields.testimonials[0].attribution, 'Ann Patel');
    },
  },
  {
    name: 'an FAQ accordion',
    make: FAQ,
    kind: 'faq',
    adoptable: true,
    check(a) {
      assert.equal(a.fields.headline, 'Questions we get asked');
      assert.deepEqual(a.fields.faqs.map((f) => f.question),
        ['How long does it take?', 'Do I need planning permission?']);
      assert.equal(a.fields.faqs[0].answer, 'About three weeks.');
    },
  },
  {
    name: 'a contact section with an Elementor Pro form',
    make: CONTACT,
    kind: 'contact',
    adoptable: true,
    check(a) {
      // The routing wires come across EXACTLY as they are. A form that was
      // typed "quote" must not silently become a "lead" because we rebuilt
      // the section around it (SCOPE §2.5).
      assert.equal(a.fields.form_purpose, 'quote');
      assert.equal(a.fields.email_to, 'leads@fernbrook.invalid');
      assert.deepEqual(a.fields.form_fields, ['Name', 'Email', 'Message']);
      assert.equal(a.fields.contact_methods[0].kind, 'phone');
      assert.equal(a.fields.contact_methods[0].value, '01952 000000');
    },
  },
  {
    name: 'an about section — a picture beside the story',
    make: ABOUT,
    kind: 'about',
    adoptable: true,
    check(a) {
      assert.equal(a.fields.image_url, 'https://fernbrook.invalid/shop.jpg');
      assert.equal(a.fields.image_id, 12);
      assert.equal(a.fields.image_alt, 'The workshop');
      assert.deepEqual(a.fields.story_paragraphs, ['We started in 2009.', 'Today we build forty a year.']);
    },
  },
  {
    name: 'a picture gallery',
    make: GALLERY,
    kind: 'gallery',
    adoptable: true,
    check(a) {
      assert.equal(a.fields.images.length, 2);
      assert.equal(a.fields.images[0].id, 1);
      assert.equal(a.fields.images[1].alt, 'A garden gym');
    },
  },
  {
    name: 'a call to action with two buttons',
    make: CTA,
    kind: 'cta',
    adoptable: true,
    check(a) {
      assert.equal(a.fields.primary_cta_text, 'Book a survey');
      assert.equal(a.fields.secondary_cta_text, 'Call us');
    },
  },
  {
    name: 'a hand-built awards strip we cannot identify',
    make: AWARDS,
    kind: null,
    adoptable: false,
    reason: 'no_match',
  },
  {
    name: 'a section with a video on it — content we cannot carry over',
    make: CTA_WITH_VIDEO,
    kind: 'cta',
    adoptable: false,
    reason: 'would_lose_content',
    check(a) {
      const v = a.unmapped.find((u) => u.widgetType === 'video');
      assert.ok(v, 'the video is named');
      assert.equal(v.carriesContent, true);
      assert.equal(v.label, 'a video');
    },
  },
  {
    name: 'a plain divider carries nothing, so it never blocks an adoption',
    make: HERO_WITH_DIVIDER,
    kind: 'hero',
    adoptable: true,
    check(a) {
      const d = a.unmapped.find((u) => u.widgetType === 'divider');
      assert.ok(d, 'the divider is still reported');
      assert.equal(d.carriesContent, false);
    },
  },
  {
    name: 'a divider with words drawn through it DOES block — those words would go',
    make: HERO_WITH_TEXT_DIVIDER,
    kind: 'hero',
    adoptable: false,
    reason: 'would_lose_content',
    check(a) {
      const d = a.unmapped.find((u) => u.widgetType === 'divider');
      assert.equal(d.carriesContent, true);
      assert.equal(d.preview, 'Est. 2009');
    },
  },
  {
    name: 'two matching columns with no heading of their own fall under the floor',
    make: WEAK_TWO_COLUMN,
    kind: 'services',
    adoptable: false,
    reason: 'low_confidence',
    check(a) {
      assert.deepEqual(a.unmapped, [], 'nothing is left over — it is the SCORE that refuses it');
      assert.ok(a.confidence > 0, 'and it is a real guess, not a blank');
      assert.ok(a.confidence < ADOPT_MIN_CONFIDENCE,
        `${a.confidence} must sit under the floor of ${ADOPT_MIN_CONFIDENCE}`);
    },
  },
];

for (const row of TABLE) {
  test(`mapper: ${row.name}`, () => {
    const a = analyseSection(row.make(), { allowPro: true });
    assert.equal(a.kind, row.kind, `expected kind ${row.kind}, got ${a.kind}`);
    assert.equal(a.adoptable, row.adoptable,
      `expected adoptable=${row.adoptable}, got ${a.adoptable} (${a.reason}, ${a.confidence})`);
    if (row.reason) assert.equal(a.reason, row.reason);
    if (row.adoptable) {
      assert.ok(a.confidence >= ADOPT_MIN_CONFIDENCE, `confidence ${a.confidence} below the floor`);
      assert.ok(a.reasonText === null);
    } else {
      assert.ok(typeof a.reasonText === 'string' && a.reasonText.length > 20,
        'a refusal always says why, in words a client can read');
    }
    if (row.fields) {
      for (const [k, v] of Object.entries(row.fields)) {
        assert.deepEqual(a.fields[k], v, `field ${k}`);
      }
    }
    if (row.check) row.check(a);
  });
}

/* ==========================================================================
 * 2. The confidence floor
 * ======================================================================== */

test('the floor is a real line: a bare heading is refused, a full hero clears', () => {
  const bare = sec([col([w('heading', { title: 'Hello', header_size: 'h4' })])]);
  const a = analyseSection(bare, { allowPro: true });
  assert.equal(a.adoptable, false);
  assert.ok(a.confidence < ADOPT_MIN_CONFIDENCE || a.kind === null);

  const full = analyseSection(HERO(), { allowPro: true });
  assert.ok(full.confidence >= 0.85, `a clean hero should be high confidence, got ${full.confidence}`);
  assert.equal(full.confidenceLabel, 'high');
});

test('the floor is what refuses a weak guess — nothing else is standing in the way', () => {
  // The one case that proves ADOPT_MIN_CONFIDENCE does any work: a section
  // that maps cleanly, leaves nothing over, needs no Elementor Pro, and is
  // still refused, purely on the score. Drop the floor and this becomes
  // adoptable — which is exactly what the mutation test checks.
  const a = analyseSection(WEAK_TWO_COLUMN(), { allowPro: true });
  assert.equal(a.reason, 'low_confidence');
  assert.equal(a.adoptable, false);
  assert.deepEqual(a.unmapped, []);
  assert.equal(a.confidenceLabel, 'low');
  assert.match(a.reasonText, /not confident enough/);
});

test('confidence is reported as a word as well as a number, and the word matches', () => {
  for (const make of [HERO, SERVICES_BOXES, FAQ, CONTACT, GALLERY]) {
    const a = analyseSection(make(), { allowPro: true });
    const expected = a.confidence >= 0.85 ? 'high' : a.confidence >= ADOPT_MIN_CONFIDENCE ? 'fair' : 'low';
    assert.equal(a.confidenceLabel, expected);
  }
});

test('a form section is not offered on a site with no Elementor Pro, and says why', () => {
  const a = analyseSection(CONTACT(), { allowPro: false });
  assert.equal(a.kind, 'contact');
  assert.equal(a.adoptable, false);
  assert.equal(a.reason, 'needs_pro');
  assert.match(a.reasonText, /Elementor Pro/);
});

test('every refusal reason has plain-word text, and none of them says "tenant"', () => {
  for (const [key, text] of Object.entries(adoptInternals.REASON_TEXT)) {
    assert.ok(text.length > 20, `${key} needs a real sentence`);
    assert.doesNotMatch(text, /tenant/i, `${key} must not say "tenant" (feedback_no_tenant_in_ui)`);
    assert.doesNotMatch(text, /elementor_data|widget|_ia_field|archetype/i,
      `${key} must not use our vocabulary at the client`);
  }
});

/* ==========================================================================
 * 3. Analysis never touches the tree
 * ======================================================================== */

test('analysing a section does not modify it — not one byte', () => {
  for (const make of [HERO, SERVICES_COLUMNS, CONTACT, ABOUT, GALLERY, CTA_WITH_VIDEO, AWARDS]) {
    const node = make();
    const before = JSON.stringify(node);
    const a = analyseSection(node, { allowPro: true });
    if (a.adoptable) buildAdoptedSection({ analysis: a, brand: BRAND, blockId: 'x' });
    assert.equal(JSON.stringify(node), before, 'the original tree changed during analysis');
  }
});

test('a whole-page review counts what can be offered and what cannot', () => {
  const built = blockToElementorSection({
    kind: 'hero',
    block: { headline: 'Ours', subheadline: 'x', cta_text: 'Go', cta_href: '#', background_style: 'solid' },
    brand: BRAND, seedId: 'p', blockId: 'b',
  });
  const list = reduceToSectionList([built, HERO(), AWARDS(), CTA_WITH_VIDEO()]);
  const view = analysePage(list, { allowPro: true });

  assert.equal(view.rows.length, 4);
  assert.equal(view.rows[0].already, true, 'a section we already own is not up for adoption');
  assert.equal(view.rows[0].adoptable, false);
  assert.equal(view.customCount, 3);
  assert.equal(view.adoptableCount, 1, 'only the hero can be offered');
  assert.equal(view.rows[1].adoptable, true);
  assert.equal(view.rows[2].reason, 'no_match');
  assert.equal(view.rows[3].reason, 'would_lose_content');
  assert.equal(view.rows[3].unmappedCount, 1);
});

/* ==========================================================================
 * 4. What comes out the other side
 * ======================================================================== */

test('an adopted section is one the ordinary read can edit — every kind', () => {
  for (const make of [HERO, SERVICES_BOXES, SERVICES_COLUMNS, TESTIMONIALS, FAQ, CONTACT, ABOUT, GALLERY, CTA]) {
    const a = analyseSection(make(), { allowPro: true });
    assert.ok(a.adoptable, `${a.kind} should be adoptable`);
    const fixes = { headline: a.fields.headline || 'A heading' };
    const built = buildAdoptedSection({ analysis: a, brand: BRAND, blockId: 'blk1', fixes });
    assert.ok(built.ok, built.ok ? '' : built.message);

    const [entry] = reduceToSectionList([built.node]);
    assert.equal(entry.editable, true, `${a.kind} came back read-only`);
    assert.equal(entry.kind, a.kind);
    assert.equal(entry.blueprintId, ADOPTED_BLUEPRINT,
      'the handle says it was adopted, so the Portal can label the row');
    assert.equal(built.handle, `ia:${a.kind}:${ADOPTED_BLUEPRINT}:blk1`);
    assert.deepEqual(built.dropped, [], `${a.kind} lost a field on the way through`);
  }
});

test('the words and the pictures survive the rebuild', () => {
  const a = analyseSection(HERO(), { allowPro: true });
  const built = buildAdoptedSection({ analysis: a, brand: BRAND, blockId: 'b' });
  const after = extractFields(built.node, 'hero');
  assert.equal(after.headline, 'Garden rooms built to last');
  assert.equal(after.subheadline, 'Hand-made in Shropshire, delivered across the Midlands.');
  assert.equal(after.cta_text, 'Get a quote');
  assert.equal(after.cta_href, 'https://fernbrook.invalid/contact');
  assert.equal(after.image_url, 'https://fernbrook.invalid/hero.jpg');
  // The attachment id is what makes Elementor emit srcset. Losing it on the
  // way through adoption would be the v1.6.0 defect all over again.
  assert.equal(after.image_id, 44);
});

test('a form keeps its purpose, its recipient and its fields through adoption', () => {
  const a = analyseSection(CONTACT(), { allowPro: true });
  const built = buildAdoptedSection({ analysis: a, brand: BRAND, blockId: 'b' });
  const after = extractFields(built.node, 'contact');
  assert.equal(after.form_purpose, 'quote', 'a quote form must not become a lead form');
  assert.equal(after.email_to, 'leads@fernbrook.invalid', 'the enquiries keep going where they went');
  assert.deepEqual(after.form_fields, ['Name', 'Email', 'Message']);
  assert.equal(after.submit_text, 'Send it');
});

test('a form with no recipient of its own inherits the business email, never a blank', () => {
  const node = sec([col([
    w('heading', { title: 'Get in touch', header_size: 'h2' }),
    w('form', { form_name: 'Contact', form_fields: [{ field_label: 'Name' }] }),
  ])]);
  const a = analyseSection(node, { allowPro: true });
  assert.equal(a.fields.email_to, undefined, 'nothing is claimed where the form had nothing');
  const built = buildAdoptedSection({ analysis: a, brand: BRAND, blockId: 'b' });
  assert.ok(built.ok);
  assert.equal(extractFields(built.node, 'contact').email_to, BRAND.email);
});

test('a form with no recipient and no business email is refused, not published blank', () => {
  const node = sec([col([
    w('heading', { title: 'Get in touch', header_size: 'h2' }),
    w('form', { form_name: 'Contact', form_fields: [{ field_label: 'Name' }] }),
  ])]);
  const a = analyseSection(node, { allowPro: true });
  const built = buildAdoptedSection({ analysis: a, brand: { business_name: 'X' }, blockId: 'b' });
  assert.equal(built.ok, false);
  assert.equal(built.code, 'NO_FORM_RECIPIENT');
  assert.match(built.message, /nowhere to send/);
});

/* ==========================================================================
 * 5. What the client still has to type
 * ======================================================================== */

test('a picture with no description is asked for, never invented', () => {
  const a = analyseSection(ABOUT_NO_ALT(), { allowPro: true });
  assert.equal(a.adoptable, true, 'a missing description does not block the offer');
  assert.ok(a.needsInput.some((n) => n.field === 'image_alt'), 'the preview asks for it');
  assert.ok(a.warnings.some((t) => /description/i.test(t)));

  // The write path refuses until it is filled in...
  const refused = buildAdoptedSection({ analysis: a, brand: BRAND, blockId: 'b', validate: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'CONTENT_NOT_VALID');

  // ...and takes it when it is.
  const ok = buildAdoptedSection({
    analysis: a, brand: BRAND, blockId: 'b', validate: true,
    fixes: { image_alt: 'Our workshop in Shropshire' },
  });
  assert.ok(ok.ok, ok.ok ? '' : ok.message);
  assert.equal(extractFields(ok.node, 'about').image_alt, 'Our workshop in Shropshire');
});

test('the preview deliberately renders a section that is not yet publishable', () => {
  const a = analyseSection(ABOUT_NO_ALT(), { allowPro: true });
  const preview = buildAdoptedSection({ analysis: a, brand: BRAND, blockId: 'b' });
  assert.ok(preview.ok, 'no validation on the preview path — the client has to SEE what it needs');
});

test('fixes reach a row inside a list as well as a top-level field', () => {
  const fields = { headline: 'Our work', images: [{ url: 'a', alt: '' }, { url: 'b', alt: '' }] };
  const out = applyFixes(fields, { headline: 'Recent jobs', 'images[1].alt': 'A garden gym' });
  assert.equal(out.headline, 'Recent jobs');
  assert.equal(out.images[0].alt, '');
  assert.equal(out.images[1].alt, 'A garden gym');
  assert.equal(fields.headline, 'Our work', 'applyFixes does not mutate its input');
});

test('a fix cannot reach a field this section does not have', () => {
  const fields = { headline: 'x' };
  const out = applyFixes(fields, { 'ghost[0].thing': 'y', 'weird.path': 'z' });
  assert.deepEqual(Object.keys(out), ['headline'], 'unknown paths are dropped, not invented');
});

test('the fixes a gallery needs are exactly what validateFields names', () => {
  const noAlt = sec([col([
    w('heading', { title: 'Our work', header_size: 'h2' }),
    w('image-gallery', { gallery: [{ url: 'https://x.invalid/1.jpg', id: 1 }], ia_gallery_meta: [{}] }),
  ])]);
  const a = analyseSection(noAlt, { allowPro: true });
  assert.ok(a.needsInput.some((n) => n.field === 'images[0].alt'));
  const fixed = applyFixes(a.fields, { 'images[0].alt': 'A finished office' });
  assert.equal(validateFields('gallery', fixed).ok, true);
});

/* ==========================================================================
 * 6. Identity — adopting the section we previewed, and no other
 * ======================================================================== */

test('the fingerprint changes when the section does, and only then', () => {
  const a = HERO();
  const b = HERO();
  // Different Elementor ids, same content, so the bytes differ — which is
  // right: adoption replaces the whole node and a changed id means a changed
  // node.
  assert.notEqual(sectionFingerprint(a), sectionFingerprint(b));
  assert.equal(sectionFingerprint(a), sectionFingerprint(JSON.parse(JSON.stringify(a))));

  const edited = JSON.parse(JSON.stringify(a));
  edited.elements[0].elements[0].settings.title = 'Something else';
  assert.notEqual(sectionFingerprint(a), sectionFingerprint(edited));
});

test('a section index is a position on the page and nothing else', () => {
  assert.equal(readSectionIndex('0'), 0);
  assert.equal(readSectionIndex('7'), 7);
  assert.equal(readSectionIndex('-1'), null);
  assert.equal(readSectionIndex('1.5'), null);
  assert.equal(readSectionIndex('abc'), null);
  assert.equal(readSectionIndex('999'), null, 'past the page cap is not a position');
  assert.equal(readSectionIndex(''), null);
});

/* ==========================================================================
 * 7. The way back
 * ======================================================================== */

test('the original bytes survive the store round trip, byte for byte', () => {
  const original = AWARDS();
  const stored = storeInternals.encodeNode(original);
  const restored = JSON.parse(stored);
  assert.equal(JSON.stringify(restored), JSON.stringify(original),
    'Undo adoption restores exactly what was there, not something like it');
  // And the whole page splice puts it back at the same position.
  const page = [HERO(), original, CTA()];
  const adopted = buildAdoptedSection({
    analysis: analyseSection(original, { allowPro: true }), brand: BRAND, blockId: 'b',
  });
  assert.equal(adopted.ok, false, 'the awards strip is not adoptable — that is the point of it');
  const rebuilt = page.map((n, i) => (i === 1 ? restored : n));
  assert.equal(JSON.stringify(rebuilt[1]), JSON.stringify(page[1]));
});

test('a section too big to keep a copy of is refused rather than adopted one-way', () => {
  const huge = sec([col([w('text-editor', { editor: 'x'.repeat(storeInternals.MAX_NODE_BYTES + 10) })])]);
  assert.throws(() => storeInternals.encodeNode(huge), AdoptionTooBigError);
});

test('the undo window is 30 days and the row says when it closes', () => {
  assert.equal(ADOPT_UNDO_DAYS, 30);
  const at = new Date('2020-03-01T00:00:00Z');
  const row = publicAdoption({
    adoption_id: '11111111-1111-1111-1111-111111111111',
    kind: 'hero', confidence: 0.93, adopted_at: at, actor_email: 'a@b.invalid',
  });
  assert.equal(row.undoUntil, '2020-03-31T00:00:00.000Z');
  assert.equal(row.adoptedAt, '2020-03-01T00:00:00.000Z');
  assert.equal(row.canUndo, false, 'an adoption long past its window is not offered an Undo');

  const fresh = publicAdoption({
    adoption_id: '11111111-1111-1111-1111-111111111111',
    kind: 'hero', confidence: 0.93, adopted_at: new Date(), actor_email: null,
  });
  assert.equal(fresh.canUndo, true);
});

/* ==========================================================================
 * 8. The before/after the client actually looks at
 * ======================================================================== */

test('the preview shows both sides, and says nothing has been saved', () => {
  const node = HERO();
  const a = analyseSection(node, { allowPro: true });
  const built = buildAdoptedSection({ analysis: a, brand: BRAND, blockId: 'b' });
  const html = renderAdoptionPreviewHtml({
    node, kind: built.kind, fields: built.fields, kindLabel: a.label,
    warnings: a.warnings, tools: previewTools,
  }, BRAND);

  assert.match(html, /Nothing has been changed on your website/);
  assert.match(html, /Now — built on the site/);
  assert.match(html, /After — Hero banner you can edit/);
  // The words appear on BOTH sides, which is the whole question the client is
  // asking (feedback_assert_presence_not_just_absence).
  assert.equal(html.split('Garden rooms built to last').length - 1, 2);
  assert.match(html, /Get a quote/);
  assert.doesNotMatch(html, /_ia_field|elementor_data|widgetType/);
});

test('the before side renders a section we cannot adopt at all', () => {
  const node = CTA_WITH_VIDEO();
  const a = analyseSection(node, { allowPro: true });
  const html = renderAdoptionPreviewHtml({
    node, kind: a.kind, fields: a.fields, kindLabel: a.label, warnings: a.warnings, tools: previewTools,
  }, BRAND);
  assert.match(html, /See one being built/);
  assert.match(html, /a video/, 'the thing we cannot carry is named in plain words');
});

test('the warning that the layout changes is always shown', () => {
  for (const make of [HERO, SERVICES_BOXES, FAQ, GALLERY]) {
    const a = analyseSection(make(), { allowPro: true });
    assert.ok(a.warnings.some((t) => /layout is replaced/i.test(t)),
      'a client is told the styling changes BEFORE they tap, never after');
  }
});

/* ==========================================================================
 * 9. The plugin's pre-grey hint — the JS half of the mirror
 * ======================================================================== */

test('the widget census the plugin mirrors is the one we compute', () => {
  const c = readCensus(CONTACT());
  assert.deepEqual(c.widgetTypes, ['form', 'heading', 'icon-list']);
  const g = readCensus(SERVICES_COLUMNS());
  assert.deepEqual(g.widgetTypes, ['heading', 'text-editor']);
  const v = readCensus(CTA_WITH_VIDEO());
  assert.deepEqual(v.widgetTypes, ['button', 'heading', 'video']);
});

test('every widget the mapper can meet has a plain-word name', () => {
  for (const t of ['heading', 'text-editor', 'button', 'image', 'icon-box', 'icon-list',
    'accordion', 'image-gallery', 'form', 'testimonial', 'video', 'google_maps', 'html',
    'shortcode', 'counter', 'divider', 'spacer']) {
    const label = widgetLabel(t);
    // A client reads a PHRASE, never a widget type. "a drop-down list" and
    // "a form" are both fine; "icon-box" and "google_maps" are not.
    assert.ok(label && label.includes(' '), `${t} -> "${label}" is not a phrase`);
    assert.notEqual(label, t, `${t} -> "${label}" is the raw type`);
    assert.doesNotMatch(label, /[_]|[a-z]-[a-z]+-/, `${t} -> "${label}" still reads like code`);
  }
  assert.equal(widgetLabel('theme-archive-title'), 'a theme element');
  assert.equal(widgetLabel('some_new_thing'), 'a some new thing block');
});

test('only decoration is safe to lose', () => {
  const dec = { widgetType: 'divider', settings: { style: 'solid' } };
  const spacer = { widgetType: 'spacer', settings: { space: { size: 40 } } };
  const vid = { widgetType: 'video', settings: { youtube_url: 'https://youtu.be/x' } };
  const emptyHeading = { widgetType: 'heading', settings: { title: '' } };
  assert.equal(carriesContent(dec), false);
  assert.equal(carriesContent(spacer), false);
  assert.equal(carriesContent(vid), true);
  assert.equal(carriesContent(emptyHeading), false);
});

/* ==========================================================================
 * 10. Nothing is ever adopted by itself
 * ======================================================================== */

test('there is no bulk adopt: analysePage reports, it does not act', () => {
  const page = [HERO(), SERVICES_BOXES(), AWARDS()];
  const before = JSON.stringify(page);
  const view = analysePage(reduceToSectionList(page), { allowPro: true });
  assert.equal(view.adoptableCount, 2);
  assert.equal(JSON.stringify(page), before, 'a review must not change anything');
  // Every row carries its own fingerprint, so each adoption is a separate,
  // explicitly-confirmed act against the section that was looked at.
  const prints = view.rows.map((r) => r.fingerprint);
  assert.equal(new Set(prints).size, 3);
});

/* ==========================================================================
 * 11. The route's own read — always fresh, never the tree the browser holds
 * ======================================================================== */

const FAKE_SITE = Object.freeze({
  site_id: 's1', tenant_id: 't1', domain: 'fernbrook.invalid',
  site_token_raw: 'raw-token-abc', arion_tier: 'business',
});

/** Swap globalThis.fetch for the length of one call. */
async function withFetch(reply, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const r = typeof reply === 'function' ? reply(url, init) : reply;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)),
    };
  };
  try { return { out: await fn(), calls }; } finally { globalThis.fetch = real; }
}

test('the route reads the page live before it touches a section', async () => {
  const tree = [HERO(), AWARDS()];
  const { out, calls } = await withFetch(
    { status: 200, body: { elementor_data: tree, page_id: 12, title: 'Home' } },
    () => routeInternals.loadLiveSection(FAKE_SITE, 12, 1),
  );
  assert.equal(calls.length, 1, 'one read, and it is a read');
  assert.equal(calls[0].init.method, 'GET');
  assert.match(calls[0].url, /\/pages\/12\/sections\?/);
  assert.ok(out.ok);
  assert.equal(out.node.settings._title, 'Awards strip (built in Elementor)');
  assert.equal(out.entry.editable, false);
  assert.equal(out.entry.reason, 'custom');
});

test('a section index past the end of the live page is refused, not clamped', async () => {
  const { out } = await withFetch(
    { status: 200, body: { elementor_data: [HERO()], page_id: 12 } },
    () => routeInternals.loadLiveSection(FAKE_SITE, 12, 4),
  );
  assert.equal(out.ok, false);
  assert.equal(out.code, 'SECTION_NOT_FOUND');
  assert.match(out.message, /not on the page any more/);
});

test('a website that will not answer is a failure, never an empty page', async () => {
  const { out } = await withFetch(
    { status: 401, body: { error: 'bad token' } },
    () => routeInternals.loadLiveSection(FAKE_SITE, 12, 0),
  );
  assert.equal(out.ok, false);
  assert.ok(out.plugin, 'the transport failure is handed up, not swallowed');
  assert.equal(out.plugin.error, 'site_not_connected');
});
