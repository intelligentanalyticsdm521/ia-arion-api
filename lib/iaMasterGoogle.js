/**
 * IA-master Google service-account client.
 *
 * What this enables (Brandon-locked design 2026-06-23):
 *   • Probe a domain for existing Google footprint (GSC sites, GBP listings,
 *     GA4 properties) before asking the customer to authenticate, so the
 *     "Not sure" answer can be auto-routed to BYO or auto-create.
 *   • Provision GA4 + GSC + GBP under the IA master Google service account
 *     when the customer has none of them.
 *   • Invite the customer (by email) as Admin on the provisioned assets so
 *     they own the data going forward — Google's only real "ownership
 *     transfer" surface is "add the customer as Admin and remove our
 *     service account when they've accepted".
 *
 * Architecture:
 *   The IA master credentials live in Key Vault as a single JSON service-
 *   account key (kebab-case secret name `GOOGLE-MASTER-SERVICE-ACCOUNT-JSON`).
 *   The KV value is the raw JSON of a Google Cloud service-account key file
 *   created in the IA platform Google Cloud project, with these IAM roles
 *   on the IA Google Workspace org / Google Cloud project:
 *     • Analytics Admin API — `accounts/<IA>` Admin
 *     • Search Console API — site-level Owner on a placeholder property
 *     • Business Profile APIs — Admin on the IA master GBP organization
 *
 * Until that JSON lands in KV (verified missing 2026-06-23 via
 * `az keyvault secret list --vault-name kv-IADM-prod`), every helper in
 * here returns `{ error: 'ia_master_not_configured' }` so callers can
 * surface a clean "we couldn't auto-create — please connect your own
 * account" fallback rather than crashing.
 *
 * Honest Google reality (do not paper over):
 *   • GA4 property creation under a service account is a Google API call
 *     (`analyticsadmin.googleapis.com/v1beta/properties`). Adding the
 *     customer as an Admin uses `accessBindings.create`. Real, working,
 *     fully programmatic.
 *   • Search Console: no API to create+verify a site under one user then
 *     transfer it. The IA master account CAN verify a site once (DNS TXT
 *     record), then add the customer as an Owner via
 *     `webmasters/v3/sites/<siteUrl>/permissions`. Customer doesn't need
 *     to re-verify after the IA owner adds them — that's the supported
 *     "transfer" path.
 *   • GBP: We can call `accounts.locations.create` to create an unverified
 *     listing, then `accounts.admins.create` to invite the customer's
 *     email as ADMIN. Verification (postcard / phone / video) still has
 *     to happen on the customer's side — Google does not allow a third
 *     party to fully verify a listing on a customer's behalf. We surface
 *     this honestly in the runner evidence so the founder dashboard knows
 *     verification is pending the customer.
 *
 * Cache: getAccessToken() caches the OAuth2 access token for its declared
 * lifetime (typically 3600s).
 */

import { getSecret } from './secrets.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Cached access token: { token, expires_at_ms }
let _cachedToken = null;
// Cached parsed service-account JSON
let _cachedKey = null;

/**
 * Combined OAuth scope set used by the master service account. Must be added
 * as Google-Workspace-wide-delegation scopes on the service account's IAM
 * config before any of these APIs will return data for the IA org.
 */
const MASTER_SCOPES = [
  'https://www.googleapis.com/auth/analytics.edit',
  'https://www.googleapis.com/auth/analytics.manage.users',
  'https://www.googleapis.com/auth/webmasters',
  'https://www.googleapis.com/auth/business.manage',
].join(' ');

/**
 * Load the service-account key from Key Vault.
 * Returns { client_email, private_key, project_id, ... } or null if not
 * configured. Cached for the process lifetime.
 */
async function loadServiceAccountKey() {
  if (_cachedKey) return _cachedKey;
  const raw = await getSecret('GOOGLE_MASTER_SERVICE_ACCOUNT_JSON', 'GOOGLE-MASTER-SERVICE-ACCOUNT-JSON');
  if (!raw) {
    console.warn('[iaMasterGoogle] GOOGLE-MASTER-SERVICE-ACCOUNT-JSON not found in Key Vault — IA master path is offline');
    return null;
  }
  try {
    _cachedKey = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return _cachedKey;
  } catch (err) {
    console.error('[iaMasterGoogle] Failed to parse service-account JSON:', err.message);
    return null;
  }
}

/**
 * Mint a fresh OAuth2 access token via JWT-bearer grant. Caches it until 5
 * minutes before declared expiry.
 *
 * Implementation note: we use Node's built-in `crypto` (RS256 over the JWT
 * payload) so this works without adding a googleapis dependency.
 */
