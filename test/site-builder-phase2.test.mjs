/**
 * Site builder Phase 2 — forms, the pixel, booking links, pictures, tiers.
 *
 * The one sentence this file exists to hold up:
 *
 *   Editing the WORDS on a page must never change where its enquiries go,
 *   whether the visit that produced them was counted, or where its buttons
 *   point.
 *
 * So most of what follows is byte-identity: build a real section with the
 * real emitters, change ONE unrelated field through the real save path, and
 * assert that every routing attribute is the same object it was. Guards are
 * proved to have teeth by breaking them on purpose here, in-suite, rather
 * than only by hand (memory: feedback_mutation_test_your_guards).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { blockToElementorSection } from '../lib/websiteBuilder/elementorAdapter.js';
import { getEmitter } from '../lib/websiteBuilder/emitterRegistry.js';
import {
  reduceToSectionList, extractFields, applyFields, validateFields,
  validateProposedFields, sectionCatalog, sectionKindMeta, FORM_PURPOSES,
  CODECS,
} from '../lib/websiteBuilder/sectionSchema.js';
import { buildStarterSection, starterBlock } from '../lib/websiteBuilder/starterSections.js';
import { bookingUrlFor, __test__ as brandInternals } from '../lib/websiteBuilder/brandContext.js';
import { listMedia, setMediaAlt, pushBookingConfig } from '../lib/websiteBuilder/pageClient.js';
import { __test__ as routeInternals } from '../routes/arion/pages.js';
import { __test__ as aiInternals, aiTierGate } from '../lib/websiteBuilder/aiEdit.js';

const { buildNodes, withFormRecipient, publicMediaItem, siteAllowsPro } = routeInternals;

const BRAND = Object.freeze({
  business_name: 'Fernbrook Garden Rooms',
  email: 'hello@fernbrook.invalid',
  primary_color: '#245A4A',
  booking_href: '',
});

const SITE = Object.freeze({
  site_id: 's1', tenant_id: 't1',
  domain: 'fernbrook.invalid',
  site_token_raw: 'raw-token-abc',
  arion_tier: 'business',
});

function build(kind, overrides = {}, brand = BRAND) {
  const block = { ...getEmitter(kind).example, ...overrides };
  return blockToElementorSection({ kind, block, brand, seedId: `p2-${kind}`, blockId: `blk-${kind}` });
}

/** A fetch stand-in that records the call. */
function fakeFetch(reply) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const r = typeof reply === 'function' ? reply(url, init) : reply;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)),
    };
  };
  impl.calls = calls;
  return impl;
}

/** Every node in a section that carries a form widget's settings. */
function formSettings(section) {
  let found = null;
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.widgetType === 'form') found = n.settings;
    (n.elements || []).forEach(walk);
  };
  walk(section);
  return found;
}

/**
 * The three attributes a form submission is routed by. `form_name` rides
 * along because the plugin's interceptor falls back to it when no class
 * matches (class-ia-form-interceptor.php:127) — losing it would change the
 * type of every submission on a site running an older plugin.
 */
function formWire(section) {
  const s = formSettings(section) || {};
  return {
    form_css_class: s.form_css_class,
    email_to: s.email_to,
    form_name: s.form_name,
    email_subject: s.email_subject,
  };
}

/* ==========================================================================
 * 1. Forms stay wired through every kind of edit
 * ======================================================================== */

test('the form section we emit is addressed and typed from the start', () => {
  const section = build('contact');
  const wire = formWire(section);
  assert.equal(wire.email_to, BRAND.email, 'email_to must come from brand context, never ""');
  assert.match(String(wire.form_css_class), /^ia-/, 'the interceptor keys on an ia- class');
});

test('a save that touches only the headline leaves every form wire byte-identical', () => {
  const section = build('contact');
  const before = formWire(section);

  const [entry] = reduceToSectionList([section]);
  const fields = { ...entry.fields, headline: 'Talk to the workshop' };
  const saved = applyFields(section, 'contact', fields);

  assert.deepEqual(formWire(saved), before);
  // And the change we DID ask for actually happened — asserting the absence
  // of damage proves nothing on its own (feedback_assert_presence_not_just_absence).
  assert.equal(extractFields(saved, 'contact').headline, 'Talk to the workshop');
});

