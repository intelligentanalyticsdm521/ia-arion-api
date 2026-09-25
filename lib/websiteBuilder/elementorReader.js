/**
 * THE REVERSE OF THE EMITTER — an Elementor page, read into the builder.
 * ---------------------------------------------------------------------------
 * Brandon, 2026-09-22, walking Website → Pages: *"then I can't actually edit
 * anything."* He was right. Every page on a client's real website is built in
 * Elementor ON THE SITE, and the builder could only read two things: a section
 * carrying our `ia:<kind>:…` handle, and a widget carrying our `_ia_w` stamp.
 * Everything else came back as *"Custom section — built on the site"*, locked,
 * with Edit greyed out and a sentence telling the client to ask us instead.
 *
 * This file is the other direction, and it is ONE mechanism:
 *
 *   an Elementor node  →  the block the builder edits
 *   ─────────────────────────────────────────────────────────────────────
 *   container / section / column   our container, with its layout read back
 *   a widget we have a row for     that widget, props read off its settings
 *   a widget we do not know        an OPAQUE block: drawn as a placeholder,
 *                                  not editable, written back byte for byte
 *
 * ── THE PROMISE THIS FILE HAS TO KEEP ─────────────────────────────────────
 * Opening somebody's page and pressing Publish without changing anything must
 * change NOTHING on their live website. That is not achieved by hoping every
 * reader is a perfect inverse — it is achieved by a rule you can state in one
 * line and test on real bytes:
 *
 *     a block whose props came back unchanged is written back as the very
 *     node it was read from.
 *
 * `writeSection` below keeps an index of the original nodes by their Elementor
 * id; a block still carrying the props its node read as is returned verbatim,
 * object identity and all. Only a block the author actually changed goes
 * through the emitter, and even then the emitter's settings are merged OVER
 * the original node's, so a colour Elementor put there that nothing in our
 * vocabulary names survives the edit.
 *
 * ── WHY `read` LIVES BESIDE `settings` ────────────────────────────────────
 * A family row is `{ widgetType, tier, label, settings(props, ctx) }`. It may
 * now also carry `read(settings)`, in the same file, so the two halves of one
 * widget's translation are read together and change together. Where a row
 * declares none, `genericRead` below answers — and it can, because the panel's
 * control names ARE the page engine's setting names (that is the rule
 * `elementorWidgets.js` has held since D-165), so the inverse of most rows is
 * "unwrap the engine's own wrapper shapes and hand the rest back".
 *
 * `test/website-elementor-reader.test.mjs` runs EVERY row of the catalogue
 * through `settings → read → settings` and fails on any row that is not a
 * fixed point. A row that cannot be made one is not offered as editable at
 * all: it reads OPAQUE, which loses the client nothing and lies to them about
 * nothing.
 *
 * Pure: nodes in, nodes out. No fetch, no clock.
 */

import { ELEMENTOR_WIDGETS, canonicalKind } from './elementorWidgets.js';
import { settingsToStyle, layoutStyleFromSettings } from './elementorTree.js';

/* ── the vocabulary this file adds ───────────────────────────────────────── */

/** A widget the builder has no row for. Drawn, kept, never edited. */
export const OPAQUE_KIND = 'opaque';
/** The Elementor id a block was read from, so a save can find its node again. */
export const BLOCK_ID_KEY = '__id';
/** Which element a container block was: `container`, `section` or `column`. */
export const BLOCK_EL_KEY = '__el';
/** What an opaque block really is, so the canvas can name it. */
export const OPAQUE_TYPE_KEY = '__widgetType';

/** Keys that are OURS, not the page's. Never handed to an emitter as a prop. */
const OUR_KEYS = new Set([
  '_ia_w', '_ia_props', '_ia_field', '_ia_field_section', '_ia_col', '_ia_row',
  '_ia_node', '_ia_widget', '_ia_role', '_ia_role_review',
]);

/** What Elementor hangs its own machinery on. Not settings an emitter wrote. */
const ELEMENTOR_INTERNALS = new Set(['__globals__', '__dynamic__']);

/* ══════════════════════════════════════════════════════════════════════════
   1. WHICH OF OUR WIDGETS A PAGE-ENGINE WIDGET IS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The kind whose NAME is the widget type — `price-table` → `price_table`,
 * `ia_product_cards` → `product_cards`.
 *
 * Two widget types are claimed by two kinds each: `price-table` by `card` and
 * `price_table`, `ia_product_cards` by `catalog_card` and `product_cards`. In
 * both pairs one kind is the widget itself and the other is a BOUND one — a
 * card that fills itself from the OLIVER catalogue, whose `settings()` writes
 * a binding and cannot be read back out of a page that has none. Reading a
 * page must pick the same one every time, and it must pick the plain one, so
 * the tie is broken by the name and not by which family loaded first.
 */
