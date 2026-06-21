/**
 * Page assembler — concatenates accepted draft blocks into a full
 * Elementor `_elementor_data` array ready to be written to a WP post's
 * `_elementor_data` post meta by wpInjector.
 * --------------------------------------------------------------------------
 * Phase 1 (commit 67dcb83) shipped the *block-level* emitters + adapter:
 * each emitter produces ONE Elementor section node.
 *
 * This module is the page-level glue. It:
 *   1. Iterates the orderedBlocks in display order
 *   2. Asks the elementorAdapter for the section node for each block
 *      (already-cached `elementor_json` is preferred; if absent we re-run the
 *      adapter from `block_json` so this module is also useful for previews)
 *   3. Skips any block whose adapter returns null (unknown kind) — logs to
 *      `skipped[]` so callers can warn the customer
 *   4. Injects the brand's CSS-variable palette into the FIRST section's
 *      settings so brand colours propagate without touching every node
 *
 * The output is exactly what Elementor expects under post_meta
 * `_elementor_data`: a JSON array of section objects. The wpInjector
 * stringifies + slashes it before POSTing to the WP plugin.
 *
 * This file is pure (no DB / HTTP). Easy to unit-test; the verifier does so
 * with mocked drafts.
 */

import { blockToElementorSection } from './elementorAdapter.js';

/**
 * Normalize a single draft row into the shape blockToElementorSection wants.
 * Accepts either `block_json` (parsed object) or its stringified form.
 */
function readDraftBlock(draft) {
  if (!draft) return null;
  if (draft.block_json && typeof draft.block_json === 'object') return draft.block_json;
  if (typeof draft.block_json === 'string') {
    try { return JSON.parse(draft.block_json); } catch { return null; }
  }
  // tolerate snake_case from raw DB rows where the column is `generated_json`
  if (typeof draft.generated_json === 'string') {
    try { return JSON.parse(draft.generated_json); } catch { return null; }
  }
  return null;
}

function readCachedElementor(draft) {
  if (!draft) return null;
  if (draft.elementor_json && typeof draft.elementor_json === 'object') return draft.elementor_json;
  if (typeof draft.elementor_json === 'string') {
    try { return JSON.parse(draft.elementor_json); } catch { return null; }
  }
  return null;
}

/**
 * Build the brand CSS-variable settings blob that we inject into the FIRST
 * section. Elementor's section schema supports custom CSS via the
 * `custom_css` setting on the section level; we use that to define page-wide
 * `--ia-*` variables that downstream widgets can reference for brand
 * theming. This is the lightest-weight way to propagate brand colors
 * without touching every leaf widget on every emit.
 */
function buildBrandCssVars(brand) {
  if (!brand) return null;
  const lines = [];
  if (brand.primary_color)   lines.push(`  --ia-primary: ${brand.primary_color};`);
  if (brand.secondary_color) lines.push(`  --ia-secondary: ${brand.secondary_color};`);
  if (brand.accent_color)    lines.push(`  --ia-accent: ${brand.accent_color};`);
  if (brand.font_family)     lines.push(`  --ia-font: ${brand.font_family};`);
  if (lines.length === 0) return null;
  // Elementor scopes `selector` to the section's wrapper — using :root makes
  // the vars page-global, which is what we want for a brand palette.
  return `:root {\n${lines.join('\n')}\n}`;
}

/**
 * Inject the brand CSS-variable bundle into a section's settings. Returns a
 * NEW section object (does not mutate the input) so re-running the assembler
 * is idempotent.
 */
function withBrandCss(section, brand) {
  const css = buildBrandCssVars(brand);
  if (!css) return section;
  return {
    ...section,
    settings: {
      ...(section.settings || {}),
      // The Elementor Pro "Custom CSS" setting lives under custom_css; for
      // free Elementor we also stash it under _ia_custom_css so the IA
      // plugin can render it via wp_add_inline_style if Pro isn't active.
      custom_css: css,
      _ia_brand_css: css,
    },
  };
}

/**
 * Assemble a full Elementor `_elementor_data` array from ordered draft blocks.
 *
 * @param {Array<{ kind: string, block_json?: object|string, elementor_json?: object|string, block_id?: string }>} orderedBlocks
 *   In display order. Each entry needs at minimum `kind` plus either
 *   `block_json` (so we can re-run the adapter) OR `elementor_json` (cached).
 * @param {object} [brand]              brand context (from brandContext.js)
 * @param {object} [opts]
 * @param {string} [opts.seedPrefix]    deterministic-id seed (defaults to 'page')
 * @returns {{
 *   elementorData: Array<object>,
 *   sectionsBuilt: number,
 *   skipped: Array<{ index: number, kind?: string, block_id?: string, reason: string }>,
 * }}
 */
export function assemblePage(orderedBlocks, brand = {}, opts = {}) {
  const seedPrefix = opts.seedPrefix || 'page';
  const sections = [];
  const skipped = [];

  if (!Array.isArray(orderedBlocks)) {
    return { elementorData: [], sectionsBuilt: 0, skipped: [{ index: -1, reason: 'orderedBlocks must be an array' }] };
  }

  orderedBlocks.forEach((draft, idx) => {
    if (!draft || typeof draft !== 'object') {
      skipped.push({ index: idx, reason: 'falsy or non-object draft' });
      return;
    }
    const kind = draft.kind;
    if (!kind || typeof kind !== 'string') {
      skipped.push({ index: idx, kind, block_id: draft.block_id, reason: 'missing kind' });
      return;
    }

    // Prefer the cached Elementor JSON written by callEmitter at draft time
    // — it's already adapter-converted and validated. Falls back to re-running
    // the adapter on the raw block JSON (useful for re-applies after schema
    // changes to the adapter).
    let section = readCachedElementor(draft);
    if (!section) {
      const block = readDraftBlock(draft);
      if (!block) {
        skipped.push({ index: idx, kind, block_id: draft.block_id, reason: 'no block_json or elementor_json' });
        return;
      }
      section = blockToElementorSection({
        kind,
        block,
        brand,
        seedId: `${seedPrefix}-${idx}-${draft.block_id || kind}`,
      });
    }

    if (!section) {
      skipped.push({ index: idx, kind, block_id: draft.block_id, reason: 'adapter returned null (unknown kind?)' });
      return;
    }
    sections.push(section);
  });

  // Inject brand CSS variables into the FIRST section so the palette is
  // page-global. If no sections survived, nothing to do.
  if (sections.length > 0) {
    sections[0] = withBrandCss(sections[0], brand);
  }

  return {
    elementorData: sections,
    sectionsBuilt: sections.length,
    skipped,
  };
}

export const __test__ = { buildBrandCssVars, withBrandCss, readDraftBlock, readCachedElementor };
