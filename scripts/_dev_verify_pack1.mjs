#!/usr/bin/env node
/**
 * _dev_verify_pack1.mjs — drive the ARION pack 1 plugin routes against the dev
 * WordPress container and print a PASS/FAIL matrix.
 *
 * This is the half of the exhaustive test that cannot be a unit test. The
 * blank-page guard, the signed preview a logged-out visitor can open, the
 * read-back on page settings and SEO, and replace-a-picture-in-place all live
 * in PHP against a real WordPress with a real Elementor.
 *
 * It asserts on the CONTENT COMING BACK, not on the absence of an error
 * (memory: feedback_assert_presence_not_just_absence), it BREAKS THINGS ON
 * PURPOSE — it deactivates Elementor mid-run to prove the writer fails closed
 * (memory: feedback_mutation_test_your_guards) — and it puts every page,
 * setting and picture back the way it found them.
 *
 * ⚠ Dev only. It refuses to run against anything but a loopback host.
 *
 * ⚠ It needs the PACK 1 PLUGIN mounted (>= 1.7.3):
 *     dev-stack\start-dev-wp.ps1 -PluginDir C:\dev\iadm\ia-plugin-septa-arion1
 *   ...or the release-line checkout once this branch has merged. Against an
 *   older plugin every new route 404s and the run is meaningless rather than
 *   informative.
 *
 * ⚠ A MUTATION SWEEP over the plugin guards is destructive to the fixture: each
 *   mutant breaks the guard whose job is to stop this script's destructive step,
 *   so the fixture drifts and later runs abort on a draft an earlier one
 *   trashed. That used to be a note asking the reader to remember; it is a FLAG
 *   now. Run a sweep with `--reseed` and the fixture is rebuilt at the end,
 *   through the ONE seeder (`dev-stack\start-dev-wp.ps1 -Reseed`) rather than a
 *   second copy of it here. Either way this script now NAMES every leftover
 *   `Pack 1 …` / `ia-preview-…` / `Verification scratch` page it can still see,
 *   so drift is never silent.
 *
 *   node scripts/_dev_verify_pack1.mjs [--base http://localhost:8084] [--reseed]
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BASE = arg('base', 'http://localhost:8084');
const TOKEN_FILE = arg('token-file', 'C:\\dev\\iadm\\dev-stack\\wordpress\\.site-token');
const COMPOSE = arg('compose', 'C:\\dev\\iadm\\dev-stack\\wordpress\\compose.yml');
// The compose file mounts the plugin from ${IA_PLUGIN_DIR}. Without it set, a
// `docker compose run` resolves a DIFFERENT config from the running stack and
// recreates the WordPress container mid-request — which reads as an ECONNRESET
// halfway through a verification run. Found exactly that way.
const PLUGIN_DIR = arg('plugin-dir', 'C:\\dev\\iadm\\ia-plugin-septa-arion1');
const RESEED = argv.includes('--reseed');
const RESEED_SCRIPT = arg('reseed-script', 'C:\\dev\\iadm\\dev-stack\\start-dev-wp.ps1');
const API = `${BASE}/wp-json/intelligent-analytics/v1`;

if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(BASE)) {
  console.error(`Refusing to run against "${BASE}" — this script is for the local dev container only.`);
  process.exit(1);
}

const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/**
 * Docker Desktop's port forwarder drops established connections for a moment
 * whenever a container starts or stops, and this script starts a one-shot
 * wp-cli container to break things on purpose. Without this, the first request
 * after each of those reads as ECONNRESET and the run dies half way through
 * with nothing to do with the code under test.
 */
async function fetchRetry(url, init, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr;
}

