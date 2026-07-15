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
      // 2026-07-15 fix: only enforce used/expired on the ARION token when the
      // client is actually PRESENTING it (their setup_token hash matches it).
      // Previously an ARION token that was expired/used short-circuited to
      // TOKEN_EXPIRED / TOKEN_ALREADY_USED even when the client's link carried
      // the (valid) oliver_onboarding token — so a stale ARION welcome token
      // shadowed every fresh Path-B link on any tenant that has both an ARION
      // site AND an oliver onboarding token (e.g. clients with a website).
      // Match FIRST; only then apply used/expiry to the token the user holds.
      // F-SEC1.3 (2026-06-21): stored value is the SHA-256 hex hash; compare
      // hash-vs-hash via constant-time eq.
      if (arionDetails.welcome_token && timingSafeEq(arionDetails.welcome_token, setupTokenHash)) {
        if (arionDetails.welcome_token_used_at) {
          return res.status(409).json({ error: { code: 'TOKEN_ALREADY_USED' } });
        }
        // F-A.1 (2026-06-19): enforce expiry (expired → resend flow via
        // POST /onboarding/activate/resend; Portal /welcome reads can_resend).
        if (arionDetails.welcome_token_expires_at && new Date(arionDetails.welcome_token_expires_at) < new Date()) {
          return res.status(409).json({ error: { code: 'TOKEN_EXPIRED', can_resend: true } });
        }
        matched = { source: 'arion' };
      }
      // If the client's token is NOT the ARION token, fall through to the
      // oliver_onboarding token below instead of wrongly rejecting here.
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

    // Brandon 2026-07-09: "already used" = the client actually REGISTERED, not
    // merely that the link was clicked. If a user with this email is already a
    // member of this tenant, the activation is spent — send them to sign in.
    // (Path A / arion keeps its own used-at semantics below.)
    if (matched.source !== 'arion') {
      try {
        const regPool = await getPlatformPool();
        const regRow = await regPool.request()
          .input('tenant_id', sql.UniqueIdentifier, tenantId)
          .input('email', sql.NVarChar(320), providedEmail)
          .query(`
            SELECT TOP 1 1 AS yes
              FROM core.tenant_users tu
              JOIN core.users u ON u.user_id = tu.user_id
             WHERE tu.tenant_id = @tenant_id AND LOWER(u.email) = LOWER(@email)
          `);
        if (regRow.recordset.length) {
          return res.status(409).json({ error: { code: 'TOKEN_ALREADY_USED' } });
        }
      } catch (e) {
        console.error('[onboarding/activate] registration check failed (non-fatal):', e.message);
      }
    }

    // Brandon 2026-07-09: DO NOT consume the token on click. Consuming it the
    // instant the /welcome page validated it broke real signups — a client who
    // clicked the link but hadn't finished creating their account (reloaded, or
    // waiting on the email verification code) found the link dead
    // ("NO_WELCOME_TOKEN") on the next click. The token must survive the whole
    // signup window. It still expires naturally (48h TTL) and the tenant
    // invitation is one-time (claimed once on first sign-in); the registration
    // check above is what marks the link spent, once the account actually exists.
    //
    // Path A (arion self-serve) is a separate flow and keeps consume-on-activate.
    if (matched.source === 'arion') {
      arionDetails.welcome_token_used_at = new Date().toISOString();
      arionDetails.welcome_email_activated_by = email;
      await pool.request()
        .input('siteId', sql.UniqueIdentifier, arionSite.site_id)
        .input('details', sql.NVarChar(sql.MAX), JSON.stringify(arionDetails))
        .query(`UPDATE arion.site SET provisioning_details_json=@details, updated_at=GETUTCDATE() WHERE site_id=@siteId`);
    }
    // Path B (oliver_onboarding / oliver_onboarding_users): token intentionally
    // NOT consumed here — see note above.

    // 2026-06-30 FIX: /signup was renamed to /pricing (the checkout page) on
    // 2026-05-20. The old URL still 301-redirected, but landed clients on the
    // public CHECKOUT page asking them to buy products — not a CIAM signup.
    // Welcome-email clicks looked like asking the customer to pay again.
    //
    // Target the authenticated app shell directly. AppGate detects no MSAL
    // session, triggers Entra External ID signup/signin (which handles new-
    // account creation), and on return continues to the welcome=1 query the
    // UnifiedSetupCard reads to auto-open the orientation modal. Path B
    // clients (already onboarded by founder) see the card self-suppress via
    // finished_at; Path A self-onboarders see the modal open.
    const signupUrl = `${PORTAL_BASE}/app/services/command?welcome=1&prefill_email=${encodeURIComponent(email)}`;

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
