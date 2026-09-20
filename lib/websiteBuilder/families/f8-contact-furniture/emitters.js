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
};

export default EMITTERS;
