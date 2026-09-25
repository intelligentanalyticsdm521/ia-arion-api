/**
 * families/f2-pictures/emitters.js - what the f2-pictures family PUBLISHES.
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
 * the author's change does nothing on the live page. So every key here is in
 * the widget's list in the Portal's test/fixtures/WIDGET_SETTINGS_KEYS.json,
 * and this family's test asserts it, key by key, against a copy of that file.
 *
 * -- ALL TEN ARE HERE NOW -------------------------------------------------
 * Wave 1 took over `pro_gallery` (its old row published the layout and the
 * columns and not one of the author's pictures, because it never emitted the
 * `gallery` control) and added the four the catalogue had never had.
 *
 * Wave 2 takes over the other five - `image`, `image_box`, `image_carousel`,
 * `gallery` (the free Basic Gallery) and `video`. Their Portal definitions moved
 * into this family in the same pass and now carry Elementor's own control keys,
 * so the old rows here read property names nothing writes any more:
 *
 *   image          published `p.url`; the panel had stored `src` since D-165 and
 *                  stores Elementor's `image` now. Its whole Style tab - the
 *                  alignment, the width, the border, the caption's colour and
 *                  size - reached nothing at all.
 *   image_box      published four keys of the widget's hundred and twenty-three.
 *   image_carousel published four of ninety, and `image_stretch`, `autoplay`
 *                  and `infinite` as CONSTANTS rather than as the author's.
 *   gallery        published the columns and the pictures and nothing else.
 *   video          published `youtube_url` and a hard-coded `video_type`, so a
 *                  Vimeo address reached the page as a broken YouTube embed.
 *
 * Every one of those rows is DELETED from `elementorWidgets.js` in the same
 * pass - replace means delete, and the family map is spread FIRST, so a row
 * left behind would be dead code that looks live.
 *
 * `basic_gallery` is published under the key `gallery` because
 * `WIDGET_KIND_ALIASES` has resolved that spelling since D-165 and
 * `canonicalKind()` is applied before this map is read. One kind, one row, no
 * third spelling.
 *
 * NO FALLBACKS HERE. All five are Pro but `audio`, and a paid widget quietly
 * swapped for a free imitation is not the widget the author chose: the caller
 * refuses by name, which is what D-165 settled for the rest of the paid panel.
 *
 * Nothing in here ever opens elementorWidgets.js or another family's folder.
 */

const FREE = 'free';
const PRO = 'pro';

const text = (v) => String(v == null ? '' : v);

/** Anything -> an array, so a row never maps over undefined. */
const rows = (v) => (Array.isArray(v) ? v : []);

/**
 * THE ONE WAY A STORED PICTURE IS READ, on this side too.
 *
 * The Portal stores a plain string, or Elementor's own `{ url, id }`, or the
 * older `{ src }`. The panel's own reader (`families/f2-pictures/media.ts`)
 * accepts all three, so the publisher has to as well or the author's picture
 * reaches the page as an empty control.
 */
function mediaUrl(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return text(v.url || v.src);
}

/**
 * A LIBRARY ID IS A NUMBER, and Elementor stores it as one.
 *
 * `text()` turned `44` into `"44"`, and the srcset the page engine builds from
 * the media record is keyed on the attachment id. A blank stays blank - an
 * address with no library record behind it is a real case (a picture pasted in
 * by URL) and `0` would be a record that does not exist.
 */
function attachmentId(v) {
  const raw = v === undefined || v === null ? '' : v;
  if (raw === '') return '';
  const n = Number(raw);
  return Number.isFinite(n) && String(raw).trim() !== '' ? n : text(raw);
}

/** Elementor's media control: a url and the library id when we have one. */
const media = (v) => ({ url: mediaUrl(v), id: attachmentId(v && v.id) });

/** Elementor's link control. An empty url is a link that goes nowhere. */
const link = (v) => ({ url: mediaUrl(v), is_external: '', nofollow: '' });

/** Elementor's slider control: a number and the unit it is measured in. */
const slider = (v, unit, dflt) => {
  const n = Number(v);
  return { unit, size: Number.isFinite(n) && n !== 0 ? n : dflt, sizes: [] };
};

