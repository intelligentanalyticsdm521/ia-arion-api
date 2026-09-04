#!/usr/bin/env node
/**
 * _dev_verify_phase3_routes.mjs — the adoption ROUTES, live.
 *
 * `_dev_verify_phase3.mjs` drives the PLUGIN: the mapper's coverage on a real
 * page, one snapshot per adopt, and the byte-identical restore. This one
 * drives ARION-API the way the Portal does, through dev-auth, because the
 * branches that matter most here are the ones a browser cannot easily
 * provoke — a stale fingerprint, a second Undo, an index past the end of the
 * page — and every one of them is a place where a wrong answer would rewrite
 * the wrong piece of somebody's live site.
 *
 * The rule underneath all of them: never a success on a failure
 * (`reference_catch_swallow_report_success`), and never a write from the
 * preview.
 *
 *   node scripts/_dev_verify_phase3_routes.mjs [--api http://localhost:4036]
 *
 * Needs: the dev WordPress container, arion-api running from THIS worktree
 * with DEV_AUTH=1, and migration 061 applied to the local database.
 */

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const API = arg('api', 'http://localhost:4036');
const TENANT = arg('tenant', 'a0000001-0000-0000-0000-000000000001');
const SITE = arg('site', 'e68a46ae-b5ee-441d-a71c-2afeca12a658');
const PAGE = Number(arg('page', '89'));

if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(API)) {
  console.error(`Refusing to run against "${API}" — this script is for the local dev API only.`);
  process.exit(1);
}

let pass = 0;
let fail = 0;
const check = (n, ok, d = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); }
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
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
}

const base = `/arion/sites/${SITE}/pages/${PAGE}`;

console.log('\nadoption routes, on purpose\n');

// The read, so we know the shape and the fingerprints.
const read = await api(`${base}/sections`);
check('the page reads with its adoption view', read.status === 200 && !!read.json?.data?.adoption,
  JSON.stringify(read.json?.error || '').slice(0, 200));
const secs = read.json?.data?.sections || [];
const custom = secs.map((s, i) => ({ ...s, i })).filter((s) => !s.editable);
console.log(`  (page has ${secs.length} sections, ${custom.length} built on the site, `
  + `${read.json?.data?.adoption?.adoptableCount} of them offerable)`);

const offerable = custom.find((s) => s.adoptable);
const refusedVideo = custom.find((s) => s.adoptReason === 'would_lose_content');
const refusedUnknown = custom.find((s) => s.adoptReason === 'no_match');

check('a greyed row carries the reason it is greyed', !!refusedUnknown?.adoptReasonText);
check("the website's own hint rides along", typeof custom[0].pluginAdoptable === 'boolean');

// 1. Adopt with no fingerprint.
const noPrint = await api(`${base}/sections/${offerable.i}/adopt`, { method: 'POST', body: {} });
check('adopt with no fingerprint is refused', noPrint.status === 400
  && noPrint.json?.error?.code === 'PREVIEW_REQUIRED', `HTTP ${noPrint.status}`);

// 2. Adopt with a fingerprint from a DIFFERENT section.
const wrongPrint = await api(`${base}/sections/${offerable.i}/adopt`, {
  method: 'POST', body: { fingerprint: refusedUnknown.fingerprint },
});
check('adopt with a stale fingerprint is refused, and says the section changed',
  wrongPrint.status === 409 && wrongPrint.json?.error?.code === 'SECTION_CHANGED',
  `HTTP ${wrongPrint.status} ${wrongPrint.json?.error?.code}`);

// 3. Adopt a section we refused.
const refusedAdopt = await api(`${base}/sections/${refusedVideo.i}/adopt`, {
  method: 'POST', body: { fingerprint: refusedVideo.fingerprint },
});
check('adopting a section we refused is refused again at the write',
  refusedAdopt.status === 400 && refusedAdopt.json?.error?.code === 'NOT_ADOPTABLE',
  `HTTP ${refusedAdopt.status} ${refusedAdopt.json?.error?.code}`);

