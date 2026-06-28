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
import crypto from 'node:crypto';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import { getPlatformPool } from '../../db/platformPool.js';
import { checkRate, getClientIp } from '../../lib/rateLimiter.js';

const PORTAL_BASE = (process.env.PORTAL_BASE_URL
  || 'https://portal.intelligentanalyticsdm.com').replace(/\/+$/, '');

// F-SEC2.1 (2026-06-21): rate-limit /onboarding/activate to 5 req/min per IP
// AND per email (whichever cap hits first → 429). Activate is a public,
// unauthenticated endpoint that takes (email, setup_token, tenant_id) — the
// natural enumeration / brute-force surface. Caps here mean a single attacker
// IP can probe at most 5 emails per minute, and a single targeted email can
// be probed at most 5 times per minute across any number of IPs. Restart
// resets the window (in-memory) — acceptable for V1 per Brandon.
const ACTIVATE_WINDOW_SEC = 60;
const ACTIVATE_MAX_HITS   = 5;

const router = Router();

router.post('/', async (req, res) => {
  const { email, setup_token: setupToken, tenant_id: tenantId } = req.body || {};
  if (!email || !setupToken || !tenantId) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'email, setup_token, tenant_id required' },
    });
  }

  // F-SEC2.1 — rate-limit BEFORE any DB lookup. Check IP first, then email.
  // Both caps share the same window/limit; whichever trips first denies. The
  // 429 response shape is identical whether the email exists or not, so this
  // does NOT leak existence (the email-keyed bucket starts empty either way).
  const ip = getClientIp(req);
  const lowerEmail = String(email || '').toLowerCase().trim();
  const ipCheck = checkRate({ key: 'ip:' + ip, windowSec: ACTIVATE_WINDOW_SEC, maxHits: ACTIVATE_MAX_HITS });
  if (!ipCheck.ok) {
    res.set('Retry-After', String(ipCheck.retryAfter));
    return res.status(429).json({ error: 'rate_limited', retry_after_seconds: ipCheck.retryAfter });
  }
  const emailCheck = checkRate({ key: 'email:' + lowerEmail, windowSec: ACTIVATE_WINDOW_SEC, maxHits: ACTIVATE_MAX_HITS });
  if (!emailCheck.ok) {
    res.set('Retry-After', String(emailCheck.retryAfter));
    return res.status(429).json({ error: 'rate_limited', retry_after_seconds: emailCheck.retryAfter });
  }

  // F-SEC1.3 (2026-06-21): tokens are stored at rest as SHA-256 hex hashes.
  // Hash the incoming plaintext token ONCE here, then compare hashes
  // (constant-time) against what's in the DB / JSON. Customer-facing URL
  // still carries plaintext — only the at-rest representation changed.
  // Migration 028 (arion) / 095 (oliver) expired all pre-existing plaintext
  // tokens by zeroing welcome_token_expires_at, forcing affected accounts
  // through the resend path which mints fresh hashed tokens.
  const setupTokenHash = crypto.createHash('sha256').update(String(setupToken)).digest('hex');

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
        // F-A.1 (2026-06-19): enforce expiry on the arion path (Path B path
        // already does it). Without this, leaked Path A tokens were
        // functionally immortal until used.
        if (arionDetails.welcome_token_expires_at && new Date(arionDetails.welcome_token_expires_at) < new Date()) {
          // 2026-06-27 — Brandon-directed: expired tokens must hand the user
          // to the resend-verification flow at POST /onboarding/activate/resend.
          // Portal `/welcome` reads `can_resend` and shows a "Send me a new
          // link" button. Including the email in the response is intentional
          // — it's already in the request body, so this leaks nothing.
          return res.status(409).json({ error: { code: 'TOKEN_EXPIRED', can_resend: true } });
        }
        // F-SEC1.3 (2026-06-21): stored value is the SHA-256 hex hash of the
        // plaintext token. We compare hash-vs-hash via constant-time eq.
        if (timingSafeEq(arionDetails.welcome_token, setupTokenHash)) {
          matched = { source: 'arion' };
        }
      }
    }

    let oliverOnboardingState = null;
    let oliverMatchedUserIndex = -1;
    if (!matched) {
      // Path B fallback — check oliver.tenant_onboarding_state.
      //
      // 2026-06-27 (C.02) — Multi-user support. The migration script writes
      // per-user welcome tokens into state_json.users[] (each entry has
      // {email, hash, expires_at}) AND mirrors the LAST user's hash into
      // the legacy `welcome_token` column for backwards compat. Without
      // this branch, only the LAST user in users[] could activate — every
      // other user got a 422 TOKEN_MISMATCH even with a valid plaintext
      // token. For Briarwood that meant Angel Blass (admin) could activate
      // but Chris Ryan could not.
      //
      // Order of checks per request:
      //   1. state_json.users[] — match (email == request.email AND
      //      hash == setupTokenHash). Per-user expires_at enforced.
      //   2. Legacy welcome_token column — for single-user tenants AND
      //      the LAST user in multi-user tenants.
      const oRow = await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query(`
          SELECT welcome_token, welcome_token_expires_at, state_json
            FROM oliver.tenant_onboarding_state
           WHERE tenant_id = @tenantId
        `);
      const oRec = oRow.recordset[0];
      if (oRec) {
        try {
          oliverOnboardingState = oRec.state_json ? JSON.parse(oRec.state_json) : {};
        } catch { oliverOnboardingState = {}; }

        const usersArr = Array.isArray(oliverOnboardingState?.users)
          ? oliverOnboardingState.users
          : [];
        if (usersArr.length) {
          const lowerEmail = String(email || '').toLowerCase().trim();
          for (let i = 0; i < usersArr.length; i++) {
            const u = usersArr[i];
            if (!u || !u.hash) continue;
            if (u.used_at) continue; // already activated — skip silently
            if (String(u.email || '').toLowerCase().trim() !== lowerEmail) continue;
            const userExp = u.expires_at || u.welcome_token_expires_at;
            if (userExp && new Date(userExp) < new Date()) {
              return res.status(409).json({ error: { code: 'TOKEN_EXPIRED', can_resend: true } });
            }
            if (timingSafeEq(u.hash, setupTokenHash)) {
              matched = { source: 'oliver_onboarding_users' };
              oliverMatchedUserIndex = i;
              break;
            }
          }
        }

        if (!matched && oRec.welcome_token) {
          if (oRec.welcome_token_expires_at && new Date(oRec.welcome_token_expires_at) < new Date()) {
            return res.status(409).json({ error: { code: 'TOKEN_EXPIRED', can_resend: true } });
          }
          // F-SEC1.3 (2026-06-21): stored value is SHA-256 hex hash.
          if (timingSafeEq(oRec.welcome_token, setupTokenHash)) {
            matched = { source: 'oliver_onboarding' };
          } else if (!usersArr.length) {
            // Single-user tenant + mismatch = real mismatch. For multi-user
            // we already exhausted users[] and fell through, so a legacy
            // mismatch is a NOT-FOUND case (handled below) — don't 422 here.
            return res.status(422).json({ error: { code: 'TOKEN_MISMATCH' } });
          }
        }
      }
    }

    if (!matched) {
      return res.status(arionSite ? 422 : 404).json({
        error: { code: arionSite ? 'TOKEN_MISMATCH' : 'NO_WELCOME_TOKEN' },
      });
    }

    // F-SEC1.2 (2026-06-21): verify the activating email matches the Stripe-paid
    // tenant's primary_contact_email. Prevents tenant-claim hijack: if an
    // attacker intercepts the activation link and swaps in their own email,
    // they shouldn't be able to claim the paid tenant via CIAM signup.
    //
    // 2026-06-27 (C.02) — Multi-user adjustment. When the matched source is
    // `oliver_onboarding_users`, the email check has ALREADY happened inside
    // the users[] match loop above (we matched by `u.email == request.email`
    // before validating the hash). For that source we skip the
    // primary_contact_email comparison — primary_contact_email holds the
    // OWNER's email, and Chris Ryan / other non-owner users would otherwise
    // be blocked even with a valid per-user token.
    const EMAIL_MISMATCH_RESPONSE = {
      error: 'email_mismatch',
      message: 'The email you signed up with does not match the email on file. Please contact support.',
    };
    const providedEmail = String(email || '').toLowerCase().trim();
    if (matched.source !== 'oliver_onboarding_users') {
      let expectedEmail = null;
      try {
        const platformPool = await getPlatformPool();
        const tRow = await platformPool.request()
          .input('tenant_id', sql.UniqueIdentifier, tenantId)
          .query(`SELECT primary_contact_email FROM core.tenants WHERE tenant_id=@tenant_id`);
        const rawExpected = tRow.recordset[0]?.primary_contact_email;
        expectedEmail = rawExpected ? String(rawExpected).toLowerCase().trim() : null;
      } catch (e) {
        console.error(`[SECURITY][onboarding/activate] core.tenants lookup failed (fail-closed) tenant_id=${tenantId} provided=${maskEmail(email)} err=${e.message}`);
        return res.status(403).json(EMAIL_MISMATCH_RESPONSE);
      }
      if (!expectedEmail) {
        console.warn(`[SECURITY][onboarding/activate] fail-open suppressed — no primary_contact_email on core.tenants tenant_id=${tenantId} provided=${maskEmail(email)} source=${matched.source}`);
        return res.status(403).json(EMAIL_MISMATCH_RESPONSE);
      }
      if (providedEmail !== expectedEmail) {
        console.error(`[SECURITY][onboarding/activate] email mismatch tenant_id=${tenantId} provided=${maskEmail(email)} expected=${maskEmail(expectedEmail)} source=${matched.source}`);
        return res.status(403).json(EMAIL_MISMATCH_RESPONSE);
      }
    }

    // Mark used.
    if (matched.source === 'arion') {
      arionDetails.welcome_token_used_at = new Date().toISOString();
      arionDetails.welcome_email_activated_by = email;
      await pool.request()
        .input('siteId', sql.UniqueIdentifier, arionSite.site_id)
        .input('details', sql.NVarChar(sql.MAX), JSON.stringify(arionDetails))
        .query(`UPDATE arion.site SET provisioning_details_json=@details, updated_at=GETUTCDATE() WHERE site_id=@siteId`);
    } else if (matched.source === 'oliver_onboarding_users') {
      // 2026-06-27 (C.02) — Multi-user: stamp ONLY this user's row in
      // state_json.users[]. The other users' tokens remain valid.
      if (oliverOnboardingState && oliverMatchedUserIndex >= 0) {
        const usersArr = oliverOnboardingState.users || [];
        const userRow = usersArr[oliverMatchedUserIndex];
        if (userRow) {
          userRow.used_at = new Date().toISOString();
          userRow.hash = null; // null out so a stolen plaintext can't replay
        }
        // If this was the LAST user (whose hash mirrors the legacy column),
        // also clear the legacy column so the resend / activate paths agree.
        const anyRemaining = usersArr.some(u => u && u.hash && !u.used_at);
        await pool.request()
          .input('tenantId', sql.UniqueIdentifier, tenantId)
          .input('state', sql.NVarChar(sql.MAX), JSON.stringify(oliverOnboardingState))
          .query(`
            UPDATE oliver.tenant_onboarding_state
               SET state_json = @state,
                   welcome_token = ${anyRemaining ? 'welcome_token' : 'NULL'},
                   welcome_token_expires_at = ${anyRemaining ? 'welcome_token_expires_at' : 'NULL'},
                   last_saved_at = SYSUTCDATETIME()
             WHERE tenant_id = @tenantId
          `);
      }
    } else {
      // Path B legacy single-user: null out the token + record used-at so
      // it can't be replayed.
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
 * Mask an email for SECURITY log lines — keep first char of local-part + first
 * char of domain, redact the rest. e.g. `brandon@example.com` -> `b****@e****.com`.
 * Falsy input returns `<none>` so log lines stay scannable.
 */
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

/**
 * Constant-time string compare. After F-SEC1.3 (2026-06-21) both sides of
 * the comparison are 64-char SHA-256 hex hashes, so we can use Node's
 * crypto.timingSafeEqual directly. The length-equality short-circuit is
 * still constant-time-safe because length itself is not secret (always 64).
 */
function timingSafeEq(a, b) {
  const aBuf = Buffer.from(String(a || ''), 'utf8');
  const bBuf = Buffer.from(String(b || ''), 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export default router;
