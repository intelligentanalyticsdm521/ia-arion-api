/**
 * Onboarding — Welcome-token resend.
 * --------------------------------------------------------------------------
 *   POST /onboarding/activate/resend
 *   Body: { email, tenant_id, expired_token }
 *
 *   200:  { ok: true, expires_at }
 *   400:  validation
 *   403:  email mismatch / expired_token mismatch
 *   404:  no welcome token on file for this tenant
 *   429:  rate-limited (2 resends per hour per email AND per IP)
 *   500:  internal
 *
 * Built 2026-06-27 alongside the 48h TTL change. Flow:
 *
 *   1. /welcome page POSTs to /onboarding/activate with the expired link's
 *      (email, setup_token, tenant_id).
 *   2. activate.js returns 409 TOKEN_EXPIRED with `can_resend: true`.
 *   3. /welcome shows the customer "Your link expired — send me a new one".
 *   4. On click, /welcome POSTs to THIS endpoint with the same
 *      (email, tenant_id, expired_token) it already had.
 *   5. We hash the expired_token, verify it matches the current stored hash
 *      (which is expired), mint a fresh 48h plaintext token + SHA-256 hash,
 *      OVERWRITE the stored hash + expiry, and trigger the welcome email
 *      send via the existing pipeline.
 *
 * Why we require expired_token (rather than just (email, tenant_id)):
 *
 *   Anyone who can guess a tenant_id and an email would otherwise be able to
 *   spam resends. Requiring the expired token means the caller had to have
 *   received the original email — a much smaller attack surface. The email
 *   itself stays out of attackers' hands unless the inbox is compromised, in
 *   which case the resend isn't the weak link.
 *
 * Rate-limiting:
 *
 *   Reuses lib/rateLimiter.js with a separate keyspace ('resend:...') so
 *   resend caps don't interact with the activate caps. 2 per hour per IP +
 *   per email. Far stricter than activate (60/min) because a successful
 *   resend triggers an outbound email — that's the abuse surface.
 *
 * Backward compat: We accept both arion.site (Path A self-serve) and
 * oliver.tenant_onboarding_state (Path B founder-wizard) token storage.
 * The endpoint discovers which one holds the current expired token and
 * updates the matching row.
 */

import { Router } from 'express';
import crypto from 'node:crypto';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import { getPlatformPool } from '../../db/platformPool.js';
import { checkRate, getClientIp } from '../../lib/rateLimiter.js';
import {
  sendOnboardingWelcomeEmail,
  generateSetupToken,
} from '../../lib/welcomeEmail.js';

const RESEND_WINDOW_SEC = 3600;
const RESEND_MAX_HITS = 2;
const TOKEN_TTL_HOURS = 48;

const router = Router();

