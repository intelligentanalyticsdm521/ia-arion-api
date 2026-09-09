#!/usr/bin/env node
/**
 * _dev_verify_pack2.mjs — drive the ARION pack 2 plugin routes against the dev
 * WordPress container and print a PASS/FAIL matrix.
 *
 * This is the half of the exhaustive test that cannot be a unit test. Whether
 * a menu really appears in a theme's header, whether a colour written into
 * Elementor's kit actually reaches the rendered CSS, whether the chat bubble
 * really stops being injected, and whether a blog post really renders — all of
 * that lives in PHP against a real WordPress with a real theme.
 *
 * It asserts on the CONTENT COMING BACK and on the RENDERED PAGE, not on the
 * absence of an error (memory: feedback_assert_presence_not_just_absence), it
 * BREAKS THINGS ON PURPOSE (memory: feedback_mutation_test_your_guards), and
 * it puts every menu, colour, setting and page back the way it found them.
 *
 * ⚠ Dev only. It refuses to run against anything but a loopback host.
 * ⚠ It needs the PACK 2 PLUGIN mounted (>= 1.7.4):
 *     dev-stack\start-dev-wp.ps1 -PluginDir C:\dev\iadm\ia-plugin-septa-arion2
 *
 *   node scripts/_dev_verify_pack2.mjs [--base http://localhost:8084]
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
const PLUGIN_DIR = arg('plugin-dir', 'C:\\dev\\iadm\\ia-plugin-septa-arion2');
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

/** Docker's port forwarder drops connections when a container starts/stops. */
async function fetchRetry(url, init, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, init); } catch (err) {
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

/** The rendered page, as a visitor sees it. */
async function html(url) {
  if (!url) return { status: 0, body: '' };
  const res = await fetchRetry(`${url}${url.includes('?') ? '&' : '?'}_ia_nc=${Date.now()}`, {
    headers: { 'Cache-Control': 'no-cache' },
  });
  return { status: res.status, body: await res.text() };
}

/** wp-cli in the dev container. Used only to break things and put them back. */
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

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

(async () => {
  console.log(`\n=== ARION pack 2 verification against ${BASE} ===\n`);

  /* ══════════════ 0. the plugin build that answers these ══════════════ */
  const status = await call('/status');
  check('the site is answering, and running the pack 2 plugin',
    status.status === 200 && String(status.json?.data?.plugin_version || '') >= '1.7.4',
    String(status.json?.data?.plugin_version));

  /* ══════════════ 1. MENUS ════════════════════════════════════════════ */
  console.log('\n-- menus --');
  const before = await call('/menus');
  check('GET /menus lists the menus, the positions and what can be added',
    before.status === 200 && Array.isArray(before.json?.menus) && Array.isArray(before.json?.locations),
    `status ${before.status}`);
  const menu = (before.json?.menus || [])[0];
  check('there is a menu to work with', !!menu, menu ? `#${menu.menu_id}` : 'none');
  if (!menu) { console.log('\ncannot continue without a menu\n'); process.exit(1); }

  const menuId = menu.menu_id;
  const itemsBefore = JSON.stringify(menu.items.map((i) => [i.title, i.kind, i.object_id, i.url, i.parent_item_id]));
  const locationsBefore = [...menu.locations];
  const addable = before.json?.addable || [];
  const aPage = addable.find((a) => a.kind === 'page' && a.status === 'publish');
  check('the pages a client could add are offered', !!aPage, `${addable.length} things`);

  // Add a page, a nested child and the booking link, and put it in the header.
  const wanted = [
    ...menu.items.map((i) => ({ item_id: i.item_id, kind: i.kind, object_id: i.object_id, title: i.title, url: i.url })),
    { kind: 'page', object_id: aPage.object_id },
    { kind: 'custom', title: 'Call us', url: 'tel:+15555550123' },
  ];
  wanted[wanted.length - 1].parent_index = wanted.length - 2;
  if (before.json?.booking?.url) {
    wanted.push({ kind: 'custom', title: before.json.booking.label, url: before.json.booking.url });
  }
  const wrote = await call(`/menus/${menuId}`, {
    method: 'PUT',
    body: { items: wanted, locations: ['menu-1'] },
  });
  const after = (wrote.json?.menus || []).find((m) => m.menu_id === menuId);
  check('a whole menu can be written in one go', wrote.status === 200 && !!after, `status ${wrote.status} ${wrote.text.slice(0, 150)}`);
  check('...with the page that was added on it',
    !!after && after.items.some((i) => i.kind === 'page' && i.object_id === aPage.object_id));
  check('...and the phone link nested under it',
    !!after && after.items.some((i) => /^tel:/.test(i.url) && i.parent_item_id > 0),
    JSON.stringify((after?.items || []).map((i) => [i.title, i.parent_item_id])));
  check('...and it is in the header position', !!after && after.locations.includes('menu-1'),
    JSON.stringify(after?.locations));

  const home = await html(BASE);
  check('the new entry really shows on the website', home.body.includes(aPage.title),
    `page ${home.status}`);
  check('...and so does the phone link', home.body.includes('tel:+15555550123'));

  // BREAK IT ON PURPOSE: a link a browser cannot follow.
  const badLink = await call(`/menus/${menuId}`, {
    method: 'PUT',
    body: { items: [{ kind: 'custom', title: 'Bad', url: 'javascript:alert(1)' }] },
  });
  check('a link that is not a web address is REFUSED', badLink.status === 400,
    `status ${badLink.status}`);
  check('...in a sentence, with a code the Portal can branch on',
    badLink.json?.code === 'bad_item' && /web address/i.test(String(badLink.json?.error || '')),
    String(badLink.json?.error).slice(0, 120));
  const untouched = await call('/menus');
  const stillThere = (untouched.json?.menus || []).find((m) => m.menu_id === menuId);
  check('...and the refused write changed NOTHING',
    !!stillThere && stillThere.items.length === after.items.length,
    `${stillThere?.items.length} vs ${after.items.length}`);

  // A page that is not on this website cannot go in a menu.
  const ghost = await call(`/menus/${menuId}`, {
    method: 'PUT', body: { items: [{ kind: 'page', object_id: 99999 }] },
  });
  check('a page that is not on this website is refused', ghost.status === 400, `status ${ghost.status}`);

  // A position this design does not have is refused BEFORE anything is written.
  const badLoc = await call(`/menus/${menuId}`, {
    method: 'PUT', body: { locations: ['not-a-real-position'] },
  });
  check('a menu position this website does not have is refused', badLoc.status === 400,
    `status ${badLoc.status}`);

  const undone = await call(`/menus/${menuId}/undo`, { method: 'POST', body: {} });
  const restored = (undone.json?.menus || []).find((m) => m.menu_id === menuId);
  check('Undo puts the previous menu back', undone.status === 200 && undone.json?.restored === true);
  check('...exactly as it was',
    JSON.stringify((restored?.items || []).map((i) => [i.title, i.kind, i.object_id, i.url, i.parent_item_id])) === itemsBefore,
    JSON.stringify((restored?.items || []).map((i) => i.title)));

  // Put the location back the way it was, since Undo covers items, not places.
  await call(`/menus/${menuId}`, { method: 'PUT', body: { locations: locationsBefore } });

  /* ══════════════ 2. THE BRAND KIT ════════════════════════════════════ */
  console.log('\n-- brand colours and fonts --');
  const kitBefore = await call('/site/kit');
  check('GET /site/kit reads Elementor\'s own live kit',
    kitBefore.status === 200 && Number(kitBefore.json?.kit_id) > 0, `status ${kitBefore.status}`);
  const kitId = Number(kitBefore.json?.kit_id);
  const coloursBefore = JSON.stringify(kitBefore.json?.colors || []);
  const fontsBefore = JSON.stringify(kitBefore.json?.typography || []);

  const kitWrote = await call('/site/kit', {
    method: 'POST',
    body: {
      colors: [{ id: 'primary', color: '#123456' }, { id: 'accent', color: '#ABCDEF' }],
      typography: [{ id: 'primary', font_family: 'Plus Jakarta Sans', font_weight: '700' }],
    },
  });
  check('colours and fonts can be written', kitWrote.status === 200, `status ${kitWrote.status} ${kitWrote.text.slice(0, 150)}`);
  const primary = (kitWrote.json?.colors || []).find((c) => c.id === 'primary');
  check('...and the website is really holding them', primary?.color === '#123456', JSON.stringify(primary));
  const font = (kitWrote.json?.typography || []).find((t) => t.id === 'primary');
  check('...including the font', font?.font_family === 'Plus Jakarta Sans', JSON.stringify(font));

  // The value has to reach the KIT POST Elementor reads, not just our answer.
  const kitMeta = wp(['post', 'meta', 'get', String(kitId), '_elementor_page_settings', '--format=json']);
  check('...in the meta Elementor itself reads (_elementor_page_settings)',
    kitMeta.includes('#123456'), kitMeta.slice(0, 160));

  // BREAK IT ON PURPOSE.
  const badColour = await call('/site/kit', { method: 'POST', body: { colors: [{ id: 'primary', color: 'tomato' }] } });
  check('a colour that is not a colour is REFUSED', badColour.status === 400, `status ${badColour.status}`);
  const stillBlue = await call('/site/kit');
  check('...and nothing changed', (stillBlue.json?.colors || []).find((c) => c.id === 'primary')?.color === '#123456');

  const noFont = await call('/site/kit', { method: 'POST', body: { typography: [{ id: 'primary', font_family: '' }] } });
  check('a font with no name is refused', noFont.status === 400, `status ${noFont.status}`);

  const nothing = await call('/site/kit', { method: 'POST', body: {} });
  check('a save with nothing in it is refused rather than reported as saved', nothing.status === 400);

  /* ══════════════ 3. THE HEADER AND THE FOOTER ════════════════════════ */
  console.log('\n-- header and footer --');
  const chromeBefore = await call('/site/chrome');
  check('GET /site/chrome names the design and what it offers',
    chromeBefore.status === 200 && !!chromeBefore.json?.theme && Array.isArray(chromeBefore.json?.fields),
    `status ${chromeBefore.status}`);
  const fieldsBefore = Object.fromEntries((chromeBefore.json?.fields || []).map((f) => [f.key, f.value]));
  const supported = (chromeBefore.json?.fields || []).filter((f) => f.supported).map((f) => f.key);
  check('...including the business name, which every design has',
    supported.includes('business_name'), supported.join(','));
  const unsupported = (chromeBefore.json?.fields || []).filter((f) => !f.supported);
  check('anything the design does NOT offer comes back with a reason, not missing',
    unsupported.every((f) => typeof f.reason === 'string' && f.reason.length > 10),
    JSON.stringify(unsupported.map((f) => [f.key, f.reason])).slice(0, 200));

  const FOOTER = 'Pack 2 footer line, put back afterwards';
  const chromeWrote = await call('/site/chrome', {
    method: 'POST', body: { business_name: 'Pack 2 Test Business', footer_text: FOOTER },
  });
  check('the business name and the footer wording can be set',
    chromeWrote.status === 200, `status ${chromeWrote.status} ${chromeWrote.text.slice(0, 150)}`);
  const now = Object.fromEntries((chromeWrote.json?.fields || []).map((f) => [f.key, f.value]));
  check('...and read back as what was asked for',
    now.business_name === 'Pack 2 Test Business' && now.footer_text === FOOTER,
    JSON.stringify([now.business_name, now.footer_text]));

  const rendered = await html(BASE);
  check('the footer wording really appears on the website', rendered.body.includes(FOOTER));
  check('...and so does the business name', rendered.body.includes('Pack 2 Test Business'));

  // BREAK IT ON PURPOSE: a key we do not own, and an empty business name.
  const notOurs = await call('/site/chrome', { method: 'POST', body: { admin_email: 'x@y.z' } });
  check('a setting we do not own is REFUSED, never quietly ignored',
    notOurs.status === 400 && notOurs.json?.code === 'not_in_whitelist', `status ${notOurs.status}`);
  const emptyName = await call('/site/chrome', { method: 'POST', body: { business_name: '   ' } });
  check('an empty business name is refused', emptyName.status === 400, `status ${emptyName.status}`);
  const stillNamed = await call('/site/chrome');
  check('...and the name is untouched',
    (stillNamed.json?.fields || []).find((f) => f.key === 'business_name')?.value === 'Pack 2 Test Business');

  const badLogo = await call('/site/chrome', { method: 'POST', body: { logo_id: 987654 } });
  check('a logo that is not in this website\'s library is refused', badLogo.status === 400, `status ${badLogo.status}`);

  /* ══════════════ 4. THE TWO SITE SWITCHES ════════════════════════════ */
  console.log('\n-- the chat bubble and the Book now button --');
  const optsBefore = await call('/site/options');
  check('GET /site/options reads both switches',
    optsBefore.status === 200 && typeof optsBefore.json?.chat?.enabled === 'boolean',
    `status ${optsBefore.status}`);
  const chatWas = optsBefore.json.chat.enabled;
  const headerWas = optsBefore.json.booking.in_header;
  const labelWas = optsBefore.json.booking.label;

  await call('/site/options', { method: 'POST', body: { chat_enabled: true } });
  const withChat = await html(BASE);
  check('with the chat bubble ON, the website really carries it',
    /ia-chat-widget|ia_chat|ia-chat/i.test(withChat.body));

  const chatOff = await call('/site/options', { method: 'POST', body: { chat_enabled: false } });
  check('the chat bubble can be switched off', chatOff.status === 200 && chatOff.json?.chat?.enabled === false);
  const withoutChat = await html(BASE);
  check('...and it really stops being on the website',
    !/ia-chat-widget\.js/i.test(withoutChat.body));

  const labelled = await call('/site/options', { method: 'POST', body: { booking_in_header: true, booking_label: 'Book a visit' } });
  check('the Book now button can be switched on and reworded',
    labelled.status === 200 && labelled.json?.booking?.label === 'Book a visit',
    `status ${labelled.status} ${labelled.text.slice(0, 150)}`);
  const withButton = await html(BASE);
  check('...and the new wording really appears on the website',
    withButton.body.includes('Book a visit'));

  const notASetting = await call('/site/options', { method: 'POST', body: { admin_email: 'x@y.z' } });
  check('a setting we do not own is REFUSED here too',
    notASetting.status === 400 && notASetting.json?.code === 'not_in_whitelist');
  const badChatUrl = await call('/site/options', { method: 'POST', body: { chat_fallback_url: 'not a url' } });
  check('a fallback that is not a web address is refused', badChatUrl.status === 400);

  await call('/site/options', {
    method: 'POST',
    body: { chat_enabled: chatWas, booking_in_header: headerWas, booking_label: labelWas },
  });

  /* ══════════════ 5. THE THREE NEW SECTIONS, RENDERED ═════════════════ */
  console.log('\n-- pricing, team and stats --');
  const { blockToElementorSection } = await import('../lib/websiteBuilder/elementorAdapter.js');
  const made = await call('/pages', {
    method: 'POST',
    body: {
      title: 'Pack 2 scratch page',
      sections: [{
        node: blockToElementorSection({
          kind: 'pricing',
          block: {
            headline: 'Pack 2 prices',
            subheadline: '',
            plans: [{
              name: 'Weekly mow', price: '$45', period: 'per visit',
              summary: 'Tidy every week', features: ['Mow', 'Edge'],
              cta_text: 'Book', cta_href: '#contact', offering_id: 'pack2-o1',
            }],
          },
          brand: {}, seedId: 'pack2-pricing', blockId: 'p2',
        }),
      }],
    },
  });
  const scratchId = Number(made.json?.page_id || 0);
  check('a page can be created carrying a pricing section', made.status === 201 && scratchId > 0,
    `status ${made.status} ${made.text.slice(0, 150)}`);

  if (scratchId) {
    const withAll = await call(`/pages/${scratchId}/sections`, {
      method: 'POST',
      body: {
        status: 'publish',
        sections: [
          { node: blockToElementorSection({ kind: 'pricing', block: { headline: 'Pack 2 prices', subheadline: '', plans: [{ name: 'Weekly mow', price: '$45', period: 'per visit', summary: 'Tidy every week', features: ['Mow', 'Edge'], cta_text: 'Book', cta_href: '#contact', offering_id: 'pack2-o1' }] }, brand: {}, seedId: 'p2a', blockId: 'p2a' }) },
          { node: blockToElementorSection({ kind: 'team', block: { headline: 'Pack 2 people', subheadline: '', members: [{ name: 'Sam Fielding', role: 'Crew lead', photo_url: '', photo_alt: '', photo_id: '' }] }, brand: {}, seedId: 'p2b', blockId: 'p2b' }) },
          { node: blockToElementorSection({ kind: 'stats', block: { headline: 'Pack 2 numbers', subheadline: '', stats: [{ value: '12', prefix: '', suffix: '+', label: 'Years doing this' }] }, brand: {}, seedId: 'p2c', blockId: 'p2c' }) },
        ],
      },
    });
    check('all three new kinds save onto a page', withAll.status === 200 && withAll.json?.sections_saved === 3,
      `status ${withAll.status} ${withAll.text.slice(0, 150)}`);

    const view = await html(String(withAll.json?.permalink || ''));
    check('the PRICE really renders on the page', view.body.includes('$45'), `page ${view.status}`);
    check('...with what is included', view.body.includes('Weekly mow') && view.body.includes('Edge'));
    check('the PERSON really renders', view.body.includes('Sam Fielding') && view.body.includes('Crew lead'));
    check('the NUMBER really renders', view.body.includes('Years doing this') && /12/.test(view.body));

    // And the editor can read every one of them back out again.
    const readBack = await call(`/pages/${scratchId}/sections`);
    const kinds = (readBack.json?.sections || []).map((s) => s.kind);
    check('the editor sees all three as sections it can edit',
      ['pricing', 'team', 'stats'].every((k) => kinds.includes(k)), kinds.join(','));
    check('...and none of them is locked',
      (readBack.json?.sections || []).every((s) => s.editable !== false),
      JSON.stringify((readBack.json?.sections || []).map((s) => [s.kind, s.editable])));
  }

  /* ══════════════ 6. A BLOG POST, END TO END ══════════════════════════ */
  console.log('\n-- writing a blog post --');
  const post = await call('/pages', { method: 'POST', body: { title: 'Pack 2 test post', type: 'post' } });
  const postId = Number(post.json?.page_id || 0);
  check('a blog post can be created from the Portal', post.status === 201 && postId > 0 && post.json?.type === 'post',
    `status ${post.status} ${post.text.slice(0, 150)}`);

  const media = await call('/media/sideload', {
    method: 'POST',
    body: { filename: 'pack2-post.png', content_type: 'image/png', data_base64: PNG_1x1 },
  });
  const attId = Number(media.json?.attachment_id || 0);

  if (postId) {
    const body = await call(`/pages/${postId}/sections`, {
      method: 'POST',
      body: {
        status: 'publish',
        sections: [{
          node: blockToElementorSection({
            kind: 'about',
            block: {
              headline: 'Autumn lawn care',
              subheadline: '',
              story_paragraphs: ['What to do with a lawn in October.'],
              values: [], image_alt: '',
            },
            brand: {}, seedId: 'p2post', blockId: 'p2post',
          }),
        }],
      },
    });
    check('a post is written in the same section editor as a page', body.status === 200,
      `status ${body.status} ${body.text.slice(0, 150)}`);

    const details = await call(`/pages/${postId}/settings`, {
      method: 'POST',
      body: {
        excerpt: 'A short version for the list.',
        categories: ['Pack 2 Category'],
        tags: ['pack2', 'autumn'],
        featured_image_id: attId,
      },
    });
    check('its categories, tags, summary and picture save', details.status === 200,
      `status ${details.status} ${details.text.slice(0, 200)}`);
    const pf = details.json?.post_fields;
    check('...and the website is really holding them',
      pf?.excerpt === 'A short version for the list.'
      && pf?.categories?.includes('Pack 2 Category')
      && pf?.tags?.includes('pack2')
      && Number(pf?.featured_image?.id) === attId,
      JSON.stringify(pf));

    const live = await html(String(details.json?.permalink || ''));
    check('the post really renders on the website', live.body.includes('Autumn lawn care'), `page ${live.status}`);

    // The same fields on a PAGE are refused rather than dropped.
    const pageList = await call('/pages');
    const anyPage = (pageList.json?.pages || []).find((p) => p.type === 'page' && p.status === 'publish');
    if (anyPage) {
      const wrongType = await call(`/pages/${anyPage.page_id}/settings`, {
        method: 'POST', body: { categories: ['Nope'] },
      });
      check('a category on a PAGE is refused, not silently dropped',
        wrongType.status === 400 && wrongType.json?.code === 'not_a_post',
        `status ${wrongType.status}`);
    }

    // Into the bin and back, exactly as a page does.
    const trashed = await call(`/pages/${postId}/trash`, { method: 'POST', body: {} });
    check('a post goes in the bin', trashed.status === 200 && trashed.json?.status === 'trash');
    const back = await call(`/pages/${postId}/restore`, { method: 'POST', body: {} });
    check('...and comes back as a draft, not straight onto the website',
      back.status === 200 && back.json?.status === 'draft', String(back.json?.status));
  }

  /* ══════════════ 7. PUT EVERYTHING BACK ═════════════════════════════ */
  console.log('\n-- putting it all back --');
  if (postId) wp(['post', 'delete', String(postId), '--force']);
  if (scratchId) wp(['post', 'delete', String(scratchId), '--force']);
  if (attId) wp(['post', 'delete', String(attId), '--force']);
  try { wp(['term', 'delete', 'category', 'pack-2-category', '--by=slug']); } catch { /* may not exist */ }
  try { wp(['term', 'delete', 'post_tag', 'pack2', '--by=slug']); } catch { /* may not exist */ }
  try { wp(['term', 'delete', 'post_tag', 'autumn', '--by=slug']); } catch { /* may not exist */ }

  await call('/site/chrome', {
    method: 'POST',
    body: Object.fromEntries(Object.entries(fieldsBefore).filter(([k, v]) => (
      ['business_name', 'tagline', 'footer_text'].includes(k) && v !== null && v !== undefined
    ))),
  });
  await call('/site/kit', {
    method: 'POST',
    body: {
      colors: JSON.parse(coloursBefore).map((c) => ({ id: c.id, color: c.color })).filter((c) => c.color),
      typography: JSON.parse(fontsBefore)
        .filter((t) => t.font_family)
        .map((t) => ({ id: t.id, font_family: t.font_family, font_weight: t.font_weight })),
    },
  });

  const finalMenus = await call('/menus');
  const finalMenu = (finalMenus.json?.menus || []).find((m) => m.menu_id === menuId);
  check('the menu is exactly as it was found',
    JSON.stringify((finalMenu?.items || []).map((i) => [i.title, i.kind, i.object_id, i.url, i.parent_item_id])) === itemsBefore,
    JSON.stringify((finalMenu?.items || []).map((i) => i.title)));
  check('...and back in the positions it was in',
    JSON.stringify([...(finalMenu?.locations || [])].sort()) === JSON.stringify([...locationsBefore].sort()),
    JSON.stringify(finalMenu?.locations));

  const finalChrome = await call('/site/chrome');
  const finalFields = Object.fromEntries((finalChrome.json?.fields || []).map((f) => [f.key, f.value]));
  check('the business name is back', finalFields.business_name === fieldsBefore.business_name,
    `${finalFields.business_name} vs ${fieldsBefore.business_name}`);
  check('the footer wording is back', String(finalFields.footer_text || '') === String(fieldsBefore.footer_text || ''),
    `${finalFields.footer_text} vs ${fieldsBefore.footer_text}`);

  const finalOpts = await call('/site/options');
  check('both switches are back', finalOpts.json?.chat?.enabled === chatWas
    && finalOpts.json?.booking?.in_header === headerWas
    && finalOpts.json?.booking?.label === labelWas,
    JSON.stringify(finalOpts.json?.booking));

  const finalPages = await call('/pages');
  check('no page this run made is left behind',
    !(finalPages.json?.pages || []).some((p) => /^Pack 2 /.test(p.title)),
    (finalPages.json?.pages || []).filter((p) => /^Pack 2 /.test(p.title)).map((p) => p.title).join(','));

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nverification blew up:', err);
  process.exit(1);
});
