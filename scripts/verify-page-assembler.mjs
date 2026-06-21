#!/usr/bin/env node
/**
 * Verification script for the ARION IL website builder Phase 2 — page
 * assembler + WP injector.
 * --------------------------------------------------------------------------
 * Checks:
 *   1. assemblePage() concatenates 3 mock drafts into a 3-entry
 *      _elementor_data array
 *   2. Brand CSS variables are injected into the FIRST section's settings
 *      (and not into later sections — page-global, not per-section)
 *   3. Re-running the assembler with the same inputs produces stable
 *      element IDs (deterministic — no churn on Elementor's revisions)
 *   4. Skipped tracker fires for unknown / malformed drafts
 *   5. wpInjector POSTs to the right URL with the right auth headers
 *      (mocked fetch — NEVER hits a real customer WP site)
 *   6. wpInjector surfaces plugin errors cleanly
 *
 * Usage:
 *   node scripts/verify-page-assembler.mjs
 *
 * Exit codes:
 *   0 = all checks passed
 *   1 = at least one check failed
 *
 * Read-only against the DB (does not touch SQL at all — pure JS verifier).
 */

import { assemblePage, __test__ as paInternals } from '../lib/websiteBuilder/pageAssembler.js';
import { injectPageToWordpress, __test__ as wpInternals } from '../lib/websiteBuilder/wpInjector.js';
import { getEmitter } from '../lib/websiteBuilder/emitterRegistry.js';
import { blockToElementorSection } from '../lib/websiteBuilder/elementorAdapter.js';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';

let pass = 0;
let fail = 0;

function ok(msg)   { console.log(`  ${GREEN}✔${RESET} ${msg}`); pass++; }
function bad(msg)  { console.log(`  ${RED}✘${RESET} ${msg}`);   fail++; }
function section(title) { console.log(`\n${BOLD}${CYAN}=== ${title} ===${RESET}`); }

const MOCK_BRAND = {
  tenant_id: '11111111-1111-1111-1111-111111111111',
  site_id:   '22222222-2222-2222-2222-222222222222',
  business_name:   'Cedar Ridge Plant Services',
  primary_color:   '#1A3A4A',
  secondary_color: '#FEC82C',
  font_family:     'Inter',
};

// Helper — build a mock draft row that looks like what blocks.js inserts.
function mockDraft(blockId, kind, blockJson) {
  return {
    block_id:      blockId,
    kind,
    // Stringified to match the SQL column type (NVARCHAR(MAX)). assemblePage
    // tolerates both strings and parsed objects — we use strings here to
    // exercise the JSON-parse fallback.
    block_json:    JSON.stringify(blockJson),
    elementor_json: null, // force re-adapter path so we test that branch too
  };
}

const heroBlock = getEmitter('hero')?.example || {
  headline: 'Sanitized by sunrise.',
  subheadline: 'Overnight plant cleaning that gets you back online.',
  cta_text: 'Get a quote',
  cta_href: '/contact',
  image_alt: 'Spotless food-grade plant floor',
  background_style: 'image',
};
const servicesBlock = getEmitter('services')?.example || {
  headline: 'What we do',
  subheadline: 'Industrial cleaning specialists.',
  services: [
    { title: 'Plant deep clean',  description: 'Full overnight sanitation.', icon_name: 'soap' },
    { title: 'Warehouse floors',  description: 'Stripped, sealed, sparkling.', icon_name: 'broom' },
    { title: 'Office janitorial', description: 'Routine office care.',         icon_name: 'spray-can' },
  ],
};
// Third block — another hero (the elementorAdapter only ships hero+services
// in Phase 1; this still gives us a 3-entry _elementor_data array).
const heroBlock2 = {
  ...heroBlock,
  headline: 'Trusted by every plant manager in eastern Iowa.',
  cta_text: 'See case studies',
};

