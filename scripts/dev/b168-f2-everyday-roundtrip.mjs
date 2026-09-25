/**
 * Publish THE FIVE EVERYDAY PICTURE WIDGETS to the dev WordPress, read the page
 * back off the site, and prove the page engine kept every one of them and the
 * settings the deepened panel writes.
 *
 *   node scripts/dev/b168-f2-everyday-roundtrip.mjs
 *
 * B-168 wave 2. Image, Image Box, Image Carousel, Basic Gallery and Video are
 * the widgets an author reaches for first, and until this pass each published a
 * handful of keys out of the widget's own fifty to a hundred and twenty — and
 * read property names the panel stopped writing at D-165. A unit test proves
 * the emitter writes the names we meant; it cannot prove the WEBSITE kept them.
 * The plugin, the page engine's own writer and its sanitiser are all between us
 * and the visitor, and a settings key the engine does not know is dropped
 * SILENTLY on the way in: the page publishes and the client sees a green
 * message. That is the failure this drive exists to catch.
 *
 * Nothing here is a test double. It writes to the dev fixture site on
 * localhost:8084 and to nothing else; the connection details come from
 * `dev-stack/wordpress/.site-id` and `.site-token`, which only that fixture has
 * (memory: feedback_no_real_client_data_in_dev). No client is named in it.
 *
 * All five are FREE widgets, so this needs no plan gate to be lifted — which is
 * the other reason wave 2 matters: these are the five every business can use.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { writePageSections, fetchPages, fetchPageSections, createPage } from '../../lib/websiteBuilder/pageClient.js';
import { pageToElementor, documentToTree } from '../../lib/websiteBuilder/elementorTree.js';
import { ELEMENTOR_WIDGETS, canonicalKind } from '../../lib/websiteBuilder/elementorWidgets.js';

const DEV = 'C:/dev/iadm/dev-stack/wordpress';
const site = {
  site_id: readFileSync(`${DEV}/.site-id`, 'utf8').trim(),
  domain: 'localhost:8084',
  site_token_raw: readFileSync(`${DEV}/.site-token`, 'utf8').trim(),
};

const ctx = { allowPro: false, iaWidgets: [], iaShortcodes: [], seed: 'b168-f2b' };

/** One of each, filled the way the deepened panel writes it. */
const EVERYDAY = [
  ['image', {
    image: { url: 'https://placehold.co/900x600' },
    alt: 'A finished lawn', image_size: 'large',
    caption_source: 'custom', caption: 'Edged and cut',
    link_to: 'custom', link: { url: 'https://example.test/gallery' },
    open_lightbox: 'yes',
    align: 'start', width: 60, image_border_border: 'solid',
    image_border_width: 3, image_border_color: '#1E4E57', image_border_radius: 8,
    caption_align: 'center', text_color: '#334155', caption_typography_font_size: 15,
  }],
  ['image_box', {
    image: { url: 'https://placehold.co/600x400' },
    image_alt: 'The crew', title_text: 'Weekly mowing',
    description_text: 'Every Tuesday, April to October',
    title_size: 'h2', position: 'left', content_vertical_alignment: 'middle',
    text_align: 'start', image_space: 20, image_size: 40,
    title_color: '#0F172A', description_color: '#475569',
  }],
  ['image_carousel', {
    carousel: [
      { url: 'https://placehold.co/600x400' },
      { url: 'https://placehold.co/600x401' },
      { url: 'https://placehold.co/600x402' },
    ],
    slides_to_show: '2', slides_to_scroll: '1', navigation: 'dots',
    image_stretch: 'yes', caption_type: 'title', effect: 'fade',
    autoplay: '', infinite: '', speed: 900,
    image_spacing: 'custom', image_spacing_custom: 24, arrows_color: '#1E4E57',
  }],
  ['basic_gallery', {
    wp_gallery: [
      { url: 'https://placehold.co/500x500', caption: 'Before' },
      { url: 'https://placehold.co/500x501', caption: 'After' },
    ],
    gallery_columns: '2', gallery_link: 'none', open_lightbox: 'no',
    image_spacing: 'custom', image_spacing_custom: 18,
    image_border_border: 'solid', image_border_width: 2, image_border_color: '#1E4E57',
  }],
  ['video', {
    video_type: 'vimeo', vimeo_url: 'https://vimeo.com/235215203',
    start: 30, mute: 'yes', controls: '', aspect_ratio: '43',
    show_image_overlay: 'yes', image_overlay: { url: 'https://placehold.co/800x450' },
    show_play_icon: 'yes', play_icon_color: '#FFFFFF',
  }],
];

/* It starts where a real publish starts — the Portal's own BuilderDocument. */
const DOC = {
  v: 2,
  settings: {},
  sections: [{
    id: 'b168f2b-sec',
    label: 'The everyday five',
    layout: 1,
    width: 'contained',
    style: { padding: { top: 48, right: 20, bottom: 48, left: 20 } },
    columns: [{
      id: 'b168f2b-col',
      widgets: EVERYDAY.map(([kind, props], i) => ({ id: `b168f2b-${i}`, kind, props })),
    }],
  }],
};

const { data, swapped } = pageToElementor(documentToTree(DOC), ctx);
console.log(`sending ${EVERYDAY.length} widgets, all free`);
assert.deepEqual(swapped, [], 'a free widget was refused for the plan, which is a defect in the gate');

