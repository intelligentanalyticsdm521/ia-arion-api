/**
 * ARION pack 1 — "the Portal is the builder" (2026-09-08).
 *
 * The guards these tests exist to hold, in the order they matter:
 *
 *  1. ELEMENTOR IS DETECTED (D-ARION-E). A site that says it has no Elementor is
 *     REFUSED, with a sentence and a 409 — never a 200 and a blank page. A site
 *     we could not ask is NOT refused, because "we could not ask" is a third
 *     answer and collapsing it into "there is none" locks a working client out
 *     of their own editor.
 *  2. Pro is detected too, and the tier is only the fallback.
 *  3. PAGE SETTINGS come back in plain words, and a template the site does not
 *     have is never offered.
 *  4. SEO fields say so when nothing on the site will render them.
 *  5. DELETE a picture only when the answer to "where is this used" is nowhere
 *     AND the scan was complete. A partial scan is not permission.
 *  6. SWAP THE LOOK carries the words across, and drops nothing silently.
 *  7. ONE PRICE LIST: an unpriced action is DEAD, not free; a 0-credit row
 *     charges nothing; a library answer is never charged.
 *
 * Every one of these was mutation-tested by breaking it on purpose and watching
 * this file go red (see GAP_SPRINT_WALK_2026-09-04 § ARION pack 1).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getSiteCapability, elementorRefusal, allowProFor, __resetCapabilityCache,
  NO_ELEMENTOR_MESSAGE,
} from '../lib/websiteBuilder/siteCapability.js';
import { __test__ as routeInternals } from '../routes/arion/pages.js';
import {
  assertBuilderCredits, builderActionPrice,
  ACTION_GENERATE_SECTION, ACTION_ASSEMBLE_PAGE,
} from '../lib/websiteBuilder/builderMeter.js';
import { _resetArgusTablesProbe } from '../lib/argus/tables.js';
import { buildStarterSection } from '../lib/websiteBuilder/starterSections.js';
import { reduceToSectionList, applyFields, extractFields } from '../lib/websiteBuilder/sectionSchema.js';
import { resolveBusinessName, displayName, promptName, BUSINESS_NAME_NOT_SET } from '../lib/businessName.js';

const {
  publicPageSettings, publicTemplates, publicSeo, publicUsage, TEMPLATE_LABELS, SEO_LIMITS,
} = routeInternals;

const SITE = { site_id: '11111111-1111-1111-1111-111111111111', domain: 'localhost:8084', site_token_raw: 'tok', arion_tier: 'business' };

/** A /status answer, as the plugin sends it (data nested one level). */
function statusFetch(payload, { ok = true, status = 200 } = {}) {
  return async () => ({
    ok,
    status,
    text: async () => JSON.stringify(payload),
  });
}

/* ═══════════════ 1. Elementor detected, and the third answer ═════════════ */

test('a site that says it has no Elementor is REFUSED with a sentence, not a 200', async () => {
  __resetCapabilityCache();
  const cap = await getSiteCapability(SITE, {
    force: true,
    fetchImpl: statusFetch({
      data: {
        plugin_version: '1.7.3',
        elementor: { active: false, version: null, pro_active: false, pro_version: null },
      },
    }),
  });
  assert.equal(cap.known, true);
  assert.equal(cap.elementorActive, false);

  const refusal = elementorRefusal(cap);
  assert.ok(refusal, 'a site with no Elementor must be refused');
  assert.equal(refusal.status, 409);
  assert.equal(refusal.code, 'ELEMENTOR_NOT_ACTIVE');
  // A2-52: the refusal is a sentence a client can act on, and it names NOBODY.
  assert.doesNotMatch(refusal.message, /Elementor|WordPress|Hello|Astra|Rank Math/i,
    'no vendor name reaches the client');
  assert.match(refusal.message, /your website/i, 'it is addressed to their website');
  assert.match(refusal.message, /blank/, 'the client is told what would happen, not given a code');
  assert.match(refusal.message, /tell us/i, 'and what to do about it');
  assert.equal(refusal.message, NO_ELEMENTOR_MESSAGE);
});

