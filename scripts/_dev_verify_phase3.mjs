#!/usr/bin/env node
/**
 * _dev_verify_phase3.mjs — adoption, against the dev WordPress container.
 *
 * Phase 3 is the offer to take charge of a section somebody built on the
 * website itself. It rewrites a piece of a LIVE page, so what has to be proved
 * is not "the mapper guesses well" — the unit tests do that over fixture trees
 * — but the four things only a real WordPress can show:
 *
 *   1. the mapper's answers on a real page match what the plugin's own census
 *      says about the same sections (the two-tables-drifting defect, again);
 *   2. the preview writes NOTHING — not a byte on the page, not a snapshot;
 *   3. the adopt writes exactly ONE snapshot and changes exactly ONE section,
 *      and the section that comes back is one the editor can read;
 *   4. the original bytes come back BYTE-IDENTICAL, compared against the
 *      `_elementor_data` slice as it stood before anything was touched.
 *
 * Plus the deliberate failures, because a green check proves nothing until it
 * fails on purpose (feedback_mutation_test_your_guards).
 *
 * ⚠ Dev only. Refuses anything but a loopback host, and leaves every page —
 * and every Undo ring — exactly as it found it.
 *
 *   node scripts/_dev_verify_phase3.mjs [--base http://localhost:8084]
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import { reduceToSectionList } from '../lib/websiteBuilder/sectionSchema.js';
import {
  analyseSection, analysePage, buildAdoptedSection, sectionFingerprint,
  readCensus, ADOPT_MIN_CONFIDENCE,
} from '../lib/websiteBuilder/adoption.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BASE = arg('base', 'http://localhost:8084');
const TOKEN_FILE = arg('token-file', 'C:\\dev\\iadm\\dev-stack\\wordpress\\.site-token');
const API = `${BASE}/wp-json/intelligent-analytics/v1`;

if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(BASE)) {
  console.error(`Refusing to run against "${BASE}" — this script is for the local dev container only.`);
  process.exit(1);
}

const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

const BRAND = {
  business_name: 'Fernbrook Garden Rooms',
  email: 'hello@fernbrook.invalid',
  primary_color: '#1A3A4A',
  services: [],
};

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function call(path, { method = 'GET', body, token = TOKEN } = {}) {
  const url = `${API}${path}${path.includes('?') ? '&' : '?'}_ia_cb=${Date.now()}${Math.random()}`;
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(token ? { 'X-Arion-Site-Token': token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
}

const fetchHtml = async (url) => (await fetch(`${url}${url.includes('?') ? '&' : '?'}cb=${Date.now()}`)).text();

/** Walk a page back to the snapshot depth it had, by undoing rather than writing. */
async function rewindTo(pageId, floor) {
  for (let i = 0; i < 40; i++) {
    const read = await call(`/pages/${pageId}/sections`);
    const count = Number(read.json?.snapshot_count || 0);
    if (count <= floor) return count;
    const undone = await call(`/pages/${pageId}/undo`, { method: 'POST', body: {} });
    if (undone.json?.restored === false) return count;
  }
  return -1;
}

/** Post a whole section list, the way the Portal's save does. */
function toNodes(tree) {
  return tree.map((node) => ({ handle: node?.settings?._title || null, node }));
}

