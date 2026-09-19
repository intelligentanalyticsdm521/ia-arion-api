/**
 * families/f4-moving/emitters.js - what the f4-moving family PUBLISHES.
 *
 * BUILDER_FULL_WIDGET_PLAN_2026-09-19 section C.1. One row per widget kind,
 * the same shape ELEMENTOR_WIDGETS has always had:
 *
 *   kind: {
 *     widgetType,             // what the WEBSITE calls it - the engine's slug
 *     tier,                   // FREE | PRO | `ia:<product>`
 *     label,                  // for the message when a plan cannot carry it
 *     settings(props, ctx)    // the widget's own settings object
 *     node(props, ctx)        // OR a whole TREE, for a nested element
 *   }
 *
 * EXACTLY ONE of `settings` and `node` - `website-elementor-tree.test.mjs`
 * says so, because a row with both is a row with two answers.
 *
 * A settings key the engine does not have is DROPPED SILENTLY on publish and
 * the author's change does nothing on the live page. So every key here is in
 * the widget's list in the Portal's test/fixtures/WIDGET_SETTINGS_KEYS.json,
 * and this family's test asserts it by EXECUTING the row.
 *
 * Nothing in here ever opens elementorWidgets.js or another family's folder.
 *
 * ── WAVE 2, 2026-09-19: THE DEPRECATED WIDGETS ARE GONE ───────────────────
 * Wave 1 left `tabs` and `accordion` publishing Elementor's DEPRECATED
 * `tabs` / `accordion` widgets - plan section B.2's open defect - because
 * fixing it needed one live capture of what Elementor writes for a
 * `nested-tabs`, and the rule is do not guess. That capture exists now:
 * `overnight-report/elementor-reference/widgets/_g4_nested_tree.json`, taken
 * out of the real editor's own serializer on 2026-09-19. It says, exactly:
 *
 *   nested-tabs       settings.tabs  = [{ tab_title, _id }]
 *                     elements       = one CONTAINER per tab, each
 *                                      { _title: "<the tab's title>",
 *                                        content_width: "full" }
 *   nested-accordion  settings.items = [{ item_title, _id }]
 *                     elements       = one CONTAINER per item, same shape
 *
 * …and the words of a panel are WIDGETS INSIDE that container. So both rows
 * below build the real tree with `node()`, and `show_in_panel` says why it
 * matters: in the live editor `tabs` and `accordion` are both FALSE and
 * `nested-tabs` / `nested-accordion` are both TRUE. We were publishing two
 * widgets a person can no longer even add.
 *
 * The other three rows are DEEPENED: every Style control the rebuilt panel
 * offers is sent, under Elementor's own key.
 */
import { escapeHtml, mintId } from '../../elementorIds.js';

/** The three words a tier can be, spelled here so this file imports no rows. */
const FREE = 'free';
const PRO = 'pro';

const text = (v) => String(v == null ? '' : v);
const has = (v) => text(v).trim() !== '';

/** A number inside a range, or the fallback. Never NaN on a published page. */
const num = (v, dflt, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
};

/** Elementor's SLIDER shape. A bare number is dropped by the page engine. */
const slider = (size, unit = 'px') => ({ unit, size, sizes: [] });

/** Elementor's DIMENSIONS shape, from the one number our panel stores. */
const dims = (size, unit = 'px') => ({
  unit, top: String(size), right: String(size), bottom: String(size), left: String(size),
  isLinked: true,
});

/** Elementor's SWITCHER: the string 'yes', or the empty string. Both spellings
 *  of "on" reach us - our panel stores `true`, a page read back stores 'yes'. */
const onOff = (v, dfltOn = false) => {
  if (v === true || v === 'yes' || v === 'show') return 'yes';
  if (v === false || v === '' || v === 'no' || v === 'hide') return '';
  return dfltOn ? 'yes' : '';
};

/** One of the page engine's own values, or its default. A value the control
 *  does not have is not passed through to be ignored - it is refused here. */
const oneOf = (v, allowed, dflt) => (allowed.includes(text(v)) ? text(v) : dflt);

