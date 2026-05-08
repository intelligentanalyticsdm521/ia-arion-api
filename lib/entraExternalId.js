/**
 * Entra External ID — programmatic user invitation via Microsoft Graph.
 * --------------------------------------------------------------------------
 * Creates a local-account user in our Entra External ID tenant so a freshly-
 * signed-up customer can log into the portal at /app. Email + temporary
 * password are emailed separately (see emailTemplates.portalAccountInviteEmail).
 *
 * On first sign-in the user is forced to change their password.
 *
 * Required env vars (all in Key Vault):
 *   ENTRA_GRAPH_TENANT_ID     - Entra tenant GUID
 *   ENTRA_GRAPH_CLIENT_ID     - app registration with User.ReadWrite.All app permission
 *   ENTRA_GRAPH_CLIENT_SECRET - the client secret
 *   ENTRA_TENANT_DOMAIN       - e.g. "iadmexternal.onmicrosoft.com" (used as identity issuer)
 *   ENTRA_USER_DEFAULT_GROUP_ID  - optional: GUID of a group to add new users to
 *
 * Graph permission needed (app permission, admin consent):
 *   User.ReadWrite.All
 */

import crypto from 'node:crypto';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_TTL_BUFFER_MS = 60_000; // refresh 1 min before expiry

let _token = null;
let _tokenExpiresAt = 0;

/**
 * Acquire a Graph API token via client_credentials. Cached until expiry-1m.
 * @returns {Promise<string|null>}
 */
async function getGraphToken() {
  if (_token && Date.now() < _tokenExpiresAt - TOKEN_TTL_BUFFER_MS) return _token;

  const tenantId = process.env.ENTRA_GRAPH_TENANT_ID;
  const clientId = process.env.ENTRA_GRAPH_CLIENT_ID;
  const clientSecret = process.env.ENTRA_GRAPH_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    console.warn('[entra] ENTRA_GRAPH_TENANT_ID / CLIENT_ID / CLIENT_SECRET not set');
    return null;
  }

  const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  try {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('[entra] token request failed:', res.status, errText.slice(0, 300));
      return null;
    }
    const data = await res.json();
    _token = data.access_token;
    _tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return _token;
  } catch (err) {
    console.error('[entra] token request error:', err.message);
    return null;
  }
}

/**
 * Generate a strong temporary password compliant with Entra default policy
 * (8-256 chars, 3 of 4 character classes).
 * @returns {string}
 */
function generateTempPassword() {
  // 16 chars from a curated set: uppercase, lowercase, digit, symbol — guaranteed mix
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%^&*';
  const all = upper + lower + digits + symbols;

  const buf = crypto.randomBytes(16);
  // Force at least one of each class
  let pwd = upper[buf[0] % upper.length]
          + lower[buf[1] % lower.length]
          + digits[buf[2] % digits.length]
          + symbols[buf[3] % symbols.length];
  for (let i = 4; i < 16; i++) pwd += all[buf[i] % all.length];
  // Shuffle so the forced characters aren't always at the start
  return pwd.split('').sort(() => crypto.randomInt(0, 3) - 1).join('');
}

/**
 * Look up a user by email (sign-in email).
 * @param {string} email
 * @returns {Promise<object|null>}
 */
export async function findUserByEmail(email) {
  const token = await getGraphToken();
  if (!token) return null;
  const filter = `identities/any(i:i/issuerAssignedId eq '${email.replace(/'/g, "''")}' and i/issuer eq '${(process.env.ENTRA_TENANT_DOMAIN || '').replace(/'/g, "''")}')`;
  const res = await fetch(`${GRAPH_BASE}/users?$filter=${encodeURIComponent(filter)}&$select=id,displayName,userPrincipalName,identities`, {
    headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' },
  });
  if (!res.ok) {
    console.warn('[entra] findUserByEmail failed:', res.status, await res.text().catch(() => ''));
    return null;
  }
  const data = await res.json();
  return data.value?.[0] || null;
}

/**
 * Create a local-account Entra user.
 *
 * @param {object} args
 * @param {string} args.email
 * @param {string} [args.displayName]
 * @returns {Promise<{ok: true, userId: string, tempPassword: string} | {ok: false, error: string}>}
 */
export async function createPortalUser({ email, displayName }) {
  const token = await getGraphToken();
  if (!token) return { ok: false, error: 'graph_not_configured' };

  const tenantDomain = process.env.ENTRA_TENANT_DOMAIN;
  if (!tenantDomain) return { ok: false, error: 'ENTRA_TENANT_DOMAIN not set' };

  // Idempotency: if user already exists, return their ID
  const existing = await findUserByEmail(email);
  if (existing) {
    return { ok: true, userId: existing.id, tempPassword: '', alreadyExists: true };
  }

  const tempPassword = generateTempPassword();
  const mailNickname = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').slice(0, 60);

  const body = {
    accountEnabled: true,
    displayName: displayName || email,
    mailNickname,
    // Local-account UPN must be unique within the tenant; use a UUID prefix
    // since we're identifying by `identities` not by UPN.
    userPrincipalName: `${mailNickname}-${crypto.randomUUID().slice(0, 8)}@${tenantDomain}`,
    passwordProfile: {
      forceChangePasswordNextSignIn: true,
      password: tempPassword,
    },
    identities: [
      {
        signInType: 'emailAddress',
        issuer: tenantDomain,
        issuerAssignedId: email,
      },
    ],
  };

  try {
    const res = await fetch(`${GRAPH_BASE}/users`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[entra] createPortalUser failed:', res.status, data);
      return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
    }

    // Optional: add to default group
    const groupId = process.env.ENTRA_USER_DEFAULT_GROUP_ID;
    if (groupId && data.id) {
      addUserToGroup(data.id, groupId).catch((err) => console.warn('[entra] addUserToGroup failed:', err.message));
    }

    return { ok: true, userId: data.id, tempPassword };
  } catch (err) {
    console.error('[entra] createPortalUser error:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Add a user to a security or M365 group (used for portal access groups).
 */
async function addUserToGroup(userId, groupId) {
  const token = await getGraphToken();
  if (!token) return;
  await fetch(`${GRAPH_BASE}/groups/${groupId}/members/$ref`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ '@odata.id': `${GRAPH_BASE}/directoryObjects/${userId}` }),
  });
}
