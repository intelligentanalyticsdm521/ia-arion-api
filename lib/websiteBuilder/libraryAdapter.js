/**
 * Curated section library → the section-list editor.
 * ---------------------------------------------------------------------------
 * SCOPE_ARION_SITE_BUILDER_2026-09-05 §3.2/§3.3, Phase 1B step 3.
 *
 * THE PROBLEM
 *
 * There are 120 hand-authored Elementor sections in the curated library (12
 * archetypes × 10 variants, `arion.section_library` + blob, migration 029).
 * Phase 1A deliberately kept every one of them out of the "Add a section"
 * picker, because the editor can only edit a section whose widgets carry an
 * `_ia_field` stamp, and a library blueprint carries none. Offering one would
 * have handed a client a section they could then never change — which is the
 * exact complaint the whole feature exists to answer.
 *
 * THE RULE
 *
 * A blueprint is offered ONLY when this adapter can stamp it so that the
 * editor can edit it afterwards. "Can edit it afterwards" is not a guess: the
 * adapter stamps, reads the fields straight back out through the ordinary
 * `extractFields`, and requires that every field the schema marks REQUIRED
 * comes back with a value. If it does not, the blueprint stays out of the
 * picker and says why.
 *
 * Two extra refusals, both learned rather than invented:
 *
 *   1. AN UNSTAMPED BUTTON OR FORM BLOCKS THE WHOLE BLUEPRINT.
 *      A heading nobody can edit is a wart. A BUTTON whose text and
 *      destination nobody can edit, or a FORM whose recipient nobody can set,
 *      is a reason to open WordPress — and closing that hatch is the point of
 *      the feature. Decorative widgets we cannot map (a stat number, a spacer,
 *      a divider) ride along untouched and are fine.
 *
 *   2. A COMPOSED BINDING ONLY STAMPS WHEN IT ALREADY ROUND-TRIPS.
 *      `testimonials.items` and the gallery store several values inside one
 *      widget's markup. Writing one back re-encodes that markup from scratch.
 *      If the library's own markup does not decode-and-re-encode to itself,
 *      stamping it would mean the client's first save silently rebuilds the
 *      card and loses the layout. So the adapter proves byte-equivalence
 *      first and refuses the blueprint when it fails.
 *
 * WHAT THIS FILE NEVER DOES
 *
 * It does not rewrite a library section's design. Colours, spacing,
 * typography, background — every setting the blueprint carries is left
 * exactly as authored. All it adds is `settings._ia_field` markers and the
 * `ia:` handle on the container's `_title`, so the section the client gets is
 * the section Brandon drew.
 */

import {
  BINDINGS, sectionKindMeta, extractFields, validateFields, listSectionKinds,
  decodeTestimonialCard, encodeTestimonialCard, cssClassFromPurpose,
  decodePricingCard, encodePricingCard,
} from './sectionSchema.js';

/* ==========================================================================
 * Archetype → the editor kind that can edit it
 *
 * The library's 12 archetypes and the editor's 8 kinds are different
 * vocabularies drawn a year apart. Five library archetypes (pricing, team,
 * stats, header, footer) have no editor kind at all, and the editor's
 * `gallery` has no library archetype. Those gaps are stated, not hidden —
 * a picker that silently drops an option is indistinguishable from a bug.
 * ======================================================================== */

export const LIBRARY_KIND_BY_ARCHETYPE = Object.freeze({
  hero:         'hero',
  features:     'services',      // a row of icon-box cards is what "What you do" is
  cta:          'cta',
  about:        'about',
  faq:          'faq',
  contact:      'contact',
  testimonials: 'testimonials',
  // ARION pack 2 — the three that had no editor kind at all. A blueprint is
  // still offered ONLY when the stamp plan below can make it editable
  // afterwards, so a layout drawn with widgets these plans do not name stays
  // out of the picker WITH its reason, exactly as before.
  pricing:      'pricing',
  team:         'team',
  stats:        'stats',
});

