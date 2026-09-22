/**
 * families/f5-sliders-reviews/emitters.js - what the f5-sliders-reviews family
 * PUBLISHES to a live website.
 *
 * BUILDER_FULL_WIDGET_PLAN_2026-09-19 section C.1. One row per widget kind,
 * the same shape ELEMENTOR_WIDGETS has always had:
 *
 *   kind: {
 *     widgetType,          // what the WEBSITE calls it - the engine's own slug
 *     tier,                // FREE | PRO | `ia:<product>`
 *     label,               // for the message when a plan cannot carry it
 *     settings(props, ctx) // the widget's own settings object
 *     fallback(props, ctx) // OPTIONAL - real content to publish instead
 *   }
 *
 * Every key below is on the widget in the Portal's
 * test/fixtures/WIDGET_SETTINGS_KEYS.json, which is machine-cut from a real
 * install, and the Portal's family test asserts it. A key the engine does not
 * have is DROPPED SILENTLY on publish: the author changes a setting, the toast
 * is green and the live page does not move.
 *
 * -- FIVE OF THESE ARE PRO, AND A LOCKED ONE IS NEVER A BLANK BAND ---------
 * Slides, Reviews, Testimonial Carousel and Media Carousel are Elementor Pro,
 * which ARION Lite does not carry (D-157). Each declares a `fallback` that is
 * REAL CONTENT a visitor can read - the slides drawn one under the next inside
 * a plain container - rather than nothing with a green toast over it
 * (reference_catch_swallow_report_success). Testimonial is free and needs none.
 *
 * -- WHAT IS NOT HERE ------------------------------------------------------
 * `nested-carousel` (Carousel) and `loop-carousel`. A row's `settings()`
 * returns SETTINGS; Carousel's slides are real CONTAINERS published as
 * `elements: [...]`, which this seam cannot express, and Loop Carousel draws
 * every slide with a saved loop template that F7 owns. Publishing either one
 * would put an empty carousel on a customer's live site. Both are written up in
 * D168_HANDOFF_2026-09-19.md.
 */
/* LEAF IMPORTS ONLY. elementorWidgets.js spreads this family's map, so a family
   that imported it back would be a cycle the loader resolves as a half-built
   module - `Cannot access FREE before initialization`. elementorIds.js has no
   imports of its own. The two tier words are the literals elementorWidgets.js
   exports under those names; one string, not a second table. */
import { escapeHtml, mintId } from '../../elementorIds.js';

const FREE = 'free';
const PRO = 'pro';

/**
 * A NODE ID FOR SOMETHING THIS FILE INVENTS.
 *
 * Only a fallback mints one: the widget itself is given its id by the caller.
 * Same seed rule as `cardFallback` in elementorWidgets.js, so publishing the
 * same page twice produces the same ids and the diff on the site is empty.
 */
const nodeId = (ctx, salt) => mintId(ctx?.seed || 'f5', `${ctx?.nodeId || 's'}-${salt}`);

const text = (v) => String(v == null ? '' : v);

/** Elementor's link shape. An empty url is a link that goes nowhere, which is
 *  what the author gets until they say where it goes. */
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
const media = (url, id) => (url && typeof url === 'object'
  ? { url: text(url.url || url.src), id: text(url.id ?? id ?? '') }
  : { url: text(url), id: text(id || '') });

/**
 * THE SLIDES OF A WIDGET, whatever the stored document spells them.
 *
 * The same reader as the Portal's `slideRows`: the engine's own `slides` first,
 * then `items`, which is what a page written before this family carries. One
 * rule on both sides, or a published page loses slides the canvas can see.
 */
function slideRows(p) {
  for (const k of ['slides', 'items']) {
    const v = p && p[k];
    if (Array.isArray(v) && v.length) return v.map((x) => (x && typeof x === 'object' ? x : { content: x }));
  }
  return [];
}

/**
 * A SELECT'S VALUE, OR THE CONTROL'S OWN DEFAULT — never what was handed in.
 *
 * The page engine DROPS a value a control does not offer, so passing one through
 * is a setting the author watched us accept and the page never got. Every list
 * below is the control's own, copied out of
 * BUILDER_WIDGET_CATALOG_2026-09-17.pro.json, and `test/website-widget-map`
 * checks the emitted value against the same machine file.
 */
const oneOf = (v, allowed, dflt) => (allowed.includes(text(v)) ? text(v) : dflt);

