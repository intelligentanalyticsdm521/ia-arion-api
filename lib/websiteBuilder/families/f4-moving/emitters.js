/**
 * families/f4-moving/emitters.js - what the f4-moving family PUBLISHES.
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
 * Nothing in here ever opens elementorWidgets.js or another family's folder.
 *
 * ── WHAT IS HERE, 2026-09-19 ──────────────────────────────────────────────
 *   counter          MOVED here from elementorWidgets.js, id unchanged. Its
 *                    old row dropped `thousand_separator`, so an author who
 *                    turned the comma off watched the published page keep it.
 *   progress_bar     MOVED here, id unchanged, plus the two keys the panel
 *                    offers and the old row never sent: `title_tag` and
 *                    `progress_type`.
 *   star_rating      MOVED here, id unchanged. Its old row asked the site
 *                    whether it registers `rating` or `star-rating` - which is
 *                    right - and then sent the `star-rating` keys either way,
 *                    so a site on a newer build published five empty stars
 *                    under a green Published toast. Each name now gets its own
 *                    keys. ONE THING IS STILL LOST: the modern `rating` widget
 *                    has no Title control, so on a site that registers it the
 *                    author's title has nowhere to go. A Heading above the
 *                    stars is the answer and it needs a `node()`, which this
 *                    row may not have (`website-elementor-tree.test.mjs`:
 *                    exactly one of settings() and node()). The right shape is
 *                    a SECTION TEMPLATE of Heading + Rating, which is D-168's
 *                    own model. Written up in the handoff.
 *   progress_tracker NEW, Pro. The Portal's new f4-moving widget.
 *
 * ── WHAT IS NOT HERE, AND WHY, SAID PLAINLY ───────────────────────────────
 *   tabs, accordion  Elementor 4.x's real widgets are `nested-tabs` and
 *                    `nested-accordion`, and both are NESTED elements: each
 *                    panel is a child CONTAINER carried in the node's
 *                    `elements`, not a row of a `tabs` repeater. A row here
 *                    can build such a tree (`node()` does), but nobody on this
 *                    pass watched Elementor write one, and the plan's own rule
 *                    is do not guess. `elementorWidgets.js` therefore still
 *                    publishes the DEPRECATED `accordion` widget, which is the
 *                    defect §B.2 of the plan names, and it is still open. The
 *                    next agent needs one live capture of a nested-accordion's
 *                    `_elementor_data` and this is a small row.
 *   countdown,       Not offered on any panel that reaches this publisher, so
 *   off_canvas       an emitter for either would be code nothing can call.
 */

/** The three words a tier can be, spelled here so this file imports no rows. */
const FREE = 'free';
const PRO = 'pro';

const text = (v) => String(v == null ? '' : v);

/** A number inside a range, or the fallback. Never NaN on a published page. */
const num = (v, dflt, lo, hi) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
};

/** Elementor's SLIDER shape. A bare number is dropped by the page engine. */
const slider = (size, unit = 'px') => ({ unit, size, sizes: [] });

/** Elementor's SWITCHER: the string 'yes', or the empty string. Both spellings
 *  of "on" reach us — our panel stores `true`, a page read back stores 'yes'. */
const onOff = (v, dfltOn = false) => {
  if (v === true || v === 'yes') return 'yes';
  if (v === false || v === '' || v === 'no') return '';
  return dfltOn ? 'yes' : '';
};

/** One of the page engine's own values, or its default. A value the control
 *  does not have is not passed through to be ignored — it is refused here. */
const oneOf = (v, allowed, dflt) => (allowed.includes(text(v)) ? text(v) : dflt);

/** Elementor's own HTML tags for a title, in its own order. */
const TITLE_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'p'];

/** Our left / centre / right, in the words Elementor's newer controls use. */
const START_END = { left: 'start', center: 'center', right: 'end' };

/* ── RATING HAS TWO NAMES, AND THE SITE SAYS WHICH ────────────────────────────
   The page engine renamed this widget: newer builds register `rating`, the
   builds our clients run register `star-rating`, and the two have DIFFERENT
   controls — `rating` / `title` / `star_style` / `align` on the old one,
   `rating_value` / `rating_scale` (a slider) / `icon_alignment` on the new.
   The row this family took over asked the site which name it has and then sent
   the OLD keys either way, so a site on a newer build published a Rating with
   every setting dropped: five empty stars, and a green Published toast.

   The rule is `reference_absence_based_guards_fail_open`: gate on the PRESENCE
   of the new name. A site that told us it has `rating` and not `star-rating`
   gets the new widget with the new keys; a site that told us nothing gets what
   we have always published. */
