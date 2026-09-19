/**
 * Publish ONE OF EVERY STANDARD WIDGET to the dev WordPress, read the page
 * back off the site, and prove every widget type and the container settings
 * survived.
 *
 *   node scripts/dev/d165-standard-set-roundtrip.mjs
 *   node scripts/dev/d165-standard-set-roundtrip.mjs --lite
 *
 * D-165 §11.13.3, point 4. A unit test proves the emitter writes the names we
 * meant; it cannot prove the WEBSITE kept them. The plugin, the page engine's
 * own writer and its sanitiser are all between us and the visitor, and a
 * widget name the engine does not know is silently dropped on the way in —
 * which is exactly the failure this drive exists to catch, because the page
 * would still publish and the client would still see a green message.
 *
 * Nothing here is a test double. It writes to the dev fixture site on
 * localhost:8084 and to nothing else; the connection details come from
 * `dev-stack/wordpress/.site-id` and `.site-token`, which only that fixture
 * has (memory: feedback_no_real_client_data_in_dev).
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
const ctx = { allowPro: !lite, iaWidgets: [], iaShortcodes: [], seed: 'd165-drive' };

/** One widget of every standard kind §11.13.3 names, with real words on it. */
const STANDARD = [
  ['heading', { text: 'Every widget, once', level: 'h2', align: 'center' }],
  ['paragraph', { text: 'One of each, published through the plugin.' }],
  ['image', { url: 'https://placehold.co/600x300', caption: 'A picture' }],
  ['button', { text: 'Get in touch', href: 'https://example.test/contact' }],
  ['divider', {}],
  ['spacer', { height: 32 }],
  ['icon', { icon: 'check', view: 'stacked' }],
  ['list', { items: ['Salting included', '24-hour response'] }],
  ['icon_box', { icon: 'clock', title: 'Fast', description: 'On the road within the hour.' }],
  ['image_box', { url: 'https://placehold.co/400x300', title: 'The crew', description: 'The same people.' }],
  ['testimonial', { quote: 'Out before we opened.', attribution: 'A customer', role: 'Owner' }],
  ['star_rating', { rating: 4.5, scale: 5, title: 'Our reviews' }],
  ['alert', { type: 'warning', title: 'Storm watch', text: 'Routes run early tomorrow.' }],
  ['social_links', { links: [{ network: 'facebook', url: 'https://facebook.test/x' }] }],
  ['video', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }],
  ['map', { address: '1200 Prairie Ave, Marshalltown, IA', zoom: 13 }],
  ['counter', { value: 1240, suffix: '+', label: 'Lots cleared' }],
  ['progress_bar', { title: 'Season booked', percent: 72 }],
  ['tabs', { items: [{ title: 'Commercial', body: 'Lots and walks.' }, { title: 'Residential', body: 'Drives.' }] }],
  ['accordion', { items: [{ question: 'When do you come out?', answer: 'At a two-inch trigger.' }] }],
  ['toggle', { items: [{ title: 'The small print', body: 'Prices exclude tax.' }] }],
  ['image_carousel', { images: ['https://placehold.co/600x400', 'https://placehold.co/600x401'] }],
  ['gallery', { images: ['https://placehold.co/300x300'] }],
  ['html', { html: '<p>Typed straight onto the page.</p>' }],
  ['shortcode', { shortcode: '[ia_book_now]' }],
  ['menu_anchor', { anchor: 'prices' }],
];

/**
 * IT STARTS WHERE A REAL PUBLISH STARTS — the Portal's own BuilderDocument,
 * read by `documentToTree`.
 *
 * The first cut of this drive handed the emitter a tree typed by hand, which
 * skipped that reader entirely — the same corner D-156's conformance pass had
 * to un-cut, and it showed immediately: the box's own tag never reached the
 * website and the drive passed anyway until the assertion below caught it.
 */
const DOC = {
  v: 2,
  settings: {},
  sections: [{
    id: 'd165-sec',
    label: 'Every widget, once',
    layout: 1,
    width: 'contained',
    style: { padding: { top: 48, right: 20, bottom: 48, left: 20 } },
    columns: [{
      id: 'd165-col',
      widgets: [
        ...STANDARD.map(([kind, props], i) => ({ id: `d165-${i}`, kind, props })),
        /* A ROW three across, carrying the three things a box can say that the
           website has to hear: how it lines up, whether it wraps, and the tag
           it is drawn as. */
        {
          id: 'd165-row',
          kind: 'container',
          props: { html_tag: 'section' },
          style: { direction: 'row', alignItems: 'center', wrap: true, gap: 24 },
          children: [0, 1, 2].map((n) => ({
            id: `d165-row-${n}`,
            kind: 'icon_box',
            props: { icon: 'check', title: `Reason ${n + 1}`, description: 'Why somebody would want it.' },
          })),
        },
      ],
    }],
  }],
};

