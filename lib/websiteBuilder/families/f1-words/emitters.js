/**
 * families/f1-words/emitters.js - what the f1-words family PUBLISHES.
 *
 * BUILDER_FULL_WIDGET_PLAN_2026-09-19 section C.1. One row per widget kind, the
 * same shape ELEMENTOR_WIDGETS has always had, so `elementorWidgets.js` spreads
 * this map and nothing else in that file changes.
 *
 * A settings key the engine does not have is DROPPED SILENTLY on publish and
 * the author's change does nothing on the live page. Every key below is in the
 * widget's list in the Portal's test/fixtures/WIDGET_SETTINGS_KEYS.json, and
 * test/website-builder-f1-words.test.mjs asserts it by EXECUTING each
 * `settings()` and checking every key it produced.
 *
 * -- SEVEN OF THE TWELVE -----------------------------------------------------
 * F1 is twelve widgets. `heading`, `paragraph` (Text Editor), `html` and
 * `shortcode` already have rows in `elementorWidgets.js` and keep them; moving
 * them here while the old rows stand would make `families/index.js` throw on a
 * kind two places publish. The move is written out for the lander in
 * D168_HANDOFF_2026-09-19.md. `menu_anchor` has a Portal widget and no emitter
 * at all, and is listed there too.
 *
 * -- HOW A SWITCH IS PUBLISHED, in one place ---------------------------------
 * Elementor stores a switcher as the control's RETURN VALUE when it is on and
 * the empty string when it is off. Where the 2026-09-17 catalogue records a
 * non-empty default for a switcher, that string IS the return value
 * (`line-numbers`, `copy-to-clipboard`, `yes`) and it is used. Where the
 * catalogue records an empty default the return value is not in the scrape, and
 * `switchOn` falls back to Elementor's own default of `yes`. The two that fall
 * back are Code Highlight's and Table of Contents' `word_wrap`, and the handoff
 * says so under "What I could NOT verify" rather than pretending it was read.
 */
/* The two tier words as LITERALS, not an import: `elementorWidgets.js` spreads
   this map, so importing its constants back would make the two files load each
   other and the header above promises this file never opens it. They are
   literals there too (`export const FREE = 'free'`), and the family test pins
   both spellings against that module so a rename cannot drift. */
const FREE = 'free';
const PRO = 'pro';

const text = (v) => String(v == null ? '' : v);
const on = (v) => v === true || v === 'yes' || (typeof v === 'string' && v !== '' && v !== 'no' && v !== 'false');

/** Elementor's switcher: the return value when on, the empty string when off. */
export function switchOn(value, returnValue = 'yes') {
  return on(value) ? returnValue : '';
}

/** Elementor's slider shape. An empty size means "whatever the theme says". */
export function slider(value, unit = 'px') {
  const n = Number(value);
  return { unit, size: Number.isFinite(n) && String(value ?? '').trim() !== '' ? n : '', sizes: [] };
}

/** The ONE escaper this repo has. A second one is the one that forgets a quote. */
import { escapeHtml } from '../../elementorIds.js';

/** Plain words become a paragraph, exactly as the legacy row made them. */
const html = (v) => `<p>${escapeHtml(text(v))}</p>`;

/** Elementor's link shape. Never a made-up destination. */
const link = (url) => ({ url: text(url), is_external: '', nofollow: '' });

/** One of a closed list, or the list's first entry. A value the engine does not
 *  know is a setting the author watched us accept and the page then ignored. */
export function choice(value, allowed, fallback) {
  const v = text(value);
  return allowed.indexOf(v) >= 0 ? v : (fallback === undefined ? allowed[0] : fallback);
}

export const BLOCKQUOTE_SKINS = ['border', 'quotation', 'boxed', 'clean'];
export const HEADLINE_STYLES = ['highlight', 'rotate'];
export const HEADLINE_ANIMATIONS = [
  'typing', 'clip', 'flip', 'swirl', 'blinds', 'drop-in', 'wave', 'slide', 'slide-down',
];
export const HEADLINE_MARKERS = [
  'circle', 'curly', 'underline', 'double', 'double_underline',
  'underline_zigzag', 'diagonal', 'strikethrough', 'x',
];
export const HEADLINE_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'p'];
export const TEXT_PATHS = ['wave', 'arc', 'circle', 'line', 'oval', 'spiral', 'custom'];
export const TEXT_DIRECTIONS = ['', 'rtl', 'ltr'];
export const ALIGNMENTS = ['left', 'center', 'right'];
export const TOC_TAGS = ['h2', 'h3', 'h4', 'h5', 'h6', 'div'];
export const TOC_MARKERS = ['numbers', 'bullets'];
export const TOC_MINIMIZED_ON = ['mobile', 'tablet', 'desktop'];
export const CODE_THEMES = ['default', 'dark', 'okaidia', 'solarizedlight', 'tomorrow', 'twilight'];
export const CODE_LANGUAGES = [
  'markup', 'html', 'css', 'sass', 'scss', 'less', 'javascript', 'typescript', 'jsx', 'tsx',
  'php', 'ruby', 'json', 'http', 'xml', 'svg', 'rust', 'csharp', 'dart', 'git', 'java', 'sql',
  'go', 'kotlin', 'julia', 'python', 'swift', 'bash', 'scala', 'haskell', 'perl', 'objectivec',
  'visual-basic,', 'r', 'c', 'cpp', 'aspnet',
];

