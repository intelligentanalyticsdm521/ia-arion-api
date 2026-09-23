/**
 * ARION IL website builder — block generation endpoints.
 * --------------------------------------------------------------------------
 * Mounted at: /arion/sites/:siteId/blocks  (via routes/arion.js)
 * Auth:       /arion is gated by requireAuth + tenantResolution +
 *             requireArionAccess (see index.js). All handlers here can
 *             trust req.tenant.tenantId and req.platformUser.userId.
 *
 * Routes:
 *   POST /:kind            — generate a new block draft for the given site
 *                            Body: { sectionContext?: {...}, brandOverride?: {...} }
 *                            Returns: { block_id, kind, block_json, elementor_json,
 *                                        tokens_used, latency_ms, cost_usd,
 *                                        model_id, created_at }
 *
 *   GET  /                 — list draft+accepted blocks for the site
 *   GET  /:blockId         — fetch one block draft
 *   POST /:blockId/accept  — flip accepted=1 (idempotent)
 *
 * NOTE: the underlying provider (Claude / Anthropic) is implementation
 * detail. Per memory `reference_intelligence_layer_terminology.md`, never
 * surface "Claude" / "OpenAI" in this endpoint's responses — surface name
 * is "ARION IL" or "Website Builder".
 */

import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import { callEmitter } from '../../lib/websiteBuilder/callEmitter.js';
import { loadBrandContext, mergeBrandContext } from '../../lib/websiteBuilder/brandContext.js';
import { hasEmitter, listEmitterKinds } from '../../lib/websiteBuilder/emitterRegistry.js';
import { assemblePage, assemblePageWithMedia } from '../../lib/websiteBuilder/pageAssembler.js';
import { injectPageToWordpress } from '../../lib/websiteBuilder/wpInjector.js';
// ONE PRICE LIST (P18). Before this, generating a section quoted a price the
// Portal invented client-side and the server debited nothing at all
// (grep meterAndAudit here = 0 hits), while costGuard enforced a dollar ceiling
// nobody was shown. Both actions are priced in argus.action_pricing now and
// charged through the one metering path.
import {
  assertBuilderCredits, chargeBuilderAction,
  ACTION_GENERATE_SECTION, ACTION_ASSEMBLE_PAGE,
} from '../../lib/websiteBuilder/builderMeter.js';

const router = Router({ mergeParams: true });

function badReq(res, code, message) {
  return res.status(400).json({ error: { code, message, status: 400 } });
}
function notFound(res, message) {
  return res.status(404).json({ error: { code: 'NOT_FOUND', message, status: 404 } });
}
function serverErr(res, err, where) {
  console.error(`[${where}]`, err);
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
}

/**
 * Verify the site belongs to the calling tenant. Returns the site row or
 * null. Cheap — single PK lookup.
 */
async function loadSiteForTenant(pool, { tenantId, siteId }) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('siteId',   sql.UniqueIdentifier, siteId)
    .query(`SELECT TOP 1 site_id, tenant_id, domain
              FROM arion.site
             WHERE tenant_id = @tenantId AND site_id = @siteId`);
  return r.recordset[0] || null;
}

