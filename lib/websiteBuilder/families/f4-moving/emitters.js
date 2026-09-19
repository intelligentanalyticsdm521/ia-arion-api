/**
 * families/f4-moving/emitters.js - what the f4-moving family PUBLISHES.
 *
 * BUILDER_FULL_WIDGET_PLAN_2026-09-19 section C.1. One row per widget kind,
 * the same shape ELEMENTOR_WIDGETS has always had, so `elementorWidgets.js`
 * spreads this map and nothing else in that file changes:
 *
 *   kind: {
 *     widgetType,          // what the WEBSITE calls it - the engine's own slug
 *     tier,                // FREE | PRO | `ia:<product>`
 *     label,               // for the message when a plan cannot carry it
 *     settings(props, ctx) // the widget's own settings object
 *     fallback(props, ctx) // OPTIONAL - real content to publish instead
 *   }
 *
 * A settings key the engine does not have is DROPPED SILENTLY on publish and
 * the author's change does nothing on the live page. So every key here must be
 * in the widget's list in the Portal's test/fixtures/WIDGET_SETTINGS_KEYS.json,
 * and this family's test asserts it.
 *
 * Empty until the family's first widget lands. Nothing in here ever opens
 * elementorWidgets.js or another family's folder.
 */

export const EMITTERS = {};

export default EMITTERS;