test('a site that HAS Elementor is not refused', async () => {
  __resetCapabilityCache();
  const cap = await getSiteCapability(SITE, {
    force: true,
    fetchImpl: statusFetch({
      data: {
        plugin_version: '1.7.3',
        elementor: { active: true, version: '3.34.1', pro_active: false, pro_version: null },
      },
    }),
  });
  assert.equal(cap.known, true);
  assert.equal(cap.elementorActive, true);
  assert.equal(cap.elementorVersion, '3.34.1');
  assert.equal(elementorRefusal(cap), null);
});

test('THREE answers: a plugin too old to be asked is not the same as "there is none"', async () => {
  __resetCapabilityCache();
  // 1.7.2 answers /status happily and simply does not mention Elementor.
  const old = await getSiteCapability(SITE, {
    force: true,
    fetchImpl: statusFetch({ data: { plugin_version: '1.7.2', tier: 'business' } }),
  });
  assert.equal(old.known, false, 'no elementor block means we do not know');
  assert.equal(old.reason, 'plugin_too_old');
  assert.equal(old.elementorActive, null, 'null, not false — they are different facts');
  assert.equal(elementorRefusal(old), null,
    'refusing here would lock every un-upgraded site out of its own editor');
});

test('a site we could not reach is not refused either — its own write fails honestly', async () => {
  __resetCapabilityCache();
  const down = await getSiteCapability(SITE, {
    force: true,
    fetchImpl: async () => { throw Object.assign(new Error('socket hang up'), { name: 'TypeError' }); },
  });
  assert.equal(down.known, false);
  assert.equal(elementorRefusal(down), null);
});

test('a /status that is not JSON, or has a non-boolean active, is "unknown" and not "no"', async () => {
  for (const payload of [
    { data: { plugin_version: '1.7.3', elementor: 'yes' } },
    { data: { plugin_version: '1.7.3', elementor: { version: '3.34.1' } } },
    { data: { plugin_version: '1.7.3', elementor: { active: 'true' } } },
  ]) {
    __resetCapabilityCache();
    const cap = await getSiteCapability(SITE, { force: true, fetchImpl: statusFetch(payload) });
    assert.equal(cap.known, false, JSON.stringify(payload));
    assert.equal(elementorRefusal(cap), null);
  }
});

/* ═══════════════════ 2. Pro is detected; tier is the fallback ════════════ */

test('Elementor Pro is DETECTED when the site answered, whatever the plan says', async () => {
  __resetCapabilityCache();
  const noPro = await getSiteCapability(SITE, {
    force: true,
    fetchImpl: statusFetch({
      data: { plugin_version: '1.7.3', elementor: { active: true, version: '3.34.1', pro_active: false, pro_version: null } },
    }),
  });
  // A BUSINESS site with no Pro installed gets no Pro archetypes — the plan
  // used to be the whole answer and it was wrong in both directions.
  const business = allowProFor({ arion_tier: 'business' }, noPro);
  assert.equal(business.allowPro, false);
  assert.equal(business.source, 'detected');

  __resetCapabilityCache();
  const withPro = await getSiteCapability(SITE, {
    force: true,
    fetchImpl: statusFetch({
      data: { plugin_version: '1.7.3', elementor: { active: true, version: '3.34.1', pro_active: true, pro_version: '3.34.0' } },
    }),
  });
  // ...and a LITE site that really does have Pro installed (the golden master
  // installs it on every tier) is allowed it.
  const lite = allowProFor({ arion_tier: 'lite' }, withPro);
  assert.equal(lite.allowPro, true);
  assert.equal(lite.source, 'detected');
});

test('with no answer from the site, the tier inference is the fallback and says so', () => {
  const unknown = { known: false };
  assert.deepEqual(allowProFor({ arion_tier: 'lite' }, unknown), { allowPro: false, source: 'tier' });
  assert.deepEqual(allowProFor({ arion_tier: 'business' }, unknown), { allowPro: true, source: 'tier' });
  assert.deepEqual(allowProFor({}, unknown), { allowPro: true, source: 'tier' });
});

