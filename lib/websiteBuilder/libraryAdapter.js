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
  BINDINGS, CODECS, COMPOSED_PARTS, ROLE_MARKER, ROLE_REVIEW_MARKER,
  sectionKindMeta, extractFields, validateFields, listSectionKinds,
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
 * THE LIST-ITEM BINDING FORM (ARION pack 2b)
 *
 * Pack 2 gave pricing, team and stats editor kinds and guessed how the curated
 * library draws them. The guess was wrong on all three, and the number that
 * proved it was 44 of 120 with pricing, team, stats and testimonials all at
 * ZERO (D-83). The library does not draw a list as one widget per item; it
 * draws a CARD — a container with several widgets inside it.
 *
 * So the adapter learns to find those cards and name the parts inside them.
 * Two questions, kept apart on purpose:
 *
 *   1. WHERE are the items?   `findItemGroup` — structural, no content read.
 *   2. WHICH part is which?   `assignRoles`   — the rules below, which read
 *                             content, and which say so when they had to
 *                             guess.
 * ======================================================================== */

/** Every widget under a node, in document order, however deeply nested. */
function widgetsUnder(node) {
  return walkWidgets(node);
}

/** The widget types under a node, in document order — a layout's fingerprint. */
function signatureOf(node) {
  return widgetsUnder(node).map((w) => String(w.widgetType)).join(',');
}

function childContainers(node) {
  return (node?.elements || []).filter((c) => c && c.elType && c.elType !== 'widget');
}

/**
 * The repeating cards, if this blueprint has any.
 *
 * A group is TWO OR MORE sibling containers with an IDENTICAL widget
 * fingerprint — same widget types, same order, however deep. Two is the floor
 * on purpose: one container is not evidence of a list, and treating a lone
 * card as a list is how a section's own headline gets eaten by an item.
 *
 * Order, not just the set of types, because `heading + text-editor` and
 * `text-editor + heading` are a statistic and a quote, and a layout that puts
 * one of each side by side is a layout we cannot read — better refused than
 * guessed (`testimonials.stat-quote.v1` is exactly that).
 *
 * The biggest group wins, then the deepest, so a layout with an intro block
 * drawn the same way as its cards (`stats.split-text.v1`) still finds the
 * four cards rather than the intro.
 */
export function findItemGroup(root) {
  let best = null;
  const consider = (parent, depth) => {
    const kids = childContainers(parent);
    if (kids.length >= 2) {
      const sig = signatureOf(kids[0]);
      if (sig && kids.every((k) => signatureOf(k) === sig)) {
        const candidate = { parent, items: kids, signature: sig, depth };
        if (!best
          || candidate.items.length > best.items.length
          || (candidate.items.length === best.items.length && candidate.depth > best.depth)) {
          best = candidate;
        }
      }
    }
    kids.forEach((k) => consider(k, depth + 1));
  };
  consider(root, 0);
  return best;
}

/* --- The role rules ------------------------------------------------------
 * Written out in one place so there is one answer to "why is this box called
 * the period?". Every rule reaches for a MARKER first — something the author
 * put in the content on purpose — and falls back to length only when there is
 * no marker. A length fallback is never silent: it is recorded on the section
 * and the edit sheet shows it with "check this" and a one-tap swap.
 * ---------------------------------------------------------------------- */

/** A price says so: a currency sign, or a digit. */
const PRICEY_RE = /[$€£¥₹]|\d/;

/** A list says so: line breaks, list items, or a bullet at the front. */
const LISTY_RE = /<br\s*\/?>|<li[\s>]|^\s*(?:<p[^>]*>)?\s*[✓✔•·\-–—*]/i;