async function call(path, { method = 'GET', body, token = TOKEN } = {}) {
  const url = `${API}${path}${path.includes('?') ? '&' : '?'}_ia_cb=${Date.now()}${Math.random()}`;
  const res = await fetchRetry(url, {
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

/** wp-cli in the dev container. Used only to break things and put them back. */
/**
 * Leave the fixture in a state the next reader can trust, and SAY what state
 * that is.
 *
 * §4d, arion pack 1: the header used to ask whoever ran a mutation sweep to
 * remember to repair the fixture afterwards, and to go and delete the leftovers
 * by hand. A cleanup somebody has to remember is a cleanup that does not
 * happen — twelve scratch drafts had piled up on this fixture before anybody
 * looked. So:
 *
 *   always     name every leftover page still on the fixture, so drift shows up
 *              in the run's own output rather than on the next walk;
 *   --reseed   rebuild the fixture pages afterwards, through the ONE seeder
 *              (start-dev-wp.ps1 -Reseed). A second copy of the seeding logic
 *              here would be a second answer to "what is the fixture", and the
 *              two would drift.
 */
async function settleFixture() {
  const LEFTOVER = /^(Pack 1 |ia-preview-|Verification scratch)/i;
  const leftovers = ((await call('/pages')).json?.pages || []).filter((p) => LEFTOVER.test(p.title || ''));
  if (leftovers.length) {
    console.log(`
  ! ${leftovers.length} leftover fixture page(s):`);
    for (const p of leftovers) console.log(`      #${p.page_id}  ${p.status}  ${p.title}`);
  } else {
    console.log(`
  fixture clean: no Pack 1 / preview / scratch pages left behind`);
  }

  if (!RESEED) {
    if (leftovers.length) console.log('  -> re-run with --reseed to rebuild the fixture');
    return;
  }

  console.log('  reseeding the fixture through start-dev-wp.ps1 -Reseed ...');
  try {
    execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RESEED_SCRIPT, '-Reseed'], {
      encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'],
    });
  } catch (err) {
    // A failed reseed must be LOUD: a fixture somebody believes was rebuilt and
    // was not is worse than one nobody touched.
    check('the fixture was reseeded', false, String(err.message).split('\n')[0]);
    return;
  }
  const after = ((await call('/pages')).json?.pages || []).filter((p) => LEFTOVER.test(p.title || ''));
  check('the fixture was reseeded and holds no leftover pages', after.length === 0,
    after.map((p) => `#${p.page_id} ${p.title}`).join(', '));
}

function wp(args) {
  return execFileSync('docker', [
    'compose', '--progress', 'quiet', '-f', COMPOSE,
    'run', '--rm', '-T', 'wpcli', 'wp', ...args,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, IA_PLUGIN_DIR: PLUGIN_DIR },
  }).trim();
}

/** A 1x1 and a 2x1 PNG, so a replace changes a dimension we can read back. */
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_3x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAABCAYAAAAKI8wLAAAAEUlEQVR42mNk+M/AwMDAyAAAFPYCAdSDhOwAAAAASUVORK5CYII=';