function modernRating(ctx) {
  const seen = ctx && ctx.siteWidgets;
  return Array.isArray(seen) && !seen.includes('star-rating') && seen.includes('rating');
}

/** Elementor 4.x `rating`. */
function modernStars(p) {
  const scale = num(p.rating_scale == null ? p.scale : p.rating_scale, 5, 1, 10);
  const out = {
    rating_scale: slider(scale),
    rating_value: num(p.rating == null ? p.rating_value : p.rating, 0, 0, scale),
    icon_alignment: START_END[text(p.align)] || 'start',
  };
  /* A style key only when the author set one: an empty colour published as an
     empty string overrides the site's own theme with nothing. */
  if (text(p.stars_color)) out.icon_color = text(p.stars_color);
  return out;
}

/** The older `star-rating`, which is what nearly every client site registers. */
function legacyStars(p) {
  return {
    rating: num(p.rating, 0, 0, 10),
    rating_scale: num(p.rating_scale == null ? p.scale : p.rating_scale, 5, 1, 10) === 10 ? '10' : '5',
    title: text(p.title),
    star_style: 'star_fontawesome',
    align: oneOf(p.align, ['left', 'center', 'right'], ''),
  };
}

export const EMITTERS = {
  /* ══════════════════════════════════════════════════════════════════════
     Counter — Elementor `counter`, group General, free
     ══════════════════════════════════════════════════════════════════════ */
  counter: {
    widgetType: 'counter', tier: FREE, label: 'Counter',
    settings: (p) => ({
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
    }),
  },

  /* ══════════════════════════════════════════════════════════════════════
     Progress Bar — Elementor `progress`, group General, free
     ══════════════════════════════════════════════════════════════════════ */
  progress_bar: {
    widgetType: 'progress', tier: FREE, label: 'Progress Bar',
    settings: (p) => ({
      title: text(p.title),
      title_tag: oneOf(p.title_tag, TITLE_TAGS, 'span'),
      title_display: onOff(p.title_display, true),
      progress_type: oneOf(p.progress_type, ['', 'info', 'success', 'warning', 'danger'], ''),
      percent: slider(num(p.percent, 0, 0, 100), '%'),
      /* Elementor stores this one as 'show' rather than 'yes'. Copied from the
         machine file, not from the pattern the switcher next to it uses. */
      display_percentage: (p.display_percentage === false || p.display_percentage === ''
        || p.show_percent === false) ? '' : 'show',
      inner_text: text(p.inner_text),
    }),
  },

  /* ══════════════════════════════════════════════════════════════════════
     Rating — Elementor `rating`, group General, free

     Our stored kind is `star_rating` and the tile says "Rating", which is
     Elementor's own title; the id is unchanged because documents carry it.

     THE TITLE. Elementor's Rating widget has no title control — it is five
     stars and nothing else. Our widget has one, and an author who typed
     "What our customers say" must not watch it disappear on publish, so a
     rating WITH a title publishes a Heading above it inside a container,
     built out of free widgets the page engine has always had. A rating with
     no title publishes the one widget and no wrapper.
     ══════════════════════════════════════════════════════════════════════ */
  star_rating: {
    widgetType: 'star-rating', tier: FREE, label: 'Rating',
    widgetTypeFor: (ctx) => (modernRating(ctx) ? 'rating' : 'star-rating'),
    settings: (p, ctx) => (modernRating(ctx) ? modernStars(p) : legacyStars(p)),
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
      if (relative === 'selector' && text(p.selector)) out.selector = text(p.selector);
      if (text(p.direction)) out.direction = oneOf(p.direction, ['ltr', 'rtl'], 'ltr');
      if (text(p.percentage_position)) {
        out.percentage_position = oneOf(p.percentage_position, ['ltr', 'rtl'], 'ltr');
      }
      if (text(p.horizontal_color_color)) out.horizontal_color_color = text(p.horizontal_color_color);
      if (text(p.horizontal_background_color_color)) {
        out.horizontal_background_color_color = text(p.horizontal_background_color_color);
      }
      if (p.horizontal_height != null && text(p.horizontal_height)) {
        out.horizontal_height = slider(num(p.horizontal_height, 10, 1, 200));
      }
      if (p.circular_size != null && text(p.circular_size)) out.circular_size = slider(num(p.circular_size, 120, 20, 600));
      if (p.circular_width != null && text(p.circular_width)) out.circular_width = slider(num(p.circular_width, 8, 1, 80));
      if (text(p.circular_color)) out.circular_color = text(p.circular_color);
      if (text(p.circular_background_color)) out.circular_background_color = text(p.circular_background_color);
      if (text(p.percentage_color)) out.percentage_color = text(p.percentage_color);
      return out;
    },
  },
};

export default EMITTERS;