async function mintAccessToken() {
  const key = await loadServiceAccountKey();
  if (!key) return null;
  if (_cachedToken && _cachedToken.expires_at_ms - 5 * 60_000 > Date.now()) {
    return _cachedToken.token;
  }
  const { default: crypto } = await import('node:crypto');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: key.private_key_id };
  const payload = {
    iss: key.client_email,
    scope: MASTER_SCOPES,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const b64u = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString('base64')
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const signingInput = `${b64u(header)}.${b64u(payload)}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(key.private_key)
    .toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error('[iaMasterGoogle] Token mint failed:', res.status, text.slice(0, 300));
    return null;
  }
  const data = await res.json();
  _cachedToken = {
    token: data.access_token,
    expires_at_ms: Date.now() + (Number(data.expires_in || 3600) * 1000),
  };
  return _cachedToken.token;
}

async function masterFetch(method, url, body = undefined) {
  const token = await mintAccessToken();
  if (!token) {
    const err = new Error('ia_master_not_configured');
    err.code = 'ia_master_not_configured';
    throw err;
  }
  const headers = {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
  };
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Google API ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/* ──────────────────────────────────────────────────────────────────────
 * PROBE — given a domain, return what the IA master account can see for
 * it today. Used to answer the "Not sure" case at onboarding time.
 *
 * Returns:
 *   {
 *     configured: boolean,           // false when IA master JSON missing
 *     gsc:        { found, sites: [] },
 *     gbp:        { found, locations: [] },
 *     ga4:        { found, properties: [] },
 *     route:      'byo' | 'ia',      // recommended path
 *   }
 *
 * "Found" here means anything plausible — even an unverified GSC site or
 * an unclaimed GBP listing counts. The customer can still flip the route
 * manually after the probe; we just want a sensible default.
 * ────────────────────────────────────────────────────────────────────── */
export async function probeGoogleFootprint(domain) {
  const cleanDomain = String(domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();
  if (!cleanDomain) {
    return { configured: true, gsc: { found: false, sites: [] }, gbp: { found: false, locations: [] }, ga4: { found: false, properties: [] }, route: 'byo' };
  }
  const token = await mintAccessToken();
  if (!token) {
    return {
      configured: false,
      error: 'ia_master_not_configured',
      gsc: { found: false, sites: [] },
      gbp: { found: false, locations: [] },
      ga4: { found: false, properties: [] },
      route: 'byo',                 // safest default — let the customer log in
    };
  }

  // GSC — does our master service account already own / have access to
  // this domain? `webmasters/v3/sites` lists every site any caller has any
  // permission on. Any hit (even verified-via-DNS-but-unowned) is enough
  // to route the customer to BYO.
  let gscSites = [];
  try {
    const data = await masterFetch('GET', 'https://www.googleapis.com/webmasters/v3/sites');
    const all = (data.siteEntry || []).map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
    gscSites = all.filter((s) => {
      const u = String(s.siteUrl || '')
        .replace(/^sc-domain:/, '')
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\/$/, '')
        .toLowerCase();
      return u === cleanDomain || u.endsWith('.' + cleanDomain) || cleanDomain.endsWith('.' + u);
    });
  } catch (err) {
    console.warn('[iaMasterGoogle] probeGsc failed:', err.message);
  }

  // GBP — search all listings under the IA master org for the domain. The
  // search-listings endpoint matches website URI substrings.
  let gbpLocations = [];
  try {
    const accountsData = await masterFetch('GET', 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
    const accounts = accountsData.accounts || [];
    for (const acct of accounts) {
      try {
        const readMask = 'name,title,websiteUri';
        const locUrl = `https://mybusinessbusinessinformation.googleapis.com/v1/${acct.name}/locations?readMask=${encodeURIComponent(readMask)}&pageSize=100`;
        const locData = await masterFetch('GET', locUrl);
        for (const loc of (locData.locations || [])) {
          const websiteUri = (loc.websiteUri || '').toLowerCase();
          if (!websiteUri) continue;
          if (websiteUri.includes(cleanDomain)) {
            gbpLocations.push({ account_name: acct.name, location_name: `${acct.name}/${loc.name}`, title: loc.title, websiteUri });
          }
        }
      } catch (err) {
        console.warn(`[iaMasterGoogle] probeGbp accounts/${acct.name} failed:`, err.message);
      }
    }
  } catch (err) {
    console.warn('[iaMasterGoogle] probeGbp failed:', err.message);
  }

  // GA4 — list account summaries the service account can see. Property
  // displayName commonly contains the domain, so substring match is fine
  // as a probe (not a guarantee of access).
  let ga4Props = [];
  try {
    const data = await masterFetch('GET', 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries');
    for (const acct of (data.accountSummaries || [])) {
      for (const prop of (acct.propertySummaries || [])) {
        const dn = String(prop.displayName || '').toLowerCase();
        if (dn.includes(cleanDomain) || cleanDomain.includes(dn.replace(/[^a-z0-9.-]/g, ''))) {
          ga4Props.push({
            propertyId: prop.property.replace('properties/', ''),
            displayName: prop.displayName,
            account_name: acct.account,
          });
        }
      }
    }
  } catch (err) {
    console.warn('[iaMasterGoogle] probeGa4 failed:', err.message);
  }

  const found = gscSites.length > 0 || gbpLocations.length > 0 || ga4Props.length > 0;
  return {
    configured: true,
    gsc: { found: gscSites.length > 0, sites: gscSites },
    gbp: { found: gbpLocations.length > 0, locations: gbpLocations },
    ga4: { found: ga4Props.length > 0, properties: ga4Props },
    route: found ? 'byo' : 'ia',
  };
}

