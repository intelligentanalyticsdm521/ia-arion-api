/**
 * The container dialect, at any depth — our tree → the page engine's tree.
 * ---------------------------------------------------------------------------
 * D-156 / D-157 (DECISIONS_QUEUE, 2026-09-17). Brandon: "containers > widgets
 * get dragged or added to the containers. The containers have their own layout
 * settings and the widget sections within them have their own layout settings
 * … Header, drag that into this box and it's now its own section inside the
 * box, then a text field under it with Pick One, then cards."
 *
 * `containerEmitters.js` already draws our ELEVEN ARCHETYPES as containers.
 * What it cannot draw is a page the author built themselves: a box inside a box
 * inside a box. This module is that — one recursive function, no per-kind
 * emitters, no depth limit.
 *
 * ── THE SHAPE, BOTH WAYS ──────────────────────────────────────────────────
 * OUR node (what the Portal serialises, §11.12's tree):
 *
 *   container  { id, type:'container', layout:'row'|'column'|'grid',
 *                columns?, style?, children:[node] }
 *   widget     { id, type:'widget', kind, props, style? }
 *
 * THEIRS (Elementor's element tree, what `_elementor_data` holds):
 *
 *   { id, elType:'container', settings:{ container_type, flex_direction,
 *     flex_justify_content, flex_align_items, flex_gap, flex_wrap,
 *     content_width, min_height, padding, margin, background_* … },
 *     elements:[…], isInner }
 *   { id, elType:'widget', widgetType, settings:{…} }
 *
 * Every settings key below was read off the page engine's own source on the
 * dev site (`includes/elements/container.php`, `controls/groups/flex-container
 * .php`, `controls/groups/grid-container.php`, 2026-09-17), not guessed: the
 * flex group is named `flex` so its fields come out prefixed `flex_direction`,
 * `flex_justify_content`, `flex_align_items`, `flex_align_content`, `flex_gap`,
 * `flex_wrap`; the grid group is named `grid`, so `grid_columns_grid`,
 * `grid_rows_grid`, `grid_gaps`, `grid_auto_flow`.
 *
 * ── THE ROUND TRIP IS THE POINT ───────────────────────────────────────────
 * `treeToElementor` stamps every node with `_ia_node` (our id) and every widget
 * with `_ia_widget` (our kind), and `elementorToTree` reads them back. A page
 * we published and then read off the live site must come back as the tree we
 * sent — that is what `test/website-elementor-tree.test.mjs` asserts against
 * the dev WordPress, and it is the only way to know a publish is not quietly
 * losing a level of nesting.
 *
 * Pure: tree in, tree out. No fetch, no clock.
 */

import { mintId } from './elementorIds.js';
import { resolveWidget, UnsupportedWidgetError } from './elementorWidgets.js';

/** Our id, carried on the page so the tree can be read back. */
export const NODE_MARKER = '_ia_node';
/** Which of our widgets a page-engine widget is. */
export const WIDGET_MARKER = '_ia_widget';

const px = (n) => ({ unit: 'px', size: Number(n) || 0, sizes: [] });

const sides = (v) => ({
  unit: 'px',
  top: String(v?.top ?? 0), right: String(v?.right ?? 0),
  bottom: String(v?.bottom ?? 0), left: String(v?.left ?? 0),
  isLinked: false,
});

/* ══════════════════════════════════════════════════════════════════════════
   Our style → their settings
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The §11.8 `style` shape, in the page engine's words.
 *
 * ONLY what the author actually set. An absent key must stay absent: writing
 * `background_color: ''` over a container that has a picture behind it CLEARS
 * the picture, which is the wart §12.3 had to fix once already.
 *
 * Per-device overrides use the engine's own `_tablet` / `_mobile` suffixes,
 * the same mechanism its editor writes, so an author who opens the page on the
 * site sees the phone padding they typed here.
 */