/** Elementor's own HTML tags for a title, in its own order. */
const TITLE_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'p'];

/** Our left / centre / right, in the words Elementor's newer controls use. */
const START_END = { left: 'start', center: 'center', right: 'end', start: 'start', end: 'end' };
const startEnd = (v, dflt = '') => START_END[text(v).toLowerCase()] || dflt;

/**
 * A TYPOGRAPHY GROUP ONLY COUNTS WHEN ITS TOGGLE IS ON.
 *
 * Elementor's group controls carry a `<prefix>typography` popover toggle, and
 * the engine ignores every `<prefix>font_size` beside it unless that toggle is
 * the string 'custom'. Sending the size alone is the silent drop this whole
 * family exists to stop, so the toggle goes with it or neither goes.
 */
function typo(prefix, size, weight) {
  const out = {};
  if (size != null && has(size)) out[`${prefix}font_size`] = slider(num(size, 16, 4, 400));
  if (has(weight)) out[`${prefix}font_weight`] = text(weight);
  if (Object.keys(out).length) out[`${prefix}typography`] = 'custom';
  return out;
}

/** A background group only counts when its TYPE is 'classic'. Same rule. */
function classicBg(prefix, colour) {
  if (!has(colour)) return {};
  return { [`${prefix}background`]: 'classic', [`${prefix}color`]: text(colour) };
}

/** …and a border group only counts when its TYPE is set. */
function solidBorder(prefix, colour) {
  if (!has(colour)) return {};
  return { [`${prefix}border`]: 'solid', [`${prefix}color`]: text(colour) };
}

/**
 * THE PANELS OF A TABS OR AN ACCORDION, however they were stored.
 *
 * Our key is `tabs` and each row is `{ tab_title, tab_content }`; Elementor's
 * nested Accordion calls the list `items` and the title `item_title`, and a
 * page read back off a live site carries those. Both are read here, once.
 */
function panels(p) {
  const raw = Array.isArray(p && p.tabs) ? p.tabs
    : (Array.isArray(p && p.items) ? p.items : []);
  return raw.map((r) => ({
    title: text(r && (r.tab_title != null ? r.tab_title
      : (r.item_title != null ? r.item_title : (r.title != null ? r.title : r.question)))),
    body: text(r && (r.tab_content != null ? r.tab_content
      : (r.item_content != null ? r.item_content : (r.body != null ? r.body : r.answer)))),
  }));
}

/**
 * ONE PANEL, as Elementor's own capture has it: a CONTAINER carrying the
 * panel's title in `_title`, full width, holding the words as a Text Editor.
 *
 * A panel with no words still gets its container, because a tab whose child is
 * missing is a tab Elementor's editor cannot open at all.
 */
function panelContainer(id, title, body) {
  const kids = has(body)
    ? [{
      id: `${id}-t`, elType: 'widget', widgetType: 'text-editor',
      settings: { editor: `<p>${escapeHtml(body)}</p>` },
    }]
    : [];
  return {
    id, elType: 'container',
    settings: { _title: title, content_width: 'full' },
    elements: kids,
    isInner: true,
  };
}

/* ── RATING HAS TWO NAMES, AND THE SITE SAYS WHICH ────────────────────────────
   The page engine renamed this widget: newer builds register `rating`, older
   builds register `star-rating`, and the two have DIFFERENT controls. Driven in
   the live editor on 2026-09-19: `rating` is show_in_panel TRUE and
   `star-rating` is FALSE, so `rating` is the one a person is offered today and
   `star-rating` is what a client's older site still has.

   The rule is `reference_absence_based_guards_fail_open`: gate on the PRESENCE
   of the new name. A site that told us it has `rating` and not `star-rating`
   gets the new widget with the new keys; a site that told us nothing gets what
   we have always published. */
function modernRating(ctx) {
  const seen = ctx && ctx.siteWidgets;
  return Array.isArray(seen) && !seen.includes('star-rating') && seen.includes('rating');
}

