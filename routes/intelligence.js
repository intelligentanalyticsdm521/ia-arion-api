// routes/intelligence.js — ARION Platform Pulse endpoint.
//
// BRANDON'S FINAL INSIGHTS ARCHITECTURE:
//   GET /intelligence/arion/platform-pulse/:tenantId
//
// Returns the cached ARION Platform Pulse (Trend+Intel)/2 with components.
// Called by platform-api when computing Business Pulse (equal-weight average
// of every active product's Platform Pulse).
//
// Auth: same chain as the rest of arion-api (requireAuth + tenantResolution
// + requireArionAccess) inherited from index.js mount.
import { Router } from 'express';
import { getServicesPool } from '../db/servicesPool.js';
import { getArionPlatformPulse } from '../lib/intelligence/platformPulse.js';

const router = Router();

// GET /intelligence/arion/platform-pulse/:tenantId
//   Query: ?refresh=true to force recompute.
router.get('/arion/platform-pulse/:tenantId', async (req, res) => {
  try {
    const requestedTenant = req.params.tenantId;
    // Validate the requested tenant matches the resolved auth tenant.
    if (req.tenant?.tenantId && requestedTenant !== req.tenant.tenantId) {
      return res.status(403).json({ error: 'tenant_mismatch' });
    }
    const tenantId = requestedTenant || req.tenant?.tenantId;
    if (!tenantId) return res.status(400).json({ error: 'tenant_required' });

    const refresh = String(req.query.refresh || '').toLowerCase() === 'true';
    const pool = await getServicesPool();
    const result = await getArionPlatformPulse(pool, tenantId, { refresh });

    return res.json({
      data: {
        platform: 'arion',
        tenant_id: tenantId,
        score: result.score,
        trend_component: result.trend_component,
        intelligence_component: result.intelligence_component,
        partial: result.partial,
        no_data: result.no_data,
        calculated_at: result.calculated_at,
        cache_state: result.cache_state,
      },
    });
  } catch (err) {
    console.error('[intelligence/arion/platform-pulse]', err);
    return res.status(500).json({ error: 'platform_pulse_failed', detail: err.message });
  }
});

export default router;
