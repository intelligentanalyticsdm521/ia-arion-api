/**
 * Site builder — the transport and the save-path guards.
 *
 * The one defect this area must not repeat is a green answer on a failed
 * write: `reference_catch_swallow_report_success` counts 13+ instances of a
 * 200 over a failure. Every assertion below about `ok:false` exists so T18/T19
 * in the walkthrough have something underneath them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSiteBaseUrl, isLoopbackHost, buildPluginAuth } from '../lib/pluginClient.js';
import {
  fetchPages, fetchPageSections, writePageSections, undoPage, createPage, sideloadMedia,
} from '../lib/websiteBuilder/pageClient.js';
import { __test__ as routeInternals } from '../routes/arion/pages.js';
import { renderSectionListHtml } from '../lib/websiteBuilder/sectionPreview.js';
import { blockToElementorSection } from '../lib/websiteBuilder/elementorAdapter.js';
import { getEmitter } from '../lib/websiteBuilder/emitterRegistry.js';
import { reduceToSectionList, extractFields } from '../lib/websiteBuilder/sectionSchema.js';
import { buildStarterSection } from '../lib/websiteBuilder/starterSections.js';

const { buildNodes, siteAllowsPro, readPageId, ALLOWED_MEDIA_TYPES } = routeInternals;

const SITE = Object.freeze({
  site_id: 's1', tenant_id: 't1',
  domain: 'fernbrook.invalid',
  site_token_raw: 'raw-token-abc',
  arion_tier: 'business',
});
const DEV_SITE = Object.freeze({ ...SITE, domain: 'localhost:8084' });

/** A fetch stand-in that records the call and returns what the test wants. */
function fakeFetch(reply) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const r = typeof reply === 'function' ? reply(url, init) : reply;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)),
    };
  };
  impl.calls = calls;
  return impl;
}

/* ── how we reach the site ─────────────────────────────────────────────── */

test('a client domain is always https; only loopback drops to http', () => {
  assert.equal(resolveSiteBaseUrl(SITE), 'https://fernbrook.invalid');
  assert.equal(resolveSiteBaseUrl(DEV_SITE), 'http://localhost:8084');
  assert.equal(resolveSiteBaseUrl({ domain: '127.0.0.1:8084' }), 'http://127.0.0.1:8084');
  assert.equal(resolveSiteBaseUrl({ domain: 'host.docker.internal:8084' }), 'http://host.docker.internal:8084');
  // Anything that merely LOOKS like localhost stays on https — the guard is
  // presence of a loopback marker, not absence of a production one.
  assert.equal(resolveSiteBaseUrl({ domain: 'localhost.evil.invalid' }), 'https://localhost.evil.invalid');
  assert.equal(resolveSiteBaseUrl({ domain: 'notlocalhost' }), 'https://notlocalhost');
  assert.equal(isLoopbackHost('localhost.evil.invalid'), false);
  assert.equal(resolveSiteBaseUrl({}), null);
});

test('every page call carries the site token and a cache-buster', async () => {
  // LiteSpeed caches /wp-json on every ARION site; a URL it has never seen is
  // the only reliable way past it (reference_arion_plugin_release).
  const f = fakeFetch({ status: 200, body: { pages: [] } });
  await fetchPages(SITE, { fetchImpl: f });
  const { url, init } = f.calls[0];
  assert.match(url, /^https:\/\/fernbrook\.invalid\/wp-json\/intelligent-analytics\/v1\/pages\?/);
  assert.match(url, /_ia_cb=\d+/);
  assert.equal(init.headers['X-Arion-Site-Token'], 'raw-token-abc');
  assert.match(init.headers['Cache-Control'], /no-cache/);
  assert.equal(init.method, 'GET');
});

test('the write path posts to the sections route, not to a hand-rolled one', async () => {
  const f = fakeFetch({ status: 200, body: { success: true, page_id: 12 } });
  await writePageSections(SITE, 12, { sections: [] }, { fetchImpl: f });
  assert.match(f.calls[0].url, /\/pages\/12\/sections\?/);
  assert.equal(f.calls[0].init.method, 'POST');

  const g = fakeFetch({ status: 200, body: { success: true, restored: true } });
  await undoPage(SITE, 12, { fetchImpl: g });
  assert.match(g.calls[0].url, /\/pages\/12\/undo\?/);

  const h = fakeFetch({ status: 201, body: { page_id: 44 } });
  await createPage(SITE, { title: 'New' }, { fetchImpl: h });
  assert.equal(JSON.parse(h.calls[0].init.body).status, 'draft', 'a new page is always born a draft (W-3)');

  const m = fakeFetch({ status: 201, body: { url: 'https://x/y.jpg' } });
  await sideloadMedia(SITE, { url: 'https://x/y.jpg' }, { fetchImpl: m });
  assert.match(m.calls[0].url, /\/media\/sideload\?/);
});

