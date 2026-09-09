/**
 * Final walk fixes (2026-09-09) — the three things the pack merges exposed.
 *
 * D-81  THE BRAND KIT GOES THROUGH THE PLUGIN, AND ONLY THROUGH THE PLUGIN.
 *       Onboarding used to write it with wp-cli over SSH, against an option
 *       Elementor does not define and a meta key a kit's settings do not live
 *       in — so it had never branded one site while reporting that it had.
 *       These tests hold the new shape AND hold the door shut behind it: the
 *       onboarding path must not import the SSH writer again.
 *
 * D-82  A NEWSLETTER ISSUE BECOMES A BLOG POST THROUGH THE SAME PLUGIN PATH.
 *       `/arion/plugin/publish-newsletter` proxied to a plugin route that has
 *       never existed. The replacement composes the post out of the routes
 *       that DO exist, and — the part that matters — a post that did not land
 *       is reported as a failure, not as a 200 with a sad field in it.
 *
 * Every guard below was mutation-tested by breaking it on purpose and
 * watching this file go red. The tally is in the walk doc.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  setElementorGlobals, buildGlobalsPayload, kitBodyFromGlobals, pickDefaultFonts,
} from '../lib/elementorGlobals.js';
import { composePostFromHtml, htmlToPostSections, __test__ as postTest } from '../lib/websiteBuilder/postComposer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

/* ==========================================================================
 * D-81 — the brand kit
 * ======================================================================== */

test('D-81: the kit body says the same brand the Portal suggestion says', () => {
  const payload = buildGlobalsPayload({
    brandName: 'Summit Lawn',
    primaryColor: '#1A3A4A',
    secondaryColor: '#2E7D5B',
    accentColor: '#F2B705',
    headingFont: 'Inter',
    bodyFont: 'Inter',
  });
  const body = kitBodyFromGlobals(payload);

  // The plugin route's vocabulary, not Elementor's.
  assert.deepEqual(body.colors.map((c) => c.id).sort(), ['accent', 'primary', 'secondary', 'text']);
  assert.equal(body.colors.find((c) => c.id === 'primary').color, '#1A3A4A');
  assert.equal(body.colors.find((c) => c.id === 'accent').color, '#F2B705');
  assert.deepEqual(body.typography.map((t) => t.id), ['primary', 'secondary']);
  assert.equal(body.typography[0].font_family, 'Inter');
  assert.equal(body.typography[0].font_weight, '700');
  // Nothing is renamed twice: no Elementor-shaped keys survive into the body.
  assert.ok(!JSON.stringify(body).includes('_id'));
  assert.ok(!JSON.stringify(body).includes('typography_font_family'));
});

test('D-81: the colours reach the site through writeKit, and nowhere else', async () => {
  const calls = [];
  const res = await setElementorGlobals({
    site: { domain: 'example.test', site_token_raw: 'tok' },
    brandName: 'Summit Lawn',
    primaryColor: '#1A3A4A',
    secondaryColor: '#2E7D5B',
    accentColor: '#F2B705',
    writeKit: async (site, body, opts) => {
      calls.push({ site, body, opts });
      return { ok: true, status: 200, data: { kit_id: 42, colors: body.colors } };
    },
  });

  assert.equal(calls.length, 1, 'exactly one write, through the plugin');
  assert.equal(calls[0].site.domain, 'example.test');
  assert.equal(calls[0].body.colors.find((c) => c.id === 'primary').color, '#1A3A4A');
  assert.equal(res.ok, true);
  assert.equal(res.via, 'plugin');
  assert.equal(res.kit_id, 42);
  assert.deepEqual(res.applied, ['colors', 'typography']);
});

test('D-81: a refused kit write is a failure, never a green tick', async () => {
  const res = await setElementorGlobals({
    site: { domain: 'example.test', site_token_raw: 'tok' },
    primaryColor: '#111111',
    secondaryColor: '#222222',
    accentColor: '#333333',
    writeKit: async () => ({
      ok: false, status: 500, error: 'plugin_rejected',
      message: 'Your website did not keep: the primary colour.',
      data: { code: 'kit_not_persisted' },
    }),
  });
  assert.equal(res.ok, false);
  assert.deepEqual(res.applied, []);
  assert.equal(res.error, 'plugin_rejected');
  assert.match(res.message, /did not keep/);
});

test('D-81: no site and no brand colours are refused before any call is made', async () => {
  let called = false;
  const spy = async () => { called = true; return { ok: true, data: {} }; };

  const noSite = await setElementorGlobals({
    primaryColor: '#111111', secondaryColor: '#222222', accentColor: '#333333', writeKit: spy,
  });
  assert.equal(noSite.ok, false);
  assert.equal(noSite.error, 'no_domain_for_site');

  const noColour = await setElementorGlobals({
    site: { domain: 'example.test' }, primaryColor: 'tomato',
    secondaryColor: '#222222', accentColor: '#333333', writeKit: spy,
  });
  assert.equal(noColour.ok, false);
  assert.equal(noColour.error, 'missing_or_invalid_brand_colors');

  assert.equal(called, false, 'a refusal never reaches the website');
});

