/**
 * Rebuild the container-dialect golden fixtures.
 *
 *   node scripts/dev/build-container-goldens.mjs
 *
 * The goldens are the WHOLE Elementor node every section kind emits, checked
 * in and diffed by test/website-container-dialect.test.mjs. They exist so a
 * change to the dialect shows up as a reviewable diff rather than as a page
 * that looks wrong on somebody's live website a week later.
 *
 * Deterministic: `mintId` is seeded per kind, so running this twice with no
 * source change produces byte-identical output and an empty diff.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { blockToElementorSection } from '../../lib/websiteBuilder/elementorAdapter.js';
import { starterBlock } from '../../lib/websiteBuilder/starterSections.js';
import { listContainerKinds } from '../../lib/websiteBuilder/containerEmitters.js';
import { GOLDEN_BRAND, GOLDEN_BLOCKS } from '../../test/fixtures/container-golden-inputs.mjs';

const out = {};
for (const kind of listContainerKinds()) {
  const block = GOLDEN_BLOCKS[kind] || starterBlock(kind, GOLDEN_BRAND);
  out[kind] = blockToElementorSection({
    kind, block, brand: GOLDEN_BRAND, seedId: `golden-${kind}`, blockId: 'golden',
  });
}

const target = path.join(process.cwd(), 'test', 'fixtures', 'container-goldens.json');
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(`wrote ${target} (${Object.keys(out).length} kinds)`);