test('a site with no token is refused before any request is made', async () => {
  const f = fakeFetch({ status: 200, body: {} });
  const r = await fetchPages({ domain: 'fernbrook.invalid' }, { fetchImpl: f });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'site_not_connected');
  assert.equal(f.calls.length, 0, 'nothing was sent');
  assert.match(r.message, /not connected/i);
  assert.equal(buildPluginAuth({ domain: 'x' }).ok, false);
});

test('a 401 is site_not_connected, a 404 is not_found, a 500 is a rejection — never ok', async () => {
  for (const [status, error] of [[401, 'site_not_connected'], [403, 'site_not_connected'],
    [404, 'not_found'], [500, 'plugin_rejected'], [502, 'plugin_rejected']]) {
    const r = await fetchPageSections(SITE, 3, { fetchImpl: fakeFetch({ status, body: { error: 'nope' } }) });
    assert.equal(r.ok, false, `HTTP ${status} must not be ok`);
    assert.equal(r.error, error, `HTTP ${status}`);
    assert.ok(r.message && r.message.length > 0, `HTTP ${status} carries words`);
  }
});

test('an unreachable site is a failure with words, not a crash', async () => {
  const boom = async () => { throw Object.assign(new Error('ECONNREFUSED'), { name: 'FetchError' }); };
  const r = await writePageSections(SITE, 1, { sections: [] }, { fetchImpl: boom });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unreachable');
  assert.match(r.message, /could not reach your website/i);

  const abort = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  const t = await writePageSections(SITE, 1, { sections: [] }, { fetchImpl: abort });
  assert.equal(t.ok, false);
  assert.equal(t.error, 'timeout');
});

/* ── what actually gets published ──────────────────────────────────────── */

function hero(overrides = {}) {
  return blockToElementorSection({
    kind: 'hero',
    block: { ...getEmitter('hero').example, ...overrides },
    brand: { business_name: 'F', email: 'a@b.co' },
    seedId: 'route-hero', blockId: 'blk-1',
  });
}
const CUSTOM = Object.freeze({
  id: 'h1', elType: 'section', settings: { _title: 'Hand built' },
  elements: [{ id: 'c', elType: 'column', settings: {}, elements: [] }],
});

test('buildNodes patches ours and passes a custom section straight through', () => {
  const list = reduceToSectionList([hero(), CUSTOM]);
  const incoming = [
    { ...list[0], fields: { ...list[0].fields, headline: 'Changed' } },
    list[1],
  ];
  const { nodes, errors } = buildNodes(incoming);
  assert.equal(errors.length, 0);
  assert.equal(nodes.length, 2);
  assert.equal(extractFields(nodes[0].node, 'hero').headline, 'Changed');
  assert.equal(JSON.stringify(nodes[1].node), JSON.stringify(CUSTOM), 'custom section is byte-identical');
});

test('buildNodes refuses bad content instead of publishing it', () => {
  const list = reduceToSectionList([hero()]);
  const { nodes, errors } = buildNodes([{ ...list[0], fields: { ...list[0].fields, headline: '' } }]);
  assert.equal(nodes.length, 0, 'nothing is built when the content is wrong');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, 'sections[0].headline');
  assert.match(errors[0].message, /cannot be empty/);
});

test('a section arriving without its content is an error, not a silently dropped section', () => {
  const { nodes, errors } = buildNodes([{ index: 0, fields: {}, node: null }]);
  assert.equal(nodes.length, 0);
  assert.match(errors[0].message, /missing its content/);
  // The save route compares nodes.length to incoming.length precisely so this
  // case can never write a page with a section quietly removed.
});

test('a node that is not a section is refused', () => {
  const { errors } = buildNodes([{ index: 0, fields: {}, node: { elType: 'widget' } }]);
  assert.equal(errors.length, 1);
});

/* ── preview ───────────────────────────────────────────────────────────── */

