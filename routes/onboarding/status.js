/**
 * Onboarding — Status Polling
 * --------------------------------------------------------------------------
 * The ProvisioningStatus UI polls this endpoint every 5s to render the
 * step-by-step progress indicator. It returns the latest job's phase, percent
 * complete, and any final URLs/errors.
 *
 * Public route — auth via the signup session ID, which is unguessable enough
 * for this purpose (Stripe's session IDs are random + opaque).
 *
 * Special case: if BYOD and DNS hasn't propagated yet, we return
 * `phase: 'dns_verifying'` instead of failing — the UI keeps polling, and the
 * actual provisioning kicks off once the user resubmits or our background
 * verifier auto-resumes.
 */

import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import { getLatestJobForSite, PHASE_PROGRESS } from '../../lib/provisioningJobs.js';
import { verifyHostingerNameservers } from '../../lib/dnsVerifier.js';

const router = Router();

router.get('/', async (req, res) => {
  const sessionId = String(req.query?.session_id || '').trim();
  if (!sessionId) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'session_id required', status: 400 } });
  }

  try {
    const pool = await getServicesPool();

    const sessionRow = await pool.request()
      .input('sessionId', sql.NVarChar(200), sessionId)
      .query(`
        SELECT TOP 1 ss.session_pk, ss.tenant_id, ss.site_id, ss.email, ss.domain_json,
               s.domain, s.wp_admin_url, s.provisioning_state, s.provisioning_details_json
        FROM arion.signup_session ss
        JOIN arion.site s ON s.site_id = ss.site_id
        WHERE ss.stripe_session_id = @sessionId
      `);

    if (sessionRow.recordset.length === 0) {
      return res.status(404).json({ error: { code: 'SESSION_NOT_FOUND', message: 'Signup session not found', status: 404 } });
    }
    const ctx = sessionRow.recordset[0];

    // First check the new phase tracker fields in provisioning_details_json.
    // If they're present (set by the async submit.js orchestrator), they're
    // the authoritative source for progress — return them directly.
    let phaseDetails = null;
    try { phaseDetails = ctx.provisioning_details_json ? JSON.parse(ctx.provisioning_details_json) : null; } catch { /* noop */ }
    if (phaseDetails?.current_phase) {
      const wpLoginUrl2 = ctx.wp_admin_url ? rtrimSlash(ctx.wp_admin_url).replace(/\/wp-admin$/, '') + '/wp-login.php' : null;
      const previewUrl2 = ctx.domain ? `https://${ctx.domain}` : null;
      return res.json({
        data: {
          phase: phaseDetails.current_phase,
          progress_percent: Number(phaseDetails.current_percent ?? 0),
          message: phaseDetails.current_message || null,
          error: phaseDetails.current_phase === 'failed' ? phaseDetails.current_message : null,
          wp_admin_url: ctx.wp_admin_url || null,
          wp_login_url: wpLoginUrl2,
          preview_url: previewUrl2,
          provisioning_state: ctx.provisioning_state || null,
        },
        meta: { timestamp: new Date().toISOString(), source: 'phase_tracker' },
      });
    }

    // 1. Check for BYOD-not-yet-propagated state. The UI flagged this case
    //    via /onboarding/submit returning 425 — we surface it here too in
    //    case the client refreshes the status page.
    let domainParsed = null;
    try { domainParsed = ctx.domain_json ? JSON.parse(ctx.domain_json) : null; } catch { /* ignore */ }
    if (domainParsed?.mode === 'byod') {
      const job = await getLatestJobForSite(pool, { tenantId: ctx.tenant_id, siteId: ctx.site_id });
      if (!job) {
        // No job yet — likely still waiting on DNS. Re-check.
        const ns = await verifyHostingerNameservers(domainParsed.domain);
        return res.json({
          data: {
            phase: 'dns_verifying',
            progress_percent: 10,
            message: ns.pointsToHostinger
              ? 'DNS verified — please resubmit your build.'
              : 'Waiting for nameserver change to propagate.',
            details: { current_nameservers: ns.nameservers },
          },
          meta: { timestamp: new Date().toISOString() },
        });
      }
    }

    // 2. Standard path — find the latest job and report its state
    const job = await getLatestJobForSite(pool, { tenantId: ctx.tenant_id, siteId: ctx.site_id });
    if (!job) {
      return res.json({
        data: {
          phase: 'queued',
          progress_percent: 5,
          message: 'Preparing your site',
        },
        meta: { timestamp: new Date().toISOString() },
      });
    }

    // 3. Cross-check site.provisioning_state — IA Plugin's bootstrap may have
    //    moved past the worker's terminal state. We trust the more advanced one.
    const finalPhase = phasePreferringIaBootstrap(job.state, ctx.provisioning_state);
    const progressPct = PHASE_PROGRESS[finalPhase] ?? job.progress_percent;

    const wpLoginUrl = ctx.wp_admin_url ? rtrimSlash(ctx.wp_admin_url).replace(/\/wp-admin$/, '') + '/wp-login.php' : null;
    const previewUrl = ctx.domain ? `https://${ctx.domain}` : null;

    return res.json({
      data: {
        phase: finalPhase,
        progress_percent: progressPct,
        message: job.last_message || null,
        error: ['failed'].includes(finalPhase) ? job.last_error : null,
        wp_admin_url: ctx.wp_admin_url || null,
        wp_login_url: wpLoginUrl,
        preview_url: previewUrl,
      },
      meta: { timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[onboarding/status]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

/**
 * If the IA Plugin's bootstrap reports a more advanced state in
 * `arion.site.provisioning_state`, prefer that — the worker can finish before
 * the bootstrap, and we want the UI to keep showing progress until the plugin
 * is actually ready.
 */
function phasePreferringIaBootstrap(workerState, siteState) {
  if (siteState === 'ready') return 'ready';
  if (siteState === 'ready_partial') return 'ready_partial';
  if (siteState === 'failed') return 'failed';
  if (siteState === 'manifest_fetched' && !['ready', 'ready_partial', 'failed'].includes(workerState)) {
    return 'bootstrap_running';
  }
  return workerState;
}

function rtrimSlash(s) { return String(s).replace(/\/+$/, ''); }

export default router;