// ---------------------------------------------------------------------------
// POST /arion/sites/:siteId/blocks/:kind  — generate a new draft block
// ---------------------------------------------------------------------------
router.post('/:kind', async (req, res, next) => {
  // `/assemble` is declared further down this file; Express matches routes in
  // declaration order, so without this hand-off every assemble call answered
  // 404 UNKNOWN_KIND "assemble" (walk defect arion-assemble-route-shadowed).
  if (req.params.kind === 'assemble') return next();
  const tenantId = req.tenant?.tenantId;
  const userId = req.platformUser?.userId || null;
  const { siteId, kind } = req.params;
  const body = req.body || {};

  if (!tenantId) return badReq(res, 'NO_TENANT', 'Tenant not resolved');
  if (!siteId)   return badReq(res, 'NO_SITE', 'siteId required');
  if (!kind)     return badReq(res, 'NO_KIND', 'kind required');

  if (!hasEmitter(kind)) {
    return res.status(404).json({
      error: {
        code: 'UNKNOWN_KIND',
        message: `No emitter registered for kind="${kind}". Known: ${listEmitterKinds().join(', ')}`,
        status: 404,
      },
    });
  }

  try {
    const pool = await getServicesPool();
    const site = await loadSiteForTenant(pool, { tenantId, siteId });
    if (!site) return notFound(res, 'Site not found for this tenant');

    // 0. THE PRICE, from the one price list, BEFORE any work (P18). A client
    //    who cannot afford this is told now, not after a model has been paid
    //    for. The number the Portal showed came from the same row.
    const afford = await assertBuilderCredits({ pool, tenantId, actionType: ACTION_GENERATE_SECTION });
    if (!afford.ok) {
      return res.status(afford.status).json({
        error: { code: afford.code, message: afford.message, status: afford.status },
        ...(afford.balance != null ? { meta: { balance: afford.balance, required: afford.required } } : {}),
      });
    }

    // 1. Load brand context (site + signup questionnaire + tenant fallbacks).
    const baseBrand = await loadBrandContext(pool, { tenantId, siteId });
    const brand = body.brandOverride
      ? mergeBrandContext(baseBrand, body.brandOverride)
      : baseBrand;

    // 2. Call the emitter (validates output + logs tokens to lumen.ai_usage).
    const result = await callEmitter({
      kind,
      brand,
      sectionContext: body.sectionContext || {},
      tenantId,
      siteId,
      userId,
      pool,
    });

    if (!result.ok) {
      // Audit row was already written by callEmitter (except for cap_exceeded
      // — no provider call happened). Surface error to client.
      const code = result.error?.code || 'EMITTER_FAILED';
      const httpStatus = code === 'cap_exceeded' ? 402  // Payment Required — tenant over $ cap
                       : code === 'unknown_kind' ? 404
                       : code === 'invalid_json' || code === 'shape_error' || code.startsWith('missing_') ? 422
                       : code.startsWith('http_4') ? 502
                       : 500;
      const errBody = {
        error: {
          code: code.toUpperCase(),
          message: result.error?.message || 'Block generation failed',
          status: httpStatus,
        },
        meta: {
          tokens_used: result.tokens || null,
          latency_ms: result.latencyMs || null,
          model_id: result.model || null,
        },
      };
      // For cap_exceeded, attach the spend/cap breakdown so the portal can
      // render "You've used $X of $Y this month" without a follow-up call.
      if (code === 'cap_exceeded') {
        errBody.error.cap = result.error.cap;
        errBody.error.spent = result.error.spent;
        errBody.error.remaining = result.error.remaining;
        errBody.error.scope = result.error.scope;
        errBody.error.source = result.error.source;
      }
      return res.status(httpStatus).json(errBody);
    }

    // 2b. CHARGE - and only for work a provider actually did. Six of the eight
    //     archetypes are answered out of the curated section library with no
    //     model call at all (callEmitter's short-circuit), and a library answer
    //     is free: charging for it would be inventing a cost, the mirror of the
    //     defect this is fixing.
    const fromLibrary = result.source === 'section_library';
    const charged = fromLibrary
      ? { ok: true, creditsCharged: 0 }
      : await chargeBuilderAction({
        pool, tenantId, userId,
        actionType: ACTION_GENERATE_SECTION,
        provider: 'anthropic',
        model: result.model || null,
        meta: { surface: 'arion.website_builder', kind, site_id: siteId },
        inputTokens: result.tokens?.input || 0,
        outputTokens: result.tokens?.output || 0,
      });

    // 3. Persist as draft.
    const blockJson = JSON.stringify(result.block);
    const elementorJson = result.elementor ? JSON.stringify(result.elementor) : null;
    const insertRow = await pool.request()
      .input('tenantId',      sql.UniqueIdentifier, tenantId)
      .input('siteId',        sql.UniqueIdentifier, siteId)
      .input('kind',          sql.NVarChar(40),     kind)
      .input('generated',     sql.NVarChar(sql.MAX), blockJson)
      .input('elementor',     sql.NVarChar(sql.MAX), elementorJson)
      .input('model',         sql.NVarChar(64),     result.model || null)
      .input('inputTokens',   sql.Int,              result.tokens?.input || null)
      .input('outputTokens',  sql.Int,              result.tokens?.output || null)
      .input('latencyMs',     sql.Int,              result.latencyMs || null)
      .input('createdBy',     sql.UniqueIdentifier, userId)
      .query(`
        INSERT INTO arion.site_block_draft
          (tenant_id, site_id, kind, generated_json, elementor_json,
           model_id, input_tokens, output_tokens, latency_ms, created_by)
        OUTPUT INSERTED.block_id, INSERTED.created_at
        VALUES
          (@tenantId, @siteId, @kind, @generated, @elementor,
           @model, @inputTokens, @outputTokens, @latencyMs, @createdBy)
      `);
    const inserted = insertRow.recordset[0];

    return res.status(201).json({
      data: {
        block_id:       inserted.block_id,
        site_id:        siteId,
        kind,
        block_json:     result.block,
        elementor_json: result.elementor,
        // Present when the adapter refused to build the section (e.g. a
        // contact form with no notification recipient). The draft is saved
        // either way; the portal must show this rather than a bare success.
        elementor_error: result.elementorError || null,
        tokens_used: {
          input:  result.tokens?.input  || 0,
          output: result.tokens?.output || 0,
          total:  result.tokens?.total  || 0,
        },
        latency_ms: result.latencyMs || 0,
        cost_usd:   result.costUsd ?? null,
        model_id:   result.model || null,
        accepted:   false,
        created_at: inserted.created_at,
        // What was ACTUALLY charged, from the one price list. `0` with
        // `from_library:true` is the honest answer for a curated layout: no
        // model ran, so nothing was spent.
        credits_charged: charged.creditsCharged,
        from_library:    fromLibrary,
      },
      meta: { tenant_id: tenantId, site_id: siteId, timestamp: new Date().toISOString() },
    });
  } catch (err) {
    return serverErr(res, err, 'arion/sites/blocks:generate');
  }
});

