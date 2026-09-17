/**
 * Elementor adapter — block JSON → one Elementor CONTAINER section.
 * --------------------------------------------------------------------------
 * The block emitters produce a *semantic* shape (headline / subheadline /
 * services list / etc.). This adapter is the *block-level* converter: it takes
 * ONE block payload (validated by the emitter) and returns ONE section node,
 * drawn by `containerEmitters.js`. The page assembler array-wraps accepted
 * blocks into a page's `_elementor_data` in display order.
 *
 * Format reference (read off the page engine's own source on the dev site,
 * 2026-09-17, not guessed):
 *   - every node has id (7-char hex), elType, settings, elements;
 *   - a band is `elType: 'container'`, and so is every box inside it —
 *     `isInner` is what says which; a widget is `elType: 'widget'` with
 *     `widgetType` set;
 *   - ids are minted deterministically from the block's seed so re-applying
 *     one draft does not churn the page's revision history.
 *
 * A page the AUTHOR builds — boxes inside boxes, to any depth — is
 * `elementorTree.js`. This file stays the eleven archetypes' door.
 */

// ONE layout dialect (§2, closed by D-156). Every section we write comes out
// of here, and so do the two small helpers this file's `__test__` still hands
// to other tests — one implementation of each, never a copy.
import {
  CONTAINER_EMITTERS, useFormFieldHelpers, escapeHtml, mintId,
} from './containerEmitters.js';
// What a form is FOR — one home for the table, the codec and the three keys.
import { cssClassFromPurpose, __test__ as formPurposeTest } from './formPurpose.js';

/* ==========================================================================
 * Who does a generated form notify?
 * --------------------------------------------------------------------------
 * `email_to` used to be read from `brand.email` -- a key brandContext never
 * returned -- so EVERY AI-built contact form shipped with an empty
 * notification recipient. Capture into ARION still worked (the plugin's form
 * interceptor fires regardless), so the defect was silent: the owner simply
 * never heard about the lead. Evidence:
 * SCOPE_ARION_SITE_BUILDER_2026-09-05 section 2.5.
 *
 * brandContext now supplies `email`. A form we cannot address is a broken
 * deliverable, so the adapter REFUSES to build one instead of publishing a
 * dead form; the assembler turns that refusal into a skipped[] entry the
 * caller sees. There is deliberately no hardcoded fallback address -- mail to
 * the wrong inbox is worse than a refused build.
 * ======================================================================== */

/** Thrown when a form section cannot be given a notification recipient. */
export class FormRecipientError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FormRecipientError';
    this.code = 'form_recipient_missing';
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function firstEmail(candidates) {
  for (const raw of candidates) {
    const v = String(raw == null ? '' : raw).trim();
    if (EMAIL_RE.test(v)) return v;
  }
  return null;
}

/**
 * The tenant's own notification address first (brandContext.email --
 * questionnaire, signup session, or arion.tenant.primary_email), then the
 * email contact method this section's own copy already shows the visitor.
 *
 * @returns {string|null} a valid address, or null when none can be resolved
 */
export function resolveFormRecipient(brand, block) {
  const fromBrand = firstEmail([
    brand?.email,
    brand?.notification_email,
    brand?.contact_email,
  ]);
  if (fromBrand) return fromBrand;

  const methods = Array.isArray(block?.contact_methods) ? block.contact_methods : [];
  const fromBlock = [];
  for (const m of methods) {
    if (!m || m.kind !== 'email') continue;
    const href = String(m.href || '').trim();
    if (/^mailto:/i.test(href)) fromBlock.push(href.slice(7).split('?')[0]);
    fromBlock.push(m.value);
  }
  return firstEmail(fromBlock);
}

/* ==========================================================================
 * What KIND of form is this?
 * --------------------------------------------------------------------------
 * The plugin's form interceptor types every submission from the widget's
 * `form_css_class` (ia-plugin intelligent-analytics.php, process_submission()):
 *
 *   ia-booking -> booking | ia-quote -> quote | ia-newsletter -> newsletter
 *   ia-lead    -> lead    | ia-contact -> contact
 *
 * ...falling back to a substring of the form NAME when no class matches. We
 * never set the class, so no form we generated could be typed booking, quote
 * or lead -- every one of them landed as "contact" on the name fallback. This
 * is the wire the site builder must not cut
 * (SCOPE_ARION_SITE_BUILDER_2026-09-05 section 2.5).
 * ======================================================================== */

/**
 * The token table and the codec BOTH live in `formPurpose.js` now.
 *
 * This file kept its own copy and `sectionSchema.js` kept another, and the two
 * did not hold the same keys — one mechanism per concern, so there is now one
 * table, one class codec, and one writer of the three keys a form carries
 * (D-156 conformance, audit point 11). `formCssClassFor` stays as the name
 * this file's callers and tests already use.
 */
export const formCssClassFor = cssClassFromPurpose;

/**
 * An explicit purpose on the block wins (the section editor's "what is this
 * form for?" picker writes it); otherwise the section kind decides.
 */
function resolveFormPurpose(kind, block) {
  return block?.form_config?.purpose
      || block?.form_purpose
      || kind;
}

/* ==========================================================================
 * Section identity
 * --------------------------------------------------------------------------
 * Migration 029:14 establishes the convention -- the blueprint id "is set on
 * each section's settings._title at authoring time". The curated library
 * honours it; this adapter never did (grep _title found one hit, the FAQ tab
 * titles), so a section we generated was indistinguishable from one a human
 * built in Elementor and the Portal had nothing to key on.
 *
 * Format: ia:<archetype>:<blueprintId|scratch>:<blockId>
 *
 * The archetype segment is the ADAPTER KIND -- the key that can re-render the
 * section -- so the handle stays identical whichever path built it.
 * ======================================================================== */