export function styleToSettings(style) {
  if (!style || typeof style !== 'object') return {};
  const out = {};
  const layer = (s, suffix) => {
    if (!s || typeof s !== 'object') return;
    if (s.padding) out[`padding${suffix}`] = sides(s.padding);
    if (s.margin) out[`margin${suffix}`] = sides(s.margin);
    if (s.gap != null) out[`flex_gap${suffix}`] = px(s.gap);
    if (s.minHeight != null) out[`min_height${suffix}`] = px(s.minHeight);
    // "Hide on this device" is the engine's own three flags, one per device,
    // each carrying the class it adds. One line so the three cannot drift.
    if (s.hidden) {
      const device = suffix === '' ? 'desktop' : (suffix === '_tablet' ? 'tablet' : 'mobile');
      out[`hide_${device}`] = `hidden-${device}`;
    }
  };
  layer(style, '');
  layer(style.tablet, '_tablet');
  layer(style.phone, '_mobile');

  // The look — desktop only, because a border that changes on a phone is a
  // control nobody asked for and four more keys to keep in step.
  if (style.background) {
    out.background_background = 'classic';
    out.background_color = String(style.background);
  }
  if (style.border && (style.border.width || style.border.color)) {
    out.border_border = String(style.border.style || 'solid');
    if (style.border.width != null) {
      out.border_width = sides({
        top: style.border.width, right: style.border.width, bottom: style.border.width, left: style.border.width,
      });
      out.border_width.isLinked = true;
    }
    if (style.border.color) out.border_color = String(style.border.color);
  }
  if (style.radius != null) {
    out.border_radius = sides({ top: style.radius, right: style.radius, bottom: style.radius, left: style.radius });
    out.border_radius.isLinked = true;
  }
  if (style.shadow && style.shadow !== 'none') {
    out.box_shadow_box_shadow_type = 'yes';
    out.box_shadow_box_shadow = style.shadow === 'strong'
      ? { horizontal: 0, vertical: 12, blur: 32, spread: 0, color: 'rgba(11,28,36,0.22)' }
      : { horizontal: 0, vertical: 4, blur: 14, spread: 0, color: 'rgba(11,28,36,0.10)' };
  }
  return out;
}

/** Their settings → our style. The other half of the round trip. */
export function settingsToStyle(settings) {
  const s = settings || {};
  const readSides = (v) => (v && typeof v === 'object'
    ? {
      top: Number(v.top) || 0, right: Number(v.right) || 0,
      bottom: Number(v.bottom) || 0, left: Number(v.left) || 0,
    }
    : null);
  const layerFrom = (suffix) => {
    const out = {};
    const p = readSides(s[`padding${suffix}`]); if (p) out.padding = p;
    const m = readSides(s[`margin${suffix}`]); if (m) out.margin = m;
    const g = s[`flex_gap${suffix}`]; if (g && g.size != null) out.gap = Number(g.size);
    const h = s[`min_height${suffix}`]; if (h && h.size != null) out.minHeight = Number(h.size);
    return Object.keys(out).length ? out : null;
  };
  const style = layerFrom('') || {};
  const tablet = layerFrom('_tablet'); if (tablet) style.tablet = tablet;
  const phone = layerFrom('_mobile'); if (phone) style.phone = phone;
  if (s.background_color) style.background = String(s.background_color);
  if (s.border_border) {
    style.border = {
      style: String(s.border_border),
      width: Number(s.border_width?.top) || 0,
      ...(s.border_color ? { color: String(s.border_color) } : {}),
    };
  }
  if (s.border_radius?.top != null) style.radius = Number(s.border_radius.top) || 0;
  if (s.box_shadow_box_shadow_type === 'yes') {
    style.shadow = (Number(s.box_shadow_box_shadow?.blur) || 0) >= 24 ? 'strong' : 'soft';
  }
  return Object.keys(style).length ? style : undefined;
}

/* ══════════════════════════════════════════════════════════════════════════
   Layout → their settings
   ══════════════════════════════════════════════════════════════════════════ */

export const LAYOUTS = ['row', 'column', 'grid'];

/**
 * A container's own layout settings, in the engine's words.
 *
 * `isInner` is the engine's own flag for "this container is not a top-level
 * band", and it is decided by DEPTH here rather than by the caller, because
 * depth is the only thing that decides it and a caller that gets it wrong
 * produces a page whose sections cannot be dragged in its own editor.
 */