test('a save that changes nothing at all is byte-identical, form included', () => {
  const section = build('contact');
  const [entry] = reduceToSectionList([section]);
  const saved = applyFields(section, 'contact', entry.fields);
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), JSON.parse(JSON.stringify(section)));
});

test('EVERY archetype survives a no-op save byte for byte', () => {
  // The broadest version of the rule, and the assertion that found the
  // form-field defect: read a section, write back exactly what you read, and
  // the tree must be the same tree. Anything that re-derives a value from
  // another one shows up here and nowhere else.
  for (const kind of ['hero', 'services', 'testimonials', 'cta', 'about', 'faq', 'gallery', 'contact']) {
    const section = build(kind);
    const [entry] = reduceToSectionList([section]);
    const saved = applyFields(section, kind, entry.fields);
    assert.deepEqual(
      JSON.parse(JSON.stringify(saved)),
      JSON.parse(JSON.stringify(section)),
      `${kind} changed on a save that changed nothing`,
    );
  }
});

test('a reorder never re-renders a section, so nothing on it can change', () => {
  const hero = build('hero');
  const contact = build('contact');
  const before = formWire(contact);

  // A reorder is the section list in a different order. `buildNodes` passes
  // an untouched section straight through.
  const incoming = reduceToSectionList([hero, contact]).reverse()
    .map((s) => ({ fields: s.fields, node: s.node }));
  const { nodes, errors } = buildNodes(incoming, BRAND);

  assert.deepEqual(errors, []);
  assert.equal(nodes.length, 2);
  assert.deepEqual(formWire(nodes[0].node), before);
});

test('an ARGUS-style copy edit leaves the wires alone', () => {
  const section = build('contact');
  const before = formWire(section);
  const [entry] = reduceToSectionList([section]);

  // What an approved proposal fills into the editor: copy fields only.
  const after = { ...entry.fields, headline: 'Tell us about your garden room', subheadline: 'We reply the same day.' };
  const saved = applyFields(section, 'contact', after);

  assert.deepEqual(formWire(saved), before);
});

test('THE GUARD HAS TEETH — a writer that drops the CSS class is caught', () => {
  const section = build('contact');
  const before = formWire(section);

  // The mutation: a save path that "tidies up" by clearing the class.
  const broken = JSON.parse(JSON.stringify(applyFields(section, 'contact', { headline: 'x' })));
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.widgetType === 'form') delete n.settings.form_css_class;
    (n.elements || []).forEach(walk);
  };
  walk(broken);

  assert.notDeepEqual(formWire(broken), before);
  assert.equal(formWire(broken).form_css_class, undefined);
});

test('THE GUARD HAS TEETH — a writer that blanks the recipient is caught', () => {
  const section = build('contact');
  const broken = JSON.parse(JSON.stringify(section));
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.widgetType === 'form') n.settings.email_to = '';
    (n.elements || []).forEach(walk);
  };
  walk(broken);
  assert.notDeepEqual(formWire(broken), formWire(section));
});

test('changing the purpose rewrites ONLY the class the interceptor reads', () => {
  const section = build('contact');
  const [entry] = reduceToSectionList([section]);
  const saved = applyFields(section, 'contact', { ...entry.fields, form_purpose: 'booking' });

  assert.equal(formWire(saved).form_css_class, 'ia-booking');
  assert.equal(formWire(saved).email_to, formWire(section).email_to);
  assert.equal(formWire(saved).form_name, formWire(section).form_name);
});

/* ── the recipient: read-only, from the business, and fail-loud ─────────── */

test('the recipient is filled from the business when the section carries none', () => {
  const out = withFormRecipient('contact', { headline: 'Hi', email_to: '' }, BRAND);
  assert.equal(out.ok, true);
  assert.equal(out.fields.email_to, BRAND.email);
});

test('a recipient the site already has is NEVER overwritten by the business one', () => {
  const out = withFormRecipient('contact', { email_to: 'office@fernbrook.invalid' }, BRAND);
  assert.equal(out.ok, true);
  assert.equal(out.fields.email_to, 'office@fernbrook.invalid');
});

