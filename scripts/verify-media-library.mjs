#!/usr/bin/env node
/**
 * Verification script for the ARION IL website builder media library
 * injector (lib/websiteBuilder/mediaLibrary.js + extended pageAssembler).
 * --------------------------------------------------------------------------
 * Constraint from the task: NEVER touch a real customer WP site. All HTTP
 * is mocked. The verifier proves:
 *
 *   1. injectMediaIntoBlocks walks the assembled tree, finds gallery widgets,
 *      and swaps every placeholder URL → real attachment URL/id.
 *   2. Dedupe: the same placeholder URL across multiple slots → ONE upload.
 *   3. URLs that look like real attachments (have a non-empty id, host not in
 *      ALLOWED_PLACEHOLDER_HOSTS) are left alone.
 *   4. Non-gallery sections (hero/services/cta) pass through untouched.
 *   5. Upload failures land in `failed[]` and the original URL is preserved.
 *   6. The input tree is NOT mutated (deep-clone safety).
 *   7. uploadPlaceholderToWp:
 *      a. Rejects URLs outside the allowlist.
 *      b. Returns a clear error when neither token nor app password is set.
 *      c. Hits the IA Plugin /media/sideload endpoint when the token is
 *         available and the endpoint returns 200.
 *      d. Falls back to /wp-json/wp/v2/media on 404 from the plugin endpoint
 *         when wp_app_password_ref is set, and surfaces attachment_id +
 *         source_url from the WP response.
 *      e. Surfaces wp_media_http_<status> + httpStatus on non-2xx core
 *         responses.
 *   8. assemblePageWithMedia end-to-end: drafts + gallery → assembled tree
 *      with swapped URLs, matching media counters in the result.
 *
 * Usage:
 *   node scripts/verify-media-library.mjs
 *
 * Exit codes: 0 all pass, 1 any fail.
 */

import {
  uploadPlaceholderToWp,
  injectMediaIntoBlocks,
  __test__ as mlInternals,
} from '../lib/websiteBuilder/mediaLibrary.js';
import { assemblePage, assemblePageWithMedia } from '../lib/websiteBuilder/pageAssembler.js';
import { getEmitter } from '../lib/websiteBuilder/emitterRegistry.js';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';
const CYAN  = '\x1b[36m';
const BOLD  = '\x1b[1m';

let pass = 0;
let fail = 0;
function ok(msg)  { console.log(`  ${GREEN}✔${RESET} ${msg}`); pass++; }
function bad(msg) { console.log(`  ${RED}✘${RESET} ${msg}`);   fail++; }
function section(title) { console.log(`\n${BOLD}${CYAN}=== ${title} ===${RESET}`); }

const MOCK_BRAND = {
  tenant_id: '11111111-1111-1111-1111-111111111111',
  site_id:   '22222222-2222-2222-2222-222222222222',
  business_name:   'Cedar Ridge Plant Services',
  primary_color:   '#1A3A4A',
  secondary_color: '#FEC82C',
  font_family:     'Inter',
};

const MOCK_SITE_TOKEN = {
  site_id:            MOCK_BRAND.site_id,
  domain:             'cedarridgeplant.com',
  wp_admin_url:       'https://cedarridgeplant.com/wp-admin',
  site_token_raw:     'tok_test_abc123',
  wp_app_password_ref: null,
};
const MOCK_SITE_APP_PWD = {
  ...MOCK_SITE_TOKEN,
  site_token_raw:      null,
  wp_app_password_ref: 'ia_admin:abcd-efgh-ijkl-mnop',
};
const MOCK_SITE_BOTH = {
  ...MOCK_SITE_TOKEN,
  wp_app_password_ref: 'ia_admin:abcd-efgh-ijkl-mnop',
};

// ---------------------------------------------------------------------------
// 1. injectMediaIntoBlocks — URL swap on a gallery section
// ---------------------------------------------------------------------------
section('injectMediaIntoBlocks — gallery URL swap');