router.post('/', async (req, res) => {
  const { email, tenant_id: tenantId, expired_token: expiredToken } = req.body || {};
  if (!email || !tenantId || !expiredToken) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'email, tenant_id, expired_token required' },
    });
  }

  const ip = getClientIp(req);
  const lowerEmail = String(email || '').toLowerCase().trim();
  const ipCheck = checkRate({ key: 'resend:ip:' + ip, windowSec: RESEND_WINDOW_SEC, maxHits: RESEND_MAX_HITS });
  if (!ipCheck.ok) {
    res.set('Retry-After', String(ipCheck.retryAfter));
    return res.status(429).json({ error: 'rate_limited', retry_after_seconds: ipCheck.retryAfter });
  }
  const emailCheck = checkRate({ key: 'resend:email:' + lowerEmail, windowSec: RESEND_WINDOW_SEC, maxHits: RESEND_MAX_HITS });
  if (!emailCheck.ok) {
    res.set('Retry-After', String(emailCheck.retryAfter));
    return res.status(429).json({ error: 'rate_limited', retry_after_seconds: emailCheck.retryAfter });
  }

  const expiredHash = crypto.createHash('sha256').update(String(expiredToken)).digest('hex');

  try {
    const pool = await getServicesPool();
    const platformPool = await getPlatformPool();

    // Look up the tenant (we'll use it for emails + the email-match check).
    const tRow = await platformPool.request()
      .input('tid', sql.UniqueIdentifier, tenantId)
      .query(`SELECT TOP 1 tenant_id, full_name, name, primary_contact_email
                FROM core.tenants WHERE tenant_id = @tid`);
    const tenantRow = tRow.recordset[0];
    if (!tenantRow) {
      return res.status(404).json({ error: { code: 'TENANT_NOT_FOUND' } });
    }
    const primaryContactEmail = tenantRow.primary_contact_email
      ? String(tenantRow.primary_contact_email).toLowerCase().trim()
      : null;

    // Locate the welcome-token storage row. Try arion.site first (Path A),
    // then oliver.tenant_onboarding_state (Path B).
    const siteRow = await pool.request()
      .input('tid', sql.UniqueIdentifier, tenantId)
      .query(`SELECT TOP 1 site_id, domain, wp_admin_url, provisioning_details_json
                FROM arion.site WHERE tenant_id = @tid
               ORDER BY updated_at DESC`);
    const arionSite = siteRow.recordset[0] || null;
    let arionDetails = null;
    if (arionSite) {
      try { arionDetails = arionSite.provisioning_details_json ? JSON.parse(arionSite.provisioning_details_json) : {}; }
      catch { arionDetails = {}; }
    }

    // Read the oliver onboarding state up front so we can both check users[]
    // and check the legacy welcome_token column with one round trip.
    const oRow = await pool.request()
      .input('tid', sql.UniqueIdentifier, tenantId)
      .query(`SELECT welcome_token, state_json
                FROM oliver.tenant_onboarding_state WHERE tenant_id = @tid`);
    const oRec = oRow.recordset[0];
    let oliverOnboardingState = null;
    if (oRec) {
      try { oliverOnboardingState = oRec.state_json ? JSON.parse(oRec.state_json) : {}; }
      catch { oliverOnboardingState = {}; }
    }
    const oliverUsers = Array.isArray(oliverOnboardingState?.users) ? oliverOnboardingState.users : [];

    // 2026-06-27 (C.02) — Email-match check.
    // For multi-user tenants the requester may be a non-owner (e.g. Chris
    // Ryan on Briarwood). Accept the email if it matches EITHER the owner
    // (primary_contact_email) OR any user in state_json.users[]. For
    // single-user tenants only primary_contact_email is allowed.
    const oliverUserEmailMatch = oliverUsers.some(u =>
      String(u?.email || '').toLowerCase().trim() === lowerEmail
    );
    if (!oliverUserEmailMatch && (!primaryContactEmail || primaryContactEmail !== lowerEmail)) {
      return res.status(403).json({
        error: 'email_mismatch',
        message: 'The email you provided does not match any email on file. Please contact support.',
      });
    }

    // Match the expired_token hash against any current at-rest hash.
    // Priority: arion.site → oliver users[] → oliver legacy column.
    let source = null;       // 'arion' | 'oliver_onboarding_users' | 'oliver_onboarding'
    let userIndex = -1;
    if (arionDetails?.welcome_token && timingSafeEq(arionDetails.welcome_token, expiredHash)) {
      source = 'arion';
    } else if (oliverUsers.length) {
      for (let i = 0; i < oliverUsers.length; i++) {
        const u = oliverUsers[i];
        if (!u || !u.hash) continue;
        if (String(u.email || '').toLowerCase().trim() !== lowerEmail) continue;
        if (timingSafeEq(u.hash, expiredHash)) {
          source = 'oliver_onboarding_users';
          userIndex = i;
          break;
        }
      }
    }
    if (!source && oRec?.welcome_token && timingSafeEq(oRec.welcome_token, expiredHash)) {
      // Multi-user tenants mirror the LAST user's hash here; if we still
      // matched against this column it means the requester IS that last
      // user. Treat as users[] match if we can find them; otherwise legacy.
      const lastIdx = oliverUsers.length
        ? oliverUsers.findIndex(u => u?.hash && timingSafeEq(u.hash, expiredHash))
        : -1;
      if (lastIdx >= 0) {
        source = 'oliver_onboarding_users';
        userIndex = lastIdx;
      } else {
        source = 'oliver_onboarding';
      }
    }

    if (!source) {
      // Either no token on file or the supplied expired_token doesn't match
      // any current hash. Both surface as 403 so we don't disclose which.
      return res.status(403).json({ error: { code: 'TOKEN_MISMATCH' } });
    }

    // Mint a fresh 48h token. setupToken is the plaintext that goes in the
    // email URL; the hash is what we store at rest. Same shape as
    // /onboarding/submit and /admin/onboard-existing.
    const setupToken = generateSetupToken();
    const setupTokenHash = crypto.createHash('sha256').update(setupToken).digest('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 60 * 60 * 1000).toISOString();

    if (source === 'arion') {
      arionDetails.welcome_token = setupTokenHash;
      arionDetails.welcome_token_expires_at = expiresAt;
      arionDetails.welcome_token_used_at = null;
      arionDetails.welcome_token_resent_at = new Date().toISOString();
      arionDetails.welcome_token_resend_count = (arionDetails.welcome_token_resend_count || 0) + 1;
      await pool.request()
        .input('sid', sql.UniqueIdentifier, arionSite.site_id)
        .input('details', sql.NVarChar(sql.MAX), JSON.stringify(arionDetails))
        .query(`UPDATE arion.site
                   SET provisioning_details_json = @details, updated_at = GETUTCDATE()
                 WHERE site_id = @sid`);
    } else if (source === 'oliver_onboarding_users') {
      // 2026-06-27 (C.02) — Rotate only THIS user's hash. Other users keep
      // their own valid (or expired) tokens.
      const userRow = oliverOnboardingState.users[userIndex];
      userRow.hash = setupTokenHash;
      userRow.expires_at = expiresAt;
      userRow.used_at = null;
      userRow.resent_at = new Date().toISOString();
      userRow.resend_count = (userRow.resend_count || 0) + 1;
      // If this is the LAST user in users[], also update the legacy column
      // (the migration script mirrors the last user's hash there).
      const isLastIdx = userIndex === oliverOnboardingState.users.length - 1;
      const legacyHashClause = isLastIdx ? '@hash' : 'welcome_token';
      const legacyExpClause = isLastIdx ? '@exp' : 'welcome_token_expires_at';
      await pool.request()
        .input('tid', sql.UniqueIdentifier, tenantId)
        .input('state', sql.NVarChar(sql.MAX), JSON.stringify(oliverOnboardingState))
        .input('hash', sql.NVarChar(128), setupTokenHash)
        .input('exp', sql.DateTime2, new Date(expiresAt))
        .query(`UPDATE oliver.tenant_onboarding_state
                   SET state_json = @state,
                       welcome_token = ${legacyHashClause},
                       welcome_token_expires_at = ${legacyExpClause},
                       last_saved_at = SYSUTCDATETIME()
                 WHERE tenant_id = @tid`);
    } else {
      await pool.request()
        .input('tid', sql.UniqueIdentifier, tenantId)
        .input('hash', sql.NVarChar(128), setupTokenHash)
        .input('exp', sql.DateTime2, new Date(expiresAt))
        .query(`UPDATE oliver.tenant_onboarding_state
                   SET welcome_token = @hash, welcome_token_expires_at = @exp
                 WHERE tenant_id = @tid`);
    }

    // 2026-06-27 (C.02) — Personalize the firstName for multi-user paths.
    // primary_contact_first_name is the OWNER's first name; for non-owner
    // users we want "Hi Chris" not "Hi Angel".
    let recipientFirstName = tenantRow.primary_contact_first_name || '';
    if (source === 'oliver_onboarding_users' && userIndex >= 0) {
      const u = oliverOnboardingState.users[userIndex];
      recipientFirstName = (u?.first || u?.first_name || recipientFirstName || '').trim();
    }

    // Send the email. Best-effort but report on result.
    let emailResult = null;
    try {
      emailResult = await sendOnboardingWelcomeEmail({
        toEmail: lowerEmail,
        firstName: recipientFirstName,
        brandName: tenantRow.full_name || tenantRow.name || '',
        tenantId,
        wpAdminUrl: arionSite?.wp_admin_url || null,
        wpAdminLogin: null,
        wpAdminPassword: null,
        setupToken,
        iaPluginDownloadUrl: arionDetails?.ia_plugin_download_url || null,
        existingWebsite: !!arionDetails?.flow?.startsWith?.('existing'),
        path: 'client_onboard',
      });
    } catch (e) {
      console.error('[onboarding/activate/resend] sendOnboardingWelcomeEmail threw:', e?.message);
      emailResult = { ok: false, error: e?.message || 'send_failed' };
    }

    if (!emailResult?.ok) {
      // We've already rotated the token in DB. Surface the error but the
      // customer can retry — the new token is what they'll use either way.
      return res.status(502).json({
        error: { code: 'EMAIL_SEND_FAILED', message: emailResult?.error || 'unknown' },
      });
    }

    return res.status(200).json({
      ok: true,
      expires_at: expiresAt,
      sent_to: maskEmail(lowerEmail),
    });
  } catch (err) {
    console.error('[onboarding/activate/resend]', err);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: err.message },
    });
  }
});

function maskEmail(raw) {
  const s = String(raw || '').trim();
  if (!s) return '<none>';
  const at = s.indexOf('@');
  if (at < 1) return `${s[0] || ''}****`;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const domainHead = dot > 0 ? domain.slice(0, 1) : domain.slice(0, 1);
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local[0]}****@${domainHead}****${tld}`;
}

function timingSafeEq(a, b) {
  const aBuf = Buffer.from(String(a || ''), 'utf8');
  const bBuf = Buffer.from(String(b || ''), 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export default router;