test('D-81: a bare domain is enough to address a site, so the shim still works', async () => {
  let seen = null;
  await setElementorGlobals({
    domain: 'shim.test',
    primaryColor: '#111111', secondaryColor: '#222222', accentColor: '#333333',
    writeKit: async (site) => { seen = site; return { ok: true, data: { kit_id: 1 } }; },
  });
  assert.equal(seen.domain, 'shim.test');
});

test('D-81: fonts still follow the vertical, so the Portal suggestion is unchanged', () => {
  assert.deepEqual(pickDefaultFonts('industrial-cleaning'), { heading: 'Inter', body: 'Inter' });
  assert.deepEqual(pickDefaultFonts('wedding photography'), { heading: 'Plus Jakarta Sans', body: 'IBM Plex Sans' });
});

test('D-81: the SSH writer is gone, and onboarding cannot reach for it again', () => {
  const kit = read('lib/elementorGlobals.js');
  // Comments may still explain what the old path got wrong — that history is
  // why the file looks the way it does. The CODE must be free of it.
  const code = kit.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/hostingerSsh/.test(code), 'the brand kit module must not import the SSH client');
  assert.ok(!/runWpCli/.test(code), 'the brand kit module must not run wp-cli');
  assert.ok(!/elementor_active_kit_id/.test(code), 'the option Elementor does not define must be gone');
  assert.ok(!/_elementor_data/.test(code), 'the meta key a kit does not live in must be gone');
  assert.ok(/pageClient\.js/.test(code), 'the brand kit is written through the plugin client');

  // The onboarding submit path may still use SSH for the things SSH is for
  // (installing plugins, creating the editor user). What it must never do
  // again is reach for wp-cli to set the brand.
  const submit = read('routes/onboarding/submit.js');
  const brandBlock = submit.slice(
    submit.indexOf('setting_brand_globals'),
    submit.indexOf('17b.'),
  );
  assert.ok(brandBlock.length > 200, 'found the brand-kit step');
  assert.ok(!/runWpCli|wp-cli/.test(brandBlock), 'the brand-kit step must not mention wp-cli');
});

/* ==========================================================================
 * D-82 — a newsletter issue as a blog post
 * ======================================================================== */

test('D-82: an issue body becomes one Elementor section the editor understands', () => {
  const sections = htmlToPostSections('<p>Hello there.</p><p>Second paragraph.</p>');
  assert.equal(sections.length, 1);
  const node = sections[0].node;
  assert.equal(node.elType, 'container');
  const widget = node.elements[0];
  assert.equal(widget.elType, 'widget');
  assert.equal(widget.widgetType, 'text-editor');
  assert.match(widget.settings.editor, /Second paragraph/);
  // The handle is what makes the section show up in the section editor rather
  // than as "built on the website itself".
  assert.match(String(node.settings._title), /^ia:/);
});

test('D-82: an empty body is refused rather than publishing a blank post', () => {
  assert.throws(() => htmlToPostSections('   '), /nothing to publish/i);
  assert.throws(() => htmlToPostSections('<p> </p>'), /nothing to publish/i);
});

test('D-82: script and iframe never travel from an email body into a web page', () => {
  const sections = htmlToPostSections(
    '<p>Fine.</p><script>alert(1)</script><iframe src="http://x"></iframe><p onclick="x()">Also fine.</p>',
  );
  const html = sections[0].node.elements[0].settings.editor;
  assert.ok(!/<script/i.test(html), 'the tag is gone');
  // …and so is what was INSIDE it. Stripping only the tags would leave
  // "alert(1)" sitting in the client's article as visible text.
  assert.ok(!/alert\(1\)/.test(html), 'the script body is gone too');
  assert.ok(!/<iframe/i.test(html));
  assert.ok(!/onclick/i.test(html));
  assert.match(html, /Also fine/);
});

