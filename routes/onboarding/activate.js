/**
 * Onboarding — Welcome-token activate.
 * --------------------------------------------------------------------------
 * Public route called by the Portal /welcome page when the customer clicks
 * the "Activate my account" link in the post-onboarding welcome email.
 *
 *   POST /onboarding/activate
 *   Body: { email, setup_token, tenant_id }
 *   200:  { ok: true, signup_url, site: {domain, wp_admin_url} }
 *   400:  validation
 *   404:  no site for tenant_id
 *   409:  token already used
 *   422:  token mismatch
 *
 * Token lives on `arion.site.provisioning_details_json.welcome_token` (set
 * by /onboarding/submit at the end). On a successful match we stamp
 * `welcome_token_used_at` so a stolen email link can't be replayed.
 *
 * The response includes `signup_url` — Portal redirects the user there so
 * the existing CIAM/MSAL signup flow takes over. Email is prefilled in the
 * URL hash so the customer doesn't retype it.
 */

import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';

const PORTAL_BASE = (process.env.PORTAL_BASE_URL
  || 'https://portal.intelligentanalyticsdm.com').replace(/\/+$/, '');

const router = Router();

router.post('/', async (req, res) => {
  const { email, setup_token: setupToken, tenant_id: tenantId } = req.body || {};
  if (!email || !setupToken || !tenantId) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'email, setup_token, tenant_id required' },
    });
  }

  try {
    const pool = await getServicesPool();

    // Path A: arion.site.provisioning_details_json.welcome_token (set by
    // /onboarding/submit at end of self-serve flow). Path B: oliver.tenant_-
    // onboarding_state.welcome_token (set by oliver-api finish-onboarding
    // when the founder onboards a client through the modal). Path B clients
    // may not have an arion.site at all (SPARK-only / OLIVER-only purchases).
    //
    // We try the arion.site path first; if no token there, fall through to
    // oliver.tenant_onboarding_state. Whichever matches gets marked used.
    const row = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT TOP 1 site_id, domain, wp_admin_url, provisioning_details_json
        FROM arion.site
        WHERE tenant_id = @tenantId
        ORDER BY updated_at DESC
      `);

    let matched = null; // { source: 'arion' | 'oliver_onboarding', payload }
    let arionDetails = null;
    const arionSite = row.recordset[0] || null;
    if (arionSite) {
      try {
        arionDetails = arionSite.provisioning_details_json ? JSON.parse(arionSite.provisioning_details_json) : {};
      } catch { arionDetails = {}; }
      if (arionDetails.welcome_token) {
        if (arionDetails.welcome_token_used_at) {
          return res.status(409).json({ error: { code: 'TOKEN_ALREADY_USED' } });
        }
        if (timingSafeEq(arionDetails.welcome_token, setupToken)) {
          matched = { source: 'arion' };
        }
      }
    }

    if (!matched) {
      // Path B fallback — check oliver.tenant_onboarding_state.
      const oRow = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT welcome_token, welcome_token_expires_at
            FROM oliver.tenant_onboarding_state
           WHERE tenant_id = @tenantId
        `);
      const oRec = oRow.recordset[0];
      if (oRec?.welcome_token) {
        if (oRec.welcome_token_expires_at && new Date(oRec.welcome_token_expires_at) < new Date()) {
          return res.status(409).json({ error: { code: 'TOKEN_EXPIRED' } });
        }
        if (timingSafeEq(oRec.welcome_token, setupToken)) {
          matched = { source: 'oliver_onboarding' };
        } else {
          return res.status(422).json({ error: { code: 'TOKEN_MISMATCH' } });
        }
      }
    }

    if (!matched) {
      return res.status(arionSite ? 422 : 404).json({
        error: { code: arionSite ? 'TOKEN_MISMATCH' : 'NO_WELCOME_TOKEN' },
      });
    }

    // Mark used.
    if (matched.source === 'arion') {
      arionDetails.welcome_token_used_at = new Date().toISOString();
      arionDetails.welcome_email_activated_by = email;
      await pool.request()
        .input('siteId', sql.UniqueIdentifier, arionSite.site_id)
        .input('details', sql.NVarChar(sql.MAX), JSON.stringify(arionDetails))
        .query(`UPDATE arion.site SET provisioning_details_json=@details, updated_at=GETUTCDATE() WHERE site_id=@siteId`);
    } else {
      // Path B: null out the token + record used-at so it can't be replayed.
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          UPDATE oliver.tenant_onboarding_state
             SET welcome_token = NULL,
                 welcome_token_expires_at = NULL
           WHERE tenant_id = @tenantId
        `);
    }

    // The customer's next stop is the existing CIAM signup flow. Add the
    // welcome=1 hint so UnifiedSetupCard auto-opens the modal — but only
    // for Path A (Path B clients are already onboarded by the founder so
    // the card will see finished_at and self-suppress).
    const signupUrl = `${PORTAL_BASE}/signup?prefill_email=${encodeURIComponent(email)}&activated=1&post_signup_redirect=${encodeURIComponent('/app/services/command?welcome=1')}`;

    return res.status(200).json({
      ok: true,
      signup_url: signupUrl,
      site: arionSite ? { domain: arionSite.domain, wp_admin_url: arionSite.wp_admin_url } : null,
      activation_source: matched.source,
    });
  } catch (err) {
    console.error('[onboarding/activate]', err);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: err.message },
    });
  }
});

/**
 * Constant-time string compare. The token is short and base64url so a naive
 * `===` would leak length and matching prefix via timing. crypto.timingSafeEqual
 * needs equal-length buffers; we coerce + length-pad to avoid throwing on
 * mismatched lengths AND keep the comparison constant-time.
 */
function timingSafeEq(a, b) {
  const aBuf = Buffer.from(String(a || ''), 'utf8');
  const bBuf = Buffer.from(String(b || ''), 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  let diff = 0;
  for (let i = 0; i < aBuf.length; i++) diff |= aBuf[i] ^ bBuf[i];
  return diff === 0;
}

export default router;