function nameMatchesType(kind, widgetType) {
  return kind === String(widgetType).replace(/-/g, '_').replace(/^ia_/, '')
    || kind === String(widgetType).replace(/-/g, '_');
}

/**
 * `widgetType → kind`, built once by inverting the catalogue.
 *
 * A row with no `settings(props)` is a COMPOSITION: its `node(props, ctx)`
 * builds a tree of free widgets standing in for one of ours, and there is no
 * settings object to read props back out of. Those are not in this map, so a
 * page carrying one reads OPAQUE — kept, drawn, never claimed.
 */
export const KIND_OF_WIDGET_TYPE = (() => {
  const out = {};
  for (const [kind, row] of Object.entries(ELEMENTOR_WIDGETS)) {
    if (typeof row?.settings !== 'function') continue;
    const type = String(row.widgetType || '');
    if (!type) continue;
    const held = out[type];
    if (held === undefined) { out[type] = kind; continue; }
    if (nameMatchesType(kind, type) && !nameMatchesType(held, type)) out[type] = kind;
  }
  return Object.freeze(out);
})();

/** Which of our widgets this page-engine widget is, or null. */
export function kindOfWidgetType(widgetType) {
  const t = String(widgetType || '');
  return KIND_OF_WIDGET_TYPE[t] || null;
}

/* ══════════════════════════════════════════════════════════════════════════
   2. ONE WIDGET'S SETTINGS → THE PROPS THE PANEL EDITS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Elementor's own wrapper shapes, unwrapped.
 *
 * The engine stores a link as `{ url, is_external, nofollow }`, a slider as
 * `{ unit, size, sizes }` and a four-sided measurement as `{ unit, top, right,
 * bottom, left, isLinked }`. The emitters take a plain string or a plain
 * number for all three, so handing the wrapper straight back would publish
 * `"[object Object]"` into somebody's button. Unwrapped HERE, by the shape of
 * the value, so no table has to be kept in step with eighty-eight rows.
 *
 * An icon (`{ value, library }`) and a picture (`{ id, url }`) are handed back
 * whole, because `faIcon()` and the picture emitters already read that exact
 * shape — the round-trip test is what proves it, per widget.
 */
export function unwrap(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return value;
  // A link. `url` and nothing that says it is a picture or an icon.
  if ('url' in value && !('id' in value) && !('value' in value)) return String(value.url ?? '');
  // A slider.
  if ('size' in value && 'unit' in value && !('top' in value)) {
    return value.size === '' || value.size == null ? '' : Number(value.size);
  }
  // A four-sided measurement, which the emitters build from ONE number. Four
  // equal sides are that number; four different ones are a layout we did not
  // write and cannot express as one, so the object is handed back and the
  // round-trip test says so rather than this guessing an average.
  if ('top' in value && 'right' in value && 'bottom' in value && 'left' in value) {
    const sides = [value.top, value.right, value.bottom, value.left].map((v) => String(v ?? ''));
    if (!sides.every((v) => v === sides[0])) return value;
    // FOUR BLANK SIDES ARE NOT ZERO. `Number('')` is 0, and handing 0 to an
    // emitter that was given nothing publishes a real zero measurement over a
    // control the author never touched.
    return sides[0] === '' ? '' : Number(sides[0]);
  }
  return value;
}

/**
 * The default inverse: every setting the widget carries, unwrapped, minus ours.
 *
 * It works because the panel's controls are spelled with the page engine's own
 * setting names. Where a row's `settings()` does something a rename cannot
 * undo — composing four boxes into one shadow key, wrapping plain words in a
 * paragraph — that row declares its own `read`, beside its `settings`.
 */
export function genericRead(settings) {
  const out = {};
  for (const [k, v] of Object.entries(settings || {})) {
    if (OUR_KEYS.has(k) || ELEMENTOR_INTERNALS.has(k)) continue;
    out[k] = unwrap(v);
  }
  return out;
}

/**
 * One widget node → the props the builder's panel edits, or null.
 *
 * `null` means "we cannot": no row for this widget type, or the row is a
 * composition with no settings of its own. The caller makes it opaque.
 */