// ---------------------------------------------------------------------------
// 1. Three drafts → three sections
// ---------------------------------------------------------------------------
section('assemblePage — happy path');
const drafts = [
  mockDraft('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hero',     heroBlock),
  mockDraft('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'services', servicesBlock),
  mockDraft('cccccccc-cccc-cccc-cccc-cccccccccccc', 'hero',     heroBlock2),
];
const out = assemblePage(drafts, MOCK_BRAND, { seedPrefix: 'verify-page' });

if (Array.isArray(out.elementorData)) ok(`elementorData is an array`);
else bad(`elementorData not an array (got ${typeof out.elementorData})`);

if (out.elementorData.length === 3) ok(`elementorData has 3 entries`);
else bad(`expected 3 sections, got ${out.elementorData.length}`);

if (out.sectionsBuilt === 3) ok(`sectionsBuilt === 3`);
else bad(`sectionsBuilt = ${out.sectionsBuilt}, expected 3`);

if (Array.isArray(out.skipped) && out.skipped.length === 0) ok(`no drafts skipped`);
else bad(`skipped[] expected to be empty, got ${JSON.stringify(out.skipped)}`);

// Shape sanity per section.
for (const [idx, s] of out.elementorData.entries()) {
  const looksRight = s
    && s.elType === 'section'
    && typeof s.id === 'string'
    && s.id.length >= 5
    && Array.isArray(s.elements)
    && s.elements.length > 0;
  if (looksRight) ok(`section[${idx}] valid (id=${s.id}, ${s.elements.length} child(ren))`);
  else bad(`section[${idx}] malformed: ${JSON.stringify(s).slice(0, 150)}`);
}

// ---------------------------------------------------------------------------
// 2. Brand CSS injected into FIRST section only
// ---------------------------------------------------------------------------
section('Brand CSS variables on first section');
const css0 = out.elementorData[0]?.settings?.custom_css;
const css1 = out.elementorData[1]?.settings?.custom_css;
if (css0 && css0.includes('--ia-primary: #1A3A4A')) ok(`first section has --ia-primary`);
else bad(`first section missing --ia-primary (got: ${String(css0).slice(0, 120)})`);
if (css0 && css0.includes('--ia-secondary: #FEC82C')) ok(`first section has --ia-secondary`);
else bad(`first section missing --ia-secondary`);
if (css0 && css0.includes('--ia-font: Inter')) ok(`first section has --ia-font`);
else bad(`first section missing --ia-font`);
if (!css1) ok(`second section has NO brand CSS (page-global, not per-section)`);
else bad(`second section should not have custom_css, but got: ${String(css1).slice(0, 80)}`);

// ---------------------------------------------------------------------------
// 3. Determinism — re-run produces identical IDs
// ---------------------------------------------------------------------------
section('Deterministic element IDs');
const rerun = assemblePage(drafts, MOCK_BRAND, { seedPrefix: 'verify-page' });
const ids1 = out.elementorData.map((s) => s.id).join('|');
const ids2 = rerun.elementorData.map((s) => s.id).join('|');
if (ids1 === ids2) ok(`re-run produces identical section IDs (${ids1})`);
else bad(`IDs drifted: ${ids1} vs ${ids2}`);

// ---------------------------------------------------------------------------
// 4. Skipped tracker — malformed + unknown-kind drafts
// ---------------------------------------------------------------------------
section('Skipped tracker');
const mixed = [
  mockDraft('11111111-1111-1111-1111-111111111111', 'hero', heroBlock),
  { kind: 'cta', block_json: '{"invalid":"shape"}' },                // unknown kind
  { /* no kind */ block_json: '{}' },                                 // missing kind
  null,                                                               // falsy
  { kind: 'services', block_json: 'not-json' },                       // bad JSON
];
const mixedOut = assemblePage(mixed, MOCK_BRAND);
if (mixedOut.sectionsBuilt === 1) ok(`only 1 valid section from mixed batch`);
else bad(`expected 1 valid section, got ${mixedOut.sectionsBuilt}`);
if (mixedOut.skipped.length === 4) ok(`4 drafts in skipped[]`);
else bad(`expected 4 skipped, got ${mixedOut.skipped.length}: ${JSON.stringify(mixedOut.skipped)}`);
const reasons = mixedOut.skipped.map((s) => s.reason);
if (reasons.some((r) => r.includes('unknown kind'))) ok(`'unknown kind' surfaced`);
else bad(`expected an 'unknown kind' reason; got: ${reasons.join(' | ')}`);
if (reasons.some((r) => r.includes('missing kind'))) ok(`'missing kind' surfaced`);
else bad(`expected a 'missing kind' reason`);

// ---------------------------------------------------------------------------
// 5. wpInjector — happy path with mocked fetch
// ---------------------------------------------------------------------------
section('wpInjector — mocked fetch');
const mockSite = {
  site_id:            MOCK_BRAND.site_id,
  domain:             'cedarridgeplant.com',
  wp_admin_url:       'https://cedarridgeplant.com/wp-admin',
  site_token_raw:     'tok_test_abc123',
  wp_app_password_ref: null,
};

let capturedUrl = null;
let capturedHeaders = null;
let capturedBody = null;
const mockFetchOk = async (url, init) => {
  capturedUrl = url;
  capturedHeaders = init.headers;
  capturedBody = JSON.parse(init.body);
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      data: {
        post_id: 412,
        elementor_edit_url: 'https://cedarridgeplant.com/wp-admin/post.php?post=412&action=elementor',
      },
      plugin_status: 'connected',
    }),
  };
};