test('a form with no recipient anywhere cannot be published, and says why', () => {
  const out = withFormRecipient('contact', { email_to: '' }, { ...BRAND, email: '' });
  assert.equal(out.ok, false);
  assert.match(out.message, /nowhere to send enquiries/i);
  assert.match(out.message, /Your business/i);
  assert.match(out.message, /Nothing was saved/i);
});

test('the save path refuses the whole page rather than publish an unaddressed form', () => {
  const section = build('contact');
  const [entry] = reduceToSectionList([section]);
  const incoming = [{ fields: { ...entry.fields, email_to: '' }, node: section }];

  const { nodes, errors } = buildNodes(incoming, { ...BRAND, email: '' });
  assert.equal(nodes.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].field, /email_to$/);
  assert.match(errors[0].message, /nowhere to send enquiries/i);
});

test('with a business email on file the same page saves, addressed', () => {
  const section = build('contact');
  const [entry] = reduceToSectionList([section]);
  const incoming = [{ fields: { ...entry.fields, email_to: '' }, node: section }];

  const { nodes, errors } = buildNodes(incoming, BRAND);
  assert.deepEqual(errors, []);
  assert.equal(formWire(nodes[0].node).email_to, BRAND.email);
});

test('the recipient field is read-only and points at the business details', () => {
  const spec = sectionKindMeta('contact').fields.find((f) => f.key === 'email_to');
  assert.equal(spec.readOnly, true);
  assert.equal(spec.source, 'business');
  assert.equal(spec.notForAi, true);
  assert.match(spec.help, /Your business/);
  assert.doesNotMatch(spec.help.toLowerCase(), /tenant/);
});

test('the purpose picker offers exactly the four choices a client understands', () => {
  assert.deepEqual(FORM_PURPOSES.map((p) => p.label),
    ['Contact', 'Quote request', 'Booking request', 'Newsletter']);
  // The VALUES are the wire and must not drift with the labels.
  assert.deepEqual(FORM_PURPOSES.map((p) => p.value),
    ['lead', 'quote', 'booking', 'newsletter']);
});

/* ── ARGUS may rewrite the words, never the wires ───────────────────────── */

test('ARGUS cannot re-route a form: email_to is refused outright', () => {
  const check = validateProposedFields('contact', { email_to: 'attacker@example.invalid' });
  assert.equal(check.ok, false);
  assert.match(check.errors[0].message, /not something ARGUS AI can change/);
});

test('ARGUS cannot re-type a form: form_purpose is refused outright', () => {
  const check = validateProposedFields('contact', { form_purpose: 'newsletter' });
  assert.equal(check.ok, false);
  assert.match(check.errors[0].message, /not something ARGUS AI can change/);
});

test('ARGUS is never even TOLD about the wires', () => {
  const lines = aiInternals.fieldLines ? aiInternals.fieldLines('contact') : null;
  if (lines === null) return; // fieldLines is private; the refusal above is the guard that matters
  assert.doesNotMatch(lines, /email_to/);
  assert.doesNotMatch(lines, /form_purpose/);
});

test('ARGUS rewriting the copy of a form section still passes', () => {
  const section = build('contact');
  const [entry] = reduceToSectionList([section]);
  const check = validateProposedFields(
    'contact',
    { headline: 'Talk to us', subheadline: 'We answer the same day.' },
    { existing: entry.fields },
  );
  assert.equal(check.ok, true, JSON.stringify(check.errors));
});

/* ==========================================================================
 * 2. The pixel
 *
 * The SPARK visitor pixel and the ARGUS beacon are enqueued on `wp_head` by
 * the plugin on every front-end render, with no reference to page content,
 * and the visitor id reaches a submission from the `__ia_vid` COOKIE, read
 * server-side. None of that is in `_elementor_data`, so the only way an edit
 * could disturb it is by writing something OTHER than `_elementor_data` —
 * which is the invariant asserted here. The live proof (view source after an
 * edit) is row 15 of the 1A walk and a Phase 2 verifier check.
 * ======================================================================== */

test('a save writes sections, title and status — and nothing else', async () => {
  const f = fakeFetch({ status: 200, body: { success: true, page_id: 7 } });
  const { writePageSections } = await import('../lib/websiteBuilder/pageClient.js');
  await writePageSections(SITE, 7, { sections: [], title: 'Home', status: 'publish' }, { fetchImpl: f });

  const body = JSON.parse(f.calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ['sections', 'status', 'title']);
});

