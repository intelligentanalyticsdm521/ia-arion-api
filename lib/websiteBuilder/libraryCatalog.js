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
import { sectionKindMeta } from './sectionSchema.js';

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
          || 'This layout uses the Elementor Pro form widget, which ARION Lite sites do not have installed.',
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
  return { ok: true, node: mapped.node, kind: mapped.kind };
}

/** TEST/DEV seam — drop the cached verdicts. */
export function __resetCatalogCache() {
  _cache = null;
  _inflight = null;
}

export const __test__ = { prettyVariant, mapWithLimit, SENTINEL_BRAND, TTL_MS };
