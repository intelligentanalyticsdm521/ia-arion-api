/**
 * families/f7-data-lists/emitters.js - what the f7-data-lists family PUBLISHES.
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
 *   }
 *
 * A settings key the engine does not have is DROPPED SILENTLY on publish and
 * the author's change does nothing on the live page. So every key here is in
 * the widget's list in `test/fixtures/WIDGET_SETTINGS_KEYS.json` - a byte copy
 * of the Portal's, cut from the 2026-09-17 scrape of a real install - and
 * `test/website-builder-f7-data-lists.test.js` asserts it, widget by widget.
 *
 * ── THE VALUE SHAPES ARE THE ENGINE'S, NOT OURS ───────────────────────────
 * A key being right is half of it. Elementor stores a switcher as the STRING
 * "yes" (never a boolean), a slider as `{ unit, size, sizes }` (never a bare
 * number), a link as `{ url, is_external, nofollow }` and a picture as
 * `{ url, id }`. A bare number where the engine wants a slider is a value the
 * page reads as nothing, which looks exactly like the key being wrong. The four
 * helpers below are the only places those shapes are written.
 *
 * ── EVERY ONE OF THESE IS PRO ─────────────────────────────────────────────
 * All nineteen are Elementor Pro widgets. The offer file's `pro_rule` is
 * "offered on ARION Standard and up; on Lite the tile shows a padlock", and the
 * padlock is drawn from `tier` - which is why no row here is FREE.
 *
 * Nothing in here ever opens elementorWidgets.js or another family's folder.
 */
/**
 * THE WORD, NOT THE IMPORT.
 *
 * `elementorWidgets.js` exports `PRO = 'pro'`, and importing it from here would
 * close a circle - that file imports `families/index.js`, which imports this
 * one - so the constant would be read while its own module was still
 * evaluating. The catalogue is the importer and a family is the imported; a
 * family reaching back up is the coupling section C.1 exists to remove. One
 * three-letter word, and the family test asserts every row carries it.
 */
const PRO = 'pro';

/* ══════════════════════════════════════════════════════════════════════════
   The four value shapes
   ══════════════════════════════════════════════════════════════════════════ */

const text = (v) => String(v == null ? '' : v);

/**
 * Elementor's switcher: the string "yes", or empty. Never a boolean.
 *
 * `dflt` IS THE ENGINE'S OWN DEFAULT, and it matters. A switcher the author
 * never touched arrives here as `undefined`, and reading that as "off" turns
 * OFF every title, excerpt and Read More on a Posts grid the moment it is
 * published — Elementor's own default for those three is "yes". So an ABSENT
 * value takes the widget's default and only a value that is really there is
 * read. Found by executing the emitter with no props and looking at what came
 * out, not by reading it.
 */
const yn = (v, dflt = false) => {
  if (v === undefined || v === null) return dflt ? 'yes' : '';
  return v === true || v === 'yes' ? 'yes' : '';
};

/** A whole number, with the engine's own default when the author left it blank. */
function int(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : dflt;
}

/** Elementor's slider control. A bare number here reads as nothing on the page. */
function slider(v, dflt, unit = 'px') {
  const n = Number(v);
  return { unit, size: Number.isFinite(n) && n !== 0 ? n : dflt, sizes: [] };
}

/** Elementor's link control. An empty url is a link that goes nowhere, which is
 *  what the author gets until they say where it goes - never a made-up one. */
const link = (url) => ({ url: text(url), is_external: '', nofollow: '' });

/**
 * Elementor's media control, reading the SHAPE THE PAGE ALREADY HOLDS.
 *
 * B-168, 2026-09-22: a page read back off a client's own website hands this
 * the engine's own `{ url, id }` object, not the plain address the panel
 * writes. Both, for the same reason `faIcon` takes both and `pick` takes two
 * spellings - the alternative is `"[object Object]"` where the picture was,
 * on somebody's live page. Measured by the reader's round trip, not guessed.
 */
const media = (url) => ({ url: text(url && typeof url === 'object' ? (url.url || url.src) : url), id: 0 });