export function readWidgetProps(node) {
  const kind = kindOfWidgetType(node?.widgetType);
  if (!kind) return null;
  const row = ELEMENTOR_WIDGETS[kind];
  if (!row || typeof row.settings !== 'function') return null;
  /* A ROW MAY SAY IT CANNOT BE READ BACK. `read: false` is the one widget's own
     declaration that its settings are not an inverse of its props — a bound
     card whose settings are a fetch instruction, not content. It reads OPAQUE,
     which keeps it on the page and tells the client the truth about it. */
  if (row.read === false) return null;
  const settings = node?.settings || {};
  /* A ROW'S `read` IS A CORRECTION, NOT A REPLACEMENT. It names only what a
     rename cannot undo — a composed key, a shape the emitter does not take —
     and the default inverse answers for everything else. That is what keeps
     `read` a handful of lines beside a `settings` of a hundred, and what stops
     a family author having to re-list forty keys to fix one. */
  const fixes = typeof row.read === 'function' ? row.read(settings) : null;
  const props = { ...genericRead(settings), ...(fixes && typeof fixes === 'object' ? fixes : {}) };
  return { kind, props };
}

/* ══════════════════════════════════════════════════════════════════════════
   3. A WHOLE SECTION, READ
   ══════════════════════════════════════════════════════════════════════════ */

const CONTAINER_EL_TYPES = new Set(['container', 'section', 'column']);

/** How deep this reader will follow somebody else's nesting. */
export const MAX_READ_DEPTH = 12;

/**
 * One Elementor node → one block.
 *
 * `stamped` is the reader for a node WE wrote (`sectionSchema.readContentWidget`),
 * handed in rather than imported so this module and `sectionSchema` do not
 * import each other. Our own stamped widgets keep their existing path exactly:
 * a page the builder wrote reads back the way it always did.
 */
export function readNode(node, deps = {}) {
  const { stamped, normalise, depth = 1 } = deps;
  /* THE ONE READ. `writeSection` below compares a block the builder sent back
     against `readNode` of the node it came from, and hands the ORIGINAL node
     back when the two match. So every step of the read has to happen HERE,
     including `normalise` — the caller's last pass over one block. Applying it
     outside would mean the write compared a normalised block against an
     un-normalised read, decide nothing matched, and rebuild every node on the
     page on a save that changed nothing. Measured, 2026-09-22. */
  const done = (block) => (block && typeof normalise === 'function' ? normalise(block) : block);
  if (!node || typeof node !== 'object') return null;

  /* One of ours, stamped. Its own reader answers, and it answers for its
     children too, so a box we wrote comes back whole. */
  if (typeof stamped === 'function' && node?.settings?.[BLOCK_MARKER_KEY]) {
    const block = stamped(node);
    return block ? done({ ...block, [BLOCK_ID_KEY]: String(node.id || '') }) : null;
  }

  if (CONTAINER_EL_TYPES.has(String(node.elType))) {
    const style = containerStyleOf(node.settings);
    return done({
      kind: 'container',
      [BLOCK_ID_KEY]: String(node.id || ''),
      [BLOCK_EL_KEY]: String(node.elType),
      ...(style ? { __style: style } : {}),
      __children: depth >= MAX_READ_DEPTH
        ? []
        : (Array.isArray(node.elements) ? node.elements : [])
          .map((kid) => readNode(kid, { ...deps, depth: depth + 1 }))
          .filter(Boolean),
    });
  }

  if (String(node.elType) !== 'widget') return null;

  const known = readWidgetProps(node);
  if (known) {
    return done({ kind: known.kind, [BLOCK_ID_KEY]: String(node.id || ''), ...known.props });
  }

  /* A widget we have no row for. It stays on the page exactly as it is, and
     the canvas draws a placeholder saying what it is and where to change it.
     Losing it would be losing something off a client's live website. */
  return {
    kind: OPAQUE_KIND,
    [BLOCK_ID_KEY]: String(node.id || ''),
    [OPAQUE_TYPE_KEY]: String(node.widgetType || 'unknown'),
  };
}

/** `sectionSchema`'s stamp, spelled here so the two files do not import each other. */
const BLOCK_MARKER_KEY = '_ia_w';

/**
 * A container's own look and arranging, in the §11.8 `style` the builder edits.
 *
 * Both halves come from `elementorTree.js`, which is where this platform's one
 * layout dialect lives — `settingsToStyle` for the look and
 * `layoutStyleFromSettings` for the arranging. Nothing is re-derived here: a
 * second copy of a layout dialect is how a box comes back saying `row` and
 * publishes `column` (reference_platform_seams_audit).
 */
export function containerStyleOf(settings) {
  const look = settingsToStyle(settings) || {};
  const layout = layoutStyleFromSettings(settings) || {};
  const merged = { ...look, ...layout };
  if (look.tablet || layout.tablet) merged.tablet = { ...(look.tablet || {}), ...(layout.tablet || {}) };
  if (look.phone || layout.phone) merged.phone = { ...(look.phone || {}), ...(layout.phone || {}) };
  return Object.keys(merged).length ? merged : null;
}

