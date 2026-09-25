/**
 * Publish the FIVE f4-moving widgets wave 2 deepened, with a real value on
 * every control the panel offers, to the dev WordPress — then read
 * `_elementor_data` back off the site and prove each setting survived.
 *
 *   node scripts/dev/g4-f4-wave2-roundtrip.mjs
 *
 * A unit test proves the emitter WRITES the keys we meant. It cannot prove the
 * WEBSITE kept them: the plugin, the page engine's own writer and its
 * sanitiser are all in between, and a key the engine does not know is dropped
 * in silence while the page still publishes and the client still sees a green
 * message. That is the shape this drive exists to catch, and it is the shape
 * wave 1 found twice.
 *
 * TWO THINGS THIS ONE ANSWERS THAT THE D-165 DRIVE COULD NOT:
 *   1. Tabs and Accordion are NESTED elements. We now publish `nested-tabs`
 *      and `nested-accordion` with a child container per panel, built from a
 *      live capture of what Elementor itself writes. Does WordPress keep the
 *      children, and the `_title` on each?
 *   2. Every Style control the rebuilt panels added — the colours, the sizes,
 *      the typography toggles. Do they come back?
 *
 * Nothing here is a test double. It writes to the dev fixture site on
 * localhost:8084 and to nothing else; the connection details come from
 * `dev-stack/wordpress/.site-id` and `.site-token`, which only that fixture
 * has (memory: feedback_no_real_client_data_in_dev).
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

const ctx = { allowPro: true, iaWidgets: [], iaShortcodes: [], seed: 'g4-drive' };

/** One of each, with a real value on every control the rebuilt panel offers. */
const FIVE = [
  ['counter', {
    starting_number: 0, ending_number: 1250, prefix: '$', suffix: '+', duration: 1500,
    thousand_separator: true, thousand_separator_char: '.', title: 'Jobs done', title_tag: 'h3',
    title_position: 'before', title_horizontal_alignment: 'center', number_alignment: 'center',
    title_gap: 6, number_color: '#0C4A60', typography_number_font_size: 40,
    typography_number_font_weight: '700', title_color: '#334155',
    typography_title_font_size: 14, typography_title_font_weight: '500',
  }],
  ['progress_bar', {
    title: 'Season booked', title_tag: 'h4', title_display: true, progress_type: 'success',
    percent: 72, display_percentage: true, inner_text: 'on track',
    title_color: '#334155', typography_font_size: 15, typography_font_weight: '600',
    bar_color: '#0C4A60', bar_bg_color: '#E2E8F0', bar_height: 18, bar_border_radius: 9,
    bar_inline_color: '#FFFFFF', bar_inner_typography_font_size: 11,
  }],
  ['star_rating', {
    rating_scale: 5, rating_value: 4.5, rating_icon: 'eicon-star', icon_alignment: 'center',
    icon_size: 22, icon_gap: 4, icon_color: '#F59E0B', icon_unmarked_color: '#E2E8F0',
    title: 'Our reviews',
  }],
  ['tabs', {
    tabs: [
      { tab_title: 'Commercial', tab_content: 'Lots and walks, cleared before six.' },
      { tab_title: 'Residential', tab_content: 'Drives and paths.' },
    ],
    tabs_direction: 'block-start', tabs_justify_horizontal: 'center', title_alignment: 'center',
    tabs_title_space_between: 8, tabs_title_spacing: 12,
    tabs_title_background_color_color: '#F1F5F9', tabs_title_border_color: '#CBD5E1',
    tabs_title_background_color_active_color: '#0C4A60',
    title_text_color: '#334155', title_text_color_active: '#0C4A60',
    title_typography_font_size: 16, title_typography_font_weight: '600',
    box_background_color_color: '#FFFFFF', box_border_color: '#E2E8F0', box_padding: 16,
  }],
  ['accordion', {
    tabs: [
      { tab_title: 'When do you come out?', tab_content: 'At a two-inch trigger.' },
      { tab_title: 'Do you salt?', tab_content: 'Yes, and it is in the price.' },
    ],
    accordion_item_title_position_horizontal: 'start', accordion_item_title_icon_position: 'end',
    title_tag: 'h4', faq_schema: true, default_state: 'all_collapsed',
    accordion_item_title_space_between: 6, accordion_item_title_distance_from_content: 4,
    accordion_background_normal_color: '#FFFFFF', accordion_border_normal_color: '#E2E8F0',
    normal_title_color: '#334155', active_title_color: '#0C4A60',
    title_typography_font_size: 16, title_typography_font_weight: '600',
    normal_icon_color: '#64748B', icon_spacing: 10,
    content_background_color: '#F8FAFC', content_border_color: '#E2E8F0', content_padding: 12,
  }],
];

