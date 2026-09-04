/**
 * The curated library in the picker — and, more importantly, the ones kept out.
 *
 * Phase 1A's rule was "never give a client a section they cannot edit". This
 * file is that rule with teeth: a blueprint is offered only when the adapter
 * can stamp it AND the ordinary read path can then read every required field
 * back out of it. Every refusal below is a blueprint that would otherwise have
 * shipped as a section the owner could look at and not change.
 *
 * The real 120-section export is used when it is on the machine (it is
 * Brandon's own authoring file, not client data and not prod storage); the
 * synthetic fixtures below run everywhere and carry the actual rules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  mapLibrarySection, stampLibrarySection, libraryCoverage, pickHeadline,
  LIBRARY_KIND_BY_ARCHETYPE, ARCHETYPES_WITHOUT_A_KIND, kindsWithoutLibraryVariants,
} from '../lib/websiteBuilder/libraryAdapter.js';
import { extractFields, applyFields, reduceToSectionList } from '../lib/websiteBuilder/sectionSchema.js';
import { __test__ as catalogInternals } from '../lib/websiteBuilder/libraryCatalog.js';
import { __test__ as routeInternals } from '../routes/arion/pages.js';

const BRAND = Object.freeze({ email: 'owner@example.invalid', business_name: 'Fernbrook' });

/* ── the shape a library blueprint really has: containers, not sections ── */

const widget = (id, widgetType, settings) => ({ id, elType: 'widget', widgetType, settings });
const container = (id, settings, elements) => ({ id, elType: 'container', settings, elements });

function heroBlueprint(extra = []) {
  return container('c1', {
    background_background: 'classic', background_color: '#0E1A2B',
    padding: { unit: 'px', top: '110' }, _title: 'hero.centered-dual-cta.v1',
  }, [
    widget('h6', 'heading', { title: 'TRUSTED BY 400 HOMES', header_size: 'h6', typography_font_size: { size: 14 } }),
    widget('h1', 'heading', { title: 'Bespoke joinery', header_size: 'h1', typography_font_size: { size: 52 } }),
    widget('t2', 'text-editor', { editor: '<p>Made in the workshop.</p>' }),
    widget('b3', 'button', { text: 'Get a quote', link: { url: '#contact' } }),
    ...extra,
  ]);
}

function featuresBlueprint() {
  return container('c1', { _title: 'features.3col-iconbox.v1' }, [
    widget('h1', 'heading', { title: 'What we do', header_size: 'h2' }),
    container('row', { flex_direction: 'row' }, [
      container('cc1', { padding: { top: '20' } }, [widget('i1', 'icon-box', { title_text: 'Fitting', description_text: 'a', selected_icon: { value: 'fas fa-check' } })]),
      container('cc2', { padding: { top: '20' } }, [widget('i2', 'icon-box', { title_text: 'Design', description_text: 'b', selected_icon: { value: 'fas fa-pen' } })]),
    ]),
  ]);
}

/* ==========================================================================
 * The archetype gate
 * ======================================================================== */

test('five library archetypes have no editor kind, and say why', () => {
  for (const archetype of ['pricing', 'team', 'stats', 'header', 'footer']) {
    assert.equal(LIBRARY_KIND_BY_ARCHETYPE[archetype], undefined);
    const out = mapLibrarySection({ archetype, blueprintId: `${archetype}.x.v1`, sectionJson: heroBlueprint() });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'no_editor_kind');
    assert.equal(out.detail, ARCHETYPES_WITHOUT_A_KIND[archetype]);
    // The reason is written for a person, not a log file.
    assert.doesNotMatch(out.detail, /null|undefined|_ia_field|elType/);
  }
});

test('the editor kind with no library behind it is named, not hidden', () => {
  assert.deepEqual(kindsWithoutLibraryVariants(), ['gallery']);
});

/* ==========================================================================
 * Stamping, and what it does not do
 * ======================================================================== */

test('a hero blueprint is stamped and reads back through the ordinary path', () => {
  const out = mapLibrarySection({
    archetype: 'hero', blueprintId: 'hero.centered-dual-cta.v1', sectionJson: heroBlueprint(), brand: BRAND,
  });
  assert.equal(out.ok, true);
  assert.equal(out.kind, 'hero');
  assert.equal(out.node.settings._title, 'ia:hero:hero.centered-dual-cta.v1:-');

  const [row] = reduceToSectionList([out.node]);
  assert.equal(row.editable, true);
  assert.equal(row.kind, 'hero');
  assert.equal(row.blueprintId, 'hero.centered-dual-cta.v1');
  assert.equal(row.fields.headline, 'Bespoke joinery');
  assert.equal(row.fields.subheadline, 'Made in the workshop.');
  assert.equal(row.fields.cta_text, 'Get a quote');
});

