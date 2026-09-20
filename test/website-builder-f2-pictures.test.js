// test/website-builder-f2-pictures.test.js — what the PICTURES family publishes.
//
// B-168, plan §C.1 step 4. The family's own test on the arion side, and the
// one thing it has to prove: EVERY SETTINGS KEY THIS FAMILY EMITS IS A KEY THE
// PAGE ENGINE HAS. A key Elementor does not know is not an error anywhere — the
// widget publishes, the setting is dropped, and the author's change quietly
// does nothing on the live page. That is `reference_catch_swallow_report_
// success` on a customer's website, and it is invisible without this file.
//
// THE LEGAL KEYS come from `test/fixtures/WIDGET_SETTINGS_KEYS.f2-pictures.json`,
// a five-widget slice of the fixture the Portal generates from the two
// 2026-09-17 Elementor catalogues (Portal `scripts/gen-widget-settings-keys.mjs`).
// Same provenance, same generator; the slice is here because a test that needs
// a 9 MB file from outside the repo is a test the build machine cannot run.
//
// ── MUTATION CHECKS (run, then restored — see the D168 handoff) ───────────
//   1. `gallery_layout` renamed to `layout` in the pro_gallery row  → red,
//      naming the key and the widget;
//   2. the `gallery` key removed from the same row                  → red on
//      "the author's pictures are published, not just the layout";
//   3. the old `pro_gallery` row put back in elementorWidgets.js     → red on
//      the seams test that says a family's row IS the catalogue's row.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMITTERS } from '../lib/websiteBuilder/families/f2-pictures/emitters.js';
import { ELEMENTOR_WIDGETS, canonicalKind } from '../lib/websiteBuilder/elementorWidgets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEYS = JSON.parse(fs.readFileSync(
  path.join(HERE, 'fixtures', 'WIDGET_SETTINGS_KEYS.f2-pictures.json'), 'utf8'));

