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
  width: 'full',
  htmlTag: 'section',
  justify: 'space-between',
  align: 'center',
  wrap: 'wrap',
  flex_size: 48,
  flex_grow: 1,
  flex_shrink: 0,
  alignSelf: 'stretch',
  order: 'start',
  tablet: { layout: 'column', justify: 'center', align: 'flex-start', wrap: 'nowrap' },
  phone: { layout: 'column', justify: 'flex-start', align: 'stretch', wrap: 'wrap', columns: 1 },
  style: {
    padding: { top: 64, right: 20, bottom: 64, left: 20 },
    margin: { top: 0, right: 0, bottom: 24, left: 0 },
    gap: 24,
    minHeight: 320,
    background: '#F4F7F8',
    border: { style: 'solid', width: 1, color: '#DCE4E8' },
    radius: 10,
    shadow: 'strong',
    // All three "hide on this device" flags, because each is its own control.
    hidden: true,
    tablet: { padding: { top: 40, right: 16, bottom: 40, left: 16 }, gap: 16, minHeight: 240, hidden: true },
    phone: { padding: { top: 24, right: 12, bottom: 24, left: 12 }, gap: 12, minHeight: 180, hidden: true },
  },
};

/** The grid's own four, which a row never emits. */
export const MAXIMAL_GRID = {
  id: 'pin-grid',
  type: 'container',
  layout: 'grid',
  columns: 3,
  phone: { columns: 1 },
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
    ...Object.keys(styleToSettings(node.style)),
  ]);
  return [...keys].sort();
}