test('the headline is the h1, not the eyebrow above it and not the biggest number', () => {
  const headings = [
    widget('a', 'heading', { title: 'EYEBROW', header_size: 'h6', typography_font_size: { size: 14 } }),
    widget('b', 'heading', { title: 'The real one', header_size: 'h1', typography_font_size: { size: 46 } }),
    widget('c', 'heading', { title: '98%', header_size: 'h2', typography_font_size: { size: 64 } }),
  ];
  assert.equal(pickHeadline(headings).settings.title, 'The real one');
  // Within one tag, size breaks the tie.
  assert.equal(pickHeadline([
    widget('a', 'heading', { title: 'small', header_size: 'h2', typography_font_size: { size: 20 } }),
    widget('b', 'heading', { title: 'big', header_size: 'h2', typography_font_size: { size: 40 } }),
  ]).settings.title, 'big');
  assert.equal(pickHeadline([]), null);
});

test('stamping changes markers and the handle, and nothing a designer chose', () => {
  const before = heroBlueprint();
  const beforeJson = JSON.stringify(before);
  const out = stampLibrarySection(before, { kind: 'hero', blueprintId: 'hero.x.v1', brand: BRAND });
  assert.equal(out.ok, true);
  // The input is never mutated.
  assert.equal(JSON.stringify(before), beforeJson);
  // Every design setting survives on the container.
  assert.equal(out.node.settings.background_color, '#0E1A2B');
  assert.deepEqual(out.node.settings.padding, { unit: 'px', top: '110' });
  // And on the widgets: only `_ia_field` was added.
  const h1 = out.node.elements.find((e) => e.settings?.title === 'Bespoke joinery');
  assert.equal(h1.settings.header_size, 'h1');
  assert.deepEqual(h1.settings.typography_font_size, { size: 52 });
  assert.equal(h1.settings._ia_field, 'hero.headline');
});