const gallerySection = {
  id: 'gal-sec',
  elType: 'section',
  settings: { structure: '10', gap: 'extended' },
  elements: [
    {
      id: 'gal-head-col',
      elType: 'column',
      settings: { _column_size: 100 },
      elements: [
        { id: 'gal-head-h', elType: 'widget', widgetType: 'heading', settings: { title: 'Recent work' } },
      ],
    },
    {
      id: 'gal-grid-col',
      elType: 'column',
      settings: { _column_size: 100 },
      elements: [
        {
          id: 'gal-grid',
          elType: 'widget',
          widgetType: 'image-gallery',
          settings: {
            gallery: [
              { id: '', url: 'https://source.unsplash.com/800x600/?warehouse,clean', _meta_idx: 0 },
              { id: '', url: 'https://source.unsplash.com/800x600/?factory,floor',   _meta_idx: 1 },
              // Deliberate duplicate of #0 to test dedupe.
              { id: '', url: 'https://source.unsplash.com/800x600/?warehouse,clean', _meta_idx: 2 },
              { id: '', url: 'https://via.placeholder.com/800x600?text=Sample',      _meta_idx: 3 },
            ],
            ia_gallery_meta: [
              { alt: 'Polished warehouse floor', caption: 'Cedar Rapids', category: 'Floor Care' },
              { alt: 'Food-grade line ready',    caption: 'Quad Cities',  category: 'Plant Cleaning' },
              { alt: 'Another warehouse shot',   caption: 'Mt. Pleasant', category: 'Floor Care' },
              { alt: 'Sample',                   caption: '',             category: '' },
            ],
            gallery_columns: 3,
            gallery_link: 'file',
          },
        },
      ],
    },
  ],
  isInner: false,
};

// Hero section — should be untouched.
const heroSection = {
  id: 'hero-sec',
  elType: 'section',
  settings: { structure: '10', layout: 'full_width' },
  elements: [
    {
      id: 'hero-col',
      elType: 'column',
      settings: { _column_size: 100 },
      elements: [
        { id: 'hero-h', elType: 'widget', widgetType: 'heading', settings: { title: 'Sanitized by sunrise.' } },
        { id: 'hero-sub', elType: 'widget', widgetType: 'text-editor', settings: { editor: '<p>Overnight cleaning</p>' } },
        { id: 'hero-cta', elType: 'widget', widgetType: 'button', settings: { text: 'Get a quote' } },
      ],
    },
  ],
  isInner: false,
};

const ORIGINAL_TREE = [heroSection, gallerySection];
// Freeze a deep snapshot of input to assert non-mutation later.
const FROZEN_SNAPSHOT = JSON.stringify(ORIGINAL_TREE);

// Mock uploader: returns a deterministic attachment_id derived from URL hash.
let uploadCallCount = 0;
const seenUrls = new Set();
const mockUpload = async (placeholderUrl, perOpts) => {
  uploadCallCount += 1;
  seenUrls.add(placeholderUrl);
  // Use a tiny hash so the attachment_id is stable per URL.
  let h = 0;
  for (const ch of placeholderUrl) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
  const id = Math.abs(h % 9000) + 1000;
  return {
    ok: true,
    attachment_id: id,
    full_url: `https://cedarridgeplant.com/wp-content/uploads/2026/06/arion-${id}.jpg`,
    via: 'mock',
    _meta: { alt: perOpts?.alt, caption: perOpts?.caption },
  };
};

const res1 = await injectMediaIntoBlocks(MOCK_SITE_TOKEN, ORIGINAL_TREE, { uploadImpl: mockUpload });

if (Array.isArray(res1.elementorData) && res1.elementorData.length === 2) ok('elementorData returned with 2 sections');
else bad(`elementorData wrong shape: ${JSON.stringify(res1.elementorData).slice(0, 120)}`);

// Hero section pass-through — deep-equal to original.
const heroOut = res1.elementorData[0];
if (JSON.stringify(heroOut) === JSON.stringify(heroSection)) ok('hero section passes through untouched');
else bad('hero section was mutated');

// Gallery URLs swapped + ids non-empty.
const galleryOut = res1.elementorData[1].elements[1].elements[0].settings.gallery;
if (galleryOut.every((g) => Number.isFinite(g.id) && g.id > 0)) ok('every gallery image has a numeric attachment_id');
else bad(`gallery ids not all numeric: ${JSON.stringify(galleryOut.map((g) => g.id))}`);

