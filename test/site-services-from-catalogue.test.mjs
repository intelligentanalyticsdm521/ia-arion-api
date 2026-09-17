/**
 * D-23 — the website's "What you do" section comes from Products & Services.
 *
 * BUILDER_USER_TEST_2026-09-16:
 *
 *   "'What you do' asks 'How many services? 1–8', inserts, and the inspector
 *    heading says SERVICES — typed on the page. The three cards it created were
 *    copied off the existing section ('Garden offices', 'Studios and
 *    workshops' — the fixture's content, not Summit's) with the filler line
 *    'What it is and why somebody would want it.' Products & Services is not
 *    offered."
 *
 * Brandon, the same night: *"I need to be able to call products and services."*
 *
 * `brand.service_prices` is the business's OWN catalogue, loaded through
 * lib/websiteBuilder/servicePricing.js — the same one the PRICING section, the
 * booking page and the invoices read. The services section now answers from it
 * first, and only falls back to the onboarding answers (a list of names typed
 * once) and then to prompts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { starterBlock } from '../lib/websiteBuilder/starterSections.js';

const CATALOGUE = [
  { offering_id: 'o1', name: 'Snow Removal', description: 'Plowing and de-icing', price: '$525.00', period: 'per push' },
  { offering_id: 'o2', name: 'Weekly Mowing', description: 'Cut, trim and blow', price: '$65.00', period: 'per visit' },
  { offering_id: 'o3', name: 'Spring Cleanup', description: 'Beds, edges and haul-away', price: '$340.00', period: 'one-off' },
  { offering_id: 'o4', name: 'Mulch Installation', description: '', price: '', period: '' },
];

test('D-23: the services section is built from the price list', () => {
  const block = starterBlock('services', { business_name: 'Summit Lawn & Landscape', service_prices: CATALOGUE });
  assert.deepEqual(
    block.services.map((s) => s.title),
    ['Snow Removal', 'Weekly Mowing', 'Spring Cleanup'],
  );
  assert.equal(block.services[0].description, 'Plowing and de-icing');
});

test('D-23: none of the filler the walk saw survives when there is a catalogue', () => {
  const block = starterBlock('services', { service_prices: CATALOGUE });
  for (const s of block.services) {
    assert.notEqual(s.description, 'What it is and why somebody would want it.',
      'a real description beats the prompt');
  }
});

test('a service in the catalogue with no description still gets a prompt, not a blank card', () => {
  const block = starterBlock('services', { service_prices: [CATALOGUE[3]] });
  assert.equal(block.services.length, 1);
  assert.equal(block.services[0].title, 'Mulch Installation');
  assert.equal(block.services[0].description, 'What it is and why somebody would want it.');
});

test('the onboarding answers are the FALLBACK, and still work', () => {
  // A business that does not keep its prices with us: `services` is the list of
  // names somebody typed during onboarding, and it is better than prompts.
  const block = starterBlock('services', {
    service_prices: [],
    services: ['Gutter clearing', 'Leaf removal'],
  });
  assert.deepEqual(block.services.map((s) => s.title), ['Gutter clearing', 'Leaf removal']);
});

test('the catalogue WINS over the onboarding answers — one source, the better one', () => {
  const block = starterBlock('services', {
    service_prices: CATALOGUE,
    services: ['Gutter clearing', 'Leaf removal'],
  });
  assert.equal(block.services[0].title, 'Snow Removal');
});

test('a business with neither still gets three prompts rather than an empty section', () => {
  const block = starterBlock('services', {});
  assert.equal(block.services.length, 3);
  assert.equal(block.services[0].title, 'First service');
});

test('a malformed catalogue row is skipped, not turned into a nameless card', () => {
  const block = starterBlock('services', {
    service_prices: [{ name: '' }, { description: 'orphan' }, CATALOGUE[1]],
  });
  assert.deepEqual(block.services.map((s) => s.title), ['Weekly Mowing']);
});

test('a catalogue that is not a list does not throw the section open', () => {
  for (const bad of [null, 'nope', 7, {}]) {
    const block = starterBlock('services', { service_prices: bad });
    assert.equal(block.services.length, 3, 'falls all the way through to the prompts');
  }
});

test('the PRICING section still reads the same one catalogue — one source, two views', () => {
  const block = starterBlock('pricing', { service_prices: CATALOGUE });
  assert.equal(block.plans[0].name, 'Snow Removal');
  assert.equal(block.plans[0].price, '$525.00');
  // The catalogue's own word for the billing basis, verbatim (D-09).
  assert.equal(block.plans[0].period, 'per push');
  assert.equal(block.plans[0].offering_id, 'o1');
});