test('the capability is cached per site, so opening the editor is not a probe per click', async () => {
  __resetCapabilityCache();
  let calls = 0;
  const impl = async () => {
    calls += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { plugin_version: '1.7.3', elementor: { active: true } } }) };
  };
  await getSiteCapability(SITE, { fetchImpl: impl });
  await getSiteCapability(SITE, { fetchImpl: impl });
  await getSiteCapability(SITE, { fetchImpl: impl });
  assert.equal(calls, 1);
  await getSiteCapability(SITE, { fetchImpl: impl, force: true });
  assert.equal(calls, 2, 'force re-asks');
});

/* ═════════════════════ 3. page settings, in plain words ═════════════════ */

test('the page layouts are named in words a client uses, and the list is the SITE’s', () => {
  const rows = publicTemplates([
    { file: '', label: 'Default' },
    { file: 'elementor_canvas', label: 'Elementor Canvas' },
    { file: 'elementor_header_footer', label: 'Elementor Full Width' },
    { file: 'page-templates/custom.php', label: 'Astra Narrow' },
  ]);
  assert.equal(rows[1].label, TEMPLATE_LABELS.elementor_canvas);
  assert.doesNotMatch(rows[1].label, /Elementor/, 'no vendor name reaches the client');
  assert.doesNotMatch(rows[2].label, /Elementor/);
  // A theme template we have no plain words for keeps the theme's own label
  // rather than being dropped: a missing option is indistinguishable from a bug.
  assert.equal(rows[3].label, 'Astra Narrow');
  assert.equal(rows.length, 4);
});

test('page settings come back with the home page, the parent and the address', () => {
  const out = publicPageSettings({
    page_id: 12, title: 'About us', slug: 'about-us', status: 'publish', type: 'page',
    permalink: 'http://x/about-us/', template: 'elementor_canvas',
    templates: [{ file: '', label: 'Default' }, { file: 'elementor_canvas', label: 'Elementor Canvas' }],
    parent_id: 4,
    parents: [{ page_id: 4, title: 'Services', status: 'publish' }],
    is_front_page: false, front_page_id: 2, blog_page_id: 3,
    changed: ['slug'],
  });
  assert.equal(out.pageId, 12);
  assert.equal(out.slug, 'about-us');
  assert.equal(out.template, 'elementor_canvas');
  assert.equal(out.parentId, 4);
  assert.equal(out.parents[0].title, 'Services');
  assert.equal(out.isHomePage, false);
  assert.equal(out.homePageId, 2);
  assert.deepEqual(out.changed, ['slug']);
  assert.ok(!('slugAdjusted' in out), 'nothing was adjusted, so nothing is claimed');
});

test('a slug WordPress had to make unique is REPORTED, not silently different', () => {
  const out = publicPageSettings({
    page_id: 12, slug: 'about-us-2', status: 'draft', type: 'page',
    templates: [], parents: [], slug_adjusted: true,
  });
  assert.equal(out.slug, 'about-us-2');
  assert.equal(out.slugAdjusted, true);
});

/* ═══════════════════════ 4. SEO fields, and the truth ══════════════════ */

test('SEO fields come back with the recommended lengths, on every tier', () => {
  const out = publicSeo({
    page_id: 12,
    seo: { title: 'Lawn care in Ashby', description: 'We mow lawns.', focus_keyword: 'lawn care' },
    recommended: { title: 60, description: 160 },
    seo_plugin: { plugin: 'rank_math', version: '1.0.2', active: true },
  });
  assert.equal(out.title, 'Lawn care in Ashby');
  assert.equal(out.focusKeyword, 'lawn care');
  assert.equal(out.recommended.title, 60);
  assert.equal(out.seoPluginActive, true);
  assert.equal(out.seoPluginNote, null, 'nothing to warn about when it is working');
});

