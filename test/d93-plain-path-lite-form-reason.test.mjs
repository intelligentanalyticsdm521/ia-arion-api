// D-93 on the PLAIN path + D-90 on the Lite form refusal.
//
// A section built from scratch (not from a ready-made layout) must carry the
// same prompts as an adopted layout and never an invented person, quote or
// number; and the sentence a Lite site reads when a layout needs the paid form
// must name no vendor and say what to do instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionKindMeta } from '../lib/websiteBuilder/sectionSchema.js';
import { starterBlock } from '../lib/websiteBuilder/starterSections.js';

const VENDOR = /elementor|wordpress|rank math|astra|kodee|hostinger|wp-admin/i;

test('the Lite form refusal names no vendor and says what to do instead', () => {
  const reason = sectionKindMeta('contact').proReason;
  assert.equal(typeof reason, 'string');
  assert.doesNotMatch(reason, VENDOR);
  assert.match(reason, /plan above Lite/);
  assert.match(reason, /layout without a form/);
});

test('a from-scratch quote, person or number section carries prompts, never an invented claim', () => {
  const quotes = starterBlock('testimonials', {}).testimonials;
  assert.equal(quotes[0].quote, 'What they said');
  assert.equal(quotes[0].attribution, 'Who said it');
  assert.equal(quotes[0].role, 'Their job or company');
  const people = starterBlock('team', {}).members;
  assert.equal(people[0].name, 'Name');
  assert.equal(people[0].role, 'Role');
  const stats = starterBlock('stats', {}).stats;
  assert.equal(stats[0].value, '');
  assert.equal(stats[0].prefix, '');
  assert.equal(stats[0].suffix, '');
  assert.equal(stats[0].label, 'What this counts');
  assert.doesNotMatch(JSON.stringify(stats), /[0-9]/, 'no invented number on a plain stats section');
});