const injectRes = await injectPageToWordpress(mockSite, null, out.elementorData, {
  title: 'Home',
  status: 'publish',
  fetchImpl: mockFetchOk,
});

if (injectRes.success) ok(`inject returned success`);
else bad(`inject failed: ${injectRes.error}`);
if (injectRes.postId === 412) ok(`postId=412 round-tripped from plugin response`);
else bad(`postId expected 412, got ${injectRes.postId}`);
if (injectRes.elementorEditUrl?.includes('action=elementor')) ok(`elementorEditUrl set`);
else bad(`elementorEditUrl missing: ${injectRes.elementorEditUrl}`);

// URL + auth header sanity
if (capturedUrl === `https://cedarridgeplant.com${wpInternals.DEFAULT_NAMESPACE}${wpInternals.PAGES_ELEMENTOR_PATH}`) {
  ok(`fetch URL is the IA Plugin /pages/elementor endpoint`);
} else {
  bad(`fetch URL wrong: ${capturedUrl}`);
}
if (capturedHeaders?.['X-Arion-Site-Token'] === 'tok_test_abc123') ok(`X-Arion-Site-Token sent`);
else bad(`X-Arion-Site-Token not sent (got: ${JSON.stringify(capturedHeaders)})`);
if (capturedHeaders?.['Content-Type'] === 'application/json') ok(`Content-Type set`);
else bad(`Content-Type not application/json`);

// Body shape
if (Array.isArray(capturedBody?.elementor_data) && capturedBody.elementor_data.length === 3) {
  ok(`POST body contains elementor_data[] with 3 sections`);
} else {
  bad(`POST body elementor_data shape wrong: ${JSON.stringify(capturedBody).slice(0, 200)}`);
}
if (capturedBody?.title === 'Home') ok(`title forwarded`);
else bad(`title not forwarded, got ${capturedBody?.title}`);
if (capturedBody?.flip_to_builder === true) ok(`flip_to_builder=true`);
else bad(`flip_to_builder not set`);

// ---------------------------------------------------------------------------
// 6. wpInjector — error surfacing
// ---------------------------------------------------------------------------
section('wpInjector — error surfacing');
const mockFetch401 = async () => ({
  ok: false,
  status: 401,
  text: async () => JSON.stringify({ message: 'Bad token' }),
});
const errRes = await injectPageToWordpress(mockSite, 99, out.elementorData, { fetchImpl: mockFetch401 });
if (!errRes.success) ok(`401 surfaced as success=false`);
else bad(`401 should have failed`);
if (errRes.pluginStatus === 'token_invalid') ok(`401 → pluginStatus=token_invalid`);
else bad(`pluginStatus expected token_invalid, got ${errRes.pluginStatus}`);
if (errRes.httpStatus === 401) ok(`httpStatus=401 propagated`);
else bad(`httpStatus expected 401, got ${errRes.httpStatus}`);

// No auth available
const noAuthRes = await injectPageToWordpress(
  { domain: 'cedarridgeplant.com' },
  null,
  out.elementorData,
  { title: 'X', fetchImpl: async () => { throw new Error('should not be called'); } }
);
if (!noAuthRes.success && noAuthRes.error?.includes('no_auth_available')) ok(`missing token → no_auth_available`);
else bad(`missing token did not error cleanly: ${JSON.stringify(noAuthRes)}`);

// No domain
const noHostRes = await injectPageToWordpress(
  { site_token_raw: 't' },
  null,
  out.elementorData,
  { title: 'X', fetchImpl: async () => { throw new Error('should not be called'); } }
);
if (!noHostRes.success && noHostRes.error === 'no_domain_for_site') ok(`missing domain → no_domain_for_site`);
else bad(`missing domain did not error cleanly: ${JSON.stringify(noHostRes)}`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${BOLD}Summary:${RESET} ${GREEN}${pass} pass${RESET} · ${RED}${fail} fail${RESET}`);
process.exit(fail === 0 ? 0 : 1);
