/**
 * Generic emitter call wrapper for the ARION IL website builder.
 * --------------------------------------------------------------------------
 *  1. Looks up the emitter from the registry by `kind`
 *  2. Builds the system + user prompts from brand + sectionContext
 *  3. Calls Anthropic via lib/websiteBuilder/anthropicClient.js
 *  4. Validates the JSON output against the emitter's schema
 *  5. Logs tokens + cost to lumen.ai_usage
 *  6. Optionally converts the block to an Elementor section
 *  7. Returns { ok, block, elementor, tokens, latencyMs, model, error }
 *
 * Persistence of the draft to arion.site_block_draft is the route handler's
 * job, NOT this module's — keeps callEmitter pure-ish + reusable from
 * scripts (verify, smoke tests) without needing a tenant.
 *
 * Logging policy:
 *   - Every call (success OR failure) writes one row to lumen.ai_usage,
 *     with ok=0 + error_code populated on failure. This is the canonical
 *     "did the IL fire?" audit trail.
 *   - We never let an audit write fail the request — wrap in try/catch.
 *
 * Surface name: 'arion.website_builder'  (memory: IL surfaces are per-platform)
 */

import sql from 'mssql';
import { getEmitter } from './emitterRegistry.js';
import { callAnthropic, DEFAULT_MODEL, estimateCostUsd } from './anthropicClient.js';
import { blockToElementorSection } from './elementorAdapter.js';
import { assertTenantUnderCap } from './costGuard.js';
import { pickAndPrepareSection } from './sectionLibrary.js';

export const SURFACE = 'arion.website_builder';

// Conservative estimate for one block emission against haiku-4-5. Real cost
// (computed after the call from token counts) typically lands $0.001-$0.05.
// We use a deliberately-too-high estimate as the cap-check headroom so the
// LAST call before the cap is hit still refuses — better to leave $0.50 on
// the table than charge $0.50 over.
const DEFAULT_ESTIMATED_COST_USD = 0.50;

/**
 * Write one row to lumen.ai_usage. Never throws — logs and swallows on
 * failure (we don't want audit-table issues to break the build flow).
 */
async function logUsage(pool, {
  tenantId, surface, subKind, model, inputTokens, outputTokens,
  latencyMs, costUsd, ok, errorCode, meta,
}) {
  if (!pool) return;
  try {
    await pool.request()
      .input('tenant_id',     sql.UniqueIdentifier, tenantId)
      .input('surface',       sql.NVarChar(50),     surface)
      .input('sub_kind',      sql.NVarChar(50),     subKind || null)
      .input('provider',      sql.NVarChar(32),     'anthropic')
      .input('model_id',      sql.NVarChar(64),     model || null)
      .input('input_tokens',  sql.Int,              inputTokens || null)
      .input('output_tokens', sql.Int,              outputTokens || null)
      .input('latency_ms',    sql.Int,              latencyMs || null)
      .input('cost_usd',      sql.Decimal(10, 4),   costUsd == null ? null : Number(costUsd))
      .input('ok',            sql.Bit,              ok ? 1 : 0)
      .input('error_code',    sql.NVarChar(64),     errorCode || null)
      .input('meta_json',     sql.NVarChar(sql.MAX), meta ? JSON.stringify(meta) : null)
      .query(`
        INSERT INTO lumen.ai_usage
          (tenant_id, surface, sub_kind, provider, model_id,
           input_tokens, output_tokens, latency_ms, cost_usd,
           ok, error_code, meta_json)
        VALUES
          (@tenant_id, @surface, @sub_kind, @provider, @model_id,
           @input_tokens, @output_tokens, @latency_ms, @cost_usd,
           @ok, @error_code, @meta_json)
      `);
  } catch (e) {
    console.warn(`[callEmitter:logUsage] insert failed (non-fatal): ${e?.message?.slice(0, 200)}`);
  }
}

/**
 * Main entry. The route handler calls this once per generation request.
 *
 * @param {object} args
 * @param {string} args.kind                 — registered emitter kind ('hero', 'services', ...)
 * @param {object} args.brand                — loaded via brandContext.loadBrandContext()
 * @param {object} [args.sectionContext]     — optional per-call overrides
 * @param {string} args.tenantId             — for ai_usage logging
 * @param {string} [args.siteId]             — for ai_usage meta
 * @param {string} [args.userId]             — for ai_usage meta
 * @param {import('mssql').ConnectionPool} [args.pool] — services pool for ai_usage logging
 * @param {{
 *   model?: string,
 *   maxTokens?: number,
 *   skipElementor?: boolean,
 *   skipCapGuard?: boolean,    // verifier scripts only; never set from route handlers
 *   estimatedCostUsd?: number, // override the $0.50 default headroom estimate
 * }} [args.opts]
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   block?: object,
 *   elementor?: object|null,
 *   tokens?: { input: number, output: number, total: number },
 *   latencyMs?: number,
 *   model?: string,
 *   costUsd?: number|null,
 *   raw?: string,                // raw text on validation failure (debug)
 *   error?: { code: string, message: string }
 * }>}
 */