/**
 * Build the stable handle for one generated section.
 * `blockId` is the arion.site_block_draft row id when we have one ('-' at
 * emit time, where the draft row does not exist yet; the assembler re-stamps
 * it once the id is known).
 */
export function buildSectionTitle({ kind, block, blockId } = {}) {
  const archetype = String(block?.archetype || kind || 'section').trim().toLowerCase();
  const blueprint = String(block?.blueprint_id || 'scratch').trim() || 'scratch';
  const id = String(blockId == null ? '' : blockId).trim() || '-';
  return `ia:${archetype}:${blueprint}:${id}`;
}

/** True only for a handle this codebase minted -- never a hand-authored _title. */
export function isIaSectionTitle(title) {
  return typeof title === 'string' && title.startsWith('ia:');
}

/* ==========================================================================
 * Form fields
 * --------------------------------------------------------------------------
 * What KIND of input a labelled field gets. This lived in TWO places -- here
 * and in sectionSchema's `buildFormField` -- and they disagreed: this one
 * knows "Square Footage" is a number, that one did not. The result was a
 * silent round-trip defect. Editing a headline re-encoded the form's fields
 * and turned the number box into a text box, on a form the client had not
 * touched. Found by asserting whole-section byte identity, which is the only
 * assertion that could have found it.
 *
 * One function, imported by both. `sectionSchema` already imports from this
 * file, so there is no new dependency and no cycle.
 * ======================================================================== */
export function inferFormFieldType(label) {
  const lower = String(label == null ? '' : label).toLowerCase();
  if (lower.includes('email')) return 'email';
  if (lower.includes('phone')) return 'tel';
  if (lower.includes('date')) return 'date';
  if (lower.includes('time')) return 'time';
  if (lower.includes('message') || lower.includes('notes')) return 'textarea';
  if (lower.includes('party size') || lower.includes('square footage')) return 'number';
  return 'text';
}

/** The stable id a labelled field is stored under. */
export function formFieldId(label, idx = 0) {
  const sanitized = String(label == null ? '' : label)
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized || `field_${idx}`;
}

/* ==========================================================================
 * ONE DIALECT (§2's open item, closed for good — D-156, 2026-09-17).
 * --------------------------------------------------------------------------
 * ARION used to carry two layout dialects at once: the legacy
 * `section` -> `column` -> `widget` tree this file emitted, and the flexbox
 * `container` tree the curated library and Elementor itself speak. Since
 * 2026-09-16 nothing emitted the legacy one, and on 2026-09-17 the emitters
 * were DELETED — a rebuild deletes the old system in the same pass
 * (`feedback_replace_means_delete`), and a second way to draw a page that
 * nobody calls is a second way to draw a page that somebody will.
 *
 * The five live client sites whose pages were built that way are unaffected,
 * and the proof of it did not need the emitters: `extractFields` and
 * `applyFields` key on the `_ia_field` stamp and have never cared what kind
 * of node they walked. One page of each old shape is frozen as DATA in
 * `test/fixtures/legacy-page-goldens.json` (captured by
 * `scripts/dev/capture-legacy-pages.mjs` on the last commit that still had
 * the emitters), and `test/website-container-dialect.test.mjs` reads, patches
 * and re-reads every one of them.
 * ======================================================================== */

// One implementation of "is 'Square Footage' a number box?", shared rather
// than copied — the last time it lived in two places it produced a silent
// round-trip defect that turned a number box into a text box on a form the
// client had never touched.
useFormFieldHelpers({ inferFormFieldType, formFieldId });

/**
 * Convert one block payload + brand into one Elementor section node.
 *
 * @param {{ kind: string, block: object, brand: object, seedId?: string }} args
 * @returns {object|null}
 */
export function blockToElementorSection({ kind, block, brand, seedId, blockId }) {
  const emit = CONTAINER_EMITTERS[kind];
  if (!emit) return null;
  const resolvedSeed = seedId || `${kind}-${Date.now()}`;
  let section;
  if (kind === 'contact') {
    // The recipient is resolved BEFORE anything is built: a contact form with
    // no recipient is not a deliverable, because the owner never hears about
    // the lead. Refuse the section rather than publish a dead form.
    const emailTo = resolveFormRecipient(brand, block);
    if (!emailTo) {
      throw new FormRecipientError(
        'Cannot build the contact form: no notification email could be resolved for this '
        + 'business. Set the business contact email (onboarding questionnaire, or the '
        + 'tenant primary email) and rebuild the section.',
      );
    }
    section = emit(block, brand || {}, resolvedSeed, {
      emailTo,
      // THE PURPOSE, not the class it becomes: the emitter writes all three
      // of the keys a form carries (`formPurpose.js`), so the archetype path
      // and the tree path type a submission identically.
      formPurpose: resolveFormPurpose('contact', block),
    });
  } else {
    section = emit(block, brand || {}, resolvedSeed);
  }
  if (!section) return null;
  // Stamp the migration-029 handle centrally so every emitter gets it and no
  // future emitter can forget it. Returns a NEW object -- adapters stay pure.
  return {
    ...section,
    settings: {
      ...(section.settings || {}),
      _title: buildSectionTitle({ kind, block, blockId }),
    },
  };
}

export function listSupportedKinds() {
  return Object.keys(CONTAINER_EMITTERS).sort();
}

export const __test__ = {
  escapeHtml, mintId, FORM_PURPOSE_CLASS: formPurposeTest.CLASS_FROM_PURPOSE, resolveFormPurpose,
};
