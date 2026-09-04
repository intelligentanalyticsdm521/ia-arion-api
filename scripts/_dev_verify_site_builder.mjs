#!/usr/bin/env node
/**
 * _dev_verify_site_builder.mjs — drive the IA plugin's site-builder routes
 * against the dev WordPress container and print a PASS/FAIL matrix.
 *
 * This is the half of the exhaustive test that cannot be a unit test: the
 * snapshot ring, Undo, and media sideload all live in PHP against a real
 * WordPress. It asserts on the CONTENT COMING BACK, not on the absence of an
 * error (memory: feedback_assert_presence_not_just_absence), and it breaks
 * things on purpose at the end (memory: feedback_mutation_test_your_guards).
 *
 * ⚠ Dev only. It refuses to run against anything but a loopback host, and it
 * puts every page it touched back the way it found it.
 *
 *   node scripts/_dev_verify_site_builder.mjs [--base http://localhost:8084]
 */

import fs from 'node:fs';
import { reduceToSectionList, applyFields, extractFields } from '../lib/websiteBuilder/sectionSchema.js';

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

let pass = 0;
let fail = 0;
const rows = [];
function check(name, ok, detail = '') {
  rows.push({ name, ok, detail });
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

/** A 1x1 PNG, built here so the script needs no fixture file and no network. */
const PNG_1PX_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  console.log(`\n=== site builder verification against ${BASE} ===\n`);

  /* ── the read path ──────────────────────────────────────────────────── */
  const list = await call('/pages');
  const pages = list.json?.pages || [];
  check('GET /pages answers 200 with a list', list.status === 200 && pages.length > 0,
    `status ${list.status}, ${pages.length} pages`);

  const draft = pages.find((p) => p.status === 'draft' && p.ia_managed);
  check('the list includes a DRAFT page (the publish-only endpoint never could)',
    !!draft, draft ? `#${draft.page_id} ${draft.title}` : 'no ia-managed draft found');

  const home = pages.find((p) => p.title === 'Home');
  const about = pages.find((p) => p.title === 'About us');
  check('the fixture Home and About pages are both there', !!home && !!about);
  if (!home || !about) { report(); return; }

  const homeRead = await call(`/pages/${home.page_id}/sections`);
  const homeSections = homeRead.json?.sections || [];
  check('a page reduces to a NAMED section list, not JSON',
    homeSections.length === 4 && homeSections.every((s) => typeof s.kind === 'string'),
    homeSections.map((s) => s.kind).join(', '));
  check('the hero headline reads back as words',
    typeof homeSections[0]?.fields?.headline === 'string' && homeSections[0].fields.headline.length > 5,
    JSON.stringify(homeSections[0]?.fields?.headline));

  const aboutRead = await call(`/pages/${about.page_id}/sections`);
  const aboutSections = aboutRead.json?.sections || [];
  const custom = aboutSections.find((s) => s.reason === 'custom');
  check('a hand-built Elementor section shows in position, read-only',
    !!custom && custom.index === 1 && custom.editable === false,
    custom ? `index ${custom.index}` : 'not found');

  /* ── the write path + snapshot ring ─────────────────────────────────── */
  const tree = homeRead.json?.elementor_data || [];
  const before = JSON.stringify(tree);
  const parsed = reduceToSectionList(tree);
  const originalHeadline = parsed[0].fields.headline;
  const NEW_HEADLINE = `Verified at ${new Date().toISOString()}`;

  const edited = parsed.map((s, i) => (i === 0
    ? { handle: s.handle, node: applyFields(s.node, s.kind, { ...s.fields, headline: NEW_HEADLINE }) }
    : { handle: s.handle, node: s.node }));

  const saved = await call(`/pages/${home.page_id}/sections`, { method: 'POST', body: { sections: edited } });
  check('POST /pages/:id/sections saves and reports a snapshot',
    saved.status === 200 && saved.json?.success === true && saved.json?.snapshot_count >= 1,
    `status ${saved.status}, snapshots ${saved.json?.snapshot_count}`);

  const afterSave = await call(`/pages/${home.page_id}/sections`);
  check('the new headline reads back from the site',
    afterSave.json?.sections?.[0]?.fields?.headline === NEW_HEADLINE,
    JSON.stringify(afterSave.json?.sections?.[0]?.fields?.headline));
  check('Undo is offered once there is something to undo', afterSave.json?.can_undo === true);

  // Everything we did not touch must be byte-identical.
  const untouched = JSON.stringify((afterSave.json?.elementor_data || []).slice(1));
  check('every other section round-tripped byte for byte',
    untouched === JSON.stringify(JSON.parse(before).slice(1)));

  const liveHtml = await (await fetch(`${home.permalink}?cb=${Date.now()}`)).text();
  check('the change is on the LIVE page, not just in the API',
    liveHtml.includes(NEW_HEADLINE), 'headline not found in the rendered page');
  check('the ARGUS beacon survived the edit',
    /ia-argus-beacon|iaArgusBeacon|ia_argus/i.test(liveHtml),
    'beacon script not found on the rendered page');

  /* ── undo ───────────────────────────────────────────────────────────── */
  const undone = await call(`/pages/${home.page_id}/undo`, { method: 'POST', body: {} });
  check('POST /pages/:id/undo reports a restore',
    undone.status === 200 && undone.json?.restored === true, `status ${undone.status}`);

  const afterUndo = await call(`/pages/${home.page_id}/sections`);
  check('Undo put the original headline back',
    afterUndo.json?.sections?.[0]?.fields?.headline === originalHeadline,
    JSON.stringify(afterUndo.json?.sections?.[0]?.fields?.headline));
  check('Undo restored the WHOLE tree, byte for byte',
    JSON.stringify(afterUndo.json?.elementor_data) === before);

  const undoAgain = await call(`/pages/${home.page_id}/undo`, { method: 'POST', body: {} });
  check('Undo with nothing left says so rather than pretending',
    undoAgain.status === 200 && undoAgain.json?.restored === false,
    JSON.stringify(undoAgain.json?.restored));

  /* ── the snapshot ring caps at 20 ───────────────────────────────────── */
  const ringPage = pages.find((p) => p.title === 'Autumn offer');
  if (ringPage) {
    const ringRead = await call(`/pages/${ringPage.page_id}/sections`);
    const ringSections = (ringRead.json?.elementor_data || []).map((n) => ({ node: n }));
    for (let i = 0; i < 23; i++) {
      await call(`/pages/${ringPage.page_id}/sections`, { method: 'POST', body: { sections: ringSections } });
    }
    const ringAfter = await call(`/pages/${ringPage.page_id}/sections`);
    check('the snapshot ring holds 20 and no more',
      ringAfter.json?.snapshot_count === 20, `snapshot_count ${ringAfter.json?.snapshot_count}`);
  } else {
    check('the snapshot ring holds 20 and no more', false, 'no Autumn offer page to exercise it on');
  }

  /* ── new page, born a draft ─────────────────────────────────────────── */
  const created = await call('/pages', { method: 'POST', body: { title: `Verify draft ${Date.now()}`, sections: [] } });
  check('POST /pages creates a DRAFT and returns its real id',
    created.status === 201 && created.json?.status === 'draft' && Number(created.json?.page_id) > 0,
    `status ${created.status}, page ${created.json?.page_id}, ${created.json?.status}`);
  check('a new page reports a real last-changed time, not "never"',
    (await call('/pages')).json?.pages?.find((p) => p.page_id === created.json?.page_id)?.modified != null,
    'drafts carry a zero post_modified_gmt in WordPress; the read must fall back');
  // Name the page it leaves behind so the next reader knows what it is. The
  // plugin has no delete route (deleting a client's page is not something this
  // scope should be able to do); `start-dev-wp.ps1 -Destroy` resets the lot.
  if (created.json?.page_id) {
    await call(`/pages/${created.json.page_id}/sections`, {
      method: 'POST',
      body: { sections: [], status: 'draft', title: 'Verification scratch (safe to delete)' },
    });
  }

  /* ── media sideload ─────────────────────────────────────────────────── */
  const upload = await call('/media/sideload', {
    method: 'POST',
    body: { filename: 'verify.png', content_type: 'image/png', data_base64: PNG_1PX_B64, alt: 'A test picture' },
  });
  check('POST /media/sideload stores a picture and returns its URL',
    upload.status === 201 && /^https?:\/\/.+\.png$/i.test(String(upload.json?.url || '')),
    `status ${upload.status}, url ${upload.json?.url}`);
  if (upload.json?.url) {
    const head = await fetch(upload.json.url, { method: 'GET' });
    check('the uploaded picture is actually served', head.ok, `status ${head.status}`);
  }

  const badType = await call('/media/sideload', {
    method: 'POST',
    body: { filename: 'x.exe', content_type: 'application/octet-stream', data_base64: PNG_1PX_B64 },
  });
  check('an unsupported picture type is refused with a reason',
    badType.status === 415 && /JPG|PNG/i.test(String(badType.json?.error || '')),
    `status ${badType.status}, ${badType.json?.error}`);

  const liar = await call('/media/sideload', {
    method: 'POST',
    // A text file claiming to be a PNG. The bytes decide, not the header.
    body: { filename: 'x.png', content_type: 'image/png', data_base64: Buffer.from('MZ not a picture').toString('base64') },
  });
  check('a file that only CLAIMS to be a picture is refused',
    liar.status === 415, `status ${liar.status}, ${liar.json?.error}`);

  const empty = await call('/media/sideload', { method: 'POST', body: {} });
  check('an upload with nothing in it is refused', empty.status === 400, `status ${empty.status}`);

  /* ── break it on purpose ────────────────────────────────────────────── */
  const noToken = await call('/pages', { token: '' });
  check('no site token -> 401, never a page list',
    noToken.status === 401 && !Array.isArray(noToken.json?.pages), `status ${noToken.status}`);

  const badToken = await call('/pages', { token: 'not-the-token' });
  check('a wrong site token -> 401', badToken.status === 401, `status ${badToken.status}`);

  const ghost = await call('/pages/999999/sections');
  check('a page that does not exist -> 404, with words',
    ghost.status === 404 && typeof ghost.json?.error === 'string', `status ${ghost.status}`);

  const junk = await call(`/pages/${home.page_id}/sections`, {
    method: 'POST', body: { sections: [{ node: { elType: 'widget' } }] },
  });
  check('a save carrying something that is not a section -> 400, nothing written',
    junk.status === 400, `status ${junk.status}`);

  const stillOriginal = await call(`/pages/${home.page_id}/sections`);
  check('the page is untouched after the refused save',
    stillOriginal.json?.sections?.[0]?.fields?.headline === originalHeadline);

  report();
})().catch((err) => {
  console.error('\nverification crashed:', err);
  process.exit(1);
});

function report() {
  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  if (fail > 0) {
    for (const r of rows.filter((x) => !x.ok)) console.log(`  FAILED: ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  process.exit(fail > 0 ? 1 : 0);
}