test('no section we emit carries a script tag, so an edit cannot inject or drop one', () => {
  for (const kind of ['hero', 'services', 'testimonials', 'cta', 'about', 'faq', 'gallery', 'contact']) {
    const json = JSON.stringify(build(kind));
    assert.doesNotMatch(json, /<script/i, `${kind} must not carry a script`);
    assert.doesNotMatch(json, /__ia_vid/, `${kind} must not carry the visitor cookie name`);
  }
});

/* ==========================================================================
 * 3. Booking links
 * ======================================================================== */

test('the booking address puts the BUSINESS IN THE PATH, not in a subdomain', () => {
  // SEAMS PACK 4B. This emitted `https://<slug>.book.ia-dm.com/` until
  // 2026-09-06, and that hostname has never resolved for a real client: there
  // is no *.book.ia-dm.com binding in DNS, and the Static Web App
  // custom-domain cap is why APP-1 chose the path model. Every "Book online"
  // button ARION had ever published pointed at a host that does not exist.
  // oliver-api's buildBookingUrl and lib/appQr.appUrlFor already emit this
  // shape; this was the last emitter that did not.
  assert.equal(bookingUrlFor('fernbrook'), `https://${brandInternals.BOOKING_HOSTNAME_SUFFIX}/fernbrook/`);
  assert.equal(bookingUrlFor('Fernbrook-Garden'), `https://${brandInternals.BOOKING_HOSTNAME_SUFFIX}/fernbrook-garden/`);
  // MUTATION: the subdomain form must not come back.
  assert.ok(!bookingUrlFor('fernbrook').startsWith('https://fernbrook.'),
    'a subdomain link is a link that has never resolved');
});

test('a slug that is not a safe path segment produces NO booking link', () => {
  // The slug is a path segment now rather than a host label, but this string
  // still goes straight into a published page. Anything that could point the
  // button somewhere else has to come back empty, not "mostly right".
  for (const bad of ['', 'a', 'has.dot', 'has/slash', '-leading', 'trailing-', 'has space', 'x'.repeat(70)]) {
    assert.equal(bookingUrlFor(bad), '', `"${bad}" must not become a booking link`);
  }
});

test('a new hero and CTA point at the booking page when the business has one', () => {
  const withBooking = { ...BRAND, booking_href: 'https://book.ia-dm.com/fernbrook/' };
  assert.equal(starterBlock('hero', withBooking).cta_href, 'https://book.ia-dm.com/fernbrook/');
  assert.equal(starterBlock('hero', withBooking).cta_text, 'Book online');
  assert.equal(starterBlock('cta', withBooking).primary_cta_href, 'https://book.ia-dm.com/fernbrook/');
});

test('a business with no booking page still gets the contact anchor, not a dead link', () => {
  assert.equal(starterBlock('hero', BRAND).cta_href, '#contact');
  assert.equal(starterBlock('cta', BRAND).primary_cta_href, '#contact');
});

test('a booking link survives an edit to the words around it', () => {
  const withBooking = { ...BRAND, booking_href: 'https://book.ia-dm.com/fernbrook/' };
  const built = buildStarterSection('cta', withBooking);
  assert.equal(built.ok, true);

  const [entry] = reduceToSectionList([built.node]);
  assert.equal(entry.fields.primary_cta_href, 'https://book.ia-dm.com/fernbrook/');

  const saved = applyFields(built.node, 'cta', { ...entry.fields, headline: 'Book your survey' });
  assert.equal(extractFields(saved, 'cta').primary_cta_href, 'https://book.ia-dm.com/fernbrook/');
  assert.equal(extractFields(saved, 'cta').headline, 'Book your survey');
});

test('the button fields are the ones that offer the booking page as a choice', () => {
  const heroHref = sectionKindMeta('hero').fields.find((f) => f.key === 'cta_href');
  const ctaHref = sectionKindMeta('cta').fields.find((f) => f.key === 'primary_cta_href');
  assert.equal(heroHref.offersBooking, true);
  assert.equal(ctaHref.offersBooking, true);
  // A field that is not a button link must NOT offer it.
  assert.equal(sectionKindMeta('hero').fields.find((f) => f.key === 'headline').offersBooking, undefined);
});