/** Elementor's own option lists, per control, read off the machine file. */
const OPTIONS = {
  /* Not left / center / right: this one really is start / center / end. */
  testimonial_alignment: ['start', 'center', 'end'],
  testimonial_image_position: ['aside', 'top'],
  pagination: ['', 'bullets', 'fraction', 'progressbar'],
  tc_skin: ['default', 'bubble'],
  tc_layout: ['image_inline', 'image_stacked', 'image_above', 'image_left', 'image_right'],
  tc_alignment: ['left', 'center', 'right'],
  slides_navigation: ['both', 'arrows', 'dots', 'none'],
  slides_transition: ['slide', 'fade'],
  html_tag: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'p'],
  mc_skin: ['carousel', 'slideshow', 'coverflow'],
  mc_effect: ['slide', 'fade', 'cube'],
  mc_caption: ['title', 'caption', 'description'],
};

/** What a page written before this family called Elementor's start and end. */
const LEGACY_ALIGN = { left: 'start', right: 'end' };

/** A switcher is the string "yes" or absent. Never `false`, which Elementor reads as on. */
const onOff = (v, dflt) => ((v === undefined || v === null || v === '') ? dflt : ((v === true || v === 'yes') ? 'yes' : ''));

/** A select that stores a number, published as Elementor's string. */
const count = (v) => (v === undefined || v === null || v === '' ? '' : String(Math.max(1, Math.min(10, Number(v) || 1))));

/** A slider control's value, in Elementor's own {unit,size,sizes} shape. */
const slider = (v, unit = 'px') => ({ unit, size: Number(v) || 0, sizes: [] });

