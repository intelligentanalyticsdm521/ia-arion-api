/**
 * Publish a THREE-DEEP container page to the dev WordPress, read it back, and
 * prove the tree survived.
 *
 *   node scripts/dev/tree-roundtrip-dev-wp.mjs            # Standard plan
 *   node scripts/dev/tree-roundtrip-dev-wp.mjs --lite     # ARION Lite
 *
 * D-156 stream D. A unit test proves our emitter produces the tree we meant;
 * it cannot prove the WEBSITE kept it. The page engine's own writer, its
 * sanitiser and its renderer are all between us and the visitor, and the only
 * way to know a level of nesting is not being flattened on the way in is to
 * push a page through the plugin and read `_elementor_data` back off the site.
 *
 * Nothing here is a test double. It writes to the dev fixture site on
 * localhost:8084 and to nothing else — the connection details come from
 * `dev-stack/wordpress/.site-id` and `.site-token`, which only that fixture
 * has (memory: feedback_no_real_client_data_in_dev).
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

import {
  writePageSections, fetchPages, fetchPageSections, createPage,
} from '../../lib/websiteBuilder/pageClient.js';
import {
  pageToElementor, elementorToPage, outline, documentToTree,
} from '../../lib/websiteBuilder/elementorTree.js';

const DEV = 'C:/dev/iadm/dev-stack/wordpress';
const site = {
  site_id: readFileSync(`${DEV}/.site-id`, 'utf8').trim(),
  domain: 'localhost:8084',
  site_token_raw: readFileSync(`${DEV}/.site-token`, 'utf8').trim(),
};

const lite = process.argv.includes('--lite');
const ctx = { allowPro: !lite, iaWidgets: [], seed: 'drive-2026-09-17' };

/* THE PAGE - Brandon's sentence, three containers deep, and it starts as the
 * PORTAL'S OWN DOCUMENT.
 *
 * D-156 conformance (audit point 1). The drive used to start from a tree typed
 * by hand, which skipped `documentToTree` - the very reader that was dropping
 * `alignItems`, `wrap` and `props.html_tag` on the way to a website. So the
 * page now starts where a real publish starts: a `BuilderDocument` whose box
 * keeps its layout in `style`, exactly as the builder saves it.
 *
 * The row says three things the author can set and the website never used to
 * hear: line them up in the MIDDLE across the row, let them WRAP onto a second
 * line, and draw the box as a `section`.                                      */
const DOC = {
  v: 2,
  settings: {},
  sections: [{
    id: 'drive-sec',
    label: 'Choose your plan',
    layout: 1,
    style: { padding: { top: 64, right: 20, bottom: 64, left: 20 }, background: '#F4F7F8' },
    columns: [{
      id: 'drive-col',
      widgets: [
        { id: 'drive-h', kind: 'heading', props: { text: 'Choose your plan', level: 'h2', align: 'center' } },
        { id: 'drive-p', kind: 'paragraph', props: { text: 'Pick one', align: 'center' } },
        {
          id: 'drive-row',
          kind: 'container',
          props: { html_tag: 'section' },
          style: { direction: 'row', alignItems: 'center', wrap: true, gap: 24 },
          children: [
            {
              id: 'drive-boxa',
              kind: 'container',
              props: {},
              style: { direction: 'column' },
              children: [{
                id: 'drive-card-a',
                kind: 'card',
                props: {
                  heading: 'Garden tidy', price: '120', period: 'month',
                  currency_symbol: 'pound',
                  description: 'Every fortnight, April to October.',
                  features_list: [{ item_text: 'Lawn cut' }, { item_text: 'Edges done' }],
                  button_text: 'Choose this',
                  show_ribbon: true, ribbon_preset: 'recommended',
                },
              }],
            },
            {
              id: 'drive-boxb',
              kind: 'container',
              props: {},
              style: { direction: 'column' },
              children: [{
                id: 'drive-card-b',
                kind: 'catalog_card',
                props: {
                  _ia_source: 'oliver:catalogue',
                  _ia_selection: { offering_id: 'svc-441', price_id: 'pr-441' },
                  refresh: 'live',
                  on_empty: 'placeholder',
                  overrides: { heading: 'Full maintenance', button_text: 'Choose this' },
                  _ia_snapshot: { heading: 'Full maintenance', price: '240', period: 'month' },
                },
              }],
            },
          ],
        },
      ],
    }],
  }],
};

const TREE = documentToTree(DOC);

function depthOf(node, d = 0) {
  const kids = node.elements || [];
  return kids.length ? Math.max(...kids.map((c) => depthOf(c, d + 1))) : d;
}

const { data, swapped } = pageToElementor(TREE, ctx);
console.log(`plan: ${lite ? 'ARION Lite' : 'ARION Standard'}`);
console.log('sending:');
console.log(outline(TREE[0]).join('\n'));
if (swapped.length) console.log('swapped for the plan:', swapped.map((s) => `${s.nodeId}=${s.kind}`).join(', '));

/* ITS OWN PAGE, never somebody else's.
 * The fixture's Home and Contact are what the other streams walk; a drive that
 * overwrites them costs somebody else an hour. */