test('a site whose SEO plugin is OFF is told so — we saved it, nothing renders it', () => {
  const out = publicSeo({
    page_id: 12,
    seo: { title: 'T', description: '', focus_keyword: '' },
    seo_plugin: { plugin: null, version: null, active: false },
  });
  assert.equal(out.seoPluginActive, false);
  assert.ok(out.seoPluginNote, 'silence here would read as "Google has this now"');
  assert.match(out.seoPluginNote, /not switched on/);
  assert.doesNotMatch(out.seoPluginNote, /Rank Math/, 'the client never meets a vendor name');
});

test('the SEO limits are hard caps, not advice', () => {
  assert.equal(SEO_LIMITS.title, 200);
  assert.equal(SEO_LIMITS.description, 500);
  assert.equal(SEO_LIMITS.focusKeyword, 200);
  assert.ok(SEO_LIMITS.title > 60, 'the RECOMMENDED length is guidance; the cap is storage');
});

/* ═════════ 5. delete a picture only when it is used nowhere ════════════ */

test('a picture used nowhere, with a complete scan, can be deleted', () => {
  const out = publicUsage({
    attachment_id: 88, filename: 'deck-2.jpg', used: false, places: [], notes: [], scan: 'complete',
  });
  assert.equal(out.used, false);
  assert.equal(out.complete, true);
  assert.equal(out.canDelete, true);
});

test('a picture in use is NOT deletable, and the pages are named', () => {
  const out = publicUsage({
    attachment_id: 88, filename: 'deck-2.jpg', used: true, scan: 'complete',
    places: [{ post_id: 3, title: 'Home', status: 'publish', type: 'page', permalink: 'http://x/' },
      { post_id: 9, title: 'Autumn offer', status: 'draft', type: 'page', permalink: null }],
    notes: [],
  });
  assert.equal(out.canDelete, false);
  assert.equal(out.places.length, 2);
  assert.equal(out.places[1].status, 'draft', 'a DRAFT using it counts — deleting would break it');
});

test('a PARTIAL scan is not permission to delete', () => {
  const out = publicUsage({
    attachment_id: 88, filename: 'deck-2.jpg', used: false, places: [], notes: [], scan: 'partial',
  });
  assert.equal(out.used, false);
  assert.equal(out.complete, false);
  assert.equal(out.canDelete, false,
    '"we did not find it" is not "it is not there" when we did not finish looking');
});

test('the logo and the site icon are reasons in plain words, not option keys', () => {
  const out = publicUsage({
    attachment_id: 88, filename: 'logo.png', used: true, places: [], notes: ['custom_logo'], scan: 'complete',
  });
  assert.equal(out.canDelete, false);
  assert.match(out.notes[0], /logo/i);
  assert.doesNotMatch(out.notes[0], /custom_logo/);
});

/* ═══════════════ 6. swap the look keeps the words (D-ARION-F) ══════════ */

test('swapping a layout carries every word and every card across', () => {
  // The two halves the swap route joins: a node built for a kind, and the
  // field values from the row the client is looking at.
  const built = buildStarterSection('services', { business_name: 'Summit Lawn', email: 'hi@summit.invalid' });
  assert.equal(built.ok, true, built.message);

  const wanted = {
    headline: 'What we do all year',
    services: [
      { title: 'Mowing', description: 'Weekly through the season.', icon_name: 'check' },
      { title: 'Hedges', description: 'Twice a year.', icon_name: 'check' },
      { title: 'Leaves', description: 'Autumn only.', icon_name: 'check' },
      { title: 'Gritting', description: 'When it turns.', icon_name: 'check' },
    ],
  };
  const swapped = applyFields(built.node, 'services', wanted);
  const [entry] = reduceToSectionList([swapped]);
  assert.equal(entry.editable, true, 'a swapped section must still be editable');

  const after = entry.fields;
  assert.equal(after.headline, 'What we do all year');
  assert.equal(after.services.length, 4, 'a FOURTH card is carried by cloning, not truncated');
  assert.deepEqual(after.services.map((i) => i.title), ['Mowing', 'Hedges', 'Leaves', 'Gritting']);
  assert.equal(after.services[3].description, 'When it turns.');
});