test('preview renders the words, escapes them, and touches nothing', () => {
  const list = reduceToSectionList([hero({ headline: 'Rooms & <script>alert(1)</script>' }), CUSTOM]);
  const before = JSON.stringify(list.map((s) => s.node));

  const html = renderSectionListHtml(
    list.map((s) => ({ kind: s.kind, fields: s.fields })),
    { primary_color: '#245A4A' },
    { pageTitle: 'Home' },
  );

  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /Rooms &amp; &lt;script&gt;/);
  assert.ok(!html.includes('<script>alert(1)</script>'), 'no live script reaches the preview');
  assert.match(html, /Custom section — built on the site/);
  assert.match(html, /Nothing has been saved yet/);
  assert.match(html, /--ia-primary:#245A4A/);
  assert.equal(JSON.stringify(list.map((s) => s.node)), before, 'preview mutates nothing');
});

test('preview refuses to render a picture from a non-web source', () => {
  const html = renderSectionListHtml([{ kind: 'hero', fields: { headline: 'H', image_url: 'javascript:alert(1)' } }]);
  assert.ok(!html.includes('javascript:'), html.slice(0, 400));
});

test('preview of an empty page says so rather than rendering a blank sheet', () => {
  assert.match(renderSectionListHtml([]), /no sections yet/);
});

/* ── adding a section ──────────────────────────────────────────────────── */

test('a freshly added section is editable the moment it is added', () => {
  for (const kind of ['hero', 'services', 'testimonials', 'cta', 'about', 'faq', 'gallery']) {
    const built = buildStarterSection(kind, { business_name: 'Fernbrook Garden Rooms' });
    assert.equal(built.ok, true, `${kind}: ${built.message || ''}`);
    const [entry] = reduceToSectionList([built.node]);
    assert.equal(entry.kind, kind);
    assert.equal(entry.editable, true, `${kind} is editable straight away`);
  }
});

test('a starter section uses the business own words, never the emitter demo copy', () => {
  const built = buildStarterSection('hero', { business_name: 'Fernbrook Garden Rooms' });
  const [entry] = reduceToSectionList([built.node]);
  assert.match(entry.fields.headline, /Fernbrook Garden Rooms/);
  assert.ok(!/Cedar Ridge|Iowa/i.test(JSON.stringify(entry.fields)), 'no demo business leaks onto a real site');
});

test('a contact section refuses to exist without somewhere to send the enquiry', () => {
  const built = buildStarterSection('contact', { business_name: 'Fernbrook' });
  assert.equal(built.ok, false);
  assert.equal(built.code, 'form_recipient_missing');
  assert.match(built.message, /notification email/i);

  const withEmail = buildStarterSection('contact', { business_name: 'Fernbrook', email: 'hello@fernbrook.invalid' });
  assert.equal(withEmail.ok, true);
});

test('an unknown section kind is refused by name', () => {
  const built = buildStarterSection('carousel', {});
  assert.equal(built.ok, false);
  assert.match(built.message, /carousel/);
});

/* ── small guards ──────────────────────────────────────────────────────── */

test('the tier decides Elementor Pro, and unknown means the site has it', () => {
  assert.equal(siteAllowsPro({ arion_tier: 'lite' }), false);
  assert.equal(siteAllowsPro({ arion_tier: 'LITE' }), false);
  assert.equal(siteAllowsPro({ arion_tier: 'standard' }), true);
  assert.equal(siteAllowsPro({ arion_tier: 'business' }), true);
  assert.equal(siteAllowsPro({}), true);
});

test('a page id is a positive whole number and nothing else', () => {
  assert.equal(readPageId('12'), 12);
  assert.equal(readPageId(12), 12);
  assert.equal(readPageId('0'), null);
  assert.equal(readPageId('-3'), null);
  assert.equal(readPageId('1.5'), null);
  assert.equal(readPageId('12; DROP TABLE'), null);
  assert.equal(readPageId(''), null);
});

test('only real picture types are accepted for upload', () => {
  assert.deepEqual(Object.keys(ALLOWED_MEDIA_TYPES).sort(),
    ['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
  assert.equal(ALLOWED_MEDIA_TYPES['image/svg+xml'], undefined, 'SVG is not accepted — it can carry script');
  assert.equal(ALLOWED_MEDIA_TYPES['application/pdf'], undefined);
});