const TITLE = 'D-156 container check';
const pages = await fetchPages(site);
if (!pages.ok) { console.error('could not list pages:', pages); process.exit(1); }
const list = pages.data?.pages || [];
let page = list.find((p) => p.title === TITLE);
if (!page) {
  const made = await createPage(site, { title: TITLE, type: 'page', sections: [] });
  if (!made.ok || !made.data?.page_id) { console.error('could not create the page:', made); process.exit(1); }
  page = { page_id: made.data.page_id, title: TITLE };
}
console.log(`page: ${page.title} (${page.page_id})`);

// The plugin takes `[{ node }]`, the same envelope every save in the product
// uses — the node itself is our container, verbatim.
const wrote = await writePageSections(site, page.page_id, {
  sections: data.map((node) => ({ node })), status: "publish",
});
if (!wrote.ok || wrote.data?.success === false) { console.error('write refused:', wrote); process.exit(1); }
console.log('written:', JSON.stringify(wrote.data).slice(0, 220));

// Read it back off the WEBSITE — not out of our own memory. The plugin hands
// back the page's whole `_elementor_data` beside its reduced section list, and
// the RAW tree is the one that matters here: the reduction deliberately says
// nothing about depth.
const read = await fetchPageSections(site, page.page_id);
if (!read.ok) { console.error('read-back refused:', read); process.exit(1); }
const live = typeof read.data?.elementor_data === 'string'
  ? JSON.parse(read.data.elementor_data)
  : (read.data?.elementor_data || []);
console.log('the website reduced it to:',
  JSON.stringify((read.data?.sections || []).map((x) => ({ handle: x.handle, widgets: x.widget_types }))));

const tree = elementorToPage(live);
const mine = tree.filter((n) => String(n.id || '').startsWith('drive-'));
console.log('read back:');
console.log(mine.map((n) => outline(n).join('\n')).join('\n'));

assert.equal(mine.length, 1, 'our section came back exactly once');

/* THE THREE THINGS THE WEBSITE USED TO NEVER HEAR (audit point 1).
 * Read off what the SITE gave back, not off what we sent: the plugin, the page
 * engine's own writer and its sanitiser are all in between. */
const liveRow = (function findRow(nodes) {
  for (const n of nodes || []) {
    if (n?.settings?._ia_node === 'drive-row') return n;
    const deeper = findRow(n?.elements);
    if (deeper) return deeper;
  }
  return null;
}(live));
assert.ok(liveRow, 'the row never came back off the site');
console.log('the row came back as:', JSON.stringify({
  flex_direction: liveRow.settings.flex_direction,
  flex_align_items: liveRow.settings.flex_align_items,
  flex_wrap: liveRow.settings.flex_wrap,
  html_tag: liveRow.settings.html_tag,
  flex_direction_mobile: liveRow.settings.flex_direction_mobile,
}));
assert.equal(liveRow.settings.flex_align_items, 'center', 'the Align items the author set did not survive');
assert.equal(liveRow.settings.flex_wrap, 'wrap', 'the Wrap the author set did not survive');
assert.equal(liveRow.settings.html_tag, 'section', 'the tag the box is drawn as did not survive');
assert.equal(liveRow.settings.flex_direction_mobile, 'column', 'the row does not stack on a phone');
// ...and the tree reader says the same thing back in our own words.
const readRow = (function findOurs(nodes) {
  for (const n of nodes || []) {
    if (n?.id === 'drive-row') return n;
    const deeper = findOurs(n?.children);
    if (deeper) return deeper;
  }
  return null;
}(mine));
assert.equal(readRow?.align, 'center');
assert.equal(readRow?.wrap, 'wrap');
assert.equal(readRow?.htmlTag, 'section');
console.log('align items, wrap and the tag all survived the round trip.');
assert.ok(depthOf(live.find((n) => n.settings?._ia_node === 'drive-sec')) >= 3,
  'the page came back flatter than it went in');
assert.deepEqual(outline(mine[0]).map((l) => l.replace(/\(.*\)/, '')).slice(0, 4),
  ['container', '  widget', '  widget', '  container'],
  'the shape changed on the way through the website');
console.log('\nOK — three levels of containers survived the round trip.');

/* AND THE PAGE A VISITOR SEES.
 * The tree surviving the write proves nothing about the render: the paid card
 * widget WRITES fine on a website that cannot DRAW it, and the visitor gets an
 * empty box — measured here on 2026-09-17, when the Standard run put 22 `e-con`
 * wrappers and not one word of the card on the page. So the words are asserted
 * on the live HTML, not only in the JSON
 * (`feedback_assert_presence_not_just_absence`).
 */
const permalink = wrote.data?.permalink;
const pageHtml = await (await fetch(permalink)).text();
const containers = (pageHtml.match(/e-con/g) || []).length;
console.log(`live page: ${permalink} — ${containers} container wrappers`);
assert.ok(containers >= 4, 'the live page is not drawn with containers');
assert.match(pageHtml, /Choose your plan/, 'the heading never reached the visitor');
if (lite) {
  for (const word of ['Garden tidy', '120', 'Lawn cut', 'Edges done', 'Full maintenance', 'Recommended']) {
    assert.ok(pageHtml.includes(word), `"${word}" never reached the visitor`);
  }
  console.log('every word of both cards is on the live page.');
} else {
  console.log('NOTE: this website has no paid add-on, so the paid card widget writes '
    + 'but does not draw. Run with --lite to see the words a Lite business gets.');
}