/** One of a list, or the engine's own default. A value the engine does not know
 *  is a setting it drops, so it is refused here rather than passed through. */
function choice(v, allowed, dflt) {
  const s = text(v).trim();
  return allowed.indexOf(s) === -1 ? dflt : s;
}

const COLUMNS = ['1', '2', '3', '4', '5', '6'];
const TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'p'];
const ORDERBY = ['post_date', 'post_title', 'menu_order', 'modified', 'comment_count', 'rand'];
const ORDER = ['asc', 'desc'];
const SOURCES = ['post', 'page', 'by_id', 'current_query', 'related'];
const PAGINATION = ['', 'numbers', 'prev_next', 'numbers_and_prev_next', 'load_more_on_click', 'load_more_infinite_scroll'];
const RESOLUTIONS = ['thumbnail', 'medium', 'medium_large', 'large', 'full'];
const ALIGN3 = ['left', 'center', 'right'];
const ALIGN_START = ['start', 'center', 'end'];

/** THE QUERY BLOCK, published. One reader, five prefixes - the mirror of the
 *  Portal's `families/f7-data-lists/shared.ts`. Search has the short one. */
function query(p, prefix, withOffset) {
  const out = {};
  out[`${prefix}post_type`] = choice(p[`${prefix}post_type`], SOURCES, 'post');
  out[`${prefix}orderby`] = choice(p[`${prefix}orderby`], ORDERBY, 'post_date');
  out[`${prefix}order`] = choice(p[`${prefix}order`], ORDER, 'desc');
  if (!withOffset) return out;
  out[`${prefix}offset`] = int(p[`${prefix}offset`], 0);
  out[`${prefix}avoid_duplicates`] = yn(p[`${prefix}avoid_duplicates`]);
  return out;
}

/** THE PAGINATION BLOCK, published. Search's keys are a different four; see the
 *  Portal's `shared.ts` header for which and why. */
