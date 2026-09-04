#!/usr/bin/env node
/**
 * How many of the 120 curated library sections can the Portal editor actually
 * offer? — DEV/AUDIT ONLY. Reads nothing but a local JSON file, writes
 * nothing, touches no database, no blob storage and no site.
 *
 *   node scripts/_dev_library_coverage.mjs [path-to-iadm-section-library.json]
 *
 * The default path is Brandon's own authoring export from iadm-template-lab
 * (the same file scripts/upload-section-library.mjs uploads from), so this can
 * be re-run whenever the library changes without going near prod blob storage.
 *
 * The number this prints is the number the walkthrough quotes. Re-run it
 * rather than copying an old figure forward.
 */

import fs from 'node:fs';
import path from 'node:path';
import { libraryCoverage, kindsWithoutLibraryVariants, ARCHETYPES_WITHOUT_A_KIND } from '../lib/websiteBuilder/libraryAdapter.js';

const DEFAULT_EXPORT = 'C:/Users/brand/Downloads/iadm-section-library.json';

const positional = process.argv.slice(2).find((a) => !a.startsWith('--'));
const file = positional || process.env.SECTION_LIBRARY_EXPORT || DEFAULT_EXPORT;
if (!fs.existsSync(file)) {
  console.error(`No library export at ${file}`);
  console.error('Pass the path to iadm-section-library.json as the first argument.');
  process.exit(2);
}

const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const sections = doc?.sections || {};
const rows = Object.entries(sections).map(([blueprint_id, sectionJson]) => ({
  blueprint_id,
  archetype: String(blueprint_id).split('.')[0],
  sectionJson,
}));

// A representative business. Only one field matters to the mapper: a contact
// form has to know which inbox to notify, exactly as the scratch contact
// emitter has always insisted (elementorAdapter refuses a form it cannot
// address). Nothing else here influences pickability.
const BRAND = { email: 'owner@example.invalid' };

const cov = libraryCoverage(rows, { brand: BRAND });

console.log(`library export: ${path.basename(file)}  (generated ${doc.generated || '?'}, ${cov.total} sections)`);
console.log('');
console.log('archetype      total  pickable  editor kind');
console.log('-------------  -----  --------  -----------');
for (const [archetype, n] of Object.entries(cov.byArchetype).sort()) {
  const kind = cov.rows.find((r) => r.archetype === archetype)?.kind || '—';
  console.log(`${archetype.padEnd(13)}  ${String(n.total).padStart(5)}  ${String(n.pickable).padStart(8)}  ${kind}`);
}
console.log('');
console.log(`PICKABLE: ${cov.pickable} of ${cov.total}`);
console.log('');
console.log('why the rest are out:');
for (const [reason, n] of Object.entries(cov.refusals).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(3)}  ${reason}`);
}
console.log('');
console.log('archetypes with no editor kind at all:');
for (const [a, why] of Object.entries(ARCHETYPES_WITHOUT_A_KIND)) console.log(`  ${a}: ${why}`);
console.log('');
console.log(`editor kinds with no library variant: ${kindsWithoutLibraryVariants().join(', ') || '(none)'}`);

if (process.argv.includes('--rows')) {
  console.log('');
  for (const r of cov.rows) {
    console.log(`${r.pickable ? 'YES' : ' no'}  ${r.blueprint_id.padEnd(36)} ${r.reason || ''} ${r.detail || ''}`);
  }
}

if (process.argv.includes('--json')) {
  const out = path.join(process.cwd(), 'library-coverage.json');
  fs.writeFileSync(out, JSON.stringify(cov, null, 2));
  console.log(`\nwrote ${out}`);
}