if (galleryOut.every((g) => g.url.startsWith('https://cedarridgeplant.com/wp-content/uploads/'))) ok('every gallery url swapped to the uploaded URL');
else bad(`gallery urls not all swapped: ${JSON.stringify(galleryOut.map((g) => g.url))}`);

// Dedupe: 4 slots, but only 3 unique placeholders → 3 uploads, 1 reuse.
if (uploadCallCount === 3) ok(`dedupe: 3 unique uploads for 4 slots (1 reuse)`);
else bad(`expected 3 uploads, got ${uploadCallCount}`);
if (res1.uploaded === 3 && res1.reused === 1) ok(`counters: uploaded=3 reused=1`);
else bad(`counters wrong: uploaded=${res1.uploaded} reused=${res1.reused}`);

// Slot 0 and slot 2 (same source URL) should map to the same attachment.
if (galleryOut[0].id === galleryOut[2].id && galleryOut[0].url === galleryOut[2].url) ok('deduped slots share attachment_id + url');
else bad(`dedupe did not propagate to slot 2: ${JSON.stringify({ s0: galleryOut[0], s2: galleryOut[2] })}`);

// Alt/caption passed to the uploader for each slot.
if (seenUrls.size === 3) ok('uploader was called with 3 unique URLs');
else bad(`uploader saw ${seenUrls.size} unique URLs`);

// Non-mutation of original input.
if (JSON.stringify(ORIGINAL_TREE) === FROZEN_SNAPSHOT) ok('input tree NOT mutated');
else bad('input tree WAS mutated — defensive clone failed');

if (res1.failed.length === 0) ok('no failures');
else bad(`unexpected failures: ${JSON.stringify(res1.failed)}`);

// ---------------------------------------------------------------------------
// 2. Already-attached + non-placeholder URLs are skipped
// ---------------------------------------------------------------------------
section('Already-attached / non-allowed URLs are skipped');

const treeWithRealAttachment = [{
  id: 'gal-sec-2',
  elType: 'section',
  settings: {},
  elements: [{
    id: 'col-1',
    elType: 'column',
    settings: { _column_size: 100 },
    elements: [{
      id: 'gal-grid-2',
      elType: 'widget',
      widgetType: 'image-gallery',
      settings: {
        gallery: [
          // Real-looking attachment — already uploaded, has id, host not a placeholder
          { id: 42, url: 'https://cedarridgeplant.com/wp-content/uploads/2026/04/photo.jpg' },
          // Customer-supplied URL on an unknown host — leave alone
          { id: '', url: 'https://customer-cdn.example.com/photo.jpg' },
          // Real placeholder — should be uploaded
          { id: '', url: 'https://source.unsplash.com/800x600/?candle,shop' },
        ],
        ia_gallery_meta: [
          { alt: 'a', caption: '', category: '' },
          { alt: 'b', caption: '', category: '' },
          { alt: 'c', caption: '', category: '' },
        ],
      },
    }],
  }],
  isInner: false,
}];

let upload2Count = 0;
const mockUpload2 = async (url) => {
  upload2Count += 1;
  return { ok: true, attachment_id: 7777, full_url: 'https://cedarridgeplant.com/wp-content/uploads/2026/06/swap.jpg' };
};
const res2 = await injectMediaIntoBlocks(MOCK_SITE_TOKEN, treeWithRealAttachment, { uploadImpl: mockUpload2 });
if (upload2Count === 1) ok('only the unsplash slot was uploaded');
else bad(`expected 1 upload, got ${upload2Count}`);
if (res2.skipped.length === 2) ok('2 slots skipped (real attachment + unknown host)');
else bad(`expected 2 skipped, got ${res2.skipped.length}: ${JSON.stringify(res2.skipped)}`);
const reasons = res2.skipped.map((s) => s.reason);
if (reasons.includes('already_attached')) ok('already_attached reason surfaced');
else bad(`expected already_attached, got: ${reasons.join(' | ')}`);
if (reasons.includes('not_a_known_placeholder')) ok('not_a_known_placeholder reason surfaced');
else bad(`expected not_a_known_placeholder, got: ${reasons.join(' | ')}`);

