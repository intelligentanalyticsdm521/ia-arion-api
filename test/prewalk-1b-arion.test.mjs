/**
 * Pre-walk fixes 1b — the two ARION defects pass 2 logged and did not fix.
 *
 * 1. THE TWELFTH BUSINESS-NAME CHAIN, and the only one whose last resort
 *    invents a name. lib/websiteBuilder/brandContext.js read the ARION
 *    onboarding questionnaire's `businessName`, then fell back to the part of
 *    the tenant's email address before the @. `hello@…` became a business
 *    called "hello", on its own published website; and on the dev database the
 *    questionnaire held a DIFFERENT business's fixture, so Summit Lawn &
 *    Landscape's own section library came back branded "Fernbrook Garden
 *    Rooms" with hello@fernbrook.invalid in the "Enquiries go to" box
 *    (walk rows D3, S3-7).
 *
 * 2. "WE COULD NOT CHECK WHETHER YOU ARE THE FOUNDER" ANSWERED 500.
 *    Walk row W-4B-F.7 states the rule: 503 `founder_lookup_unavailable`,
 *    retryable — never a 403, and a 500 is worse than the 403 the row forbids
 *    because it is neither actionable nor attributable. Covered in
 *    test/site-request.test.mjs beside the gate's own tests; this file pins
 *    the source so a later edit cannot quietly put the 500 back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUSINESS_NAME_NOT_SET } from '../lib/websiteBuilder/brandContext.js';
import { NEUTRAL_BUSINESS_NAME } from '../lib/businessIdentityClient.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFileSync(path.join(ROOT, rel), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));

/* ── 1. one name, and no invented one ───────────────────────────────────── */

test('the builder asks the ONE business identity, and nothing else, for the name', () => {
  const brand = src('lib/websiteBuilder/brandContext.js');
  assert.match(brand, /import \{ getBusinessIdentity \} from '\.\.\/\.\.\/lib\/businessIdentityClient\.js'/);
  assert.match(brand, /const identity = await getBusinessIdentity\(tenantId\);/);
  assert.match(brand, /const businessName = identityNamed \? String\(identity\.display_name \|\| ''\)\.trim\(\) : '';/);
});

test('the email local-part is never a business name again', () => {
  const brand = src('lib/websiteBuilder/brandContext.js');
  // The exact expression that produced "hello". Not a near-miss: the string.
  assert.doesNotMatch(brand, /businessName = primaryEmail\.split\('@'\)/,
    'a mailbox is not a name, and a website is the worst place to learn that');
  assert.doesNotMatch(brand, /businessName = answers\.businessName/,
    'the questionnaire is one business\'s answer typed once; the record is the answer');
  // And no other split-for-a-name crept in beside it.
  assert.doesNotMatch(brand, /Name[^\n]*\.split\('@'\)/);
});

test('no recorded name is a SENTENCE, never the neutral brand and never a guess', () => {
  assert.equal(BUSINESS_NAME_NOT_SET, 'Business name not set');
  assert.notEqual(BUSINESS_NAME_NOT_SET, NEUTRAL_BUSINESS_NAME,
    'a site\'s BRAND is not "Your Service Provider" — printing that as a business\'s '
    + 'own name on its own website is inventing one');
  const brand = src('lib/websiteBuilder/brandContext.js');
  assert.match(brand, /business_name_status: businessNameStatus/,
    'the surfaces need to know WHICH of the three states this is');
});

test('the founder is told, through the event stream, not only a log line', () => {
  const brand = src('lib/websiteBuilder/brandContext.js');
  assert.match(brand, /import \{ firePlatformEvent \} from '\.\.\/platformEvents\.js'/);
  assert.match(brand, /eventType: 'arion\.brand\.business_name_missing'/);
  // Once per (business, site) per process — a notice filed on every read is a
  // notice nobody reads.
  assert.match(brand, /_nameNoticeSent/);
  // And filing it can never break a site build.
  assert.match(brand, /could not file the missing-name notice/);
});

test('the section library serves the sentence, not an empty string or a guess', () => {
  const pages = src('routes/arion/pages.js');
  assert.match(pages, /businessName: brand\.business_name_status === 'set'/);
  assert.match(pages, /: BUSINESS_NAME_NOT_SET,/);
  assert.match(pages, /businessNameStatus: brand\.business_name_status \|\| 'not_set'/);
});

test('this repo holds no second copy of the name chain', () => {
  // The client is a THIN client: it carries the neutral last resort and the
  // HTTP call, and it decides nothing. A `||` chain over display_name here is
  // the thirteenth chain.
  const client = src('lib/businessIdentityClient.js');
  assert.equal(NEUTRAL_BUSINESS_NAME, 'Your Service Provider',
    'byte-identical to platform-api\'s and to every other repo\'s copy');
  assert.doesNotMatch(client, /display_name \|\|/,
    'the chain lives in platform-api lib/businessIdentity.js and nowhere else');
});

/* ── 2. the founder check that could not run ────────────────────────────── */

test('a founder check that could not RUN is a retryable 503 with a Retry-After', () => {
  const gate = src('middleware/requireFounder.js');
  assert.match(gate, /res\.set\("Retry-After", "5"\)/);
  assert.match(gate, /status\(503\)/);
  assert.match(gate, /code: "founder_lookup_unavailable"/);
  assert.match(gate, /retryable: true/);
  // …and it is still CLOSED. "We could not check" must never open the queue,
  // so the catch block itself must contain no next().
  const from = gate.indexOf('} catch (err) {');
  const catchBlock = gate.slice(from, gate.indexOf('\n}\n', from));
  assert.doesNotMatch(catchBlock, /next\(/,
    'an outage that calls next() is an absence-based guard failing open');
  assert.match(catchBlock, /status\(503\)/);
});

test('a caller who is simply not a founder still gets 403, not the 503', () => {
  const gate = src('middleware/requireFounder.js');
  assert.match(gate, /code: "FORBIDDEN", message: "Founder access required", status: 403/,
    'the two answers must stay two answers — only one of them is actionable');
});