// ---------------------------------------------------------------------------
// GET /arion/sites/:siteId/blocks  — list drafts for the site
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const kindFilter = (req.query.kind || '').toString().trim() || null;
  const acceptedOnly = req.query.accepted === '1' || req.query.accepted === 'true';

  if (!tenantId || !siteId) return badReq(res, 'BAD_REQUEST', 'tenantId and siteId required');

  try {
    const pool = await getServicesPool();
    const site = await loadSiteForTenant(pool, { tenantId, siteId });
    if (!site) return notFound(res, 'Site not found for this tenant');

    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId',   sql.UniqueIdentifier, siteId)
      .input('kind',     sql.NVarChar(40),     kindFilter)
      .input('accepted', sql.Bit,              acceptedOnly ? 1 : 0)
      .query(`
        SELECT TOP 100 block_id, kind, accepted, accepted_at, model_id,
               input_tokens, output_tokens, latency_ms, created_at
          FROM arion.site_block_draft
         WHERE tenant_id = @tenantId
           AND site_id   = @siteId
           AND (@kind IS NULL OR kind = @kind)
           AND (@accepted = 0 OR accepted = 1)
         ORDER BY created_at DESC
      `);
    return res.json({
      data: r.recordset,
      meta: { tenant_id: tenantId, site_id: siteId, count: r.recordset.length },
    });
  } catch (err) {
    return serverErr(res, err, 'arion/sites/blocks:list');
  }
});