/* ══════════════════════════════════════════════════════════════════════════
   WAVE 2 — the five everyday word widgets
   ══════════════════════════════════════════════════════════════════════════

   `heading`, `paragraph`, `html`, `shortcode` and `menu_anchor` had rows in
   `elementorWidgets.js` that published between one and three settings each,
   and `menu_anchor` could not be published at all when wave 1 looked. Those
   rows are LEGACY now: `mergeEmitters(FAMILY_EMITTERS, LEGACY_WIDGETS)` gives
   the family's row the page, in the legacy one's place, and
   `shadowedLegacyKinds()` prints the leftovers for the lander.

   ── ONLY WHAT THE AUTHOR SET ────────────────────────────────────────────
   `some()` drops an empty value rather than publishing it. Elementor treats a
   missing key and an empty one the same way — the theme decides — but a page
   carrying forty empty keys per heading is forty rows of noise in
   `_elementor_data` that a person reading it has to skip, and every one of
   them is a key somebody later has to decide whether we meant.

   ── THE THREE POPOVER TOGGLES ───────────────────────────────────────────
   Elementor's group controls (Typography, Text Stroke, Text Shadow) do
   nothing on the live page unless their popover toggle is on: the group's CSS
   is written behind `{{WRAPPER}}` only when the author "opened" it. The scrape
   does not record a popover_toggle's return value, so the two Elementor uses
   are written here from its own source conventions — `custom` for a typography
   group, `yes` for the two shadows/strokes — and the handoff says so under
   "what I could not verify" rather than pretending it was read. A toggle set
   to the wrong word is a style that publishes and does not paint; it is never
   a style that paints something else.
*/

