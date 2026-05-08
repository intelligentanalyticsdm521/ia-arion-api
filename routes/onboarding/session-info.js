/**
 * Onboarding — Session Info
 * --------------------------------------------------------------------------
 * GET /onboarding/session-info?session_id=cs_test_...
 *
 * Returns the context an OnboardingFlow UI needs to render: the plan they
 * bought, billing cycle, customer email, and any saved progress.
 *
 * Public (unauthenticated) — Stripe session IDs are unguessable random
 * strings, equivalent to a one-time-use token for this purpose.
 */

import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import { getPlan } from '../../lib/pricing.js';

const router = Router();

router.get('/', async (req, res) => {
  const sessionId = String(req.query?.session_id || '').trim();
  if (!sessionId) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'session_id required', status: 400 } });
  }

  try {
    const pool = await getServicesPool();
    const r = await pool.request()
      .input('sessionId', sql.NVarChar(200), sessionId)
      .query(`
        SELECT TOP 1
          ss.email, ss.questionnaire_json, ss.domain_json, ss.submitted_at,
          t.plan, t.billing_cycle, t.status,
          s.domain, s.provisioning_state
        FROM arion.signup_session ss
        JOIN arion.tenant t ON t.tenant_id = ss.tenant_id
        JOIN arion.site s ON s.site_id = ss.site_id
        WHERE ss.stripe_session_id = @sessionId
      `);

    if (r.recordset.length === 0) {
      return res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'Signup session not found', status: 404 } });
    }
    const row = r.recordset[0];
    const planMeta = getPlan(row.plan);

    return res.json({
      data: {
        email: row.email,
        plan: {
          key: row.plan,
          name: planMeta?.name || row.plan,
          description: planMeta?.description || null,
        },
        billing_cycle: row.billing_cycle,
        tenant_status: row.status,
        site: {
          domain: row.domain || null,
          provisioning_state: row.provisioning_state || null,
        },
        // If the client refreshed mid-flow, surface what they already saved
        saved_questionnaire: safeParse(row.questionnaire_json),
        saved_domain: safeParse(row.domain_json),
        already_submitted: !!row.submitted_at,
      },
      meta: { timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[onboarding/session-info]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export default router;