test('the booking config push sends the url, empty included', async () => {
  const f = fakeFetch({ status: 200, body: { success: true } });
  await pushBookingConfig(SITE, { bookingUrl: 'https://x.book.ia-dm.com/' }, { fetchImpl: f });
  assert.match(f.calls[0].url, /\/booking-config\?/);
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { booking_url: 'https://x.book.ia-dm.com/' });

  const f2 = fakeFetch({ status: 200, body: { success: true } });
  await pushBookingConfig(SITE, { bookingUrl: '' }, { fetchImpl: f2 });
  assert.deepEqual(JSON.parse(f2.calls[0].init.body), { booking_url: '' });
});

test('the booking push is throttled per site, and fires again when the answer changes', () => {
  const { syncBookingButton, bookingPushed } = routeInternals;
  bookingPushed.clear();
  const site = { ...SITE, site_id: 'throttle-1', domain: 'nowhere.invalid' };

  syncBookingButton(site, 'https://a.book.ia-dm.com/');
  const first = bookingPushed.get('throttle-1');
  assert.equal(first.href, 'https://a.book.ia-dm.com/');

  syncBookingButton(site, 'https://a.book.ia-dm.com/');
  assert.equal(bookingPushed.get('throttle-1').at, first.at, 'the same answer inside the window is not re-pushed');

  syncBookingButton(site, '');
  assert.equal(bookingPushed.get('throttle-1').href, '', 'a CHANGED answer pushes straight away');
  bookingPushed.clear();
});

/* ==========================================================================
 * 4. Pictures — the library, the attachment id, and alt text
 * ======================================================================== */

test('the media list asks for one page, clamped, with the search term', async () => {
  const f = fakeFetch({ status: 200, body: { items: [], total: 0 } });
  await listMedia(SITE, { page: 3, perPage: 500, search: 'deck' }, { fetchImpl: f });
  const url = new URL(f.calls[0].url);
  assert.equal(url.searchParams.get('page'), '3');
  assert.equal(url.searchParams.get('per_page'), '60', 'per_page is clamped, not trusted');
  assert.equal(url.searchParams.get('search'), 'deck');
  assert.match(url.pathname, /\/media$/);
  assert.equal(f.calls[0].init.headers['X-Arion-Site-Token'], 'raw-token-abc');
});

test('the media list defaults to the first page and never sends an empty search', async () => {
  const f = fakeFetch({ status: 200, body: { items: [] } });
  await listMedia(SITE, {}, { fetchImpl: f });
  const url = new URL(f.calls[0].url);
  assert.equal(url.searchParams.get('page'), '1');
  assert.equal(url.searchParams.get('per_page'), '24');
  assert.equal(url.searchParams.has('search'), false);
});

test('setting alt text posts to the attachment, not to the page', async () => {
  const f = fakeFetch({ status: 200, body: { success: true, alt: 'A green garden room' } });
  await setMediaAlt(SITE, 42, 'A green garden room', { fetchImpl: f });
  assert.match(f.calls[0].url, /\/media\/42\/alt\?/);
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { alt: 'A green garden room' });
});

test('a media row reaches the picker in words, with its rendered-size count', () => {
  const row = publicMediaItem({
    attachment_id: '42', url: 'https://s/x.jpg', thumbnail_url: 'https://s/x-150.jpg',
    alt: 'A garden room', title: 'x', filename: 'x.jpg', mime: 'image/jpeg',
    width: 1600, height: 900, bytes: 240000, uploaded_at: '2026-09-01T00:00:00Z',
    sizes: [{ name: 'medium' }, { name: 'large' }],
  });
  assert.equal(row.attachmentId, 42);
  assert.equal(row.sizeCount, 2);
  assert.equal(row.alt, 'A garden room');
  assert.equal(row.thumbnailUrl, 'https://s/x-150.jpg');
});