(async () => {
  console.log(`\n=== ARION pack 1 verification against ${BASE} ===\n`);

  /* ══════════════ 1. the site says what it is running ══════════════════ */
  const status = await call('/status');
  const el = status.json?.data?.elementor;
  check('GET /status reports Elementor', status.status === 200 && !!el && el.active === true,
    `status ${status.status}, elementor ${JSON.stringify(el)}`);
  check('...with a real version, not a boolean pretending to be one',
    typeof el?.version === 'string' && /^\d+\./.test(el.version), String(el?.version));
  check('...and Elementor Pro is reported ABSENT on this container (it is a paid licence)',
    el?.pro_active === false, JSON.stringify(el));
  const seoPlugin = status.json?.data?.seo_plugin;
  check('GET /status reports the SEO plugin the golden master installs',
    seoPlugin?.active === true && seoPlugin?.plugin === 'rank_math', JSON.stringify(seoPlugin));

  /* ══════════════ 2. find the fixture pages ═══════════════════════════ */
  const list = await call('/pages');
  const pages = list.json?.pages || [];
  const home = pages.find((p) => p.slug === 'home' && p.ia_managed);
  const draft = pages.find((p) => p.status === 'draft' && p.ia_managed);
  check('the pages list still answers', pages.length > 0, `${pages.length} pages`);
  check('the fixture Home page is there', !!home, home ? `#${home.page_id}` : 'missing');
  check('a draft is there to work on', !!draft, draft ? `#${draft.page_id}` : 'missing');
  if (!home || !draft) { console.log('\ncannot continue without the fixture pages\n'); process.exit(1); }

  const pageCountBefore = pages.length;
  const slugsBefore = pages.map((p) => `${p.page_id}:${p.slug}`).sort().join(',');
  const frontBefore = wp(['option', 'get', 'page_on_front']);
  const showBefore = wp(['option', 'get', 'show_on_front']);

  const homeSections = await call(`/pages/${home.page_id}/sections`);
  const homeTreeBefore = JSON.stringify(homeSections.json?.elementor_data || []);
  const homeUndoBefore = Number(homeSections.json?.snapshot_count || 0);

  /* ══════════════ 3. THE BLANK PAGE GUARD (D-ARION-E) ═════════════════ */
  // Break it on purpose: no Elementor, then try to save. Before this pack the
  // save answered 200, the client saw a green toast, and the page rendered
  // empty. Both ends must refuse.
  console.log('\n  -- deactivating Elementor on purpose --');
  wp(['plugin', 'deactivate', 'elementor']);
  try {
    const st2 = await call('/status');
    check('with Elementor off, /status says so', st2.json?.data?.elementor?.active === false,
      JSON.stringify(st2.json?.data?.elementor));

    const blind = await call(`/pages/${home.page_id}/sections`, {
      method: 'POST',
      body: { sections: (homeSections.json?.elementor_data || []).map((n) => ({ node: n })) },
    });
    check('a save to a site with no Elementor is REFUSED (409), not a green 200',
      blind.status === 409, `status ${blind.status} ${blind.text.slice(0, 120)}`);
    check('...and the refusal is a sentence a client can act on',
      /Elementor is not active/i.test(String(blind.json?.error || '')), String(blind.json?.error).slice(0, 140));
    check('...and it names the reason in a code the Portal can branch on',
      blind.json?.code === 'elementor_missing', String(blind.json?.code));

    const preview0 = await call(`/pages/${home.page_id}/preview`, {
      method: 'POST', body: { sections: [{ node: (homeSections.json?.elementor_data || [])[0] }] },
    });
    check('a PREVIEW is refused too, rather than showing a blank page',
      preview0.status === 409, `status ${preview0.status}`);

    // The section save and the create both check Elementor early, so breaking
    // one of the two guards there leaves the other holding. `POST /pages/elementor`
    // — the v1.2 assemble path — has NO early guard by design, so its only
    // protection is the WRITER's own, and this is what proves that fires by
    // itself. Aimed at the EXISTING Home page, so a refusal leaves nothing
    // behind either way.
    const blindWriter = await call('/pages/elementor', {
      method: 'POST',
      body: { page_id: home.page_id, elementor_data: homeSections.json?.elementor_data || [] },
    });
    check('the WRITER itself refuses, on the one path with no early guard',
      blindWriter.status === 409 && blindWriter.json?.code === 'elementor_missing',
      `status ${blindWriter.status} ${blindWriter.text.slice(0, 120)}`);

    const born = await call('/pages', {
      method: 'POST',
      body: { title: 'Pack 1 must not be created', sections: [{ node: (homeSections.json?.elementor_data || [])[0] }] },
    });
    check('...and a new page cannot be born on a site that cannot draw it',
      born.status === 409 && born.json?.code === 'elementor_missing',
      `status ${born.status} ${born.text.slice(0, 120)}`);
    // The create used to insert the post and THEN refuse, leaving an orphan
    // draft on the client's site every time. Counted, not assumed.
    const bornId = Number(born.json?.page_id || 0);
    check('...and it left NO half-made page behind',
      !bornId, bornId ? `page ${bornId} was created anyway` : '');
    if (bornId) wp(['post', 'delete', String(bornId), '--force']);

    const after = await call(`/pages/${home.page_id}/sections`);
    check('the page was NOT touched by the refused save',
      JSON.stringify(after.json?.elementor_data || []) === homeTreeBefore);
    check('...and the refused save left NO step in the Undo ring',
      Number(after.json?.snapshot_count || 0) === homeUndoBefore,
      `${after.json?.snapshot_count} vs ${homeUndoBefore}`);
  } finally {
    wp(['plugin', 'activate', 'elementor']);
    console.log('  -- Elementor back on --\n');
  }
  const st3 = await call('/status');
  check('Elementor is active again', st3.json?.data?.elementor?.active === true);

  /* ══════════════ 4. the preview WordPress renders (D-ARION-B) ════════ */
  const tree = homeSections.json?.elementor_data || [];
  const MARK = `Preview marker ${Date.now()}`;
  // Change the first heading's text in the candidate tree, without saving.
  const candidate = JSON.parse(JSON.stringify(tree));
  let stamped = false;
  const stamp = (node) => {
    if (stamped) return;
    if (node?.elType === 'widget' && node.widgetType === 'heading' && node.settings) {
      node.settings.title = MARK; stamped = true; return;
    }
    for (const c of node?.elements || []) stamp(c);
  };
  for (const n of candidate) stamp(n);
  check('the fixture Home page has a heading to stamp', stamped);

  const prev = await call(`/pages/${home.page_id}/preview`, {
    method: 'POST',
    body: { sections: candidate.map((n) => ({ node: n })), title: 'Home' },
  });
  check('POST /pages/<id>/preview answers 200 with a link',
    prev.status === 200 && typeof prev.json?.preview_url === 'string',
    `status ${prev.status} ${prev.text.slice(0, 160)}`);
  check('...and says out loud that nothing was saved', prev.json?.saved === false);
  const previewUrl = String(prev.json?.preview_url || '');
  const previewPostId = Number(prev.json?.preview_post_id || 0);
  check('...on a companion page, not the page being previewed',
    previewPostId > 0 && previewPostId !== home.page_id, `${previewPostId} vs ${home.page_id}`);

  // The client has no WordPress account. NO cookie, NO token: just the link.
  const shown = await fetchRetry(previewUrl, { headers: { Accept: 'text/html' } });
  const html = await shown.text();
  check('the link opens with NO WordPress login', shown.status === 200, `status ${shown.status}`);
  check('...and shows the unsaved wording', html.includes(MARK));
  check('...rendered by Elementor, not by us',
    /elementor-element|elementor-widget/.test(html), 'no elementor markup in the page');
  check('...inside the real theme', /hello-elementor|wp-content\/themes/.test(html));
  check('...and is told not to index it', /name="robots" content="noindex/.test(html));

  const wrongKey = await fetchRetry(previewUrl.replace(/ia_preview_key=[^&]+/, 'ia_preview_key=' + 'x'.repeat(40)));
  const wrongHtml = await wrongKey.text();
  check('a WRONG key does not show the preview', !wrongHtml.includes(MARK),
    `status ${wrongKey.status}`);
  const noKey = await fetchRetry(`${BASE}/?ia_preview=${previewPostId}`);
  check('and NO key does not either', !(await noKey.text()).includes(MARK));

  // Expiry, without waiting an hour: wind the stored timestamp back and the
  // same link must stop working.
  const keptExpiry = wp(['post', 'meta', 'get', String(previewPostId), '_ia_preview_expires']);
  wp(['post', 'meta', 'update', String(previewPostId), '_ia_preview_expires', '1000000000']);
  const expired = await fetchRetry(previewUrl);
  check('an EXPIRED preview link stops working', !(await expired.text()).includes(MARK));
  wp(['post', 'meta', 'update', String(previewPostId), '_ia_preview_expires', keptExpiry]);
  const revived = await fetchRetry(previewUrl);
  check('...and works again once it is in date', (await revived.text()).includes(MARK));

  const afterPreview = await call(`/pages/${home.page_id}/sections`);
  check('the live page is byte-identical after a preview',
    JSON.stringify(afterPreview.json?.elementor_data || []) === homeTreeBefore);
  check('...and the preview added nothing to its Undo ring',
    Number(afterPreview.json?.snapshot_count || 0) === homeUndoBefore);

  const listWithPreview = await call('/pages');
  const previewInList = (listWithPreview.json?.pages || []).some((p) => p.page_id === previewPostId);
  check('the preview page is NOT in the client\'s page list', !previewInList);

  // A second preview rotates the key, so an old link stops working.
  const prev2 = await call(`/pages/${home.page_id}/preview`, {
    method: 'POST', body: { sections: candidate.map((n) => ({ node: n })) },
  });
  check('a second preview reuses the same companion page rather than piling up',
    Number(prev2.json?.preview_post_id) === previewPostId);
  const stale = await fetchRetry(previewUrl);
  check('...and the previous link is dead', !(await stale.text()).includes(MARK));

  /* ══════════════ 5. page settings ════════════════════════════════════ */
  const s0 = await call(`/pages/${draft.page_id}/settings`);
  check('GET /pages/<id>/settings answers', s0.status === 200 && !!s0.json?.success);
  const slug0 = String(s0.json?.slug || '');
  const tpl0 = String(s0.json?.template || '');
  const parent0 = Number(s0.json?.parent_id || 0);
  check('...with the layouts THIS site has, from the theme and the page builder',
    Array.isArray(s0.json?.templates) && s0.json.templates.some((t) => t.file === 'elementor_canvas'),
    JSON.stringify((s0.json?.templates || []).map((t) => t.file)));
  check('...and a parent list that does not offer the page itself',
    !(s0.json?.parents || []).some((p) => Number(p.page_id) === draft.page_id));

  // A published page of our own to test the live-clash path on, so nothing that
  // matters is renamed.
  const madePub = await call('/pages', { method: 'POST', body: { title: 'Pack 1 clash target' } });
  const scratchPublished = Number(madePub.json?.page_id || 0);
  check('a published scratch page was created', scratchPublished > 0, madePub.text.slice(0, 120));
  await call(`/pages/${scratchPublished}/sections`, {
    method: 'POST',
    body: { sections: [{ node: (homeSections.json?.elementor_data || [])[0] }], status: 'publish' },
  });

  const newSlug = `pack1-verify-${Date.now()}`;
  const s1 = await call(`/pages/${draft.page_id}/settings`, {
    method: 'POST', body: { slug: newSlug, template: 'elementor_canvas', parent_id: home.page_id },
  });
  check('POST settings changes the address, the layout and the parent',
    s1.status === 200 && s1.json?.slug === newSlug && s1.json?.template === 'elementor_canvas'
      && Number(s1.json?.parent_id) === home.page_id,
    `${s1.status} ${JSON.stringify({ slug: s1.json?.slug, tpl: s1.json?.template, parent: s1.json?.parent_id })}`);
  check('...and WordPress agrees when asked independently',
    wp(['post', 'get', String(draft.page_id), '--field=post_name']) === newSlug);
  check('...as does the layout meta',
    wp(['post', 'meta', 'get', String(draft.page_id), '_wp_page_template']) === 'elementor_canvas');

  // WordPress only makes a slug unique against a PUBLISHED post — a draft's own
  // slug reserves nothing — so the clash has to be against the live Home page.
  // WordPress makes a slug unique only against PUBLISHED posts, so a DRAFT is
  // allowed to hold an address the live Home page already has — and WordPress
  // quietly renames it at publish time. The client has to be told that now.
  // `parent_id: 0` matters: WordPress checks a page slug for uniqueness among
  // its SIBLINGS, so a child of Home may legitimately be called "home" too.
  const clash = await call(`/pages/${draft.page_id}/settings`, {
    method: 'POST', body: { slug: String(home.slug), parent_id: 0 },
  });
  check('a draft may take an address that is in use, and is told what it will become',
    clash.status === 200 && clash.json?.slug === String(home.slug)
      && clash.json?.slug_on_publish !== String(home.slug)
      && String(clash.json?.slug_on_publish || '').startsWith(String(home.slug)),
    `${clash.status} slug=${clash.json?.slug} on_publish=${clash.json?.slug_on_publish}`);
  check('...and the live page kept its own address',
    wp(['post', 'get', String(home.page_id), '--field=post_name']) === String(home.slug));

  // On a page that IS published, WordPress renames it there and then, and the
  // answer says so rather than letting the address differ silently.
  const clashLive = await call(`/pages/${scratchPublished}/settings`, {
    method: 'POST', body: { slug: String(home.slug) },
  });
  check('a LIVE page given an address in use is renamed, and the answer says so',
    clashLive.status === 200 && clashLive.json?.slug_adjusted === true
      && clashLive.json?.slug !== String(home.slug),
    `${clashLive.status} slug=${clashLive.json?.slug} adjusted=${clashLive.json?.slug_adjusted}`);

  const badTpl = await call(`/pages/${draft.page_id}/settings`, {
    method: 'POST', body: { template: 'page-templates/does-not-exist.php' },
  });
  check('a layout this site does not have is refused', badTpl.status === 400, `status ${badTpl.status}`);

  const selfParent = await call(`/pages/${draft.page_id}/settings`, {
    method: 'POST', body: { parent_id: draft.page_id },
  });
  check('a page cannot be its own parent', selfParent.status === 400);

  const draftHome = await call(`/pages/${draft.page_id}/settings`, { method: 'POST', body: { make_homepage: true } });
  check('a DRAFT cannot be made the home page (it would leave the site blank)',
    draftHome.status === 409, `status ${draftHome.status} ${String(draftHome.json?.error).slice(0, 80)}`);

  const homeSet = await call(`/pages/${home.page_id}/settings`, { method: 'POST', body: { make_homepage: true } });
  check('a published page CAN be made the home page',
    homeSet.status === 200 && homeSet.json?.is_front_page === true, `status ${homeSet.status}`);
  check('...and WordPress agrees', wp(['option', 'get', 'page_on_front']) === String(home.page_id)
    && wp(['option', 'get', 'show_on_front']) === 'page');

  const trashHome = await call(`/pages/${home.page_id}/trash`, { method: 'POST' });
  check('the HOME page cannot be deleted', trashHome.status === 409,
    `status ${trashHome.status} ${String(trashHome.json?.error).slice(0, 80)}`);

  /* ══════════════ 6. delete and restore a page ════════════════════════ */
  const made = await call('/pages', { method: 'POST', body: { title: 'Pack 1 scratch page' } });
  const scratchId = Number(made.json?.page_id || 0);
  check('a scratch page was created to delete', made.status === 201 && scratchId > 0, made.text.slice(0, 120));

  const trashed = await call(`/pages/${scratchId}/trash`, { method: 'POST' });
  check('POST /pages/<id>/trash puts it in the bin',
    trashed.status === 200 && trashed.json?.status === 'trash', `status ${trashed.status}`);
  check('...and WordPress agrees', wp(['post', 'get', String(scratchId), '--field=post_status']) === 'trash');
  const listTrash = await call('/pages');
  check('...and the page list shows it as deleted rather than hiding it',
    (listTrash.json?.pages || []).some((p) => p.page_id === scratchId && p.status === 'trash'),
    JSON.stringify((listTrash.json?.pages || []).map((p) => `${p.page_id}:${p.status}`)));

  const restored = await call(`/pages/${scratchId}/restore`, { method: 'POST' });
  check('POST /pages/<id>/restore brings it back',
    restored.status === 200 && restored.json?.status !== 'trash', `status ${restored.status}`);
  check('...as a DRAFT, never straight back onto the website',
    restored.json?.status === 'draft', String(restored.json?.status));
  const restoreTwice = await call(`/pages/${scratchId}/restore`, { method: 'POST' });
  check('restoring a page that is not in the bin says so', restoreTwice.status === 409);

  /* ══════════════ 7. the three SEO fields ═════════════════════════════ */
  const seo0 = await call(`/pages/${draft.page_id}/seo`);
  check('GET /pages/<id>/seo answers', seo0.status === 200 && !!seo0.json?.success);
  check('...and says which SEO plugin will render it',
    seo0.json?.seo_plugin?.active === true, JSON.stringify(seo0.json?.seo_plugin));
  const seoBefore = seo0.json?.seo || {};

  const SEO_T = `Pack 1 title ${Date.now()}`;
  const seo1 = await call(`/pages/${draft.page_id}/seo`, {
    method: 'POST',
    body: { title: SEO_T, description: 'A line under it.', focus_keyword: 'pack one' },
  });
  check('POST /pages/<id>/seo saves all three',
    seo1.status === 200 && seo1.json?.seo?.title === SEO_T
      && seo1.json?.seo?.description === 'A line under it.'
      && seo1.json?.seo?.focus_keyword === 'pack one',
    `${seo1.status} ${JSON.stringify(seo1.json?.seo)}`);
  check('...and WordPress holds Rank Math\'s own meta keys',
    wp(['post', 'meta', 'get', String(draft.page_id), 'rank_math_title']) === SEO_T
    && wp(['post', 'meta', 'get', String(draft.page_id), 'rank_math_focus_keyword']) === 'pack one');

  const cleared = await call(`/pages/${draft.page_id}/seo`, { method: 'POST', body: { description: '' } });
  check('an empty value CLEARS a field rather than being ignored',
    cleared.status === 200 && cleared.json?.seo?.description === '',
    JSON.stringify(cleared.json?.seo));
  check('...and the title it was not asked about is untouched',
    cleared.json?.seo?.title === SEO_T);

  const nothing = await call(`/pages/${draft.page_id}/seo`, { method: 'POST', body: {} });
  check('a request with no fields is refused rather than reported as saved',
    nothing.status === 400, `status ${nothing.status}`);

  /* ══════════════ 8. pictures: where used, replace, delete ════════════ */
  const upA = await call('/media/sideload', {
    method: 'POST',
    body: { filename: 'pack1-unused.png', content_type: 'image/png', data_base64: PNG_1x1, alt: 'An unused test picture' },
  });
  const unusedId = Number(upA.json?.attachment_id || 0);
  check('a picture uploaded for this run', upA.status === 201 && unusedId > 0, upA.text.slice(0, 120));

  const u1 = await call(`/media/${unusedId}/usage`);
  check('GET /media/<id>/usage says an unused picture is unused',
    u1.status === 200 && u1.json?.used === false && u1.json?.scan === 'complete',
    JSON.stringify({ used: u1.json?.used, scan: u1.json?.scan }));

  // Put it on the DRAFT page, and it must count as used — deleting it would
  // break a page nobody has published yet, which /media/audit cannot see.
  const draftSections = await call(`/pages/${draft.page_id}/sections`);
  const draftTree = draftSections.json?.elementor_data || [];
  const withImage = JSON.parse(JSON.stringify(draftTree));
  const imgUrl = String(upA.json?.url || '');
  let placed = false;
  const place = (node) => {
    if (placed) return;
    if (node?.elType === 'widget' && node.widgetType === 'heading' && node.settings) {
      node.settings.title = `${node.settings.title || ''} ${imgUrl}`; placed = true; return;
    }
    for (const c of node?.elements || []) place(c);
  };
  for (const n of withImage) place(n);
  if (placed) {
    await call(`/pages/${draft.page_id}/sections`, {
      method: 'POST', body: { sections: withImage.map((n) => ({ node: n })) },
    });
    const u2 = await call(`/media/${unusedId}/usage`);
    check('a picture used on a DRAFT counts as used',
      u2.json?.used === true && (u2.json?.places || []).some((p) => Number(p.post_id) === draft.page_id),
      JSON.stringify({ used: u2.json?.used, places: (u2.json?.places || []).map((p) => p.post_id) }));

    const refused = await call(`/media/${unusedId}`, { method: 'DELETE' });
    check('deleting a picture that is in use is REFUSED, with the pages named',
      refused.status === 409 && (refused.json?.places || []).length > 0,
      `status ${refused.status}`);
    check('...and the picture is still there',
      wp(['post', 'get', String(unusedId), '--field=post_type']) === 'attachment');

    // Take it off again and undo, so the draft ends as it started.
    await call(`/pages/${draft.page_id}/undo`, { method: 'POST' });
  } else {
    check('the draft has a heading to put a picture reference on', false);
  }

  const u3 = await call(`/media/${unusedId}/usage`);
  check('once nothing uses it, the answer changes back', u3.json?.used === false,
    JSON.stringify({ used: u3.json?.used, places: (u3.json?.places || []).map((p) => p.title) }));

  // Replace in place: same id, new bytes, new dimensions.
  const rep = await call(`/media/${unusedId}/replace`, {
    method: 'POST', body: { data_base64: PNG_3x1 },
  });
  check('POST /media/<id>/replace keeps the same picture id',
    rep.status === 200 && Number(rep.json?.attachment_id) === unusedId,
    `status ${rep.status} ${rep.text.slice(0, 140)}`);
  check('...and the file underneath really changed', Number(rep.json?.width) === 3,
    `width ${rep.json?.width}`);
  const libAfter = await call(`/media?per_page=60`);
  const row = (libAfter.json?.items || []).find((i) => Number(i.attachment_id) === unusedId);
  check('...so the library reports the new size, at the same address',
    !!row && Number(row.width) === 3 && String(row.url) === imgUrl,
    JSON.stringify({ width: row?.width, sameUrl: String(row?.url) === imgUrl }));

  const wrongType = await call(`/media/${unusedId}/replace`, {
    method: 'POST', body: { url: `${BASE}/wp-content/plugins/intelligent-analytics/README.md` },
  });
  check('replacing a picture with something that is not one is refused',
    wrongType.status >= 400, `status ${wrongType.status}`);

  const gone = await call(`/media/${unusedId}`, { method: 'DELETE' });
  check('an unused picture CAN be deleted', gone.status === 200 && gone.json?.deleted === true,
    `status ${gone.status} ${gone.text.slice(0, 120)}`);
  let stillThere = true;
  try { wp(['post', 'get', String(unusedId)]); } catch { stillThere = false; }
  check('...and it is really gone from WordPress', !stillThere);

  /* ══════════════ 9. put everything back ══════════════════════════════ */
  console.log('\n  -- restoring --');
  await call(`/pages/${draft.page_id}/settings`, {
    method: 'POST', body: { slug: slug0, template: tpl0, parent_id: parent0 },
  });
  // The draft must come back a DRAFT even if something above published it —
  // this script runs against a fixture other walks use.
  if (wp(['post', 'get', String(draft.page_id), '--field=post_status']) !== 'draft') {
    wp(['post', 'update', String(draft.page_id), '--post_status=draft']);
  }
  await call(`/pages/${draft.page_id}/seo`, {
    method: 'POST',
    body: {
      title: String(seoBefore.title || ''),
      description: String(seoBefore.description || ''),
      focus_keyword: String(seoBefore.focus_keyword || ''),
    },
  });
  wp(['option', 'update', 'show_on_front', showBefore || 'posts']);
  wp(['option', 'update', 'page_on_front', frontBefore || '0']);
  if (scratchId) wp(['post', 'delete', String(scratchId), '--force']);
  if (scratchPublished) wp(['post', 'delete', String(scratchPublished), '--force']);
  if (previewPostId) wp(['post', 'delete', String(previewPostId), '--force']);

  const finalList = await call('/pages');
  const finalPages = finalList.json?.pages || [];
  check('the page count is back where it started',
    finalPages.length === pageCountBefore, `${finalPages.length} vs ${pageCountBefore}`);
  check('every slug is back where it started',
    finalPages.map((p) => `${p.page_id}:${p.slug}`).sort().join(',') === slugsBefore);
  check('the front page setting is back',
    wp(['option', 'get', 'show_on_front']) === showBefore
    && wp(['option', 'get', 'page_on_front']) === frontBefore);
  const finalHome = await call(`/pages/${home.page_id}/sections`);
  check('the Home page is byte-identical to how this run found it',
    JSON.stringify(finalHome.json?.elementor_data || []) === homeTreeBefore);
  const finalSeo = await call(`/pages/${draft.page_id}/seo`);
  check('the draft\'s SEO fields are back',
    String(finalSeo.json?.seo?.title || '') === String(seoBefore.title || '')
    && String(finalSeo.json?.seo?.description || '') === String(seoBefore.description || ''));

  await settleFixture();

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nverifier threw:', err);
  process.exit(1);
});
