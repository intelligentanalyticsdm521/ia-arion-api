// test/website-builder-f3-buttons-icons-panels.test.js — what F3 PUBLISHES to
// a live website, and the two ways it could silently do nothing.
//
// B-168, family F3 (buttons, icons and panels). Five Elementor PRO widgets:
// Share Buttons, Call to Action, Flip Box, Facebook Embed and Facebook Page.
//
// THE TWO FAILURES THIS EXISTS TO CATCH, both of which end the same way — a
// green toast over a page that did not change:
//
//   1. A SETTINGS KEY THE ENGINE DOES NOT HAVE. The page engine drops it on
//      publish without a word. `test/fixtures/elementor-widget-controls.json`
//      is the machine truth, written by `scripts/dev/extract-widget-controls.mjs`
//      straight out of BUILDER_WIDGET_CATALOG_2026-09-17.pro.json, and the
//      extractor REFUSES to write a fixture that blesses an unknown key — so a
//      bad key fails before this file even runs. What is asserted here is the
//      other half: that the keys really are emitted, on every row, every time.
//
//   2. A VALUE THE CONTROL DOES NOT OFFER. A select whose value is not on its
//      option list behaves exactly like a key that does not exist. Every
//      `choice()` in the emitters is checked against the engine's own list.
//
// ── MUTATION CHECKS (run on 2026-09-19, not assumed) ──────────────────────
//   · `alignment: 'middle'` on Share Buttons → "every select value is one the
//     engine offers" went red: 'share_buttons.alignment = "middle" is not one
//     of left, center, right, justify'. Restored, green.
//   · `flip_direction` deleted from Flip Box's settings → both key tests went
//     red ('flip_box stopped emitting flip_direction', and the two-way key
//     comparison). Restored, green. That is the ASSERT-PRESENCE half: a key
//     quietly disappearing is as bad as a wrong one.
//   · `min-height` renamed to `min_height` on Call to Action → the EXTRACTOR
//     refused to write the fixture: 'not controls of that widget — min_height'.
//     Restored, it wrote.
//   · `tier: 'free'` on Flip Box → "all five are PRO" went red. Restored.
//
//   A FIFTH MUTATION FAILED TO GO RED, and is why the option lists further down
//   are in this file rather than read off the pinned fixture: with `alignment`
//   checked against `elementor-widget-controls.json`, 'middle' published clean,
//   because the extractor records a control's options only when the registry
//   holds them as an object and every `choose` control holds them as an array.
//   Written up in D168_HANDOFF_2026-09-19.md with the two real silent-drop
//   defects that experiment surfaced elsewhere in the catalogue.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { EMITTERS } from '../lib/websiteBuilder/families/f3-buttons-icons-panels/emitters.js';
import { ELEMENTOR_WIDGETS } from '../lib/websiteBuilder/elementorWidgets.js';

const ENGINE = JSON.parse(readFileSync(
  path.join(process.cwd(), 'test/fixtures/elementor-widget-controls.json'), 'utf8'));

/** The five, and Elementor's own slug for each. */
const F3 = {
  share_buttons: 'share-buttons',
  call_to_action: 'call-to-action',
  flip_box: 'flip-box',
  facebook_embed: 'facebook-embed',
  facebook_page: 'facebook-page',
};

/**
 * PROPS AN AUTHOR REALLY TYPES, for all five at once.
 *
 * One object, because a row must read only its own props: a Flip Box that
 * picked up Call to Action's `title` would pass a per-widget fixture and put
 * the wrong words on a live page.
 */