export async function callEmitter({
  kind,
  brand,
  sectionContext,
  tenantId,
  siteId,
  userId,
  pool,
  opts,
}) {
  const o = opts || {};
  const emitter = getEmitter(kind);
  if (!emitter) {
    return {
      ok: false,
      error: { code: 'unknown_kind', message: `No emitter registered for kind="${kind}"` },
    };
  }
  if (!brand || typeof brand !== 'object') {
    return { ok: false, error: { code: 'bad_brand', message: 'brand context required' } };
  }
  if (!tenantId) {
    return { ok: false, error: { code: 'bad_tenant', message: 'tenantId required' } };
  }

  const { system, user } = emitter.buildPrompts({ brand, sectionContext: sectionContext || {} });
  const model = o.model || emitter.model || DEFAULT_MODEL;
  const maxTokens = o.maxTokens || emitter.maxTokens || 1500;

  // ─── SECTION LIBRARY SHORT-CIRCUIT ───────────────────────────────────────
  // If the emitter declares an archetype mapping AND the curated library
  // (migration 029_arion_section_library + the iadm-template-lab blob upload)
  // has variants for it, skip the Anthropic call entirely and inject the
  // best-matching library section directly. Saves $ per onboarding and
  // ships a known-good Elementor structure the founder hand-authored.
  //
  // Tier gating: Lite tier sites do NOT have Elementor Pro installed (see
  // reference_arion_plugin_stack.md), so we exclude Pro-dependent variants
  // (the 11 form-widget sections). For Standard+ tier we allow Pro variants.
  //
  // Bypassed when:
  //   - emitter.archetype is null/missing (e.g. gallery — no library match)
  //   - opts.skipLibrary === true (verifier scripts that need the raw block JSON)
  //   - the library returns no matching variants for the tier (logs and falls through)
  const tier = String(brand?.tier || '').toLowerCase();
  const allowPro = tier !== 'lite';
  if (emitter.archetype && o.skipLibrary !== true) {
    try {
      const picked = await pickAndPrepareSection({
        archetype: emitter.archetype,
        brand,
        allowPro,
        requirePro: false,
      });
      if (picked && picked.sectionJson) {
        // Note: we DO NOT write to lumen.ai_usage on library hits — there was
        // no provider spend. The route handler / onboardingDriver tracks the
        // blueprint_id in provisioning_details_json.sections_used[] for
        // attribution.
        return {
          ok: true,
          // Library sections carry their own copy; there's no semantic block
          // JSON to expose. Set block to a minimal marker so downstream code
          // can detect "this came from the library" without crashing readers
          // that expect an object.
          block: { source: 'section_library', blueprint_id: picked.meta.blueprint_id },
          elementor: picked.sectionJson,
          tokens: { input: 0, output: 0, total: 0 },
          latencyMs: 0,
          model: 'section_library',
          costUsd: 0,
          source: 'section_library',
          blueprint_id: picked.meta.blueprint_id,
          libraryMeta: {
            archetype:    picked.meta.archetype,
            variant_key:  picked.meta.variant_key,
            blueprint_id: picked.meta.blueprint_id,
            version:      picked.meta.version,
            dependencies: picked.meta.dependencies,
          },
        };
      }
      // No variants matched → log and fall through to Anthropic.
      // (Verbose only on the gallery emitter would be noisy; pick the kind
      // here so this line is informative without spamming when archetype is null.)
      console.log(`[callEmitter:${kind}] section library returned no variants for archetype=${emitter.archetype} allowPro=${allowPro} — falling back to scratch-emit`);
    } catch (e) {
      console.warn(`[callEmitter:${kind}] section library lookup failed (non-fatal, falling back to scratch-emit): ${e?.message?.slice(0, 200)}`);
    }
  }

  // ─── COST GUARD ──────────────────────────────────────────────────────────
  // BEFORE the Anthropic call: refuse if this tenant has blown its monthly
  // (or daily) $ cap. Open-fails to ok=true on DB errors so a transient SQL
  // blip doesn't take the builder offline — see lib/websiteBuilder/costGuard.js.
  //
  // We DO NOT write a lumen.ai_usage row on cap-deny — there was no provider
  // spend. The route handler turns this into HTTP 402 (Payment Required).
  if (pool && o.skipCapGuard !== true) {
    const estimatedCostUsd = Number.isFinite(o.estimatedCostUsd) && o.estimatedCostUsd >= 0
      ? Number(o.estimatedCostUsd) : DEFAULT_ESTIMATED_COST_USD;
    const guard = await assertTenantUnderCap(pool, {
      tenantId,
      surface: SURFACE,
      estimatedCostUsd,
    });
    if (!guard.ok) {
      return {
        ok: false,
        error: {
          code: 'cap_exceeded',
          message: `${guard.scope === 'daily' ? 'Daily' : 'Monthly'} AI website builder spend cap reached for this tenant. Cap=$${guard.capUsd.toFixed(2)}, spent=$${Number(guard.spentUsd).toFixed(2)}, remaining=$${Number(guard.remainingUsd).toFixed(2)}.`,
          scope: guard.scope,
          reason: guard.reason,
          cap: guard.capUsd,
          spent: Number(guard.spentUsd),
          remaining: Number(guard.remainingUsd),
          source: guard.source,
        },
      };
    }
  }

  const aiRes = await callAnthropic({
    model,
    system,
    user,
    maxTokens,
    responseFormat: 'json',
  });

  const costUsd = estimateCostUsd({
    model: aiRes.model || model,
    inputTokens: aiRes.inputTokens,
    outputTokens: aiRes.outputTokens,
  });

  if (!aiRes.ok) {
    await logUsage(pool, {
      tenantId, surface: SURFACE, subKind: kind, model: aiRes.model || model,
      inputTokens: aiRes.inputTokens, outputTokens: aiRes.outputTokens,
      latencyMs: aiRes.latencyMs, costUsd,
      ok: false, errorCode: aiRes.error?.code || 'unknown',
      meta: { site_id: siteId || null, user_id: userId || null, stage: 'anthropic_call', error: aiRes.error?.message?.slice(0, 200) },
    });
    return {
      ok: false,
      tokens: { input: aiRes.inputTokens, output: aiRes.outputTokens, total: aiRes.inputTokens + aiRes.outputTokens },
      latencyMs: aiRes.latencyMs,
      model: aiRes.model || model,
      costUsd,
      raw: aiRes.text || null,
      error: aiRes.error,
    };
  }

  // Validate the JSON shape against the emitter's schema.
  const v = emitter.validate(aiRes.data);
  if (!v.ok) {
    await logUsage(pool, {
      tenantId, surface: SURFACE, subKind: kind, model: aiRes.model || model,
      inputTokens: aiRes.inputTokens, outputTokens: aiRes.outputTokens,
      latencyMs: aiRes.latencyMs, costUsd,
      ok: false, errorCode: v.error?.code || 'validation_failed',
      meta: { site_id: siteId || null, user_id: userId || null, stage: 'validate', error: v.error?.message?.slice(0, 200) },
    });
    return {
      ok: false,
      tokens: { input: aiRes.inputTokens, output: aiRes.outputTokens, total: aiRes.inputTokens + aiRes.outputTokens },
      latencyMs: aiRes.latencyMs,
      model: aiRes.model || model,
      costUsd,
      raw: aiRes.text || null,
      error: v.error,
    };
  }

  // Success — convert to Elementor unless explicitly skipped.
  let elementor = null;
  let elementorError = null;
  if (!o.skipElementor) {
    try {
      elementor = blockToElementorSection({
        kind,
        block: v.data,
        brand,
        seedId: `${siteId || 'preview'}-${kind}-${Date.now()}`,
      });
    } catch (e) {
      // Non-fatal for the DRAFT (the block JSON is still worth keeping) but
      // never silent: the reason travels back to the caller so the portal can
      // say why the section has no Elementor tree instead of showing a green
      // tick over an unbuildable block.
      elementorError = {
        code: e?.code || 'adapter_error',
        message: String(e?.message || 'elementorAdapter failed').slice(0, 300),
      };
      console.warn(`[callEmitter:${kind}] elementorAdapter refused: ${elementorError.message}`);
    }
  }

  await logUsage(pool, {
    tenantId, surface: SURFACE, subKind: kind, model: aiRes.model || model,
    inputTokens: aiRes.inputTokens, outputTokens: aiRes.outputTokens,
    latencyMs: aiRes.latencyMs, costUsd,
    ok: true, errorCode: null,
    meta: { site_id: siteId || null, user_id: userId || null, stage: 'ok' },
  });

  return {
    ok: true,
    block: v.data,
    elementor,
    elementorError,
    tokens: { input: aiRes.inputTokens, output: aiRes.outputTokens, total: aiRes.inputTokens + aiRes.outputTokens },
    latencyMs: aiRes.latencyMs,
    model: aiRes.model || model,
    costUsd,
  };
}