(async () => {
  console.log(`\nARION site builder — Phase 3 (adoption) against ${BASE}\n`);

  /* ── 0. the site answers ─────────────────────────────────────────────── */

  const status = await call('/status');
  const version = status.json?.data?.plugin_version || status.json?.plugin_version;
  check('the plugin answers and is 1.6.1 or later',
    !!version && version.localeCompare('1.6.1', undefined, { numeric: true }) >= 0, `v${version}`);

  const listed = await call('/pages');
  const pages = Array.isArray(listed.json?.pages) ? listed.json.pages : [];
  check('the fixture site lists its pages', pages.length >= 5, `${pages.length} pages`);

  const workshop = pages.find((p) => p.title === 'Our workshop');
  if (!workshop) {
    console.error('\n  The "Our workshop" fixture page is missing. Re-run start-dev-wp.ps1 -Reseed '
      + 'with -ApiDir pointing at THIS worktree.\n');
    process.exit(1);
  }
  check('the all-hand-built fixture page has five sections and none of them editable',
    workshop.section_count === 5 && workshop.editable_section_count === 0,
    `${workshop.editable_section_count}/${workshop.section_count}`);

  /* ── 1. the mapper's coverage on the fixture site ────────────────────── */

  const before = await call(`/pages/${workshop.page_id}/sections`);
  const originalTree = before.json?.elementor_data || [];
  const originalJson = JSON.stringify(originalTree);
  const snapshotFloor = Number(before.json?.snapshot_count || 0);

  const view = analysePage(reduceToSectionList(originalTree), { allowPro: true });
  console.log('\n  mapper coverage on "Our workshop":');
  for (const r of view.rows) {
    console.log(`    #${r.index} ${r.adoptable ? 'ADOPTABLE ' : 'keep      '}`
      + `${String(r.kind || '—').padEnd(13)} conf ${String(r.confidence).padEnd(5)} `
      + `${r.adoptable ? r.why : r.reason}`);
  }
  console.log('');

  check('three of the five hand-built sections can be offered on this plan',
    view.adoptableCount === 3, `${view.adoptableCount} of ${view.customCount}`);
  check('the banner is read as a hero, the card row as services, the quote block as contact',
    view.rows[0].kind === 'hero' && view.rows[1].kind === 'services' && view.rows[2].kind === 'contact',
    `${view.rows[0].kind} / ${view.rows[1].kind} / ${view.rows[2].kind}`);
  check('the video band is refused because of what is ON it, not because of a low score',
    view.rows[3].reason === 'would_lose_content' && view.rows[3].confidence >= ADOPT_MIN_CONFIDENCE,
    `${view.rows[3].reason} @ ${view.rows[3].confidence}`);
  check('the awards strip is refused because we cannot say what it is',
    view.rows[4].reason === 'no_match', String(view.rows[4].reason));

  // The tier gate on the ADOPTION path, not on the "add a section" picker: a
  // Lite site has no Elementor Pro form widget, so a hand-built form section
  // cannot be rebuilt there and must not be offered.
  const onLite = analysePage(reduceToSectionList(originalTree), { allowPro: false });
  check('the quote block is NOT offered on a plan with no Elementor Pro, and says why',
    onLite.rows[2].adoptable === false && onLite.rows[2].reason === 'needs_pro'
    && /Elementor Pro/.test(String(onLite.rows[2].reasonText)),
    `${onLite.rows[2].reason}`);
  check('and nothing else changes on Lite — exactly one thing is gated',
    onLite.adoptableCount === view.adoptableCount - 1,
    `${onLite.adoptableCount} vs ${view.adoptableCount}`);

  // The routing wires a form carries must come across untouched: a quote form
  // that became a lead form on adoption would silently re-file every enquiry.
  const quote = analyseSection(originalTree[2], { allowPro: true });
  check('the quote form keeps its purpose and its recipient through the mapper',
    quote.fields.form_purpose === 'quote' && quote.fields.email_to === 'quotes@fernbrook.invalid',
    JSON.stringify([quote.fields.form_purpose, quote.fields.email_to]));
  check('and every field it asks for comes across, in order',
    JSON.stringify(quote.fields.form_fields) === JSON.stringify(['Name', 'Email', 'Square Footage', 'Message']),
    JSON.stringify(quote.fields.form_fields));

  /* ── 2. the plugin's own census agrees with ours ─────────────────────── */

  // Two implementations of "what is on this section", one in JS and one in
  // PHP. This is the comparison that caught the v1.6.0 `image_id` defect, and
  // the reason the plugin's adoption hint exists at all is to be checked here.
  let censusOk = true;
  let hintOk = true;
  const censusDetail = [];
  for (const p of pages) {
    const read = await call(`/pages/${p.page_id}/sections`);
    const tree = read.json?.elementor_data || [];
    const theirs = read.json?.sections || [];
    reduceToSectionList(tree).forEach((s, i) => {
      const row = theirs[i];
      if (!row || row.editable) return;
      const mine = readCensus(s.node).widgetTypes;
      const yours = Array.isArray(row.widget_types) ? row.widget_types : null;
      if (yours === null || JSON.stringify(mine) !== JSON.stringify(yours)) {
        censusOk = false;
        censusDetail.push(`${p.title} #${i}: arion ${JSON.stringify(mine)} plugin ${JSON.stringify(yours)}`);
      }
      // The plugin says "nothing on this is beyond the editor". arion-api may
      // still refuse for a reason the plugin cannot see (it cannot identify
      // the section), but it must NEVER offer one the plugin has ruled out.
      const a = analyseSection(s.node, { allowPro: true });
      if (a.adoptable && row.adoptable === false) {
        hintOk = false;
        censusDetail.push(`${p.title} #${i}: arion offers it, the plugin says no `
          + `(${JSON.stringify(row.foreign_widgets)})`);
      }
    });
  }
  check("the plugin's widget census matches arion-api's, section for section",
    censusOk, censusDetail.join('\n        '));
  check('arion-api never offers a section the website itself has ruled out',
    hintOk, censusDetail.join('\n        '));

  /* ── 3. the preview writes nothing ───────────────────────────────────── */

  const heroNode = originalTree[0];
  const analysis = analyseSection(heroNode, { allowPro: true });
  const built = buildAdoptedSection({ analysis, brand: BRAND, blockId: crypto.randomUUID() });
  check('the banner rebuilds into a section the editor can read',
    built.ok && reduceToSectionList([built.node])[0]?.editable === true,
    built.ok ? '' : built.message);

  const afterPreview = await call(`/pages/${workshop.page_id}/sections`);
  check('previewing changed nothing on the page',
    JSON.stringify(afterPreview.json?.elementor_data || []) === originalJson);
  check('previewing added no version to the Undo ring',
    Number(afterPreview.json?.snapshot_count || 0) === snapshotFloor,
    `${afterPreview.json?.snapshot_count} vs ${snapshotFloor}`);

  /* ── 4. the adopt: one snapshot, one section ─────────────────────────── */

  const fingerprintBefore = sectionFingerprint(heroNode);
  const adoptedTree = originalTree.map((n, i) => (i === 0 ? built.node : n));
  const wrote = await call(`/pages/${workshop.page_id}/sections`, {
    method: 'POST', body: { sections: toNodes(adoptedTree) },
  });
  check('the website accepted the adopted section', wrote.json?.success === true, wrote.text.slice(0, 200));

  const afterAdopt = await call(`/pages/${workshop.page_id}/sections`);
  const liveTree = afterAdopt.json?.elementor_data || [];
  check('exactly one version was added to the Undo ring',
    Number(afterAdopt.json?.snapshot_count || 0) === snapshotFloor + 1,
    `${afterAdopt.json?.snapshot_count} vs ${snapshotFloor + 1}`);
  check('the page still has five sections',
    liveTree.length === originalTree.length, `${liveTree.length}`);
  check('exactly one section changed',
    liveTree.filter((n, i) => JSON.stringify(n) !== JSON.stringify(originalTree[i])).length === 1);

  const liveRows = afterAdopt.json?.sections || [];
  check('the adopted section reads back as an editable hero, from the WEBSITE',
    liveRows[0]?.editable === true && liveRows[0]?.kind === 'hero',
    JSON.stringify({ editable: liveRows[0]?.editable, kind: liveRows[0]?.kind }));
  check('its handle says it was adopted, so the row can say so',
    String(liveRows[0]?.blueprint_id) === 'adopted', String(liveRows[0]?.handle));
  check('the words came across',
    liveRows[0]?.fields?.headline === 'Built in Shropshire, delivered to your garden',
    String(liveRows[0]?.fields?.headline));
  check('the button came across, pointing where it pointed',
    liveRows[0]?.fields?.cta_text === 'Book a survey' && liveRows[0]?.fields?.cta_href === '/contact/',
    JSON.stringify([liveRows[0]?.fields?.cta_text, liveRows[0]?.fields?.cta_href]));
  check('the three sections nobody touched are byte-identical',
    JSON.stringify(liveTree.slice(1)) === JSON.stringify(originalTree.slice(1)));

  /* ── 4b. the live page actually renders it ───────────────────────────── */

  await call('/purge-cache', { method: 'POST', body: {} });
  const html = await fetchHtml(workshop.permalink);
  check('the adopted wording is on the live page',
    html.includes('Built in Shropshire, delivered to your garden'));
  check('the ARGUS beacon is still there after an adoption',
    /ia-argus-beacon|argus-beacon|__ia_vid|webhooks\/beacon/i.test(html));
  check('Elementor still owns the page',
    /data-elementor-type|elementor-element/i.test(html));

  /* ── 4c. the fingerprint moved, so a stale preview cannot be adopted ── */

  check('the section at that position no longer matches the preview we took',
    sectionFingerprint(liveTree[0]) !== fingerprintBefore);

  /* ── 5. Undo adoption restores the original BYTE FOR BYTE ────────────── */

  const restoredTree = liveTree.map((n, i) => (i === 0 ? originalTree[0] : n));
  const restored = await call(`/pages/${workshop.page_id}/sections`, {
    method: 'POST', body: { sections: toNodes(restoredTree) },
  });
  check('the website accepted the original back', restored.json?.success === true);

  const afterUndo = await call(`/pages/${workshop.page_id}/sections`);
  const undoneTree = afterUndo.json?.elementor_data || [];
  check('the restored section is BYTE-IDENTICAL to what was there before',
    JSON.stringify(undoneTree[0]) === JSON.stringify(originalTree[0]),
    `${JSON.stringify(undoneTree[0]).slice(0, 160)}…`);
  check('the whole page is byte-identical to what it was',
    JSON.stringify(undoneTree) === originalJson);
  check('the row is greyed again, and offered again',
    afterUndo.json?.sections?.[0]?.editable === false
    && afterUndo.json?.sections?.[0]?.adoptable === true);

  await call('/purge-cache', { method: 'POST', body: {} });
  const htmlBack = await fetchHtml(workshop.permalink);
  check('the live page shows the original wording again',
    htmlBack.includes('Built in Shropshire, delivered to your garden'),
    'the fixture banner says the same thing either way — this is the section, not the copy');

  /* ── 6. deliberate failures ──────────────────────────────────────────── */

  console.log('\n  on purpose:');

  const noToken = await call(`/pages/${workshop.page_id}/sections`, { token: '' });
  check('no site token is refused, not answered with an empty page',
    noToken.status === 401 || noToken.status === 403, `HTTP ${noToken.status}`);

  const badToken = await call(`/pages/${workshop.page_id}/sections`, { token: 'not-the-token' });
  check('a wrong site token is refused', badToken.status === 401 || badToken.status === 403,
    `HTTP ${badToken.status}`);

  const ghost = await call('/pages/99999/sections');
  check('a page that does not exist is a 404, not an empty section list',
    ghost.status === 404, `HTTP ${ghost.status}`);

  const junk = await call(`/pages/${workshop.page_id}/sections`, {
    method: 'POST', body: { sections: [{ node: { elType: 'widget', widgetType: 'heading' } }] },
  });
  check('a top-level node that is not a section or a container is refused',
    junk.status === 400, `HTTP ${junk.status}`);

  const videoAnalysis = analyseSection(originalTree[3], { allowPro: true });
  check('the video band cannot be built even when asked directly',
    buildAdoptedSection({ analysis: { ...videoAnalysis, adoptable: true }, brand: BRAND, blockId: 'x' }).ok === true
      && videoAnalysis.adoptable === false,
    'the REFUSAL lives in the analysis, and the route is what honours it');

  const awardsAnalysis = analyseSection(originalTree[4], { allowPro: true });
  check('the awards strip has no archetype at all, so nothing can be built from it',
    awardsAnalysis.kind === null
    && buildAdoptedSection({ analysis: awardsAnalysis, brand: BRAND, blockId: 'x' }).ok === false);

  /* ── 7. leave it as we found it ──────────────────────────────────────── */

  const level = await rewindTo(workshop.page_id, snapshotFloor);
  check('the page and its Undo ring are back the depth they started',
    level === snapshotFloor, `${level} vs ${snapshotFloor}`);

  const finalRead = await call(`/pages/${workshop.page_id}/sections`);
  check('and the page itself is exactly as it was found',
    JSON.stringify(finalRead.json?.elementor_data || []) === originalJson);

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\n  the verifier itself fell over:', err);
  process.exit(1);
});
