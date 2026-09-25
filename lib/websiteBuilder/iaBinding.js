/**
 * iaBinding.js — THE BINDING STAMP, in a module that imports nothing.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 * `iaStamp`, `bindingProps`, `IA_SOURCES`, `REFRESH_MODES` and
 * `ON_EMPTY_MODES` lived in `elementorWidgets.js`. Every IA widget's emitter
 * needs `iaStamp` — it is what puts `_ia_widget`, `_ia_source` and
 * `_ia_selection` on a published node so a re-publish can refresh live prices
 * without the author touching the page.
 *
 * B-168 moves those emitters into `families/<name>/emitters.js`, and
 * `elementorWidgets.js` imports `families/index.js`. So a family that imported
 * the stamp from `elementorWidgets.js` closed a cycle:
 *
 *   families/f8/emitters.js → elementorWidgets.js → families/index.js
 *                                                 → families/f8/emitters.js
 *
 * Entering that cycle at the family (which every family TEST does) throws
 * *"Cannot access 'F8_CONTACT_FURNITURE' before initialization"*. Measured, not
 * predicted: b168/f8-contact-furniture-deep hit it on the first run.
 *
 * The two ways out were a SECOND copy of the stamp in a family folder, or ONE
 * copy somewhere neither side has to import the other to reach. A second copy
 * is two answers to "what marks a bound widget", which is the drift B-168
 * exists to stop, so this is the one copy. **This module imports nothing** —
 * that is the whole property that makes it safe, and `test/website-builder-
 * families.test.js` asserts it, the way `builder/esc.ts` is asserted on the
 * Portal side (b168/override, item 5b).
 *
 * `elementorWidgets.js` RE-EXPORTS all five names, so not one caller anywhere
 * in this repo changes. Moving is not copying: the definitions are gone from
 * that file.
 */

const text = (v) => String(v == null ? '' : v);

/** How often a bound widget re-reads its source. A closed list (F.2). */
export const REFRESH_MODES = ['live', 'snapshot_publish', 'snapshot_send'];
/** What a bound widget does when its source answers nothing (F.2). */
export const ON_EMPTY_MODES = ['hide', 'placeholder', 'last_snapshot'];

/**
 * WHAT A BOUND WIDGET IS BOUND TO — the marker, not a table name.
 *
 * D156_CONFORMANCE_HANDOFF_2026-09-17 §3 (agent O): `_ia_source` is a marker
 * and deliberately NOT a schema object, because
 * `reference_data_ownership_architecture` moves schema objects and a stored
 * document naming one is a stored document that goes stale. Same strings in
 * all three repos.
 */
export const IA_SOURCES = Object.freeze({
  catalogue: 'oliver:catalogue',
  location: 'lumen:locations',
  document: 'document',
  /* D-165 — the four new website markers. Same shape as the three above and
     for the same reason: a MARKER, never a table name. Added to the shared
     vocabulary in D165_HANDOFF_2026-09-19.md so the other repos can read them
     back. */
  reviews: 'lumen:reviews',
  contacts: 'lumen:contacts',
  forms: 'lumen:forms',
  booking: 'oliver:booking',
});

/**
 * The five controls every IA data widget shares, read once.
 *
 * `_ia_selection` is snake case, matching the columns the APIs already speak
 * (handoff §3): `{ offering_id, price_id }` for the catalogue,
 * `{ location_id }` for a site, absent for the document. A list of offering
 * ids is also accepted, because one product-card widget on a website can be
 * bound to several rows.
 *
 * Nothing is invented: a widget bound to nothing answers an empty list, and
 * the widget on the page then does what `on_empty` says.
 */
export function bindingProps(p = {}) {
  const sel = p._ia_selection;
  const obj = sel && typeof sel === 'object' && !Array.isArray(sel) ? sel : null;
  const ids = Array.isArray(sel)
    ? sel.filter(Boolean).map((v) => text(v && typeof v === 'object' ? v.offering_id : v))
    : (obj
      ? [text(obj.offering_id)].filter(Boolean)
      : (sel ? [text(sel)] : []));
  const refresh = REFRESH_MODES.includes(text(p.refresh)) ? text(p.refresh) : 'live';
  const onEmpty = ON_EMPTY_MODES.includes(text(p.on_empty)) ? text(p.on_empty) : 'hide';
  return {
    source: text(p._ia_source) || IA_SOURCES.catalogue,
    ids: ids.filter(Boolean),
    priceId: obj ? text(obj.price_id) : '',
    locationId: obj ? text(obj.location_id) : '',
    tier: obj ? text(obj.tier) : '',
    refresh,
    on_empty: onEmpty,
    overrides: (p.overrides && typeof p.overrides === 'object') ? p.overrides : {},
    snapshot: (p._ia_snapshot && typeof p._ia_snapshot === 'object') ? p._ia_snapshot : null,
  };
}

/** The stamp itself: which of our widgets this is, and what it is bound to. */
export function iaStamp(settings, kind, props = {}, defaultSource = '') {
  const b = bindingProps(props);
  return {
    ...settings,
    _ia_widget: kind,
    /* The author's own binding wins; otherwise the widget's own source, which
       is a fact about the widget and not a guess about the document. */
    _ia_source: text(props._ia_source) || defaultSource || b.source,
    _ia_selection: JSON.stringify(props._ia_selection == null ? [] : props._ia_selection),
    _ia_refresh: b.refresh,
    _ia_on_empty: b.on_empty,
  };
}