/** How many out of how many, from every spelling our panel has ever stored. */
function ratingOf(p) {
  const rawScale = p.rating_scale && typeof p.rating_scale === 'object'
    ? p.rating_scale.size : (p.rating_scale == null ? p.scale : p.rating_scale);
  const scale = num(rawScale, 5, 1, 10);
  return { scale, value: num(p.rating_value == null ? p.rating : p.rating_value, 0, 0, scale) };
}

/** Elementor 4.x `rating` - the tile a person is offered. */
function modernStars(p) {
  const { scale, value } = ratingOf(p);
  const out = {
    rating_scale: slider(scale),
    rating_value: value,
    icon_alignment: startEnd(p.icon_alignment == null ? p.align : p.icon_alignment, 'start'),
  };
  if (has(p.rating_icon)) out.rating_icon = { value: text(p.rating_icon), library: 'eicons' };
  /* A style key only when the author set one: an empty colour published as an
     empty string overrides the site's own theme with nothing. */
  if (has(p.icon_color) || has(p.stars_color)) out.icon_color = text(p.icon_color || p.stars_color);
  if (has(p.icon_unmarked_color)) out.icon_unmarked_color = text(p.icon_unmarked_color);
  if (has(p.icon_size)) out.icon_size = slider(num(p.icon_size, 20, 4, 200));
  if (has(p.icon_gap)) out.icon_gap = slider(num(p.icon_gap, 2, 0, 100));
  return out;
}

/** The older `star-rating`, which is what an existing client site registers. */
function legacyStars(p) {
  const { scale, value } = ratingOf(p);
  const out = {
    rating: value,
    rating_scale: scale === 10 ? '10' : '5',
    title: text(p.title),
    star_style: 'star_fontawesome',
    align: startEnd(p.icon_alignment == null ? p.align : p.icon_alignment, ''),
  };
  if (has(p.icon_color) || has(p.stars_color)) out.stars_color = text(p.icon_color || p.stars_color);
  if (has(p.icon_unmarked_color)) out.stars_unmarked_color = text(p.icon_unmarked_color);
  if (has(p.icon_size)) out.icon_size = slider(num(p.icon_size, 20, 4, 200));
  if (has(p.icon_gap)) out.icon_space = slider(num(p.icon_gap, 2, 0, 100));
  return out;
}