// ---------------------------------------------------------------------------
// GET /arion/sites/:siteId/blocks/draft/:blockId  — fetch one draft
// Using /draft/ prefix to disambiguate from /:kind in POST (uniqueidentifier
// could collide otherwise — keeps the URL space unambiguous).
// ---------------------------------------------------------------------------
router.get('/draft/:blockId', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId, blockId } = req.params;
  if (!tenantId || !siteId || !blockId) return badReq(res, 'BAD_REQUEST', 'tenantId, siteId, blockId required');

  try {
    const pool = await getServicesPool();
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId',   sql.UniqueIdentifier, siteId)
      .input('blockId',  sql.UniqueIdentifier, blockId)
      .query(`
        SELECT TOP 1 block_id, kind, generated_json, elementor_json,
               accepted, accepted_at, model_id, input_tokens, output_tokens,
               latency_ms, created_at
          FROM arion.site_block_draft
         WHERE tenant_id = @tenantId
           AND site_id   = @siteId
           AND block_id  = @blockId
      `);
    if (r.recordset.length === 0) return notFound(res, 'Block draft not found');
    const row = r.recordset[0];
    return res.json({
      data: {
        ...row,
        block_json:     safeParse(row.generated_json),
        elementor_json: safeParse(row.elementor_json),
      },
    });
  } catch (err) {
    return serverErr(res, err, 'arion/sites/blocks:detail');
  }
});

// ---------------------------------------------------------------------------
// POST /arion/sites/:siteId/blocks/draft/:blockId/accept
// ---------------------------------------------------------------------------
router.post('/draft/:blockId/accept', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const userId = req.platformUser?.userId || null;
  const { siteId, blockId } = req.params;
  if (!tenantId || !siteId || !blockId) return badReq(res, 'BAD_REQUEST', 'tenantId, siteId, blockId required');

  try {
    const pool = await getServicesPool();
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId',   sql.UniqueIdentifier, siteId)
      .input('blockId',  sql.UniqueIdentifier, blockId)
      .input('userId',   sql.UniqueIdentifier, userId)
      .query(`
        UPDATE arion.site_block_draft
           SET accepted    = 1,
               accepted_at = SYSUTCDATETIME(),
               accepted_by = @userId
         OUTPUT INSERTED.block_id, INSERTED.accepted, INSERTED.accepted_at
         WHERE tenant_id = @tenantId
           AND site_id   = @siteId
           AND block_id  = @blockId
      `);
    if (r.recordset.length === 0) return notFound(res, 'Block draft not found');
    return res.json({ data: r.recordset[0] });
  } catch (err) {
    return serverErr(res, err, 'arion/sites/blocks:accept');
  }
});

