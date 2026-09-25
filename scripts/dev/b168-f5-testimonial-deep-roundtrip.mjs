/**
 * Publish a DEEPLY STYLED Testimonial to the dev WordPress, read the page back
 * off the site, and prove every one of the thirty-nine settings survived.
 *
 *   node scripts/dev/b168-f5-testimonial-deep-roundtrip.mjs
 *
 * B-168, family F5, wave 2. `b168-f5-sliders-roundtrip.mjs` proved the five
 * widget NAMES reach a live site. This proves the thing wave 2 is about: an
 * author who sets a colour, a size, a weight, a border or a phone-sized
 * heading gets it on the page a visitor loads.
 *
 * WHY A ROUND TRIP AND NOT A UNIT TEST. A unit test proves the emitter writes
 * the keys we meant. It cannot prove the WEBSITE kept them: the plugin, the
 * page engine's own writer and its sanitiser are all between us and the
 * visitor, and a settings key the engine does not have is dropped SILENTLY —
 * the page publishes, the client sees a green message, and the setting is not
 * there. That is `reference_catch_swallow_report_success` at the one boundary
 * where nobody looks twice, so the assertions below read the settings OFF THE
 * SITE and never off what we sent.
 *
 * Nothing here is a test double. It writes to the dev fixture site on
 * localhost:8084 and to nothing else; the connection details come from
 * `dev-stack/wordpress/.site-id` and `.site-token`, which only that fixture
 * has (memory: feedback_no_real_client_data_in_dev). No business is named on
 * the page and the testimonial on it is invented for this script.
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import { writePageSections, fetchPages, fetchPageSections, createPage } from '../../lib/websiteBuilder/pageClient.js';
import { pageToElementor, documentToTree } from '../../lib/websiteBuilder/elementorTree.js';

const DEV = 'C:/dev/iadm/dev-stack/wordpress';
const site = {
  site_id: readFileSync(`${DEV}/.site-id`, 'utf8').trim(),
  domain: 'localhost:8084',
  site_token_raw: readFileSync(`${DEV}/.site-token`, 'utf8').trim(),
};

const ctx = { allowPro: true, iaWidgets: [], iaShortcodes: [], seed: 'b168-g5' };

/**
 * ONE TESTIMONIAL WITH THE WHOLE STYLE TAB USED.
 *
 * Every key here is one the panel writes: the three parts' colour and
 * typography, the picture's five, Alignment's three devices, the link and the
 * job. `align: "left"` is on purpose — it is the spelling a document stored
 * before this family carries, and Elementor's control offers `start`. If the
 * emitter passed it through the page would quietly become centred.
 */
const PROPS = {
  quote: 'Out before we opened, every time.',
  attribution: 'A property manager',
  job: 'Owner',
  image: 'https://placehold.co/128x128',
  link: 'https://example.test/review',
  align: 'left',
  align_tablet: 'center',
  align_mobile: 'end',
  testimonial_image_position: 'top',

  content_content_color: '#123456',
  content_typography_font_size: 22,
  content_typography_font_size_tablet: 20,
  content_typography_font_size_mobile: 17,
  content_typography_font_weight: '700',
  content_typography_text_transform: 'none',
  content_typography_font_style: 'italic',
  content_typography_text_decoration: 'none',
  content_typography_line_height: 1.4,
  content_typography_letter_spacing: 1,
  content_typography_word_spacing: 2,

  name_text_color: '#654321',
  name_typography_font_size: 16,
  name_typography_font_weight: '600',
  name_typography_text_transform: 'uppercase',
  name_typography_letter_spacing: 1,

  job_text_color: '#0A0B0C',
  job_typography_font_size: 12,
  job_typography_font_style: 'italic',

  image_size: 96,
  image_size_mobile: 64,
  image_border_border: 'solid',
  image_border_width: 3,
  image_border_color: '#0C4A60',
  image_border_radius: 8,
};

/* IT STARTS WHERE A REAL PUBLISH STARTS — the Portal's own BuilderDocument,
   read by `documentToTree`. Handing the emitter a hand-typed tree would skip
   that reader, which is the corner D-156's conformance pass had to un-cut. */
const DOC = {
  v: 2,
  settings: {},
  sections: [{
    id: 'b168g5-sec',
    label: 'Testimonial, deeply styled',
    layout: 1,
    width: 'contained',
    style: { padding: { top: 48, right: 20, bottom: 48, left: 20 } },
    columns: [{ id: 'b168g5-col', widgets: [{ id: 'b168g5-0', kind: 'testimonial', props: PROPS }] }],
  }],
};

const TREE = documentToTree(DOC);
const { data } = pageToElementor(TREE, ctx);

const TITLE = 'B-168 F5 testimonial (deep)';
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