const TREE = documentToTree(DOC);

/* pageToElementor resolves every widget through `resolveWidget`, which is the
   one door the plan gate and the alias table live behind. */
const { data, swapped } = pageToElementor(TREE, ctx);
console.log(`plan: ${lite ? 'ARION Lite' : 'ARION Standard'}`);
console.log(`sending ${STANDARD.length} widgets`);
if (swapped.length) console.log('swapped for the plan:', swapped.map((s) => `${s.kind}`).join(', '));

const TITLE = 'D-165 standard set';
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

/* ── WHAT CAME BACK OFF THE SITE ─────────────────────────────────────────── */
const back = [];
(function walk(nodes) {
  for (const n of nodes || []) {
    if (n?.elType === 'widget') back.push(n);
    walk(n?.elements);
  }
}(live));

const expected = STANDARD.map(([kind]) => ELEMENTOR_WIDGETS[kind].widgetType);
const got = back.filter((w) => String(w.settings?._ia_node || '').startsWith('d165-')).map((w) => w.widgetType);
console.log('read back:', got.join(', '));

const lost = expected.filter((t) => !got.includes(t));
assert.deepEqual(lost, [], `the website dropped: ${lost.join(', ')}`);

/* The container settings, read off what the SITE gave back — never off what
   we sent, because the plugin, the engine's writer and its sanitiser are all
   in between. */
const findNode = (marker) => (function find(nodes) {
  for (const n of nodes || []) {
    if (n?.settings?._ia_node === marker) return n;
    const deeper = find(n?.elements);
    if (deeper) return deeper;
  }
  return null;
}(live));

const liveSec = findNode('d165-sec');
assert.ok(liveSec, 'the section never came back off the site');
console.log('the section came back as:', JSON.stringify({
  container_type: liveSec.settings.container_type,
  flex_direction: liveSec.settings.flex_direction,
  content_width: liveSec.settings.content_width,
  padding: liveSec.settings.padding,
}));
assert.equal(liveSec.settings.container_type, 'flex', 'the section is not a flex container');
assert.equal(liveSec.settings.content_width, 'boxed', 'the content width did not survive');

const liveRow = findNode('d165-row');
assert.ok(liveRow, 'the row never came back off the site');
console.log('the row came back as:', JSON.stringify({
  flex_direction: liveRow.settings.flex_direction,
  flex_align_items: liveRow.settings.flex_align_items,
  flex_wrap: liveRow.settings.flex_wrap,
  html_tag: liveRow.settings.html_tag,
  flex_direction_mobile: liveRow.settings.flex_direction_mobile,
}));
assert.equal(liveRow.settings.flex_direction, 'row', 'the direction did not survive');
assert.equal(liveRow.settings.flex_align_items, 'center', 'the Align items the author set did not survive');
assert.equal(liveRow.settings.flex_wrap, 'wrap', 'the Wrap the author set did not survive');
assert.equal(liveRow.settings.html_tag, 'section', 'the tag the box is drawn as did not survive');
assert.equal(liveRow.settings.flex_direction_mobile, 'column', 'the row does not stack on a phone');

/* And the reader says the same thing back in our own words. */
const mine = elementorToPage(live).filter((n) => String(n.id || '').startsWith('d165-'));
console.log(mine.map((n) => outline(n).join('\n')).join('\n'));

/* ── AND THE WORDS ARE ON THE PAGE A VISITOR SEES ────────────────────────── */
const slug = String(read.data?.slug || page.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const url = `http://localhost:8084/${slug}/`;
const html = await fetch(url).then((r) => (r.ok ? r.text() : '')).catch(() => '');
if (!html) {
  console.log(`(could not read ${url} — the assertion below is skipped, and that is a gap, not a pass)`);
} else {
  /* §11.13.4's own reference shapes — a hero, a row of three icon boxes and
     an accordion — read off the page a VISITOR gets, because a widget can be
     in `_elementor_data` and still draw nothing (D-156 caught exactly that
     with a paid card on a plan that could not render it). */
  for (const words of [
    'Every widget, once',            // the hero heading
    'Reason 1', 'Reason 2', 'Reason 3', // the row of three icon boxes
    'When do you come out?',         // the accordion
    'At a two-inch trigger.',        // ...and its answer
    'Storm watch',                   // the alert
    'Our reviews',                   // the star rating
  ]) {
    assert.ok(html.includes(words), `“${words}” is not on the live page at ${url}`);
  }
  for (const cls of ['elementor-widget-accordion', 'elementor-widget-icon-box', 'e-con']) {
    assert.ok(html.includes(cls), `the live page has no ${cls} — the widget was written and not drawn`);
  }
  console.log(`the live page at ${url} draws the hero, the three icon boxes and the accordion.`);
}

console.log('\nROUND TRIP OK — every standard widget survived the website.');