/**
 * Every block on one top-level section, in page order.
 *
 * The section's OWN container is not a block — it is the section — so this
 * reads its children. What comes back is exactly the shape a free section's
 * `blocks` field already has, which is why the Portal needs no new section
 * kind to draw somebody else's page: it is "Words and pictures", with their
 * words and their pictures in it.
 */
export function readSectionBlocks(section, deps = {}) {
  const kids = Array.isArray(section?.elements) ? section.elements : [];
  return kids.map((kid) => readNode(kid, { ...deps, depth: 1 })).filter(Boolean);
}

/* ══════════════════════════════════════════════════════════════════════════
   4. AND BACK — the write that changes nothing when nothing changed
   ══════════════════════════════════════════════════════════════════════════ */

/** Every node in a tree, by its Elementor id. */
export function indexById(node, into = new Map()) {
  if (!node || typeof node !== 'object') return into;
  if (node.id) into.set(String(node.id), node);
  for (const kid of Array.isArray(node.elements) ? node.elements : []) indexById(kid, into);
  return into;
}

/** Two blocks are the same block when they say the same thing. */
function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The section, written back from its blocks.
 *
 * @param {object} section   the node the blocks were read from
 * @param {Array}  blocks    what the builder sent back
 * @param {object} deps      { stamped, build }  — `sectionSchema`'s two halves
 *
 * THE RULE, in code: for every block, find the node it was read from; read
 * that node again; if the block still says the same thing, hand the ORIGINAL
 * NODE back. Nothing is rebuilt, nothing is re-stamped, and the JSON that
 * reaches the website is the JSON that came off it.
 *
 * A block the author DID change is built by `sectionSchema.buildContentWidget`
 * — the one builder, the same one a section we authored uses — with the
 * original node handed in as `previous`, so every setting our vocabulary does
 * not name survives the edit.
 */
export function writeSection(section, blocks, deps = {}) {
  const { stamped, normalise, build, buildBox } = deps;
  if (typeof build !== 'function') throw new Error('writeSection needs sectionSchema.buildContentWidget');
  const index = indexById(section);
  const list = Array.isArray(blocks) ? blocks : [];

  const writeOne = (block, depth) => {
    if (!block || typeof block !== 'object') return null;
    const prior = block[BLOCK_ID_KEY] ? index.get(String(block[BLOCK_ID_KEY])) || null : null;

    /* AN OPAQUE BLOCK IS NEVER REBUILT. We could not read it, so we have
       nothing to write; the node it came from is the only truthful answer.
       One with no node behind it never existed on this page and is dropped
       rather than invented. */
    if (block.kind === OPAQUE_KIND) return prior;

    if (block.kind === 'container') {
      const kids = (Array.isArray(block.__children) ? block.__children : [])
        .map((kid) => writeOne(kid, depth + 1))
        .filter(Boolean);
      if (prior) {
        const before = readNode(prior, { stamped, normalise, depth });
        const priorKids = Array.isArray(prior.elements) ? prior.elements : [];
        const untouched = same(before, block)
          && kids.length === priorKids.length
          && kids.every((k, i) => k === priorKids[i]);
        if (untouched) return prior;
        /* A LEGACY `section` OR `column` KEEPS ITS OWN SETTINGS. Elementor's
           old row/column element does not have the flexbox container's layout
           keys, so writing ours onto it would publish keys the element does
           not have — dropped silently, and the author's change would do
           nothing. Its children still change; its own arranging is the one
           thing this editor does not offer for a legacy element, and the
           handoff says so. */
        if (prior.elType !== 'container') return { ...prior, elements: kids };
      }
      return buildBox({ ...block, __children: [] }, prior, depth, kids);
    }

    if (prior) {
      const before = readNode(prior, { stamped, normalise, depth });
      if (same(before, block)) return prior;
    }
    const { [BLOCK_ID_KEY]: _id, [BLOCK_EL_KEY]: _el, ...props } = block;
    return build(props, prior?.id || null, prior, depth);
  };

  const elements = list.map((b) => writeOne(b, 1)).filter(Boolean);
  const before = Array.isArray(section.elements) ? section.elements : [];
  const unchanged = elements.length === before.length && elements.every((n, i) => n === before[i]);
  return unchanged ? section : { ...section, elements };
}

export default {
  OPAQUE_KIND, BLOCK_ID_KEY, BLOCK_EL_KEY, OPAQUE_TYPE_KEY,
  kindOfWidgetType, readWidgetProps, readNode, readSectionBlocks, writeSection,
  genericRead, unwrap, indexById, containerStyleOf,
};