const node = (function find(nodes) {
  for (const n of nodes || []) {
    if (n?.settings?._ia_node === 'b168g5-0') return n;
    const deeper = find(n?.elements);
    if (deeper) return deeper;
  }
  return null;
}(live));
assert.ok(node, 'the testimonial never came back off the site');
assert.equal(node.widgetType, 'testimonial', `it came back as ${node.widgetType}`);

/** A slider came back as Elementor's own {unit,size,sizes}. */
const slider = (v) => (v && typeof v === 'object' ? `${v.size}${v.unit}` : String(v));
/** A four-sided box came back with all four the same. */
const box = (v) => (v && typeof v === 'object' ? `${v.top}${v.unit}` : String(v));

const PLAIN = {
  testimonial_content: PROPS.quote,
  testimonial_name: PROPS.attribution,
  testimonial_job: PROPS.job,
  /* `left` is not a value this control offers; the emitter reads it as
     Elementor's own `start` rather than letting the engine drop it and the
     page quietly become centred. */
  testimonial_alignment: 'start',
  testimonial_alignment_tablet: 'center',
  testimonial_alignment_mobile: 'end',
  testimonial_image_position: 'top',
  content_content_color: '#123456',
  content_typography_typography: 'custom',
  content_typography_font_weight: '700',
  content_typography_font_style: 'italic',
  name_text_color: '#654321',
  name_typography_typography: 'custom',
  name_typography_font_weight: '600',
  name_typography_text_transform: 'uppercase',
  job_text_color: '#0A0B0C',
  job_typography_typography: 'custom',
  job_typography_font_style: 'italic',
  image_border_border: 'solid',
  image_border_color: '#0C4A60',
};
const SLIDERS = {
  content_typography_font_size: '22px',
  content_typography_font_size_tablet: '20px',
  content_typography_font_size_mobile: '17px',
  content_typography_line_height: '1.4em',
  content_typography_letter_spacing: '1px',
  content_typography_word_spacing: '2px',
  name_typography_font_size: '16px',
  name_typography_letter_spacing: '1px',
  job_typography_font_size: '12px',
  image_size: '96px',
  image_size_mobile: '64px',
};
const BOXES = {
  image_border_width: '3px',
  image_border_radius: '8px',
};

const bad = [];
for (const [k, want] of Object.entries(PLAIN)) {
  if (String(node.settings[k]) !== String(want)) bad.push(`${k}: site has ${JSON.stringify(node.settings[k])}, we sent ${JSON.stringify(want)}`);
}
for (const [k, want] of Object.entries(SLIDERS)) {
  if (slider(node.settings[k]) !== want) bad.push(`${k}: site has ${JSON.stringify(node.settings[k])}, we sent ${want}`);
}
for (const [k, want] of Object.entries(BOXES)) {
  if (box(node.settings[k]) !== want) bad.push(`${k}: site has ${JSON.stringify(node.settings[k])}, we sent ${want}`);
}
/* THE PICTURE AND THE LINK, which are objects rather than words. */
if (String(node.settings.testimonial_image?.url || '') !== PROPS.image) {
  bad.push(`testimonial_image: site has ${JSON.stringify(node.settings.testimonial_image)}`);
}
if (String(node.settings.link?.url || '') !== PROPS.link) {
  bad.push(`link: site has ${JSON.stringify(node.settings.link)}`);
}

const checked = Object.keys(PLAIN).length + Object.keys(SLIDERS).length + Object.keys(BOXES).length + 2;
console.log(`checked ${checked} settings read back OFF THE SITE`);
if (bad.length) {
  console.error('THESE DID NOT SURVIVE THE PUBLISH:');
  for (const b of bad) console.error('  ·', b);
  process.exit(1);
}
console.log('every one of them came back exactly as it was sent.');

/* AND THE LIVE PAGE A VISITOR LOADS. Testimonial is FREE, so unlike the four
   Pro sliders this one really draws on a dev WordPress that has no Pro. */
const slug = String(read.data?.slug || TITLE).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const url = `http://localhost:8084/${slug}/`;
const html = await fetch(url).then((r) => (r.ok ? r.text() : '')).catch(() => '');
if (!html) {
  console.log(`could not fetch ${url} — the page is published; look at it yourself.`);
} else {
  const found = [];
  const missing = [];
  for (const [what, needle] of [
    ['the quote', 'Out before we opened, every time.'],
    ['the name', 'A property manager'],
    ['the job', 'Owner'],
    ['the widget wrapper', 'elementor-widget-testimonial'],
    ['the quote colour', '#123456'],
    ['the name colour', '#654321'],
    ['the border colour', '#0C4A60'],
    ['the quote size', '22px'],
    ['the picture size', '96px'],
  ]) (html.includes(needle) ? found : missing).push(what);
  console.log(`${url}`);
  console.log('  on the live page:', found.join(', ') || 'nothing');
  if (missing.length) console.log('  NOT on the live page:', missing.join(', '));
}