// ---------------------------------------------------------------------------
// POST /arion/sites/:siteId/blocks/assemble  — concatenate drafts into a page
// ---------------------------------------------------------------------------
// Body: { pageId?: number, draftBlockIds: string[] }
//   - draftBlockIds: ordered list of arion.site_block_draft.block_id values
//     for THIS site. Display order is the array order.
//   - pageId: WP post ID to update. If absent, the IA Plugin's
//     POST /pages/elementor endpoint will create a new page (it returns the
//     new post_id in the response).
//
// Behavior:
//   1. Load all draft rows by ID, verify they all belong to this tenant+site.
//   2. Load brand context for color injection.
//   3. assemblePage(orderedBlocks, brand) → elementorData array
//   4. injectPageToWordpress(site, pageId, elementorData) → POSTs to plugin
//      (this is a no-op if the plugin endpoint isn't deployed yet — see
//       followup TODOs in scripts/verify-page-assembler.mjs).
//   5. Mark each draft accepted=1 + persisted_to_post_id=<pageId> + persisted_at=NOW.
//
// Returns: { pageId, elementorEditUrl, blocksInjected, skipped[] }
router.post('/assemble', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const userId = req.platformUser?.userId || null;
  const { siteId } = req.params;
  const body = req.body || {};
  const pageIdInput = (body.pageId === 0 || body.pageId) ? Number(body.pageId) : null;
  const ids = Array.isArray(body.draftBlockIds) ? body.draftBlockIds : null;

  if (!tenantId) return badReq(res, 'NO_TENANT', 'Tenant not resolved');
  if (!siteId)   return badReq(res, 'NO_SITE', 'siteId required');
  if (!ids || ids.length === 0) return badReq(res, 'NO_DRAFTS', 'draftBlockIds[] required (non-empty)');
  if (ids.length > 50) return badReq(res, 'TOO_MANY_DRAFTS', 'max 50 drafts per assemble call');

  try {
    const pool = await getServicesPool();
    // We need the FULL site row (token, wp_admin_url, etc.) — loadSiteForTenant
    // returns only a thin projection. Pull the row directly here.
    const siteRowRes = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId',   sql.UniqueIdentifier, siteId)
      .query(`SELECT TOP 1 * FROM arion.site
               WHERE tenant_id = @tenantId AND site_id = @siteId`);
    const site = siteRowRes.recordset[0];
    if (!site) return notFound(res, 'Site not found for this tenant');

    // The price list decides, not this file. The row ships at 0 credits -
    // publishing sections you have already accepted makes no model call - and
    // if that row ever changes, this charges what it says (P18).
    const afford = await assertBuilderCredits({ pool, tenantId, actionType: ACTION_ASSEMBLE_PAGE });
    if (!afford.ok) {
      return res.status(afford.status).json({
        error: { code: afford.code, message: afford.message, status: afford.status },
        ...(afford.balance != null ? { meta: { balance: afford.balance, required: afford.required } } : {}),
      });
    }

    // Load every draft in one round-trip via a TVP-equivalent: comma-join the
    // IDs and use STRING_SPLIT — SQL Server supports this on 2016+ and we're
    // on Azure SQL which is well past that. Parameterized via @ids NVarChar.
    const idsCsv = ids.map(String).join(',');
    const draftRes = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId',   sql.UniqueIdentifier, siteId)
      .input('ids',      sql.NVarChar(sql.MAX), idsCsv)
      .query(`
        SELECT block_id, kind, generated_json, elementor_json, accepted
          FROM arion.site_block_draft
         WHERE tenant_id = @tenantId
           AND site_id   = @siteId
           AND CAST(block_id AS NVARCHAR(64)) IN (SELECT TRIM(value) FROM STRING_SPLIT(@ids, ','))
      `);
    const drafts = draftRes.recordset;
    // Reorder to match the request order (SQL won't preserve it).
    const draftById = new Map(drafts.map((d) => [String(d.block_id).toLowerCase(), d]));
    const ordered = ids.map((id) => draftById.get(String(id).toLowerCase())).filter(Boolean);
    if (ordered.length !== ids.length) {
      return badReq(res, 'MISSING_DRAFTS',
        `Expected ${ids.length} drafts, found ${ordered.length}. Some IDs are wrong tenant/site or don't exist.`);
    }

    // Brand context drives color injection on the assembled page.
    const brand = await loadBrandContext(pool, { tenantId, siteId });

    // Pre-parse for assembler.
    const orderedForAssembler = ordered.map((d) => ({
      block_id:      d.block_id,
      kind:          d.kind,
      block_json:    d.generated_json,
      elementor_json: d.elementor_json,
    }));

    // Dry-run skips BOTH the media upload pass and the page injection — useful
    // for previews / portal "what would this look like" calls.
    const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true' || body.dryRun === true;

    // Build the elementor_data tree. On a real run we ALSO upload every
    // gallery placeholder image to the customer's WP media library and swap
    // the URLs in place (assemblePageWithMedia). Dry-run sticks to the pure
    // sync assembler — no HTTP, placeholder URLs survive in the response.
    let elementorData;
    let sectionsBuilt;
    let skipped;
    let mediaResult = { uploaded: 0, reused: 0, failed: [], skipped: [] };
    if (dryRun) {
      const pure = assemblePage(orderedForAssembler, brand, { seedPrefix: `site-${siteId}` });
      elementorData = pure.elementorData;
      sectionsBuilt = pure.sectionsBuilt;
      skipped       = pure.skipped;
    } else {
      const withMedia = await assemblePageWithMedia(site, orderedForAssembler, brand, {
        seedPrefix:    `site-${siteId}`,
        // Default sequential per-site for politeness; small concurrency keeps
        // 12-image galleries fast without hammering the customer host.
        maxConcurrent: 2,
      });
      elementorData = withMedia.elementorData;
      sectionsBuilt = withMedia.sectionsBuilt;
      skipped       = withMedia.skipped;
      mediaResult   = withMedia.media;
    }

    if (sectionsBuilt === 0) {
      return res.status(422).json({
        error: { code: 'NO_SECTIONS_BUILT', message: 'Assembler produced zero sections', status: 422 },
        meta: { skipped, media: mediaResult },
      });
    }

    let injectResult;
    if (dryRun) {
      injectResult = {
        success: true,
        postId: pageIdInput || null,
        elementorEditUrl: null,
        pluginStatus: 'dry_run',
        dryRun: true,
      };
    } else {
      injectResult = await injectPageToWordpress(site, pageIdInput, elementorData, {
        title: body.title || null,
        status: body.status || 'publish',
        flipToBuilder: true,
      });
    }

    if (!injectResult.success) {
      return res.status(502).json({
        error: {
          code: 'WP_INJECTION_FAILED',
          message: injectResult.error || 'WP plugin rejected the injection',
          status: 502,
        },
        meta: {
          plugin_status: injectResult.pluginStatus || null,
          http_status:   injectResult.httpStatus || null,
          sections_built: sectionsBuilt,
          skipped,
        },
      });
    }

    const finalPageId = injectResult.postId || pageIdInput || null;

    // Mark drafts accepted + record where they landed. We accept-all even if
    // some were skipped by the adapter (sectionsBuilt < ordered.length) —
    // the skipped[] array tells the caller which ones didn't make it.
    if (finalPageId != null && !dryRun) {
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('siteId',   sql.UniqueIdentifier, siteId)
        .input('ids',      sql.NVarChar(sql.MAX), idsCsv)
        .input('userId',   sql.UniqueIdentifier, userId)
        .input('pageId',   sql.Int,              finalPageId)
        .query(`
          UPDATE arion.site_block_draft
             SET accepted              = 1,
                 accepted_at           = COALESCE(accepted_at, SYSUTCDATETIME()),
                 accepted_by           = COALESCE(accepted_by, @userId),
                 persisted_to_post_id  = @pageId,
                 persisted_at          = SYSUTCDATETIME()
           WHERE tenant_id = @tenantId
             AND site_id   = @siteId
             AND CAST(block_id AS NVARCHAR(64)) IN (SELECT TRIM(value) FROM STRING_SPLIT(@ids, ','))
        `);
    }

    // Charged after the page has actually landed, never before, and skipped
    // entirely for a dry run - which writes nothing anywhere.
    let creditsCharged = 0;
    if (!dryRun && afford.credits > 0) {
      const charged = await chargeBuilderAction({
        pool, tenantId, userId,
        actionType: ACTION_ASSEMBLE_PAGE,
        provider: 'internal',
        model: null,
        meta: { surface: 'arion.website_builder', stage: 'assemble', site_id: siteId, sections: sectionsBuilt },
      });
      creditsCharged = charged.creditsCharged;
    }

    return res.json({
      data: {
        pageId:           finalPageId,
        elementorEditUrl: injectResult.elementorEditUrl || null,
        blocksInjected:   sectionsBuilt,
        dryRun:           !!dryRun,
        credits_charged:  creditsCharged,
        skipped,
        media: mediaResult,
      },
      meta: {
        tenant_id:    tenantId,
        site_id:      siteId,
        plugin_status: injectResult.pluginStatus || null,
        timestamp:    new Date().toISOString(),
      },
    });
  } catch (err) {
    return serverErr(res, err, 'arion/sites/blocks:assemble');
  }
});

function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export default router;
