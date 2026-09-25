/**
 * The box that sets EVERYTHING a box can set — one shape, two readers.
 *
 * D-156 conformance. `scripts/dev/extract-container-controls.mjs` runs the
 * emitter over this node to decide which of the page engine's controls to
 * extract, and `test/website-container-controls.test.mjs` runs the same
 * emitter over the same node to assert every key it produced is one of them.
 * One input, so the fixture cannot be extracted from a smaller node than the
 * test asserts against — which is the only way the pin can be trusted.
 *
 * It is a ROW, because a row is the layout with the most keys (a grid's four
 * are added separately below), and it carries a tablet and a phone layer
 * because per-device is where audit point 1's losses were.
 */
import { treeToElementor, layoutToSettings, flexItemSettings, styleToSettings } from '../../lib/websiteBuilder/elementorTree.js';

export const MAXIMAL_CONTAINER = {
  id: 'pin-row',
  type: 'container',
  layout: 'row',
  direction: 'row-reverse',
  width: 'full',
  contentWidthSize: 80,
  htmlTag: 'section',
  justify: 'space-evenly',
  align: 'center',
  wrap: 'wrap',
  flex_size: 48,
  flex_grow: 1,
  flex_shrink: 0,
  alignSelf: 'stretch',
  order: 'start',
  tablet: {
    layout: 'column', direction: 'column-reverse', justify: 'center', align: 'flex-start',
    wrap: 'nowrap', contentWidthSize: 70, width: 'full',
  },
  phone: { layout: 'column', justify: 'flex-start', align: 'stretch', wrap: 'wrap', columns: 1 },
  style: {
    padding: { top: 64, right: 20, bottom: 64, left: 20 },
    margin: { top: 0, right: 0, bottom: 24, left: 0 },
    gap: 24,
    /* THE ROW HALF OF THE GAPS CONTROL (B-168, family F0). With it set, the
       chain is UNLINKED and the emitter writes two numbers; without it, one
       answers for both. Both paths are exercised — the grid below is linked. */
    rowGap: 12,
    minHeight: 320,
    border: { style: 'solid', width: 1, color: '#DCE4E8' },
    radius: 10,
    shadow: 'strong',
    // All three "hide on this device" flags, because each is its own control.
    hidden: true,
    /* THE REST OF THE REFERENCE EDITOR'S CONTAINER PANEL (B-168, family F0).
       Everything an author can now set on a box, so the pin extracts — and the
       test asserts against — the keys the emitter can actually produce. */
    contentWidth: 'full',
    width: 80,
    overflow: 'hidden',
    background: {
      type: 'classic', color: '#F4F7F8', image: 'https://example.invalid/bg.png',
      position: 'top center', repeat: 'no-repeat', size: 'cover',
    },
    overlay: {
      type: 'gradient', color: '#0B1C24', colorB: '#0C4A60', gradient: 'linear', angle: 135,
      image: 'https://example.invalid/overlay.png', opacity: 0.4, blend: 'multiply',
    },
    shapeTop: {
      shape: 'waves', color: '#FFFFFF', height: 80, width: 120,
      flip: true, invert: true, aboveContent: true,
    },
    shapeBottom: { shape: 'tilt', color: '#F4F7F8', height: 60, width: 100 },
    alignSelf: 'center',
    order: 2,
    selfWidth: 48,
    position: 'absolute',
    zIndex: 5,
    cssId: 'prices',
    cssClasses: 'tight two-up',
    customCss: 'selector { outline: none }',
    sticky: 'top',
    stickyOn: ['desktop', 'tablet', 'phone'],
    stickyOffset: 16,
    tablet: {
      padding: { top: 40, right: 16, bottom: 40, left: 16 },
      gap: 16, rowGap: 8, minHeight: 240, hidden: true,
      overflow: 'auto', zIndex: 4, alignSelf: 'start', order: 1,
    },
    phone: {
      padding: { top: 24, right: 12, bottom: 24, left: 12 },
      gap: 12, minHeight: 180, hidden: true,
      overflow: 'hidden', zIndex: 3, alignSelf: 'end', order: 3,
    },
  },
};

/**
 * THE SECOND BACKGROUND SHAPES, which the maximal box cannot hold at once.
 *
 * A background is ONE of four, so a single node can only exercise one of them.
 * These three are run through the emitter by the extract script and the pin
 * test in exactly the same way, so `background_gradient_type`,
 * `background_video_link` and `background_slideshow_gallery` are pinned rather
 * than being three keys nobody checks.
 */
export const BACKGROUND_VARIANTS = [
  { type: 'gradient', color: '#0B1C24', colorB: '#0C4A60', gradient: 'radial', angle: 45 },
  { type: 'video', color: '#0B1C24', videoUrl: 'https://example.invalid/film.mp4', image: 'https://example.invalid/still.png' },
  { type: 'slideshow', color: '#0B1C24', images: ['https://example.invalid/a.png', 'https://example.invalid/b.png'] },
].map((background, i) => ({
  id: `pin-bg-${i}`, type: 'container', layout: 'column', style: { background },
}));

/** The grid's own four, which a row never emits. */
export const MAXIMAL_GRID = {
  id: 'pin-grid',
  type: 'container',
  layout: 'grid',
  columns: 3,
  rows: 2,
  autoFlow: 'column',
  phone: { columns: 1, rows: 1, autoFlow: 'row' },
  // Linked gaps — the other half of the chain the row above unlinks.
  style: { gap: 24, tablet: { gap: 16 } },
};

/**
 * Keys we write that are NOT controls of the container element, each with the
 * reason it is allowed through. A key that is neither a control nor on this
 * list fails the pin.
 */
export const SETTINGS_NOT_CONTROLS = [
  // Our own stamps. `_ia_node` is how a published page reads back as the tree
  // we sent; `_ia_widget` / `_ia_swapped` say which of our widgets a box
  // stands for when the plan could not have the real one.
  '_ia_node',
  '_ia_widget',
  '_ia_swapped',
  // Elementor's own element LABEL. It is not a registered control of the
  // container element (it is set on the element, and its editor shows it as
  // the layer name), and it carries our `ia:<kind>:…` handle.
  '_title',
];

/** Every settings key the emitter produces for one node, deduped and sorted. */
export function emittedContainerSettings(node) {
  const published = treeToElementor({ ...node, label: 'Pinned' }, { allowPro: true, seed: 'pin' }, 0);
  const inner = treeToElementor({ ...node, id: `${node.id}-inner` }, { allowPro: true, seed: 'pin' }, 1);
  const keys = new Set([
    ...Object.keys(published.settings),
    ...Object.keys(inner.settings),
    // And the three functions on their own, so a key that only a deeper or a
    // grid-shaped call can produce is still covered.
    ...Object.keys(layoutToSettings(node, 1)),
    ...Object.keys(layoutToSettings(MAXIMAL_GRID, 1)),
    ...Object.keys(flexItemSettings(node)),
    ...Object.keys(styleToSettings(node.style, { container: true })),
    /* The three backgrounds one node cannot hold at once (B-168, family F0).
       Run through the same emitter, so their keys are extracted and pinned
       exactly like every other one rather than being the three nobody checks. */
    ...BACKGROUND_VARIANTS.flatMap((v) => Object.keys(styleToSettings(v.style, { container: true }))),
  ]);
  return [...keys].sort();
}