/** A switcher is the string "yes" or the empty string. Never a boolean. */
const sw = (v) => (v === true || v === 'yes' ? 'yes' : '');

/** Refuse a value the control does not have rather than let it be dropped. */
function choice(value, allowed, dflt) {
  const v = String(value == null ? '' : value).trim();
  return allowed.includes(v) ? v : dflt;
}

/**
 * ELEMENTOR'S DIMENSIONS CONTROL - a border width, a corner radius.
 *
 * Four sides and a link flag. Our panel offers ONE number, because four boxes
 * for a border nobody sets differently on each side is four boxes, so the one
 * number is written to all four and `isLinked` says so - which is exactly what
 * Elementor stores when the author leaves the link closed.
 */
const dimensions = (v, unit = 'px') => {
  const n = Number(v);
  const size = Number.isFinite(n) ? String(n) : '';
  return { unit, top: size, right: size, bottom: size, left: size, isLinked: true };
};

/**
 * A WIDTH, WITH THE UNIT IT IS MEASURED IN.
 *
 * The same question the Portal's `widthCss` answers, answered the same way and
 * for the same reason: Elementor's slider carries its own unit, our number
 * control does not, and the documents on disk hold a bare number that the D-165
 * renderer drew as PIXELS. Up to 100 is a percentage - Elementor's own default
 * unit on these sliders - and anything larger can only have been pixels.
 */
const width = (v, dflt) => {
  if (v && typeof v === 'object') return slider(v.size, text(v.unit) || '%', dflt);
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return slider('', '%', dflt);
  return n > 100 ? slider(n, 'px', dflt) : slider(n, '%', dflt);
};

/**
 * A RESPONSIVE CONTROL, ON ALL THREE SCREENS.
 *
 * Elementor stores the twins beside the desktop key as `<key>_tablet` and
 * `<key>_mobile`, which is how the Portal's `deviceKey()` stores them too. A
 * twin the author never set is published EMPTY rather than left out, because an
 * absent key and an empty one mean the same thing to the page engine and a
 * present one is what makes the desktop value stop leaking onto a phone when
 * the author clears it.
 */
function perDevice(out, key, props, make) {
  out[key] = make(props[key]);
  out[`${key}_tablet`] = make(props[`${key}_tablet`]);
  out[`${key}_mobile`] = make(props[`${key}_mobile`]);
  return out;
}

/** THE PICTURE, in every spelling a stored document can hold. */
const pictureOf = (p) => mediaUrl(p.image) || mediaUrl(p.src) || mediaUrl(p.url);

const GALLERY_LAYOUTS = ['grid', 'justified', 'masonry'];
const CAPTION_SOURCES = ['none', 'attachment', 'custom'];
const LINK_TO = ['none', 'file', 'custom'];
const OBJECT_FITS = ['', 'fill', 'cover', 'contain', 'scale-down'];
const BORDER_TYPES = ['', 'none', 'solid', 'double', 'dotted', 'dashed', 'groove'];
const ALIGN_3 = ['start', 'center', 'end'];
const ALIGN_4 = ['start', 'center', 'end', 'justify'];
const BOX_POSITIONS = ['left', 'top', 'right'];
const V_ALIGNMENTS = ['top', 'middle', 'bottom'];
const TITLE_TAGS_BOX = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'p'];
const COUNTS_10 = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const CAROUSEL_NAV = ['both', 'arrows', 'dots', 'none'];
const CAPTION_TYPES = ['', 'title', 'caption', 'description'];
const CAROUSEL_EFFECTS = ['slide', 'fade'];
const DIRECTIONS = ['ltr', 'rtl'];
const ARROWS_POSITIONS = ['inside', 'outside'];
const DOTS_POSITIONS = ['outside', 'inside'];
const GALLERY_V_ALIGN = ['flex-start', 'center', 'flex-end'];
const SPACING = ['', 'custom'];
const GALLERY_LINKS = ['file', 'attachment', 'none'];
const GALLERY_ORDER = ['', 'rand'];
const VIDEO_SOURCES = ['youtube', 'vimeo', 'dailymotion', 'videopress', 'hosted'];
const ASPECT_RATIOS_VIDEO = ['11', '32', '43', '169', '219', '916'];
const FONT_WEIGHTS = ['', '300', '400', '500', '600', '700', '900'];
const ASPECT_RATIOS = ['1:1', '3:2', '4:3', '9:16', '16:9', '21:9'];
const OVERLAY_FIELDS = ['', 'title', 'caption', 'alt', 'description'];
const LIGHTBOX = ['default', 'yes', 'no'];
const TITLE_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span'];
const LOTTIE_SOURCES = ['media_file', 'external_url'];
const LOTTIE_TRIGGERS = ['arriving_to_viewport', 'on_click', 'on_hover', 'bind_to_scroll', 'none'];
const LOTTIE_RENDERERS = ['svg', 'canvas'];
const ALIGNMENTS = ['left', 'center', 'right'];
const HOTSPOT_ANIMATIONS = ['e-hotspot--expand', 'e-hotspot--soft-beat', 'e-hotspot--overlay', ''];
const TOOLTIP_POSITIONS = ['top', 'right', 'bottom', 'left'];
const TOOLTIP_TRIGGERS = ['click', 'mouseenter', 'none'];
const IMAGE_SIZES = ['thumbnail', 'medium', 'medium_large', 'large', 'full'];

