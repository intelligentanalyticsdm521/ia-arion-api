/**
 * The website link we publish to a Google Business Profile is tagged, once.
 *
 * LEADGEN_POST_CAPTURE_SCOPE_2026-09-04 §8.3 item 5 (locked as L11): every
 * link we publish carries its own UTMs, because referrers are stripped by
 * iOS, in-app browsers and most social apps. For a GBP the set is
 * `utm_source=google&utm_medium=gbp&utm_campaign=profile`. The attribution
 * builder wrote the LUMEN half (`gbpUtms()` in
 * src/services/attribution/utmBuilder.js) and left the arion-api half — the
 * side that actually writes the profile's website link — documented only.
 *
 * The rules that make this safe: never double-tag, never touch a link the
 * client tagged themselves, and only for a tenant that owns SPARK (SPARK is
 * where the attribution lands).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { addUtms, gbpUtms, isTaggable, maybeTagGbpWebsite } from '../lib/gbpUtm.js';

const q = (url) => Object.fromEntries(new URL(url).searchParams.entries());

test('a SPARK tenant\'s profile link gets the documented UTM set', () => {
  const out = maybeTagGbpWebsite('https://cedarridge.test/', { ownsSpark: true });
  assert.deepEqual(q(out), {
    utm_source: 'google',
    utm_medium: 'gbp',
    utm_campaign: 'profile',
  });
});

test('a tenant without SPARK is left alone', () => {
  const url = 'https://cedarridge.test/';
  assert.equal(maybeTagGbpWebsite(url, { ownsSpark: false }), url);
  // Unknown ownership must behave like "no" — the helper is the fail-closed
  // half of a fail-closed pair (tenantOwnsService returns false on error).
  assert.equal(maybeTagGbpWebsite(url, {}), url);
  assert.equal(maybeTagGbpWebsite(url), url);
});

test('tagging twice does not double-tag', () => {
  const once = maybeTagGbpWebsite('https://cedarridge.test/', { ownsSpark: true });
  const twice = maybeTagGbpWebsite(once, { ownsSpark: true });
  assert.equal(twice, once);
  assert.equal((twice.match(/utm_source/g) || []).length, 1);
});

test('a link the client tagged themselves is never rewritten', () => {
  const clientTagged = 'https://cedarridge.test/?utm_source=flyer&utm_medium=print';
  assert.equal(maybeTagGbpWebsite(clientTagged, { ownsSpark: true }), clientTagged);
});

test('existing query and fragment survive tagging', () => {
  const out = maybeTagGbpWebsite('https://cedarridge.test/services?ref=card#quote', { ownsSpark: true });
  const u = new URL(out);
  assert.equal(u.pathname, '/services');
  assert.equal(u.searchParams.get('ref'), 'card');
  assert.equal(u.hash, '#quote');
  assert.equal(u.searchParams.get('utm_medium'), 'gbp');
});

test('a campaign ref overrides the default', () => {
  const out = maybeTagGbpWebsite('https://cedarridge.test/', { ownsSpark: true, campaign: 'loc_42' });
  assert.equal(new URL(out).searchParams.get('utm_campaign'), 'loc_42');
  assert.equal(gbpUtms('loc_42').campaign, 'loc_42');
  assert.equal(gbpUtms().campaign, 'profile');
});

test('anything that is not an http(s) link passes through untouched', () => {
  for (const bad of ['', null, undefined, 'mailto:a@b.test', 'tel:+13195550142',
                     '/relative/path', 'cedarridge.test', 'https://{{domain}}/']) {
    assert.equal(isTaggable(bad), false, `${String(bad)} is not taggable`);
    assert.equal(maybeTagGbpWebsite(bad, { ownsSpark: true }), bad);
  }
});

test('an unparseable http link is returned unchanged rather than thrown on', () => {
  const broken = 'http://';
  assert.equal(maybeTagGbpWebsite(broken, { ownsSpark: true }), broken);
});

test('addUtms with nothing to add is a no-op', () => {
  const url = 'https://cedarridge.test/';
  assert.equal(addUtms(url, {}), url);
});

// --- the wiring ----------------------------------------------------------
//
// The helper is only worth anything if the two places arion-api writes a
// profile's website link actually call it. Both sit behind Google OAuth on a
// real Business Profile, so they are asserted at the source rather than
// exercised against a live listing.

import { readFile } from 'node:fs/promises';
import { tenantOwnsService } from '../lib/coreTenants.js';

test('both GBP website-link writers tag through the helper', async () => {
  const src = await readFile(new URL('../routes/arion.js', import.meta.url), 'utf8');

  // POST /arion/sites/:siteId/gbp/create-listing
  assert.match(
    src,
    /locationBody\.websiteUri = maybeTagGbpWebsite\(/,
    'create-listing must tag the websiteUri it sends to Google',
  );
  // PATCH /arion/business/update
  assert.match(
    src,
    /updates\.websiteUri = maybeTagGbpWebsite\(/,
    'business/update must tag the websiteUri it sends to Google',
  );
  // Both gated on SPARK ownership, never on a hardcoded product list.
  assert.equal(
    (src.match(/tenantOwnsService\(tenantId, 'spark'\)/g) || []).length,
    2,
    'each write path resolves SPARK ownership for itself',
  );
  // And no un-tagged assignment slipped back in.
  const rawAssignments = src.match(/\.websiteUri = (?!maybeTagGbpWebsite)/g) || [];
  assert.equal(rawAssignments.length, 0, 'no GBP website link is written untagged');
});

test('the ownership gate fails closed', async () => {
  // No tenant / no key answers "no" without touching the platform DB, so a
  // caller can never tag a link for a tenant we could not resolve.
  assert.equal(await tenantOwnsService(null, 'spark'), false);
  assert.equal(await tenantOwnsService('11111111-1111-1111-1111-111111111111', ''), false);
});