/** Why an archetype has no editor kind — shown in the coverage report. */
export const ARCHETYPES_WITHOUT_A_KIND = Object.freeze({
  // Pricing, team and stats got their editor kinds in ARION pack 2 and are in
  // LIBRARY_KIND_BY_ARCHETYPE above.
  header:  'Your header is not part of a page — it is the same on every page, so it is set under Website → Brand and layout.',
  footer:  'Your footer is not part of a page — it is the same on every page, so it is set under Website → Brand and layout.',
});

/** Widgets a visitor uses. One of these left unstamped fails the blueprint. */
const INTERACTIVE_WIDGETS = Object.freeze(new Set(['button', 'form']));

/** Bindings whose write path rebuilds markup, so they must round-trip first. */
const COMPOSED_BINDINGS = Object.freeze(new Set(['testimonial_card', 'pricing_card', 'gallery']));

/* ==========================================================================
 * Walking a blueprint
 * ======================================================================== */

function walkWidgets(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.elType === 'widget') out.push(node);
  if (Array.isArray(node.elements)) node.elements.forEach((c) => walkWidgets(c, out));
  return out;
}

const HEADING_RANK = { h1: 6, h2: 5, h3: 4, h4: 3, h5: 2, h6: 1 };

function fontSizeOf(widget) {
  const n = Number(widget?.settings?.typography_font_size?.size);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Which heading is the section's headline?
 *
 * By tag first (an h1 beats an h2 beats an eyebrow h6), then by type size
 * within the same tag. Tag before size on purpose: a hero's eyebrow is a
 * small h6 and a stats band's number is a huge h2, so size alone picks the
 * wrong one in both directions, while the tag the author chose is the tag
 * they meant.
 */
export function pickHeadline(headings) {
  if (!headings.length) return null;
  let best = headings[0];
  let bestRank = HEADING_RANK[String(best.settings?.header_size || '').toLowerCase()] ?? 0;
  let bestSize = fontSizeOf(best);
  for (const h of headings.slice(1)) {
    const rank = HEADING_RANK[String(h.settings?.header_size || '').toLowerCase()] ?? 0;
    const size = fontSizeOf(h);
    if (rank > bestRank || (rank === bestRank && size > bestSize)) {
      best = h; bestRank = rank; bestSize = size;
    }
  }
  return best;
}

/* ==========================================================================
 * The stamp plan — per editor kind, which widget gets which binding
 *
 * Each entry names a widgetType, how many of them the binding takes ('one' or
 * 'all'), and the binding id. Order matters: within a widgetType the first
 * unclaimed widget in document order wins, which is why `about` lists
 * subheadline before story.
 * ======================================================================== */

const STAMP_PLANS = Object.freeze({
  hero: [
    { widget: 'heading',     take: 'headline', binding: 'hero.headline' },
    { widget: 'text-editor', take: 'one',      binding: 'hero.subheadline' },
    { widget: 'button',      take: 'one',      binding: 'hero.cta' },
  ],
  services: [
    { widget: 'heading',     take: 'headline', binding: 'services.headline' },
    { widget: 'text-editor', take: 'one',      binding: 'services.subheadline' },
    { widget: 'icon-box',    take: 'all',      binding: 'services.items' },
  ],
  cta: [
    { widget: 'heading',     take: 'headline', binding: 'cta.headline' },
    { widget: 'text-editor', take: 'one',      binding: 'cta.subheadline' },
    { widget: 'button',      take: 'one',      binding: 'cta.primary' },
    { widget: 'button',      take: 'one',      binding: 'cta.secondary' },
  ],
  about: [
    { widget: 'heading',     take: 'headline', binding: 'about.headline' },
    { widget: 'text-editor', take: 'one',      binding: 'about.subheadline' },
    { widget: 'text-editor', take: 'one',      binding: 'about.story' },
    { widget: 'image',       take: 'one',      binding: 'about.image' },
    { widget: 'icon-box',    take: 'all',      binding: 'about.values' },
  ],
  faq: [
    { widget: 'heading',     take: 'headline', binding: 'faq.headline' },
    { widget: 'text-editor', take: 'one',      binding: 'faq.subheadline' },
    { widget: 'accordion',   take: 'one',      binding: 'faq.items' },
  ],
  gallery: [
    { widget: 'heading',       take: 'headline', binding: 'gallery.headline' },
    { widget: 'text-editor',   take: 'one',      binding: 'gallery.subheadline' },
    { widget: 'image-gallery', take: 'one',      binding: 'gallery.items' },
  ],
  contact: [
    { widget: 'heading',     take: 'headline', binding: 'contact.headline' },
    { widget: 'text-editor', take: 'one',      binding: 'contact.subheadline' },
    { widget: 'icon-list',   take: 'one',      binding: 'contact.methods' },
    { widget: 'form',        take: 'one',      binding: 'contact.form' },
  ],
  testimonials: [
    { widget: 'heading',     take: 'headline', binding: 'testimonials.headline' },
    { widget: 'text-editor', take: 'one',      binding: 'testimonials.subheadline' },
    { widget: 'text-editor', take: 'all',      binding: 'testimonials.items' },
  ],
  // Pricing is the testimonials shape: the subheadline claims the first
  // text-editor, the cards claim the rest, and the composed-card round-trip
  // check below decides whether a blueprint survives. A hand-drawn price card
  // built from a heading + a heading + a button does NOT round-trip our card
  // markup, so it is refused with its reason rather than silently rebuilt on
  // the client's first save — which is the rule this whole file exists for.
  pricing: [
    { widget: 'heading',     take: 'headline', binding: 'pricing.headline' },
    { widget: 'text-editor', take: 'one',      binding: 'pricing.subheadline' },
    { widget: 'text-editor', take: 'all',      binding: 'pricing.plans' },
  ],
  team: [
    { widget: 'heading',     take: 'headline', binding: 'team.headline' },
    { widget: 'text-editor', take: 'one',      binding: 'team.subheadline' },
    { widget: 'image-box',   take: 'all',      binding: 'team.members' },
  ],
  stats: [
    { widget: 'heading',     take: 'headline', binding: 'stats.headline' },
    { widget: 'text-editor', take: 'one',      binding: 'stats.subheadline' },
    { widget: 'counter',     take: 'all',      binding: 'stats.items' },
  ],
});

/* ==========================================================================
 * Stamping
 * ======================================================================== */

function deepClone(node) {
  return JSON.parse(JSON.stringify(node));
}

/**
 * Does this widget's existing markup survive a decode → encode round trip?
 * Only asked of the composed bindings, where the write path rebuilds markup
 * from the decoded values rather than patching a single setting.
 */
function composedRoundTrips(binding, widget) {
  try {
    if (binding.composed === 'testimonial_card') {
      // The schema's own codecs, so there is one implementation of the card
      // markup rather than a second copy that can drift from it.
      const current = widget?.settings?.[binding.setting];
      if (typeof current !== 'string' || !current.trim()) return false;
      return encodeTestimonialCard(decodeTestimonialCard(current)).trim() === current.trim();
    }
    if (binding.composed === 'pricing_card') {
      const current = widget?.settings?.[binding.setting];
      if (typeof current !== 'string' || !current.trim()) return false;
      return encodePricingCard(decodePricingCard(current)).trim() === current.trim();
    }
    if (binding.composed === 'gallery') {
      return Array.isArray(widget?.settings?.gallery) && widget.settings.gallery.length > 0;
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * Stamp one library blueprint so the editor can read and write it.
 *
 * @param {object} sectionJson  the blueprint's Elementor container, as authored
 * @param {object} opts
 * @param {string} opts.kind        the editor kind (from LIBRARY_KIND_BY_ARCHETYPE)
 * @param {string} opts.blueprintId e.g. "hero.gradient-dual-cta.v1"
 * @param {object} [opts.brand]     brandContext — supplies the one thing a
 *   library form does not carry: who the enquiry is emailed to. The scratch
 *   contact emitter already refuses to build a form it cannot address
 *   (elementorAdapter), and a library form is held to the same bar.
 * @returns {{ ok:boolean, reason?:string, detail?:string, node?:object, fields?:object,
 *             stamped?:string[], unmapped?:string[] }}
 */
export function stampLibrarySection(sectionJson, { kind, blueprintId, brand = null }) {
  const meta = sectionKindMeta(kind);
  if (!meta) return { ok: false, reason: 'unknown_kind', detail: `No editor section called "${kind}".` };
  const plan = STAMP_PLANS[kind];
  if (!plan) return { ok: false, reason: 'no_stamp_plan', detail: `No mapping written for "${kind}" yet.` };
  if (!sectionJson || typeof sectionJson !== 'object') {
    return { ok: false, reason: 'not_a_section', detail: 'That blueprint is not an Elementor container.' };
  }

  const node = deepClone(sectionJson);
  const widgets = walkWidgets(node);
  const claimed = new Set();
  const stamped = [];

  for (const step of plan) {
    const binding = BINDINGS[step.binding];
    if (!binding) continue;
    const candidates = widgets.filter((w) => w.widgetType === step.widget && !claimed.has(w));
    if (candidates.length === 0) continue;

    if (step.take === 'all') {
      if (COMPOSED_BINDINGS.has(binding.composed) && !candidates.every((w) => composedRoundTrips(binding, w))) {
        // Leave them unclaimed: the required-field check below will decide
        // whether the blueprint survives without them.
        continue;
      }
      for (const w of candidates) {
        w.settings = { ...(w.settings || {}), _ia_field: step.binding };
        claimed.add(w);
      }
      stamped.push(step.binding);
      continue;
    }

    // A `take: 'one'` step must never eat the LAST widget of a type a later
    // `take: 'all'` step needs. A pricing or testimonials section drawn with
    // no supporting line has exactly one text-editor - the card - and the
    // subheadline step used to claim it, leaving the cards unstamped and the
    // whole blueprint refused for a missing required field. Found by stamping
    // our own emitted section, which is the cheapest blueprint there is.
    const laterAllNeeds = plan
      .slice(plan.indexOf(step) + 1)
      .some((s) => s.widget === step.widget && s.take === 'all');
    if (laterAllNeeds && candidates.length <= 1) continue;

    const chosen = step.take === 'headline' ? pickHeadline(candidates) : candidates[0];
    if (!chosen) continue;
    if (COMPOSED_BINDINGS.has(binding.composed) && !composedRoundTrips(binding, chosen)) continue;
    chosen.settings = { ...(chosen.settings || {}), _ia_field: step.binding };
    claimed.add(chosen);
    stamped.push(step.binding);
  }

  // A library form carries its fields and its button text but no recipient
  // and no purpose class — the two things the plugin's interceptor and the
  // owner's inbox actually depend on (class-ia-form-interceptor.php:127, and
  // the empty `email_to` defect in SCOPE §2.5). Seed them from the business's
  // own details so the section arrives wired, and let the client change both
  // in the edit sheet afterwards.
  if (kind === 'contact') {
    const formWidget = widgets.find((w) => w.settings?._ia_field === 'contact.form');
    if (formWidget) {
      const email = String(brand?.email || '').trim();
      if (!email) {
        return {
          ok: false,
          reason: 'no_notification_email',
          detail: 'This layout has an enquiry form and we do not yet know which inbox to send enquiries to. Add your business email under Settings first.',
        };
      }
      formWidget.settings = {
        ...formWidget.settings,
        email_to: formWidget.settings.email_to || email,
        form_css_class: formWidget.settings.form_css_class || cssClassFromPurpose('lead'),
      };
    }
  }

  // The hero's picture is the container's own background, not a widget.
  if (kind === 'hero' && node.settings?.background_image?.url) {
    node.settings = { ...node.settings, _ia_field_section: 'hero.background' };
    stamped.push('hero.background');
  }

  // A visitor-facing control nobody can edit is a reason to open WordPress.
  const unmapped = widgets
    .filter((w) => !claimed.has(w) && INTERACTIVE_WIDGETS.has(String(w.widgetType)))
    .map((w) => String(w.widgetType));
  if (unmapped.length > 0) {
    return {
      ok: false,
      reason: 'unmapped_control',
      detail: `This layout has ${unmapped.length} ${unmapped[0] === 'form' ? 'form' : 'button'}${unmapped.length > 1 ? 's' : ''} the editor could not take charge of.`,
      unmapped,
    };
  }

  // The handle. `ia:<kind>:<blueprintId>:-` — the blueprint id is kept so a
  // page can still be traced back to the variant it was built from.
  node.settings = { ...(node.settings || {}), _title: `ia:${kind}:${blueprintId || 'library'}:-` };

  // Prove it: read the fields back out through the ordinary path and require
  // every REQUIRED one. Anything less and the client gets a section they
  // cannot finish filling in.
  const fields = extractFields(node, kind);
  const check = validateFields(kind, fields);
  const missing = check.errors.filter((e) => /cannot be empty/.test(e.message)).map((e) => e.message);

  // `validateFields` skips a list it was not given at all, which is right for
  // the edit sheet (an untouched list is not an empty one) and wrong here: a
  // list the adapter never stamped IS absent, and a testimonials section whose
  // quotes cannot be edited is exactly the section 1A refused to hand out.
  // So the substance of a section — any list it must have at least one of —
  // is required explicitly.
  for (const spec of meta.fields) {
    if (spec.type !== 'list' || !(spec.min >= 1)) continue;
    const value = fields[spec.key];
    if (Array.isArray(value) && value.length >= spec.min) continue;
    missing.push(`${spec.label} could not be matched to anything in this layout.`);
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'required_field_missing',
      detail: missing.join(' '),
      stamped,
    };
  }

  return { ok: true, node, fields, stamped, unmapped: [] };
}

/**
 * Can this blueprint go in the picker? Archetype gate first (cheap), then the
 * full stamp.
 *
 * @param {object} args
 * @param {string} args.archetype
 * @param {string} args.blueprintId
 * @param {object} args.sectionJson
 * @param {object} [args.brand]
 */
export function mapLibrarySection({ archetype, blueprintId, sectionJson, brand = null }) {
  const kind = LIBRARY_KIND_BY_ARCHETYPE[String(archetype || '').toLowerCase()];
  if (!kind) {
    return {
      ok: false,
      kind: null,
      reason: 'no_editor_kind',
      detail: ARCHETYPES_WITHOUT_A_KIND[String(archetype || '').toLowerCase()]
        || 'The editor has no section of that kind yet.',
    };
  }
  const stamped = stampLibrarySection(sectionJson, { kind, blueprintId, brand });
  return { ...stamped, kind };
}

/**
 * Coverage across a whole manifest — the number the walkthrough quotes.
 *
 * @param {Array<{blueprint_id:string, archetype:string, sectionJson:object}>} rows
 * @returns {{ total:number, pickable:number, byArchetype:object, refusals:object, rows:Array }}
 */
export function libraryCoverage(rows, { brand = null } = {}) {
  const byArchetype = {};
  const refusals = {};
  const out = [];
  let pickable = 0;

  for (const row of rows || []) {
    const archetype = String(row.archetype || String(row.blueprint_id || '').split('.')[0] || '');
    const result = mapLibrarySection({
      archetype, blueprintId: row.blueprint_id, sectionJson: row.sectionJson, brand,
    });
    byArchetype[archetype] = byArchetype[archetype] || { total: 0, pickable: 0 };
    byArchetype[archetype].total += 1;
    if (result.ok) {
      byArchetype[archetype].pickable += 1;
      pickable += 1;
    } else {
      refusals[result.reason] = (refusals[result.reason] || 0) + 1;
    }
    out.push({
      blueprint_id: row.blueprint_id,
      archetype,
      kind: result.kind,
      pickable: !!result.ok,
      reason: result.ok ? null : result.reason,
      detail: result.ok ? null : result.detail,
    });
  }

  return { total: (rows || []).length, pickable, byArchetype, refusals, rows: out };
}

/** Editor kinds with no library archetype behind them — stated, not hidden. */
export function kindsWithoutLibraryVariants() {
  const covered = new Set(Object.values(LIBRARY_KIND_BY_ARCHETYPE));
  return listSectionKinds().filter((k) => !covered.has(k));
}

export const __test__ = { walkWidgets, STAMP_PLANS, INTERACTIVE_WIDGETS, COMPOSED_BINDINGS, fontSizeOf };
