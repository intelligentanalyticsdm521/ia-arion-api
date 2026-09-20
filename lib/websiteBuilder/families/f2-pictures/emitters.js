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
 * -- THE FIVE THAT ARE HERE, AND THE FIVE THAT ARE NOT --------------------
 * The family's ten widgets are image, image-box, image-carousel, image-gallery,
 * gallery, video, video-playlist, audio, lottie, hotspot. FIVE of them already
 * had a row in `elementorWidgets.js` written by D-165 - image, image_box,
 * image_carousel, gallery (the free Basic Gallery) and video - and their Portal
 * definitions still live in the shared atom files, so they are left exactly
 * where they are. Taking half a widget over would publish from here and draw
 * from there.
 *
 * The sixth, `pro_gallery`, IS taken over: its old row published a Gallery with
 * the LAYOUT and the COLUMNS and none of the author's pictures. That row is
 * deleted in the same pass (replace means delete, and the header of
 * ELEMENTOR_WIDGETS says a family deletes its own rows when it takes them).
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

/** Elementor's media control: a url and the library id when we have one. */
const media = (v) => ({ url: mediaUrl(v), id: text(v && v.id) });

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

const GALLERY_LAYOUTS = ['grid', 'justified', 'masonry'];
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