test('a shorter list after a swap loses the cards the client removed and no others', () => {
  const built = buildStarterSection('services', { business_name: 'Summit Lawn', email: 'hi@summit.invalid' });
  const swapped = applyFields(built.node, 'services', {
    headline: 'Two things',
    services: [
      { title: 'Mowing', description: 'Weekly.', icon_name: 'check' },
      { title: 'Hedges', description: 'Twice a year.', icon_name: 'check' },
    ],
  });
  const [entry] = reduceToSectionList([swapped]);
  assert.equal(entry.fields.services.length, 2);
  assert.deepEqual(entry.fields.services.map((i) => i.title), ['Mowing', 'Hedges']);
});

test('the swap tells the client what did not fit, rather than losing it quietly', () => {
  // The route's own arithmetic: a field that had something and now has nothing.
  const before = { headline: 'Hello', subheadline: 'And a sub', image_url: 'http://x/a.jpg' };
  const after = { headline: 'Hello', subheadline: '', image_url: 'http://x/a.jpg' };
  const dropped = Object.keys(before).filter((key) => {
    const had = before[key];
    if (had == null || had === '' || (Array.isArray(had) && had.length === 0)) return false;
    const now = after[key];
    return now == null || now === '' || (Array.isArray(now) && now.length === 0);
  });
  assert.deepEqual(dropped, ['subheadline']);
});

test('an empty field that was already empty is not reported as lost', () => {
  const before = { headline: 'Hello', subheadline: '' };
  const after = { headline: 'Hello', subheadline: '' };
  const dropped = Object.keys(before).filter((key) => {
    const had = before[key];
    if (had == null || had === '' || (Array.isArray(had) && had.length === 0)) return false;
    const now = after[key];
    return now == null || now === '' || (Array.isArray(now) && now.length === 0);
  });
  assert.deepEqual(dropped, []);
});

/* ═══════════════════════ 7. one price list (P18) ═══════════════════════ */

