/**
 * families/f8-contact-furniture/emitters.js - what F8 PUBLISHES.
 *
 * One row per widget kind, the same shape ELEMENTOR_WIDGETS has always had, so
 * `elementorWidgets.js` spreads this map and nothing else in that file changes:
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
 * the author's change does nothing on the live page. So every key here is a
 * control of the widget it claims to be, read out of
 * BUILDER_WIDGET_CATALOG_2026-09-17.pro.json, and
 * test/families-f8-contact-furniture.test.mjs asserts it by EXECUTING these
 * functions over a maximal props object - not by reading them.
 *
 * -- TWO ROWS MOVED HERE, THEY DID NOT GET COPIED -------------------------
 * `form` and `nav_menu` were in `elementorWidgets.js` and are DELETED from it
 * in the same commit, which is what the seams commit set out for these rows:
 * *"the nineteen rows below stay for one release and are then deleted, family
 * by family, as each one takes its own widgets over (replace means delete)"*.
 * Copying rather than moving would have been worse than doing nothing:
 * ELEMENTOR_WIDGETS spreads FAMILY_EMITTERS FIRST and its own rows after, so
 * the old row would have won and every setting the new panel offers would have
 * been dropped on publish with a green toast over it.
 *
 * -- THE TIER STRINGS ARE LITERALS ON PURPOSE -----------------------------
 * `elementorWidgets.js` exports FREE and PRO, and importing them from here
 * would be a cycle (that file imports families/index.js, which imports this).
 * The literals are the same two words and the family test asserts `tier ===
 * PRO` against the real export, so a rename cannot pass silently.
 */
import { mintId } from '../../elementorIds.js';
/**
 * THE BINDING STAMP, from the module that imports nothing.
 *
 * NOT from `elementorWidgets.js`: that file imports `families/index.js`, which
 * imports this one, so importing the stamp from there closed a cycle and threw
 * *"Cannot access 'F8_CONTACT_FURNITURE' before initialization"* the moment
 * this family's own test was the entry point. Measured on the first run of
 * b168/f8-contact-furniture-deep, not predicted. `iaBinding.js` is the ONE copy
 * of the stamp, imports nothing, and `elementorWidgets.js` re-exports it so no
 * other caller in the repo changed. `FREE` is spelled as its literal for the
 * same reason the tier strings are: it IS read at module-evaluation time.
 */
import { iaStamp, IA_SOURCES } from '../../iaBinding.js';
import {
  formPurposeSettings, normalizeFormPurpose, FORM_PURPOSE_KEY, CSS_CLASSES_KEY,
} from '../../formPurpose.js';

const text = (v) => String(v == null ? '' : v);

/** Elementor's link shape. An empty url stays empty - never a made-up one. */
const link = (url) => ({ url: text(url), is_external: '', nofollow: '' });

/** Elementor's switcher is the string 'yes' or the empty string. One reader. */
const yesNo = (v) => (v === true || v === 'yes' ? 'yes' : '');

/**
 * ...and its inverse for a switch whose DEFAULT is on.
 *
 * `show_remember_me`, `show_lost_password` and `show_logged_in_message` default
 * to 'yes' in the catalogue, so an author who has never touched one has no
 * stored value at all. Reading that as "off" would turn three of Login's
 * switches off the moment the widget is published, which is the opposite of
 * what the panel showed them. Absent means the default.
 */
const yesNoDefaultOn = (v) => (v === false || v === 'no' || v === '' ? '' : 'yes');

/** One of a fixed list, or the fallback. A value the engine would ignore never
 *  leaves here - a setting the engine drops is one the author watched us take. */
function choice(value, allowed, dflt) {
  const v = String(value == null ? '' : value).trim();
  return allowed.includes(v) ? v : dflt;
}

/** A number as Elementor's slider shape: `{ unit, size, sizes }`. */
function slider(value, unit = 'px') {
  const n = Number(value);
  return { unit, size: Number.isFinite(n) ? n : '', sizes: [] };
}

/** A key only when there is something to say. An explicitly-empty colour
 *  overrides the theme with nothing, which is not what "I left it alone" means. */