export const EMITTERS = {
  /* ── Image (Elementor `image`, free, Basic) ─────────────────────────────
     The one an author reaches for first. The row this replaces published the
     address, a hard-coded `image_size: 'large'`, the alignment and the caption
     - four keys - and read the address from `p.url`, which the panel has not
     written since D-165. */
  image: {
    widgetType: 'image', tier: FREE, label: 'Image',
    settings: (p) => {
      const out = {
        /* `id` last: the stored document calls the attachment id `id` and the
           panel calls it `mediaId`. All three, so a picture keeps its library
           record - which is what Elementor builds the srcset from - whichever
           way the block was written (B-168 W-1). */
        image: { url: pictureOf(p), id: attachmentId((p.image && p.image.id) || p.mediaId || p.id) },
        image_size: choice(p.image_size, IMAGE_SIZES, 'large'),
        caption_source: choice(p.caption_source, CAPTION_SOURCES, p.caption ? 'custom' : 'none'),
        caption: text(p.caption),
        link_to: choice(p.link_to, LINK_TO, 'none'),
        link: link(p.link),
        open_lightbox: choice(p.open_lightbox, LIGHTBOX, 'default'),
        opacity: slider(p.opacity, 'px', ''),
        image_border_border: choice(p.image_border_border, BORDER_TYPES, ''),
        image_border_color: text(p.image_border_color),
        text_color: text(p.text_color),
        caption_background_color: text(p.caption_background_color),
        caption_typography_font_weight: choice(p.caption_typography_font_weight, FONT_WEIGHTS, ''),
      };
      /* `image_alt` IS NOT PUBLISHED, and Elementor has no control for it:
         WordPress keeps a picture's alt text on the MEDIA RECORD, which is
         where the page engine reads it from. Our panel offers it because we
         have no media library and a picture with no alt text is one a screen
         reader cannot describe - it reaches the canvas and the mailbox, not
         the website. Same decision, same words, as `image-box` below. */
      perDevice(out, 'align', p, (v) => choice(v, ALIGN_3, ''));
      perDevice(out, 'width', p, (v) => width(v, ''));
      perDevice(out, 'height', p, (v) => slider(v, 'px', ''));
      perDevice(out, 'object-fit', p, (v) => choice(v, OBJECT_FITS, ''));
      perDevice(out, 'image_border_width', p, (v) => dimensions(v));
      perDevice(out, 'image_border_radius', p, (v) => dimensions(v));
      perDevice(out, 'caption_align', p, (v) => choice(v, ALIGN_4, ''));
      perDevice(out, 'caption_typography_font_size', p, (v) => slider(v, 'px', ''));
      perDevice(out, 'caption_space', p, (v) => slider(v, 'px', ''));
      return out;
    },
  },

  /* ── Image Box (Elementor `image-box`, free, General) ──────────────────── */
  image_box: {
    widgetType: 'image-box', tier: FREE, label: 'Image Box',
    settings: (p) => {
      const out = {
        /* `id` last: the stored document calls the attachment id `id` and the
           panel calls it `mediaId`. All three, so a picture keeps its library
           record - which is what Elementor builds the srcset from - whichever
           way the block was written (B-168 W-1). */
        image: { url: pictureOf(p), id: attachmentId((p.image && p.image.id) || p.mediaId || p.id) },
        thumbnail_size: choice(p.thumbnail_size, IMAGE_SIZES, 'full'),
        title_text: text(p.title_text || p.title),
        description_text: text(p.description_text || p.description),
        link: link(p.link || p.url),
        title_size: choice(p.title_size, TITLE_TAGS_BOX, 'h3'),
        image_object_fit: choice(p.image_object_fit, OBJECT_FITS, ''),
        image_border_border: choice(p.image_border_border, BORDER_TYPES, ''),
        image_border_color: text(p.image_border_color),
        image_opacity: slider(p.image_opacity, 'px', ''),
        title_color: text(p.title_color),
        description_color: text(p.description_color),
        title_typography_font_weight: choice(p.title_typography_font_weight, FONT_WEIGHTS, ''),
      };
      perDevice(out, 'position', p, (v) => choice(v, BOX_POSITIONS, 'top'));
      perDevice(out, 'content_vertical_alignment', p, (v) => choice(v, V_ALIGNMENTS, 'top'));
      perDevice(out, 'text_align', p, (v) => choice(v, ALIGN_4, ''));
      perDevice(out, 'image_space', p, (v) => slider(v, 'px', ''));
      perDevice(out, 'title_bottom_space', p, (v) => slider(v, 'px', ''));
      perDevice(out, 'image_size', p, (v) => width(v, ''));
      perDevice(out, 'image_height', p, (v) => slider(v, 'px', ''));
      perDevice(out, 'image_border_width', p, (v) => dimensions(v));
      perDevice(out, 'image_border_radius', p, (v) => slider(v, 'px', ''));
      perDevice(out, 'title_typography_font_size', p, (v) => slider(v, 'px', ''));
      perDevice(out, 'description_typography_font_size', p, (v) => slider(v, 'px', ''));
      return out;
    },
  },

  /* ── Image Carousel (Elementor `image-carousel`, free, General) ────────── */
  image_carousel: {
    widgetType: 'image-carousel', tier: FREE, label: 'Image Carousel',
    settings: (p) => {
      const pictures = rows(p.carousel).length ? rows(p.carousel) : rows(p.images);
      const out = {
        carousel: pictures.map((im, i) => ({
          id: text(im && (im.id || im.mediaId)), url: mediaUrl(im), _id: `c${i}`,
        })),
        thumbnail_size: choice(p.thumbnail_size, IMAGE_SIZES, 'thumbnail'),
        image_stretch: choice(p.image_stretch, ['no', 'yes'], 'no'),
        navigation: choice(p.navigation, CAROUSEL_NAV, 'both'),
        link_to: choice(p.link_to, LINK_TO, 'none'),
        link: link(p.link),
        open_lightbox: choice(p.open_lightbox, LIGHTBOX, 'default'),
        caption_type: choice(p.caption_type, CAPTION_TYPES, ''),
        lazyload: sw(p.lazyload),
        /* A switcher whose Elementor default is "yes" must publish '' when the
           author turns it OFF, and 'yes' when they have not touched it. */
        autoplay: p.autoplay === false || p.autoplay === '' ? '' : 'yes',
        pause_on_hover: p.pause_on_hover === false || p.pause_on_hover === '' ? '' : 'yes',
        pause_on_interaction: p.pause_on_interaction === false || p.pause_on_interaction === '' ? '' : 'yes',
        infinite: p.infinite === false || p.infinite === '' ? '' : 'yes',
        autoplay_speed: Number(p.autoplay_speed) || 5000,
        speed: Number(p.speed) || 500,
        effect: choice(p.effect, CAROUSEL_EFFECTS, 'slide'),
        direction: choice(p.direction, DIRECTIONS, 'ltr'),
        arrows_position: choice(p.arrows_position, ARROWS_POSITIONS, 'inside'),
        arrows_color: text(p.arrows_color),
        dots_position: choice(p.dots_position, DOTS_POSITIONS, 'outside'),
        dots_inactive_color: text(p.dots_inactive_color),
        dots_color: text(p.dots_color),
        image_spacing: choice(p.image_spacing, SPACING, ''),
        image_border_border: choice(p.image_border_border, BORDER_TYPES, ''),
        image_border_color: text(p.image_border_color),
        caption_text_color: text(p.caption_text_color),
      };
      perDevice(out, 'slides_to_show', p, (v) => choice(v, COUNTS_10, ''));
      perDevice(out, 'slides_to_scroll', p, (v) => choice(v, COUNTS_10, ''));
      perDevice(out, 'arrows_size', p, (v) => slider(v, 'px', ''));
      perDevice(out, 'dots_gap', p, (v) => slider(v, 'px', ''));
      perDevice(out, 'dots_size', p, (v) => slider(v, 'px', ''));
      perDevice(out, 'gallery_vertical_align', p, (v) => choice(v, GALLERY_V_ALIGN, ''));
      perDevice(out, 'image_spacing_custom', p, (v) => slider(v, 'px', ''));
      perDevice(out, 'image_border_width', p, (v) => dimensions(v));
      perDevice(out, 'image_border_radius', p, (v) => dimensions(v));
      perDevice(out, 'caption_align', p, (v) => choice(v, ALIGN_4, ''));
      perDevice(out, 'caption_typography_font_size', p, (v) => slider(v, 'px', ''));
      perDevice(out, 'caption_space', p, (v) => slider(v, 'px', ''));
      return out;
    },
  },

  /* ── Basic Gallery (Elementor `image-gallery`, free, General) ───────────
     The KEY is `gallery`, not `basic_gallery`: `WIDGET_KIND_ALIASES` has
     resolved that spelling since D-165 and `canonicalKind()` runs before this
     map is read. One kind, one row. */
  gallery: {
    widgetType: 'image-gallery', tier: FREE, label: 'Basic Gallery',
    settings: (p) => {
      const pictures = rows(p.wp_gallery).length ? rows(p.wp_gallery)
        : rows(p.images).length ? rows(p.images) : rows(p.items);
      const out = {
        wp_gallery: pictures.map((im, i) => ({
          id: text(im && (im.id || im.mediaId)), url: mediaUrl(im), _id: `g${i}`,
        })),
        thumbnail_size: choice(p.thumbnail_size, IMAGE_SIZES, 'thumbnail'),
        gallery_columns: choice(p.gallery_columns == null ? '' : String(p.gallery_columns), COUNTS_10, '4'),
        gallery_display_caption: choice(p.gallery_display_caption, ['', 'none'], ''),
        gallery_link: choice(p.gallery_link, GALLERY_LINKS, 'file'),
        open_lightbox: choice(p.open_lightbox, LIGHTBOX, 'default'),
        gallery_rand: choice(p.gallery_rand, GALLERY_ORDER, ''),
        image_spacing: choice(p.image_spacing, SPACING, ''),
        image_spacing_custom: slider(p.image_spacing_custom, 'px', ''),
        image_border_border: choice(p.image_border_border, BORDER_TYPES, ''),
        image_border_color: text(p.image_border_color),
        text_color: text(p.text_color),
        typography_font_weight: choice(p.typography_font_weight, FONT_WEIGHTS, ''),
      };
      perDevice(out, 'image_border_width', p, (v) => dimensions(v));
      perDevice(out, 'image_border_radius', p, (v) => dimensions(v));
      perDevice(out, 'align', p, (v) => choice(v, ALIGN_4, ''));
      perDevice(out, 'typography_font_size', p, (v) => slider(v, 'px', ''));
      perDevice(out, 'caption_space', p, (v) => slider(v, 'px', ''));
      return out;
    },
  },

  /* ── Video (Elementor `video`, free, Basic) ─────────────────────────────
     The row this replaces published `youtube_url: p.url` and a hard-coded
     `video_type: 'youtube'`, so a Vimeo address the author pasted reached the
     page as a YouTube embed of nothing. */
  video: {
    widgetType: 'video', tier: FREE, label: 'Video',
    settings: (p) => {
      const typed = text(p.video_type).trim();
      const pasted = text(p.youtube_url || p.vimeo_url || p.dailymotion_url || p.url);
      const source = typed || (/vimeo\.com/i.test(pasted) ? 'vimeo'
        : /dailymotion\.com|dai\.ly/i.test(pasted) ? 'dailymotion' : 'youtube');
      const out = {
        video_type: choice(source, VIDEO_SOURCES, 'youtube'),
        youtube_url: source === 'youtube' ? pasted : text(p.youtube_url),
        vimeo_url: source === 'vimeo' ? pasted : text(p.vimeo_url),
        dailymotion_url: source === 'dailymotion' ? pasted : text(p.dailymotion_url),
        hosted_url: media(p.hosted_url),
        start: Number(p.start) || '',
        end: Number(p.end) || '',
        autoplay: sw(p.autoplay),
        mute: sw(p.mute),
        loop: sw(p.loop),
        /* Elementor's own default is ON, so an untouched widget publishes
           'yes' and only a deliberate switch-off publishes empty. */
        controls: p.controls === false || p.controls === '' ? '' : 'yes',
        yt_privacy: sw(p.yt_privacy),
        lazy_load: sw(p.lazy_load),
        color: text(p.color),
        show_image_overlay: sw(p.show_image_overlay),
        image_overlay: media(p.image_overlay),
        show_play_icon: p.show_play_icon === false || p.show_play_icon === '' ? '' : 'yes',
        lightbox: sw(p.lightbox),
        aspect_ratio: choice(p.aspect_ratio, ASPECT_RATIOS_VIDEO, '169'),
        play_icon_color: text(p.play_icon_color),
      };
      perDevice(out, 'play_icon_size', p, (v) => slider(v, 'px', ''));
      return out;
    },
  },

  /* ── Gallery (Elementor Pro `gallery`) ──────────────────────────────────
     The one the author's pictures actually reach. */
  pro_gallery: {
    widgetType: 'gallery', tier: PRO, label: 'Gallery',
    settings: (p) => ({
      gallery_type: 'single',
      gallery: rows(p.gallery).map((im) => ({ id: text(im && im.id), url: mediaUrl(im) })),
      gallery_layout: choice(p.gallery_layout, GALLERY_LAYOUTS, 'grid'),
      columns: Number(p.columns) || 4,
      gap: slider(p.gap, 'px', 10),
      aspect_ratio: choice(p.aspect_ratio, ASPECT_RATIOS, '3:2'),
      open_lightbox: choice(p.open_lightbox, LIGHTBOX, 'default'),
      lazyload: sw(p.lazyload),
      overlay_background: sw(p.overlay_background),
      overlay_title: choice(p.overlay_title, OVERLAY_FIELDS, ''),
      overlay_description: choice(p.overlay_description, OVERLAY_FIELDS, ''),
      image_border_radius: slider(p.image_border_radius, 'px', 0),
      image_border_width: slider(p.image_border_width, 'px', 0),
      image_border_color: text(p.image_border_color),
    }),
  },

  /* ── Video Playlist (Elementor Pro `video-playlist`) ──────────────────── */
  video_playlist: {
    widgetType: 'video-playlist', tier: PRO, label: 'Video Playlist',
    settings: (p) => ({
      playlist_title: text(p.playlist_title) || 'Playlist',
      playlist_title_tag: choice(p.playlist_title_tag, TITLE_TAGS, 'h2'),
      tabs: rows(p.tabs).map((v, i) => ({
        _id: `vp${i}`,
        type: 'youtube',
        youtube_url: text(v && (v.youtube_url || v.url)),
        title: text(v && v.title),
        duration: text(v && v.duration),
        thumbnail: media(v && v.thumbnail),
      })),
      show_image_overlay: sw(p.show_image_overlay),
      image_overlay: media(p.image_overlay),
      autoplay_on_load: sw(p.autoplay_on_load),
      autoplay_next: sw(p.autoplay_next),
      show_video_count: sw(p.show_video_count),
      show_duration: sw(p.show_duration),
      show_thumbnail: sw(p.show_thumbnail),
      tabs_alignment: choice(p.tabs_alignment, ['start', 'end'], 'end'),
      playlist_name_color: text(p.playlist_name_color),
      playlist_name_background: text(p.playlist_name_background),
      normal_color: text(p.normal_color),
      normal_background: text(p.normal_background),
    }),
  },

  /* ── SoundCloud (Elementor `audio`, free) ─────────────────────────────── */
  audio: {
    widgetType: 'audio', tier: FREE, label: 'SoundCloud',
    settings: (p) => ({
      link: link(p.link),
      visual: p.visual === 'yes' || p.visual === true ? 'yes' : 'no',
      sc_auto_play: sw(p.sc_auto_play),
      sc_buying: sw(p.sc_buying),
      sc_liking: sw(p.sc_liking),
      sc_download: sw(p.sc_download),
      sc_show_artwork: sw(p.sc_show_artwork),
      sc_sharing: sw(p.sc_sharing),
      sc_show_comments: sw(p.sc_show_comments),
      sc_show_playcount: sw(p.sc_show_playcount),
      sc_show_user: sw(p.sc_show_user),
      sc_color: text(p.sc_color),
    }),
  },

  /* ── Lottie (Elementor Pro `lottie`) ──────────────────────────────────── */
  lottie: {
    widgetType: 'lottie', tier: PRO, label: 'Lottie',
    settings: (p) => ({
      source: choice(p.source, LOTTIE_SOURCES, 'media_file'),
      source_json: media(p.source_json),
      source_external_url: link(p.source_external_url),
      align: choice(p.align, ALIGNMENTS, 'center'),
      caption_source: choice(p.caption_source, ['none', 'custom'], 'none'),
      caption: text(p.caption),
      link_to: choice(p.link_to, ['none', 'custom'], 'none'),
      custom_link: link(p.custom_link),
      trigger: choice(p.trigger, LOTTIE_TRIGGERS, 'arriving_to_viewport'),
      loop: sw(p.loop),
      number_of_times: Number(p.number_of_times) || '',
      reverse_animation: sw(p.reverse_animation),
      renderer: choice(p.renderer, LOTTIE_RENDERERS, 'svg'),
      lazyload: sw(p.lazyload),
      width: slider(p.width, '%', 100),
      opacity: slider(p.opacity, 'px', 1),
      caption_align: choice(p.caption_align, ALIGNMENTS, 'center'),
      text_color: text(p.text_color),
    }),
  },

  /* ── Hotspot (Elementor Pro `hotspot`) ────────────────────────────────── */
  hotspot: {
    widgetType: 'hotspot', tier: PRO, label: 'Hotspot',
    settings: (p) => ({
      image: media(p.image),
      image_size: choice(p.image_size, IMAGE_SIZES, 'large'),
      hotspot: rows(p.hotspot).map((h, i) => ({
        _id: `hs${i}`,
        hotspot_label: text(h && h.hotspot_label),
        hotspot_link: link(h && h.hotspot_link),
        hotspot_tooltip_content: text(h && h.hotspot_tooltip_content),
        hotspot_offset_x: slider(h && h.hotspot_offset_x, '%', 50),
        hotspot_offset_y: slider(h && h.hotspot_offset_y, '%', 50),
      })),
      hotspot_animation: choice(p.hotspot_animation, HOTSPOT_ANIMATIONS, 'e-hotspot--expand'),
      hotspot_sequenced_animation: sw(p.hotspot_sequenced_animation),
      tooltip_position: choice(p.tooltip_position, TOOLTIP_POSITIONS, 'top'),
      tooltip_trigger: choice(p.tooltip_trigger, TOOLTIP_TRIGGERS, 'click'),
      width: slider(p.width, '%', 100),
      style_hotspot_color: text(p.style_hotspot_color),
      style_hotspot_size: slider(p.style_hotspot_size, 'px', 0),
      style_tooltip_text_color: text(p.style_tooltip_text_color),
      style_tooltip_color: text(p.style_tooltip_color),
    }),
  },
};

export default EMITTERS;
