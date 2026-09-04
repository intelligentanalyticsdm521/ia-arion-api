#!/usr/bin/env node
/**
 * _dev_verify_phase2.mjs — Phase 2 against the dev WordPress container.
 *
 * What a unit test cannot see, and this can:
 *   - the media LIBRARY read: paging, search, the rendered sizes that make
 *     srcset possible, and alt text that actually lands on the attachment;
 *   - a picture chosen from the library rendering with a real `srcset` on the
 *     live page — the whole point of storing the attachment id;
 *   - the SPARK pixel and the ARGUS beacon still in the page's source AFTER an
 *     edit, which is the only proof that editing cannot drop them;
 *   - the form's routing attributes byte-identical in the LIVE stored tree
 *     after a save that touched a different field;
 *   - the [ia_book_now] button rendering (and, on a Lite site, not);
 *   - deliberate failures at the end.
 *
 * ⚠ Dev only. Refuses anything but a loopback host, and puts every page it
 * touched back the way it found it.
 *
 *   node scripts/_dev_verify_phase2.mjs [--base http://localhost:8084]
 */

import fs from 'node:fs';
import zlib from 'node:zlib';
import { reduceToSectionList, applyFields } from '../lib/websiteBuilder/sectionSchema.js';

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

const fetchHtml = async (url) => (await fetch(`${url}${url.includes('?') ? '&' : '?'}cb=${Date.now()}`)).text();

/**
 * Put a page back by UNDOING, not by writing.
 *
 * Writing the old tree back restores the content and leaves a snapshot behind,
 * so a verifier that "puts everything back" still grows the Undo ring — and
 * the 1A verifier's "Undo with nothing left says so rather than pretending"
 * then pops one of ours and fails. Undoing exactly as many times as we wrote
 * walks the page back to where it started AND leaves the ring the depth it
 * was, so the scripts stop depending on the order they are run in.
 */
async function rewindTo(pageId, snapshotFloor) {
  for (let i = 0; i < 40; i++) {
    const read = await call(`/pages/${pageId}/sections`);
    const count = Number(read.json?.snapshot_count || 0);
    if (count <= snapshotFloor) return count;
    const undone = await call(`/pages/${pageId}/undo`, { method: 'POST', body: {} });
    if (undone.json?.restored === false) return count;
  }
  return -1;
}

/** A 4x4 PNG — enough to prove the upload path, too small to make sizes. */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAF0lEQVR42mNk+M9QzwAFjDAGABLAAv9EnHkAAAAASUVORK5CYII=';

/**
 * A real 1600x1000 PNG, built here so the script needs no fixture file.
 *
 * The srcset check NEEDS a picture WordPress will actually make sizes from.
 * A tiny one produces no `-300x188` variants, so `wp_get_attachment_image_srcset`
 * returns false and the page carries no srcset — which would read as "the
 * feature does not work" when it is the fixture that is too small. That is a
 * false negative, and a false negative in a verifier is worse than no check.
 */
function bigPngBase64(width = 1600, height = 1000) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[o++] = Math.floor((x * 255) / width);
      raw[o++] = Math.floor((y * 255) / height);
      raw[o++] = 140;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    let c = ~0;
    for (const b of body) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
    const crc = Buffer.alloc(4); crc.writeUInt32BE((~c) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

/** The routing attributes of the first form widget in a tree. */
function formWire(tree) {
  let found = null;
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.widgetType === 'form' && !found) {
      found = {
        form_css_class: n.settings?.form_css_class,
        email_to: n.settings?.email_to,
        form_name: n.settings?.form_name,
        fields: JSON.stringify(n.settings?.form_fields || []),
      };
    }
    (n.elements || []).forEach(walk);
  };
  walk(tree);
  return found;
}

