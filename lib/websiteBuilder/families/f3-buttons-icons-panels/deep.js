// lib/websiteBuilder/families/f3-buttons-icons-panels/deep.js
//
// WHAT THE EIGHT EVERYDAY WIDGETS PUBLISH (B-168 wave 2, 2026-09-19).
//
// `button`, `icon`, `icon_box`, `list` (Icon List), `social_links` (Social
// Icons), `alert`, `divider` and `spacer` already had rows in
// `elementorWidgets.js` and those rows were THIN:
//
//   · button    published four settings and read `p.href`, a key the Portal has
//               never stored. Every button published with an empty link.
//   · divider   published `{ style: 'solid' }`. A CONSTANT: the author's
//               colour, weight, width, alignment and the words in the middle
//               were dropped on the way to the live page.
//   · spacer    read `p.height`, which is the key the Portal stopped writing.
//   · icon_box  published `position: 'top'` and `title_size: 'h3'`, both
//               constants, and no colours and no sizes.
//   · icon-list published a check for every row and nothing else.
//
// Since the override seam, a FAMILY row beats the legacy one:
// `mergeEmitters(FAMILY_EMITTERS, ELEMENTOR_WIDGETS)` in `elementorWidgets.js`
// keeps the family's, and `shadowedLegacyKinds()` prints what the lander should
// then delete. These are those eight rows.
//
// ── THE ONE RULE ABOUT A KEY ──────────────────────────────────────────────
// A settings key the engine does not have is DROPPED SILENTLY on publish, so
// the author watches us accept a change that never happens. Every key below is
// in the widget's own list in the Portal's
// `test/fixtures/WIDGET_SETTINGS_KEYS.json`, machine-cut from a real Elementor
// install, and `test/website-builder-f3-deep.test.js` checks all of them by
// executing the emitter rather than reading it.
//
// ── PER-DEVICE, PUBLISHED ─────────────────────────────────────────────────
// The Portal stores a responsive control's twins as `<key>_tablet` and
// `<key>_mobile`, which is Elementor's own spelling; `responsive()` below
// copies whichever of the three the author actually set. This is the half that
// makes a per-device control mean anything: the page renderer draws the desktop
// value because it has no device, and the real breakpoint lives on the
// published page.

/** "" for null and undefined, never the word "null" on a live page. */
const text = (v) => String(v == null ? '' : v);

/** Elementor's link control. An empty url goes nowhere, never somewhere made up. */
const link = (url) => ({ url: text(url), is_external: '', nofollow: '' });

/** Elementor's slider: a number with its unit. An empty size is the engine's own. */
const slider = (value, unit = 'px') => {
  const n = Number(value);
  return { unit, size: Number.isFinite(n) && n > 0 ? n : '', sizes: [] };
};

/** …and one that may legitimately be zero, which a `> 0` test would swallow. */
const slider0 = (value, unit = 'px') => {
  const n = Number(value);
  return { unit, size: Number.isFinite(n) && n >= 0 ? n : '', sizes: [] };
};

/**
 * Elementor's dimensions control, from ONE number.
 *
 * Border Width, Border Radius and Padding are four-sided in Elementor and one
 * number in our panel, because the engine's right-hand panel draws seven
 * control types and a four-box dimensions field is not one of them. The same
 * number on all four sides is the honest publish of what the author set; the
 * shortfall is named in the handoff rather than faked with three zeroes.
 */
/**
 * FOUR SIDES ALREADY ON THE PAGE come through untouched.
 *
 * B-168, 2026-09-22: the reader hands these the engine's own four-sided object
 * when a page read off a client's website carries one whose sides are not all
 * the same — `Number({…})` is `NaN`, and the author's padding came back empty.
 * Both shapes, measured by the reader's round trip.
 */
const heldSides = (v) => (v && typeof v === 'object' && 'top' in v ? v : null);