// The real-attachment slot must be unchanged.
const realOut = res2.elementorData[0].elements[0].elements[0].settings.gallery[0];
if (realOut.id === 42 && realOut.url.endsWith('/photo.jpg')) ok('real attachment slot unchanged');
else bad(`real attachment slot mutated: ${JSON.stringify(realOut)}`);

// ---------------------------------------------------------------------------
// 3. Upload failure → original URL preserved, failed[] populated
// ---------------------------------------------------------------------------
section('Upload failures preserve original URL');

const failureTree = [{
  id: 'gal-sec-3',
  elType: 'section',
  settings: {},
  elements: [{
    id: 'col-3',
    elType: 'column',
    settings: { _column_size: 100 },
    elements: [{
      id: 'gal-3',
      elType: 'widget',
      widgetType: 'image-gallery',
      settings: {
        gallery: [
          { id: '', url: 'https://source.unsplash.com/800x600/?ok' },
          { id: '', url: 'https://source.unsplash.com/800x600/?fail' },
        ],
        ia_gallery_meta: [
          { alt: '1', caption: '', category: '' },
          { alt: '2', caption: '', category: '' },
        ],
      },
    }],
  }],
  isInner: false,
}];
const mockUpload3 = async (url) => {
  if (url.includes('fail')) return { ok: false, error: 'simulated_upload_500' };
  return { ok: true, attachment_id: 555, full_url: 'https://cedarridgeplant.com/wp-content/uploads/2026/06/ok.jpg' };
};
const res3 = await injectMediaIntoBlocks(MOCK_SITE_TOKEN, failureTree, { uploadImpl: mockUpload3 });
const g3 = res3.elementorData[0].elements[0].elements[0].settings.gallery;
if (g3[0].id === 555) ok('successful slot got attachment_id');
else bad(`successful slot missing id: ${JSON.stringify(g3[0])}`);
if (g3[1].id === '' && g3[1].url === 'https://source.unsplash.com/800x600/?fail') ok('failed slot kept placeholder URL untouched');
else bad(`failed slot was mutated: ${JSON.stringify(g3[1])}`);
if (res3.failed.length === 1 && res3.failed[0].error === 'simulated_upload_500') ok('failed[] reports the upload error');
else bad(`failed[] wrong: ${JSON.stringify(res3.failed)}`);
if (res3.uploaded === 1) ok('uploaded counter excludes failures');
else bad(`uploaded counter=${res3.uploaded}, expected 1`);

// ---------------------------------------------------------------------------
// 4. uploadPlaceholderToWp — direct unit tests with mocked fetch
// ---------------------------------------------------------------------------
section('uploadPlaceholderToWp — direct path tests');

// 4a. Allowlist rejection.
const rejNotAllowed = await uploadPlaceholderToWp(MOCK_SITE_TOKEN, 'https://evil.example.com/x.jpg', {
  fetchImpl: async () => { throw new Error('should not be called'); },
});
if (!rejNotAllowed.ok && rejNotAllowed.error === 'placeholder_not_allowed') ok('non-allowlist host rejected (placeholder_not_allowed)');
else bad(`expected placeholder_not_allowed, got ${JSON.stringify(rejNotAllowed)}`);

// 4b. No auth.
const noAuth = await uploadPlaceholderToWp({ domain: 'foo.com' }, 'https://source.unsplash.com/800x600/?x', {
  fetchImpl: async () => { throw new Error('should not be called'); },
});
if (!noAuth.ok && /no_auth_available/.test(noAuth.error)) ok('missing auth → no_auth_available');
else bad(`expected no_auth_available, got ${JSON.stringify(noAuth)}`);