const PROPS = {
  // Share Buttons
  share_buttons: [{ button: 'facebook' }, { button: 'linkedin' }, { button: 'not-a-network' }],
  view: 'icon', show_label: true, skin: 'framed', shape: 'circle',
  columns: '3', alignment: 'center', share_url_type: 'custom',
  share_url: 'https://example.test/spring-tidy', color_source: 'custom',
  primary_color: '#0C4A60', secondary_color: '#FFFFFF', icon_size: 18, column_gap: 14,
  // Call to Action
  skin: 'cover', layout: 'left', bg_image: 'https://cdn.example.test/yard.jpg', bg_image_id: '31',
  bg_image_size: 'full', graphic_element: 'icon', selected_icon: { value: 'fas fa-leaf', library: 'fa-solid' },
  title: 'Book your spring tidy', title_tag: 'h3',
  description: 'Two of us, half a day, everything taken away.', description_tag: 'div',
  button: 'Get a price', link: 'https://example.test/quote', link_click: 'box',
  ribbon_title: 'Popular', ribbon_horizontal_position: 'right',
  'min-height': 320, icon_primary_color: '#2F855A', graphic_image_width: 40,
  content_bg_color: '#FFFFFF', title_color: '#0B1C24', description_color: '#5A7A8A',
  button_text_color: '#FFFFFF', button_background_color: '#0C4A60',
  ribbon_bg_color: '#D97706', ribbon_text_color: '#FFFFFF',
  // Flip Box
  image: 'https://cdn.example.test/mower.jpg', image_id: '32', image_size: 'medium',
  title_text_a: 'Weekly mowing', description_text_a: 'Every Tuesday, April to October.',
  title_text_b: 'From $45 a visit', description_text_b: 'Edges, blow-down and clippings taken.',
  button_text: 'See the plan', height: 340, border_radius: 12,
  flip_effect: 'slide', flip_direction: 'left', flip_3d: 'yes',
  background_a_color: '#F1F5F9', alignment_a: 'start', title_color_a: '#0B1C24',
  description_color_a: '#5A7A8A', background_b_color: '#0C4A60', alignment_b: 'center',
  title_color_b: '#FFFFFF', description_color_b: '#E2E8F0',
  // Facebook Embed / Page
  type: 'video', post_url: 'https://www.facebook.com/example/posts/1',
  video_url: 'https://www.facebook.com/example/videos/2',
  comment_url: 'https://www.facebook.com/example/videos/2?comment_id=3',
  show_text: 'yes', include_parent: true, video_allowfullscreen: 'yes',
  video_autoplay: '', video_show_captions: 'yes',
  url: 'https://www.facebook.com/example', tabs: ['events'],
  small_header: 'yes', show_cover: 'yes', show_facepile: '', show_cta: 'yes',
};

const CTX = { seed: 'f3', nodeId: 'f3-1', allowPro: true };

describe('F3 publishes five Elementor Pro widgets', () => {
  test('the family owns exactly the five, by Elementor’s own slug', () => {
    assert.deepEqual(Object.keys(EMITTERS).sort(), Object.keys(F3).sort());
    for (const [kind, widgetType] of Object.entries(F3)) {
      assert.equal(EMITTERS[kind].widgetType, widgetType, kind);
    }
  });

  test('the one index really publishes THESE rows, not an older copy of them', () => {
    // `families/index.js` is spread FIRST in ELEMENTOR_WIDGETS, so a leftover
    // row further down the object literal WINS. Two of these five had exactly
    // that — five-key stubs for `call_to_action` and `flip_box`, deleted with
    // this family. The identity check is what would have caught it.
    for (const kind of Object.keys(F3)) {
      assert.equal(ELEMENTOR_WIDGETS[kind], EMITTERS[kind],
        `${kind}: elementorWidgets.js publishes a different row than the family declares`);
    }
  });

  test('all five are PRO, and none pretends to have a fallback it has not got', () => {
    for (const [kind, row] of Object.entries(EMITTERS)) {
      assert.equal(row.tier, 'pro', kind);
      assert.ok(row.label && row.label.trim(), `${kind} has no label for the refusal message`);
      assert.equal(row.fallback, undefined,
        `${kind} declares a fallback; if it really has one, say what it publishes`);
    }
  });
});