/** The props a widget carries when an author has actually filled it in. */
const FILLED = {
  /* WAVE 2 — filled the way the deepened panel writes them, INCLUDING the
     per-device twins, because a twin published under a key the engine does not
     have is the same silent drop as any other. */
  image: {
    image: { url: 'https://example.test/lawn.jpg', id: '31' }, alt: 'A finished lawn',
    image_size: 'large', caption_source: 'custom', caption: 'Edged and cut',
    link_to: 'custom', link: { url: 'https://example.test/go' }, open_lightbox: 'yes',
    align: 'start', align_tablet: 'center', width: 60, width_mobile: 100, height: 240,
    'object-fit': 'cover', opacity: 0.9,
    image_border_border: 'solid', image_border_width: 3, image_border_color: '#112233',
    image_border_radius: 8, caption_align: 'center', text_color: '#445566',
    caption_background_color: '#F1F5F9', caption_typography_font_size: 15,
    caption_typography_font_weight: '600', caption_space: 10,
  },
  image_box: {
    image: { url: 'https://example.test/crew.jpg', id: '32' }, image_alt: 'The crew',
    thumbnail_size: 'large', title_text: 'Weekly mowing',
    description_text: 'Every Tuesday, April to October', link: { url: 'https://example.test/mowing' },
    title_size: 'h2', position: 'left', position_mobile: 'top',
    content_vertical_alignment: 'middle', text_align: 'start',
    image_space: 20, title_bottom_space: 8, image_size: 40, image_height: 180,
    image_object_fit: 'cover', image_opacity: 0.95,
    image_border_border: 'solid', image_border_width: 2, image_border_color: '#99AABB',
    image_border_radius: 6, title_color: '#101820', title_typography_font_size: 22,
    title_typography_font_weight: '700', description_color: '#556677',
    description_typography_font_size: 14,
  },
  image_carousel: {
    carousel: [{ url: 'https://example.test/1.jpg', id: '41' }, { url: 'https://example.test/2.jpg' }],
    thumbnail_size: 'medium', slides_to_show: '2', slides_to_show_mobile: '1',
    slides_to_scroll: '1', image_stretch: 'yes', navigation: 'dots',
    link_to: 'file', open_lightbox: 'yes', caption_type: 'title',
    lazyload: 'yes', autoplay: '', pause_on_hover: '', pause_on_interaction: 'yes',
    autoplay_speed: 4000, infinite: '', speed: 900, effect: 'fade', direction: 'rtl',
    arrows_position: 'outside', arrows_size: 22, arrows_color: '#123456',
    dots_position: 'inside', dots_gap: 8, dots_size: 10,
    dots_inactive_color: '#CBD5E1', dots_color: '#654321',
    gallery_vertical_align: 'center', image_spacing: 'custom', image_spacing_custom: 24,
    image_border_border: 'dashed', image_border_width: 1, image_border_color: '#334455',
    image_border_radius: 4, caption_align: 'start', caption_text_color: '#475569',
    caption_typography_font_size: 13, caption_space: 8,
  },
  gallery: {
    wp_gallery: [{ url: 'https://example.test/a.jpg', id: '51' }, { url: 'https://example.test/b.jpg' }],
    thumbnail_size: 'medium', gallery_columns: '2', gallery_display_caption: '',
    gallery_link: 'none', open_lightbox: 'no', gallery_rand: 'rand',
    image_spacing: 'custom', image_spacing_custom: 18,
    image_border_border: 'solid', image_border_width: 2, image_border_color: '#334455',
    image_border_radius: 6, align: 'start', text_color: '#778899',
    typography_font_size: 13, typography_font_weight: '500', caption_space: 6,
  },
  video: {
    video_type: 'vimeo', vimeo_url: 'https://vimeo.com/235215203',
    start: 30, end: 90, autoplay: 'yes', mute: 'yes', loop: 'yes', controls: '',
    yt_privacy: 'yes', lazy_load: 'yes', color: '#FF8800',
    show_image_overlay: 'yes', image_overlay: { url: 'https://example.test/still.jpg', id: '61' },
    show_play_icon: 'yes', lightbox: 'yes', aspect_ratio: '43',
    play_icon_color: '#00FF88', play_icon_size: 72,
  },
  pro_gallery: {
    gallery: [{ url: 'https://example.test/one.jpg', id: '11' }, { url: 'https://example.test/two.jpg' }],
    gallery_layout: 'masonry', columns: 3, gap: 16, aspect_ratio: '16:9',
    open_lightbox: 'yes', lazyload: 'yes',
    overlay_background: 'yes', overlay_title: 'title', overlay_description: 'caption',
    image_border_radius: 8, image_border_width: 2, image_border_color: '#1E4E57',
  },
  video_playlist: {
    playlist_title: 'How we do it', playlist_title_tag: 'h3',
    tabs: [{ title: 'Spring clean-up', youtube_url: 'https://youtu.be/aaaaaa', duration: '2:10' }],
    show_image_overlay: 'yes', image_overlay: { url: 'https://example.test/poster.jpg' },
    autoplay_on_load: '', autoplay_next: 'yes',
    show_video_count: 'yes', show_duration: 'yes', show_thumbnail: 'yes',
    tabs_alignment: 'start', playlist_name_color: '#0F172A', normal_color: '#334155',
  },
  audio: {
    link: 'https://soundcloud.com/a-business/a-track', visual: 'yes',
    sc_auto_play: '', sc_buying: 'yes', sc_liking: 'yes', sc_download: '',
    sc_show_artwork: 'yes', sc_sharing: 'yes', sc_show_comments: '',
    sc_show_playcount: 'yes', sc_show_user: 'yes', sc_color: '#1E4E57',
  },
  lottie: {
    source: 'external_url', source_external_url: { url: 'https://example.test/a.json' },
    align: 'left', caption_source: 'custom', caption: 'Watch it grow',
    link_to: 'custom', custom_link: { url: 'https://example.test/more' },
    trigger: 'on_hover', loop: 'yes', number_of_times: 3, reverse_animation: '',
    renderer: 'canvas', lazyload: 'yes', width: 60, opacity: 1,
    caption_align: 'left', text_color: '#334155',
  },
  hotspot: {
    image: { url: 'https://example.test/yard.jpg', id: '22' }, image_size: 'full',
    hotspot: [{ hotspot_label: 'Edging', hotspot_tooltip_content: 'Cut along every bed', hotspot_offset_x: 20, hotspot_offset_y: 30 }],
    hotspot_animation: 'e-hotspot--soft-beat', hotspot_sequenced_animation: 'yes',
    tooltip_position: 'right', tooltip_trigger: 'mouseenter',
    width: 80, style_hotspot_color: '#1E4E57', style_hotspot_size: 24,
    style_tooltip_text_color: '#FFFFFF', style_tooltip_color: '#0F172A',
  },
};