const dims = (value, unit = 'px') => {
  const held = heldSides(value);
  if (held) {
    return {
      unit: held.unit || unit, top: held.top, right: held.right,
      bottom: held.bottom, left: held.left, isLinked: held.isLinked !== false,
    };
  }
  const n = Number(value);
  const v = Number.isFinite(n) && n >= 0 ? n : '';
  return { unit, top: v, right: v, bottom: v, left: v, isLinked: true };
};

/** …and one where the sides are twice the top, as the page renderer draws it. */
const padDims = (value, unit = 'px') => {
  const held = heldSides(value);
  if (held) {
    return {
      unit: held.unit || unit, top: held.top, right: held.right,
      bottom: held.bottom, left: held.left, isLinked: held.isLinked === true,
    };
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return { unit, top: '', right: '', bottom: '', left: '', isLinked: true };
  return { unit, top: n, right: n * 2, bottom: n, left: n * 2, isLinked: false };
};

/** ONE OF THE ENGINE'S OWN OPTIONS, or the default. Never the author's raw string. */
const choice = (value, allowed, dflt) => {
  const v = String(value == null ? '' : value).toLowerCase().trim();
  return allowed.includes(v) ? v : dflt;
};

/** Elementor's switcher: the string "yes", or "". Both `true` and "yes" are on. */
const onOff = (v) => (v === true || v === 'yes' ? 'yes' : '');

/** Elementor's `icons` control, in the shape the Portal already stores. */
const faIcon = (v, dflt = 'fas fa-star') => {
  if (v && typeof v === 'object' && v.value) {
    return {
      value: String(v.value),
      library: String(v.library || (String(v.value).startsWith('fab') ? 'fa-brands' : 'fa-solid')),
    };
  }
  const name = text(v).trim();
  if (!name) return { value: dflt, library: dflt.startsWith('fab') ? 'fa-brands' : 'fa-solid' };
  return { value: name.includes(' ') ? name : `fas fa-${name}`, library: 'fa-solid' };
};

/** The first of these the author actually set. */
const pick = (p, ...keys) => {
  for (const k of keys) {
    const v = p ? p[k] : undefined;
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

/** A colour the author really chose, or "" — never a broken swatch on a page. */
const colour = (v) => {
  const s = text(v).trim();
  return /^(#[0-9a-fA-F]{3,8}|rgba?\([\d.,\s%]+\))$/.test(s) ? s : '';
};

/**
 * ONE RESPONSIVE CONTROL, PUBLISHED FOR EVERY SCREEN THE AUTHOR SET.
 *
 * Returns `{ key, key_tablet, key_mobile }`, each run through `shape`, and
 * leaves out a screen the author never touched — Elementor's own rule is that
 * an unset breakpoint inherits the one above it, and publishing an empty twin
 * would override that inheritance with nothing.
 */
const responsive = (p, key, shape) => {
  const out = {};
  for (const suffix of ['', '_tablet', '_mobile']) {
    const stored = p ? p[key + suffix] : undefined;
    if (stored === undefined || stored === null || stored === '') continue;
    out[key + suffix] = shape(stored);
  }
  return out;
};

/* ── The engine's own option lists, copied from the machine file ────────── */

export const VIEWS = ['default', 'stacked', 'framed'];
export const SHAPES = ['square', 'rounded', 'circle'];
export const LRC = ['left', 'center', 'right'];
export const LRCJ = ['left', 'center', 'right', 'justify'];
export const SCE = ['start', 'center', 'end'];
export const SCEJ = ['start', 'center', 'end', 'justify'];
export const BUTTON_TYPES = ['', 'info', 'success', 'warning', 'danger'];
export const BUTTON_SIZES = ['xs', 'sm', 'md', 'lg', 'xl'];
export const ICON_POSITIONS = ['inline-start', 'inline-end', 'block-start', 'block-end'];
export const V_ALIGN = ['top', 'middle', 'bottom'];
export const BORDER_TYPES = ['', 'none', 'solid', 'double', 'dotted', 'dashed', 'groove'];
export const DIVIDER_STYLES = ['solid', 'double', 'dotted', 'dashed'];
export const DIVIDER_LOOKS = ['line', 'line_text', 'line_icon'];
export const LIST_VIEWS = ['traditional', 'inline'];
export const LINK_CLICK = ['full_width', 'inline'];
export const ALERT_TYPES = ['info', 'success', 'warning', 'danger'];
export const HTML_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'p'];
export const FONT_WEIGHTS = ['', '100', '200', '300', '400', '500', '600', '700', '800', '900', 'normal', 'bold'];
export const TRANSFORMS = ['', 'uppercase', 'lowercase', 'capitalize', 'none'];
export const COLUMNS = ['0', '1', '2', '3', '4', '5', '6'];
export const SOCIAL_COLOUR = ['default', 'custom'];

/** Our six networks → the Font Awesome brand mark Elementor stores for each. */
const BRAND_ICON = {
  facebook: 'fab fa-facebook', instagram: 'fab fa-instagram',
  linkedin: 'fab fa-linkedin', x: 'fab fa-x-twitter',
  youtube: 'fab fa-youtube', website: 'fas fa-globe',
};
const brandIcon = (name) => {
  const key = text(name).toLowerCase().trim();
  const value = BRAND_ICON[key] || 'fas fa-globe';
  return { value, library: value.startsWith('fab') ? 'fa-brands' : 'fa-solid' };
};

/**
 * THE LEGACY `style` SELECT, which Elementor does not have.
 *
 * Our own Button offered Solid | Outline | Plain link and stored it as `style`.
 * Elementor reaches the same three through Background Color and Border Type, so
 * a stored `outline` is PUBLISHED as a border and a transparent background
 * rather than dropped — a page that came out solid blue the day we deepened the
 * widget would be a page the author has to fix by hand.
 */
function legacySkin(p) {
  const style = text(p.style).toLowerCase();
  if (style === 'outline') return { border_border: 'solid', border_width: dims(2) };
  if (style === 'plain_link') return { border_border: 'none', text_padding: dims(0) };
  return {};
}

export const DEEP_EMITTERS = {
  /* ── Button ────────────────────────────────────────────────────────────
     Elementor `button`, Content section "Button", Style section "Button".
     `text`/`link` are Elementor's keys and `label`/`url` are what documents
     hold; both are read, which is the whole reason the kind id did not change.
     The old row read `p.href`, a key nothing has ever written. */
  button: {
    widgetType: 'button', tier: 'free', label: 'Button',
    settings: (p) => ({
      button_type: choice(p.button_type, BUTTON_TYPES, ''),
      text: text(pick(p, 'text', 'label')),
      link: link(pick(p, 'link', 'url', 'href')),
      size: choice(p.size, BUTTON_SIZES, 'sm'),
      selected_icon: faIcon(p.selected_icon, ''),
      icon_align: choice(p.icon_align, ['row', 'row-reverse'], 'row'),
      icon_indent: slider(p.icon_indent),
      ...responsive(p, 'align', (v) => choice(v, LRCJ, '')),
      ...responsive(p, 'typography_font_size', (v) => slider(v)),
      typography_font_weight: choice(p.typography_font_weight, FONT_WEIGHTS, ''),
      typography_text_transform: choice(p.typography_text_transform, TRANSFORMS, ''),
      button_text_color: colour(p.button_text_color),
      background_color: colour(pick(p, 'background_color', 'colour')),
      /* THE AUTHOR'S OWN Border Type WINS; the legacy skin only speaks when
         there is none. `''` is one of Elementor's options ("Default"), so a
         `choice(…, BORDER_TYPES, fallback)` would return the empty string
         rather than the fallback — which is how an old Outline button came out
         with no border at all. Found by running it. */
      ...(p.border_border ? {} : legacySkin(p)),
      ...(p.border_border ? { border_border: choice(p.border_border, BORDER_TYPES, '') } : {}),
      ...responsive(p, 'border_width', (v) => dims(v)),
      border_color: colour(p.border_color),
      ...responsive(p, 'border_radius', (v) => dims(v)),
      ...responsive(p, 'text_padding', (v) => padDims(v)),
      hover_color: colour(p.hover_color),
      button_background_hover_color: colour(p.button_background_hover_color),
    }),
  },

  /* ── Icon ──────────────────────────────────────────────────────────────
     Elementor `icon`. The old row published four settings and no Style tab at
     all, so the colour, the size and the shape an author chose never left the
     Portal. */
  icon: {
    widgetType: 'icon', tier: 'free', label: 'Icon',
    settings: (p) => ({
      selected_icon: faIcon(pick(p, 'selected_icon', 'icon')),
      view: choice(p.view, VIEWS, 'default'),
      shape: choice(p.shape, SHAPES, 'circle'),
      link: link(pick(p, 'link', 'url')),
      /* Both dialects of Alignment: the Style tab stores `start | center | end`
         and a document written before today stores `left | center | right`. */
      ...responsive(p, 'align', (v) => {
        const s = text(v).toLowerCase();
        return choice(s === 'left' ? 'start' : s === 'right' ? 'end' : s, SCE, 'center');
      }),
      primary_color: colour(p.primary_color),
      secondary_color: colour(p.secondary_color),
      ...responsive(p, 'size', (v) => slider(v)),
      icon_padding: slider(p.icon_padding),
      ...responsive(p, 'rotate', (v) => slider0(v, 'deg')),
      border_width: dims(p.border_width),
      ...responsive(p, 'border_radius', (v) => (Number(v) >= 0 ? dims(v) : dims(''))),
    }),
  },

  /* ── Icon Box ──────────────────────────────────────────────────────────
     Elementor `icon-box`. The old row published `position: 'top'` and
     `title_size: 'h3'` as CONSTANTS, so those two controls did nothing on a
     live page however the author set them. */
  icon_box: {
    widgetType: 'icon-box', tier: 'free', label: 'Icon Box',
    settings: (p) => ({
      selected_icon: faIcon(pick(p, 'selected_icon', 'icon')),
      view: choice(p.view, VIEWS, 'default'),
      shape: choice(p.shape, SHAPES, 'circle'),
      title_text: text(pick(p, 'title_text', 'title')),
      description_text: text(pick(p, 'description_text', 'description')),
      link: link(pick(p, 'link', 'url')),
      title_size: choice(p.title_size, HTML_TAGS, 'h3'),
      /* Both spellings of Icon Position — Elementor's four and our old three. */
      ...responsive(p, 'position', (v) => {
        const s = text(v).toLowerCase();
        const legacy = { top: 'block-start', bottom: 'block-end', left: 'inline-start', right: 'inline-end' }[s];
        return choice(legacy || s, ICON_POSITIONS, 'block-start');
      }),
      ...responsive(p, 'content_vertical_alignment', (v) => choice(v, V_ALIGN, 'top')),
      ...responsive(p, 'text_align', (v) => {
        const s = text(v).toLowerCase();
        return choice(s === 'left' ? 'start' : s === 'right' ? 'end' : s, SCEJ, 'center');
      }),
      ...responsive(p, 'icon_space', (v) => slider0(v)),
      ...responsive(p, 'title_bottom_space', (v) => slider0(v)),
      primary_color: colour(p.primary_color),
      secondary_color: colour(p.secondary_color),
      ...responsive(p, 'icon_size', (v) => slider(v)),
      ...responsive(p, 'icon_padding', (v) => slider0(v)),
      ...responsive(p, 'rotate', (v) => slider0(v, 'deg')),
      ...responsive(p, 'border_width', (v) => dims(v)),
      title_color: colour(p.title_color),
      description_color: colour(p.description_color),
    }),
  },

  /* ── Icon List ─────────────────────────────────────────────────────────
     Elementor `icon-list`, stored kind `list`. The old row published the rows
     and nothing else, and gave every row the same tick. Both stored shapes are
     read: Elementor's `icon_list` repeater and the plain `items` array every
     document written before today holds. */
  list: {
    widgetType: 'icon-list', tier: 'free', label: 'Icon List',
    settings: (p) => {
      const rows = Array.isArray(p.icon_list) && p.icon_list.length
        ? p.icon_list
        : (Array.isArray(p.items) ? p.items : []);
      return {
        view: choice(p.view, LIST_VIEWS, 'traditional'),
        icon_list: rows.map((row, i) => {
          const r = typeof row === 'string' ? { text: row } : (row || {});
          return {
            _id: `li${i}`,
            text: text(r.text),
            selected_icon: faIcon(r.selected_icon, 'fas fa-check'),
            link: link(r.link),
          };
        }),
        link_click: choice(p.link_click, LINK_CLICK, 'full_width'),
        ...responsive(p, 'space_between', (v) => slider0(v)),
        ...responsive(p, 'icon_align', (v) => choice(v, SCE, '')),
        divider: onOff(p.divider),
        divider_style: choice(p.divider_style, DIVIDER_STYLES, 'solid'),
        divider_weight: slider(p.divider_weight),
        divider_color: colour(p.divider_color),
        icon_color: colour(p.icon_color),
        ...responsive(p, 'icon_size', (v) => slider(v)),
        text_indent: slider0(p.text_indent),
        text_color: colour(p.text_color),
      };
    },
  },

  /* ── Social Icons ──────────────────────────────────────────────────────
     Elementor `social-icons`, stored kind `social_links` (D-168 item 4). The
     old row published the accounts, the shape and the alignment; the Color
     select, every size and every space were dropped. */
  social_links: {
    widgetType: 'social-icons', tier: 'free', label: 'Social Icons',
    settings: (p) => {
      const rows = Array.isArray(p.social_icon_list) && p.social_icon_list.length
        ? p.social_icon_list
        : (Array.isArray(p.links) ? p.links : []);
      return {
        social_icon_list: rows.map((l, i) => ({
          _id: `s${i}`,
          social_icon: brandIcon(l && (l.social || l.network || l.label)),
          link: link(l && (l.link || l.url)),
        })),
        shape: choice(p.shape, SHAPES, 'rounded'),
        ...responsive(p, 'columns', (v) => choice(String(v), COLUMNS, '0')),
        ...responsive(p, 'align', (v) => choice(v, LRC, 'center')),
        icon_color: choice(p.icon_color, SOCIAL_COLOUR, 'default'),
        icon_primary_color: colour(p.icon_primary_color),
        icon_secondary_color: colour(p.icon_secondary_color),
        ...responsive(p, 'icon_size', (v) => slider(v)),
        ...responsive(p, 'icon_padding', (v) => slider0(v, 'em')),
        ...responsive(p, 'icon_spacing', (v) => slider0(v)),
        ...responsive(p, 'row_gap', (v) => slider0(v)),
        image_border_border: choice(p.image_border_border, BORDER_TYPES, ''),
        ...responsive(p, 'image_border_width', (v) => dims(v)),
        image_border_color: colour(p.image_border_color),
        ...responsive(p, 'border_radius', (v) => (Number(v) >= 0 ? dims(v) : dims(''))),
        hover_primary_color: colour(p.hover_primary_color),
        hover_secondary_color: colour(p.hover_secondary_color),
      };
    },
  },

  /* ── Alert ─────────────────────────────────────────────────────────────
     Elementor `alert`. The old row read `p.dismissible`, a key the widget has
     never stored, so the dismiss button was off on every published alert. */
  alert: {
    widgetType: 'alert', tier: 'free', label: 'Alert',
    settings: (p) => ({
      alert_type: choice(pick(p, 'alert_type', 'type'), ALERT_TYPES, 'info'),
      alert_title: text(pick(p, 'alert_title', 'title')),
      alert_description: text(pick(p, 'alert_description', 'description', 'text')),
      /* Elementor's `return_value` for this switcher is the word "show", and
         our panel writes a boolean. A widget nobody has touched shows it. */
      show_dismiss: (p.show_dismiss === undefined || p.show_dismiss === 'show' || p.show_dismiss === true
        || p.show_dismiss === 'yes' || p.dismissible === true) ? 'show' : '',
      dismiss_icon: faIcon(p.dismiss_icon, ''),
      background: colour(p.background),
      border_color: colour(p.border_color),
      'border_left-width': slider(p['border_left-width']),
      title_color: colour(p.title_color),
      ...responsive(p, 'alert_title_font_size', (v) => slider(v)),
      alert_title_font_weight: choice(p.alert_title_font_weight, FONT_WEIGHTS, ''),
      description_color: colour(p.description_color),
      ...responsive(p, 'alert_description_font_size', (v) => slider(v)),
      ...responsive(p, 'dismiss_icon_size', (v) => slider(v)),
      dismiss_icon_normal_color: colour(p.dismiss_icon_normal_color),
    }),
  },

  /* ── Divider ───────────────────────────────────────────────────────────
     Elementor `divider`. The old row was `settings: () => ({ style: 'solid' })`
     — a CONSTANT, taking no props at all, so nothing an author did to a divider
     ever reached the live page. `line` and `space_only` are our own two stored
     values and both are answered. */
  divider: {
    widgetType: 'divider', tier: 'free', label: 'Divider',
    settings: (p) => {
      const stored = text(p.style).toLowerCase() || 'solid';
      const spaceOnly = stored === 'space_only';
      return {
        style: choice(stored === 'line' ? 'solid' : stored, DIVIDER_STYLES, 'solid'),
        ...responsive(p, 'width', (v) => slider(v, '%')),
        ...responsive(p, 'align', (v) => choice(v, LRC, '')),
        look: choice(p.look, DIVIDER_LOOKS, 'line'),
        text: text(p.text),
        html_tag: choice(p.html_tag, HTML_TAGS, 'span'),
        icon: faIcon(p.icon),
        color: colour(p.color) || '#000',
        /* "Space only" was our word for a gap with no rule, and Elementor's way
           of saying it is a weight of zero. */
        weight: spaceOnly ? { unit: 'px', size: 0, sizes: [] } : slider(p.weight),
        ...responsive(p, 'gap', (v) => slider0(v)),
        text_color: colour(p.text_color),
        ...responsive(p, 'typography_font_size', (v) => slider(v)),
        typography_font_weight: choice(p.typography_font_weight, FONT_WEIGHTS, ''),
        text_align: choice(p.text_align, LRC, 'center'),
        ...responsive(p, 'text_spacing', (v) => slider0(v)),
        icon_view: choice(p.icon_view, VIEWS, 'default'),
        ...responsive(p, 'icon_size', (v) => slider(v)),
        primary_color: colour(p.primary_color),
        icon_align: choice(p.icon_align, LRC, 'center'),
        ...responsive(p, 'icon_spacing', (v) => slider0(v)),
      };
    },
  },

  /* ── Spacer ────────────────────────────────────────────────────────────
     Elementor `spacer`, one control. The old row read `p.height`, which is the
     key our own definition stopped writing; `space` is Elementor's and both are
     read. Elementor's own default is 50. */
  spacer: {
    widgetType: 'spacer', tier: 'free', label: 'Spacer',
    settings: (p) => ({
      space: slider0(pick(p, 'space', 'height') ?? 50),
      ...responsive(p, 'space', (v) => slider0(v)),
    }),
  },
};

export default DEEP_EMITTERS;