(async () => {
  console.log(`\n=== site builder Phase 2 verification against ${BASE} ===\n`);

  const list = await call('/pages');
  const pages = list.json?.pages || [];
  const home = pages.find((p) => p.title === 'Home');
  const contactPage = pages.find((p) => p.title === 'Contact');
  check('the fixture site answers with its pages', pages.length > 0 && !!home, `${pages.length} pages`);
  if (!home) { report(); return; }

  /* ── 1. the media library ───────────────────────────────────────────── */

  const seeded = [];
  for (const name of ['verify-p2-a', 'verify-p2-b', 'verify-p2-c']) {
    const up = await call('/media/sideload', {
      method: 'POST',
      body: { filename: `${name}.png`, content_type: 'image/png', data_base64: PNG_B64, alt: '' },
    });
    if (up.status === 201) seeded.push(up.json);
  }
  check('a picture uploads through the site token alone (no app password)',
    seeded.length === 3 && seeded.every((s) => s.url && s.attachment_id),
    `${seeded.length} uploaded`);

  const lib = await call('/media?page=1&per_page=2');
  check('GET /media answers a PAGE, not the whole library',
    lib.status === 200 && Array.isArray(lib.json?.items) && lib.json.items.length === 2
      && lib.json.total >= 3 && lib.json.total_pages >= 2,
    `status ${lib.status}, ${lib.json?.items?.length} of ${lib.json?.total} on ${lib.json?.total_pages} pages`);

  const page2 = await call('/media?page=2&per_page=2');
  const idsA = (lib.json?.items || []).map((i) => i.attachment_id);
  const idsB = (page2.json?.items || []).map((i) => i.attachment_id);
  check('page 2 is different pictures from page 1',
    idsB.length > 0 && idsB.every((id) => !idsA.includes(id)),
    `p1 ${idsA.join(',')} · p2 ${idsB.join(',')}`);

  const found = await call('/media?search=verify-p2-b');
  check('search finds a picture by its file name',
    (found.json?.items || []).some((i) => String(i.filename).includes('verify-p2-b')),
    (found.json?.items || []).map((i) => i.filename).join(', '));

  const missing = await call('/media?search=zzz-nothing-like-this');
  check('a search that matches nothing returns an EMPTY page, not everything',
    missing.status === 200 && (missing.json?.items || []).length === 0,
    `${missing.json?.items?.length} items`);

  const target = seeded[0];
  const ALT = 'A cedar-clad garden room at dusk';
  const alted = await call(`/media/${target.attachment_id}/alt`, { method: 'POST', body: { alt: ALT } });
  check('POST /media/:id/alt stores the description', alted.status === 200 && alted.json?.alt === ALT,
    `status ${alted.status}`);

  const reread = await call('/media?search=verify-p2-a');
  const back = (reread.json?.items || []).find((i) => i.attachment_id === target.attachment_id);
  check('the description reads back on the picture itself', back?.alt === ALT, JSON.stringify(back?.alt));

  check('the library reports the rendered sizes srcset is built from',
    Array.isArray(back?.sizes), `sizes: ${JSON.stringify(back?.sizes?.map((s) => s.name))}`);

  /* ── 2. an attachment id on the page means a real srcset ────────────── */

  const homeRead = await call(`/pages/${home.page_id}/sections`);
  const homeTree = homeRead.json?.elementor_data || [];
  const homeBefore = JSON.stringify(homeTree);
  const homeSnapsBefore = Number(homeRead.json?.snapshot_count || 0);
  const homeParsed = reduceToSectionList(homeTree);
  const originalHeadline = homeParsed[0]?.fields?.headline;

  // Put a library picture on the hero background, id and all.
  const heroEdited = homeParsed.map((s, i) => (i === 0
    ? {
      handle: s.handle,
      node: applyFields(s.node, s.kind, {
        ...s.fields,
        image_url: target.url,
        image_id: target.attachment_id,
      }),
    }
    : { handle: s.handle, node: s.node }));

  const heroSaved = await call(`/pages/${home.page_id}/sections`, { method: 'POST', body: { sections: heroEdited } });
  check('a picture chosen from the library saves with its attachment id',
    heroSaved.status === 200 && heroSaved.json?.success === true, `status ${heroSaved.status}`);

  const heroBack = await call(`/pages/${home.page_id}/sections`);
  check('the attachment id reads back off the page',
    Number(heroBack.json?.sections?.[0]?.fields?.image_id) === Number(target.attachment_id),
    JSON.stringify(heroBack.json?.sections?.[0]?.fields?.image_id));

  /* ── 2b. the PHP mirror and the JS schema agree, field for field ────── */

  // The plugin carries its own READ-side mirror of sectionSchema.js BINDINGS.
  // Two tables, both pure data, both internally consistent — which is exactly
  // how they drifted: the plugin did not know about `image_id` and would have
  // written '' over it on the next save. Nothing but a live comparison can
  // catch that, so here it is, on every archetype the fixture has.
  const norm = (v) => JSON.stringify(v, Object.keys(v || {}).sort());
  let mirrorOk = true;
  const mirrorDetail = [];
  for (const p of pages.filter((x) => x.ia_managed)) {
    const read = await call(`/pages/${p.page_id}/sections`);
    const mine = reduceToSectionList(read.json?.elementor_data || []);
    const theirs = read.json?.sections || [];
    mine.forEach((s, i) => {
      if (!s.editable) return;
      const a = norm(s.fields);
      const b = norm(theirs[i]?.fields);
      if (a !== b) {
        mirrorOk = false;
        mirrorDetail.push(`${p.title} #${i} (${s.kind}):\n          arion  ${a}\n          plugin ${b}`);
      }
    });
  }
  check("the plugin's PHP mirror reads every field exactly as arion-api does",
    mirrorOk, mirrorDetail.join('\n        '));

  /* ── 2c. srcset on the LIVE page, which is the point of the id ──────── */

  const about = pages.find((p) => p.title === 'About us');
  if (about) {
    const bigUp = await call('/media/sideload', {
      method: 'POST',
      body: {
        filename: 'verify-p2-srcset.png',
        content_type: 'image/png',
        data_base64: bigPngBase64(),
        alt: 'A cedar-clad garden room at dusk',
      },
    });
    check('a full-size picture uploads and WordPress makes its sizes',
      bigUp.status === 201 && bigUp.json?.width === 1600, `status ${bigUp.status}`);

    const aRead = await call(`/pages/${about.page_id}/sections`);
    const aBefore = JSON.stringify(aRead.json?.elementor_data || []);
    const aSnapsBefore = Number(aRead.json?.snapshot_count || 0);
    const aParsed = reduceToSectionList(aRead.json?.elementor_data || []);
    const aboutIdx = aParsed.findIndex((s) => s.kind === 'about');

    if (aboutIdx >= 0 && bigUp.json?.attachment_id) {
      const aEdited = aParsed.map((s, i) => (i === aboutIdx
        ? {
          handle: s.handle,
          node: applyFields(s.node, s.kind, {
            ...s.fields,
            image_url: bigUp.json.url,
            image_id: bigUp.json.attachment_id,
            image_alt: 'A cedar-clad garden room at dusk',
          }),
        }
        : { handle: s.handle, node: s.node }));
      const aSaved = await call(`/pages/${about.page_id}/sections`, { method: 'POST', body: { sections: aEdited } });
      check('the About page publishes with the library picture on it', aSaved.status === 200);

      const aboutHtml = await fetchHtml(about.permalink);
      const img = /<img[^>]*verify-p2-srcset[^>]*>/.exec(aboutHtml)?.[0] || '';
      check('the live page renders a real srcset AND sizes — the whole point of the id',
        /srcset="/.test(img) && /sizes="/.test(img) && /\s\d+w/.test(img),
        img ? img.slice(0, 220) : 'the picture is not on the page at all');
      check('the description reached the page as the img alt',
        /alt="A cedar-clad garden room at dusk"/.test(img), img.slice(0, 220));

      // Put About back by UNDOING, so the ring is the depth we found it too.
      const aDepth = await rewindTo(about.page_id, aSnapsBefore);
      const aBack = await call(`/pages/${about.page_id}/sections`);
      check('About us is back exactly as it was found, ring included',
        JSON.stringify(aBack.json?.elementor_data) === aBefore && aDepth === aSnapsBefore,
        `ring ${aDepth} (started ${aSnapsBefore})`);
    } else {
      check('the fixture About page has an editable about section', false);
    }
  }

  /* ── 3. the pixel survives every edit ───────────────────────────────── */

  const liveHome = await fetchHtml(home.permalink);
  check('the SPARK visitor pixel is still in the page AFTER an edit',
    /tracking\/pixel\.js/.test(liveHome), 'pixel script tag not found');
  check('the ARGUS beacon is still in the page AFTER an edit',
    /webhooks\/beacon|ia-argus-beacon/.test(liveHome), 'beacon not found');

  /* ── 4. the form's wires survive a save that touched something else ─── */

  if (contactPage) {
    const cRead = await call(`/pages/${contactPage.page_id}/sections`);
    const cTree = cRead.json?.elementor_data || [];
    const cBefore = formWire(cTree);
    const cParsed = reduceToSectionList(cTree);
    const formIdx = cParsed.findIndex((s) => s.kind === 'contact');

    check('the fixture contact form is addressed and typed',
      !!cBefore && !!cBefore.email_to && /^ia-/.test(String(cBefore.form_css_class)),
      JSON.stringify(cBefore));

    if (formIdx >= 0 && cBefore) {
      const cEdited = cParsed.map((s, i) => (i === formIdx
        ? {
          handle: s.handle,
          node: applyFields(s.node, s.kind, { ...s.fields, headline: `Talk to us ${Date.now()}` }),
        }
        : { handle: s.handle, node: s.node }));
      const cSaved = await call(`/pages/${contactPage.page_id}/sections`, { method: 'POST', body: { sections: cEdited } });
      check('the contact page saves', cSaved.status === 200, `status ${cSaved.status}`);

      const cAfter = await call(`/pages/${contactPage.page_id}/sections`);
      const cWire = formWire(cAfter.json?.elementor_data || []);
      check('every form routing attribute is byte-identical after that save',
        JSON.stringify(cWire) === JSON.stringify(cBefore),
        `before ${JSON.stringify(cBefore)}\n        after  ${JSON.stringify(cWire)}`);

      // Put it back by undoing the one save we made, so the ring is level.
      await call(`/pages/${contactPage.page_id}/undo`, { method: 'POST', body: {} });
      const cFinal = await call(`/pages/${contactPage.page_id}/sections`);
      check('the Contact page is back exactly as it was found, ring included',
        JSON.stringify(cFinal.json?.elementor_data) === JSON.stringify(cTree)
          && Number(cFinal.json?.snapshot_count || 0) === Number(cRead.json?.snapshot_count || 0));
    }
  } else {
    check('the fixture has a Contact page to test the form wires on', false, 'no Contact page');
  }

  /* ── 5. the Book now button ─────────────────────────────────────────── */

  const cfgBefore = await call('/booking-config');
  check('GET /booking-config answers', cfgBefore.status === 200, `status ${cfgBefore.status}`);

  const BOOK = 'http://localhost:8099/book/';
  const cfgSet = await call('/booking-config', { method: 'POST', body: { booking_url: BOOK } });
  check('ARION can push the booking address to the site',
    cfgSet.status === 200 && cfgSet.json?.booking_url === BOOK, JSON.stringify(cfgSet.json));

  const tierAllows = cfgSet.json?.tier_allows === true;
  const withButton = await fetchHtml(`${BASE}/?ia_p2=1`);
  if (tierAllows) {
    check('the site now carries the Book now stylesheet the shortcode needs',
      /ia-book-now-css/.test(withButton), 'no ia-book-now-css in the head');
  } else {
    check('a Lite site renders NO booking button, because it has no booking page',
      !/ia-book-now-css/.test(withButton) && !/ia-book-now/.test(withButton),
      'a Lite site is offering a button');
  }

  const cfgCleared = await call('/booking-config', { method: 'POST', body: { booking_url: '' } });
  check('an EMPTY push takes the button back off — a booking page can go away',
    cfgCleared.status === 200 && cfgCleared.json?.booking_url === '', JSON.stringify(cfgCleared.json));
  const withoutButton = await fetchHtml(`${BASE}/?ia_p2=2`);
  check('and the page stops carrying it', !/ia-book-now-css/.test(withoutButton));

  const badUrl = await call('/booking-config', { method: 'POST', body: { booking_url: 'javascript:alert(1)' } });
  check('a booking address that is not http(s) is refused', badUrl.status === 400, `status ${badUrl.status}`);

  /* ── 6. break it on purpose ─────────────────────────────────────────── */

  const noToken = await call('/media', { token: '' });
  check('no site token -> 401, never a picture list',
    noToken.status === 401 && !Array.isArray(noToken.json?.items), `status ${noToken.status}`);

  const badToken = await call('/media', { token: 'not-the-token' });
  check('a wrong site token -> 401 on the library too', badToken.status === 401, `status ${badToken.status}`);

  const ghostAlt = await call('/media/9999999/alt', { method: 'POST', body: { alt: 'x' } });
  check('describing a picture that does not exist -> 404, with words',
    ghostAlt.status === 404 && typeof ghostAlt.json?.error === 'string', `status ${ghostAlt.status}`);

  const noAlt = await call(`/media/${target.attachment_id}/alt`, { method: 'POST', body: {} });
  check('an alt call with no alt at all -> 400', noAlt.status === 400, `status ${noAlt.status}`);

  const noTokenCfg = await call('/booking-config', { method: 'POST', body: { booking_url: BOOK }, token: '' });
  check('the booking config cannot be set without the site token',
    noTokenCfg.status === 401, `status ${noTokenCfg.status}`);

  /* ── put Home back, ring and all ────────────────────────────────────── */
  const homeDepth = await rewindTo(home.page_id, homeSnapsBefore);
  const restored = await call(`/pages/${home.page_id}/sections`);
  check('Home is back exactly as it was found, ring included',
    restored.json?.sections?.[0]?.fields?.headline === originalHeadline
      && JSON.stringify(restored.json?.elementor_data) === homeBefore
      && homeDepth === homeSnapsBefore,
    `ring ${homeDepth} (started ${homeSnapsBefore})`);

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
