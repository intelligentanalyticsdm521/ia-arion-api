/**
 * lib/websiteBuilder/families/index.js - THE ONE INDEX, arion side.
 *
 * BUILDER_FULL_WIDGET_PLAN_2026-09-19 section C.1. Ten family folders, ten
 * agents, and exactly one file that knows all ten exist. `elementorWidgets.js`
 * spreads FAMILY_EMITTERS into ELEMENTOR_WIDGETS and gains nothing else; after
 * that no family agent ever opens that 40 KB file again.
 *
 * All ten folders exist from the first commit, every one of them exporting an
 * empty map, because an index that grows an import per agent is an index every
 * agent conflicts in.
 *
 * It decides nothing. It merges, and it throws when two families claim the same
 * kind - a silently-won collision publishes a widget as something else on a
 * customer's live website.
 */
import { EMITTERS as CONTAINER } from './container/emitters.js';
import { EMITTERS as F1_WORDS } from './f1-words/emitters.js';
import { EMITTERS as F2_PICTURES } from './f2-pictures/emitters.js';
import { EMITTERS as F3_BUTTONS_ICONS_PANELS } from './f3-buttons-icons-panels/emitters.js';
import { EMITTERS as F4_MOVING } from './f4-moving/emitters.js';
import { EMITTERS as F5_SLIDERS_REVIEWS } from './f5-sliders-reviews/emitters.js';
import { EMITTERS as F6_MONEY } from './f6-money/emitters.js';
import { EMITTERS as F7_DATA_LISTS } from './f7-data-lists/emitters.js';
import { EMITTERS as F8_CONTACT_FURNITURE } from './f8-contact-furniture/emitters.js';
import { EMITTERS as IA } from './ia/emitters.js';

/** Every family, by its folder name. */
export const FAMILIES = [
  ['container', CONTAINER],
  ['f1-words', F1_WORDS],
  ['f2-pictures', F2_PICTURES],
  ['f3-buttons-icons-panels', F3_BUTTONS_ICONS_PANELS],
  ['f4-moving', F4_MOVING],
  ['f5-sliders-reviews', F5_SLIDERS_REVIEWS],
  ['f6-money', F6_MONEY],
  ['f7-data-lists', F7_DATA_LISTS],
  ['f8-contact-furniture', F8_CONTACT_FURNITURE],
  ['ia', IA],
];

/** The folder each kind came from - for the collision message and the tests. */
export const FAMILY_OF_KIND = {};

/** Every family's rows, merged. THE one line elementorWidgets.js spreads. */
export const FAMILY_EMITTERS = {};

for (const [name, map] of FAMILIES) {
  for (const [kind, row] of Object.entries(map || {})) {
    if (FAMILY_OF_KIND[kind]) {
      throw new Error(
        `Two families publish the widget "${kind}": ${FAMILY_OF_KIND[kind]} and ${name}. `
        + 'One kind, one family - see lib/websiteBuilder/families/index.js.');
    }
    FAMILY_OF_KIND[kind] = name;
    FAMILY_EMITTERS[kind] = row;
  }
}

/**
 * THE CONTRACT EVERY FAMILY TEST ASKS ABOUT, on this side: a row is complete.
 *
 * A row with no `widgetType` publishes a node the page engine cannot draw, and
 * a row with no `settings` publishes an empty one. Both are a blank band on a
 * live page with a green toast over it.
 */
export function emitterContract() {
  const bad = [];
  for (const [name, map] of FAMILIES) {
    for (const [kind, row] of Object.entries(map || {})) {
      if (!row || typeof row.widgetType !== 'string' || !row.widgetType) bad.push(`${name}/${kind}: no widgetType`);
      /* A ROW PUBLISHES EITHER SETTINGS OR A WHOLE NODE, NEVER BOTH.
         `settings(props, ctx)` is one widget's own settings; `node(props, ctx)`
         is a COMPOSITION - a tree of free widgets standing in for one of ours
         that the page engine has no widget for. Book Now is the first family
         row of that shape (a shortcode where the site has one, a real Elementor
         button where it has not) and this contract only knew the first kind, so
         it called a legitimate composition incomplete.
         `website-elementor-tree.test.mjs` asserts EXACTLY ONE of the two, which
         is the other half of the same rule and the reason this is `!==` on a
         count and not two independent checks. */
      else if (Number(typeof row.settings === 'function') + Number(typeof row.node === 'function') !== 1) {
        bad.push(`${name}/${kind}: needs exactly one of settings(props, ctx) and node(props, ctx)`);
      }
      else if (!row.tier) bad.push(`${name}/${kind}: no tier`);
      else if (!row.label) bad.push(`${name}/${kind}: no label`);
    }
  }
  return bad;
}

export default FAMILY_EMITTERS;
