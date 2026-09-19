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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEYS = JSON.parse(fs.readFileSync(
  path.join(HERE, 'fixtures', 'WIDGET_SETTINGS_KEYS.f2-pictures.json'), 'utf8'));

/** The props a widget carries when an author has actually filled it in. */
const FILLED = {
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

  test('the five are the five, and none of the other five is taken over here', () => {
    assert.deepEqual(Object.keys(EMITTERS).sort(),
      ['audio', 'hotspot', 'lottie', 'pro_gallery', 'video_playlist']);
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
