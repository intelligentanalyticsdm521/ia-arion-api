/**
 * families/f3-buttons-icons-panels/emitters.js - what the f3-buttons-icons-panels family PUBLISHES.
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
 * Nothing in here ever opens elementorWidgets.js or another family's folder,
 * which is why the four small readers below are declared here rather than
 * imported: importing them would make this module and that 40 KB one import
 * each other while both are still evaluating.
 *
 * -- WHAT IS IN THIS MAP, AND WHAT IS NOT -----------------------------------
 * The five Elementor PRO widgets of F3 that the build had nothing for:
 * Share Buttons, Call to Action, Flip Box, Facebook Embed and Facebook Page.
 * The family's other eight - button, icon, icon-box, icon-list, social-icons,
 * alert, divider and spacer - ALREADY have rows in `elementorWidgets.js` and
 * are NOT copied here: `families/index.js` throws on a kind two families claim,
 * and a second row for a kind that has one is the drift this split exists to
 * stop. Moving them is one delete and one paste in the same pass, and the
 * delete is in a file no family owns, so it is written up for the lander in
 * D168_HANDOFF_2026-09-19.md instead of half-done here.
 *
 * -- NO PRO FALLBACK, SAID PLAINLY ------------------------------------------
 * All five are PRO, and none declares `fallback`. On a plan that cannot carry
 * a paid widget the publisher's own `PRO_LOCK_SENTENCE_NO_FALLBACK` is what the
 * author reads, which is the same answer `posts`, `pro_gallery` and `slides`
 * already give. A made-up box with a heading in it is not a share bar and is
 * not a flip card; saying the plan does not carry it is the honest one.
 */

/** "" for null and undefined, never the word "null" on a live page. */
const text = (v) => String(v == null ? '' : v);

/** Elementor's link control. An empty url goes nowhere, never somewhere made up. */
const link = (url) => ({ url: text(url), is_external: '', nofollow: '' });

/**
 * Elementor's slider control: a number with the unit it is measured in.
 * An empty size is the engine's own default, which is what an author who never
 * touched the control asked for.
 */
const slider = (value, unit = 'px') => {
  const n = Number(value);
  return { unit, size: Number.isFinite(n) && n > 0 ? n : '', sizes: [] };
};

/**
 * ONE OF THE ENGINE'S OWN OPTIONS, or the default.
 *
 * Never the author's raw string: a value the control does not have is dropped
 * by the page engine, and a dropped setting is a change the author watched us
 * accept. Every list below is copied from
 * BUILDER_WIDGET_CATALOG_2026-09-17.pro.json, not remembered.
 */
const choice = (value, allowed, dflt) => {
  const v = String(value == null ? '' : value).toLowerCase().trim();
  return allowed.includes(v) ? v : dflt;
};

/** Elementor's switcher: the string "yes", or "". Both `true` and "yes" are on. */
const onOff = (v) => (v === true || v === 'yes' ? 'yes' : '');

/** Elementor's `icons` control, in the shape the Portal already stores. */
const faIcon = (v) => {
  if (v && typeof v === 'object' && v.value) {
    return {
      value: String(v.value),
      library: String(v.library || (String(v.value).startsWith('fab') ? 'fa-brands' : 'fa-solid')),
    };
  }
  const name = text(v).trim();
  return name
    ? { value: name.includes(' ') ? name : `fas fa-${name}`, library: 'fa-solid' }
    : { value: 'fas fa-star', library: 'fa-solid' };
};

/**
 * Elementor's media control, reading the SHAPE THE PAGE ALREADY HOLDS.
 *
 * B-168, 2026-09-22: a page read back off a client's own website hands this
 * the engine's own `{ url, id }` object, not the plain address the panel
 * writes. Both, for the same reason `faIcon` takes both and `pick` takes two
 * spellings - the alternative is `"[object Object]"` where the picture was,
 * on somebody's live page. Measured by the reader's round trip, not guessed.
 */
const media = (url, id) => (url && typeof url === 'object'
  ? { url: text(url.url || url.src), id: text(url.id ?? id) }
  : { url: text(url), id: text(id) });

/* ── The engine's own option lists, per widget ──────────────────────────── */

export const SHARE_VIEWS = ['icon-text', 'icon', 'text'];
export const SHARE_SKINS = ['gradient', 'minimal', 'framed', 'boxed', 'flat'];
export const SHARE_SHAPES = ['square', 'rounded', 'circle'];
export const SHARE_ALIGNMENTS = ['', 'left', 'center', 'right', 'justify'];
export const SHARE_URL_TYPES = ['current_page', 'custom'];
export const SHARE_COLOR_SOURCES = ['official', 'custom'];
export const SHARE_COLUMNS = ['0', '1', '2', '3', '4', '5', '6'];
/** The networks the Portal's picker offers, by Elementor's own button value. */
export const SHARE_BUTTONS = [
  'facebook', 'x-twitter', 'linkedin', 'pinterest', 'whatsapp', 'email',
];