describe('every key an emitter writes is a control the page engine has', () => {
  for (const [kind, widgetType] of Object.entries(F3)) {
    test(`${kind} → ${widgetType}`, () => {
      const engine = ENGINE.widgets[widgetType];
      assert.ok(engine, `${widgetType} is not in elementor-widget-controls.json — regenerate it`);
      const emitted = EMITTERS[kind].settings(PROPS, CTX);
      const keys = Object.keys(emitted);
      assert.ok(keys.length >= 7, `${kind} emits only ${keys.length} keys — is it still a stub?`);
      const unknown = keys.filter((k) => !engine.controls[k]);
      assert.deepEqual(unknown, [],
        `these are not controls of ${widgetType}, so the page engine drops them on publish`);
      /* ASSERT PRESENCE, not just absence: the pinned fixture and the live
         emitter agree BOTH ways, so a key quietly stopping being emitted is a
         failure too. */
      assert.deepEqual(keys.sort(), Object.keys(engine.controls).sort());
    });
  }
});

/**
 * THE ENGINE'S OWN OPTION LISTS for the eleven choose/select controls these five
 * widgets have, quoted from BUILDER_WIDGET_CATALOG_2026-09-17.pro.json.
 *
 * WHY THEY ARE HERE AND NOT IN THE PINNED FIXTURE, said plainly:
 * `scripts/dev/extract-widget-controls.mjs` records a control's options only
 * when the registry holds them as a { value: label } OBJECT, and every control
 * below is a `choose` or a short `select` whose options the registry holds as a
 * plain ARRAY — so all five of these widgets are pinned with no option list at
 * all and the fixture cannot answer this question. Recording arrays too was
 * tried on 2026-09-19 and is NOT a safe generic change: some selects are
 * data-driven, not enumerations (`nav-menu.menu` and `ia_mega_menu.wp_menu` are
 * the IA site's own menu slugs and menu ids), so a generic array pin fails on
 * whichever site the scrape came from. It did, however, surface two real
 * silent-drop defects on the way past, and both are written up in
 * D168_HANDOFF_2026-09-19.md rather than quietly fixed from this family.
 *
 * These eleven ARE enumerations. Re-derive with:
 *   node -e "const j=require('<catalog>.pro.json');console.log(j.widgets['flip-box'].controls.flip_effect.options)"
 */
const ENGINE_OPTIONS = {
  'share-buttons': {
    view: ['icon-text', 'icon', 'text'],
    skin: ['gradient', 'minimal', 'framed', 'boxed', 'flat'],
    shape: ['square', 'rounded', 'circle'],
    columns: ['0', '1', '2', '3', '4', '5', '6'],
    alignment: ['left', 'center', 'right', 'justify'],
    share_url_type: ['current_page', 'custom'],
    color_source: ['official', 'custom'],
  },
  'call-to-action': {
    skin: ['classic', 'cover'],
    layout: ['left', 'above', 'right', 'below'],
    graphic_element: ['none', 'image', 'icon'],
    title_tag: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span'],
    description_tag: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span'],
    link_click: ['box', 'button'],
    ribbon_horizontal_position: ['left', 'right'],
    alignment: ['start', 'center', 'end'],
    bg_image_size: ['thumbnail', 'medium', 'medium_large', 'large', '1536x1536', '2048x2048', 'full', 'custom'],
    graphic_image_size: ['thumbnail', 'medium', 'medium_large', 'large', '1536x1536', '2048x2048', 'full', 'custom'],
  },
  'flip-box': {
    graphic_element: ['none', 'image', 'icon'],
    image_size: ['thumbnail', 'medium', 'medium_large', 'large', '1536x1536', '2048x2048', 'full', 'custom'],
    link_click: ['box', 'button'],
    title_tag: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'p'],
    description_tag: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'p'],
    flip_effect: ['flip', 'slide', 'push', 'zoom-in', 'zoom-out', 'fade'],
    flip_direction: ['left', 'right', 'up', 'down'],
    alignment_a: ['start', 'center', 'end'],
    alignment_b: ['start', 'center', 'end'],
  },
  'facebook-embed': { type: ['post', 'video', 'comment'] },
  'facebook-page': { tabs: ['timeline', 'events', 'messages'] },
};

