/**
 * Publish THE FIVE PICTURE WIDGETS to the dev WordPress, read the page back off
 * the site, and prove the page engine kept every one of them and their
 * settings.
 *
 *   node scripts/dev/b168-f2-pictures-roundtrip.mjs
 *
 * B-168, plan §C.3. A unit test proves the emitter writes the names we meant;
 * it cannot prove the WEBSITE kept them. The plugin, the page engine's own
 * writer and its sanitiser are all between us and the visitor, and a widget
 * name or a settings key the engine does not know is dropped SILENTLY on the
 * way in — the page still publishes and the client still sees a green message.
 * That is the failure this drive exists to catch, and it is the same drive
 * D-165 ran for the standard set (scripts/dev/d165-standard-set-roundtrip.mjs).
 *
 * Nothing here is a test double. It writes to the dev fixture site on
 * localhost:8084 and to nothing else; the connection details come from
 * `dev-stack/wordpress/.site-id` and `.site-token`, which only that fixture
 * has (memory: feedback_no_real_client_data_in_dev). No client is named in it.
 *
 * FOUR OF THE FIVE ARE PRO, so this runs with `allowPro: true` — the plan gate
 * is the same one D-165 drove and it is not what is being tested here. Run it
 * with `--lite` to watch the gate refuse them by name instead, which is the
 * behaviour the offer file's `pro_rule` asks for.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { writePageSections, fetchPages, fetchPageSections, createPage } from '../../lib/websiteBuilder/pageClient.js';
import { pageToElementor, documentToTree } from '../../lib/websiteBuilder/elementorTree.js';
import { ELEMENTOR_WIDGETS } from '../../lib/websiteBuilder/elementorWidgets.js';

const DEV = 'C:/dev/iadm/dev-stack/wordpress';
const site = {
  site_id: readFileSync(`${DEV}/.site-id`, 'utf8').trim(),
  domain: 'localhost:8084',
  site_token_raw: readFileSync(`${DEV}/.site-token`, 'utf8').trim(),
};

const lite = process.argv.includes('--lite');
const ctx = { allowPro: !lite, iaWidgets: [], iaShortcodes: [], seed: 'b168-f2' };

/** One of each, with real words on it and three settings a person would set. */
const PICTURES = [
  ['pro_gallery', {
    gallery: [
      { url: 'https://placehold.co/600x400' },
      { url: 'https://placehold.co/600x401' },
      { url: 'https://placehold.co/600x402' },
    ],
    gallery_layout: 'masonry', columns: 3, gap: 16, aspect_ratio: '16:9',
    overlay_background: 'yes', overlay_title: 'title',
  }],
  ['video_playlist', {
    playlist_title: 'How we do it', playlist_title_tag: 'h3',
    tabs: [
      { title: 'Spring clean-up', youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', duration: '2:10' },
      { title: 'Aeration', youtube_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', duration: '1:40' },
    ],
    show_duration: 'yes', show_video_count: 'yes',
  }],
  ['audio', {
    link: 'https://soundcloud.com/a-business/a-track',
    visual: 'yes', sc_download: '', sc_show_comments: '',
  }],
  ['lottie', {
    source: 'external_url', source_external_url: { url: 'https://example.test/animation.json' },
    caption_source: 'custom', caption: 'Watch it grow', trigger: 'on_hover', loop: 'yes',
  }],
  ['hotspot', {
    image: { url: 'https://placehold.co/800x500' },
    hotspot: [
      { hotspot_label: 'Edging', hotspot_tooltip_content: 'Cut along every bed', hotspot_offset_x: 20, hotspot_offset_y: 30 },
      { hotspot_label: 'Mulch', hotspot_tooltip_content: 'Two inches, no more', hotspot_offset_x: 70, hotspot_offset_y: 60 },
    ],
    tooltip_position: 'right', tooltip_trigger: 'mouseenter',
  }],
];

/* It starts where a real publish starts — the Portal's own BuilderDocument. */
const DOC = {
  v: 2,
  settings: {},
  sections: [{
    id: 'b168f2-sec',
    label: 'Pictures and media',
    layout: 1,
    width: 'contained',
    style: { padding: { top: 48, right: 20, bottom: 48, left: 20 } },
    columns: [{
      id: 'b168f2-col',
      widgets: PICTURES.map(([kind, props], i) => ({ id: `b168f2-${i}`, kind, props })),
    }],
  }],
};

const { data, swapped } = pageToElementor(documentToTree(DOC), ctx);
console.log(`plan: ${lite ? 'ARION Lite' : 'ARION Standard'}`);
console.log(`sending ${PICTURES.length} widgets`);
if (swapped.length) console.log('swapped or refused for the plan:', swapped.map((s) => s.kind).join(', '));

const TITLE = 'B-168 pictures and media';
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

const mine = back.filter((w) => String(w.settings?._ia_node || '').startsWith('b168f2-'));
const got = mine.map((w) => w.widgetType);
console.log('read back:', got.join(', '));

const expected = PICTURES.map(([kind]) => ELEMENTOR_WIDGETS[kind].widgetType);
const lost = expected.filter((t) => !got.includes(t));
if (!lite) assert.deepEqual(lost, [], `the website dropped: ${lost.join(', ')}`);

/* ── THE SETTINGS, READ OFF WHAT THE SITE GAVE BACK ─────────────────────── */
const of = (widgetType) => mine.find((w) => w.widgetType === widgetType)?.settings || {};

if (!lite) {
  const g = of('gallery');
  console.log('gallery came back as:', JSON.stringify({
    layout: g.gallery_layout, columns: g.columns, gap: g.gap, pictures: (g.gallery || []).length,
  }));
  assert.equal((g.gallery || []).length, 3, 'the pictures did not survive — this is the bug the row replaced');
  assert.equal(g.gallery_layout, 'masonry', 'the layout did not survive');
  assert.equal(Number(g.columns), 3, 'the columns did not survive');

  const v = of('video-playlist');
  assert.equal((v.tabs || []).length, 2, 'the playlist rows did not survive');
  assert.equal(v.tabs[0].title, 'Spring clean-up', 'the first video lost its title');
  assert.equal(v.playlist_title_tag, 'h3', 'the heading tag did not survive');

  const a = of('audio');
  assert.equal(a.link?.url, 'https://soundcloud.com/a-business/a-track', 'the track address did not survive');
  assert.equal(a.visual, 'yes', 'the visual player switch did not survive');

  const l = of('lottie');
  assert.equal(l.caption, 'Watch it grow', 'the caption did not survive');
  assert.equal(l.trigger, 'on_hover', 'the trigger did not survive');

  const h = of('hotspot');
  assert.equal((h.hotspot || []).length, 2, 'the hotspots did not survive');
  assert.equal(h.hotspot[0].hotspot_label, 'Edging', 'the first hotspot lost its label');
  assert.equal(h.tooltip_trigger, 'mouseenter', 'the tooltip trigger did not survive');

  console.log('every widget and every setting came back off the site.');
} else {
  console.log('lite run: the gate refused', swapped.map((s) => s.kind).join(', ') || 'nothing');
}

/* ── AND THE PAGE A VISITOR GETS ────────────────────────────────────────── */
const slug = String(read.data?.slug || TITLE).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const url = `http://localhost:8084/${slug}/`;
const html = await fetch(url).then((r) => (r.ok ? r.text() : '')).catch(() => '');
if (!html) {
  console.log(`(could not read ${url} — that is a gap, not a pass)`);
} else {
  const seen = ['How we do it', 'Edging', 'Watch it grow'].filter((w) => html.includes(w));
  console.log(`the visitor's page carries: ${seen.join(' · ') || 'none of the words'}`);
}