// 4c. Plugin /media/sideload happy path with the site token.
let capturedPluginUrl = null;
let capturedPluginHeaders = null;
let capturedPluginBody = null;
const mockFetchPluginOk = async (url, init) => {
  if (url.includes('/media/sideload')) {
    capturedPluginUrl = url;
    capturedPluginHeaders = init.headers;
    capturedPluginBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({
        success: true,
        data: { attachment_id: 1234, source_url: 'https://cedarridgeplant.com/wp-content/uploads/2026/06/arion.jpg' },
      }),
    };
  }
  throw new Error(`unexpected fetch URL: ${url}`);
};
const pluginRes = await uploadPlaceholderToWp(MOCK_SITE_TOKEN, 'https://source.unsplash.com/800x600/?warehouse,clean', {
  alt: 'Polished warehouse floor',
  caption: 'Cedar Rapids',
  idx: 0,
  fetchImpl: mockFetchPluginOk,
});
if (pluginRes.ok && pluginRes.attachment_id === 1234) ok('plugin sideload happy path: attachment_id round-tripped');
else bad(`plugin sideload happy path failed: ${JSON.stringify(pluginRes)}`);
if (pluginRes.via === 'plugin_sideload') ok('via=plugin_sideload labeled correctly');
else bad(`via wrong: ${pluginRes.via}`);
if (capturedPluginHeaders?.['X-Arion-Site-Token'] === 'tok_test_abc123') ok('X-Arion-Site-Token sent to plugin endpoint');
else bad(`token header not sent: ${JSON.stringify(capturedPluginHeaders)}`);
if (capturedPluginBody?.source_url === 'https://source.unsplash.com/800x600/?warehouse,clean') ok('source_url forwarded in body');
else bad(`source_url not forwarded: ${JSON.stringify(capturedPluginBody)}`);
if (capturedPluginBody?.alt === 'Polished warehouse floor') ok('alt forwarded');
else bad(`alt missing: ${capturedPluginBody?.alt}`);
if (capturedPluginBody?.filename?.startsWith('arion-warehouse-clean')) ok('filename derived from URL keywords');
else bad(`filename wrong: ${capturedPluginBody?.filename}`);

// 4d. Plugin 404 → fall back to WP core /wp/v2/media using Basic auth.
let coreUploadHit = false;
let coreUploadHeaders = null;
let coreUploadBody = null;
let coreMetaPatchHit = false;
const mockFetchPluginMissingCoreOk = async (url, init) => {
  if (url.includes('/media/sideload')) {
    return { ok: false, status: 404, text: async () => 'rest_no_route' };
  }
  if (url.endsWith('/wp-json/wp/v2/media')) {
    coreUploadHit = true;
    coreUploadHeaders = init.headers;
    coreUploadBody = init.body;
    return {
      ok: true,
      status: 201,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({
        id: 9911,
        source_url: 'https://cedarridgeplant.com/wp-content/uploads/2026/06/arion-fallback.jpg',
        guid: { rendered: 'https://cedarridgeplant.com/wp-content/uploads/2026/06/arion-fallback.jpg' },
      }),
    };
  }
  if (url.includes('/wp-json/wp/v2/media/9911')) {
    coreMetaPatchHit = true;
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ id: 9911 }) };
  }
  if (url.includes('source.unsplash.com')) {
    // Placeholder fetch — return 12 bytes.
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
      arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).buffer,
    };
  }
  throw new Error(`unexpected fetch URL: ${url}`);
};
const fallbackRes = await uploadPlaceholderToWp(MOCK_SITE_BOTH, 'https://source.unsplash.com/800x600/?candle,shop', {
  alt: 'Storefront shelf',
  caption: 'Portland',
  idx: 1,
  fetchImpl: mockFetchPluginMissingCoreOk,
});
if (fallbackRes.ok && fallbackRes.attachment_id === 9911) ok('fallback to /wp/v2/media on plugin 404');
else bad(`fallback failed: ${JSON.stringify(fallbackRes)}`);
if (fallbackRes.via === 'wp_core_media') ok('via=wp_core_media on fallback');
else bad(`via wrong on fallback: ${fallbackRes.via}`);
if (coreUploadHit) ok('core /wp/v2/media was hit');
else bad('core /wp/v2/media NOT hit');
if (typeof coreUploadHeaders?.Authorization === 'string' && coreUploadHeaders.Authorization.startsWith('Basic ')) ok('Basic auth header sent to core endpoint');
else bad(`Basic auth missing from core upload: ${JSON.stringify(coreUploadHeaders)}`);
if (coreUploadHeaders?.['Content-Disposition']?.includes('arion-candle-shop')) ok('Content-Disposition filename includes keyword');
else bad(`Content-Disposition wrong: ${coreUploadHeaders?.['Content-Disposition']}`);
if (Buffer.isBuffer(coreUploadBody) && coreUploadBody.length === 12) ok('placeholder bytes streamed as body');
else bad(`upload body not a Buffer of expected size: ${coreUploadBody?.length}`);
if (coreMetaPatchHit) ok('alt/caption patch sent after upload');
else bad('alt/caption patch NOT sent');

