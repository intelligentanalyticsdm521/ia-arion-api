/**
 * What the "Add a section" picker can actually offer from the curated library.
 * ---------------------------------------------------------------------------
 * `sectionLibrary.js` knows what is IN the library (manifest + blobs).
 * `libraryAdapter.js` knows whether one blueprint can be made editable.
 * This module joins the two, once, and caches the verdict — because deciding
 * it per request would mean fetching seventy blobs every time a client taps
 * "Add a section".
 *
 * THE VERDICT IS STRUCTURAL, THE OFFER IS PER-BUSINESS
 *
 * Whether a blueprint's widgets can be mapped depends only on how the
 * blueprint was drawn, so that answer is computed once per process against a
 * sentinel business and cached. Two conditions are then applied fresh on every
 * request, because they belong to the site and not to the library:
 *
 *   - Elementor Pro. A Lite site has no form widget, so the contact variants
 *     are offered with `available:false` and the reason stated, never
 *     silently dropped (walkthrough T14).
 *   - The notification email. A contact form has to know which inbox to
 *     notify; without one the offer says so, in words the owner can act on.
 *
 * FAILING SOFT IS CORRECT HERE
 *
 * The manifest lives in SQL and the blueprints in blob storage. In local dev
 * neither is reachable and `listAvailable()` answers with an empty list. The
 * picker then shows exactly what Phase 1A showed — the eight archetypes the
 * editor can build from scratch — which is a smaller menu, not a broken one.
 */

import { listAvailable, fetchSection, regenerateIds } from './sectionLibrary.js';
import { mapLibrarySection, LIBRARY_KIND_BY_ARCHETYPE } from './libraryAdapter.js';
import { sectionKindMeta, extractFields, applyFields } from './sectionSchema.js';
import { starterBlock } from './starterSections.js';

/** Structural pickability does not depend on a real business's details. */
const SENTINEL_BRAND = Object.freeze({ email: 'sentinel@ia.invalid' });

const TTL_MS = 10 * 60 * 1000;
const FETCH_CONCURRENCY = 8;

/** @type {{ ts:number, byKind:Map<string, Array<object>> }|null} */
let _cache = null;
let _inflight = null;