/* The engine's own words for "along the box's own direction" and "across it",
   turned into Elementor's option values, which are already CSS values. The ONE
   place this translation happens, which is the whole reason the Portal keeps
   its layout in `style` rather than in Elementor's spelling. Both tables are
   CLOSED: a word that is not in them is not published, because a value the
   page engine does not offer is a control that silently does nothing. */
const JUSTIFY_WORDS = {
  start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between',
};
const ALIGN_WORDS = {
  start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch',
};
/**
 * The tags a box may be drawn as.
 *
 * Elementor's `html_tag` also offers `nav` and `a (link)`; this list is the
 * RENDERER's (`Portal/src/builder/render.ts` `HTML_TAGS`), deliberately, so a
 * tag that draws as a `div` on the canvas cannot come out as something else on
 * the website. A tag out of a document is markup, and `<script>` is a tag, so
 * the list is closed at both ends.
 */
const HTML_TAGS = ['div', 'header', 'footer', 'main', 'article', 'section', 'aside'];
/** The four words `_flex_size` offers. A percentage is `custom` plus a width. */
const FLEX_SIZES = ['none', 'grow', 'shrink', 'custom'];

/**
 * A BOX'S ARRANGING, READ OUT OF §11.8's `style` — the one reader.
 *
 * The Portal keeps a box's layout in `style`, per device (§11.12.I: "`style`
 * won, on three counts"), and this is the single function that reads it. It
 * answers in the NODE's words — `layout`, `justify`, `align`, `wrap`,
 * `columns`, plus a `tablet` / `phone` layer when the author said something
 * different there — and `layoutToSettings` turns those into the page engine's
 * keys. Two functions, one each way; neither knows the other's vocabulary.
 *
 * Anything the author did not set is ABSENT, never defaulted here: the default
 * belongs to the emitter, which is the only place that knows what the page
 * engine already does when a key is missing.
 */
export function layoutFromStyle(style, props) {
  const layer = (s) => {
    if (!s || typeof s !== 'object') return null;
    const out = {};
    if (s.direction === 'row' || s.direction === 'grid' || s.direction === 'column') out.layout = s.direction;
    if (s.columns != null) out.columns = Number(s.columns);
    if (s.justify && JUSTIFY_WORDS[s.justify]) out.justify = JUSTIFY_WORDS[s.justify];
    if (s.alignItems && ALIGN_WORDS[s.alignItems]) out.align = ALIGN_WORDS[s.alignItems];
    // A BOOLEAN, and both of its values matter. The Inspector's tick box
    // DELETES the key when it is cleared, so "absent" is the canvas's `nowrap`
    // — which is why the desktop layer always answers and a missing key here
    // is not "say nothing" but "no wrap". An author who turns wrapping off and
    // sees the change on the canvas must see it on their website too, and that
    // is the whole of audit point 1.
    if (s.wrap !== undefined) out.wrap = s.wrap ? 'wrap' : 'nowrap';
    return Object.keys(out).length ? out : null;
  };
  const base = layer(style) || {};
  if (style && typeof style === 'object') {
    // Only a ROW wraps, so only a row is told not to. A `flex_wrap` on a
    // column is a key that means nothing, and keys that mean nothing are how a
    // settings object stops being readable.
    if (base.layout === 'row' && base.wrap === undefined) base.wrap = 'nowrap';
    const tablet = layer(style.tablet); if (tablet) base.tablet = tablet;
    const phone = layer(style.phone); if (phone) base.phone = phone;
  }
  const tag = String(props?.html_tag || '').trim().toLowerCase();
  if (HTML_TAGS.includes(tag)) base.htmlTag = tag;
  return base;
}