describe('f2-pictures publishes only keys the page engine has', () => {
  for (const [kind, row] of Object.entries(EMITTERS)) {
    test(`${kind} → ${row.widgetType}: every key is real`, () => {
      const w = KEYS.widgets[row.widgetType];
      assert.ok(w, `${row.widgetType} is not in the fixture — is the slice stale?`);
      assert.ok(w.keys.length, `${row.widgetType}: the catalogue reports no controls, so nothing can be checked`);
      const legal = new Set(w.keys);
      const emitted = Object.keys(row.settings(FILLED[kind] || {}, {}));
      const bad = emitted.filter((k) => !legal.has(k) && !legal.has(k.replace(/_(tablet|mobile)$/, '')));
      assert.deepEqual(bad, [],
        `${row.widgetType}: the page engine drops these on publish and the author's change does nothing`);
    });

    test(`${kind}: the row is complete and says what it costs`, () => {
      assert.equal(typeof row.settings, 'function');
      assert.ok(row.label, 'a refusal has to be able to name it');
      assert.ok(['free', 'pro'].includes(row.tier), `${kind}: tier is ${row.tier}`);
      // Elementor's own pro-elements group decides this, not our opinion.
      assert.equal(row.tier === 'pro', KEYS.widgets[row.widgetType].pro, row.widgetType);
    });

    test(`${kind}: an empty widget still publishes a node, never a throw`, () => {
      // A half-filled widget must reach the page as an empty one, not as a 500
      // in the middle of a save the author was told had worked.
      const settings = row.settings({}, {});
      assert.equal(typeof settings, 'object');
    });
  }

  test('all TEN of the family publish from here, and no eleventh', () => {
    /* Wave 1 was five. Wave 2 took over the other five — `image`, `image_box`,
       `image_carousel`, `gallery` (the free Basic Gallery, under the key
       `WIDGET_KIND_ALIASES` resolves `basic_gallery` to) and `video` — and
       DELETED their rows from `elementorWidgets.js` in the same pass. A name
       here that is not one of Elementor's picture widgets is the invention
       D-168 exists to stop. */
    assert.deepEqual(Object.keys(EMITTERS).sort(), [
      'audio', 'gallery', 'hotspot', 'image', 'image_box', 'image_carousel',
      'lottie', 'pro_gallery', 'video', 'video_playlist',
    ]);
  });

  test('the rows they replace are GONE from the catalogue, not shadowed', () => {
    /* Replace means delete. The family map is merged FIRST, so a row left in
       `elementorWidgets.js` would be dead code that reads like live code — and
       the next person to fix a defect would fix the wrong one. */
    const src = fs.readFileSync(
      path.join(HERE, '..', 'lib', 'websiteBuilder', 'elementorWidgets.js'), 'utf8');
    for (const dead of [
      "label: 'Picture',", "label: 'Picture with words',",
      "widgetType: 'image-gallery', tier: FREE, label: 'Gallery'",
      "settings: (p) => ({ youtube_url: text(p.url), video_type: 'youtube' })",
    ]) {
      assert.equal(src.includes(dead), false, `the old row is still there: ${dead}`);
    }
  });
});

describe('the Gallery publishes the author’s pictures', () => {
  // The row this replaces published `gallery_type`, `gallery_layout` and
  // `columns` — and not one photograph, because it never emitted the `gallery`
  // control at all. That is the whole reason the kind was taken over.
  const s = EMITTERS.pro_gallery.settings(FILLED.pro_gallery, {});

  test('every picture is in the published settings', () => {
    assert.equal(s.gallery.length, 2);
    assert.equal(s.gallery[0].url, 'https://example.test/one.jpg');
    assert.equal(s.gallery[0].id, '11');
    assert.equal(s.gallery[1].url, 'https://example.test/two.jpg');
  });
  test('the layout the author chose is published, and a wrong one is refused', () => {
    assert.equal(s.gallery_layout, 'masonry');
    assert.equal(EMITTERS.pro_gallery.settings({ gallery_layout: 'spiral' }, {}).gallery_layout, 'grid');
  });
  test('a slider is published as a size and a unit, which is what the engine reads', () => {
    assert.deepEqual(s.gap, { unit: 'px', size: 16, sizes: [] });
  });
});

