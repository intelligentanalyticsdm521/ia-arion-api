/**
 * families/container/emitters.js - what the container family PUBLISHES.
 *
 * BUILDER_FULL_WIDGET_PLAN_2026-09-19 section C.1. One row per widget kind,
 * the same shape ELEMENTOR_WIDGETS has always had, so `elementorWidgets.js`
 * spreads this map and nothing else in that file changes.
 *
 * -- IT IS EMPTY, AND IT HAS TO STAY EMPTY ---------------------------------
 * A container is not a WIDGET. In the page engine's own tree it is
 * `{ elType: 'container', settings: {...}, elements: [...] }` - it has no
 * `widgetType` at all, it holds children, and it is written recursively. Every
 * row in this map has to carry a `widgetType` and a flat `settings(props,
 * ctx)`, and `emitterContract()` fails the build on a row that does not, which
 * is exactly right: a container cannot be one.
 *
 * So the container's emitter is `../../elementorTree.js`, which is where the
 * recursive writer already lived:
 *
 *   layoutToSettings(node, depth)     the Layout tab - container_type,
 *                                     content_width, width / boxed_width,
 *                                     min_height, flex_*, grid_*, html_tag
 *   styleToSettings(style, {container: true})
 *                                     margin, padding, the two gaps, the three
 *                                     hide flags, z_index, _flex_align_self,
 *                                     _flex_order - per device, on the engine's
 *                                     own _tablet / _mobile suffixes
 *   containerStyleSettings(style)     the Style tab and the rest of Advanced -
 *                                     the four backgrounds, the overlay, the
 *                                     two shape dividers, overflow, position,
 *                                     _element_id, css_classes, custom_css,
 *                                     sticky
 *
 * Every key those three can produce is pinned against the page engine's own
 * registry by `test/website-container-controls.test.mjs`, which RUNS the
 * emitter over `test/fixtures/container-controls-input.mjs` rather than reading
 * it - so a key we invent fails the build instead of being dropped silently on
 * publish. That pin caught `overflow_tablet` on 2026-09-19: the engine's
 * `overflow` is not a per-device control.
 *
 * Nothing in here ever opens elementorWidgets.js or another family's folder.
 */

export const EMITTERS = {};

export default EMITTERS;