function when(key, value) {
  return value === '' || value == null ? {} : { [key]: value };
}

/** The same, for a slider whose absence means "the theme decides". */
function whenSize(key, value) {
  return value === '' || value == null ? {} : { [key]: slider(value) };
}

/** A prop under either name - the panel's Elementor-named key first, the older
 *  one the ready-made website sections still pass second. */
function pick(p, ...keys) {
  for (const k of keys) {
    if (p && Object.prototype.hasOwnProperty.call(p, k) && String(p[k] ?? '').trim() !== '') return p[k];
  }
  return '';
}

function widgetNode(id, widgetType, settings) {
  return { id, elType: 'widget', widgetType, settings };
}

/* Elementor's own option lists, values exactly as the catalogue carries them. */
export const INPUT_SIZES = ['xs', 'sm', 'md', 'lg', 'xl'];
export const BUTTON_WIDTHS = ['20', '25', '30', '33', '40', '50', '60', '66', '70', '75', '80', '100'];
export const LOGIN_ALIGNS = ['start', 'center', 'end', 'stretch'];
export const NAV_LAYOUTS = ['horizontal', 'vertical', 'dropdown'];
export const NAV_ALIGN_ITEMS = ['', 'start', 'center', 'end', 'justify'];
export const NAV_POINTERS = ['none', 'underline', 'overline', 'double-line', 'framed', 'background', 'text'];
export const NAV_BREAKPOINTS = ['mobile', 'tablet', 'none'];
export const NAV_TEXT_ALIGNS = ['aside', 'center'];
export const NAV_TOGGLES = ['', 'burger'];
export const NAV_TOGGLE_ALIGNS = ['left', 'center', 'right'];

/**
 * DOES THE ARION LITE FALLBACK ACTUALLY FIRE? One predicate, two readers.
 *
 * Moved with the `form` row and unchanged. The sentence a client reads and the
 * node we publish have to agree: before this existed, the pane promised "this
 * is added as a box with a heading, your words and a button" for every paid
 * widget that HAD a fallback function - including the form, whose fallback
 * answers null on a site that has not got our shortcode. So a Lite client was
 * promised a form and the publish refused one, which is
 * `reference_catch_swallow_report_success` in sentence form.
 */
const formFallbackFires = (ctx) =>
  Array.isArray(ctx?.iaShortcodes) && ctx.iaShortcodes.includes('ia_form');

/** One form row, in the repeater's own field names, from either vocabulary. */
function formRow(f, i) {
  const src = f || {};
  return {
    _id: text(src.custom_id || src.id || `f${i}`),
    field_label: text(src.field_label != null ? src.field_label : src.label),
    field_type: text(src.field_type || src.type || 'text'),
    placeholder: text(src.placeholder),
    required: (src.required === true || src.required === 'true') ? 'true' : '',
    width: text(src.width || '100'),
  };
}

/* Elementor's own option lists for the widgets wave 2 deepened. Values copied
   from BUILDER_WIDGET_CATALOG_2026-09-17 and, for Button and Google Maps, from
   the LIVE editor read on 2026-09-19 (elementor-reference/widgets/
   _g8_control_facts.json). A value the control does not carry is DROPPED on
   publish, so `choice()` never lets one leave here. */
export const BUTTON_TYPES = ['', 'info', 'success', 'warning', 'danger'];
export const BUTTON_ALIGNS = ['left', 'center', 'right', 'justify'];
export const ICON_POSITIONS = ['row', 'row-reverse'];
export const BORDER_TYPES = ['', 'none', 'solid', 'double', 'dotted', 'dashed', 'groove'];
export const SOCIAL_SHAPES = ['rounded', 'square', 'circle'];
export const SOCIAL_COLUMNS = ['0', '1', '2', '3', '4', '5', '6'];
export const SOCIAL_ALIGNS = ['left', 'center', 'right'];
export const SOCIAL_COLOUR_MODES = ['default', 'custom'];
export const MEGA_SOURCES = ['wordpress', 'custom'];
export const MEGA_STYLES = ['split-panel', 'column-dropdown', 'full-width-banner'];
export const MEGA_ANIMATIONS = ['fade', 'slide', 'none'];
export const MEGA_WIDTHS = ['full-width', 'auto', 'custom'];
export const MOBILE_SOURCES = ['wp_menu', 'custom'];
export const MOBILE_STYLES = ['slide_panel', 'fullscreen_overlay', 'bottom_tab_bar'];
export const MOBILE_BG_TYPES = ['solid', 'image', 'overlay'];
export const MOBILE_DIRECTIONS = ['left', 'right'];

