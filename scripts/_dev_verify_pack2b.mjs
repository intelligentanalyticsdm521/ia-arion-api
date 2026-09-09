#!/usr/bin/env node
/**
 * _dev_verify_pack2b.mjs — the list-item binding form, proved on a real page
 * of the dev website.
 *
 * The unit tests hold the arithmetic. This holds the thing they cannot: that a
 * hand-drawn curated layout, added the way a client adds one, reaches a real
 * WordPress page, RENDERS the business's own words on it, can be edited and
 * put back, and reads the same through the plugin's own eyes as it does
 * through ours.
 *
 * It asserts on the CONTENT COMING BACK and on the RENDERED PAGE, not on the
 * absence of an error (memory: feedback_assert_presence_not_just_absence), it
 * BREAKS THINGS ON PURPOSE, and it puts the page back the way it found it —
 * and then proves, byte for byte, that it did.
 *
 * ⚠ Dev only. Loopback hosts only. Needs:
 *   - the dev WordPress container on the pack 2b plugin (>= 1.7.5):
 *       dev-stack\start-dev-wp.ps1 -PluginDir C:\dev\iadm\ia-plugin-septa-arion2b
 *   - arion-api from THIS worktree with DEV_AUTH=1 on the given port
 *       PORT=4047 node index.js
 *
 *   node scripts/_dev_verify_pack2b.mjs [--api http://localhost:4047]
 */

import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const API = arg('api', 'http://localhost:4047');
const WP = arg('wp', 'http://localhost:8084');
const TENANT = arg('tenant', 'a0000001-0000-0000-0000-000000000001');
const SITE = arg('site', 'e68a46ae-b5ee-441d-a71c-2afeca12a658');
const PAGE = Number(arg('page', '89'));   // "Our workshop" — a published fixture page
const TOKEN_FILE = arg('token-file', 'C:\\dev\\iadm\\dev-stack\\wordpress\\.site-token');

const loopback = (u) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(u);
if (!loopback(API) || !loopback(WP)) {
  console.error('Refusing to run against anything but the local dev stack.');
  process.exit(1);
}

const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