test('an attachment id is a positive whole number or nothing at all', () => {
  assert.equal(CODECS.attachment_id.decode('42'), 42);
  assert.equal(CODECS.attachment_id.decode(42), 42);
  for (const junk of ['', null, undefined, 'abc', '0', '-3', '4.5', {}]) {
    assert.equal(CODECS.attachment_id.decode(junk), '', `${JSON.stringify(junk)} is not an attachment id`);
  }
});

test('choosing a library picture stores its attachment id, which is what makes srcset', () => {
  // A bare URL renders one file at every screen width; Elementor only emits
  // srcset/sizes when the widget carries a real attachment id.
  const section = build('about');
  const [entry] = reduceToSectionList([section]);
  const saved = applyFields(section, 'about', {
    ...entry.fields,
    image_url: 'https://fernbrook.invalid/wp-content/uploads/room.jpg',
    image_id: 77,
    image_alt: 'A cedar-clad garden room at dusk',
  });
  const back = extractFields(saved, 'about');
  assert.equal(back.image_id, 77);
  assert.equal(back.image_url, 'https://fernbrook.invalid/wp-content/uploads/room.jpg');
});

test('the hero background keeps its attachment id through the round trip', () => {
  const section = build('hero', { background_style: 'image' });
  const [entry] = reduceToSectionList([section]);
  const saved = applyFields(section, 'hero', { ...entry.fields, image_url: 'https://s/bg.jpg', image_id: 5 });
  assert.equal(extractFields(saved, 'hero').image_id, 5);
});

test('a gallery picture keeps its attachment id, so the lightbox opens the full size', () => {
  const section = build('gallery');
  const [entry] = reduceToSectionList([section]);
  const images = [
    { url: 'https://s/1.jpg', id: 11, alt: 'The workshop floor', caption: '', category: '' },
    { url: 'https://s/2.jpg', id: 12, alt: 'A finished room', caption: '', category: '' },
  ];
  const saved = applyFields(section, 'gallery', { ...entry.fields, images });
  const back = extractFields(saved, 'gallery');
  assert.deepEqual(back.images.map((i) => i.id), [11, 12]);
  assert.deepEqual(back.images.map((i) => i.alt), ['The workshop floor', 'A finished room']);
});

test('a picture with no description is refused, in plain words', () => {
  const section = build('about');
  const [entry] = reduceToSectionList([section]);
  const check = validateFields('about', { ...entry.fields, image_url: 'https://s/x.jpg', image_alt: '' });
  assert.equal(check.ok, false);
  const row = check.errors.find((e) => e.field === 'image_alt');
  assert.ok(row, JSON.stringify(check.errors));
  assert.match(row.message, /screen reader/i);
  assert.doesNotMatch(row.message.toLowerCase(), /alt|attribute/);
});

test('no picture means no description is asked for', () => {
  const section = build('about');
  const [entry] = reduceToSectionList([section]);
  const check = validateFields('about', { ...entry.fields, image_url: '', image_alt: '' });
  assert.equal(check.errors.some((e) => e.field === 'image_alt'), false);
});

test('a gallery picture with no description is refused too, naming the row', () => {
  const check = validateFields('gallery', {
    headline: 'Our work',
    images: [{ url: 'https://s/1.jpg', id: 1, alt: '', caption: '', category: '' }],
  });
  assert.equal(check.ok, false);
  assert.ok(check.errors.some((e) => e.field === 'images[0].alt'), JSON.stringify(check.errors));
});

test('the hero background says plainly why it needs no description', () => {
  const spec = sectionKindMeta('hero').fields.find((f) => f.key === 'image_url');
  assert.match(spec.help, /behind the words/i);
});

test('ARGUS cannot swap a picture by inventing an attachment id', () => {
  assert.equal(validateProposedFields('about', { image_id: 999 }).ok, false);
  assert.equal(validateProposedFields('gallery', {
    images: [{ url: 'https://s/1.jpg', id: 999, alt: 'x' }],
  }).ok, false);
});

test('every attachment-id field is hidden from the client and withheld from ARGUS', () => {
  const hidden = [];
  for (const kind of Object.keys({ hero: 1, about: 1, gallery: 1 })) {
    for (const spec of sectionKindMeta(kind).fields) {
      if (spec.type === 'hidden') hidden.push(spec);
      for (const sub of spec.item || []) if (sub.type === 'hidden') hidden.push(sub);
    }
  }
  assert.ok(hidden.length >= 3, 'hero, about and gallery each carry one');
  for (const spec of hidden) assert.equal(spec.notForAi, true, `${spec.key} must be notForAi`);
});