test('a second button on a hero blocks the whole blueprint', () => {
  // The hero has one CTA binding. A second button would be a control the
  // client can see and cannot change, which is a reason to open WordPress.
  const out = mapLibrarySection({
    archetype: 'hero', blueprintId: 'hero.dual.v1', brand: BRAND,
    sectionJson: heroBlueprint([widget('b4', 'button', { text: 'Learn more', link: { url: '#' } })]),
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'unmapped_control');
  assert.match(out.detail, /button/);
});

test('a form the editor cannot address blocks the blueprint', () => {
  const out = mapLibrarySection({
    archetype: 'hero', blueprintId: 'hero.leadcapture-form.v1', brand: BRAND,
    sectionJson: container('c1', { _title: 'x' }, [
      widget('h1', 'heading', { title: 'Get a quote', header_size: 'h1' }),
      widget('f1', 'form', { form_name: 'Lead', form_fields: [] }),
    ]),
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'unmapped_control');
  assert.match(out.detail, /form/);
});

test('a decorative widget the editor cannot map is fine — it rides along', () => {
  const out = mapLibrarySection({
    archetype: 'hero', blueprintId: 'hero.split-image-text.v1', brand: BRAND,
    sectionJson: container('c1', { _title: 'x' }, [
      widget('im', 'image', { image: { url: 'https://x.invalid/a.jpg' } }),   // no hero binding
      widget('h1', 'heading', { title: 'Bespoke joinery', header_size: 'h1' }),
      widget('t2', 'text-editor', { editor: '<p>Sub.</p>' }),
      widget('b3', 'button', { text: 'Go', link: { url: '#' } }),
    ]),
  });
  assert.equal(out.ok, true);
  // Untouched: it still has no marker, and it is still in the tree.
  const image = out.node.elements.find((e) => e.widgetType === 'image');
  assert.equal(image.settings._ia_field, undefined);
  assert.equal(image.settings.image.url, 'https://x.invalid/a.jpg');
});

test('a section whose substance cannot be mapped is refused, not half-offered', () => {
  // A testimonials layout built as separate heading/quote widgets rather than
  // the composed card the write path re-encodes. Stamping it would mean the
  // client's first save rebuilt the card and lost the layout.
  const out = mapLibrarySection({
    archetype: 'testimonials', blueprintId: 'testimonials.3col-cards.v1', brand: BRAND,
    sectionJson: container('c1', { _title: 'x' }, [
      widget('h1', 'heading', { title: 'What customers say', header_size: 'h2' }),
      widget('q1', 'text-editor', { editor: '<p>Lovely work.</p>' }),
      widget('n1', 'heading', { title: 'A. Customer', header_size: 'h4' }),
    ]),
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'required_field_missing');
  assert.match(out.detail, /Quotes could not be matched/);
});

test('a layout with no heading at all is refused', () => {
  const out = mapLibrarySection({
    archetype: 'features', blueprintId: 'features.centered-highlight.v1', brand: BRAND,
    sectionJson: container('c1', { _title: 'x' }, [
      widget('i1', 'icon-box', { title_text: 'One thing', description_text: 'd' }),
    ]),
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'required_field_missing');
  assert.match(out.detail, /Headline cannot be empty/);
});

test('a contact layout is refused until we know which inbox to notify', () => {
  const contact = container('c1', { _title: 'contact.centered-form.v1' }, [
    widget('h1', 'heading', { title: 'Get in touch', header_size: 'h2' }),
    widget('f1', 'form', {
      form_name: 'Contact', button_text: 'Send',
      form_fields: [{ custom_id: 'name', field_type: 'text', field_label: 'Name', _id: 'a' }],
    }),
  ]);
  const without = mapLibrarySection({ archetype: 'contact', blueprintId: 'contact.centered-form.v1', sectionJson: contact, brand: {} });
  assert.equal(without.ok, false);
  assert.equal(without.reason, 'no_notification_email');
  assert.match(without.detail, /Add your business email/);

  const withEmail = mapLibrarySection({ archetype: 'contact', blueprintId: 'contact.centered-form.v1', sectionJson: contact, brand: BRAND });
  assert.equal(withEmail.ok, true);
  // The two things the plugin's interceptor and the owner's inbox depend on.
  const form = withEmail.node.elements.find((e) => e.widgetType === 'form');
  assert.equal(form.settings.email_to, 'owner@example.invalid');
  assert.equal(form.settings.form_css_class, 'ia-lead');
  assert.equal(withEmail.fields.form_purpose, 'lead');
  assert.equal(withEmail.fields.email_to, 'owner@example.invalid');
});

/* ==========================================================================
 * Round trip — the reason any of this is allowed on a client's site
 * ======================================================================== */

test('a stamped library section survives an edit without drifting', () => {
  const out = mapLibrarySection({
    archetype: 'features', blueprintId: 'features.3col-iconbox.v1', sectionJson: featuresBlueprint(), brand: BRAND,
  });
  assert.equal(out.ok, true);

  const before = extractFields(out.node, 'services');
  assert.equal(before.services.length, 2);

  const patched = applyFields(out.node, 'services', { ...before, headline: 'What we actually do' });
  const after = extractFields(patched, 'services');
  assert.equal(after.headline, 'What we actually do');
  assert.deepEqual(after.services, before.services, 'nothing the client did not touch may move');
});

test('a new card clones the card wrapper, not just the widget', () => {
  // Every library section is flexbox containers; cloning only the icon-box
  // would drop the card's own padding and the fourth service would arrive
  // looking nothing like the first three.
  const out = mapLibrarySection({
    archetype: 'features', blueprintId: 'features.3col-iconbox.v1', sectionJson: featuresBlueprint(), brand: BRAND,
  });
  const fields = extractFields(out.node, 'services');
  const grown = applyFields(out.node, 'services', {
    ...fields, services: [...fields.services, { title: 'Repairs', description: 'c', icon_name: 'wrench' }],
  });
  const row = grown.elements.find((e) => e.elType === 'container' && (e.elements || []).length > 1);
  assert.equal(row.elements.length, 3);
  assert.ok(row.elements.every((c) => c.elType === 'container'), 'each card keeps its own wrapper');
  assert.deepEqual(row.elements[2].settings.padding, { top: '20' }, 'and the wrapper keeps its styling');
  assert.equal(extractFields(grown, 'services').services.length, 3);
});

test('the save path accepts a container as a top-level section', () => {
  // Library blueprints are `container`; sections we emit are `section`. Both
  // are legitimate top-level page nodes, and 1A only knew about the second.
  const { buildNodes } = routeInternals;
  const out = mapLibrarySection({
    archetype: 'hero', blueprintId: 'hero.x.v1', sectionJson: heroBlueprint(), brand: BRAND,
  });
  const [row] = reduceToSectionList([out.node]);
  const built = buildNodes([{ fields: row.fields, node: row.node }]);
  assert.deepEqual(built.errors, []);
  assert.equal(built.nodes.length, 1);
  assert.equal(built.nodes[0].node.elType, 'container');

  // And still refuses something that is neither.
  assert.equal(buildNodes([{ fields: {}, node: { elType: 'widget' } }]).errors.length, 1);
});

/* ==========================================================================
 * Coverage
 * ======================================================================== */

test('coverage counts what is pickable and why the rest is not', () => {
  const cov = libraryCoverage([
    { blueprint_id: 'hero.a.v1', archetype: 'hero', sectionJson: heroBlueprint() },
    { blueprint_id: 'features.a.v1', archetype: 'features', sectionJson: featuresBlueprint() },
    { blueprint_id: 'pricing.a.v1', archetype: 'pricing', sectionJson: heroBlueprint() },
  ], { brand: BRAND });

  assert.equal(cov.total, 3);
  assert.equal(cov.pickable, 2);
  assert.equal(cov.refusals.no_editor_kind, 1);
  assert.equal(cov.byArchetype.hero.pickable, 1);
  assert.equal(cov.byArchetype.pricing.pickable, 0);
});

const REAL_EXPORT = 'C:/Users/brand/Downloads/iadm-section-library.json';

test('the real 120-section library maps to exactly the coverage the walkthrough quotes', { skip: !fs.existsSync(REAL_EXPORT) && 'library export not on this machine' }, () => {
  const doc = JSON.parse(fs.readFileSync(REAL_EXPORT, 'utf8'));
  const rows = Object.entries(doc.sections).map(([blueprint_id, sectionJson]) => ({
    blueprint_id, archetype: blueprint_id.split('.')[0], sectionJson,
  }));
  const cov = libraryCoverage(rows, { brand: BRAND });

  assert.equal(cov.total, 120);
  // If this number moves, the walkthrough's "N of 120" is stale — re-run
  // scripts/_dev_library_coverage.mjs and update it in the same pass.
  assert.equal(cov.pickable, 44);
  assert.deepEqual(
    Object.fromEntries(Object.entries(cov.byArchetype).map(([a, n]) => [a, n.pickable])),
    {
      hero: 7, features: 7, cta: 9, about: 8, faq: 5, contact: 8, testimonials: 0,
      pricing: 0, team: 0, stats: 0, header: 0, footer: 0,
    },
  );

  // Every pickable one really does round-trip on a real client's page.
  for (const row of cov.rows.filter((r) => r.pickable)) {
    const mapped = mapLibrarySection({
      archetype: row.archetype, blueprintId: row.blueprint_id,
      sectionJson: doc.sections[row.blueprint_id], brand: BRAND,
    });
    const before = extractFields(mapped.node, mapped.kind);
    const patched = applyFields(mapped.node, mapped.kind, { ...before, headline: 'Edited' });
    const after = extractFields(patched, mapped.kind);
    assert.equal(after.headline, 'Edited', row.blueprint_id);
    for (const key of Object.keys(before)) {
      if (key === 'headline') continue;
      assert.deepEqual(after[key], before[key], `${row.blueprint_id}.${key} drifted`);
    }
    assert.equal(reduceToSectionList([patched])[0].editable, true, row.blueprint_id);
  }
});

/* ==========================================================================
 * The picker's own plumbing
 * ======================================================================== */

test('a variant key becomes something a person can read', () => {
  assert.equal(catalogInternals.prettyVariant('gradient-dual-cta'), 'Gradient dual cta');
  assert.equal(catalogInternals.prettyVariant('3col-iconbox'), '3col iconbox');
  assert.equal(catalogInternals.prettyVariant(''), '');
});

test('the catalogue fetches with a bound number of parallel reads', async () => {
  let live = 0;
  let peak = 0;
  const out = await catalogInternals.mapWithLimit(Array.from({ length: 25 }, (_, i) => i), 8, async (n) => {
    live += 1; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 1));
    live -= 1;
    return n * 2;
  });
  assert.equal(out.length, 25);
  assert.equal(out[24], 48);
  assert.ok(peak <= 8, `fetched ${peak} at once`);
});
