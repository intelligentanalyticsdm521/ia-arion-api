/**
 * Capture what a LIVE client page built in the old dialect looks like, ONCE,
 * as data.
 *
 *   node scripts/dev/capture-legacy-pages.mjs
 *
 * D-156, stream D. The legacy `section` → `column` → `widget` emitters are
 * deleted: nothing has emitted them since 2026-09-16 and keeping a second way
 * to draw a page is the duplication this whole scope exists to remove
 * (`feedback_replace_means_delete`).
 *
 * What must NOT be lost with them is the PROOF that the five live client sites
 * whose pages were built that way still read, still patch and still re-publish
 * untouched. That proof never needed the emitters — it needs one example of
 * each old page shape, and a page shape is DATA. So this script freezes them
 * into `test/fixtures/legacy-page-goldens.json` and the test reads the file.
 *
 * It is kept, and it will not run again after the emitters are gone: it is the
 * provenance note for the fixture, so the next person can see exactly where
 * those trees came from and does not assume somebody typed them.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { legacyBlockToElementorSection, __test__ as adapterTest } from '../../lib/websiteBuilder/elementorAdapter.js';
import { starterBlock } from '../../lib/websiteBuilder/starterSections.js';
import { GOLDEN_BRAND, GOLDEN_BLOCKS } from '../../test/fixtures/container-golden-inputs.mjs';

const out = {};
for (const kind of Object.keys(adapterTest.LEGACY_ADAPTERS)) {
  const block = GOLDEN_BLOCKS[kind] || starterBlock(kind, GOLDEN_BRAND);
  out[kind] = legacyBlockToElementorSection({
    kind, block, brand: GOLDEN_BRAND, seedId: `l-${kind}`, blockId: 'l',
  });
}

const target = path.join(process.cwd(), 'test', 'fixtures', 'legacy-page-goldens.json');
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(`wrote ${target} (${Object.keys(out).length} kinds)`);