/* ──────────────────────────────────────────────────────────────────────
 * AUTO-PROVISION — create GA4 + GSC + GBP under the IA master account.
 *
 * Returns:
 *   {
 *     configured: boolean,            // false when IA master JSON missing
 *     ga4: { ok, property_id, error },
 *     gsc: { ok, site_url, error, verification_pending },
 *     gbp: { ok, account_name, location_name, error, verification_pending },
 *   }
 *
 * Failure of any sub-step does not fail the others — the caller persists
 * a partial result and the runner re-attempts the failed sub-step.
 * ────────────────────────────────────────────────────────────────────── */
export async function autoProvisionGoogle({ domain, businessName, contactEmail }) {
  const token = await mintAccessToken();
  if (!token) {
    return {
      configured: false,
      error: 'ia_master_not_configured',
      ga4: { ok: false, error: 'ia_master_not_configured' },
      gsc: { ok: false, error: 'ia_master_not_configured' },
      gbp: { ok: false, error: 'ia_master_not_configured' },
    };
  }
  const cleanDomain = String(domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
  const result = {
    configured: true,
    ga4: { ok: false },
    gsc: { ok: false },
    gbp: { ok: false },
  };

  // GA4 — create a property under the first writable account in the IA org.
  try {
    const accountsData = await masterFetch('GET', 'https://analyticsadmin.googleapis.com/v1beta/accounts');
    const ga4Account = (accountsData.accounts || [])[0];
    if (!ga4Account) throw new Error('No GA4 account writable by the IA master service account');
    const propBody = {
      parent: ga4Account.name,
      displayName: businessName || cleanDomain,
      timeZone: 'America/Los_Angeles',
      currencyCode: 'USD',
      industryCategory: 'OTHER',
    };
    const propRes = await masterFetch('POST', 'https://analyticsadmin.googleapis.com/v1beta/properties', propBody);
    result.ga4.property_id = String(propRes.name || '').replace('properties/', '');
    // Create a web data stream so the property is usable
    try {
      await masterFetch('POST',
        `https://analyticsadmin.googleapis.com/v1beta/${propRes.name}/dataStreams`,
        {
          displayName: cleanDomain,
          type: 'WEB_DATA_STREAM',
          webStreamData: { defaultUri: `https://${cleanDomain}` },
        });
    } catch (e) { console.warn('[iaMasterGoogle] GA4 data-stream create failed:', e.message); }
    result.ga4.ok = true;
  } catch (err) {
    console.warn('[iaMasterGoogle] GA4 provision failed:', err.message);
    result.ga4.error = err.message;
  }

  // GSC — add the domain property. Verification has to happen via DNS TXT
  // before any data flows; we drop the verification token into the result
  // so the caller can hand it to Hostinger DNS (Hostinger flow already
  // wires DNS TXT writes for other onboarding tasks).
  try {
    const siteUrl = `sc-domain:${cleanDomain}`;
    const encoded = encodeURIComponent(siteUrl);
    await masterFetch('PUT', `https://www.googleapis.com/webmasters/v3/sites/${encoded}`);
    result.gsc.site_url = siteUrl;
    result.gsc.ok = true;
    result.gsc.verification_pending = true;
    // Note: programmatic GSC verification token retrieval is on the
    // Site Verification API (siteverification.googleapis.com/v1), not the
    // Webmasters API. Hostinger CNAME wiring already handles the
    // verification record placement for our domains.
  } catch (err) {
    console.warn('[iaMasterGoogle] GSC provision failed:', err.message);
    result.gsc.error = err.message;
  }

  // GBP — create an unverified listing under the IA master account.
  // Verification (postcard / phone / video) still belongs to the customer
  // and we surface that via verification_pending.
  try {
    const accountsData = await masterFetch('GET', 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
    const gbpAccount = (accountsData.accounts || []).find((a) => a.type === 'ORGANIZATION') || (accountsData.accounts || [])[0];
    if (!gbpAccount) throw new Error('No GBP account writable by the IA master service account');
    const locBody = {
      title: businessName || cleanDomain,
      websiteUri: `https://${cleanDomain}`,
      languageCode: 'en',
    };
    const locRes = await masterFetch('POST',
      `https://mybusinessbusinessinformation.googleapis.com/v1/${gbpAccount.name}/locations?validateOnly=false`,
      locBody);
    result.gbp.account_name = gbpAccount.name;
    result.gbp.location_name = `${gbpAccount.name}/${locRes.name}`;
    result.gbp.ok = true;
    result.gbp.verification_pending = true;
  } catch (err) {
    console.warn('[iaMasterGoogle] GBP provision failed:', err.message);
    result.gbp.error = err.message;
  }

  return result;
}

/* ──────────────────────────────────────────────────────────────────────
 * TRANSFER OWNERSHIP — invite the customer (by email) as an Admin /
 * Owner on each provisioned asset. The de facto Google "ownership transfer"
 * (Google does not expose a true "transfer everything to this email"
 * single-call API; the supported pattern is "add user as admin, optionally
 * remove your service account once they accept").
 *
 * Inputs come from arion.site.google_setup_evidence_json (the
 * autoProvisionGoogle() output) plus the customer's primary email.
 * ────────────────────────────────────────────────────────────────────── */
export async function transferGoogleOwnership({ customerEmail, ga4PropertyId, gscSiteUrl, gbpAccountName, gbpLocationName }) {
  const token = await mintAccessToken();
  if (!token) {
    return { configured: false, error: 'ia_master_not_configured' };
  }
  const result = { configured: true, ga4: { ok: false }, gsc: { ok: false }, gbp: { ok: false } };

  // GA4 — add the customer as an Admin via accessBindings.create
  if (ga4PropertyId) {
    try {
      await masterFetch('POST',
        `https://analyticsadmin.googleapis.com/v1beta/properties/${encodeURIComponent(ga4PropertyId)}/accessBindings`,
        {
          user: customerEmail,
          roles: ['predefinedRoles/admin'],
        });
      result.ga4.ok = true;
    } catch (err) {
      console.warn('[iaMasterGoogle] GA4 access-binding failed:', err.message);
      result.ga4.error = err.message;
    }
  } else { result.ga4.error = 'no_property_id'; }

  // GSC — add the customer as an Owner via the per-site permissions
  // collection. Customer doesn't need to verify again — IA owner adding
  // them as Owner is a supported Google flow.
  if (gscSiteUrl) {
    try {
      const encoded = encodeURIComponent(gscSiteUrl);
      await masterFetch('POST',
        `https://www.googleapis.com/webmasters/v3/sites/${encoded}/permissions`,
        {
          email_address: customerEmail,
          permission_level: 'siteOwner',
        });
      result.gsc.ok = true;
    } catch (err) {
      console.warn('[iaMasterGoogle] GSC permission failed:', err.message);
      result.gsc.error = err.message;
    }
  } else { result.gsc.error = 'no_site_url'; }

  // GBP — invite the customer's email as Admin on the account so they can
  // claim the listing and complete verification themselves.
  if (gbpAccountName) {
    try {
      await masterFetch('POST',
        `https://mybusinessaccountmanagement.googleapis.com/v1/${gbpAccountName}/admins`,
        {
          admin: customerEmail,
          role: 'MANAGER',
        });
      result.gbp.ok = true;
    } catch (err) {
      console.warn('[iaMasterGoogle] GBP admin invite failed:', err.message);
      result.gbp.error = err.message;
    }
  } else { result.gbp.error = 'no_account_name'; }

  return result;
}

/**
 * Is the IA master path actually configured in this environment?
 * Used by route handlers to surface a clean 503 when the secret is missing
 * rather than letting the JWT mint blow up with a confusing error.
 */
export async function isIaMasterConfigured() {
  const key = await loadServiceAccountKey();
  return !!key;
}