describe('the other four publish what the author typed', () => {
  test('video playlist: every row keeps its title, link and duration', () => {
    const s = EMITTERS.video_playlist.settings(FILLED.video_playlist, {});
    assert.equal(s.tabs[0].title, 'Spring clean-up');
    assert.equal(s.tabs[0].youtube_url, 'https://youtu.be/aaaaaa');
    assert.equal(s.tabs[0].duration, '2:10');
    assert.equal(s.playlist_title_tag, 'h3');
  });
  test('SoundCloud: a switcher is "yes" or empty, never true', () => {
    const s = EMITTERS.audio.settings(FILLED.audio, {});
    assert.equal(s.sc_buying, 'yes');
    assert.equal(s.sc_download, '');
    assert.equal(s.link.url, 'https://soundcloud.com/a-business/a-track');
  });
  test('lottie: an external animation publishes its address', () => {
    const s = EMITTERS.lottie.settings(FILLED.lottie, {});
    assert.equal(s.source, 'external_url');
    assert.equal(s.source_external_url.url, 'https://example.test/a.json');
    assert.equal(s.caption, 'Watch it grow');
  });
  test('hotspot: each point keeps its label, its words and where it sits', () => {
    const s = EMITTERS.hotspot.settings(FILLED.hotspot, {});
    assert.equal(s.hotspot[0].hotspot_label, 'Edging');
    assert.equal(s.hotspot[0].hotspot_tooltip_content, 'Cut along every bed');
    assert.deepEqual(s.hotspot[0].hotspot_offset_x, { unit: '%', size: 20, sizes: [] });
  });
});


/* ==========================================================================
   WAVE 2 - the five everyday widgets, and what the LIVE PAGE gets
   ========================================================================== */

