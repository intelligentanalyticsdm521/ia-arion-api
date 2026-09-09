/**
 * Site builder — the read/write round trip through a real Elementor tree.
 *
 * The load-bearing rule for all five existing sites: a section we did not
 * author is carried back BYTE FOR BYTE, and a section we did author is patched
 * in place rather than rebuilt, so every style and setting it picked up after
 * we wrote it survives (SCOPE_ARION_SITE_BUILDER_2026-09-05 §3.3).
 *
 * These build the fixture with the real emitters and the real adapter, so the
 * test tracks the code rather than a hand-written copy of its output.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { blockToElementorSection } from '../lib/websiteBuilder/elementorAdapter.js';
import { getEmitter } from '../lib/websiteBuilder/emitterRegistry.js';
import {
  reduceToSectionList, extractFields, applyFields, validateFields,
  parseSectionHandle, sectionCatalog, sectionKindMeta,
  purposeFromCssClass, cssClassFromPurpose,
  decodeTestimonialCard, encodeTestimonialCard,
} from '../lib/websiteBuilder/sectionSchema.js';

const BRAND = {
  business_name: 'Fernbrook Garden Rooms',
  email: 'hello@fernbrook.invalid',
  primary_color: '#245A4A',
};

function build(kind, overrides = {}) {
  const block = { ...getEmitter(kind).example, ...overrides };
  return blockToElementorSection({ kind, block, brand: BRAND, seedId: `t-${kind}`, blockId: `blk-${kind}` });
}

/** A section a human built in Elementor: no `ia:` handle, no field markers. */
const HAND_BUILT = Object.freeze({
  id: 'hand001',
  elType: 'section',
  settings: { _title: 'Awards strip (built in Elementor)', structure: '20', gap: 'default' },
  elements: [{
    id: 'handcol1', elType: 'column', settings: { _column_size: 100 },
    elements: [{
      id: 'handw1', elType: 'widget', widgetType: 'heading',
      settings: { title: 'County Build Awards 2025', header_size: 'h3' },
    }],
  }],
  isInner: false,
});

/* ── the reduction ─────────────────────────────────────────────────────── */

test('a page reduces to one entry per top-level section, in page order', () => {
  const tree = [build('hero'), HAND_BUILT, build('faq')];
  const list = reduceToSectionList(tree);

  assert.equal(list.length, 3);
  assert.deepEqual(list.map((s) => s.index), [0, 1, 2]);
  assert.equal(list[0].kind, 'hero');
  assert.equal(list[0].editable, true);
  assert.equal(list[1].kind, null);
  assert.equal(list[1].editable, false);
  assert.equal(list[1].reason, 'custom');
  assert.equal(list[1].label, 'Custom section — built on the site');
  assert.equal(list[2].kind, 'faq');
});

test('every emitter kind reduces to editable fields — no kind is left unreadable', () => {
  for (const kind of Object.keys(sectionKindMeta('hero') ? {
    hero: 1, services: 1, testimonials: 1, cta: 1, about: 1, faq: 1, gallery: 1, contact: 1,
  } : {})) {
    const [entry] = reduceToSectionList([build(kind)]);
    assert.equal(entry.kind, kind, `${kind} keeps its kind`);
    assert.equal(entry.editable, true, `${kind} is editable`);
    assert.ok(entry.fields && typeof entry.fields === 'object', `${kind} yields fields`);
    assert.equal(typeof entry.fields.headline, 'string', `${kind} yields a headline`);
    assert.ok(entry.fields.headline.length > 0, `${kind} headline is not empty`);
  }
});