function pagination(p) {
  return {
    pagination_type: choice(p.pagination_type, PAGINATION, ''),
    pagination_page_limit: String(int(p.pagination_page_limit, 5)),
    pagination_prev_label: text(p.pagination_prev_label) || '« Previous',
    pagination_next_label: text(p.pagination_next_label) || 'Next »',
    pagination_align: choice(p.pagination_align, ALIGN_START, 'center'),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   THE NINETEEN ROWS
   ══════════════════════════════════════════════════════════════════════════ */

export const EMITTERS = {
  /* ── the lists ───────────────────────────────────────────────────────── */

  posts: {
    widgetType: 'posts', tier: PRO, label: 'Posts',
    settings: (p = {}) => Object.assign({
      /* THE SKIN IS PUBLISHED EXPLICITLY. Elementor registers three (classic,
         cards, full_content) and we build the CLASSIC one, which is its own
         default. Saying so on the node means the page never depends on what the
         engine's default happens to be next release. */
      _skin: 'classic',
      classic_columns: choice(p.classic_columns, COLUMNS, '3'),
      classic_posts_per_page: int(p.classic_posts_per_page, 6),
      classic_thumbnail: choice(p.classic_thumbnail, ['top', 'left', 'right', 'none'], 'top'),
      classic_show_title: yn(p.classic_show_title, true),
      classic_title_tag: choice(p.classic_title_tag, TAGS, 'h3'),
      classic_show_excerpt: yn(p.classic_show_excerpt, true),
      classic_excerpt_length: int(p.classic_excerpt_length, 100),
      classic_show_read_more: yn(p.classic_show_read_more, true),
      classic_read_more_text: text(p.classic_read_more_text) || 'Read More »',
      classic_column_gap: slider(p.classic_column_gap, 30),
      classic_row_gap: slider(p.classic_row_gap, 35),
      classic_alignment: choice(p.classic_alignment, ALIGN3, ''),
      classic_title_color: text(p.classic_title_color),
      classic_meta_color: text(p.classic_meta_color),
      classic_excerpt_color: text(p.classic_excerpt_color),
    }, query(p, 'posts_', true), pagination(p)),
  },

  portfolio: {
    widgetType: 'portfolio', tier: PRO, label: 'Portfolio',
    settings: (p = {}) => Object.assign({
      columns: choice(p.columns, COLUMNS, '3'),
      posts_per_page: int(p.posts_per_page, 6),
      thumbnail_size_size: choice(p.thumbnail_size_size, RESOLUTIONS, 'medium'),
      masonry: yn(p.masonry),
      item_ratio: slider(p.item_ratio, 0.66),
      show_title: yn(p.show_title, true),
      title_tag: choice(p.title_tag, TAGS, 'h3'),
      show_filter_bar: yn(p.show_filter_bar),
      taxonomy: text(p.taxonomy) || 'category',
      item_gap: slider(p.item_gap, 10),
      column_gap: slider(p.column_gap, 10),
      row_gap: slider(p.row_gap, 10),
    }, query(p, 'posts_', true)),
  },

  loop_grid: {
    widgetType: 'loop-grid', tier: PRO, label: 'Loop Grid',
    settings: (p = {}) => Object.assign({
      template_id: int(p.template_id, 0),
      columns: String(int(p.columns, 3)),
      posts_per_page: int(p.posts_per_page, 6),
      masonry: yn(p.masonry),
      equal_height: yn(p.equal_height),
      enable_nothing_found_message: yn(p.enable_nothing_found_message, true),
      nothing_found_message_text: text(p.nothing_found_message_text),
    }, query(p, 'post_query_', true), pagination(p)),
  },

  archive_posts: {
    widgetType: 'archive-posts', tier: PRO, label: 'Archive Posts',
    /* NO QUERY BLOCK, and that is the widget, not an omission: an archive shows
       whatever list the visitor asked for, so the query is the page's. */
    settings: (p = {}) => Object.assign({
      _skin: 'archive_classic',
      archive_classic_columns: choice(p.archive_classic_columns, COLUMNS, '3'),
      archive_classic_thumbnail: choice(p.archive_classic_thumbnail, ['top', 'left', 'right', 'none'], 'top'),
      archive_classic_show_title: yn(p.archive_classic_show_title, true),
      archive_classic_title_tag: choice(p.archive_classic_title_tag, TAGS, 'h3'),
      archive_classic_show_excerpt: yn(p.archive_classic_show_excerpt, true),
      archive_classic_excerpt_length: int(p.archive_classic_excerpt_length, 100),
      archive_classic_show_read_more: yn(p.archive_classic_show_read_more, true),
      archive_classic_read_more_text: text(p.archive_classic_read_more_text) || 'Read More »',
      archive_classic_column_gap: slider(p.archive_classic_column_gap, 30),
      archive_classic_row_gap: slider(p.archive_classic_row_gap, 35),
      archive_classic_title_color: text(p.archive_classic_title_color),
      archive_classic_meta_color: text(p.archive_classic_meta_color),
      archive_classic_excerpt_color: text(p.archive_classic_excerpt_color),
      nothing_found_message: text(p.nothing_found_message),
    }, pagination(p)),
  },

  /* ── the two that narrow a list ──────────────────────────────────────── */

  taxonomy_filter: {
    widgetType: 'taxonomy-filter', tier: PRO, label: 'Taxonomy Filter',
    settings: (p = {}) => ({
      selected_element: text(p.selected_element),
      taxonomy: text(p.taxonomy) || 'category',
      direction: choice(p.direction, ['horizontal', 'vertical'], 'horizontal'),
      item_alignment_horizontal: choice(p.item_alignment_horizontal, ['start', 'center', 'end', 'stretch'], ''),
      multiple_selection: yn(p.multiple_selection),
      logical_combination: choice(p.logical_combination, ['AND', 'OR'], 'AND'),
      show_empty_items: yn(p.show_empty_items),
      show_first_item: yn(p.show_first_item, true),
      first_item_title: text(p.first_item_title) || 'All',
      taxonomy_filter_items_space_between: slider(p.taxonomy_filter_items_space_between, 10),
      taxonomy_filter_normal_text_color: text(p.taxonomy_filter_normal_text_color),
    }),
  },

  search: {
    widgetType: 'search', tier: PRO, label: 'Search',
    /* THE NO-JS DEFAULT IS PUBLISHED. `live_results` off means the engine draws
       an ordinary GET form, which is what a browser with no script gets. */
    settings: (p = {}) => Object.assign({
      search_input_placeholder_text: text(p.search_input_placeholder_text) || 'Type to start searching...',
      submit_trigger: choice(p.submit_trigger, ['click_submit', 'key_enter', 'both'], 'click_submit'),
      submit_button_text: text(p.submit_button_text) || 'Search',
      live_results: yn(p.live_results),
      minimum_search_characters: int(p.minimum_search_characters, 3),
      number_of_columns: int(p.number_of_columns, 1),
      number_of_items: int(p.number_of_items, 6),
      enable_nothing_found_message: yn(p.enable_nothing_found_message, true),
      nothing_found_message_text: text(p.nothing_found_message_text),
      pagination_type_options: choice(
        p.pagination_type_options, ['none', 'numbers', 'previous_next', 'numbers_previous_next'], 'none'),
      pagination_prev_label: text(p.pagination_prev_label) || 'Previous',
      pagination_next_label: text(p.pagination_next_label) || 'Next',
    }, query(p, 'search_query_', false)),
  },

  /* ── site furniture ──────────────────────────────────────────────────── */

  sitemap: {
    widgetType: 'sitemap', tier: PRO, label: 'Sitemap',
    settings: (p = {}) => ({
      sitemap_items: (Array.isArray(p.sitemap_items) ? p.sitemap_items : []).map((row, i) => ({
        _id: `s${i}`,
        sitemap_type_selector: choice(row && row.sitemap_type_selector, ['post_type', 'taxonomy'], 'post_type'),
        sitemap_source_post_type: text(row && row.sitemap_source_post_type) || 'page',
        sitemap_source_taxonomy: text(row && row.sitemap_source_taxonomy) || 'category',
        sitemap_title: text(row && row.sitemap_title),
      })),
      sitemap_columns: choice(p.sitemap_columns, COLUMNS, '4'),
      sitemap_title_tag: choice(p.sitemap_title_tag, TAGS, 'h2'),
      sitemap_add_nofollow: yn(p.sitemap_add_nofollow),
      sitemap_password_protected: yn(p.sitemap_password_protected),
      sitemap_title_color: text(p.sitemap_title_color),
      sitemap_list_item_color: text(p.sitemap_list_item_color),
      sitemap_list_item_bullet_style: choice(
        p.sitemap_list_item_bullet_style, ['disc', 'circle', 'square', 'none'], 'disc'),
    }),
  },

  /* BREADCRUMBS IS NOT HERE, and it is evidence rather than an oversight. The
     offer file lists it; the 2026-09-17 PRO scrape has no `breadcrumbs` widget
     at all (Elementor Pro registers Breadcrumbs only when Yoast SEO is
     installed, and that site has none), and the FREE scrape's entry of that
     name is a Pro_Widget_Promotion - the advert shown to a free install, with
     no sections and no controls. Publishing a node the site does not register
     is a blank band on a live page. It is in the handoff as a named gap.
     `scripts/dev/extract-widget-controls.mjs` refused to write a fixture for
     it, which is how this was found and not by reading. */

  template: {
    widgetType: 'template', tier: PRO, label: 'Template',
    settings: (p = {}) => ({ template_id: int(p.template_id, 0) }),
  },

  /* ── the pieces of one story ─────────────────────────────────────────── */

  post_info: {
    widgetType: 'post-info', tier: PRO, label: 'Post Info',
    settings: (p = {}) => ({
      view: choice(p.view, ['traditional', 'inline'], 'inline'),
      icon_list: (Array.isArray(p.icon_list) ? p.icon_list : []).map((row, i) => ({
        _id: `f${i}`,
        type: choice(row && row.type, ['author', 'date', 'time', 'comments', 'terms', 'custom'], 'date'),
        custom_text: text(row && row.custom_text),
      })),
      space_between: slider(p.space_between, 12),
      icon_align: choice(p.icon_align, ALIGN3, ''),
      divider: yn(p.divider),
      divider_color: text(p.divider_color) || '#ddd',
      icon_color: text(p.icon_color),
      icon_size: slider(p.icon_size, 14),
      text_color: text(p.text_color),
    }),
  },

  post_navigation: {
    widgetType: 'post-navigation', tier: PRO, label: 'Post Navigation',
    settings: (p = {}) => ({
      show_label: yn(p.show_label, true),
      prev_label: text(p.prev_label) || 'Previous',
      next_label: text(p.next_label) || 'Next',
      show_arrow: yn(p.show_arrow, true),
      show_title: yn(p.show_title, true),
      show_borders: yn(p.show_borders, true),
      label_color: text(p.label_color),
      text_color: text(p.text_color),
      arrow_color: text(p.arrow_color),
      arrow_size: slider(p.arrow_size, 20),
      sep_color: text(p.sep_color),
    }),
  },

  post_comments: {
    widgetType: 'post-comments', tier: PRO, label: 'Post Comments',
    settings: (p = {}) => ({
      source_type: choice(p.source_type, ['current_post', 'custom'], 'current_post'),
      source_custom: text(int(p.source_custom, 0) || ''),
    }),
  },

  author_box: {
    widgetType: 'author-box', tier: PRO, label: 'Author Box',
    settings: (p = {}) => ({
      source: choice(p.source, ['current', 'custom'], 'current'),
      show_avatar: yn(p.show_avatar, true),
      avatar_size: int(p.avatar_size, 300),
      author_avatar: media(p.author_avatar),
      show_name: yn(p.show_name, true),
      author_name: text(p.author_name),
      author_name_tag: choice(p.author_name_tag, ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span'], 'h4'),
      show_biography: yn(p.show_biography, true),
      author_bio: text(p.author_bio),
      show_link: yn(p.show_link),
      link_text: text(p.link_text) || 'All Posts',
      posts_url: link(p.posts_url),
      layout: choice(p.layout, ['left', 'above', 'right'], 'left'),
      alignment: choice(p.alignment, ALIGN3, 'left'),
      image_size: slider(p.image_size, 80),
      name_color: text(p.name_color),
      bio_color: text(p.bio_color),
      button_text_color: text(p.button_text_color),
      button_background_color: text(p.button_background_color),
    }),
  },

  /* ── the theme-* pieces ──────────────────────────────────────────────── */

  theme_site_logo: {
    widgetType: 'theme-site-logo', tier: PRO, label: 'Site Logo',
    settings: (p = {}) => ({
      image: media(p.image),
      image_size: choice(p.image_size, RESOLUTIONS, 'full'),
      caption_source: choice(p.caption_source, ['none', 'attachment'], 'none'),
      link_to: choice(p.link_to, ['none', 'file', 'custom', 'site_url'], 'site_url'),
      link: link(p.link),
      open_lightbox: choice(p.open_lightbox, ['default', 'yes', 'no'], 'default'),
      align: choice(p.align, ALIGN3, ''),
    }),
  },

  theme_post_featured_image: {
    widgetType: 'theme-post-featured-image', tier: PRO, label: 'Featured Image',
    settings: (p = {}) => ({
      image: media(p.image),
      image_size: choice(p.image_size, RESOLUTIONS, 'large'),
      caption_source: choice(p.caption_source, ['none', 'attachment', 'custom'], 'none'),
      caption: text(p.caption),
      link_to: choice(p.link_to, ['none', 'file', 'custom'], 'none'),
      link: link(p.link),
      open_lightbox: choice(p.open_lightbox, ['default', 'yes', 'no'], 'default'),
      align: choice(p.align, ALIGN3, ''),
    }),
  },

  theme_post_excerpt: {
    widgetType: 'theme-post-excerpt', tier: PRO, label: 'Post Excerpt',
    settings: (p = {}) => ({
      excerpt: text(p.excerpt),
      align: choice(p.align, ['start', 'center', 'end', 'justify'], ''),
      title_color: text(p.title_color),
      link_color: text(p.link_color),
    }),
  },

  theme_site_title: headingRow('theme-site-title', 'Site Title', 'h2'),
  theme_page_title: headingRow('theme-page-title', 'Page Title', 'h1'),
  theme_post_title: headingRow('theme-post-title', 'Post Title', 'h1'),
  theme_archive_title: headingRow('theme-archive-title', 'Archive Title', 'h1'),
};

/**
 * THE FOUR HEADINGS ARE ONE ROW, FOUR TIMES.
 *
 * Elementor registers Site Title, Page Title, Post Title and Archive Title with
 * the same five keys and a different default tag. Four copies of one settings
 * function is four places for them to drift apart, so there is one.
 *
 * Declared after the map it is used in on purpose: a `function` declaration is
 * hoisted, so this reads top-down as the catalogue and still resolves.
 */
function headingRow(widgetType, label, dfltTag) {
  return {
    widgetType, tier: PRO, label,
    settings: (p = {}) => ({
      title: text(p.title),
      link: link(p.link),
      size: choice(p.size, ['default', 'small', 'medium', 'large', 'xl', 'xxl'], 'default'),
      header_size: choice(p.header_size, TAGS, dfltTag),
      align: choice(p.align, ['start', 'center', 'end', 'justify'], ''),
      title_color: text(p.title_color),
    }),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   THE FAMILY'S IA TWIN — IA Posts (B-168 wave 2)
   ══════════════════════════════════════════════════════════════════════════

   `ia_posts` is a REGISTERED Elementor widget: the IA plugin's own, in
   Elementor's `intelligent-analytics` category, with 207 controls. It is in
   `WIDGET_SETTINGS_KEYS.json` exactly like the nineteen above, so every key
   below is checked against the machine file in the same way and by the same
   test. That is the whole reason an IA widget is a DATABASE TWIN rather than
   an invention: there is a real panel to copy, and a real page to publish to.

   ── THE ROW THAT WAS HERE PUBLISHED TWO KEYS, AND ONE OF THEM WAS DEAD ────
   `settings: (p) => ({ posts_per_page: Number(p.count) || 3, columns:
   Number(p.columns) || 3 })`. The Portal's definition stored `items` and
   `layout` and NEVER wrote `count`, so the number of posts published was
   always the fallback 3 whatever the author chose, and `columns` was a key no
   control on the panel could reach. Found by reading the two sides together,
   and it is the reason wave 2 exists.

   `count` is still READ here, first, because a page published before today
   carries it. Nothing a customer has loses a setting.

   ── THE TIER IS THE PLUGIN'S, NOT ELEMENTOR PRO'S ────────────────────────
   Every other row in this file is `PRO`. This one is `ia:arion`: it is OUR
   widget, it needs the IA plugin and not an Elementor licence, and
   `reference_nav_visibility_semantics` is explicit that "not on your plan" and
   "needs something you do not have" are two different answers.
*/
const IA_SKINS = ['signal', 'spotlight', 'dispatch', 'stream', 'sidebar', 'showcase', 'atlas',
  'horizon', 'archive', 'edition', 'editorial', 'magazine', 'broadsheet'];
const IA_IMAGE_MODES = ['color_block', 'featured_image', 'none'];
const IA_THEMES = ['light', 'dark'];
const IA_PRESETS = ['simple', 'classic', 'bold'];
const IA_COLUMNS = ['1', '2', '3', '4'];
const IA_POST_TYPES = ['any', 'post', 'portfolio', 'newsletter', 'magazine', 'editorial'];
const IA_ORDERBY = ['date', 'modified', 'title', 'comment_count', 'rand'];
const IA_ORDER = ['DESC', 'ASC'];
const IA_TITLE_TAGS = ['h2', 'h3', 'h4', 'p'];
const IA_PAGINATION = ['none', 'numbers', 'load_more'];
const IA_IMAGE_POSITIONS = ['top left', 'top center', 'top right',
  'center left', 'center center', 'center right',
  'bottom left', 'bottom center', 'bottom right'];
const IA_WEIGHTS = ['', '100', '200', '300', '400', '500', '600', '700', '800', '900', 'normal', 'bold'];

/**
 * A responsive slider, published under all three of Elementor's own spellings.
 *
 * `deviceKey()` in the Portal writes `<key>`, `<key>_tablet` and
 * `<key>_mobile`, and the plugin registers all three. A tablet value the
 * author set and this emitter never published is a field that does nothing on
 * a phone, which is the same silent drop in a different place — so the twins
 * go out whenever they are really there, and are left off when they are not
 * (an absent responsive key is how Elementor says "inherit the desktop one").
 */
function deviceSlider(out, p, key, dflt) {
  out[key] = slider(p[key], dflt);
  for (const suffix of ['_tablet', '_mobile']) {
    const v = p[key + suffix];
    if (v !== undefined && v !== null && v !== '') out[key + suffix] = slider(v, dflt);
  }
}

EMITTERS.ia_posts = {
  widgetType: 'ia_posts', tier: 'ia:arion', label: 'IA Posts',
  settings: (p = {}) => {
    const out = {
      /* Layout */
      post_skin: choice(p.post_skin, IA_SKINS, 'signal'),
      image_mode: choice(p.image_mode, IA_IMAGE_MODES, 'color_block'),
      post_theme: choice(p.post_theme, IA_THEMES, 'light'),
      post_preset: choice(p.post_preset, IA_PRESETS, 'classic'),
      columns: choice(p.columns, IA_COLUMNS, '3'),
      /* `count` is the prop a page published before B-168 carries. */
      posts_per_page: int(p.posts_per_page !== undefined ? p.posts_per_page : p.count, 9),
      /* Query */
      post_type: choice(p.post_type, IA_POST_TYPES, 'any'),
      orderby: choice(p.orderby, IA_ORDERBY, 'date'),
      order: choice(p.order, IA_ORDER, 'DESC'),
      /* Post Fields. Every one of these defaults to "yes" in the plugin, so an
         absent value takes `yes` and only an explicit off is off — the same
         three-answer rule `yn` already documents. */
      show_category: yn(p.show_category, true),
      show_title: yn(p.show_title, true),
      title_tag: choice(p.title_tag, IA_TITLE_TAGS, 'h3'),
      show_excerpt: yn(p.show_excerpt, true),
      excerpt_length: int(p.excerpt_length, 20),
      show_author: yn(p.show_author, true),
      show_date: yn(p.show_date, true),
      show_read_time: yn(p.show_read_time, true),
      show_tags: yn(p.show_tags, true),
      show_read_more: yn(p.show_read_more, true),
      read_more_text: text(p.read_more_text) || 'Read',
      image_position: choice(p.image_position, IA_IMAGE_POSITIONS, 'center center'),
      /* Pagination */
      pagination_type: choice(p.pagination_type, IA_PAGINATION, 'numbers'),
      archive_link: text(p.archive_link && p.archive_link.url ? p.archive_link.url : p.archive_link),
      archive_label: text(p.archive_label) || 'View all articles',
      /* Style · Typography. The weight is a plain select, not a slider. */
      title_typography_font_weight: choice(p.title_typography_font_weight, IA_WEIGHTS, ''),
    };
    /* Style · Card and the three type sizes: sliders, with their device twins. */
    deviceSlider(out, p, 'card_gap', 24);
    deviceSlider(out, p, 'card_border_radius', 8);
    deviceSlider(out, p, 'card_padding', 14);
    deviceSlider(out, p, 'title_typography_font_size', 17);
    deviceSlider(out, p, 'excerpt_typography_font_size', 14);
    deviceSlider(out, p, 'meta_typography_font_size', 12);
    return out;
  },
};


export default EMITTERS;