let pass = 0;
let fail = 0;
const check = (n, ok, d = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` — ${String(d).slice(0, 300)}` : ''}`); }
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      'x-dev-tenant': TENANT,
      Authorization: 'Bearer dev',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
}

/** The plugin, directly, on the site token — its own eyes on the same page. */
async function plugin(path) {
  const res = await fetch(`${WP}/wp-json/intelligent-analytics/v1${path}${path.includes('?') ? '&' : '?'}_cb=${Date.now()}`, {
    headers: { Accept: 'application/json', 'X-Arion-Site-Token': TOKEN },
  });
  const text = await res.text();
  try { return { status: res.status, json: text ? JSON.parse(text) : null }; } catch { return { status: res.status, json: null }; }
}

const base = `/arion/sites/${SITE}`;
const savePayload = (sections) => ({
  sections: sections.map((s) => (
    s.editable
      ? { handle: s.handle, kind: s.kind, fields: s.fields, node: s.node }
      : { handle: s.handle, node: s.node }
  )),
});

console.log(`\n=== ARION pack 2b — the list-item binding form, on ${WP} page ${PAGE} ===\n`);

/* ══════════════════ 0. the page as we found it ═══════════════════════════ */

const status = await plugin('/status');
check('the dev website is running the pack 2b plugin',
  status.json?.data?.plugin_version >= '1.7.5', `plugin ${status.json?.data?.plugin_version}`);

const before = await api(`${base}/pages/${PAGE}/sections`);
check('the page reads', before.status === 200 && Array.isArray(before.json?.data?.sections), before.text);
const ORIGINAL = before.json.data.sections;
const ORIGINAL_JSON = JSON.stringify(ORIGINAL.map((s) => s.node));
const ORIGINAL_STATUS = before.json.data.status;
console.log(`  (page "${before.json.data.title}", ${ORIGINAL.length} sections, ${ORIGINAL_STATUS})`);

/* ══════════════════ 1. what the picker now offers ════════════════════════ */

console.log('\n-- the picker --');
const lib = await api(`${base}/section-library`);
check('the picker answers', lib.status === 200, lib.text.slice(0, 200));
const byKind = Object.fromEntries((lib.json?.data?.sections || []).map((c) => [c.kind, (c.variants || []).length]));
for (const [kind, want] of [['pricing', 9], ['team', 9], ['stats', 7], ['testimonials', 5]]) {
  check(`${kind}: ${want} ready-made layouts on offer (was 0)`, byKind[kind] === want, `got ${byKind[kind]}`);
}
check('and the six that already worked are untouched',
  byKind.hero === 7 && byKind.services === 7 && byKind.cta === 9
  && byKind.about === 8 && byKind.faq === 5 && byKind.contact === 8,
  JSON.stringify(byKind));

/* ══════════════════ 2. one of each, built for THIS business ══════════════ */

console.log('\n-- building one of each --');
const WANT = {
  pricing: 'pricing.3col-cards.v1',
  team: 'team.3col-cards.v1',
  stats: 'stats.4col.v1',
  testimonials: 'testimonials.3col-cards.v1',
};
const built = {};
for (const [kind, blueprintId] of Object.entries(WANT)) {
  const res = await api(`${base}/sections`, { method: 'POST', body: { blueprintId } });
  const sec = res.json?.data?.section;
  built[kind] = sec;
  check(`${blueprintId} builds and is editable`, res.status === 201 && sec?.editable === true,
    `${res.status} ${res.text.slice(0, 200)}`);
  check(`...and the editor knows which boxes ${kind} can keep`,
    !!sec?.itemFields && Object.keys(sec.itemFields).length === 1, JSON.stringify(sec?.itemFields));
}

/* the one price source */
const plans = built.pricing?.fields?.plans || [];
check('the price cards carry the business\u2019s OWN services', plans.length >= 2
  && plans.every((p) => p.name && p.offering_id), JSON.stringify(plans.map((p) => p.name)));
check('...with the prices from the catalogue, not the library\u2019s samples',
  plans.every((p) => /^\$\d/.test(p.price)) && !/\$0\b|\$49\b|\$149\b/.test(JSON.stringify(built.pricing.node)),
  JSON.stringify(plans.map((p) => `${p.name} ${p.price}`)));
check('...and every card knows WHICH service it is, so a price is never matched on a name',
  new Set(plans.map((p) => p.offering_id)).size === plans.length);
check('...and the button goes to the real booking page',
  plans.every((p) => /^https?:\/\//.test(p.cta_href)), plans[0]?.cta_href);

/* nothing of the vendor's, and nothing to type that goes nowhere */
for (const [kind, sec] of Object.entries(built)) {
  check(`no vendor placeholder picture on the ${kind} layout`,
    !/plugins\/elementor\/assets\/images\/placeholder/.test(JSON.stringify(sec.node)));
}
check('a hand-drawn quote card offers no star rating, because it has nowhere to put one',
  !built.testimonials.itemFields.testimonials.includes('rating'),
  JSON.stringify(built.testimonials.itemFields));
check('a hand-drawn number splits into the number and what is around it',
  (built.stats.fields.stats || []).some((s) => s.suffix === '+' || s.suffix === '%'),
  JSON.stringify(built.stats.fields.stats));

/* ══════════════════ 3. on the page, published, rendered ══════════════════ */

console.log('\n-- published and rendered --');
const withNew = [...ORIGINAL, ...Object.values(built)];
const saved = await api(`${base}/pages/${PAGE}/sections`, {
  method: 'PUT',
  body: { ...savePayload(withNew), status: 'publish' },
});
check('the page saves with all four on it', saved.status === 200, saved.text.slice(0, 300));

const readBack = await api(`${base}/pages/${PAGE}/sections`);
const now = readBack.json?.data?.sections || [];
check('...and reads back with four more sections', now.length === ORIGINAL.length + 4,
  `${now.length} vs ${ORIGINAL.length}`);
for (const kind of Object.keys(WANT)) {
  const row = now.find((s) => s.kind === kind && s.blueprintId === WANT[kind]);
  check(`the ${kind} section is still editable after a round trip through WordPress`,
    !!row && row.editable === true, row ? row.reason : 'not found');
}
const savedPricing = now.find((s) => s.kind === 'pricing');
check('...and its prices came back off the website unchanged',
  JSON.stringify(savedPricing?.fields?.plans) === JSON.stringify(plans),
  JSON.stringify(savedPricing?.fields?.plans || []).slice(0, 200));

const html = await (await fetch(`${WP}/?page_id=${PAGE}&_cb=${Date.now()}`)).text();
check('the price RENDERS on the page', html.includes(plans[0].price) && html.includes(plans[0].name),
  `looking for "${plans[0].name}" and "${plans[0].price}"`);
check('a person RENDERS on the page', html.includes(built.team.fields.members[0].name));
check('a number RENDERS on the page',
  html.includes(built.stats.fields.stats[0].value + built.stats.fields.stats[0].suffix));
check('a quote RENDERS on the page',
  html.includes(built.testimonials.fields.testimonials[0].quote.slice(2, 40)));
check('and none of our own plumbing reaches the page',
  !html.includes('_ia_role') && !html.includes('_ia_offering') && !html.includes('_ia_field'));

/* ══════════════════ 4. the plugin's own eyes on the same page ════════════ */

console.log('\n-- the PHP mirror --');
const pluginPage = await plugin(`/pages/${PAGE}/sections`);
// The plugin answers FLAT — `sections` sits beside `page_id`, with no `data`
// wrapper. Reading it as `.data.sections` gives an empty array, every row
// compares against `undefined`, and the loop below skips every one of them and
// reports the mirror perfect. Found exactly that way, on this script's first
// run: it went green over a comparison it had never made.
const pluginRows = pluginPage.json?.sections || [];
check('the plugin answers with a row per section, so there is something to compare',
  pluginRows.length === now.length, `plugin ${pluginRows.length} vs arion ${now.length}`);
let mirrorOk = pluginRows.length === now.length;
const mirrorDetail = [];
let compared = 0;
for (const [i, ours] of now.entries()) {
  if (!ours.editable) continue;
  compared += 1;
  const theirs = pluginRows[i];
  const a = JSON.stringify(ours.fields);
  const b = JSON.stringify(theirs?.fields);
  if (a !== b) { mirrorOk = false; mirrorDetail.push(`#${i} (${ours.kind}) arion=${a.slice(0, 120)} plugin=${b?.slice(0, 120)}`); }
}
check('the plugin reads every field exactly as arion-api does — cards included',
  mirrorOk && compared >= 4, `compared ${compared}: ${mirrorDetail.join(' | ')}`);