describe('every select value is one the engine offers', () => {
  for (const [kind, widgetType] of Object.entries(F3)) {
    test(kind, () => {
      const lists = ENGINE_OPTIONS[widgetType];
      assert.ok(lists && Object.keys(lists).length,
        `${widgetType}: no option lists to check against — say so rather than passing`);
      const emitted = EMITTERS[kind].settings(PROPS, CTX);
      let checked = 0;
      for (const [key, allowed] of Object.entries(lists)) {
        assert.ok(key in emitted, `${kind} stopped emitting ${key}`);
        const values = Array.isArray(emitted[key]) ? emitted[key] : [emitted[key]];
        for (const v of values) {
          if (typeof v !== 'string' || v === '') continue;
          checked += 1;
          assert.ok(allowed.includes(v),
            `${kind}.${key} = "${v}" is not one of ${allowed.join(', ')} — `
            + 'the control would ignore it and the author would never know');
        }
      }
      assert.ok(checked >= Object.keys(lists).length - 1,
        `${kind}: only ${checked} values were actually checked — a guard that checks `
        + 'nothing is worse than no guard');
    });
  }
});

describe('the things an author would notice if they were wrong', () => {
  test('Share Buttons drops a network the engine does not have, and keeps the rest', () => {
    const s = EMITTERS.share_buttons.settings(PROPS, CTX);
    assert.deepEqual(s.share_buttons, [
      { _id: 'sb0', button: 'facebook' }, { _id: 'sb1', button: 'linkedin' },
    ], 'a made-up network would publish a button with no icon and no link');
    assert.equal(s.share_url.url, 'https://example.test/spring-tidy');
  });

  test('Share Buttons with nothing chosen publishes an empty list, not a guess', () => {
    const s = EMITTERS.share_buttons.settings({}, CTX);
    assert.deepEqual(s.share_buttons, []);
    assert.equal(s.share_url.url, '');
  });

  test('Call to Action carries the author’s words, picture, ribbon and colours', () => {
    const s = EMITTERS.call_to_action.settings(PROPS, CTX);
    assert.equal(s.title, 'Book your spring tidy');
    assert.equal(s.description, 'Two of us, half a day, everything taken away.');
    assert.equal(s.button, 'Get a price');
    assert.equal(s.link.url, 'https://example.test/quote');
    assert.equal(s.bg_image.url, 'https://cdn.example.test/yard.jpg');
    assert.equal(s.ribbon_title, 'Popular');
    assert.equal(s.button_background_color, '#0C4A60');
    // Elementor spells it with a hyphen. A tidied `min_height` is dropped.
    assert.deepEqual(s['min-height'], { unit: 'px', size: 320, sizes: [] });
  });

  test('Flip Box keeps the two faces apart', () => {
    const s = EMITTERS.flip_box.settings(PROPS, CTX);
    assert.equal(s.title_text_a, 'Weekly mowing');
    assert.equal(s.title_text_b, 'From $45 a visit');
    assert.notEqual(s.background_a_color, s.background_b_color);
    assert.equal(s.flip_effect, 'slide');
    assert.equal(s.flip_3d, 'yes');
  });

  test('a Facebook widget publishes the address it was given, and no default post', () => {
    const embed = EMITTERS.facebook_embed.settings({}, CTX);
    assert.equal(embed.post_url, '');
    assert.equal(embed.video_url, '');
    assert.equal(embed.type, 'post');
    const page = EMITTERS.facebook_page.settings(PROPS, CTX);
    assert.equal(page.url, 'https://www.facebook.com/example');
    // select2: the engine's own default is a LIST, so a list is published.
    assert.deepEqual(page.tabs, ['events']);
    assert.equal(page.show_facepile, '', 'an off switch is "", never "no"');
  });

  test('an empty slider is the engine’s own default, never a made-up number', () => {
    const s = EMITTERS.flip_box.settings({}, CTX);
    assert.deepEqual(s.height, { unit: 'px', size: '', sizes: [] });
  });
});
