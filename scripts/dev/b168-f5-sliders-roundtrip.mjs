/**
 * Publish EVERY WIDGET THE SLIDERS FAMILY OFFERS to the dev WordPress, read the
 * page back off the site, and prove the widget types and the settings survived.
 *
 *   node scripts/dev/b168-f5-sliders-roundtrip.mjs
 *   node scripts/dev/b168-f5-sliders-roundtrip.mjs --lite
 *
 * B-168, family F5, the same drive D-165 §11.13.3 point 4 asked for and the
 * same script shape as `d165-standard-set-roundtrip.mjs`. A unit test proves
 * the emitter writes the names we meant; it cannot prove the WEBSITE kept them.
 * The plugin, the page engine's own writer and its sanitiser are all between us
 * and the visitor, and a widget name or a settings key the engine does not know
 * is dropped SILENTLY on the way in — the page still publishes, the client
 * still sees a green message, and the band is not there.
 *
 * `--lite` publishes the same document on a plan with no Pro widgets, which is
 * the other half of the promise: every paid row here declares a fallback that
 * is real content, so a Lite site gets the reviews as words rather than a hole.
 *
 * Nothing here is a test double. It writes to the dev fixture site on
 * localhost:8084 and to nothing else; the connection details come from
 * `dev-stack/wordpress/.site-id` and `.site-token`, which only that fixture has
 * (memory: feedback_no_real_client_data_in_dev). No business is named on the
 * page and every review on it is invented for this script.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { writePageSections, fetchPages, fetchPageSections, createPage } from '../../lib/websiteBuilder/pageClient.js';
import { pageToElementor, elementorToPage, outline, documentToTree } from '../../lib/websiteBuilder/elementorTree.js';
import { ELEMENTOR_WIDGETS } from '../../lib/websiteBuilder/elementorWidgets.js';

const DEV = 'C:/dev/iadm/dev-stack/wordpress';
const site = {
  site_id: readFileSync(`${DEV}/.site-id`, 'utf8').trim(),
  domain: 'localhost:8084',
  site_token_raw: readFileSync(`${DEV}/.site-token`, 'utf8').trim(),
};

const lite = process.argv.includes('--lite');
const ctx = { allowPro: !lite, iaWidgets: [], iaShortcodes: [], seed: 'b168-f5' };

const REVIEWS = [
  { content: 'Out before we opened, every time.', name: 'A property manager', title: 'Google', rating: 5 },
  { content: 'Fair price and no surprises.', name: 'A board chair', title: 'Google', rating: 4 },
];

/** The five this family publishes, with real words on every one. */
const FAMILY = [
  ['testimonial', {
    quote: 'Out before we opened.', attribution: 'A property manager',
    job: 'Owner', align: 'left', testimonial_image_position: 'top',
  }],
  ['reviews', { slides: REVIEWS, slides_per_view: 2, space_between: 24, pagination: 'fraction' }],
  ['testimonial_carousel', {
    slides: REVIEWS.map(({ content, name, title }) => ({ content, name, title })),
    skin: 'bubble', layout: 'image_above', alignment: 'left',
  }],
  ['slides', {
    slides: [
      { heading: 'Winter is booked early', description: 'Reserve your route now.', button_text: 'Get a quote', link: 'https://example.test/quote' },
      { heading: 'One crew, all season', description: 'The same people every visit.', button_text: '', link: '' },
    ],
    slides_height: 520, navigation: 'arrows', transition: 'fade', slides_title_tag: 'h2',
  }],
  ['media_carousel', {
    slides: [
      { type: 'image', image: 'https://placehold.co/600x400' },
      { type: 'video', image: 'https://placehold.co/600x401', video: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
    ],
    skin: 'coverflow', effect: 'fade', caption: 'caption', slides_per_view: 3,
  }],
];

/* IT STARTS WHERE A REAL PUBLISH STARTS — the Portal's own BuilderDocument,
   read by `documentToTree`. Handing the emitter a hand-typed tree would skip
   that reader, which is the corner D-156's conformance pass had to un-cut. */
const DOC = {
  v: 2,
  settings: {},
  sections: [{
    id: 'b168f5-sec',
    label: 'Sliders and reviews',
    layout: 1,
    width: 'contained',
    style: { padding: { top: 48, right: 20, bottom: 48, left: 20 } },
    columns: [{
      id: 'b168f5-col',
      widgets: FAMILY.map(([kind, props], i) => ({ id: `b168f5-${i}`, kind, props })),
    }],
  }],
};

const TREE = documentToTree(DOC);
const { data, swapped } = pageToElementor(TREE, ctx);
console.log(`plan: ${lite ? 'ARION Lite' : 'ARION Standard'}`);
console.log(`sending ${FAMILY.length} widgets`);
if (swapped.length) console.log('swapped for the plan:', swapped.map((s) => s.kind).join(', '));

const TITLE = lite ? 'B-168 F5 sliders (Lite)' : 'B-168 F5 sliders';
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

const mineOnly = back.filter((w) => String(w.settings?._ia_node || '').startsWith('b168f5-'));
console.log('read back:', mineOnly.map((w) => w.widgetType).join(', '));

if (lite) {
  /* ON LITE, four of the five are swapped for real content the visitor can
     read. What must never happen is a Pro widget name reaching the site, or
     the words disappearing with it. */
  const proTypes = ['reviews', 'testimonial-carousel', 'slides', 'media-carousel'];
  const leaked = mineOnly.map((w) => w.widgetType).filter((t) => proTypes.includes(t));
  assert.deepEqual(leaked, [], `a paid widget reached a Lite site: ${leaked.join(', ')}`);
  const words = JSON.stringify(live);
  for (const phrase of ['Out before we opened', 'Fair price and no surprises', 'Winter is booked early']) {
    assert.ok(words.includes(phrase), `the fallback lost "${phrase}" — a Lite visitor reads nothing there`);
  }
  console.log('Lite: every paid band came back as words a visitor can read.');
} else {
  const expected = FAMILY.map(([kind]) => ELEMENTOR_WIDGETS[kind].widgetType);
  const got = mineOnly.map((w) => w.widgetType);
  const lost = expected.filter((t) => !got.includes(t));
  assert.deepEqual(lost, [], `the website dropped: ${lost.join(', ')}`);

  /* THE SETTINGS, READ OFF WHAT THE SITE GAVE BACK — never off what we sent,
     because the plugin, the engine's writer and its sanitiser are in between
     and a key the engine does not have is dropped without a word. */
  const findNode = (marker) => (function find(nodes) {
    for (const n of nodes || []) {
      if (n?.settings?._ia_node === marker) return n;
      const deeper = find(n?.elements);
      if (deeper) return deeper;
    }
    return null;
  }(live));

  const checks = [
    ['b168f5-0', 'testimonial', { testimonial_alignment: 'start', testimonial_image_position: 'top' }],
    ['b168f5-1', 'reviews', { pagination: 'fraction', slides_per_view: '2' }],
    ['b168f5-2', 'testimonial-carousel', { skin: 'bubble', layout: 'image_above', alignment: 'left' }],
    ['b168f5-3', 'slides', { navigation: 'arrows', transition: 'fade', slides_title_tag: 'h2' }],
    ['b168f5-4', 'media-carousel', { skin: 'coverflow', effect: 'fade', caption: 'caption' }],
  ];
  for (const [marker, type, want] of checks) {
    const node = findNode(marker);
    assert.ok(node, `${type} never came back off the site`);
    assert.equal(node.widgetType, type, `${marker} came back as ${node.widgetType}`);
    console.log(`${type} came back as:`, JSON.stringify(
      Object.fromEntries(Object.keys(want).map((k) => [k, node.settings[k]]))));
    for (const [k, v] of Object.entries(want)) {
      assert.equal(String(node.settings[k]), String(v),
        `${type}.${k} did not survive — the site has ${JSON.stringify(node.settings[k])}, we sent ${JSON.stringify(v)}`);
    }
  }

  /* THE SLIDES THEMSELVES, not just the switches around them. A repeater whose
     rows the engine drops is a carousel with no slides in it. */
  const reviews = findNode('b168f5-1');
  assert.equal((reviews.settings.slides || []).length, 2, 'the reviews repeater lost its rows');
  assert.equal(reviews.settings.slides[0].content, REVIEWS[0].content, 'a review lost its words');
  assert.equal(String(reviews.settings.slides[1].rating), '4', 'a review lost its rating');
  console.log('the reviews repeater came back with', reviews.settings.slides.length, 'rows and their words.');
}

/* And the reader says the same thing back in our own words. */
const mine = elementorToPage(live).filter((n) => String(n.id || '').startsWith('b168f5-'));
console.log(mine.map((n) => outline(n).join('\n')).join('\n'));

const slug = String(read.data?.slug || page.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const url = `http://localhost:8084/${slug}/`;
const html = await fetch(url).then((r) => (r.ok ? r.text() : '')).catch(() => '');
if (!html) {
  console.log(`could not fetch ${url} — the page is published; look at it yourself.`);
} else {
  /* WHAT THE LIVE DEV PAGE CAN AND CANNOT PROVE, said plainly.
   *
   * The dev WordPress has Elementor FREE and no Pro (checked here, not assumed:
   * nothing on the page mentions `elementor-pro`). So only the FREE widget of
   * this family — Testimonial — has a body on the page. The four Pro ones reach
   * the engine and the engine builds their elements — the `elementor-widget-…`
   * wrappers are all there, which is what proves the widget NAME was accepted
   * rather than sanitised away — and then draw nothing, because the plugin that
   * knows how is not installed. That is a fact about this dev box, not about
   * the emitter, and the read-back of `_elementor_data` above is what proves
   * the settings survived.
   */
  const hasPro = html.includes('elementor-pro');
  assert.ok(html.includes('Out before we opened'),
    `the free widget's words are not on the live page at ${url}`);
  const wrappers = lite
    ? ['elementor-widget-heading', 'elementor-widget-text-editor']
    : ['elementor-widget-testimonial', 'elementor-widget-reviews',
      'elementor-widget-testimonial-carousel', 'elementor-widget-slides',
      'elementor-widget-media-carousel'];
  const absent = wrappers.filter((w) => !html.includes(w));
  assert.deepEqual(absent, [], `the page engine never built: ${absent.join(', ')}`);
  console.log(`the live page at ${url} built every widget`
    + (hasPro ? '' : ' (Elementor Pro is NOT installed on this dev box, so only the free one has a body)'));
  if (!lite && !hasPro) {
    for (const phrase of ['Fair price and no surprises', 'Winter is booked early']) {
      assert.equal(html.includes(phrase), false,
        `"${phrase}" IS drawn — Pro is installed after all, so this branch is wrong and the`
        + ' words should be asserted PRESENT instead');
    }
    console.log('…and the Pro bodies really are empty here, which is the plugin and not us.');
  }
}

console.log('ROUND TRIP OK');