/**
 * ELEMENTOR'S POPOVER TOGGLE STORES THE STRING `custom`, NOT `yes`.
 *
 * Read off the LIVE editor on 2026-09-19 (`return_value: "custom"` on
 * `css_filters_css_filter`), because neither 2026-09-17 scrape records a
 * control's `return_value`. Publishing `yes` there leaves every CSS filter the
 * author set doing nothing on the page, silently - the exact defect this whole
 * family test exists to catch.
 */
const FILTER_ON = 'custom';
const popover = (v) => (v === true || v === FILTER_ON || v === 'yes' ? FILTER_ON : '');

/** Elementor's `dimensions` shape: four sides and the link toggle. One number
 *  from our panel becomes all four, which is what "one radius" means. */
function dimensions(value, unit = 'px') {
  const n = Number(value);
  if (!Number.isFinite(n) || String(value == null ? '' : value).trim() === '') return null;
  return { unit, top: String(n), right: String(n), bottom: String(n), left: String(n), isLinked: true };
}

/** A dimensions key only when there is a number to put in it. */
function whenDim(key, value) {
  const d = dimensions(value);
  return d ? { [key]: d } : {};
}

/** Elementor's media shape. An empty url stays empty - never a made-up one. */
const media = (url) => ({ url: text(url), id: '', size: '' });

/**
 * BOOK NOW'S BUTTON SETTINGS - Elementor's own button keys, from our panel.
 *
 * A module function and not a row property: `website-elementor-tree.test.mjs`
 * asserts a row has exactly one of `settings()` and `node()`, and Book Now
 * needs `node()` because it publishes a shortcode on a site that has one. A
 * test can still execute this directly, which is the point.
 */
export const bookNowButtonSettings = (p = {}) => ({
      text: text(pick(p, 'text', 'label') || 'Book now'),
      link: link(pick(p, 'link', 'url')),
      size: choice(p.size, INPUT_SIZES, 'sm'),
      ...when('button_type', choice(p.button_type, BUTTON_TYPES, '')),
      ...when('button_css_id', text(p.button_css_id)),
      icon_align: choice(p.icon_align, ICON_POSITIONS, 'row'),
      ...whenSize('icon_indent', p.icon_indent),
      ...when('align', choice(p.align, BUTTON_ALIGNS, '')),
      ...when('align_tablet', choice(p.align_tablet, BUTTON_ALIGNS, '')),
      ...when('align_mobile', choice(p.align_mobile, BUTTON_ALIGNS, '')),
      ...whenSize('typography_font_size', p.typography_font_size),
      ...whenSize('typography_font_size_tablet', p.typography_font_size_tablet),
      ...whenSize('typography_font_size_mobile', p.typography_font_size_mobile),
      ...when('button_text_color', text(p.button_text_color)),
      ...when('background_color', text(p.background_color)),
      ...when('hover_color', text(p.hover_color)),
      ...when('button_background_hover_color', text(p.button_background_hover_color)),
      ...when('button_hover_border_color', text(p.button_hover_border_color)),
      ...when('border_border', choice(p.border_border, BORDER_TYPES, '')),
      ...when('border_color', text(p.border_color)),
      ...whenDim('border_width', p.border_width),
      ...whenDim('border_radius', p.border_radius),
});