test('the reduction reads back exactly what the emitters put in', () => {
  const hero = build('hero');
  const f = extractFields(hero, 'hero');
  const ex = getEmitter('hero').example;
  assert.equal(f.headline, ex.headline);
  assert.equal(f.subheadline, ex.subheadline);
  assert.equal(f.cta_text, ex.cta_text);
  assert.equal(f.cta_href, ex.cta_href);

  const services = extractFields(build('services'), 'services');
  assert.equal(services.services.length, getEmitter('services').example.services.length);
  assert.equal(services.services[0].title, getEmitter('services').example.services[0].title);
  // `fas fa-tools` on the way in, plain `tools` on the way out.
  assert.equal(services.services[0].icon_name, getEmitter('services').example.services[0].icon_name);

  const faq = extractFields(build('faq'), 'faq');
  assert.equal(faq.faqs.length, getEmitter('faq').example.faqs.length);
  assert.equal(faq.faqs[0].question, getEmitter('faq').example.faqs[0].question);
  assert.equal(faq.faqs[0].answer, getEmitter('faq').example.faqs[0].answer);

  const about = extractFields(build('about'), 'about');
  assert.deepEqual(about.story_paragraphs, getEmitter('about').example.story_paragraphs);

  const tst = extractFields(build('testimonials'), 'testimonials');
  assert.equal(tst.testimonials[0].quote, getEmitter('testimonials').example.testimonials[0].quote);
  assert.equal(tst.testimonials[0].attribution, getEmitter('testimonials').example.testimonials[0].attribution);
  assert.equal(tst.testimonials[0].rating, 5);

  const gallery = extractFields(build('gallery'), 'gallery');
  assert.equal(gallery.images.length, getEmitter('gallery').example.images.length);
  assert.equal(gallery.images[0].alt, getEmitter('gallery').example.images[0].alt);

  const contact = extractFields(build('contact'), 'contact');
  assert.equal(contact.email_to, BRAND.email);
  assert.equal(contact.form_purpose, 'lead');
  assert.deepEqual(contact.form_fields, getEmitter('contact').example.form_config.fields);
  assert.equal(contact.contact_methods[0].kind, 'phone');
  assert.equal(contact.contact_methods[0].value, getEmitter('contact').example.contact_methods[0].value);
});

/* ── the round trip ────────────────────────────────────────────────────── */

test('an untouched section round-trips byte-equivalent', () => {
  const tree = [build('hero'), HAND_BUILT, build('services')];
  const before = JSON.stringify(tree);

  const list = reduceToSectionList(tree);
  // Save with exactly the fields we read back — the "nothing changed" case.
  const rebuilt = list.map((s) => (s.editable ? applyFields(s.node, s.kind, s.fields) : s.node));

  assert.equal(JSON.stringify(rebuilt), before, 'the tree is identical after a no-op save');
});

test('a custom section is never rewritten, even when fields are sent for it', () => {
  const list = reduceToSectionList([HAND_BUILT]);
  assert.equal(list[0].fields, null);
  // applyFields on a section with no kind is a no-op by construction: the save
  // path never calls it, and calling it with a bogus kind changes nothing.
  const out = applyFields(HAND_BUILT, 'hero', { headline: 'Hijacked' });
  assert.equal(JSON.stringify(out), JSON.stringify(HAND_BUILT));
});

test('editing a headline changes that setting and nothing else', () => {
  const hero = build('hero');
  const patched = applyFields(hero, 'hero', { headline: 'Garden rooms built to last' });

  assert.equal(extractFields(patched, 'hero').headline, 'Garden rooms built to last');
  // Same ids, same structure, same everything else.
  assert.equal(patched.id, hero.id);
  assert.equal(patched.settings._title, hero.settings._title);
  assert.equal(patched.settings.custom_height.size, hero.settings.custom_height.size);
  assert.equal(
    JSON.stringify(extractFields(patched, 'hero').subheadline),
    JSON.stringify(extractFields(hero, 'hero').subheadline),
  );
  // And the original is untouched — a failed save must not leave a half edit.
  assert.equal(extractFields(hero, 'hero').headline, getEmitter('hero').example.headline);
});

test('a link and a picture survive the round trip', () => {
  const hero = build('hero');
  const patched = applyFields(hero, 'hero', {
    cta_href: 'tel:+441000960118',
    image_url: 'https://example.invalid/wp-content/uploads/room.jpg',
  });
  const f = extractFields(patched, 'hero');
  assert.equal(f.cta_href, 'tel:+441000960118');
  assert.equal(f.image_url, 'https://example.invalid/wp-content/uploads/room.jpg');
  assert.equal(patched.settings.background_image.url, 'https://example.invalid/wp-content/uploads/room.jpg');
});