/**
 * A container's own layout settings, in the engine's words.
 *
 * PER DEVICE, on the engine's own `_tablet` / `_mobile` suffixes — the same
 * mechanism `styleToSettings` uses for padding, and the reason a box the
 * author made a column on a phone is a column on their website.
 *
 * THE PHONE RULE IS THE CANVAS'S. `render.ts`'s stylesheet stacks EVERY row at
 * 720px and narrower (`.bx-box-row { flex-direction: column !important }`), so
 * a row published without that rule would read side-by-side on a phone and
 * stacked in the builder — one document, two answers. The rule travels as
 * `flex_direction_mobile`, and an author who said something else for phones
 * still wins, because their own layer is written after it.
 */
export function layoutToSettings(node, depth) {
  const layout = LAYOUTS.includes(node.layout) ? node.layout : 'column';
  const top = depth === 0;
  const base = {
    container_type: layout === 'grid' ? 'grid' : 'flex',
    content_width: node.width === 'full' ? 'full' : 'boxed',
    ...(node.htmlTag && HTML_TAGS.includes(String(node.htmlTag)) ? { html_tag: String(node.htmlTag) } : {}),
  };
  if (layout === 'grid') {
    return {
      ...base,
      grid_columns_grid: { unit: 'fr', size: Math.max(1, Number(node.columns) || 2), sizes: [] },
      grid_rows_grid: { unit: 'fr', size: 1, sizes: [] },
      grid_gaps: { unit: 'px', size: 24, column: '24', row: '24', isLinked: true },
      grid_auto_flow: 'row',
      // One column on a phone, for the same reason a row stacks there.
      grid_columns_grid_mobile: { unit: 'fr', size: 1, sizes: [] },
      ...deviceLayout(node.tablet, '_tablet'),
      ...deviceLayout(node.phone, '_mobile'),
    };
  }
  return {
    ...base,
    flex_direction: layout === 'row' ? 'row' : 'column',
    ...(layout === 'row' ? { flex_align_items: 'stretch' } : {}),
    ...(node.justify && isOffered(JUSTIFY_WORDS, node.justify) ? { flex_justify_content: String(node.justify) } : {}),
    ...(node.align && isOffered(ALIGN_WORDS, node.align) ? { flex_align_items: String(node.align) } : {}),
    ...(node.wrap === 'wrap' || node.wrap === 'nowrap' ? { flex_wrap: String(node.wrap) } : {}),
    ...(top ? { padding: sides({ top: 64, right: 20, bottom: 64, left: 20 }) } : {}),
    flex_gap: px(24),
    ...(layout === 'row' ? { flex_direction_mobile: 'column' } : {}),
    ...deviceLayout(node.tablet, '_tablet'),
    ...deviceLayout(node.phone, '_mobile'),
  };
}

/** Is this already one of the values the page engine offers? */
function isOffered(table, value) {
  return Object.values(table).includes(String(value));
}

/** One device's layout overrides, on the engine's own suffix. */
function deviceLayout(layer, suffix) {
  if (!layer || typeof layer !== 'object') return {};
  const out = {};
  if (layer.layout === 'row' || layer.layout === 'column') out[`flex_direction${suffix}`] = layer.layout;
  if (layer.justify && isOffered(JUSTIFY_WORDS, layer.justify)) out[`flex_justify_content${suffix}`] = String(layer.justify);
  if (layer.align && isOffered(ALIGN_WORDS, layer.align)) out[`flex_align_items${suffix}`] = String(layer.align);
  if (layer.wrap === 'wrap' || layer.wrap === 'nowrap') out[`flex_wrap${suffix}`] = String(layer.wrap);
  if (layer.columns != null) {
    out[`grid_columns_grid${suffix}`] = { unit: 'fr', size: Math.max(1, Number(layer.columns) || 1), sizes: [] };
  }
  return out;
}

