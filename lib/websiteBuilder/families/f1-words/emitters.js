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

export const EMITTERS = {
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