describe('the five everyday widgets publish the author, not a constant', () => {
  test('image: the picture, the link, the caption and the whole Style tab', () => {
    const out = EMITTERS.image.settings(FILLED.image, {});
    assert.equal(out.image.url, 'https://example.test/lawn.jpg');
    assert.equal(out.image.id, '31');
    assert.equal(out.caption_source, 'custom');
    assert.equal(out.caption, 'Edged and cut');
    assert.equal(out.link_to, 'custom');
    assert.equal(out.link.url, 'https://example.test/go');
    assert.equal(out.open_lightbox, 'yes');
    assert.equal(out.align, 'start');
    // A width up to 100 is a percentage; a legacy pixel value is not.
    assert.deepEqual(out.width, { unit: '%', size: 60, sizes: [] });
    assert.deepEqual(out.image_border_radius,
      { unit: 'px', top: '8', right: '8', bottom: '8', left: '8', isLinked: true });
    assert.equal(out.text_color, '#445566');
  });

  test('image: a 900 stored by the OLD widget is published as 900 PIXELS', () => {
    // The D-165 renderer drew `width` in pixels, so that is what the documents
    // on disk mean. Publishing it as 900% would blow the page sideways.
    const out = EMITTERS.image.settings({ src: 'https://example.test/a.jpg', width: 900 }, {});
    assert.deepEqual(out.width, { unit: 'px', size: 900, sizes: [] });
    assert.equal(out.image.url, 'https://example.test/a.jpg', 'the older src spelling is still read');
  });

  test('image: every responsive control publishes its tablet and phone twin', () => {
    const out = EMITTERS.image.settings(FILLED.image, {});
    for (const key of ['align', 'width', 'height', 'object-fit', 'caption_align',
      'caption_typography_font_size', 'caption_space', 'image_border_width', 'image_border_radius']) {
      assert.ok(`${key}_tablet` in out, `${key} has no tablet twin`);
      assert.ok(`${key}_mobile` in out, `${key} has no phone twin`);
    }
    assert.equal(out.align_tablet, 'center');
    assert.deepEqual(out.width_mobile, { unit: '%', size: 100, sizes: [] });
  });

  test('image_box: the words reach the page under Elementor own keys', () => {
    const out = EMITTERS.image_box.settings(FILLED.image_box, {});
    assert.equal(out.title_text, 'Weekly mowing');
    assert.equal(out.description_text, 'Every Tuesday, April to October');
    assert.equal(out.title_size, 'h2');
    assert.equal(out.position, 'left');
    assert.equal(out.position_mobile, 'top');
    assert.deepEqual(out.image_size, { unit: '%', size: 40, sizes: [] });
    assert.equal(out.title_color, '#101820');
    assert.equal(out.description_color, '#556677');
    assert.equal('image_alt' in out, false, 'alt text lives on the media record, never on the widget');
  });

  test('image_box: the older title / description spellings are still read', () => {
    const out = EMITTERS.image_box.settings(
      { src: 'https://example.test/o.jpg', title: 'Older', description: 'Words' }, {});
    assert.equal(out.image.url, 'https://example.test/o.jpg');
    assert.equal(out.title_text, 'Older');
    assert.equal(out.description_text, 'Words');
  });

  test('image_carousel: the switches are the author own, not constants', () => {
    // The row this replaces published `image_stretch: no` and `infinite: yes`
    // whatever the author chose, and never published `slides_to_show` at all.
    const out = EMITTERS.image_carousel.settings(FILLED.image_carousel, {});
    assert.equal(out.slides_to_show, '2');
    assert.equal(out.slides_to_show_mobile, '1');
    assert.equal(out.image_stretch, 'yes');
    assert.equal(out.infinite, '', 'switched off by the author');
    assert.equal(out.autoplay, '', 'switched off by the author');
    assert.equal(out.effect, 'fade');
    assert.equal(out.direction, 'rtl');
    assert.equal(out.carousel.length, 2);
    assert.equal(out.carousel[0].url, 'https://example.test/1.jpg');
  });

  test('image_carousel: an untouched widget still publishes Elementor own defaults', () => {
    const out = EMITTERS.image_carousel.settings({}, {});
    assert.equal(out.autoplay, 'yes');
    assert.equal(out.infinite, 'yes');
    assert.equal(out.pause_on_hover, 'yes');
  });

  test('gallery: every photograph, the columns, the gap and the link', () => {
    const out = EMITTERS.gallery.settings(FILLED.gallery, {});
    assert.equal(out.wp_gallery.length, 2);
    assert.equal(out.wp_gallery[0].url, 'https://example.test/a.jpg');
    assert.equal(out.gallery_columns, '2');
    assert.equal(out.gallery_link, 'none');
    assert.equal(out.gallery_rand, 'rand');
    assert.deepEqual(out.image_spacing_custom, { unit: 'px', size: 18, sizes: [] });
  });

  test('gallery: basic_gallery reaches this row through the alias, not a second one', () => {
    assert.equal(canonicalKind('basic_gallery'), 'gallery');
    assert.equal(ELEMENTOR_WIDGETS[canonicalKind('basic_gallery')], EMITTERS.gallery);
  });

  test('video: a Vimeo address publishes a VIMEO video, not a broken YouTube one', () => {
    // The row this replaces hard-coded `video_type: youtube` and put whatever
    // was pasted into `youtube_url`, so a Vimeo link published an empty player.
    const out = EMITTERS.video.settings(FILLED.video, {});
    assert.equal(out.video_type, 'vimeo');
    assert.equal(out.vimeo_url, 'https://vimeo.com/235215203');
    assert.equal(out.youtube_url, '');
    assert.equal(out.start, 30);
    assert.equal(out.controls, '', 'switched off by the author');
    assert.equal(out.aspect_ratio, '43');
    assert.equal(out.image_overlay.url, 'https://example.test/still.jpg');
  });

  test('video: the Source is worked out from the address when nobody picked one', () => {
    assert.equal(EMITTERS.video.settings({ url: 'https://vimeo.com/1' }, {}).video_type, 'vimeo');
    assert.equal(EMITTERS.video.settings({ url: 'https://youtu.be/abc123' }, {}).video_type, 'youtube');
    assert.equal(EMITTERS.video.settings({ url: 'https://dai.ly/x6tqhqb' }, {}).video_type, 'dailymotion');
  });

  test('video: the older url spelling is still read', () => {
    const out = EMITTERS.video.settings({ url: 'https://www.youtube.com/watch?v=abc123xyz' }, {});
    assert.equal(out.youtube_url, 'https://www.youtube.com/watch?v=abc123xyz');
    assert.equal(out.controls, 'yes', 'Elementor own default, for a widget nobody touched');
  });
});