test('a list grows and shrinks, and the widgets follow', () => {
  const services = build('services');
  const before = extractFields(services, 'services').services;
  assert.equal(before.length, 3);

  const grown = applyFields(services, 'services', {
    services: [...before, { title: 'Re-roofing', description: 'Felt and battens.', icon_name: 'home' }],
  });
  const after = extractFields(grown, 'services').services;
  assert.equal(after.length, 4);
  assert.equal(after[3].title, 'Re-roofing');
  assert.equal(after[0].title, before[0].title, 'the existing items are untouched');

  const shrunk = applyFields(grown, 'services', { services: after.slice(0, 2) });
  assert.equal(extractFields(shrunk, 'services').services.length, 2);
});

test('the cloned widget gets fresh Elementor ids — duplicates break the page', () => {
  const services = build('services');
  const items = extractFields(services, 'services').services;
  const grown = applyFields(services, 'services', {
    services: [...items, { title: 'Extra', description: 'x', icon_name: 'star' }],
  });
  const ids = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.id) ids.push(n.id);
    (n.elements || []).forEach(walk);
  })(grown);
  assert.equal(new Set(ids).size, ids.length, 'every element id on the section is unique');
});

test('an FAQ question can be added and removed inside the one accordion widget', () => {
  const faq = build('faq');
  const items = extractFields(faq, 'faq').faqs;
  const grown = applyFields(faq, 'faq', {
    faqs: [...items, { question: 'Do you take card?', answer: 'Yes, and bank transfer.' }],
  });
  const out = extractFields(grown, 'faq').faqs;
  assert.equal(out.length, items.length + 1);
  assert.equal(out[out.length - 1].question, 'Do you take card?');
  assert.equal(out[out.length - 1].answer, 'Yes, and bank transfer.');
  // Every repeater row keeps an _id, which Elementor needs.
  const rows = grown.elements[0].elements.find((w) => w.widgetType === 'accordion').settings.tabs;
  assert.ok(rows.every((r) => typeof r._id === 'string' && r._id.length > 0));
});

test('changing the form purpose rewrites the CSS class the interceptor routes on', () => {
  // class-ia-form-interceptor.php:127 types every submission from this class.
  // Getting it wrong means a booking lands in the inbox as a plain contact.
  const contact = build('contact');
  const patched = applyFields(contact, 'contact', { form_purpose: 'booking', email_to: 'bookings@fernbrook.invalid' });
  const form = patched.elements[0].elements[1].elements[1].elements[0];
  assert.equal(form.widgetType, 'form');
  assert.equal(form.settings.form_css_class, 'ia-booking');
  assert.equal(form.settings.email_to, 'bookings@fernbrook.invalid');
  assert.equal(extractFields(patched, 'contact').form_purpose, 'booking');
});

test('purpose <-> css class is a closed loop', () => {
  for (const p of ['lead', 'quote', 'booking', 'newsletter']) {
    assert.equal(purposeFromCssClass(cssClassFromPurpose(p)), p);
  }
  // The legacy class our adapter used for a contact form still reads as a lead.
  assert.equal(purposeFromCssClass('ia-contact'), 'lead');
  assert.equal(cssClassFromPurpose('nonsense'), 'ia-lead');
});

test('the testimonial card survives its own markup', () => {
  const item = { quote: 'Two winters, no heater. "Genuinely" warm.', attribution: 'Tom B.', role: 'Studio, Farnley', rating: 4 };
  assert.deepEqual(decodeTestimonialCard(encodeTestimonialCard(item)), item);
});

/* ── the handle ────────────────────────────────────────────────────────── */

test('the handle tells us what a section is, and only for handles we minted', () => {
  assert.deepEqual(parseSectionHandle('ia:hero:hero.gradient.v1:blk-7'), {
    handle: 'ia:hero:hero.gradient.v1:blk-7', kind: 'hero', blueprintId: 'hero.gradient.v1', blockId: 'blk-7',
  });
  assert.equal(parseSectionHandle('ia:hero:scratch:-').blockId, null);
  assert.equal(parseSectionHandle('hero.gradient.v1'), null);
  assert.equal(parseSectionHandle('Awards strip'), null);
  assert.equal(parseSectionHandle(undefined), null);
});

