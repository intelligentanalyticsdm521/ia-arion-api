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
    const row = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT TOP 1 site_id, domain, wp_admin_url, provisioning_details_json
        FROM arion.site
        WHERE tenant_id = @tenantId
        ORDER BY updated_at DESC
      `);
    if (row.recordset.length === 0) {
      return res.status(404).json({ error: { code: 'SITE_NOT_FOUND' } });
    }
    const site = row.recordset[0];
    let details;
    try {
      details = site.provisioning_details_json ? JSON.parse(site.provisioning_details_json) : {};
    } catch {
      details = {};
    }
    if (!details.welcome_token) {
      return res.status(404).json({ error: { code: 'NO_WELCOME_TOKEN' } });
    }
    if (details.welcome_token_used_at) {
      return res.status(409).json({ error: { code: 'TOKEN_ALREADY_USED' } });
    }
    if (timingSafeEq(details.welcome_token, setupToken) === false) {
      return res.status(422).json({ error: { code: 'TOKEN_MISMATCH' } });
    }

    // Mark used + persist.
    details.welcome_token_used_at = new Date().toISOString();
    details.welcome_email_activated_by = email;
    await pool.request()
      .input('siteId', sql.UniqueIdentifier, site.site_id)
      .input('details', sql.NVarChar(sql.MAX), JSON.stringify(details))
      .query(`
        UPDATE arion.site
        SET provisioning_details_json = @details,
            updated_at = GETUTCDATE()
        WHERE site_id = @siteId
      `);

    // The customer's next stop is the existing CIAM signup flow.
    const signupUrl = `${PORTAL_BASE}/signup?prefill_email=${encodeURIComponent(email)}&activated=1`;

    return res.status(200).json({
      ok: true,
      signup_url: signupUrl,
      site: {
        domain: site.domain,
        wp_admin_url: site.wp_admin_url,
      },
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