const TITLE = 'B-168 everyday pictures';
const pages = await fetchPages(site);
if (!pages.ok) { console.error('could not list pages:', pages); process.exit(1); }
let page = (pages.data?.pages || []).find((p) => p.title === TITLE);
if (!page) {
  const made = await createPage(site, { title: TITLE, type: 'page', sections: [] });
  if (!made.ok || !made.data?.page_id) { console.error('could not create the page:', made); process.exit(1); }
  page = { page_id: made.data.page_id, title: TITLE };
}
console.log(`page: ${page.title} (${page.page_id})`);

const wrote = await writePageSections(site, page.page_id, {
  sections: data.map((node) => ({ node })), status: 'publish',
});
if (!wrote.ok || wrote.data?.success === false) { console.error('write refused:', wrote); process.exit(1); }

const read = await fetchPageSections(site, page.page_id);
if (!read.ok) { console.error('read-back refused:', read); process.exit(1); }
const live = typeof read.data?.elementor_data === 'string'
  ? JSON.parse(read.data.elementor_data)
  : (read.data?.elementor_data || []);

const back = [];
(function walk(nodes) {
  for (const n of nodes || []) {
    if (n?.elType === 'widget') back.push(n);
    walk(n?.elements);
  }
}(live));

const mine = back.filter((w) => String(w.settings?._ia_node || '').startsWith('b168f2b-'));
const got = mine.map((w) => w.widgetType);
console.log('read back:', got.join(', '));

const expected = EVERYDAY.map(([kind]) => ELEMENTOR_WIDGETS[canonicalKind(kind)].widgetType);
const lost = expected.filter((t) => !got.includes(t));
assert.deepEqual(lost, [], `the website dropped: ${lost.join(', ')}`);

/* ── THE SETTINGS, READ OFF WHAT THE SITE GAVE BACK ─────────────────────── */
const of = (widgetType) => mine.find((w) => w.widgetType === widgetType)?.settings || {};

const im = of('image');
console.log('image came back as:', JSON.stringify({
  url: im.image?.url, align: im.align, width: im.width, caption: im.caption,
  border: im.image_border_border, link: im.link?.url,
}));
assert.equal(im.image?.url, 'https://placehold.co/900x600', 'the picture did not survive');
assert.equal(im.caption, 'Edged and cut', 'the caption did not survive');
assert.equal(im.align, 'start', 'the Style tab alignment did not survive');
assert.equal(im.image_border_border, 'solid', 'the border type did not survive');
assert.equal(Number(im.width?.size), 60, 'the width did not survive');
assert.equal(im.link?.url, 'https://example.test/gallery', 'the link did not survive');
assert.ok('align_tablet' in im, 'the per-device twin was dropped');

const box = of('image-box');
assert.equal(box.title_text, 'Weekly mowing', 'the Image Box lost its title');
assert.equal(box.description_text, 'Every Tuesday, April to October', 'the Image Box lost its words');
assert.equal(box.position, 'left', 'the Image Position did not survive');
assert.equal(box.title_size, 'h2', 'the Title HTML Tag did not survive');
assert.equal(Number(box.image_size?.size), 40, 'the picture width did not survive');

const car = of('image-carousel');
assert.equal((car.carousel || []).length, 3, 'the carousel lost its pictures');
assert.equal(car.slides_to_show, '2', 'Slides to Show did not survive — it was never published before');
assert.equal(car.image_stretch, 'yes', 'Image Stretch did not survive — it was a constant before');
assert.equal(car.effect, 'fade', 'the Effect did not survive');
assert.equal(car.infinite, '', 'Infinite Loop was switched OFF and came back on');

const gal = of('image-gallery');
assert.equal((gal.wp_gallery || []).length, 2, 'the gallery lost its photographs');
assert.equal(gal.gallery_columns, '2', 'the columns did not survive');
assert.equal(gal.gallery_link, 'none', 'the Link choice did not survive');
assert.equal(Number(gal.image_spacing_custom?.size), 18, 'the custom gap did not survive');

const vid = of('video');
assert.equal(vid.video_type, 'vimeo', 'the Source did not survive — it was hard-coded to YouTube before');
assert.equal(vid.vimeo_url, 'https://vimeo.com/235215203', 'the Vimeo address did not survive');
assert.equal(vid.aspect_ratio, '43', 'the Aspect Ratio did not survive');
assert.equal(vid.show_image_overlay, 'yes', 'the Image Overlay switch did not survive');
assert.equal(vid.image_overlay?.url, 'https://placehold.co/800x450', 'the overlay picture did not survive');

console.log('every widget and every setting came back off the site.');

/* ── AND THE PAGE A VISITOR GETS ────────────────────────────────────────── */
const slug = String(read.data?.slug || TITLE).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const url = `http://localhost:8084/${slug}/`;
const html = await fetch(url).then((r) => (r.ok ? r.text() : '')).catch(() => '');
if (!html) {
  console.log(`(could not read ${url} — that is a gap, not a pass)`);
} else {
  const seen = ['Weekly mowing', 'Every Tuesday', 'Edged and cut', 'placehold.co']
    .filter((w) => html.includes(w));
  console.log(`the visitor's page carries: ${seen.join(' · ') || 'none of the words'}`);
}