export const CTA_SKINS = ['classic', 'cover'];
export const CTA_LAYOUTS = ['', 'left', 'above', 'right', 'below'];
export const GRAPHIC_ELEMENTS = ['none', 'image', 'icon'];
export const TITLE_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span'];
export const FLIP_TAGS = [...TITLE_TAGS, 'p'];
export const LINK_CLICKS = ['box', 'button'];
export const RIBBON_POSITIONS = ['', 'left', 'right'];
export const BOX_ALIGNMENTS = ['start', 'center', 'end'];
export const IMAGE_SIZES = [
  'thumbnail', 'medium', 'medium_large', 'large', '1536x1536', '2048x2048', 'full', 'custom',
];

export const FLIP_EFFECTS = ['flip', 'slide', 'push', 'zoom-in', 'zoom-out', 'fade'];
export const FLIP_DIRECTIONS = ['left', 'right', 'up', 'down'];

export const FB_EMBED_TYPES = ['post', 'video', 'comment'];
export const FB_PAGE_TABS = ['timeline', 'events', 'messages'];

import { DEEP_EMITTERS } from './deep.js';

export const EMITTERS = {
  /* THE EIGHT EVERYDAY WIDGETS, deepened (B-168 wave 2). They already had rows
     in `elementorWidgets.js` and those rows were thin — a Divider published a
     constant, a Button read a key nothing writes. Since the override seam a
     FAMILY row beats the legacy one, so these replace them; see ./deep.js. */
  ...DEEP_EMITTERS,

  /* ── Share Buttons ─────────────────────────────────────────────────────
     Elementor `share-buttons`. One Content section and one Style section,
     both called "Share Buttons". The repeater's rows are `{ _id, button }`,
     which is the shape the engine's own default carries. */
  share_buttons: {
    widgetType: 'share-buttons', tier: 'pro', label: 'Share Buttons',
    settings: (p) => ({
      share_buttons: (Array.isArray(p.share_buttons) ? p.share_buttons : [])
        .map((row) => (typeof row === 'string' ? row : text(row && (row.button || row.value))))
        .map((v) => choice(v, SHARE_BUTTONS, ''))
        .filter(Boolean)
        .map((button, i) => ({ _id: `sb${i}`, button })),
      view: choice(p.view, SHARE_VIEWS, 'icon-text'),
      show_label: onOff(p.show_label),
      skin: choice(p.skin, SHARE_SKINS, 'gradient'),
      shape: choice(p.shape, SHARE_SHAPES, 'square'),
      columns: choice(p.columns, SHARE_COLUMNS, '0'),
      alignment: choice(p.alignment, SHARE_ALIGNMENTS, ''),
      share_url_type: choice(p.share_url_type, SHARE_URL_TYPES, 'current_page'),
      share_url: link(p.share_url),
      color_source: choice(p.color_source, SHARE_COLOR_SOURCES, 'official'),
      primary_color: text(p.primary_color),
      secondary_color: text(p.secondary_color),
      icon_size: slider(p.icon_size),
      column_gap: slider(p.column_gap),
    }),
  },

  /* ── Call to Action ────────────────────────────────────────────────────
     Elementor `call-to-action`. Three Content sections (Image, Content,
     Ribbon) and five Style ones; the core control of each is published. */
  call_to_action: {
    widgetType: 'call-to-action', tier: 'pro', label: 'Call to Action',
    settings: (p) => ({
      skin: choice(p.skin, CTA_SKINS, 'classic'),
      layout: choice(p.layout, CTA_LAYOUTS, ''),
      bg_image: media(p.bg_image, p.bg_image_id),
      bg_image_size: choice(p.bg_image_size, IMAGE_SIZES, 'large'),
      graphic_element: choice(p.graphic_element, GRAPHIC_ELEMENTS, 'none'),
      graphic_image: media(p.graphic_image, p.graphic_image_id),
      graphic_image_size: choice(p.graphic_image_size, IMAGE_SIZES, 'thumbnail'),
      selected_icon: faIcon(p.selected_icon),
      title: text(p.title),
      title_tag: choice(p.title_tag, TITLE_TAGS, 'h2'),
      description: text(p.description),
      description_tag: choice(p.description_tag, TITLE_TAGS, 'div'),
      button: text(p.button),
      link: link(p.link),
      link_click: choice(p.link_click, LINK_CLICKS, 'button'),
      ribbon_title: text(p.ribbon_title),
      ribbon_horizontal_position: choice(p.ribbon_horizontal_position, RIBBON_POSITIONS, ''),
      alignment: choice(p.alignment, BOX_ALIGNMENTS, 'center'),
      /* Elementor spells this one with a hyphen. Copied, not tidied: a key
         the engine does not have is a setting it throws away. */
      'min-height': slider(p['min-height']),
      icon_primary_color: text(p.icon_primary_color),
      icon_size: slider(p.icon_size),
      graphic_image_width: slider(p.graphic_image_width, '%'),
      content_bg_color: text(p.content_bg_color),
      title_color: text(p.title_color),
      description_color: text(p.description_color),
      button_text_color: text(p.button_text_color),
      button_background_color: text(p.button_background_color),
      ribbon_bg_color: text(p.ribbon_bg_color),
      ribbon_text_color: text(p.ribbon_text_color),
    }),
  },

  /* ── Flip Box ──────────────────────────────────────────────────────────
     Elementor `flip-box`. Front, Back and Settings on Content; Front and
     Back on Style. The flip itself is the engine's own CSS, so nothing here
     publishes a script. */
  flip_box: {
    widgetType: 'flip-box', tier: 'pro', label: 'Flip Box',
    settings: (p) => ({
      graphic_element: choice(p.graphic_element, GRAPHIC_ELEMENTS, 'icon'),
      image: media(p.image, p.image_id),
      image_size: choice(p.image_size, IMAGE_SIZES, 'thumbnail'),
      selected_icon: faIcon(p.selected_icon),
      title_text_a: text(p.title_text_a),
      description_text_a: text(p.description_text_a),
      title_text_b: text(p.title_text_b),
      description_text_b: text(p.description_text_b),
      button_text: text(p.button_text),
      link: link(p.link),
      link_click: choice(p.link_click, LINK_CLICKS, 'button'),
      title_tag: choice(p.title_tag, FLIP_TAGS, 'h3'),
      description_tag: choice(p.description_tag, FLIP_TAGS, 'div'),
      height: slider(p.height),
      border_radius: slider(p.border_radius),
      flip_effect: choice(p.flip_effect, FLIP_EFFECTS, 'flip'),
      flip_direction: choice(p.flip_direction, FLIP_DIRECTIONS, 'up'),
      flip_3d: onOff(p.flip_3d),
      background_a_color: text(p.background_a_color),
      alignment_a: choice(p.alignment_a, BOX_ALIGNMENTS, 'center'),
      icon_primary_color: text(p.icon_primary_color),
      icon_size: slider(p.icon_size),
      title_color_a: text(p.title_color_a),
      description_color_a: text(p.description_color_a),
      background_b_color: text(p.background_b_color),
      alignment_b: choice(p.alignment_b, BOX_ALIGNMENTS, 'center'),
      title_color_b: text(p.title_color_b),
      description_color_b: text(p.description_color_b),
      button_text_color: text(p.button_text_color),
      button_background_color: text(p.button_background_color),
    }),
  },

  /* ── Facebook Embed ────────────────────────────────────────────────────
     Elementor `facebook-embed`. One section, "Embed", and no Style tab -
     what is drawn is Facebook's own card, which is also why the widget needs
     Facebook's script on the page. */
  facebook_embed: {
    widgetType: 'facebook-embed', tier: 'pro', label: 'Facebook Embed',
    settings: (p) => ({
      type: choice(p.type, FB_EMBED_TYPES, 'post'),
      post_url: text(p.post_url),
      video_url: text(p.video_url),
      comment_url: text(p.comment_url),
      show_text: onOff(p.show_text),
      include_parent: onOff(p.include_parent),
      video_allowfullscreen: onOff(p.video_allowfullscreen),
      video_autoplay: onOff(p.video_autoplay),
      video_show_captions: onOff(p.video_show_captions),
    }),
  },

  /* ── Facebook Page ─────────────────────────────────────────────────────
     Elementor `facebook-page`. One section, "Page". `tabs` is a select2 and
     the engine's own default is a LIST, so a list is what is published. */
  facebook_page: {
    widgetType: 'facebook-page', tier: 'pro', label: 'Facebook Page',
    settings: (p) => ({
      url: text(p.url),
      tabs: [choice(Array.isArray(p.tabs) ? p.tabs[0] : p.tabs, FB_PAGE_TABS, 'timeline')],
      small_header: onOff(p.small_header),
      show_cover: onOff(p.show_cover),
      show_facepile: onOff(p.show_facepile),
      show_cta: onOff(p.show_cta),
      height: slider(p.height),
    }),
  },
};

export default EMITTERS;
