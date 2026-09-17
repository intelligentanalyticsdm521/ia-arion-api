/**
 * Extract the page engine's OWN container controls for the pin test.
 *
 *   node scripts/dev/extract-container-controls.mjs
 *
 * D-156 conformance (catalogue point 12: "any test asserts against the machine
 * files"). `test/website-container-controls.test.mjs` asserts that every
 * settings key `elementorTree.js` can publish for a container is a control the
 * page engine actually has, and that every VALUE it can emit is one that
 * control offers. It cannot read the 6.9 MB machine file itself — a test that
 * depends on a file outside the repo is a test that fails on a fresh clone —
 * so this script writes the extract it reads.
 *
 * THE KEYS ARE NOT TYPED IN HERE. They come from running the emitter over a
 * node that sets EVERYTHING a container can hold, so a key the emitter gains
 * tomorrow is extracted tomorrow and a key it can no longer emit disappears.
 * A key the emitter produces that the page engine does NOT have makes this
 * script fail loudly rather than write a fixture that would bless it.
 *
 * Source: BUILDER_WIDGET_CATALOG_2026-09-17.pro.json — the Elementor editor's
 * own widget registry, read live off intelligentanalyticsdm.com (Elementor
 * 4.1.4 free + Pro 4.1.1) on 2026-09-17. Override the path with
 * IA_CATALOG_PRO_JSON.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { MAXIMAL_CONTAINER, emittedContainerSettings, SETTINGS_NOT_CONTROLS } from '../../test/fixtures/container-controls-input.mjs';

const MACHINE = process.env.IA_CATALOG_PRO_JSON
  || 'C:/dev/claude code/overnight-report/BUILDER_WIDGET_CATALOG_2026-09-17.pro.json';

if (!existsSync(MACHINE)) {
  console.error(`The machine file is not where this script looked:\n  ${MACHINE}\n`
    + 'Pass IA_CATALOG_PRO_JSON=<path to BUILDER_WIDGET_CATALOG_2026-09-17.pro.json>.');
  process.exit(1);
}

const registry = JSON.parse(readFileSync(MACHINE, 'utf8'));
const controls = registry?.elements?.container?.controls;
if (!controls || typeof controls !== 'object') {
  console.error('That file has no `elements.container.controls` — is it the Pro registry export?');
  process.exit(1);
}

/** `padding_tablet` is `padding` on the tablet device, not a control of its own. */
const DEVICE_SUFFIX = /_(tablet|mobile)$/;

const emitted = emittedContainerSettings(MAXIMAL_CONTAINER);
const wanted = new Set();
const missing = [];
for (const key of emitted) {
  if (SETTINGS_NOT_CONTROLS.includes(key)) continue;
  // The EXACT key first: `hide_mobile` is its own control, not `hide` on a
  // device. Only a key the engine does not have at all is then tried as a
  // per-device override of its base control.
  if (controls[key]) { wanted.add(key); continue; }
  const base = key.replace(DEVICE_SUFFIX, '');
  if (!controls[base]) { missing.push(key); continue; }
  if (!controls[base].responsive) {
    missing.push(`${key} (the page engine's \`${base}\` is not per-device)`);
    continue;
  }
  wanted.add(base);
}

if (missing.length) {
  console.error('The emitter publishes keys the page engine does not have:\n  '
    + `${missing.join('\n  ')}\n`
    + 'That is the defect the pin test exists to catch — fix the emitter, do not '
    + 'regenerate the fixture around it.');
  process.exit(1);
}

const out = {
  _comment: [
    'EXTRACTED from BUILDER_WIDGET_CATALOG_2026-09-17.pro.json — the Elementor',
    'editor\'s own registry, read live off intelligentanalyticsdm.com (Elementor',
    '4.1.4 free + Pro 4.1.1) on 2026-09-17. Element `container`.',
    '',
    'Every key here is one `lib/websiteBuilder/elementorTree.js` can publish for',
    'a container. The keys are not typed in: they come from running the emitter',
    'over `test/fixtures/container-controls-input.mjs`, so this file is the',
    'answer to "is every key we publish real, with a value it accepts?".',
    '',
    'Regenerate only when the emitter changes or the page engine itself does:',
    '  node scripts/dev/extract-container-controls.mjs',
    'and read the diff — a key appearing here is a key appearing on every',
    'client website we publish.',
  ],
  elementor_version: registry.elementorVersion || null,
  pro: !!registry.pro,
  element: 'container',
  extracted_from: path.basename(MACHINE),
  controls: {},
};

for (const key of [...wanted].sort()) {
  const c = controls[key];
  out.controls[key] = {
    type: c.type,
    ...(c.responsive ? { responsive: true } : {}),
    ...(Array.isArray(c.options) ? { options: c.options } : {}),
    ...(c.default !== undefined ? { default: c.default } : {}),
  };
}

const target = path.join(process.cwd(), 'test', 'fixtures', 'elementor-container-controls.json');
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
console.log(`wrote ${target} (${Object.keys(out.controls).length} controls, from ${emitted.length} emitted keys)`);
