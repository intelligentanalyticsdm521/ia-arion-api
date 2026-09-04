/**
 * D4 — every section we author carries its identity.
 *
 * Migration 029:14 establishes the convention: the blueprint id "is set on
 * each section's settings._title at authoring time". The curated library
 * honours it; `elementorAdapter.js` never did — `grep _title` across the
 * adapter found exactly one hit, `tab_title` on FAQ tabs. Without a marker
 * the Portal cannot tell a section it generated from one a human built in
 * Elementor, which is the load-bearing rule for the whole read/write round
 * trip (§3.3: our sections are re-rendered, unknown sections are spliced back
 * byte-for-byte).
 *
 * Evidence: SCOPE_ARION_SITE_BUILDER_2026-09-05 §2.6, §3.3.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blockToElementorSection,
  buildSectionTitle,
  isIaSectionTitle,
  listSupportedKinds,
} from '../lib/websiteBuilder/elementorAdapter.js';
import { assemblePage } from '../lib/websiteBuilder/pageAssembler.js';
import { getEmitter } from '../lib/websiteBuilder/emitterRegistry.js';

const BRAND = {
  business_name: 'Cedar Ridge Plant Services',
  email: 'owner@cedarridge.test',
  primary_color: '#1A3A4A',
};

const HERO_BLOCK = {
  headline: 'Facilities that run themselves',
  subheadline: 'Industrial cleaning across eastern Iowa.',
  cta_text: 'Get a quote',
  cta_href: '#contact',
  background_style: 'solid',
};

test('every supported section kind carries a settings._title handle', () => {
  const kinds = listSupportedKinds();
  assert.ok(kinds.length >= 8, 'all eight emitters are covered');
  for (const kind of kinds) {
    // Each emitter ships a real example of its own output shape — use it so
    // this test tracks the emitters rather than a second set of fixtures.
    const block = getEmitter(kind)?.example;
    assert.ok(block, `${kind} emitter ships an example block`);
    const section = blockToElementorSection({ kind, block, brand: BRAND, seedId: `seed-${kind}` });
    assert.ok(section, `${kind} emits a section`);
    assert.equal(typeof section.settings?._title, 'string', `${kind} must carry settings._title`);
    assert.ok(isIaSectionTitle(section.settings._title), `${kind} handle is an ia: handle`);
    assert.match(section.settings._title, new RegExp(`^ia:${kind}:`), `${kind} handle names its kind`);
  }
});

test('the handle carries the library blueprint id when the block came from the library', () => {
  assert.equal(
    buildSectionTitle({ kind: 'hero', block: { blueprint_id: 'hero.gradient-dual-cta.v1' }, blockId: 'b7' }),
    'ia:hero:hero.gradient-dual-cta.v1:b7',
  );
  assert.equal(buildSectionTitle({ kind: 'hero', block: {}, blockId: 'b7' }), 'ia:hero:scratch:b7');
  assert.equal(buildSectionTitle({ kind: 'hero', block: {} }), 'ia:hero:scratch:-');
});

test('isIaSectionTitle only claims sections we minted', () => {
  assert.equal(isIaSectionTitle('ia:hero:scratch:b1'), true);
  // A hand-authored library section's _title is the bare blueprint id.
  assert.equal(isIaSectionTitle('hero.gradient-dual-cta.v1'), false);
  assert.equal(isIaSectionTitle('Hero'), false);
  assert.equal(isIaSectionTitle(undefined), false);
});

test('assembling names the section with its real draft id, stably', () => {
  const blocks = [{ kind: 'hero', block_id: 'blk-1', block_json: HERO_BLOCK }];
  const a = assemblePage(blocks, BRAND, { seedPrefix: 'site-x' });
  const b = assemblePage(blocks, BRAND, { seedPrefix: 'site-x' });
  assert.equal(a.elementorData[0].settings._title, 'ia:hero:scratch:blk-1');
  assert.equal(a.elementorData[0].settings._title, b.elementorData[0].settings._title);
});

test('a cached section gets its draft id back on assembly', () => {
  // callEmitter stamps the handle before the draft row exists, so the cached
  // tree carries "-" as the id. The assembler knows the id and re-stamps it.
  const cached = blockToElementorSection({ kind: 'hero', block: HERO_BLOCK, brand: BRAND, seedId: 's' });
  assert.equal(cached.settings._title, 'ia:hero:scratch:-');

  const out = assemblePage(
    [{ kind: 'hero', block_id: 'blk-9', block_json: HERO_BLOCK, elementor_json: cached }],
    BRAND,
  );
  assert.equal(out.elementorData[0].settings._title, 'ia:hero:scratch:blk-9');
});

test('a hand-authored _title is never overwritten', () => {
  // A curated-library section carries its blueprint id in _title at authoring
  // time (migration 029:14). Re-stamping it would break the row/blob join.
  const librarySection = {
    id: 'abc1234',
    elType: 'section',
    settings: { _title: 'hero.gradient-dual-cta.v1', structure: '10' },
    elements: [],
  };
  const out = assemblePage(
    [{ kind: 'hero', block_id: 'blk-9', elementor_json: librarySection }],
    BRAND,
  );
  assert.equal(out.elementorData[0].settings._title, 'hero.gradient-dual-cta.v1');
});

test('the brand CSS injection on the first section does not drop the handle', () => {
  const out = assemblePage([{ kind: 'hero', block_id: 'blk-1', block_json: HERO_BLOCK }], BRAND);
  assert.equal(out.elementorData[0].settings._title, 'ia:hero:scratch:blk-1');
  assert.ok(out.elementorData[0].settings.custom_css, 'brand CSS still injected');
});
