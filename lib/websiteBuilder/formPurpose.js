/**
 * What a form is FOR — one home, three keys, both form paths.
 * ---------------------------------------------------------------------------
 * D-156 conformance (BUILDER_WIDGET_CATALOG_2026-09-17 H.4 gap 10, audit point
 * 11). A form's PURPOSE decides how every enquiry from that page is filed, and
 * it was written down in three different ways by three different files:
 *
 *   · `containerEmitters.js` (the archetype path) wrote `form_css_class` only;
 *   · `elementorWidgets.js`  (the tree path)      wrote nothing at all;
 *   · `elementorAdapter.js`  and `sectionSchema.js` each kept their OWN
 *     purpose → class table, and they did not hold the same keys.
 *
 * So a client's submissions were typed or not depending on which door they
 * built the form through. This module is the one home. Every writer calls
 * `formPurposeSettings()` and every reader calls `formPurposeOf()`.
 *
 * ── THE THREE KEYS, AND WHY THREE ─────────────────────────────────────────
 *   `_ia_form_purpose`  OURS, and the one the next plugin release reads
 *                       (D-159). A word — `lead` — not a class name, because
 *                       the purpose is a fact about the form and a class is
 *                       one way of carrying it.
 *   `form_css_class`    the LEGACY alias. The plugin's form interceptor types
 *                       every submission from it today, so it keeps being
 *                       written, byte for byte as before, until the release
 *                       that reads the key above. Pages already published are
 *                       read through it too.
 *   `_css_classes`      the page engine's own Advanced-tab CSS-classes key for
 *                       a WIDGET (`common` element stack — the catalogue's
 *                       A.1 Advanced table; a CONTAINER spells the same thing
 *                       `css_classes`). Without it the class never reaches the
 *                       markup, so nothing on the page can be styled or
 *                       targeted by purpose.
 *
 * DELETE-ME NOTE: when the plugin release that reads `_ia_form_purpose` ships
 * (D-159, spec in D156_CONFORMANCE_HANDOFF_2026-09-17.md), drop
 * `form_css_class` from `formPurposeSettings` and from `formPurposeOf`'s
 * fallback — in that order, a release apart, so a site running the old plugin
 * is never left with an untyped form.
 *
 * No imports: this module is read by `containerEmitters.js`,
 * `elementorAdapter.js`, `sectionSchema.js` and `elementorWidgets.js`, and the
 * first three already sit in one import cycle (see elementorIds.js for the
 * same reason).
 */

/** The settings key that holds the purpose itself. */
export const FORM_PURPOSE_KEY = '_ia_form_purpose';
/** The legacy alias the plugin's interceptor reads today. */
export const FORM_PURPOSE_CLASS_KEY = 'form_css_class';
/** The page engine's own CSS-classes key on a widget's Advanced tab. */
export const CSS_CLASSES_KEY = '_css_classes';

/**
 * What a client may pick, and the words they read. The editor's
 * "What is this form for?" renders from this list (`sectionSchema.js`).
 */
export const FORM_PURPOSES = Object.freeze([
  { value: 'lead', label: 'Contact' },
  { value: 'quote', label: 'Quote request' },
  { value: 'booking', label: 'Booking request' },
  { value: 'newsletter', label: 'Newsletter' },
]);

/**
 * The interceptor's own token table, mirrored — these strings are the routing
 * wire (ia-plugin `intelligent-analytics.php`, the form interceptor's map).
 * `contact` is an INPUT spelling, never an output: a contact-form submission
 * IS a lead, and two words for one thing is how the two tables came to
 * disagree in the first place.
 */
const CLASS_FROM_PURPOSE = Object.freeze({
  lead: 'ia-lead',
  contact: 'ia-lead',
  quote: 'ia-quote',
  booking: 'ia-booking',
  newsletter: 'ia-newsletter',
});

const PURPOSE_FROM_CLASS = Object.freeze({
  'ia-lead': 'lead',
  'ia-contact': 'lead',
  'ia-quote': 'quote',
  'ia-booking': 'booking',
  'ia-newsletter': 'newsletter',
});

/**
 * The purpose, as one of the words above.
 *
 * An unknown purpose becomes `lead`, deliberately: an UNTYPED form is the
 * defect this file exists to stop, and a form filed as a lead is at worst
 * imprecise and still reaches somebody.
 */
export function normalizeFormPurpose(purpose) {
  const key = String(purpose == null ? '' : purpose).trim().toLowerCase();
  if (key === 'contact') return 'lead';
  return CLASS_FROM_PURPOSE[key] ? key : 'lead';
}

/** The class that types a form for the plugin's interceptor. */
export function cssClassFromPurpose(purpose) {
  return CLASS_FROM_PURPOSE[String(purpose == null ? '' : purpose).trim().toLowerCase()] || 'ia-lead';
}

/** Back the other way, for a page published before the purpose key existed. */
export function purposeFromCssClass(cls) {
  return PURPOSE_FROM_CLASS[String(cls || '').trim().toLowerCase()] || 'lead';
}

/** The class a purpose puts in the markup: `ia-form-lead`. */
export function markupClassFromPurpose(purpose) {
  return `ia-form-${normalizeFormPurpose(purpose)}`;
}

/**
 * THE THREE KEYS EVERY FORM WE WRITE CARRIES.
 *
 * Spread into a form widget's settings by every writer, so the archetype path
 * and the tree path type a submission identically — asserted by
 * `test/website-conformance-d156.test.mjs`.
 *
 * `_css_classes` keeps any classes already on the widget: it is the author's
 * field as well as ours, and writing over it would delete their styling.
 */
export function formPurposeSettings(purpose, existingCssClasses = '') {
  const p = normalizeFormPurpose(purpose);
  const mine = markupClassFromPurpose(p);
  const kept = String(existingCssClasses || '')
    .split(/\s+/)
    .filter((c) => c && c !== mine && !/^ia-form-/.test(c));
  return {
    [FORM_PURPOSE_KEY]: p,
    [FORM_PURPOSE_CLASS_KEY]: cssClassFromPurpose(p),
    [CSS_CLASSES_KEY]: [...kept, mine].join(' '),
  };
}

/**
 * What a form ALREADY on a page is for.
 *
 * PRESENCE of our own key first, the legacy class second — never the absence
 * of either (`reference_absence_based_guards_fail_open`): a page published
 * before this key existed still answers correctly through the class, and a
 * page with neither answers `lead`, which is where an untyped enquiry has
 * always gone.
 */
export function formPurposeOf(settings) {
  const s = settings || {};
  const own = s[FORM_PURPOSE_KEY];
  if (own && CLASS_FROM_PURPOSE[String(own).trim().toLowerCase()]) return normalizeFormPurpose(own);
  return purposeFromCssClass(s[FORM_PURPOSE_CLASS_KEY]);
}

/** Did this form come off a page that says what it is for at all? */
export function hasFormPurpose(settings) {
  const s = settings || {};
  return !!(s[FORM_PURPOSE_KEY] || s[FORM_PURPOSE_CLASS_KEY]);
}

export const __test__ = { CLASS_FROM_PURPOSE, PURPOSE_FROM_CLASS };

export default {
  FORM_PURPOSES, FORM_PURPOSE_KEY, FORM_PURPOSE_CLASS_KEY, CSS_CLASSES_KEY,
  normalizeFormPurpose, cssClassFromPurpose, purposeFromCssClass,
  markupClassFromPurpose, formPurposeSettings, formPurposeOf, hasFormPurpose,
};