export const EMITTERS = {
  /* ══════════════════════════════════════════════════════════════════════
     Counter — Elementor `counter`, group General, free

     Wave 2 sends every control the rebuilt panel offers. Wave 1 sent nine of
     them; the ten Style keys below are new, and until now an author who set
     the number's colour watched a green Published toast and a page that
     ignored them.
     ══════════════════════════════════════════════════════════════════════ */
  counter: {
    widgetType: 'counter', tier: FREE, label: 'Counter',
    settings: (p) => {
      const out = {
        starting_number: num(p.starting_number, 0, -1e12, 1e12),
        /* `value` is what a page read back off a live site stores; both reach
           the same key rather than two rows deciding differently. */
        ending_number: num(p.ending_number == null ? p.value : p.ending_number, 0, -1e12, 1e12),
        prefix: text(p.prefix),
        suffix: text(p.suffix),
        title: text(p.title == null ? p.label : p.title),
        title_tag: oneOf(p.title_tag, TITLE_TAGS, 'div'),
        /* THE KEY THE OLD ROW DROPPED. Elementor's default is on, so "absent"
           has to mean on here too, or every stored counter changes on publish. */
        thousand_separator: onOff(p.thousand_separator, true),
      };
      if (has(p.duration)) out.duration = num(p.duration, 2000, 0, 600000);
      if (has(p.thousand_separator_char)) {
        out.thousand_separator_char = oneOf(p.thousand_separator_char, ['.', ' ', '_', "'"], '');
      }
      /* Style › Counter */
      if (has(p.title_position)) out.title_position = oneOf(p.title_position, ['before', 'after'], 'after');
      if (has(p.title_horizontal_alignment)) {
        out.title_horizontal_alignment = startEnd(p.title_horizontal_alignment, 'center');
      }
      if (has(p.number_alignment)) out.number_alignment = startEnd(p.number_alignment, 'center');
      if (has(p.title_gap)) out.title_gap = slider(num(p.title_gap, 0, 0, 200));
      /* Style › Number */
      if (has(p.number_color)) out.number_color = text(p.number_color);
      Object.assign(out, typo('typography_number_', p.typography_number_font_size, p.typography_number_font_weight));
      /* Style › Title */
      if (has(p.title_color)) out.title_color = text(p.title_color);
      Object.assign(out, typo('typography_title_', p.typography_title_font_size, p.typography_title_font_weight));
      return out;
    },
  },

  /* ══════════════════════════════════════════════════════════════════════
     Progress Bar — Elementor `progress`, group General, free
     ══════════════════════════════════════════════════════════════════════ */
  progress_bar: {
    widgetType: 'progress', tier: FREE, label: 'Progress Bar',
    settings: (p) => {
      const pct = p.percent && typeof p.percent === 'object' ? p.percent.size : p.percent;
      const out = {
        title: text(p.title),
        title_tag: oneOf(p.title_tag, TITLE_TAGS, 'span'),
        title_display: onOff(p.title_display, true),
        progress_type: oneOf(p.progress_type, ['', 'info', 'success', 'warning', 'danger'], ''),
        percent: slider(num(pct, 0, 0, 100), '%'),
        /* Elementor stores this one as 'show' rather than 'yes'. Copied from
           the machine file, not from the switcher next to it. */
        display_percentage: (p.display_percentage === false || p.display_percentage === ''
          || p.show_percent === false) ? '' : 'show',
        inner_text: text(p.inner_text),
      };
      /* Style › Title */
      if (has(p.title_color)) out.title_color = text(p.title_color);
      Object.assign(out, typo('typography_', p.typography_font_size, p.typography_font_weight));
      /* Style › Percentage — which is Elementor's own word for the bar */
      if (has(p.bar_color)) out.bar_color = text(p.bar_color);
      if (has(p.bar_bg_color)) out.bar_bg_color = text(p.bar_bg_color);
      if (has(p.bar_height)) out.bar_height = slider(num(p.bar_height, 20, 1, 200));
      if (has(p.bar_border_radius)) out.bar_border_radius = slider(num(p.bar_border_radius, 0, 0, 200));
      /* Style › Inner Text */
      if (has(p.bar_inline_color)) out.bar_inline_color = text(p.bar_inline_color);
      Object.assign(out, typo('bar_inner_typography_', p.bar_inner_typography_font_size, null));
      return out;
    },
  },

  /* ══════════════════════════════════════════════════════════════════════
     Rating — Elementor `rating` (or `star-rating` on an older site), free

     Our stored kind is `star_rating` and the tile says "Rating", which is
     Elementor's own title; the id is unchanged because documents carry it.

     THE TITLE, still. Elementor's Rating widget has no title control, so on a
     site that registers the modern widget an author's title has nowhere to go.
     The right shape is a Heading above a Rating, which is a SECTION TEMPLATE
     and D-168's own model; a `node()` here cannot be the answer because this
     row also needs `settings()` for the older widget and a row may not have
     both. The loss is asserted OUT LOUD by this family's test rather than left
     to look green.
     ══════════════════════════════════════════════════════════════════════ */
  star_rating: {
    widgetType: 'star-rating', tier: FREE, label: 'Rating',
    widgetTypeFor: (ctx) => (modernRating(ctx) ? 'rating' : 'star-rating'),
    settings: (p, ctx) => (modernRating(ctx) ? modernStars(p) : legacyStars(p)),
  },

  /* ══════════════════════════════════════════════════════════════════════
     Tabs — Elementor `nested-tabs`, group General, free

     A NESTED element: the settings carry the titles and the CHILD CONTAINERS
     carry the words. Built from the live capture named in this file's header,
     not from memory.
     ══════════════════════════════════════════════════════════════════════ */
  tabs: {
    widgetType: 'nested-tabs', tier: FREE, label: 'Tabs',
    node: (p, ctx) => {
      const rows = panels(p);
      /* A Tabs with no tabs is a widget that draws an empty strip. Refused by
         name, which `resolveWidget` turns into a sentence the author reads,
         rather than published as a blank band. */
      if (!rows.length) return null;
      const id = (ctx && ctx.nodeId) || mintId((ctx && ctx.seed) || 't', 'tabs');
      const settings = {
        tabs: rows.map((r, i) => ({ _id: `t${i}`, tab_title: r.title })),
        tabs_direction: oneOf(p.tabs_direction,
          ['block-start', 'block-end', 'inline-start', 'inline-end'], 'block-start'),
      };
      if (has(p.tabs_justify_horizontal)) {
        settings.tabs_justify_horizontal = oneOf(p.tabs_justify_horizontal,
          ['start', 'center', 'end', 'stretch'], 'start');
      }
      if (has(p.tabs_justify_vertical)) {
        settings.tabs_justify_vertical = oneOf(p.tabs_justify_vertical,
          ['start', 'center', 'end', 'stretch'], 'start');
      }
      if (has(p.tabs_width)) settings.tabs_width = slider(num(p.tabs_width, 30, 1, 100), '%');
      if (has(p.title_alignment)) settings.title_alignment = startEnd(p.title_alignment, 'start');
      /* Style › Tabs */
      if (has(p.tabs_title_space_between)) {
        settings.tabs_title_space_between = slider(num(p.tabs_title_space_between, 0, 0, 200));
      }
      if (has(p.tabs_title_spacing)) {
        settings.tabs_title_spacing = slider(num(p.tabs_title_spacing, 0, 0, 200));
      }
      Object.assign(settings, classicBg('tabs_title_background_color_', p.tabs_title_background_color_color));
      Object.assign(settings, solidBorder('tabs_title_border_', p.tabs_title_border_color));
      Object.assign(settings,
        classicBg('tabs_title_background_color_active_', p.tabs_title_background_color_active_color));
      /* Style › Titles */
      if (has(p.title_text_color)) settings.title_text_color = text(p.title_text_color);
      if (has(p.title_text_color_active)) settings.title_text_color_active = text(p.title_text_color_active);
      Object.assign(settings, typo('title_typography_', p.title_typography_font_size, p.title_typography_font_weight));
      /* Style › Content */
      Object.assign(settings, classicBg('box_background_color_', p.box_background_color_color));
      Object.assign(settings, solidBorder('box_border_', p.box_border_color));
      if (has(p.box_padding)) settings.box_padding = dims(num(p.box_padding, 12, 0, 200));
      return {
        id, elType: 'widget', widgetType: 'nested-tabs', settings,
        elements: rows.map((r, i) => panelContainer(`${id}-p${i}`, r.title, r.body)),
      };
    },
  },

  /* ══════════════════════════════════════════════════════════════════════
     Accordion — Elementor `nested-accordion`, group General, free

     Same nested shape, and Elementor's own key names: the list is `items` and
     the title is `item_title`. Ours are `tabs` / `tab_title`, and they stay
     ours in the database — the translation happens HERE, once, on the way out.
     ══════════════════════════════════════════════════════════════════════ */
  accordion: {
    widgetType: 'nested-accordion', tier: FREE, label: 'Accordion',
    node: (p, ctx) => {
      const rows = panels(p);
      if (!rows.length) return null;
      const id = (ctx && ctx.nodeId) || mintId((ctx && ctx.seed) || 'a', 'accordion');
      const settings = {
        items: rows.map((r, i) => ({ _id: `a${i}`, item_title: r.title })),
        title_tag: oneOf(p.title_tag == null ? p.title_html_tag : p.title_tag, TITLE_TAGS, 'div'),
      };
      if (has(p.accordion_item_title_position_horizontal)) {
        settings.accordion_item_title_position_horizontal =
          startEnd(p.accordion_item_title_position_horizontal, 'start');
      }
      if (has(p.accordion_item_title_icon_position)) {
        settings.accordion_item_title_icon_position =
          oneOf(startEnd(p.accordion_item_title_icon_position, 'start'), ['start', 'end'], 'start');
      }
      if (p.faq_schema != null) settings.faq_schema = onOff(p.faq_schema);
      if (has(p.default_state)) {
        settings.default_state = oneOf(p.default_state, ['expanded', 'all_collapsed'], 'expanded');
      }
      /* Style › Accordion */
      if (has(p.accordion_item_title_space_between)) {
        settings.accordion_item_title_space_between =
          slider(num(p.accordion_item_title_space_between, 0, 0, 200));
      }
      if (has(p.accordion_item_title_distance_from_content)) {
        settings.accordion_item_title_distance_from_content =
          slider(num(p.accordion_item_title_distance_from_content, 0, 0, 200));
      }
      Object.assign(settings, classicBg('accordion_background_normal_', p.accordion_background_normal_color));
      Object.assign(settings, solidBorder('accordion_border_normal_', p.accordion_border_normal_color));
      /* Style › Header */
      if (has(p.normal_title_color)) settings.normal_title_color = text(p.normal_title_color);
      if (has(p.active_title_color)) settings.active_title_color = text(p.active_title_color);
      Object.assign(settings, typo('title_typography_', p.title_typography_font_size, p.title_typography_font_weight));
      if (has(p.normal_icon_color)) settings.normal_icon_color = text(p.normal_icon_color);
      if (has(p.icon_spacing)) settings.icon_spacing = slider(num(p.icon_spacing, 8, 0, 200));
      /* Style › Content */
      Object.assign(settings, classicBg('content_background_', p.content_background_color));
      Object.assign(settings, solidBorder('content_border_', p.content_border_color));
      if (has(p.content_padding)) settings.content_padding = dims(num(p.content_padding, 10, 0, 200));
      return {
        id, elType: 'widget', widgetType: 'nested-accordion', settings,
        elements: rows.map((r, i) => panelContainer(`${id}-p${i}`, r.title, r.body)),
      };
    },
  },

  /* ══════════════════════════════════════════════════════════════════════
     Progress Tracker — Elementor `progress-tracker`, Pro

     A bar that fills as the reader scrolls. PRO, so a site on a plan that
     does not carry it gets the plan sentence rather than a blank band; there
     is no `fallback`, because there is no free widget that does this and a
     made-up substitute is worse than an honest refusal.
     ══════════════════════════════════════════════════════════════════════ */
  progress_tracker: {
    widgetType: 'progress-tracker', tier: PRO, label: 'Progress Tracker',
    settings: (p) => {
      const relative = oneOf(p.relative_to, ['entire_page', 'post_content', 'selector'], 'entire_page');
      const out = {
        type: oneOf(p.type, ['horizontal', 'circular'], 'horizontal'),
        relative_to: relative,
        percentage: onOff(p.percentage),
        align: oneOf(p.align, ['left', 'center', 'right'], ''),
      };
      /* A selector is only read when the tracker is relative to one, and an
         empty one published against `selector` is a tracker that tracks
         nothing. Send it only when both are true. */
      if (relative === 'selector' && has(p.selector)) out.selector = text(p.selector);
      if (has(p.direction)) out.direction = oneOf(p.direction, ['ltr', 'rtl'], 'ltr');
      if (has(p.percentage_position)) {
        out.percentage_position = oneOf(p.percentage_position, ['ltr', 'rtl'], 'ltr');
      }
      if (has(p.horizontal_color_color)) out.horizontal_color_color = text(p.horizontal_color_color);
      if (has(p.horizontal_background_color_color)) {
        out.horizontal_background_color_color = text(p.horizontal_background_color_color);
      }
      if (has(p.horizontal_height)) out.horizontal_height = slider(num(p.horizontal_height, 10, 1, 200));
      if (has(p.circular_size)) out.circular_size = slider(num(p.circular_size, 120, 20, 600));
      if (has(p.circular_width)) out.circular_width = slider(num(p.circular_width, 8, 1, 80));
      if (has(p.circular_color)) out.circular_color = text(p.circular_color);
      if (has(p.circular_background_color)) out.circular_background_color = text(p.circular_background_color);
      if (has(p.percentage_color)) out.percentage_color = text(p.percentage_color);
      return out;
    },
  },
};

export default EMITTERS;