/** A quotation says so: it is wrapped in quotation marks. */
const QUOTED_RE = /^\s*(?:<p[^>]*>)?\s*[“"'‘«]/;

const textOf = (w) => String(w?.settings?.title ?? w?.settings?.title_text ?? '');
const editorOf = (w) => String(w?.settings?.editor ?? '');
const plainOf = (w) => CODECS.html_text.decode(editorOf(w));

function byType(widgets, type) {
  return widgets.filter((w) => String(w.widgetType) === type);
}

/**
 * Split two candidates by a marker; fall back to length and say so.
 * Returns `{ marked, other, guessed }` where `marked` is the one that carries
 * the marker (or, failing that, the longer one).
 */
function splitByMarker(a, b, test, lengthOf) {
  const aHit = test(a);
  const bHit = test(b);
  if (aHit && !bHit) return { marked: a, other: b, guessed: false };
  if (bHit && !aHit) return { marked: b, other: a, guessed: false };
  const [longer, shorter] = lengthOf(a) >= lengthOf(b) ? [a, b] : [b, a];
  return { marked: longer, other: shorter, guessed: true };
}

const REVIEW_WORDS = {
  'name|price': 'We could not tell the plan name from the price on these cards, so we went by the order they are drawn in.',
  'features|period': 'We could not tell "how often" from the "what is included" list on these cards, so we went by which is longer.',
  'quote|role': 'We could not tell the quote from the job title on these cards, so we went by which is longer.',
};

/**
 * Which widget inside one card holds which part of the item.
 *
 * @returns {{ assign: Map<object,string>, review: Array<{roles:string[], why:string}> }}
 */
export function assignRoles(kind, widgets) {
  const assign = new Map();
  const review = [];
  const flag = (a, b) => {
    const key = [a, b].sort().join('|');
    if (!review.some((r) => [...r.roles].sort().join('|') === key)) {
      review.push({ roles: [a, b], why: REVIEW_WORDS[key] || 'We were not certain about this one.' });
    }
  };

  const headings = byType(widgets, 'heading');
  const editors = byType(widgets, 'text-editor');
  const images = byType(widgets, 'image');
  const buttons = byType(widgets, 'button');
  const iconBoxes = byType(widgets, 'icon-box');

  if (kind === 'pricing') {
    if (iconBoxes.length >= 1) assign.set(iconBoxes[0], 'plan_box');
    if (headings.length >= 2) {
      const { marked, other, guessed } = splitByMarker(
        headings[0], headings[1], (h) => PRICEY_RE.test(textOf(h)), (h) => textOf(h).length,
      );
      // Order is the tie-break the flag warns about: on a price card the name
      // is drawn above the price, so first is the name.
      if (guessed) { assign.set(headings[0], 'name'); assign.set(headings[1], 'price'); flag('name', 'price'); }
      else { assign.set(marked, 'price'); assign.set(other, 'name'); }
    } else if (headings.length === 1 && iconBoxes.length === 0) {
      assign.set(headings[0], 'name');
    }
    if (editors.length >= 2) {
      const { marked, other, guessed } = splitByMarker(
        editors[0], editors[1], (e) => LISTY_RE.test(editorOf(e)), (e) => plainOf(e).length,
      );
      assign.set(marked, 'features');
      assign.set(other, 'period');
      if (guessed) flag('period', 'features');
    } else if (editors.length === 1) {
      if (LISTY_RE.test(editorOf(editors[0]))) assign.set(editors[0], 'features');
      else { assign.set(editors[0], 'period'); flag('period', 'features'); }
    }
    if (buttons.length >= 1) assign.set(buttons[0], 'cta');
    return { assign, review };
  }

  if (kind === 'team') {
    if (images.length >= 1) assign.set(images[0], 'photo');
    if (headings.length >= 1) assign.set(headings[0], 'name');
    if (editors.length >= 1) assign.set(editors[0], 'role');
    return { assign, review };
  }

  if (kind === 'stats') {
    if (iconBoxes.length >= 1) assign.set(iconBoxes[0], 'stat_box');
    if (headings.length >= 1) assign.set(headings[0], 'number');
    if (editors.length >= 1) assign.set(editors[0], 'label');
    return { assign, review };
  }

  if (kind === 'testimonials') {
    if (headings.length >= 1) assign.set(headings[0], 'attribution');
    if (editors.length >= 2) {
      const { marked, other, guessed } = splitByMarker(
        editors[0], editors[1], (e) => QUOTED_RE.test(editorOf(e)), (e) => plainOf(e).length,
      );
      assign.set(marked, 'quote');
      assign.set(other, 'role');
      if (guessed) flag('quote', 'role');
    } else if (editors.length === 1) {
      assign.set(editors[0], 'quote');
    }
    return { assign, review };
  }

  return { assign, review };
}

/**
 * A role whose write path REBUILDS markup has to survive a decode -> encode
 * round trip before it is stamped, exactly as a composed card does: the
 * client's first save would otherwise silently rewrite the layout's own
 * markup. `features` (a `<p>a<br>b</p>` list) and `number` ("15+" split into a
 * number and a suffix) are the two.
 */
/**
 * Which tags each markup codec can write back. Anything else inside a widget
 * is markup the AUTHOR put there and our encoder would delete on the client's
 * first save — a bolded word, a link, a span with a class. That is the loss
 * this check exists to catch.
 *
 * What it must NOT catch is a difference that is not a loss: `<p> /mo</p>`
 * re-encoded as `<p>/mo</p>`, or a bare `&` re-encoded as `&amp;`. Both
 * render identically and both are how the curated library is actually
 * written, so the test is "does the VALUE survive", not "are the bytes equal".
 */
const CODEC_TAGS = Object.freeze({
  html_text:       'p',
  html_em:         'p|em',
  html_paragraphs: 'p',
  html_lines:      'p|br|ul|ol|li',
});

function markupIsPlain(html, codecName) {
  const allowed = CODEC_TAGS[codecName];
  if (!allowed) return true;
  return !new RegExp(`<(?!/?(?:${allowed})[\\s/>])[^>]*>`, 'i').test(String(html == null ? '' : html));
}

function valueSurvives(codec, current) {
  const once = codec.decode(current);
  const twice = codec.decode(codec.encode(once));
  return JSON.stringify(once) === JSON.stringify(twice);
}

function roleRoundTrips(roleSpec, widget) {
  try {
    if (roleSpec?.part) {
      const part = COMPOSED_PARTS[roleSpec.part.codec];
      if (!part) return false;
      const current = widget?.settings?.[roleSpec.part.setting];
      if (typeof current !== 'string' || !current.trim()) return false;
      // A part is plain text, so bytes are the right test: "15+" that came
      // back "15 +" would be a number the client never typed.
      return part.encode(part.decode(current)) === current;
    }
    for (const [, spec] of Object.entries(roleSpec?.fields || {})) {
      const codecName = spec?.codec;
      if (!codecName || codecName === 'text' || codecName === 'attachment_id') continue;
      const codec = CODECS[codecName];
      if (!codec) return false;
      const current = widget?.settings?.[spec.setting];
      if (typeof current !== 'string') continue;
      if (!markupIsPlain(current, codecName)) return false;
      if (!valueSurvives(codec, current)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Stamp one blueprint's repeating cards as a list.
 *
 * Returns the widgets it claimed (so a later `take:'one'` step cannot take a
 * card's heading for the section's headline) and the review notes.
 */
function stampItemCards(node, { kind, bindingId }) {
  const binding = BINDINGS[bindingId];
  if (!binding || binding.repeat !== 'container') return null;
  const group = findItemGroup(node);
  if (!group) {
    return {
      ok: false,
      reason: 'no_item_group',
      claimed: [],
      note: 'This layout draws one card, or two cards drawn differently from each other, '
        + 'so there is no list in it for the editor to add to or take away from.',
    };
  }

  // The roles are decided ONCE, off the first card, and then applied to every
  // card BY POSITION. The cards are identical by construction (that is what
  // made them a group), so position is exact — and deciding per card is how
  // two cards in one section end up disagreeing about which box is the price:
  // `pricing.2col-simple.v1` draws "Project / Fixed" and "Partner / $1,500",
  // and the currency sign is only on the second one.
  const firstWidgets = widgetsUnder(group.items[0]);
  const first = assignRoles(kind, firstWidgets);
  if (first.assign.size === 0) return { ok: false, reason: 'no_roles', claimed: [] };
  const roleByIndex = new Map();
  for (const [widget, roleKey] of first.assign.entries()) {
    const i = firstWidgets.indexOf(widget);
    if (i >= 0) roleByIndex.set(i, roleKey);
  }

  const claimed = [];
  for (const item of group.items) {
    const widgets = widgetsUnder(item);
    for (const [i, roleKey] of roleByIndex.entries()) {
      const widget = widgets[i];
      if (!widget) continue;
      const roleSpec = binding.roles?.[roleKey];
      if (!roleSpec) continue;
      if (String(widget.widgetType) !== roleSpec.widget) continue;
      // A part we cannot write back without changing it is left UNCLAIMED,
      // not fatal on its own: the required-field check below decides whether
      // the card is still usable without it, and an unclaimed BUTTON is
      // caught by the unmapped-control rule, which is the door that matters.
      if (!roleRoundTrips(roleSpec, widget)) continue;
      widget.settings = { ...(widget.settings || {}), [ROLE_MARKER]: roleKey };
      claimed.push(widget);
    }
    item.settings = { ...(item.settings || {}), _ia_field: bindingId };
  }

  return {
    ok: true,
    claimed,
    review: first.review.map((r) => ({
      list: binding.list,
      roles: r.roles,
      fields: r.roles.flatMap((rk) => Object.keys(binding.roles?.[rk]?.fields || {})),
      why: r.why,
    })),
  };
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
  // The four list-item kinds. The CARDS are claimed first, before anything
  // else looks at a heading or a text-editor — otherwise the headline step
  // takes a card's own heading (a stats band's big number was being read as
  // the section's headline) and the section comes out wrong in a way that
  // still passes every required-field check.
  testimonials: [
    { take: 'items',         binding: 'testimonials.quote_cards' },
    { widget: 'heading',     take: 'headline', binding: 'testimonials.headline' },
    { widget: 'text-editor', take: 'one',      binding: 'testimonials.subheadline' },
    { widget: 'text-editor', take: 'all',      binding: 'testimonials.items', unless: 'testimonials' },
    // ^ `unless` names the list key the card step above may already have
    //   claimed; a list is never bound twice.
  ],
  // The `unless` step below is what OUR OWN sections are drawn with — one
  // composed text-editor per card, one image-box per person, one counter per
  // number. The curated library draws none of them that way, but a blueprint
  // that did would still be read, so both shapes stay on offer and the card
  // form wins when it finds cards.
  pricing: [
    { take: 'items',         binding: 'pricing.plan_cards' },
    { widget: 'heading',     take: 'headline', binding: 'pricing.headline' },
    { widget: 'text-editor', take: 'one',      binding: 'pricing.subheadline' },
    { widget: 'text-editor', take: 'all',      binding: 'pricing.plans', unless: 'plans' },
  ],
  team: [
    { take: 'items',         binding: 'team.member_cards' },
    { widget: 'heading',     take: 'headline', binding: 'team.headline' },
    { widget: 'text-editor', take: 'one',      binding: 'team.subheadline' },
    { widget: 'image-box',   take: 'all',      binding: 'team.members', unless: 'members' },
  ],
  stats: [
    { take: 'items',         binding: 'stats.stat_cards' },
    { widget: 'heading',     take: 'headline', binding: 'stats.headline' },
    { widget: 'text-editor', take: 'one',      binding: 'stats.subheadline' },
    { widget: 'counter',     take: 'all',      binding: 'stats.items', unless: 'stats' },
  ],
});

/* ==========================================================================
 * The vendor's grey placeholder is not a picture
 * ======================================================================== */

/**
 * EVERY image in the curated library is Elementor's own placeholder file
 * (`/wp-content/plugins/elementor/assets/images/placeholder.png` — all 120
 * blueprints, one URL). Carrying it through means two things a client should
 * never meet:
 *
 *   1. a vendor's grey placeholder published on their live website
 *      (memory: feedback_no_third_party_product_surface), and
 *   2. a section they CANNOT SAVE, because a picture with no description is
 *      refused ("Describe the picture" is `requiredWith` on every image field)
 *      and there is nothing honest to write about a placeholder.
 *
 * The second one is not new: `about.image-bullets.v1` has been in the picker
 * since Phase 1B and has never been savable. The pickability gate only looked
 * for "cannot be empty" and a `requiredWith` failure says something else, so
 * it went straight through. Both are closed here, in the one place.
 *
 * A blank picture is the same state the plain one starts in, and the picture
 * picker is right there in the edit sheet.
 */
const VENDOR_PLACEHOLDER_RE = /\/plugins\/elementor\/assets\/images\/placeholder/i;

export function clearPlaceholderImages(node) {
  let cleared = 0;
  const blankIn = (settings, key) => {
    const img = settings?.[key];
    if (!img || typeof img !== 'object') return;
    if (!VENDOR_PLACEHOLDER_RE.test(String(img.url || ''))) return;
    settings[key] = { ...img, url: '', id: '' };
    cleared += 1;
  };
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.settings) {
      blankIn(n.settings, 'image');
      blankIn(n.settings, 'background_image');
    }
    if (Array.isArray(n.elements)) n.elements.forEach(walk);
  };
  walk(node);
  return cleared;
}

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
  const claimedLists = new Set();
  const notes = [];
  let roleReview = [];

  for (const step of plan) {
    const binding = BINDINGS[step.binding];
    if (!binding) continue;

    // The list-item binding form: find the repeating cards, name the parts
    // inside them, and take those widgets out of every later step's reach.
    if (step.take === 'items') {
      const result = stampItemCards(node, { kind, bindingId: step.binding });
      if (!result?.ok) {
        if (result?.note) notes.push(result.note);
        continue;
      }
      result.claimed.forEach((w) => claimed.add(w));
      claimedLists.add(binding.list);
      stamped.push(step.binding);
      roleReview = roleReview.concat(result.review || []);
      continue;
    }

    if (step.unless && claimedLists.has(step.unless)) continue;

    const candidates = widgets.filter((w) => w.widgetType === step.widget && !claimed.has(w));
    if (candidates.length === 0) {
      // Every heading in this layout belongs to a card, so the section has no
      // title of its own. Worth saying out loud: before the cards were claimed
      // the headline step took one of them, and a stats band came out with its
      // biggest number as its headline while passing every check.
      if (step.take === 'headline' && claimedLists.size > 0) {
        notes.push('Every heading in this layout is part of a card, so there is nowhere to put the '
          + 'section’s own title.');
      }
      continue;
    }

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
      detail: [
        `This layout has ${unmapped.length} ${unmapped[0] === 'form' ? 'form' : 'button'}${unmapped.length > 1 ? 's' : ''} the editor could not take charge of.`,
        ...notes,
      ].join(' '),
      unmapped,
    };
  }

  // The handle. `ia:<kind>:<blueprintId>:-` — the blueprint id is kept so a
  // page can still be traced back to the variant it was built from.
  node.settings = { ...(node.settings || {}), _title: `ia:${kind}:${blueprintId || 'library'}:-` };

  // Where a role rule had to guess, the guess is WRITTEN DOWN on the section
  // rather than left to look like a decision. The edit sheet shows it as
  // "check this" with a one-tap swap, and the note goes when they answer it.
  if (roleReview.length > 0) node.settings[ROLE_REVIEW_MARKER] = roleReview;

  // Prove it: read the fields back out through the ordinary path and require
  // every REQUIRED one. Anything less and the client gets a section they
  // cannot finish filling in.
  clearPlaceholderImages(node);

  const fields = extractFields(node, kind);
  const check = validateFields(kind, fields);
  // EVERY validation error, not just the empty-required ones. A blueprint the
  // client could add and then never save is worse than one that was never
  // offered, and that is exactly what `about.image-bullets.v1` was: its
  // picture failed `requiredWith`, which does not say "cannot be empty", so it
  // slipped through this gate and into the picker.
  const missing = check.errors.map((e) => e.message);

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
      detail: [...missing, ...notes].join(' '),
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