/* ══════════════════ 5. edit one field, then put it back ══════════════════ */

console.log('\n-- edit, and Undo --');
const edited = now.map((s) => (
  s.kind === 'pricing'
    ? { ...s, fields: { ...s.fields, plans: s.fields.plans.map((p, i) => (i === 0 ? { ...p, price: '$999' } : p)) } }
    : s
));
const savedEdit = await api(`${base}/pages/${PAGE}/sections`, { method: 'PUT', body: savePayload(edited) });
check('a single price can be changed and saved', savedEdit.status === 200, savedEdit.text.slice(0, 200));

const afterEdit = await api(`${base}/pages/${PAGE}/sections`);
const editedPricing = (afterEdit.json?.data?.sections || []).find((s) => s.kind === 'pricing');
check('...the new price is what the page says now', editedPricing?.fields?.plans?.[0]?.price === '$999',
  editedPricing?.fields?.plans?.[0]?.price);
check('...and the other two cards did not move',
  JSON.stringify(editedPricing?.fields?.plans?.slice(1)) === JSON.stringify(plans.slice(1)));
const editedHtml = await (await fetch(`${WP}/?page_id=${PAGE}&_cb=${Date.now()}`)).text();
check('...and the website shows it', editedHtml.includes('$999'));

const undo = await api(`${base}/pages/${PAGE}/undo`, { method: 'POST' });
check('Undo answers', undo.status === 200, undo.text.slice(0, 200));
const afterUndo = await api(`${base}/pages/${PAGE}/sections`);
const undonePricing = (afterUndo.json?.data?.sections || []).find((s) => s.kind === 'pricing');
check('...and one tap puts the old price back',
  undonePricing?.fields?.plans?.[0]?.price === plans[0].price, undonePricing?.fields?.plans?.[0]?.price);