/** The Slider Options every carousel here shares, by Elementor's own keys. */
function sliderOptions(p) {
  return {
    show_arrows: onOff(p.show_arrows, 'yes'),
    pagination: oneOf(p.pagination === undefined ? 'bullets' : p.pagination, OPTIONS.pagination, 'bullets'),
    speed: Number(p.speed) || 500,
    autoplay: onOff(p.autoplay, 'yes'),
    autoplay_speed: Number(p.autoplay_speed) || 5000,
    loop: onOff(p.loop, 'yes'),
    pause_on_hover: onOff(p.pause_on_hover, 'yes'),
    slides_per_view: count(p.slides_per_view),
    slides_to_scroll: count(p.slides_to_scroll),
    space_between: slider(p.space_between === undefined ? 20 : p.space_between),
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   THE DEEP PANEL'S SETTINGS — Elementor's per-part typography and its borders
   ══════════════════════════════════════════════════════════════════════════

   B-168 F5 deep pass, 2026-09-19. The Portal's Testimonial gained thirty-nine
   of Elementor's controls, each under Elementor's own literal key, and every
   one of them has to arrive on the live page or the author changed a setting,
   saw the canvas move, got a green toast and the site did not move — which is
   the `reference_catch_swallow_report_success` shape at the one boundary where
   nobody looks twice.

   THREE RULES, and each of them is a real defect if it is broken:

   1. **A key the engine does not have is DROPPED SILENTLY.** Every key below is
      in the Portal's `test/fixtures/WIDGET_SETTINGS_KEYS.json`, machine-cut
      from a real install, and the family test asserts the whole emitted object
      against it.
   2. **An EMPTY value is not the same as no value.** Elementor reads `""` as
      "use the theme's", so a control the author never touched is emitted as
      the empty string rather than left out — leaving it out and emitting it
      empty are the same to the page, but emitting it means one shape for every
      publish and a diff on the site that is empty when nothing changed.
   3. **The typography POPOVER has to be switched on.** Elementor draws a
      typography group only when `<prefix>_typography_typography` is `custom`;
      the sizes and weights under a popover that is off are ignored. So it is
      set when the author set anything in that part, and left empty when they
      did not — a popover that is on with nothing in it is a panel that looks
      edited and is not.
*/

/** Is there really a value here? `0` is a real answer and stays. */
const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/** A slider, or Elementor's own "nothing set" — an empty size, not a zero. */
const sliderOrNone = (v, unit = 'px') => (has(v)
  ? { unit, size: Number(v) || 0, sizes: [] }
  : { unit, size: '', sizes: [] });

/** Elementor's four-sided box, all four the same, or nothing set. */
const dimensions = (v) => {
  const n = has(v) ? String(Number(v) || 0) : '';
  return { unit: 'px', top: n, right: n, bottom: n, left: n, isLinked: true };
};

/** The lists Elementor's own typography selects offer. */
const TYPE_OPTIONS = {
  font_weight: ['100', '200', '300', '400', '500', '600', '700', '800', '900', 'normal', 'bold'],
  text_transform: ['uppercase', 'lowercase', 'capitalize', 'none'],
  font_style: ['normal', 'italic', 'oblique'],
  text_decoration: ['underline', 'overline', 'line-through', 'none'],
  border: ['none', 'solid', 'double', 'dotted', 'dashed', 'groove'],
};

/** A select's value, or '' — never a word the control does not offer. */
const pick = (v, allowed) => (allowed.includes(text(v)) ? text(v) : '');

/**
 * ONE PART'S TYPOGRAPHY, under Elementor's own keys, desktop and both devices.
 *
 * `colourKey` because Testimonial's Content part is `content_content_color`
 * and its Name and Title are `<prefix>_text_color`. Elementor's own spelling,
 * read off the machine file; the pattern breaks exactly once and this is it.
 *
 * LINE HEIGHT IS PUBLISHED IN `em`, and that is a decision, not a copy: the
 * panel stores a RATIO (1.6 is comfortable, which is what the platform's own
 * Typography group has always meant by it), and Elementor's desktop default
 * unit for this control is px. Publishing 1.6px would set a line height of
 * under two pixels on a live page. Its own tablet and mobile defaults are em,
 * which is the same reading.
 */
function partTypeSettings(p, prefix, colourKey) {
  const t = `${prefix}_typography`;
  const KEYS = ['font_size', 'font_weight', 'text_transform', 'font_style', 'text_decoration',
    'line_height', 'letter_spacing', 'word_spacing'];
  const touched = KEYS.some((k) => has(p[`${t}_${k}`]) || has(p[`${t}_${k}_tablet`]) || has(p[`${t}_${k}_mobile`]));
  const out = {
    [colourKey || `${prefix}_text_color`]: text(p[colourKey || `${prefix}_text_color`]),
    [`${t}_typography`]: touched ? 'custom' : '',
    [`${t}_font_weight`]: pick(p[`${t}_font_weight`], TYPE_OPTIONS.font_weight),
    [`${t}_text_transform`]: pick(p[`${t}_text_transform`], TYPE_OPTIONS.text_transform),
    [`${t}_font_style`]: pick(p[`${t}_font_style`], TYPE_OPTIONS.font_style),
    [`${t}_text_decoration`]: pick(p[`${t}_text_decoration`], TYPE_OPTIONS.text_decoration),
  };
  for (const [key, unit] of [['font_size', 'px'], ['line_height', 'em'], ['letter_spacing', 'px'], ['word_spacing', 'px']]) {
    out[`${t}_${key}`] = sliderOrNone(p[`${t}_${key}`], unit);
    out[`${t}_${key}_tablet`] = sliderOrNone(p[`${t}_${key}_tablet`], unit);
    out[`${t}_${key}_mobile`] = sliderOrNone(p[`${t}_${key}_mobile`], unit);
  }
  return out;
}

/** Elementor's five Image controls on the Testimonial's Style tab. */
function testimonialImageSettings(p) {
  const out = {
    image_border_border: pick(p.image_border_border, TYPE_OPTIONS.border),
    image_border_color: text(p.image_border_color),
  };
  for (const device of ['', '_tablet', '_mobile']) {
    out[`image_size${device}`] = sliderOrNone(p[`image_size${device}`]);
    out[`image_border_width${device}`] = dimensions(p[`image_border_width${device}`]);
    out[`image_border_radius${device}`] = dimensions(p[`image_border_radius${device}`]);
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   The fallback a plan that has no Pro widgets gets: the same slides, stacked
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * A container of plain widgets that says the same thing without the slider.
 *
 * `heading` and `text-editor` are free on every plan, so a business on ARION
 * Lite gets its reviews or its hero words on the page, one under the next,
 * instead of a band that is not there. The caller is told what was swapped.
 */
function stackedFallback(rows, ctx) {
  const kids = [];
  rows.forEach((r, i) => {
    const title = text(r.name ?? r.author ?? r.heading);
    const body = text(r.content ?? r.quote ?? r.description);
    if (title) {
      kids.push({
        id: nodeId(ctx, `t${i}`), elType: 'widget', widgetType: 'heading',
        settings: { title, header_size: 'h3' },
      });
    }
    if (body) {
      kids.push({
        id: nodeId(ctx, `b${i}`), elType: 'widget', widgetType: 'text-editor',
        settings: { editor: `<p>${escapeHtml(body)}</p>` },
      });
    }
  });
  /* NOTHING TO SAY IS NOT A BOX WITH NOTHING IN IT. `resolveWidget` refuses BY
     NAME when a fallback answers null, and the client reads the three-state
     sentence instead of getting an empty band on a live page. */
  if (!kids.length) return null;
  return {
    id: nodeId(ctx, 'box'),
    elType: 'container',
    settings: {
      container_type: 'flex',
      content_width: 'boxed',
      flex_direction: 'column',
      flex_gap: { unit: 'px', size: 16, sizes: [] },
    },
    elements: kids,
    isInner: true,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   THE ROWS
   ══════════════════════════════════════════════════════════════════════════ */

export const EMITTERS = {
  /* ── Testimonial (free) ──────────────────────────────────────────────────
     The kind keeps the props it has always stored - `quote`, `attribution`,
     `job`, `image`, `align` - and THIS is where they become Elementor's own
     names. Elementor's spellings are read too, for a testimonial that came back
     out of a published page. */
  testimonial: {
    widgetType: 'testimonial', tier: FREE, label: 'Testimonial',
    settings: (p) => ({
      testimonial_content: text(p.testimonial_content ?? p.quote),
      testimonial_name: text(p.testimonial_name ?? p.attribution),
      testimonial_job: text(p.testimonial_job ?? p.job),
      testimonial_image: media(p.testimonial_image ?? p.image, p.mediaId),
      testimonial_image_position: oneOf(p.testimonial_image_position, OPTIONS.testimonial_image_position, 'aside'),
      /* A document stored before this family says `left` / `right`, which this
         control does not offer and the engine would drop — so it is READ as the
         two words the control does offer, rather than quietly becoming centre
         on the next publish. */
      testimonial_alignment: oneOf(
        LEGACY_ALIGN[text(p.testimonial_alignment ?? p.align)] ?? (p.testimonial_alignment ?? p.align),
        OPTIONS.testimonial_alignment, 'center'),
      /* ALIGNMENT IS RESPONSIVE (the machine file carries
         `testimonial_alignment_tablet` and `_mobile`), and the panel stores the
         twins beside the desktop key. A device value Elementor does not offer
         is dropped, so the same `oneOf` guards all three; a device the author
         did not set is EMPTY, which is Elementor's own "inherit the one above"
         and not a third copy of the desktop value. */
      testimonial_alignment_tablet: oneOf(
        LEGACY_ALIGN[text(p.align_tablet ?? p.testimonial_alignment_tablet)] ?? (p.align_tablet ?? p.testimonial_alignment_tablet),
        OPTIONS.testimonial_alignment, ''),
      testimonial_alignment_mobile: oneOf(
        LEGACY_ALIGN[text(p.align_mobile ?? p.testimonial_alignment_mobile)] ?? (p.align_mobile ?? p.testimonial_alignment_mobile),
        OPTIONS.testimonial_alignment, ''),
      link: link(p.link),
      /* THE DEEP PANEL, 2026-09-19. Three parts of typography and the
         picture's own edge, each under Elementor's literal key. `content`'s
         colour is `content_content_color` — the one key in the set that does
         not follow the pattern, and the one this emitter would otherwise
         publish under a name the page engine drops. */
      ...partTypeSettings(p, 'content', 'content_content_color'),
      ...partTypeSettings(p, 'name'),
      ...partTypeSettings(p, 'job'),
      ...testimonialImageSettings(p),
    }),
  },

  /* ── Reviews (Pro) ─────────────────────────────────────────────────────── */
  reviews: {
    widgetType: 'reviews', tier: PRO, label: 'Reviews',
    settings: (p) => reviewSettings(p),
    fallback: (p, ctx) => stackedFallback(slideRows(p), ctx),
  },
  /* THE IA TWIN IS NOT HERE, and it is not missing either. `ia_reviews` is
     published by the row of that name in elementorWidgets.js, which puts the IA
     plugin's own `ia_reviews` widget on the page: it reads the business's
     reviews when the PAGE is drawn, instead of baking today's into the stored
     document, and it does that through `iaRow`, `iaStamp` and `IA_SOURCES`,
     which live in that file and which this folder cannot import without making
     a cycle. Publishing a second, staler answer here would be two mechanisms
     for one job. That row was called `reviews` until this pass and is renamed,
     which is what freed the name for Elementor's own widget above. */

  /* ── Testimonial Carousel (Pro) ──────────────────────────────────────── */
  testimonial_carousel: {
    widgetType: 'testimonial-carousel', tier: PRO, label: 'Testimonial Carousel',
    settings: (p) => ({
      slides_name: text(p.slides_name) || 'Slides',
      slides: slideRows(p).map((r, i) => ({
        _id: `s${i}`,
        content: text(r.content ?? r.quote),
        image: media(r.image, r.mediaId),
        name: text(r.name ?? r.author),
        title: text(r.title),
      })),
      skin: oneOf(p.skin, OPTIONS.tc_skin, 'default'),
      layout: oneOf(p.layout, OPTIONS.tc_layout, 'image_inline'),
      alignment: oneOf(p.alignment, OPTIONS.tc_alignment, 'center'),
      ...sliderOptions(p),
    }),
    fallback: (p, ctx) => stackedFallback(slideRows(p), ctx),
  },

  /* ── Slides (Pro) — the hero slideshow ───────────────────────────────── */
  slides: {
    widgetType: 'slides', tier: PRO, label: 'Slides',
    settings: (p) => ({
      slides_name: text(p.slides_name) || 'Slides',
      slides: slideRows(p).map((r, i) => ({
        _id: `s${i}`,
        heading: text(r.heading),
        description: text(r.description),
        button_text: text(r.button_text),
        link: link(r.link),
        background_color: text(r.background_color),
        background_image: media(r.background_image, r.mediaId),
        ...(text(r.background_overlay_color)
          ? { background_overlay: 'yes', background_overlay_color: text(r.background_overlay_color) }
          : {}),
      })),
      slides_height: slider(p.slides_height === undefined ? 400 : p.slides_height),
      slides_title_tag: oneOf(p.slides_title_tag, OPTIONS.html_tag, 'div'),
      slides_description_tag: oneOf(p.slides_description_tag, OPTIONS.html_tag, 'div'),
      navigation: oneOf(p.navigation, OPTIONS.slides_navigation, 'both'),
      autoplay: onOff(p.autoplay, 'yes'),
      pause_on_hover: onOff(p.pause_on_hover, 'yes'),
      pause_on_interaction: onOff(p.pause_on_interaction, 'yes'),
      autoplay_speed: Number(p.autoplay_speed) || 5000,
      infinite: onOff(p.infinite, 'yes'),
      transition: oneOf(p.transition, OPTIONS.slides_transition, 'slide'),
      transition_speed: Number(p.transition_speed) || 500,
    }),
    fallback: (p, ctx) => stackedFallback(slideRows(p), ctx),
  },

  /* ── Media Carousel (Pro) ────────────────────────────────────────────── */
  media_carousel: {
    widgetType: 'media-carousel', tier: PRO, label: 'Media Carousel',
    settings: (p) => ({
      skin: oneOf(p.skin, OPTIONS.mc_skin, 'carousel'),
      slides_name: text(p.slides_name) || 'Slides',
      slides: slideRows(p).map((r, i) => ({
        _id: `s${i}`,
        type: text(r.type) === 'video' ? 'video' : 'image',
        image: media(r.image, r.mediaId),
        video: link(r.video),
      })),
      effect: oneOf(p.effect, OPTIONS.mc_effect, 'slide'),
      caption: oneOf(p.caption === undefined ? 'title' : p.caption, OPTIONS.mc_caption, 'title'),
      lazyload: onOff(p.lazyload, ''),
      ...sliderOptions(p),
    }),
    fallback: (p, ctx) => {
      /* A carousel of pictures falls back to the pictures, not to words: the
         free `image-gallery` widget is on every plan and shows all of them. */
      const rows = slideRows(p).filter((r) => text(r.image));
      if (!rows.length) return null;
      return {
        id: nodeId(ctx, 'gal'), elType: 'widget', widgetType: 'image-gallery',
        settings: {
          wp_gallery: rows.map((r, i) => ({ id: text(r.mediaId || i), url: text(r.image) })),
          gallery_columns: 3,
        },
      };
    },
  },
};

/** Reviews and IA Reviews publish the same settings — see the rows above. */
function reviewSettings(p) {
  return {
    slides_name: text(p.slides_name) || 'Slides',
    slides: slideRows(p).map((r, i) => ({
      _id: `s${i}`,
      image: media(r.image, r.mediaId),
      name: text(r.name ?? r.author),
      title: text(r.title),
      rating: Math.max(0, Math.min(5, Math.round(Number(r.rating) || 0))),
      content: text(r.content ?? r.quote),
      link: link(r.link),
    })),
    ...sliderOptions(p),
  };
}

export default EMITTERS;