/**
 * HOW A CHILD SITS IN ITS PARENT — the flex ITEM controls, not the container's.
 *
 * BUILDER_WIDGET_CATALOG_2026-09-17 E.3.3: "a nested column layout that only
 * sets `width: {unit:'%'}` will not survive a client editing it in Elementor".
 * The page engine's own group for this is `_flex` (Flex Item), and its keys are
 * `_flex_size`, `_flex_grow`, `_flex_shrink`, `_flex_align_self`, `_flex_order`
 * — leading underscore, because they belong to the element's Advanced stack
 * rather than to its own settings. A node that says nothing about how it sits
 * writes none of them.
 *
 * ── `node.width` MEANS ONE THING ──────────────────────────────────────────
 * It used to mean two: `layoutToSettings` read it as `content_width` (boxed or
 * full) and this function read the SAME field as a percentage flex size, so
 * `width: 48` on a top-level node was a boxed section and a 48% child at once
 * (audit point 1, "two meanings on one key"). Now `width` is content width
 * only, and how a node sits is `flex_size` (a number = that many percent, or
 * one of none | grow | shrink | custom), `flex_grow` and `flex_shrink`.
 */
export function flexItemSettings(node, { widget = false } = {}) {
  const out = {};
  const size = node.flex_size;
  if (typeof size === 'number' && Number.isFinite(size)) {
    // A percentage is `_flex_size: 'custom'` plus the width itself — the
    // engine's own pairing; the width alone is the thing its editor drops. A
    // CONTAINER carries that width on `width`; a WIDGET has no `width` control
    // at all and spells the same thing `_element_width: 'initial'` plus
    // `_element_custom_width` (catalogue A.1, the Advanced tab every widget
    // carries). Writing `width` on a widget is a key nothing reads.
    out._flex_size = 'custom';
    if (widget) {
      out._element_width = 'initial';
      out._element_custom_width = { unit: '%', size, sizes: [] };
    } else {
      out.width = { unit: '%', size, sizes: [] };
    }
  } else if (FLEX_SIZES.includes(String(size))) {
    out._flex_size = String(size);
  }
  if (node.flex_grow != null) out._flex_grow = Number(node.flex_grow);
  if (node.flex_shrink != null) out._flex_shrink = Number(node.flex_shrink);
  if (node.alignSelf) {
    const self = ALIGN_WORDS[node.alignSelf] || String(node.alignSelf);
    if (isOffered(ALIGN_WORDS, self)) out._flex_align_self = self;
  }
  if (node.order != null) out._flex_order = String(node.order);
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   Down: our tree → theirs
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * @param {object} node   our container or widget
 * @param {object} ctx    { seed, allowPro, iaWidgets, emailTo, swapped:[] }
 * @param {number} depth
 * @returns {object} one page-engine node
 */
export function treeToElementor(node, ctx = {}, depth = 0) {
  if (!node || typeof node !== 'object') {
    throw new UnsupportedWidgetError('An empty node cannot be published.', null);
  }
  const seed = ctx.seed || 'tree';
  const id = mintId(seed, String(node.id || `${depth}`));

  if (node.type === 'widget') {
    const { node: built, swapped } = resolveWidget(node.kind, node.props || {}, {
      allowPro: ctx.allowPro !== false,
      iaWidgets: ctx.iaWidgets ?? null,
      seed, nodeId: id, emailTo: ctx.emailTo,
    });
    if (swapped && Array.isArray(ctx.swapped)) ctx.swapped.push({ ...swapped, nodeId: node.id });
    return {
      ...built,
      settings: {
        ...built.settings,
        [NODE_MARKER]: String(node.id || id),
        ...flexItemSettings(node, { widget: true }),
        ...styleToSettings(node.style),
      },
    };
  }

  if (node.type !== 'container') {
    throw new UnsupportedWidgetError(`A node must be a box or a widget, not "${node.type}".`, node.type);
  }

  const children = Array.isArray(node.children) ? node.children : [];
  return {
    id,
    elType: 'container',
    settings: {
      [NODE_MARKER]: String(node.id || id),
      ...layoutToSettings(node, depth),
      ...(depth > 0 ? flexItemSettings(node) : {}),
      ...styleToSettings(node.style),
      ...(depth === 0 && node.label ? { _title: String(node.label) } : {}),
    },
    elements: children.map((c) => treeToElementor(c, ctx, depth + 1)),
    isInner: depth > 0,
  };
}

/**
 * A whole page: our top-level nodes → the `_elementor_data` array.
 *
 * Returns the array AND what was swapped, because a caller that publishes and
 * says nothing about a card that became a box is reporting a success it did
 * not have (`reference_catch_swallow_report_success`).
 */
export function pageToElementor(nodes, ctx = {}) {
  const swapped = [];
  const data = (Array.isArray(nodes) ? nodes : []).map((n) => treeToElementor(n, { ...ctx, swapped }, 0));
  return { data, swapped };
}

/* ══════════════════════════════════════════════════════════════════════════
   Up: their tree → ours
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Read a page-engine node back as our tree.
 *
 * Tolerant on purpose, and in ONE direction: a node we did not write (a client
 * built it on the site itself, or it is a legacy `section`/`column` from a page
 * built before 2026-09-16) comes back as a container with whatever children it
 * has, never as an error and never dropped. What we cannot reconstruct is the
 * widget's PROPS — those live in the widget's own settings and belong to each
 * widget's codec — so a widget comes back with its kind, its id and the
 * settings verbatim, which is exactly what the round-trip assertion needs.
 */
export function elementorToTree(node) {
  if (!node || typeof node !== 'object') return null;
  const id = String(node.settings?.[NODE_MARKER] || node.id || '');
  if (node.elType === 'widget') {
    return {
      id,
      type: 'widget',
      kind: String(node.settings?.[WIDGET_MARKER] || node.widgetType || ''),
      widgetType: String(node.widgetType || ''),
      settings: node.settings || {},
      ...(settingsToStyle(node.settings) ? { style: settingsToStyle(node.settings) } : {}),
    };
  }
  // `section` and `column` land here too: a legacy page reads as boxes.
  const s = node.settings || {};
  // A box that IS a widget the plan could not have (the card drawn out of free
  // widgets). It says which widget it stands for, so a read-back reports the
  // author's card and not five loose things they never added.
  const swappedFor = s[WIDGET_MARKER] ? String(s[WIDGET_MARKER]) : null;
  const layout = s.container_type === 'grid'
    ? 'grid'
    : (s.flex_direction === 'row' ? 'row' : 'column');
  return {
    id,
    type: 'container',
    layout,
    ...(swappedFor ? { swappedFor } : {}),
    // The other half of `layoutToSettings`. A box read back off a live site
    // says how it arranges its children, or the round trip proves only that
    // the SHAPE survived while an author's alignment quietly did not.
    ...(s.flex_justify_content ? { justify: String(s.flex_justify_content) } : {}),
    ...(s.flex_align_items ? { align: String(s.flex_align_items) } : {}),
    ...(s.flex_wrap ? { wrap: String(s.flex_wrap) } : {}),
    ...(s.html_tag && HTML_TAGS.includes(String(s.html_tag)) ? { htmlTag: String(s.html_tag) } : {}),
    ...(s.content_width === 'full' ? { width: 'full' } : {}),
    ...(settingsToStyle(s) ? { style: settingsToStyle(s) } : {}),
    children: (node.elements || []).map(elementorToTree).filter(Boolean),
  };
}

/** The whole page, back. */
export function elementorToPage(data) {
  return (Array.isArray(data) ? data : []).map(elementorToTree).filter(Boolean);
}

/**
 * The shape of a tree, as one string per line, for an assertion a person can
 * read: `container(column) > container(row) > widget(card)`.
 */
export function outline(node, depth = 0) {
  if (!node) return [];
  const label = node.type === 'widget' || node.elType === 'widget'
    ? `widget(${node.kind || node.widgetType})`
    : (node.swappedFor
      ? `container(${node.swappedFor})`
      : `container(${node.layout || (node.settings?.flex_direction === 'row' ? 'row' : 'column')})`);
  const kids = node.children || node.elements || [];
  return [`${'  '.repeat(depth)}${label}`, ...kids.flatMap((c) => outline(c, depth + 1))];
}

/* ══════════════════════════════════════════════════════════════════════════
   The Portal's document, as a tree
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * A `BuilderDocument` (sections → columns → widgets) read as the tree.
 *
 * The Portal's engine is growing nested containers (§11.12, stream A); until
 * every document carries them, this is the ONE reader — and it stays the one
 * reader afterwards, because a section that already has `children` is just a
 * container and is taken verbatim. A section with columns becomes
 * container(column){ container(row){ container(column){ widgets } } }, which
 * is the same tree its canvas draws.
 */
export function documentToTree(doc) {
  const sections = Array.isArray(doc?.sections) ? doc.sections : [];
  return sections.map((sec) => {
    if (Array.isArray(sec.children)) {
      const own = layoutFromStyle(sec.style, sec.props);
      return {
        id: sec.id,
        type: 'container',
        ...own,
        layout: sec.layout || own.layout || 'column',
        style: sec.style,
        label: sec.label,
        ...(sec.width === 'full' ? { width: 'full' } : {}),
        children: sec.children,
      };
    }
    const columns = Array.isArray(sec.columns) ? sec.columns : [];
    /**
     * ONE NODE OF THE PORTAL'S TREE (D-156, integration).
     *
     * A widget whose kind is `container` HOLDS CHILDREN, and how it arranges
     * them lives in its `style` — `direction` (row | column | grid),
     * `columns`, `justify`, `alignItems`, `wrap`, per device — which is the one
     * place §11.8's cascade already writes. `layoutFromStyle` reads it, once,
     * and `layoutToSettings` turns the answer into the page engine's own keys:
     * the single translation this repo does, and the reason the Portal does
     * not have to speak Elementor at all.
     *
     * A box's TAG is not styling and is not in `style`: it is `props.html_tag`,
     * the one Elementor-spelled key the renderer reads (`render.ts`), and it
     * travels with the layout because it is what the box is DRAWN as.
     *
     * Recursive, with no depth limit of its own: `treeToElementor` counts the
     * depth and decides `isInner` from it, and a document is bounded by the
     * engine's own guard long before this.
     */
    const asNode = (w, depth) => {
      if (w && w.kind === 'container' && Array.isArray(w.children)) {
        const own = layoutFromStyle(w.style, w.props);
        return {
          id: w.id,
          type: 'container',
          ...own,
          layout: own.layout || 'column',
          ...(w.style ? { style: w.style } : {}),
          children: (depth > 24 ? [] : w.children.map((k) => asNode(k, depth + 1))),
        };
      }
      return { id: w.id, type: 'widget', kind: w.kind, props: w.props || {}, style: w.style };
    };
    const asWidget = (w) => asNode(w, 0);
    const inner = columns.length > 1
      ? [{
        id: `${sec.id}-row`,
        type: 'container',
        layout: 'row',
        children: columns.map((c) => ({
          id: c.id, type: 'container', layout: 'column', children: (c.widgets || []).map(asWidget),
        })),
      }]
      : (columns[0]?.widgets || []).map(asWidget);
    const secOwn = layoutFromStyle(sec.style, sec.props);
    return {
      id: sec.id,
      type: 'container',
      ...secOwn,
      // A section IS a container and is drawn as a column of its rows; its own
      // `layout` field counts COLUMNS (1 | 2 | 3), which the row below already
      // expresses, so it is not a direction and does not become one.
      layout: 'column',
      label: sec.label,
      ...(sec.width === 'full' ? { width: 'full' } : {}),
      ...(sec.style ? { style: sec.style } : {}),
      children: inner,
    };
  });
}

/**
 * Is this top-level node one of OURS, built as a tree?
 *
 * The archetypes are known by their `ia:<kind>:…` handle on `_title`; a tree
 * section has no archetype to name, so it is known by the node stamp every one
 * of its boxes carries. `sectionSchema.reduceToSectionList` asks this so a page
 * we published does not read back as "custom — built on the site", which is
 * what a client is told about somebody ELSE's work.
 */
export function isIaTreeSection(node) {
  return !!(node && node.elType === 'container' && node.settings && node.settings[NODE_MARKER]);
}

export default {
  treeToElementor, pageToElementor, elementorToTree, elementorToPage, isIaTreeSection,
  documentToTree, styleToSettings, settingsToStyle, layoutToSettings, layoutFromStyle,
  outline, flexItemSettings, NODE_MARKER, WIDGET_MARKER,
};