test('D-82: the post is created, filled, published and labelled — in that order', async () => {
  const seen = [];
  const res = await composePostFromHtml({
    site: { domain: 'example.test', site_token_raw: 'tok' },
    title: 'March issue',
    contentHtml: '<p>Body.</p>',
    excerpt: 'A short summary.',
    categories: ['Newsletter'],
    client: {
      createPage: async (site, payload) => {
        seen.push(['create', payload.type, payload.title]);
        return { ok: true, status: 201, data: { page_id: 7, type: 'post' } };
      },
      writePageSections: async (site, id, payload) => {
        seen.push(['sections', id, payload.status]);
        return { ok: true, status: 200, data: { page_id: id, status: 'publish', permalink: 'https://example.test/march' } };
      },
      writePageSettings: async (site, id, payload) => {
        seen.push(['settings', id, (payload.categories || []).join(',')]);
        return { ok: true, status: 200, data: { changed: ['excerpt', 'categories'] } };
      },
    },
  });

  assert.deepEqual(seen, [
    ['create', 'post', 'March issue'],
    ['sections', 7, 'publish'],
    ['settings', 7, 'Newsletter'],
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.postId, 7);
  assert.equal(res.postUrl, 'https://example.test/march');
});

test('D-82: a post that never got its body is a failure, not a published shell', async () => {
  const res = await composePostFromHtml({
    site: { domain: 'example.test', site_token_raw: 'tok' },
    title: 'March issue',
    contentHtml: '<p>Body.</p>',
    client: {
      createPage: async () => ({ ok: true, status: 201, data: { page_id: 7 } }),
      writePageSections: async () => ({ ok: false, status: 502, error: 'plugin_rejected', message: 'Your website answered with an error (502).' }),
      writePageSettings: async () => { throw new Error('must not be reached'); },
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.step, 'body');
  assert.equal(res.postId, 7, 'the draft that was made is named so it can be found');
  assert.match(res.message, /error/i);
});

test('D-82: the plugin answering 200 with no page id is a failure', async () => {
  const res = await composePostFromHtml({
    site: { domain: 'example.test', site_token_raw: 'tok' },
    title: 'March issue',
    contentHtml: '<p>Body.</p>',
    client: {
      createPage: async () => ({ ok: true, status: 201, data: {} }),
      writePageSections: async () => { throw new Error('must not be reached'); },
      writePageSettings: async () => { throw new Error('must not be reached'); },
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.step, 'create');
  assert.match(res.message, /did not say where/i);
});

test('D-82: the summary and category are a finishing touch, not a reason to fail', async () => {
  const res = await composePostFromHtml({
    site: { domain: 'example.test', site_token_raw: 'tok' },
    title: 'March issue',
    contentHtml: '<p>Body.</p>',
    categories: ['Newsletter'],
    client: {
      createPage: async () => ({ ok: true, status: 201, data: { page_id: 9 } }),
      writePageSections: async () => ({ ok: true, status: 200, data: { permalink: 'https://example.test/march' } }),
      writePageSettings: async () => ({ ok: false, status: 500, message: 'The summary would not save.' }),
    },
  });
  // The post IS live with its body — that is the promise the button makes.
  assert.equal(res.ok, true);
  assert.equal(res.postId, 9);
  assert.match(res.warning, /summary|categor/i);
});

test('D-82: a site with no way in is told so before anything is created', async () => {
  const res = await composePostFromHtml({
    site: null, title: 'x', contentHtml: '<p>y</p>',
    client: { createPage: async () => { throw new Error('must not be reached'); } },
  });
  assert.equal(res.ok, false);
  assert.equal(res.step, 'site');
});

test('D-82: the composer only ever speaks to the plugin client', () => {
  const src = read('lib/websiteBuilder/postComposer.js');
  assert.ok(!/hostingerSsh|runWpCli/.test(src), 'no SSH');
  assert.ok(!/wp-json\/wp\/v2/.test(src), 'not WordPress core REST either — one write path');
  assert.match(src, /pageClient\.js/);
});

test('D-82: the dead proxy is not resurrected, and nothing still calls it', () => {
  const plugin = read('routes/arion/plugin.js');
  assert.ok(!/publish-newsletter/.test(plugin.replace(/\/\*[\s\S]*?\*\//g, '')),
    'no live reference to the deleted proxy outside its gravestone comment');
  const publisher = read('lib/contentAgent/publisher.js');
  assert.ok(!/'\/publish-newsletter'/.test(publisher),
    'the content agent must not post to a plugin route that has never existed');
});

test('D-82: the sanitiser keeps the tags a newsletter is actually written in', () => {
  const kept = postTest.sanitizeBodyHtml(
    '<h2>Head</h2><p><strong>bold</strong> <em>em</em></p><ul><li>one</li></ul>'
    + '<a href="https://x.test">link</a><img src="https://x.test/a.png" alt="a">'
    + '<blockquote>q</blockquote>',
  );
  for (const tag of ['h2', 'strong', 'em', 'ul', 'li', 'a', 'img', 'blockquote']) {
    assert.ok(new RegExp(`<${tag}[ >]`, 'i').test(kept), `${tag} survives`);
  }
  assert.match(kept, /href="https:\/\/x\.test"/);
});

test('D-82: a javascript: link is stripped, not carried onto the website', () => {
  const out = postTest.sanitizeBodyHtml('<a href="javascript:alert(1)">x</a><a href="https://ok.test">y</a>');
  assert.ok(!/javascript:/i.test(out));
  assert.match(out, /https:\/\/ok\.test/);
});