/** Drop the keys the author never touched. */
function some(pairs) {
  const out = {};
  for (const [k, v] of Object.entries(pairs)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

/** A number the author typed, or undefined when the box is empty. */
function number(v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Elementor's slider shape, or undefined so `some()` drops the key. */
function sliderOr(v, unit = 'px') {
  const n = number(v);
  return n === undefined ? undefined : { unit, size: n, sizes: [] };
}

/** One of a closed list, or undefined — never a value the engine will ignore. */
function oneOf(v, allowed) {
  const s = text(v);
  return allowed.indexOf(s) >= 0 && s !== '' ? s : undefined;
}

export const HEADING_SIZES = ['default', 'small', 'medium', 'large', 'xl', 'xxl'];
export const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'p'];
export const ELEMENTOR_ALIGNMENTS = ['start', 'center', 'end', 'justify'];
export const TEXT_TRANSFORMS = ['uppercase', 'lowercase', 'capitalize', 'none'];
export const FONT_STYLES = ['normal', 'italic', 'oblique'];
export const TEXT_DECORATIONS = ['underline', 'overline', 'line-through', 'none'];
export const BLEND_MODES = [
  'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge',
  'saturation', 'color', 'difference', 'exclusion', 'hue', 'luminosity',
];
export const DROP_CAP_VIEWS = ['default', 'stacked', 'framed'];
export const TEXT_COLUMN_COUNTS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

/**
 * Elementor's OWN tag for a heading, from whichever key a document holds.
 *
 * `header_size` is Elementor's and wins. `level` is what this platform's
 * heading has stored since the first registry — 1/2/3 or the three words the
 * old Size select wrote — and is read so a page built from a document saved
 * before D-168 publishes with the tag its author chose.
 */
export function headingTag(p) {
  const tag = text(p && p.header_size).toLowerCase();
  if (HEADING_TAGS.indexOf(tag) >= 0) return tag;
  const level = p && p.level;
  if (level === 'Page title' || level === 1 || level === '1') return 'h1';
  if (level === 'Sub-section' || level === 3 || level === '3') return 'h3';
  return 'h2';
}

/** Elementor's alignment words, from ours or from its own. */
function alignment(v) {
  const s = text(v).toLowerCase();
  if (s === 'left' || s === 'start') return 'start';
  if (s === 'right' || s === 'end') return 'end';
  if (s === 'center' || s === 'centre') return 'center';
  if (s === 'justify') return 'justify';
  return undefined;
}

/** The three text-effect keys every word widget shares, under its own prefix. */
function effects(p, prefix = '') {
  const at = (k) => (p || {})[`${prefix}${k}`];
  const transform = oneOf(at('typography_text_transform'), TEXT_TRANSFORMS);
  const style = oneOf(at('typography_font_style'), FONT_STYLES);
  const decoration = oneOf(at('typography_text_decoration'), TEXT_DECORATIONS);
  const word = sliderOr(at('typography_word_spacing'));
  const any = transform || style || decoration || word;
  return some({
    [`${prefix}typography_typography`]: any ? 'custom' : '',
    [`${prefix}typography_text_transform`]: transform,
    [`${prefix}typography_font_style`]: style,
    [`${prefix}typography_text_decoration`]: decoration,
    [`${prefix}typography_word_spacing`]: word,
  });
}

/**
 * Elementor's ONE text-shadow key, put back together from four plain boxes.
 *
 * The Portal's panel has no popover, so Horizontal / Vertical / Blur / Color
 * are four controls spelled with the composite's key in front of them. This is
 * the only place they become the single key Elementor has, which is why the
 * settings-key check accepts them: a key Elementor does not have would be
 * dropped on publish and the author's shadow would simply not be there.
 */
function textShadow(p, prefix = '') {
  const at = (k) => (p || {})[`${prefix}text_shadow_text_shadow_${k}`];
  const h = number(at('horizontal'));
  const v = number(at('vertical'));
  const blur = number(at('blur'));
  const colour = text(at('color'));
  if (h === undefined && v === undefined && blur === undefined && !colour) return {};
  return {
    [`${prefix}text_shadow_text_shadow_type`]: 'yes',
    [`${prefix}text_shadow_text_shadow`]: {
      horizontal: h === undefined ? 0 : h,
      vertical: v === undefined ? 0 : v,
      blur: blur === undefined ? 10 : blur,
      color: colour || 'rgba(0,0,0,0.3)',
    },
  };
}

/** One responsive key in Elementor's own three spellings. */
function perDevice(p, key, make) {
  const props = p || {};
  return some({
    [key]: make(props[key]),
    [`${key}_tablet`]: make(props[`${key}_tablet`]),
    [`${key}_mobile`]: make(props[`${key}_mobile`]),
  });
}

export const WAVE_2 = {
  heading: {
    /**
     * Elementor's Heading, with the Style tab the old row never had.
     *
     * The words come from `text` first and `title` second: `text` is what every
     * document on the estate stores and what the canvas writes back, `title` is
     * Elementor's own key and what a page read back out of WordPress carries.
     * Both, so a round trip never loses somebody's headline.
     */
    widgetType: 'heading', tier: FREE, label: 'Heading',
    settings: (p) => {
      const props = p || {};
      const stroke = number(props.text_stroke_text_stroke);
      return {
        title: text(props.text != null && props.text !== '' ? props.text : props.title),
        header_size: headingTag(props),
        ...some({
          size: oneOf(props.size, HEADING_SIZES),
          link: text(props.link) ? link(props.link) : undefined,
          title_color: text(props.title_color),
          title_hover_color: text(props.title_hover_color),
          title_hover_color_transition_duration: sliderOr(props.title_hover_color_transition_duration, 's'),
          blend_mode: oneOf(props.blend_mode, BLEND_MODES),
          text_stroke_text_stroke_type: stroke === undefined ? '' : 'yes',
          text_stroke_text_stroke: sliderOr(stroke),
          text_stroke_stroke_color: stroke === undefined ? '' : text(props.text_stroke_stroke_color),
        }),
        ...perDevice(props, 'align', alignment),
        ...effects(props),
        ...textShadow(props),
      };
    },
  },

  paragraph: {
    /**
     * Elementor's Text Editor — the widget with the Drop Cap.
     *
     * `text` is the stored key and `editor` is Elementor's; both are read, and
     * plain text becomes paragraphs through the same `html()` the legacy row
     * used, so a page built from either spelling reads the same.
     */
    widgetType: 'text-editor', tier: FREE, label: 'Text Editor',
    settings: (p) => {
      const props = p || {};
      const words = props.text != null && props.text !== '' ? props.text : props.editor;
      const cap = on(props.drop_cap);
      return {
        editor: text(props.editor) && !text(props.text) ? text(props.editor) : html(words),
        ...some({
          drop_cap: switchOn(props.drop_cap, 'yes'),
          text_color: text(props.text_color),
          link_color: text(props.link_color),
          link_hover_color: text(props.link_hover_color),
          link_hover_color_transition_duration: sliderOr(props.link_hover_color_transition_duration, 's'),
        }),
        ...perDevice(props, 'align', alignment),
        ...perDevice(props, 'text_columns', (v) => oneOf(v, TEXT_COLUMN_COUNTS)),
        ...perDevice(props, 'column_gap', (v) => sliderOr(v)),
        ...perDevice(props, 'paragraph_spacing', (v) => sliderOr(v)),
        ...effects(props),
        ...textShadow(props),
        /* The Drop Cap section only reaches the page when the drop cap is ON.
           Publishing its colours with the cap switched off would put styling on
           a letter nobody can see, and the author would find it the day they
           turned the cap on and it came up in last month's colour. */
        ...(cap ? some({
          drop_cap_view: oneOf(props.drop_cap_view, DROP_CAP_VIEWS),
          drop_cap_primary_color: text(props.drop_cap_primary_color),
          drop_cap_secondary_color: text(props.drop_cap_secondary_color),
          drop_cap_size: sliderOr(props.drop_cap_size),
          drop_cap_space: sliderOr(props.drop_cap_space),
          drop_cap_border_radius: sliderOr(props.drop_cap_border_radius, '%'),
          drop_cap_border_width: number(props.drop_cap_border_width) === undefined ? undefined : {
            unit: 'px',
            top: String(number(props.drop_cap_border_width)),
            right: String(number(props.drop_cap_border_width)),
            bottom: String(number(props.drop_cap_border_width)),
            left: String(number(props.drop_cap_border_width)),
            isLinked: true,
          },
        }) : {}),
        ...(cap ? effects(props, 'drop_cap_') : {}),
      };
    },
  },

  html: {
    /**
     * THE ESCAPE HATCH CLIENTS ACTUALLY USE.
     *
     * BUILDER_WIDGET_CATALOG_2026-09-17 D.2: 58 of the 64 IA page bodies are
     * ONE html widget and nothing else. One control, one key, and the markup is
     * never touched on the way through — a sanitiser here would be a silent
     * second opinion about what the author meant.
     */
    widgetType: 'html', tier: FREE, label: 'HTML',
    settings: (p) => ({ html: text((p || {}).html != null ? (p || {}).html : (p || {}).code) }),
  },

  shortcode: {
    // A page-engine shortcode, which is how one of OUR features reaches a page
    // without a widget of its own — `[ia_book_now]` does it today.
    widgetType: 'shortcode', tier: FREE, label: 'Shortcode',
    settings: (p) => ({ shortcode: text((p || {}).shortcode) }),
  },

  menu_anchor: {
    /**
     * Wave 1: *"`menu_anchor` — no arion emitter at all — it is on the panel
     * and cannot be published."* The anchor is cleaned to what a URL fragment
     * may hold, by the same rule the canvas uses, because the marker is
     * invisible: an id with a space in it is a menu link that silently goes
     * nowhere and an author who can never see why.
     */
    widgetType: 'menu-anchor', tier: FREE, label: 'Menu Anchor',
    settings: (p) => ({ anchor: text((p || {}).anchor).trim().replace(/[^A-Za-z0-9_-]/g, '') }),
  },
};

export const EMITTERS = {
  /* Wave 2's five, first, so the twelve read in the order this family built
     them. `panelAt` decides where a TILE sits; this map decides nothing about
     order and only has to hold each kind once. */
  ...WAVE_2,
  blockquote: {
    /**
     * THE TWEET BUTTON IS NEVER PUBLISHED.
     *
     * Elementor's Blockquote ships one on by default (`tweet_button` defaults
     * to `yes`), so a node published without saying otherwise would put a
     * Twitter button on a client's live page. `feedback_no_third_party_product_
     * surface` forbids exactly that, so the key goes out as the empty string —
     * turned OFF on purpose, once, here, rather than left to a default.
     */
    widgetType: 'blockquote', tier: PRO, label: 'Blockquote',
    settings: (p) => ({
      blockquote_skin: choice(p.blockquote_skin, BLOCKQUOTE_SKINS, 'border'),
      blockquote_content: text(p.blockquote_content != null ? p.blockquote_content : p.quote),
      author_name: text(p.author_name != null ? p.author_name : p.attribution),
      alignment: choice(p.alignment, ALIGNMENTS, ''),
      content_text_color: text(p.content_text_color),
      author_text_color: text(p.author_text_color),
      border_color: text(p.border_color),
      border_width: slider(p.border_width),
      box_background_color: text(p.box_background_color),
      box_padding: slider(p.box_padding),
      quote_text_color: text(p.quote_text_color),
      quote_size: slider(p.quote_size),
    }),
  },

  animated_headline: {
    widgetType: 'animated-headline', tier: PRO, label: 'Animated Headline',
    settings: (p) => ({
      headline_style: choice(p.headline_style, HEADLINE_STYLES, 'highlight'),
      animation_type: choice(p.animation_type, HEADLINE_ANIMATIONS, 'typing'),
      marker: choice(p.marker, HEADLINE_MARKERS, 'circle'),
      before_text: text(p.before_text),
      highlighted_text: text(p.highlighted_text),
      rotating_text: text(p.rotating_text),
      after_text: text(p.after_text),
      loop: switchOn(p.loop),
      link: link(p.link),
      tag: choice(p.tag, HEADLINE_TAGS, 'h3'),
    }),
  },

  text_path: {
    widgetType: 'text-path', tier: FREE, label: 'Text Path',
    settings: (p) => ({
      text: text(p.text),
      path: choice(p.path, TEXT_PATHS, 'wave'),
      custom_path: { url: text(p.custom_path), id: text(p.custom_path_id), size: '' },
      link: link(p.link),
      align: choice(p.align, ALIGNMENTS, ''),
      text_path_direction: choice(p.text_path_direction, TEXT_DIRECTIONS, ''),
      show_path: switchOn(p.show_path),
      size: slider(p.size),
      start_point: slider(p.start_point, '%'),
      text_color_normal: text(p.text_color_normal),
      path_fill_normal: text(p.path_fill_normal),
      stroke_color_normal: text(p.stroke_color_normal),
      stroke_width_normal: slider(p.stroke_width_normal),
    }),
  },

  table_of_contents: {
    widgetType: 'table-of-contents', tier: PRO, label: 'Table of Contents',
    settings: (p) => ({
      title: text(p.title),
      html_tag: choice(p.html_tag, TOC_TAGS, 'h4'),
      /* The page engine finds the headings itself, on the published page. We
         publish WHICH sizes to look for; we never publish the list our own
         canvas found, because the page is the thing with the headings on it. */
      headings_by_tags: (Array.isArray(p.headings_by_tags) ? p.headings_by_tags : ['h2', 'h3', 'h4', 'h5', 'h6'])
        .map((t) => text(t).toLowerCase())
        .filter((t) => TOC_TAGS.indexOf(t) >= 0 && t !== 'div'),
      marker_view: choice(p.marker_view, TOC_MARKERS, 'numbers'),
      no_headings_message: text(p.no_headings_message),
      word_wrap: switchOn(p.word_wrap),
      minimize_box: switchOn(p.minimize_box),
      minimized_on: choice(p.minimized_on, TOC_MINIMIZED_ON, 'tablet'),
      hierarchical_view: switchOn(p.hierarchical_view),
      collapse_subitems: switchOn(p.collapse_subitems),
      background_color: text(p.background_color),
      border_color: text(p.border_color),
      border_width: slider(p.border_width),
    }),
  },

  code_highlight: {
    widgetType: 'code-highlight', tier: PRO, label: 'Code Highlight',
    settings: (p) => ({
      language: choice(p.language, CODE_LANGUAGES, 'javascript'),
      code: text(p.code),
      line_numbers: switchOn(p.line_numbers, 'line-numbers'),
      copy_to_clipboard: switchOn(p.copy_to_clipboard, 'copy-to-clipboard'),
      highlight_lines: text(p.highlight_lines),
      word_wrap: switchOn(p.word_wrap),
      theme: choice(p.theme, CODE_THEMES, 'default'),
      font_size: slider(p.font_size),
    }),
  },

  read_more: {
    widgetType: 'read-more', tier: FREE, label: 'Read More',
    settings: (p) => ({ link_text: text(p.link_text) }),
  },

  sidebar: {
    widgetType: 'sidebar', tier: FREE, label: 'Sidebar',
    settings: (p) => ({ sidebar: text(p.sidebar) }),
  },
};


export default EMITTERS;