// 4e. Plugin 404 + no app password → clear scoped error.
const noFallback = await uploadPlaceholderToWp(MOCK_SITE_TOKEN, 'https://source.unsplash.com/800x600/?x', {
  fetchImpl: async (url) => {
    if (url.includes('/media/sideload')) return { ok: false, status: 404, text: async () => '' };
    throw new Error('should not be called');
  },
});
if (!noFallback.ok && /requires_app_password/.test(noFallback.error)) ok('plugin 404 + no app pwd → media_upload_requires_app_password');
else bad(`expected requires_app_password, got ${JSON.stringify(noFallback)}`);

// 4f. WP core 401 surfaced cleanly.
const mockFetch401 = async (url) => {
  if (url.includes('/media/sideload')) return { ok: false, status: 404, text: async () => '' };
  if (url.includes('source.unsplash.com')) {
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    };
  }
  return { ok: false, status: 401, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ message: 'Bad app password' }) };
};
const res401 = await uploadPlaceholderToWp(MOCK_SITE_APP_PWD, 'https://source.unsplash.com/800x600/?x', { fetchImpl: mockFetch401 });
if (!res401.ok && /wp_media_http_401/.test(res401.error)) ok('core 401 → wp_media_http_401');
else bad(`expected wp_media_http_401, got ${JSON.stringify(res401)}`);
if (res401.httpStatus === 401) ok('httpStatus=401 propagated');
else bad(`httpStatus=${res401.httpStatus}`);

// ---------------------------------------------------------------------------
// 5. assemblePageWithMedia end-to-end
// ---------------------------------------------------------------------------
section('assemblePageWithMedia — drafts + gallery → swapped URLs');

const heroEx = getEmitter('hero')?.example;
const galleryEx = getEmitter('gallery')?.example;
if (!heroEx || !galleryEx) {
  bad('emitter examples missing — cannot run end-to-end test');
} else {
  const drafts = [
    { block_id: 'a', kind: 'hero',    block_json: JSON.stringify(heroEx),    elementor_json: null },
    { block_id: 'b', kind: 'gallery', block_json: JSON.stringify(galleryEx), elementor_json: null },
  ];

  let e2eUploadCount = 0;
  const mockE2eUpload = async (url) => {
    e2eUploadCount += 1;
    return {
      ok: true,
      attachment_id: 10000 + e2eUploadCount,
      full_url: `https://cedarridgeplant.com/wp-content/uploads/2026/06/e2e-${e2eUploadCount}.jpg`,
    };
  };
  const e2e = await assemblePageWithMedia(MOCK_SITE_TOKEN, drafts, MOCK_BRAND, {
    seedPrefix: 'verify-media',
    uploadImpl: mockE2eUpload,
    maxConcurrent: 2,
  });

  if (e2e.sectionsBuilt === 2) ok('2 sections built');
  else bad(`sectionsBuilt=${e2e.sectionsBuilt}`);

  if (e2e.media.uploaded === galleryEx.images.length) ok(`uploaded ${galleryEx.images.length} gallery images (matches example length)`);
  else bad(`expected ${galleryEx.images.length} uploads, got ${e2e.media.uploaded}`);

  // Find the gallery widget in the assembled tree and verify all urls swapped.
  let gridOut = null;
  for (const sec of e2e.elementorData) {
    JSON.stringify(sec, (k, v) => {
      if (v && v.elType === 'widget' && v.widgetType === 'image-gallery') gridOut = v;
      return v;
    });
  }
  if (gridOut && gridOut.settings.gallery.every((g) => Number.isFinite(g.id) && g.id >= 10000)) ok('every gallery slot received a numeric attachment_id');
  else bad(`gallery slots not all swapped: ${JSON.stringify(gridOut?.settings?.gallery?.map?.((g) => g.id))}`);

  if (gridOut && gridOut.settings.gallery.every((g) => g.url.startsWith('https://cedarridgeplant.com/wp-content/uploads/2026/06/e2e-'))) ok('every gallery URL swapped to uploaded URL');
  else bad(`urls not swapped: ${JSON.stringify(gridOut?.settings?.gallery?.map?.((g) => g.url))}`);

  // ia_gallery_meta should still be there (alt/caption preserved).
  if (Array.isArray(gridOut?.settings?.ia_gallery_meta) && gridOut.settings.ia_gallery_meta.length === galleryEx.images.length) ok('ia_gallery_meta survives the swap');
  else bad(`ia_gallery_meta lost or wrong length: ${JSON.stringify(gridOut?.settings?.ia_gallery_meta)}`);
}