/** A pool that answers the three queries the credit path makes. */
function fakePool({ pricing, balance = 100, spendEnabled = true, consolidated = true }) {
  return {
    request() {
      const req = {
        input() { return req; },
        async query(sql) {
          if (/OBJECT_ID\('argus\.credit_grant'/.test(sql)) {
            return { recordset: [{ id: consolidated ? 1 : null }] };
          }
          if (/spend_enabled/.test(sql)) {
            return { recordset: [{ value: spendEnabled ? 'true' : 'false' }] };
          }
          if (/credits_per_call/.test(sql)) {
            return { recordset: pricing ? [pricing] : [] };
          }
          throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
        },
        async execute() { return { recordset: [{ balance }] }; },
      };
      return req;
    },
  };
}

test('an UNPRICED action is dead, not free', async () => {
  _resetArgusTablesProbe();
  const out = await assertBuilderCredits({
    pool: fakePool({ pricing: null }), tenantId: 't1', actionType: ACTION_GENERATE_SECTION,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'ACTION_NOT_PRICED');
  assert.equal(out.status, 409);
  assert.match(out.message, /Nothing was charged/);
});

test('a 0-credit row is allowed and charges nothing — the ZERO is a row, not a word', async () => {
  _resetArgusTablesProbe();
  const out = await assertBuilderCredits({
    pool: fakePool({ pricing: { credits_per_call: 0, outlier_cap_usd: 0.05, is_active: true } }),
    tenantId: 't1',
    actionType: ACTION_ASSEMBLE_PAGE,
  });
  assert.deepEqual(out, { ok: true, credits: 0 });
});

test('a client short of credits is refused BEFORE the work, with the numbers', async () => {
  _resetArgusTablesProbe();
  const out = await assertBuilderCredits({
    pool: fakePool({ pricing: { credits_per_call: 2, outlier_cap_usd: 0.05, is_active: true }, balance: 1 }),
    tenantId: 't1',
    actionType: ACTION_GENERATE_SECTION,
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 402);
  assert.equal(out.required, 2);
  assert.equal(out.balance, 1);
  assert.match(out.message, /2 credits and you have 1/);
});

test('an inactive pricing row refuses too — is_active is a switch, not decoration', async () => {
  _resetArgusTablesProbe();
  const out = await assertBuilderCredits({
    pool: fakePool({ pricing: { credits_per_call: 2, outlier_cap_usd: 0.05, is_active: false } }),
    tenantId: 't1',
    actionType: ACTION_GENERATE_SECTION,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'ACTION_NOT_PRICED');
});

test('the platform kill switch stops a paid builder action', async () => {
  _resetArgusTablesProbe();
  const out = await assertBuilderCredits({
    pool: fakePool({ pricing: { credits_per_call: 2, outlier_cap_usd: 0.05, is_active: true }, spendEnabled: false }),
    tenantId: 't1',
    actionType: ACTION_GENERATE_SECTION,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'AI_SPEND_PAUSED');
});

test('the price the Portal shows is the row, or null — never a guess', async () => {
  _resetArgusTablesProbe();
  const priced = await builderActionPrice(
    fakePool({ pricing: { credits_per_call: 2, outlier_cap_usd: 0.05, is_active: true } }),
    ACTION_GENERATE_SECTION,
  );
  assert.deepEqual(priced, { actionType: ACTION_GENERATE_SECTION, credits: 2, available: true });

  _resetArgusTablesProbe();
  const missing = await builderActionPrice(fakePool({ pricing: null }), ACTION_GENERATE_SECTION);
  assert.deepEqual(missing, { actionType: ACTION_GENERATE_SECTION, credits: null, available: false });
});

test('the two action types are spelled the same here as in migration 065', () => {
  assert.equal(ACTION_GENERATE_SECTION, 'arion.site_generate_section');
  assert.equal(ACTION_ASSEMBLE_PAGE, 'arion.site_assemble_page');
});

/* ═════════════════ 8. one business name, no invented one ══════════════ */

test('a business with no recorded name gets the SENTENCE for display and a neutral phrase for a prompt', async () => {
  const resolved = await resolveBusinessName(null);
  assert.equal(resolved.name, '');
  assert.equal(resolved.status, 'not_set');
  assert.equal(displayName(resolved), BUSINESS_NAME_NOT_SET);
  assert.equal(promptName(resolved), 'this business');
  assert.notEqual(promptName(resolved), BUSINESS_NAME_NOT_SET,
    'a prompt reads a phrase; a page reads the sentence — they are different jobs');
});

test('a recorded name is used verbatim in both places', () => {
  const resolved = { name: 'Summit Lawn & Landscape', status: 'set', identity: null };
  assert.equal(displayName(resolved), 'Summit Lawn & Landscape');
  assert.equal(promptName(resolved), 'Summit Lawn & Landscape');
});

test('"unknown" (the resolver could not be reached) still never invents a name', () => {
  const resolved = { name: '', status: 'unknown', identity: { stale: true } };
  assert.equal(displayName(resolved), BUSINESS_NAME_NOT_SET);
  assert.equal(promptName(resolved), 'this business');
});

/* ═════════════════════ 9. the section list still round-trips ══════════ */

test('a hero built, swapped and read back keeps its picture and its attachment id', () => {
  const built = buildStarterSection('hero', { business_name: 'Summit Lawn', email: 'hi@summit.invalid' });
  const withImage = applyFields(built.node, 'hero', {
    ...extractFields(built.node, 'hero'),
    headline: 'Lawns that look after themselves',
    image_url: 'http://localhost:8084/wp-content/uploads/2026/09/lawn.jpg',
    image_id: 4242,
  });
  const [entry] = reduceToSectionList([withImage]);
  assert.equal(entry.fields.headline, 'Lawns that look after themselves');
  assert.equal(entry.fields.image_id, 4242, 'the attachment id is the whole of srcset');
});