/* ══════════════════ 6. "check this", live ════════════════════════════════ */

console.log('\n-- the one tap behind "check this" --');
const ambiguous = await api(`${base}/sections`, { method: 'POST', body: { blueprintId: 'pricing.2col-simple.v1' } });
const amb = ambiguous.json?.data?.section;
check('a layout whose cards do not say which heading is the price says so',
  Array.isArray(amb?.roleReview) && amb.roleReview.some((r) => r.roles.includes('price')),
  JSON.stringify(amb?.roleReview));
check('...in a sentence, naming the boxes the client can see',
  amb?.roleReview?.[0]?.why?.length > 20 && amb.roleReview[0].fields.length >= 2,
  JSON.stringify(amb?.roleReview?.[0]));

const swap = await api(`${base}/sections/roles/swap`, {
  method: 'POST',
  body: { kind: 'pricing', list: 'plans', roles: ['name', 'price'], node: amb.node },
});
check('one tap swaps them over', swap.status === 200 && swap.json?.data?.swapped === 2,
  `${swap.status} ${swap.text.slice(0, 200)}`);
const swappedSec = swap.json?.data?.section;
check('...on every card, not just the first',
  swappedSec?.fields?.plans?.every((p, i) => p.name === amb.fields.plans[i].price),
  JSON.stringify(swappedSec?.fields?.plans?.map((p) => p.name)));
check('...and that question is not asked twice',
  !(swappedSec?.roleReview || []).some((r) => r.roles.includes('price')),
  JSON.stringify(swappedSec?.roleReview));

const badSwap = await api(`${base}/sections/roles/swap`, {
  method: 'POST',
  body: { kind: 'pricing', list: 'plans', roles: ['name', 'cta'], node: amb.node },
});
check('two things that are not two of the same are refused, not swapped anyway',
  badSwap.status === 400, `status ${badSwap.status}`);
const noNode = await api(`${base}/sections/roles/swap`, {
  method: 'POST', body: { kind: 'pricing', list: 'plans', roles: ['name', 'price'] },
});
check('a swap with no section is refused rather than reported done', noNode.status === 400);

/* ══════════════════ 7. broken on purpose, live ═══════════════════════════ */

console.log('\n-- refused on purpose --');
const notOffered = await api(`${base}/sections`, { method: 'POST', body: { blueprintId: 'pricing.single-callout.v1' } });
check('a layout the editor cannot look after is still refused, with its reason',
  notOffered.status === 400 && /button|list/i.test(String(notOffered.json?.error?.message || '')),
  `${notOffered.status} ${String(notOffered.json?.error?.message || '').slice(0, 160)}`);
const noStatsHeadline = await api(`${base}/sections`, { method: 'POST', body: { blueprintId: 'stats.minimal-row.v1' } });
check('...and so is one whose every heading belongs to a card',
  noStatsHeadline.status === 400 && /nowhere to put the section/i.test(String(noStatsHeadline.json?.error?.message || '')),
  String(noStatsHeadline.json?.error?.message || '').slice(0, 200));

/* ══════════════════ 8. put the page back, and prove it ═══════════════════ */

console.log('\n-- putting the page back --');
const restore = await api(`${base}/pages/${PAGE}/sections`, {
  method: 'PUT',
  body: { ...savePayload(ORIGINAL), status: ORIGINAL_STATUS },
});
check('the page is written back the way it was found', restore.status === 200, restore.text.slice(0, 200));
const final = await api(`${base}/pages/${PAGE}/sections`);
const finalSections = final.json?.data?.sections || [];
check('...same number of sections', finalSections.length === ORIGINAL.length,
  `${finalSections.length} vs ${ORIGINAL.length}`);
check('...and byte for byte the tree it started with',
  JSON.stringify(finalSections.map((s) => s.node)) === ORIGINAL_JSON);
const finalHtml = await (await fetch(`${WP}/?page_id=${PAGE}&_cb=${Date.now()}`)).text();
check('...and nothing this script wrote is on the website any more',
  !finalHtml.includes('$999') && !finalHtml.includes(plans[0].name));

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