function prettyVariant(variantKey) {
  return String(variantKey || '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

async function mapWithLimit(items, limit, fn) {
  const out = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function buildCatalog() {
  const byKind = new Map();

  for (const [archetype, kind] of Object.entries(LIBRARY_KIND_BY_ARCHETYPE)) {
    let rows = [];
    try {
      rows = await listAvailable({ archetype });
    } catch (err) {
      console.warn(`[libraryCatalog] manifest unreadable for ${archetype}:`, err?.message);
      continue;
    }
    if (!rows.length) continue;

    const checked = await mapWithLimit(rows, FETCH_CONCURRENCY, async (row) => {
      let fetched = null;
      try {
        fetched = await fetchSection(row.blueprint_id);
      } catch (err) {
        console.warn(`[libraryCatalog] blob unreadable for ${row.blueprint_id}:`, err?.message);
      }
      if (!fetched?.sectionJson) return null;
      const result = mapLibrarySection({
        archetype,
        blueprintId: row.blueprint_id,
        sectionJson: fetched.sectionJson,
        brand: SENTINEL_BRAND,
      });
      if (!result.ok) return null;
      return {
        blueprintId: row.blueprint_id,
        kind,
        archetype,
        label: prettyVariant(row.variant_key),
        axes: row.axes || null,
        requiresPro: !!row.dependencies?.pro,
      };
    });

    const usable = checked.filter(Boolean);
    if (usable.length) byKind.set(kind, usable);
  }

  return { ts: Date.now(), byKind };
}

/** Cached, de-duplicated across concurrent callers. */
async function getCatalog() {
  if (_cache && Date.now() - _cache.ts < TTL_MS) return _cache;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      _cache = await buildCatalog();
      return _cache;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/**
 * Library variants for one editor kind, with the per-site conditions applied.
 *
 * @param {string} kind
 * @param {{ allowPro:boolean, brand:object }} ctx
 * @returns {Promise<Array<{blueprintId, label, available, unavailableReason}>>}
 */
export async function variantsForKind(kind, { allowPro = true, brand = null } = {}) {
  const catalog = await getCatalog();
  const rows = catalog.byKind.get(kind) || [];
  const meta = sectionKindMeta(kind);
  const hasEmail = !!String(brand?.email || '').trim();

  return rows.map((row) => {
    if (row.requiresPro && !allowPro) {
      return {
        blueprintId: row.blueprintId, label: row.label, available: false,
        unavailableReason: meta?.proReason
          || 'The form on this section needs the paid form builder, which ARION Lite websites do not include. Choose a plan above Lite, or a layout without a form.',
      };
    }
    if (kind === 'contact' && !hasEmail) {
      return {
        blueprintId: row.blueprintId, label: row.label, available: false,
        unavailableReason: 'We do not know which inbox to send enquiries to yet. Add your business email under Settings, then this layout is available.',
      };
    }
    return { blueprintId: row.blueprintId, label: row.label, available: true, unavailableReason: null };
  });
}

/** Every kind's variants at once — what GET /section-library needs. */
export async function libraryPickerRows({ allowPro = true, brand = null } = {}) {
  const catalog = await getCatalog();
  const out = {};
  for (const kind of catalog.byKind.keys()) {
    out[kind] = await variantsForKind(kind, { allowPro, brand });
  }
  return out;
}

/**
 * A curated layout's own words are the LAYOUT's sample copy, and a client
 * edits them before they publish — that is how every curated layout has
 * worked since Phase 1B, and hero, about, questions and contact have all been
 * walked that way.
 *
 * A PRICE is not sample copy. A price on a client's website is a number that
 * business is held to, and the library's blueprints say $0, $49 and $149.
 * So a curated pricing layout is filled from THE ONE PRICE SOURCE before it
 * reaches the editor — the same `starterBlock('pricing')` the plain one uses,
 * which reads `oliver.service_offering` through `servicePricing.js` and gives
 * back prompts rather than an invented number when there is no price list
 * (memory: feedback_no_fabricated_catalog; walk rows A2-28 and A2-30).
 *
 * The LAYOUT decides how many cards there are, so we never grow it past what
 * its author drew; when the business has fewer priced services than the layout
 * has cards, the section comes out with the cards it can fill honestly.
 */
export function fillPricingFromCatalogue(node, brand) {
  const before = extractFields(node, 'pricing');
  const drawn = Array.isArray(before.plans) ? before.plans.length : 0;
  if (drawn === 0) return node;

  const starter = starterBlock('pricing', brand || {});
  const plans = Array.isArray(starter?.plans) ? starter.plans : [];
  if (plans.length === 0) return node;

  return applyFields(node, 'pricing', { plans: plans.slice(0, Math.max(1, drawn)) });
}

/**
 * D-93 — A NAME, A QUOTE AND A NUMBER ARE NOT SAMPLE COPY EITHER.
 * ---------------------------------------------------------------------------
 * The same rule the price fill above obeys, pointed at the other three list
 * archetypes. A ready-made layout arrives saying "Sarah K., Operations Lead"
 * said something glowing, that "Brandon" is the Founder, and that the business
 * has "15+ years building". None of that is the business's copy to edit — it
 * is a claim about a person, a customer or a number that the business would be
 * held to, and every one of them is somebody else's.
 *
 * So the claims come out and PROMPTS go in — plain words that ask for what
 * belongs in that box, so the section reads as a form to fill in rather than
 * as a statement to correct. The plain path's prompts next door in
 * `starterSections.js` are the same idea for a section built from scratch.
 *
 * WHAT STAYS. Hero, about, questions, contact and call-to-action are untouched
 * — their sample copy is the business's own words to edit, which is how they
 * have been walked since June. So is the section's OWN heading and supporting
 * line here ("Meet the team", "Numbers that matter"): that is copy about the
 * business, not a claim about a named person. And so is the picture, which
 * `clearPlaceholderImages` already blanked.
 *
 * THE NUMBER COMES OUT EMPTY, not "0". A zero is a claim too — and a business
 * that has been going eleven years must type eleven, not correct a fifteen we
 * invented for them. `validateFields` then refuses to publish the section
 * until they do, in those words, which is the point.
 */
export const SAMPLE_WORD_PROMPTS = Object.freeze({
  testimonials: Object.freeze({
    quote: 'What they said',
    attribution: 'Who said it',
    role: 'Their job or company',
  }),
  team: Object.freeze({
    name: 'Name',
    role: 'Role',
  }),
  stats: Object.freeze({
    value: '',
    prefix: '',
    suffix: '',
    label: 'What this counts',
  }),
});

/** The one list a section of this kind keeps its items in, from the schema. */
function listKeyFor(kind) {
  const meta = sectionKindMeta(kind);
  return (meta?.fields || []).find((f) => f.type === 'list')?.key || null;
}

/**
 * Replace the library's sample claims with prompts, item by item.
 *
 * Field-level on purpose, not binding-level: a layout drawn as one card per
 * item and a layout drawn as one widget per item both read back through
 * `extractFields` under the same field names, so both are covered by the one
 * pass. A field this layout has nowhere to keep never appears in the item and
 * is therefore never written.
 *
 * @param {object} node
 * @param {string} kind
 * @param {{onlyPrompts?:boolean}} [opts]  `onlyPrompts` replaces ONLY a value
 *   that is still one of our prompts (or empty), never a word the client has
 *   typed. That is what a "check this" swap needs: the markers move, so the
 *   prompts have to follow them into their new boxes, and a section the client
 *   has already filled in must come through the swap untouched.
 */
export function neutraliseSampleWords(node, kind, { onlyPrompts = false } = {}) {
  const prompts = SAMPLE_WORD_PROMPTS[kind];
  const listKey = prompts ? listKeyFor(kind) : null;
  if (!prompts || !listKey) return node;

  const items = extractFields(node, kind)[listKey];
  if (!Array.isArray(items) || items.length === 0) return node;

  const ours = new Set(Object.values(prompts).filter((v) => v !== ''));
  let touched = false;
  const next = items.map((item) => {
    const out = { ...item };
    for (const [field, prompt] of Object.entries(prompts)) {
      if (!(field in item)) continue;
      const current = String(item[field] ?? '').trim();
      if (onlyPrompts && current !== '' && !ours.has(current)) continue;
      if (out[field] === prompt) continue;
      out[field] = prompt;
      touched = true;
    }
    return out;
  });
  if (!touched) return node;

  return applyFields(node, kind, { [listKey]: next });
}

/**
 * THE ONE never-invent step, and the one place it is wired.
 *
 * Everything a curated layout must not arrive saying goes through here, so
 * there is one call site to read and one to break on purpose. Prices come from
 * the price list; names, quotes and numbers come out and prompts go in;
 * everything else is the layout's sample copy and is left exactly as its
 * author wrote it.
 */
export function neverInventValues(node, kind, brand) {
  if (kind === 'pricing') return fillPricingFromCatalogue(node, brand);
  return neutraliseSampleWords(node, kind);
}

/**
 * Build ONE library variant, ready to drop into the editor. Nothing is
 * written anywhere; the section reaches the site on the next Save like any
 * other (SCOPE §3.4).
 *
 * @returns {Promise<{ok:true, node:object, kind:string} | {ok:false, code:string, message:string}>}
 */
export async function buildLibrarySection({ blueprintId, brand, allowPro = true }) {
  const id = String(blueprintId || '').trim();
  if (!id) return { ok: false, code: 'BAD_BLUEPRINT', message: 'That layout reference is not valid.' };

  const archetype = id.split('.')[0];
  const kind = LIBRARY_KIND_BY_ARCHETYPE[archetype];
  if (!kind) {
    return { ok: false, code: 'SECTION_NOT_AVAILABLE', message: 'That layout is not one the editor can look after yet.' };
  }
  const meta = sectionKindMeta(kind);
  if (meta?.requiresElementorPro && !allowPro) {
    return { ok: false, code: 'SECTION_NOT_AVAILABLE', message: meta.proReason };
  }

  let fetched = null;
  try {
    fetched = await fetchSection(id);
  } catch (err) {
    console.warn('[libraryCatalog] blob fetch failed:', err?.message);
  }
  if (!fetched?.sectionJson) {
    return { ok: false, code: 'LAYOUT_UNAVAILABLE', message: 'We could not fetch that layout just now. Try again in a moment.' };
  }

  // Element ids in the library are stable for authoring readability; two
  // copies of one blueprint on a page would collide without this.
  const mapped = mapLibrarySection({
    archetype, blueprintId: id, sectionJson: regenerateIds(fetched.sectionJson), brand,
  });
  if (!mapped.ok) {
    return {
      ok: false,
      code: 'SECTION_NOT_EDITABLE',
      message: mapped.detail || 'The editor could not take charge of every part of that layout, so it is not on offer.',
    };
  }
  const node = neverInventValues(mapped.node, mapped.kind, brand);
  return { ok: true, node, kind: mapped.kind };
}

/** TEST/DEV seam — drop the cached verdicts. */
export function __resetCatalogCache() {
  _cache = null;
  _inflight = null;
}

export const __test__ = { prettyVariant, mapWithLimit, SENTINEL_BRAND, TTL_MS };