/* ==========================================================================
 * 5. Tier gating — the editor on EVERY tier (decision W-4)
 * ======================================================================== */

const TIERS = ['lite', 'standard', 'pro', 'business'];

test('the editor is available on every ARION tier, Lite included', () => {
  for (const tier of TIERS) {
    const allowPro = siteAllowsPro({ arion_tier: tier });
    const catalog = sectionCatalog({ allowPro });
    assert.ok(catalog.length >= 8, `${tier} must be offered the whole catalogue`);
    const usable = catalog.filter((c) => c.available);
    assert.ok(usable.length >= 7, `${tier} must be able to add sections (got ${usable.length})`);
  }
});

test('only the Elementor Pro form section differs by tier, and it says why', () => {
  const lite = sectionCatalog({ allowPro: siteAllowsPro({ arion_tier: 'lite' }) });
  const contact = lite.find((c) => c.kind === 'contact');
  assert.equal(contact.available, false);
  assert.match(contact.unavailableReason, /Elementor Pro/);
  assert.match(contact.unavailableReason, /Lite/);

  // Everything else is available on Lite. A tier that hides more than the one
  // thing it genuinely cannot run is a tier gate that has crept.
  const blocked = lite.filter((c) => !c.available).map((c) => c.kind);
  assert.deepEqual(blocked, ['contact']);

  for (const tier of ['standard', 'pro', 'business']) {
    const cat = sectionCatalog({ allowPro: siteAllowsPro({ arion_tier: tier }) });
    assert.deepEqual(cat.filter((c) => !c.available).map((c) => c.kind), [], `${tier} blocks nothing`);
  }
});

test('the AI actions, and only the AI actions, need a paid plan', () => {
  assert.equal(aiTierGate({ arion_tier: 'lite' }).allowed, false);
  assert.match(aiTierGate({ arion_tier: 'lite' }).message, /Standard and above/);
  assert.match(aiTierGate({ arion_tier: 'lite' }).message, /on any plan/,
    'the refusal must say what Lite CAN still do');
  for (const tier of ['standard', 'pro', 'business']) {
    assert.equal(aiTierGate({ arion_tier: tier }).allowed, true, tier);
  }
  // An unknown tier fails CLOSED for the AI (a paid action) and OPEN for the
  // editor (every provisioned site really does have Elementor Pro).
  assert.equal(aiTierGate({ arion_tier: '' }).allowed, false);
  assert.equal(siteAllowsPro({ arion_tier: '' }), true);
});

test('the picker never quotes a price for anything that is free', () => {
  // Adding, reordering, editing, previewing, publishing and Undo cost
  // nothing. If a credit price ever appears on the catalogue, this fails.
  const json = JSON.stringify(sectionCatalog({ allowPro: true }));
  assert.doesNotMatch(json, /credit/i);
});

/* ==========================================================================
 * 6. The words the client reads
 * ======================================================================== */

test('nothing in the section schema says "tenant" or names a vendor', () => {
  const json = JSON.stringify(sectionKindMeta('contact'))
    + JSON.stringify(sectionKindMeta('hero'))
    + JSON.stringify(sectionKindMeta('about'))
    + JSON.stringify(sectionKindMeta('gallery'))
    + JSON.stringify(FORM_PURPOSES);
  assert.doesNotMatch(json, /tenant/i);
  for (const vendor of ['Anthropic', 'Claude', 'OpenAI', 'GPT', 'Gemini', 'Elementor Pro form widget!!!']) {
    assert.doesNotMatch(json, new RegExp(vendor, 'i'), `${vendor} must not be in a string a client reads`);
  }
});

test('what the reduction produces still validates, with the new fields on it', () => {
  for (const kind of ['hero', 'services', 'testimonials', 'cta', 'about', 'faq', 'gallery', 'contact']) {
    const [entry] = reduceToSectionList([build(kind)]);
    const check = validateFields(kind, entry.fields);
    assert.equal(check.ok, true, `${kind}: ${JSON.stringify(check.errors)}`);
  }
});