// 4. Preview a section that is already editable.
//
// Not on THIS page — the whole point of the fixture is that nothing on it is
// editable — so ask a page that has one. A check that silently skips itself
// when its subject is missing is a check that stops existing, which is how a
// suite quietly shrinks (the count dropped from 15 to 14 the first time the
// fixture changed, and that is the only reason this comment is here).
const editablePage = Number(arg('editable-page', '10'));
{
  const other = await api(`/arion/sites/${SITE}/pages/${editablePage}/sections`);
  const at = (other.json?.data?.sections || []).findIndex((s) => s.editable);
  check(`page ${editablePage} has a section we already own to test against`, at >= 0, `index ${at}`);
  const r = await api(`/arion/sites/${SITE}/pages/${editablePage}/sections/${at}/adopt-preview`, {
    method: 'POST', body: {},
  });
  check('previewing an adoption of a section you can already edit is refused',
    r.status === 400 && r.json?.error?.code === 'ALREADY_EDITABLE', `HTTP ${r.status}`);
}

// 5. A section index off the end of the page.
const off = await api(`${base}/sections/40/adopt-preview`, { method: 'POST', body: {} });
check('a section index past the end of the page is refused',
  off.status === 400 && off.json?.error?.code === 'SECTION_NOT_FOUND', `HTTP ${off.status} ${off.json?.error?.code}`);

// 6. A junk index.
const junk = await api(`${base}/sections/abc/adopt-preview`, { method: 'POST', body: {} });
check('a section index that is not a number is refused',
  junk.status === 400 && junk.json?.error?.code === 'BAD_SECTION_INDEX', `HTTP ${junk.status}`);

// 7. Undo an adoption id we do not have.
const ghost = await api(`${base}/adoptions/11111111-2222-3333-4444-555555555555/undo`, { method: 'POST' });
check('undoing an adoption we have no record of is a 404 with words',
  ghost.status === 404, `HTTP ${ghost.status}`);

// 8. Undo one that is already reverted.
const list = await api(`${base}/adoptions`);
const reverted = (list.json?.data?.adoptions || []).find((a) => a.status === 'reverted');
if (reverted) {
  const again = await api(`${base}/adoptions/${reverted.adoptionId}/undo`, { method: 'POST' });
  check('undoing an adoption twice is refused, not applied twice',
    again.status === 409 && again.json?.error?.code === 'ALREADY_UNDONE',
    `HTTP ${again.status} ${again.json?.error?.code}`);
} else {
  check('undoing an adoption twice is refused, not applied twice', false, 'no reverted row to try');
}

// 9. A bad adoption id shape.
const badId = await api(`${base}/adoptions/not-a-uuid/undo`, { method: 'POST' });
check('a reference that is not an id at all is refused',
  badId.status === 400 && badId.json?.error?.code === 'BAD_ADOPTION_ID', `HTTP ${badId.status}`);

// 10. The preview really does write nothing.
const beforePrev = await api(`${base}/sections`);
const treeBefore = JSON.stringify(beforePrev.json?.data?.sections?.map((s) => s.node));
const prev = await api(`${base}/sections/${offerable.i}/adopt-preview`, { method: 'POST', body: {} });
check('the preview answers with both sides and says nothing was saved',
  prev.status === 200 && prev.json?.data?.saved === false && !!prev.json?.data?.html,
  `HTTP ${prev.status}`);
const afterPrev = await api(`${base}/sections`);
check('and the page is byte-identical after previewing it',
  JSON.stringify(afterPrev.json?.data?.sections?.map((s) => s.node)) === treeBefore);

// 11. The adoption list.
check('the adoptions list answers with the undo window',
  list.status === 200 && list.json?.data?.undoDays === 30, `HTTP ${list.status}`);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
