/**
 * Foundation B — ARION reads the ONE business profile.
 *
 * Before this, brandContext built "what is this business" from
 * arion.signup_session.questionnaire_json: whatever someone typed once, during
 * onboarding, possibly a year ago. The owner now maintains that answer on
 * Settings -> Your business, and every product reads the same record.
 *
 * What is pinned:
 *   1. The profile OUTRANKS the questionnaire, field by field.
 *   2. An absent, empty or unreachable profile changes nothing — a site build
 *      must never break because a business has not opened the page.
 *   3. The two shape conversions (services_json -> string[], service_area_json
 *      -> a one-line location) are correct and never throw on rubbish.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { __test__ as brandTest } from '../lib/websiteBuilder/brandContext.js';
import { getBusinessProfile } from '../db/platformPool.js';

const { profileServiceNames, serviceAreaToLocation } = brandTest;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

test('services_json becomes the string[] the emitters interpolate', () => {
  assert.deepEqual(
    profileServiceNames({ services_json: '[{"name":"Gutter clean","offering_id":"x"},{"name":" Roof wash "}]' }),
    ['Gutter clean', 'Roof wash'],
  );
  // A price must never have been stored here in the first place, but if one
  // ever is, the name is still all that reaches the page.
  assert.deepEqual(profileServiceNames({ services_json: '[{"name":"Clean","price":249}]' }), ['Clean']);
});

test('a missing, empty or malformed services_json yields [] and never throws', () => {
  for (const v of [undefined, null, '', '[]', '{not json', '{"a":1}', '[null,"  "]']) {
    assert.deepEqual(profileServiceNames({ services_json: v }), [], `failed on ${JSON.stringify(v)}`);
  }
  assert.deepEqual(profileServiceNames(null), []);
});

test('service_area_json becomes one readable line, the note winning when set', () => {
  assert.equal(
    serviceAreaToLocation({ service_area_json: '{"kind":"list","cities":["Ankeny","Des Moines"],"states":["IA"]}' }),
    'Ankeny, Des Moines, IA',
  );
  assert.equal(
    serviceAreaToLocation({ service_area_json: '{"cities":["Ankeny"],"note":"30 miles around Ankeny"}' }),
    '30 miles around Ankeny',
    'the owner\'s own words beat a generated list',
  );
  for (const v of [undefined, null, '', '{}', 'nonsense', '{"cities":[],"states":[]}']) {
    assert.equal(serviceAreaToLocation({ service_area_json: v }), '', `failed on ${JSON.stringify(v)}`);
  }
});

test('the profile outranks the questionnaire, field by field', () => {
  // Read from source: loadBrandContext needs two live SQL pools, and the thing
  // worth pinning is the PRIORITY ORDER, which is right here in the literal.
  const text = src('lib/websiteBuilder/brandContext.js');
  for (const [field, expr] of [
    ['industry', /industry:\s*profile\?\.industry \|\| answers\.industry/],
    ['description', /description:\s*profile\?\.description \|\| answers\.description/],
    ['tagline', /tagline:\s*profile\?\.tagline \|\| answers\.tagline/],
    ['target_audience', /target_audience:\s*profile\?\.target_audience \|\| answers\.targetAudience/],
    ['brand_voice', /brand_voice:\s*profile\?\.brand_voice \|\| answers\.brandVoice/],
  ]) {
    assert.match(text, expr, `${field} must prefer the profile over the questionnaire`);
  }
  assert.match(text, /services:\s*profileServices\.length \? profileServices : services/);
  assert.match(text, /location:\s*profileLocation \|\| answers\.location/);
});

test('the reader never throws — a site build cannot fail on a missing profile', async () => {
  // No SQL server is reachable from the test runner, which is exactly the
  // "platform DB unavailable" case. It must answer null, like getSharedProfile.
  assert.equal(await getBusinessProfile(null), null, 'no tenant -> null, no query attempted');
});

test('brandContext still defaults every key, profile or not', () => {
  for (const k of ['industry', 'description', 'tagline', 'target_audience', 'services', 'brand_voice', 'location', 'email']) {
    assert.ok(k in brandTest.EMPTY_BRAND, `EMPTY_BRAND must still define ${k}`);
  }
});