export const EMITTERS = {
  /* ── Form — Elementor `form`, Pro. MOVED from elementorWidgets.js ────── */
  form: {
    /**
     * A FORM THAT CANNOT SEND IS NEVER DRAWN.
     *
     * A picture of a form is worse than no form: the visitor types their name
     * in and nobody ever hears. So the paid widget is refused on a plan that
     * does not carry it, with the sentence the client has always read.
     *
     * BUILDER_WIDGET_CATALOG G.3 asks for better - a Lite site should still get
     * a contact form, through OUR form on the page engine's free `shortcode`
     * widget. The shortcode does not exist yet (the plugin registers
     * `ia_book_now` and `ia_pdf` and nothing else), so the fallback is gated on
     * the site TELLING US it has one - the presence of a marker, never the
     * absence of one (`reference_absence_based_guards_fail_open`). The day the
     * plugin adds `[ia_form]`, `ctx.iaShortcodes` carries it and every Lite
     * site gets a working form with no change here.
     */
    widgetType: 'form', tier: 'pro', label: 'Form',
    settings: (p = {}, ctx) => ({
      /* `form_name` is the panel's key; `title` is what the ready-made website
         sections have always passed. First one with something wins. */
      form_name: text(pick(p, 'form_name', 'title') || 'Contact'),
      email_to: text(p.emailTo || ctx?.emailTo),
      // WHAT THIS FORM IS FOR, in the same three keys the archetype path
      // writes (`formPurpose.js`). Without them a form built as a widget and a
      // form built as a section typed their submissions differently, which is
      // the client's enquiries filed by whichever door they happened to use.
      ...formPurposeSettings(p[FORM_PURPOSE_KEY] == null ? p.purpose : p[FORM_PURPOSE_KEY], p[CSS_CLASSES_KEY]),
      form_fields: (Array.isArray(p.form_fields) ? p.form_fields
        : (Array.isArray(p.fields) ? p.fields : [])).map(formRow),
      /* ── the Content and Style controls the panel now offers ─────────
         Every one of these was dropped on the floor before F8: the row that
         lived in elementorWidgets.js emitted the three keys above and nothing
         else, so an author who set the input size or the button colour watched
         us take it and the live page never changed. */
      input_size: choice(p.input_size, INPUT_SIZES, 'sm'),
      show_labels: yesNoDefaultOn(p.show_labels),
      mark_required: yesNo(p.mark_required),
      button_size: choice(p.button_size, INPUT_SIZES, 'sm'),
      button_width: choice(p.button_width, BUTTON_WIDTHS, '100'),
      button_text: text(pick(p, 'button_text', 'submit_label') || 'Send'),
      ...whenSize('column_gap', p.column_gap),
      ...whenSize('row_gap', p.row_gap),
      ...when('label_color', text(p.label_color)),
      ...when('field_text_color', text(p.field_text_color)),
      ...when('field_background_color', text(p.field_background_color)),
      ...when('field_border_color', text(p.field_border_color)),
      ...when('button_background_color', text(p.button_background_color)),
      ...when('button_text_color', text(p.button_text_color)),
    }),
    fallbackFires: formFallbackFires,
    /** ...and when it does fire, a form is still a FORM, not a box of words. */
    swapSentence: 'Available on ARION Standard and above. On your plan this is added as our own form, '
      + 'which still sends every enquiry to your inbox.',
    fallback: (p, ctx) => {
      if (!formFallbackFires(ctx)) return null;
      const purpose = normalizeFormPurpose(p[FORM_PURPOSE_KEY] == null ? p.purpose : p[FORM_PURPOSE_KEY]);
      return widgetNode(ctx?.nodeId || mintId(ctx?.seed || 'f', 'form'), 'shortcode', {
        shortcode: `[ia_form purpose="${purpose}" to="${text(p.emailTo || ctx?.emailTo)}"]`,
        // The shortcode carries the purpose in its own attribute AND the widget
        // carries the three keys, so a Lite form is typed by the same word as a
        // Standard one - the plugin reads the attribute, we read the keys, and
        // neither has to guess what the other did.
        ...formPurposeSettings(purpose, p[CSS_CLASSES_KEY]),
      });
    },
  },

  /* ── Login — Elementor `login`, Pro ─────────────────────────────────── */
  login: {
    widgetType: 'login', tier: 'pro', label: 'Login',
    settings: (p = {}) => ({
      show_labels: yesNoDefaultOn(p.show_labels),
      input_size: choice(p.input_size, INPUT_SIZES, 'sm'),
      button_text: text(p.button_text || 'Log In'),
      button_size: choice(p.button_size, INPUT_SIZES, 'sm'),
      align: choice(p.align, LOGIN_ALIGNS, ''),
      show_lost_password: yesNoDefaultOn(p.show_lost_password),
      show_remember_me: yesNoDefaultOn(p.show_remember_me),
      show_logged_in_message: yesNoDefaultOn(p.show_logged_in_message),
      /* A redirect URL with the switch off is a URL nothing reads, so the pair
         travels together or not at all. */
      ...(yesNo(p.redirect_after_login)
        ? { redirect_after_login: 'yes', redirect_url: link(p.redirect_url) } : {}),
      ...(yesNo(p.redirect_after_logout)
        ? { redirect_after_logout: 'yes', redirect_logout_url: link(p.redirect_logout_url) } : {}),
      ...whenSize('row_gap', p.row_gap),
      ...when('links_color', text(p.links_color)),
      ...when('label_color', text(p.label_color)),
      ...when('field_text_color', text(p.field_text_color)),
      ...when('field_background_color', text(p.field_background_color)),
      ...when('field_border_color', text(p.field_border_color)),
      ...when('button_text_color', text(p.button_text_color)),
      ...when('button_background_color', text(p.button_background_color)),
      ...when('button_border_color', text(p.button_border_color)),
    }),
  },

  /* ── WordPress Menu — Elementor `nav-menu`, Pro. MOVED ──────────────── */
  nav_menu: {
    widgetType: 'nav-menu', tier: 'pro', label: 'WordPress Menu',
    /**
     * `menu` IS OMITTED WHEN EMPTY, AND THAT IS THE FEATURE.
     *
     * Elementor's own `menu` control lists the menus registered on THAT site -
     * the catalogue's three options are the IA site's own menus and nobody
     * else's. We do not know a client's from the Portal, so the panel does not
     * offer the choice (see the Portal-side navMenu.ts header) and this leaves
     * the key out entirely, which is how the page engine is told to use the
     * site's own default menu. Sending `menu: ''` instead selects a menu called
     * '' and the visitor gets an empty bar.
     *
     * The row this replaces emitted `menu` unconditionally and a hard-coded
     * horizontal `layout`, so a vertical menu was not possible and an author
     * who had never chosen a menu published an empty one.
     */
    settings: (p = {}) => ({
      ...when('menu', text(p.menu)),
      menu_name: text(p.menu_name || 'Menu'),
      layout: choice(p.layout, NAV_LAYOUTS, 'horizontal'),
      align_items: choice(p.align_items, NAV_ALIGN_ITEMS, ''),
      pointer: choice(p.pointer, NAV_POINTERS, 'underline'),
      dropdown: choice(p.dropdown, NAV_BREAKPOINTS, 'tablet'),
      full_width: yesNo(p.full_width),
      text_align: choice(p.text_align, NAV_TEXT_ALIGNS, 'aside'),
      toggle: choice(p.toggle, NAV_TOGGLES, 'burger'),
      toggle_align: choice(p.toggle_align, NAV_TOGGLE_ALIGNS, 'center'),
      ...when('color_menu_item', text(p.color_menu_item)),
      ...when('pointer_color_menu_item_hover', text(p.pointer_color_menu_item_hover)),
      ...whenSize('menu_space_between', p.menu_space_between),
      ...whenSize('padding_horizontal_menu_item', p.padding_horizontal_menu_item),
      ...whenSize('padding_vertical_menu_item', p.padding_vertical_menu_item),
      ...whenSize('border_radius_menu_item', p.border_radius_menu_item),
      ...when('color_dropdown_item', text(p.color_dropdown_item)),
      ...when('background_color_dropdown_item', text(p.background_color_dropdown_item)),
      ...when('toggle_color', text(p.toggle_color)),
      ...when('toggle_background_color', text(p.toggle_background_color)),
      ...whenSize('toggle_size', p.toggle_size),
    }),
  },
  /* ══════════════════════════════════════════════════════════════════════
     WAVE 2 — the widgets that already existed and were THIN.
     Each row REPLACES one in `elementorWidgets.js` of the same kind:
     `mergeEmitters(FAMILY_EMITTERS, LEGACY_WIDGETS)` lets the family win, and
     `shadowedLegacyKinds()` prints the old ones for the lander. The old rows
     are NOT deleted here on purpose — `ELEMENTOR_WIDGETS.map.settings(...)` is
     called by `hours_location`'s own node builder, and a delete plus a caller
     change in one pass is two changes a merge cannot separate.
     ══════════════════════════════════════════════════════════════════════ */

  /* ── Google Maps — Elementor `google_maps`, FREE ─────────────────────
     The kind we store is `map` (`WIDGET_KIND_ALIASES` resolves the Portal's
     `google_maps` to it), so this row is keyed `map` and nothing else moves.
     The row it replaces published TWO keys — address and zoom — and defaulted
     the zoom to 12 where Elementor's own default is 10, so a map published
     from an untouched widget came out at a different zoom than the canvas
     drew. This one publishes all sixteen. */
  map: {
    widgetType: 'google_maps', tier: 'free', label: 'Google Maps',
    settings: (p = {}) => ({
      address: text(pick(p, 'address')),
      zoom: slider(Number(p.zoom) || 10),
      ...whenSize('height', p.height),
      ...whenSize('height_tablet', p.height_tablet),
      ...whenSize('height_mobile', p.height_mobile),
      /* The six filters travel only when the popover is open, because that is
         the only time Elementor reads them. */
      ...(popover(p.css_filters_css_filter) ? {
        css_filters_css_filter: FILTER_ON,
        css_filters_blur: slider(Number(p.css_filters_blur) || 0),
        css_filters_brightness: slider(Number(p.css_filters_brightness) || 100),
        css_filters_contrast: slider(Number(p.css_filters_contrast) || 100),
        css_filters_saturate: slider(Number(p.css_filters_saturate) || 100),
        css_filters_hue: slider(Number(p.css_filters_hue) || 0),
      } : {}),
      ...(popover(p.css_filters_hover_css_filter) ? {
        css_filters_hover_css_filter: FILTER_ON,
        css_filters_hover_blur: slider(Number(p.css_filters_hover_blur) || 0),
        css_filters_hover_brightness: slider(Number(p.css_filters_hover_brightness) || 100),
        css_filters_hover_contrast: slider(Number(p.css_filters_hover_contrast) || 100),
        css_filters_hover_saturate: slider(Number(p.css_filters_hover_saturate) || 100),
        css_filters_hover_hue: slider(Number(p.css_filters_hover_hue) || 0),
      } : {}),
      ...whenSize('hover_transition', p.hover_transition),
    }),
  },

  /* ── Book Now — the IA twin of Elementor's Button ────────────────────
     The row it replaces published THREE keys through
     `ELEMENTOR_WIDGETS.button.settings({text, href, align})`, so every Style
     control the deepened panel offers was dropped on publish. This one writes
     Elementor's own button keys, and keeps the plugin shortcode path exactly
     as it was: presence, never absence — the shortcode is used when the site
     SAID it has it. */
  book_now: {
    widgetType: 'ia_book_now', tier: 'ia:oliver', label: 'Book Now',
    /* A ROW HAS EITHER `settings()` OR `node()`, NEVER BOTH - `website-elementor
       -tree.test.mjs` asserts exactly one, because two would be two answers to
       "what does this publish". Book Now builds its own node (shortcode where
       the site has one, a real Elementor button where it has not), so the
       button settings are `bookNowButtonSettings` above and the row has only
       `node()`. */
    node: (p = {}, ctx = {}) => {
      const id = ctx.nodeId || mintId(ctx.seed || 'b', 'book_now');
      const hasShortcode = Array.isArray(ctx.iaShortcodes) && ctx.iaShortcodes.includes('ia_book_now');
      const page = text(p.bookingPageId);
      const settings = hasShortcode
        ? { shortcode: '[ia_book_now' + (page ? ' page="' + page + '"' : '') + ']' }
        : bookNowButtonSettings(p);
      return widgetNode(id, hasShortcode ? 'shortcode' : 'button',
        iaStamp(settings, 'book_now', p, IA_SOURCES.booking));
    },
  },

  /* ── IA Social Links — the plugin's own registered widget ────────────
     Its control names are the PLUGIN'S, read off the same machine file as
     every other row. The row it replaces published three keys; this one
     publishes the seventeen the deepened panel offers, including the
     responsive twins Elementor stores beside them. */
  ia_social_links: {
    widgetType: 'ia_social_links', tier: 'ia:arion', label: 'IA Social Links',
    settings: (p = {}) => ({
      /* `platforms` is the plugin's `select2` — a LIST of network names. Both
         spellings a stored page may hold are read, so no page loses a row. */
      platforms: (Array.isArray(p.platforms) ? p.platforms
        : Array.isArray(p.links) ? p.links : [])
        .map((l) => text(typeof l === 'string' ? l : (l && (l.platform || l.network || l.label))))
        .filter(Boolean),
      shape: choice(p.shape, SOCIAL_SHAPES, 'rounded'),
      columns: choice(p.columns, SOCIAL_COLUMNS, '0'),
      ...when('columns_tablet', choice(p.columns_tablet, SOCIAL_COLUMNS, '')),
      ...when('columns_mobile', choice(p.columns_mobile, SOCIAL_COLUMNS, '')),
      align: choice(p.align, SOCIAL_ALIGNS, 'center'),
      ...when('align_tablet', choice(p.align_tablet, SOCIAL_ALIGNS, '')),
      ...when('align_mobile', choice(p.align_mobile, SOCIAL_ALIGNS, '')),
      icon_color: choice(p.icon_color, SOCIAL_COLOUR_MODES, 'default'),
      ...when('icon_primary_color', text(p.icon_primary_color)),
      ...when('icon_secondary_color', text(p.icon_secondary_color)),
      ...whenSize('icon_size', p.icon_size),
      ...whenSize('icon_size_tablet', p.icon_size_tablet),
      ...whenSize('icon_size_mobile', p.icon_size_mobile),
      ...whenSize('icon_padding', p.icon_padding),
      ...whenSize('icon_spacing', p.icon_spacing),
      ...whenDim('border_radius', p.border_radius),
    }),
  },

  /* ── IA Mega Menu — the plugin's own registered widget ───────────────
     `wp_menu` IS OMITTED and that is the feature: the select lists the menus
     registered on THAT site and the Portal cannot know a client's, so leaving
     it out is how the plugin is told to use the site's own default. Sending
     `wp_menu: ''` selects a menu called '' and the visitor gets an empty bar —
     the same trap `nav_menu` names above. The row it replaces published three
     keys and hard-coded `menu_source: 'wp'`, which is NOT one of the two
     values the plugin's own select offers (`wordpress` | `custom`), so the
     source was being dropped on every publish. */
  ia_mega_menu: {
    widgetType: 'ia_mega_menu', tier: 'ia:arion', label: 'IA Mega Menu',
    settings: (p = {}) => ({
      menu_source: choice(p.menu_source, MEGA_SOURCES, 'wordpress'),
      menu_style: choice(p.menu_style, MEGA_STYLES, 'split-panel'),
      menu_items: (Array.isArray(p.menu_items) ? p.menu_items : []).map((r, i) => ({
        _id: text((r && r._id) || ('i' + i)),
        item_label: text(r && (r.item_label != null ? r.item_label : r.label)),
        item_type: text((r && (r.item_type || r.type)) || 'link'),
      })).filter((r) => r.item_label),
      menu_groups: Array.isArray(p.menu_groups) ? p.menu_groups : [],
      ...when('featured_heading', text(p.featured_heading)),
      ...when('featured_text', text(p.featured_text)),
      ...(text(p.featured_link) ? { featured_link: link(p.featured_link) } : {}),
      ...when('featured_link_text', text(p.featured_link_text)),
      ...when('bg_color', text(p.bg_color)),
      ...when('text_color', text(p.text_color)),
      ...when('accent_color', text(p.accent_color)),
      ...when('hover_color', text(p.hover_color)),
      ...when('border_color', text(p.border_color)),
      ...whenSize('font_size', p.font_size),
      ...whenSize('item_spacing', p.item_spacing),
      dropdown_animation: choice(p.dropdown_animation, MEGA_ANIMATIONS, 'fade'),
      dropdown_width: choice(p.dropdown_width, MEGA_WIDTHS, 'full-width'),
      ...whenSize('dropdown_custom_width', p.dropdown_custom_width),
    }),
  },

  /* ── IA Mobile Menu — the plugin's own registered widget ─────────────
     The row it replaces published three keys, hard-coded `menu_source: 'wp'`
     (not one of the plugin's two values, so dropped) and offered no switch, no
     CTA and no panel style at all. */
  ia_mobile_menu: {
    widgetType: 'ia_mobile_menu', tier: 'ia:arion', label: 'IA Mobile Menu',
    settings: (p = {}) => ({
      menu_source: choice(p.menu_source, MOBILE_SOURCES, 'wp_menu'),
      custom_items: (Array.isArray(p.custom_items) ? p.custom_items : []).map((r, i) => ({
        _id: text((r && r._id) || ('i' + i)),
        label: text(typeof r === 'string' ? r : (r && r.label)),
        url: link(r && r.url && (r.url.url != null ? r.url.url : r.url)),
      })).filter((r) => r.label),
      style: choice(p.style, MOBILE_STYLES, 'slide_panel'),
      show_social: yesNoDefaultOn(p.show_social),
      social_links: Array.isArray(p.social_links) ? p.social_links : [],
      show_cta: yesNoDefaultOn(p.show_cta),
      ...when('cta_text', text(p.cta_text)),
      ...(text(p.cta_link) ? { cta_link: link(p.cta_link) } : {}),
      show_search: yesNo(p.show_search),
      bg_type: choice(p.bg_type, MOBILE_BG_TYPES, 'solid'),
      ...when('bg_color', text(p.bg_color)),
      ...(text(p.bg_image) ? { bg_image: media(p.bg_image) } : {}),
      ...when('overlay_color', text(p.overlay_color)),
      ...when('text_color', text(p.text_color)),
      ...when('accent_color', text(p.accent_color)),
      ...when('close_icon_color', text(p.close_icon_color)),
      animation_direction: choice(p.animation_direction, MOBILE_DIRECTIONS, 'right'),
      ...whenSize('panel_width', p.panel_width),
    }),
  },

  /* ── IA OLIVER Invoice — the plugin's own registered widget ──────────
     `oliver_api_base` IS NOT PUBLISHED FROM HERE. It is a deployment fact, not
     a design choice; the plugin's own default is the production API, and a key
     we send overrides it. See the Portal-side iaOliverInvoice.ts header.
     The row it replaces read `p.showBookAgain` and `p.bookAgainUrl` —
     camel-case names no panel ever wrote, so the Book Again button was
     published OFF on every invoice whatever the author chose. Both spellings
     are read here, which is why no stored page changes meaning. */
  ia_oliver_invoice: {
    widgetType: 'ia_oliver_invoice', tier: 'ia:oliver', label: 'IA Invoice',
    settings: (p = {}) => ({
      ...(text(pick(p, 'business_logo_url', 'businessLogoUrl'))
        ? { business_logo_url: media(pick(p, 'business_logo_url', 'businessLogoUrl')) } : {}),
      ...when('business_name', text(pick(p, 'business_name', 'businessName'))),
      ...when('business_phone', text(pick(p, 'business_phone', 'businessPhone'))),
      ...when('business_email', text(pick(p, 'business_email', 'businessEmail'))),
      show_book_again_cta: yesNoDefaultOn(
        p.show_book_again_cta != null ? p.show_book_again_cta : p.showBookAgain),
      ...(text(pick(p, 'book_again_url', 'bookAgainUrl'))
        ? { book_again_url: link(pick(p, 'book_again_url', 'bookAgainUrl')) } : {}),
      ...when('book_again_text', text(pick(p, 'book_again_text', 'bookAgainText'))),
      ...when('accent_color', text(p.accent_color)),
    }),
  },
};


export default EMITTERS;