const DOC = {
  v: 2,
  settings: {},
  sections: [{
    id: 'g4-sec',
    label: 'B-168 f4-moving wave 2',
    layout: 1,
    width: 'contained',
    style: { padding: { top: 48, right: 20, bottom: 48, left: 20 } },
    columns: [{
      id: 'g4-col',
      widgets: FIVE.map(([kind, props], i) => ({ id: `g4-${i}`, kind, props })),
    }],
  }],
};

const { data, swapped } = pageToElementor(documentToTree(DOC), ctx);
console.log(`sending ${FIVE.length} widgets`);
if (swapped.length) console.log('swapped for the plan:', swapped.map((s) => s.kind).join(', '));

const TITLE = 'B-168 f4-moving wave 2';
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

const byType = (t) => back.find((w) => w.widgetType === t);
console.log('read back:', back.map((w) => w.widgetType).join(', '));

/* ── EVERY SETTING, OFF THE SITE ─────────────────────────────────────────── */
const fails = [];
function want(widgetType, key, expected, why) {
  const w = byType(widgetType);
  if (!w) { fails.push(`${widgetType}: never came back off the site`); return; }
  const got = w.settings?.[key];
  const same = JSON.stringify(got) === JSON.stringify(expected);
  if (!same) fails.push(`${widgetType}.${key}: sent ${JSON.stringify(expected)}, the site gave back ${JSON.stringify(got)} — ${why}`);
}

want('counter', 'thousand_separator_char', '.', 'the separator the author chose');
want('counter', 'title_tag', 'h3', 'the tag the title is drawn as');
want('counter', 'number_color', '#0C4A60', 'the colour of the number');
want('counter', 'typography_number_typography', 'custom', 'without this the size is ignored');
want('counter', 'typography_number_font_size', { unit: 'px', size: 40, sizes: [] }, 'the size of the number');
want('counter', 'title_position', 'before', 'the title above the number');

want('progress', 'progress_type', 'success', 'the bar type');
want('progress', 'bar_color', '#0C4A60', 'the colour of the fill');
want('progress', 'bar_height', { unit: 'px', size: 18, sizes: [] }, 'how tall the bar is');
want('progress', 'display_percentage', 'show', "Elementor stores this one as 'show', not 'yes'");
want('progress', 'inner_text', 'on track', 'the words inside the bar');

want('star-rating', 'rating', 4.5, 'how many marks are filled');
want('star-rating', 'stars_color', '#F59E0B', 'the colour of the marks');
want('star-rating', 'icon_space', { unit: 'px', size: 4, sizes: [] }, 'the gap between marks');
want('star-rating', 'title', 'Our reviews', 'the legacy widget keeps the title');

want('nested-tabs', 'tabs', [
  { _id: 't0', tab_title: 'Commercial' }, { _id: 't1', tab_title: 'Residential' },
], 'the tab titles');
want('nested-tabs', 'tabs_title_background_color_background', 'classic', 'without this the colour is ignored');
want('nested-tabs', 'title_text_color_active', '#0C4A60', 'the open tab colour');
want('nested-tabs', 'box_padding',
  { unit: 'px', top: '16', right: '16', bottom: '16', left: '16', isLinked: true }, 'the panel padding');

want('nested-accordion', 'items', [
  { _id: 'a0', item_title: 'When do you come out?' }, { _id: 'a1', item_title: 'Do you salt?' },
], "Elementor's own key names for the rows");
want('nested-accordion', 'faq_schema', 'yes', 'the search-engine mark-up switch');
want('nested-accordion', 'default_state', 'all_collapsed', 'what a visitor sees first');
want('nested-accordion', 'accordion_item_title_icon_position', 'end', 'which side the + sits on');

/* ── THE CHILDREN OF A NESTED ELEMENT ────────────────────────────────────── */
for (const [type, titles] of [
  ['nested-tabs', ['Commercial', 'Residential']],
  ['nested-accordion', ['When do you come out?', 'Do you salt?']],
]) {
  const w = byType(type);
  if (!w) continue;
  const kids = w.elements || [];
  if (kids.length !== titles.length) {
    fails.push(`${type}: sent ${titles.length} child containers, the site gave back ${kids.length} — a panel with no container cannot be opened`);
    continue;
  }
  kids.forEach((box, i) => {
    if (box.elType !== 'container') fails.push(`${type}: child ${i} came back as ${box.elType}, not a container`);
    if (box.settings?._title !== titles[i]) {
      fails.push(`${type}: child ${i} lost its title — sent "${titles[i]}", got "${box.settings?._title}"`);
    }
    const inner = (box.elements || [])[0];
    if (!inner || inner.widgetType !== 'text-editor') {
      fails.push(`${type}: child ${i} lost the words inside it`);
    }
  });
  console.log(`${type}: ${kids.length} child containers came back, titled ${kids.map((k) => JSON.stringify(k.settings?._title)).join(', ')}`);
}

if (fails.length) {
  console.error('\nTHE SITE DID NOT KEEP THESE:\n  ' + fails.join('\n  '));
  process.exit(1);
}
console.log(`\nEvery setting on all five came back off http://localhost:8084/?page_id=${page.page_id}`);