// ---------------------------------------------------------------------------
// 6. assemblePage (pure sync) still works untouched — no media call
// ---------------------------------------------------------------------------
section('assemblePage — pure sync path unchanged (preview safe)');
const pureDrafts = [
  { block_id: 'a', kind: 'hero', block_json: JSON.stringify(getEmitter('hero')?.example || {}), elementor_json: null },
];
const pureOut = assemblePage(pureDrafts, MOCK_BRAND, { seedPrefix: 'pure' });
if (pureOut.sectionsBuilt === 1) ok('sync assemblePage still returns 1 section');
else bad(`sync assemblePage sectionsBuilt=${pureOut.sectionsBuilt}`);
if (!('media' in pureOut)) ok('sync assemblePage does NOT include media key (backwards-compatible)');
else bad(`sync assemblePage leaked media key: ${JSON.stringify(pureOut.media)}`);

// ---------------------------------------------------------------------------
// 7. Helper internals
// ---------------------------------------------------------------------------
section('Helper internals');
const fn1 = mlInternals.filenameForPlaceholder('https://source.unsplash.com/800x600/?warehouse,clean', 3);
if (fn1.startsWith('arion-warehouse-clean') && fn1.endsWith('.jpg')) ok(`filenameForPlaceholder unsplash: ${fn1}`);
else bad(`unsplash filename wrong: ${fn1}`);

const fn2 = mlInternals.filenameForPlaceholder('https://via.placeholder.com/800x600?text=Hello%20World', 0);
if (fn2.startsWith('arion-Hello') && fn2.endsWith('.png')) ok(`filenameForPlaceholder placeholder.com: ${fn2}`);
else bad(`placeholder.com filename wrong: ${fn2}`);

if (mlInternals.inferMimeFromUrl('https://example.com/x.png') === 'image/png') ok('inferMimeFromUrl: .png → image/png');
else bad('inferMimeFromUrl png wrong');
if (mlInternals.inferMimeFromUrl('https://source.unsplash.com/800x600/?x') === 'image/jpeg') ok('inferMimeFromUrl: unsplash default jpeg');
else bad('inferMimeFromUrl unsplash wrong');

if (mlInternals.isAllowedPlaceholder('https://source.unsplash.com/800x600/?x')) ok('isAllowedPlaceholder accepts unsplash');
else bad('isAllowedPlaceholder rejected unsplash');
if (!mlInternals.isAllowedPlaceholder('http://source.unsplash.com/800x600/?x')) ok('isAllowedPlaceholder rejects http://');
else bad('isAllowedPlaceholder allowed http://');
if (!mlInternals.isAllowedPlaceholder('https://customer-cdn.example.com/x.jpg')) ok('isAllowedPlaceholder rejects unknown host');
else bad('isAllowedPlaceholder allowed unknown host');

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${BOLD}Summary:${RESET} ${GREEN}${pass} pass${RESET} · ${RED}${fail} fail${RESET}`);
process.exit(fail === 0 ? 0 : 1);
