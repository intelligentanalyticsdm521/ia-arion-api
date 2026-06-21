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

export const SURFACE = 'arion.website_builder';

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
 * @param {{ model?: string, maxTokens?: number, skipElementor?: boolean }} [args.opts]
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
  if (!o.skipElementor) {
    try {
      elementor = blockToElementorSection({
        kind,
        block: v.data,
        brand,
        seedId: `${siteId || 'preview'}-${kind}-${Date.now()}`,
      });
    } catch (e) {
      console.warn(`[callEmitter] elementorAdapter failed (non-fatal): ${e?.message?.slice(0, 200)}`);
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
    tokens: { input: aiRes.inputTokens, output: aiRes.outputTokens, total: aiRes.inputTokens + aiRes.outputTokens },
    latencyMs: aiRes.latencyMs,
    model: aiRes.model || model,
    costUsd,
  };
}