test('a section whose kind we no longer understand is treated as custom, not crashed on', () => {
  const alien = { id: 'x1', elType: 'section', settings: { _title: 'ia:carousel:scratch:b1' }, elements: [] };
  const [entry] = reduceToSectionList([alien]);
  assert.equal(entry.editable, false);
  assert.equal(entry.reason, 'custom');
  assert.equal(entry.node, alien);
});

test('one of ours built before the field markers existed is shown, but not editable', () => {
  const old = {
    id: 'x2', elType: 'section', settings: { _title: 'ia:hero:scratch:b9' },
    elements: [{
      id: 'c', elType: 'column', settings: {},
      elements: [{ id: 'w', elType: 'widget', widgetType: 'heading', settings: { title: 'Old hero' } }],
    }],
  };
  const [entry] = reduceToSectionList([old]);
  assert.equal(entry.kind, 'hero');
  assert.equal(entry.editable, false);
  assert.equal(entry.reason, 'no_field_markers');
  assert.equal(entry.fields, null);
});

/* ── validation ────────────────────────────────────────────────────────── */

test('validation speaks plainly and names the field', () => {
  const bad = validateFields('hero', { headline: '', cta_href: 'javascript:alert(1)' });
  assert.equal(bad.ok, false);
  const msgs = bad.errors.map((e) => e.message).join(' | ');
  assert.match(msgs, /Headline cannot be empty/);
  assert.match(msgs, /Button link should start with/);
  // No stack traces, no field paths, no code names in front of a client.
  assert.ok(!/undefined|null|Error|\bregex\b/i.test(msgs), msgs);
});

test('an email field will not accept something that is not an address', () => {
  const out = validateFields('contact', {
    headline: 'Get in touch', form_purpose: 'quote', email_to: 'not-an-email',
  });
  assert.equal(out.ok, false);
  assert.match(out.errors.map((e) => e.message).join(' '), /real email address/);
});

test('a purpose outside the list is refused', () => {
  const out = validateFields('contact', {
    headline: 'Get in touch', form_purpose: 'spam', email_to: 'a@b.co',
  });
  assert.equal(out.ok, false);
  assert.match(out.errors.map((e) => e.message).join(' '), /not one of the choices/);
});

test('a list that is too long or too short is refused with the number in it', () => {
  const tooMany = validateFields('services', {
    headline: 'What we do',
    services: Array.from({ length: 9 }, () => ({ title: 'x', description: 'y' })),
  });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.errors.map((e) => e.message).join(' '), /at most 8/);

  const tooFew = validateFields('faq', { headline: 'Questions', faqs: [] });
  assert.equal(tooFew.ok, false);
  assert.match(tooFew.errors.map((e) => e.message).join(' '), /at least 1/);
});

test('what the reduction produces always validates — read then save cannot fail on its own output', () => {
  for (const kind of ['hero', 'services', 'testimonials', 'cta', 'about', 'faq', 'gallery', 'contact']) {
    const [entry] = reduceToSectionList([build(kind)]);
    const out = validateFields(kind, entry.fields);
    assert.equal(out.ok, true, `${kind}: ${JSON.stringify(out.errors)}`);
  }
});

/* ── the catalogue ─────────────────────────────────────────────────────── */

test('Lite is told WHY the form section is unavailable, not just denied it', () => {
  const lite = sectionCatalog({ allowPro: false });
  const contact = lite.find((c) => c.kind === 'contact');
  assert.equal(contact.available, false);
  assert.match(contact.unavailableReason, /Elementor Pro/);
  // And nothing else is withheld — the editor itself is on every tier (W-4).
  assert.equal(lite.filter((c) => !c.available).length, 1);

  const pro = sectionCatalog({ allowPro: true });
  assert.equal(pro.every((c) => c.available), true);
  // Eight archetypes, plus pricing, team and stats from ARION pack 2.
  assert.equal(pro.length, 11);
});
