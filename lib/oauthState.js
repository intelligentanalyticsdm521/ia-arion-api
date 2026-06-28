/**
 * lib/oauthState — HMAC-signed Google OAuth state helper
 * ---------------------------------------------------------------------------
 * Why this exists
 * ---------------
 * Audit finding 2026-06-27: every Google OAuth entry-point in arion-api built
 * `state` as `base64url(JSON)` with no signature. The callback parsed it and
 * trusted the embedded tenantId/siteId. That meant a third party who knew (or
 * guessed) a tenant_id + site_id pair could mint their own state, hit Google
 * with their own Google account, and the callback would write THEIR
 * refresh_token onto the victim's arion.site row — silently re-binding the
 * victim's Google integration to the attacker's account.
 *
 * Fix
 * ---
 * Two layers:
 *   1. Sign the state with HMAC-SHA256 keyed by `OAUTH_STATE_SECRET` (falls
 *      back to AUTH_PROVIDER_KEY to avoid an extra KV ref). Callback rejects
 *      states whose HMAC doesn't verify.
 *   2. Embed `initiatorEmail` — the auth'd portal user who started the OAuth.
 *      Callback decodes the Google id_token email and rejects when it does
 *      not match. In Brandon's consultant-grant world this still works: the
 *      IA founder authenticates as the consultant on the client tenant, hits
 *      Google with the founder's own Google account, and the founder's email
 *      matches the initiatorEmail (the founder's Entra email).
 *
 * State payload shape
 * -------------------
 *   { tenantId, siteId, setupMode?, returnUrl?, initiatorEmail?, scope?, iat }
 *
 * Wire format
 * -----------
 *   "<base64url(JSON.stringify(payload))>.<base64url(HMAC)>"
 *
 * The signed prefix-and-signature is opaque to Google; it shows up as the
 * `state` query parameter on the redirect_uri.
 *
 * Legacy unsigned states
 * ----------------------
 * On callback we accept only signed states. Legacy unsigned states are
 * rejected. This is intentional — any in-flight OAuth from before this
 * deploy will surface a friendly "Connection Failed — please retry" page,
 * which is the correct UX (the user just clicks Connect again).
 */

import crypto from 'crypto';

function getStateSecret() {
  return (
    process.env.OAUTH_STATE_SECRET ||
    process.env.AUTH_PROVIDER_KEY ||
    ''
  );
}

export function signOAuthState(payload) {
  const secret = getStateSecret();
  if (!secret) {
    // Refuse to mint unsigned state — failing closed in dev/test surfaces
    // the missing env var instead of shipping a silently-vulnerable flow
    // to prod via Web Apps' "use placeholder secrets" behaviour.
    throw new Error('OAUTH_STATE_SECRET (or AUTH_PROVIDER_KEY) is not configured');
  }
  const body = Buffer.from(
    JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000) })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyOAuthState(state) {
  if (!state || typeof state !== 'string') return null;
  const dotIdx = state.indexOf('.');
  if (dotIdx === -1) return null; // unsigned — reject
  const body = state.slice(0, dotIdx);
  const sig = state.slice(dotIdx + 1);
  const secret = getStateSecret();
  if (!secret) return null;
  let expected;
  try {
    expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  } catch {
    return null;
  }
  // timingSafeEqual requires equal length buffers
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  try {
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    // Refuse states older than 1 hour — the entire OAuth round-trip fits
    // easily inside that window and stale states are a phishing signal.
    if (payload?.iat && Math.floor(Date.now() / 1000) - payload.iat > 3600) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Decode a Google id_token (JWT) without verification. SAFE because we
 * receive the id_token directly from Google's token endpoint over TLS in
 * the same request that returns access_token + refresh_token — there is no
 * third party in the middle. We only ever read the `email` and
 * `email_verified` claims; signature verification would require fetching
 * Google's JWKS, which is unnecessary for this use.
 */
export function decodeGoogleIdTokenEmail(idToken) {
  if (!idToken || typeof idToken !== 'string') return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!claims.email || claims.email_verified === false) return null;
    return String(claims.email).toLowerCase();
  } catch {
    return null;
  }
}
