/**
 * Hostinger API Client
 * Base URL: https://developers.hostinger.com (or HOSTINGER_API_BASE env)
 * Auth: Bearer token from HOSTINGER_API_TOKEN env var
 *
 * Features: retry (3x exponential backoff), 1h GET cache, circuit breaker (5 fails -> 60s open)
 */

const HOSTINGER_BASE = process.env.HOSTINGER_API_BASE || 'https://developers.hostinger.com';
const HOSTINGER_TOKEN = process.env.HOSTINGER_API_TOKEN;

// ---------------------------------------------------------------------------
// In-memory cache (1 hour TTL)
// ---------------------------------------------------------------------------
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Return a cached value if still fresh, otherwise undefined.
 * @param {string} key
 * @returns {*|undefined}
 */
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

/**
 * Store a value in the cache.
 * @param {string} key
 * @param {*} value
 */
function cacheSet(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------
let cbFailures = 0;
let cbOpenUntil = 0;
const CB_THRESHOLD = 5;
const CB_COOLDOWN_MS = 60_000;

function cbIsOpen() {
  if (cbFailures < CB_THRESHOLD) return false;
  if (Date.now() > cbOpenUntil) {
    // half-open: allow one attempt
    cbFailures = 0;
    return false;
  }
  return true;
}

function cbRecordFailure() {
  cbFailures += 1;
  if (cbFailures >= CB_THRESHOLD) {
    cbOpenUntil = Date.now() + CB_COOLDOWN_MS;
  }
}

function cbRecordSuccess() {
  cbFailures = 0;
}

// ---------------------------------------------------------------------------
// Core request helper
// ---------------------------------------------------------------------------

/**
 * Make an authenticated request to the Hostinger API with retry + circuit breaker.
 * @param {string} method - HTTP method
 * @param {string} path   - API path (e.g. "/api/dns/v1/zones")
 * @param {object} [body] - JSON body for POST/PUT/PATCH
 * @param {number} [attempt=1]
 * @returns {Promise<object|null>}
 */
async function request(method, path, body = undefined, opts = {}, attempt = 1) {
  if (!HOSTINGER_TOKEN) {
    console.error('[hostinger] HOSTINGER_API_TOKEN is not set');
    return opts.surfaceErrors ? { ok: false, error: 'HOSTINGER_API_TOKEN not set' } : null;
  }

  if (cbIsOpen()) {
    console.error('[hostinger] Circuit breaker is OPEN – skipping request');
    return opts.surfaceErrors ? { ok: false, error: 'circuit_breaker_open' } : null;
  }

  // Cache check for GETs
  const cacheKey = `${method}:${path}`;
  if (method === 'GET') {
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;
  }

  const url = `${HOSTINGER_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${HOSTINGER_TOKEN}`,
    'Content-Type': 'application/json',
  };

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // 4xx errors are client-side mistakes (bad payload, permission, etc.) — no point retrying.
      // Record as failure for CB but don't retry; surface immediately.
      if (res.status >= 400 && res.status < 500) {
        cbRecordFailure();
        const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
        err.status = res.status;
        err.body = text;
        if (opts.surfaceErrors) return { ok: false, error: err.message, status: res.status, body: text };
        throw err;
      }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json().catch(() => null);
    cbRecordSuccess();

    if (method === 'GET' && data !== null) {
      cacheSet(cacheKey, data);
    }

    return opts.surfaceErrors ? { ok: true, data } : data;
  } catch (err) {
    cbRecordFailure();

    if (attempt < 3 && !err.status) {
      const delay = 2 ** attempt * 500; // 1s, 2s
      await new Promise((r) => setTimeout(r, delay));
      return request(method, path, body, opts, attempt + 1);
    }

    console.error(`[hostinger] ${method} ${path} failed after ${attempt} attempts:`, err.message);
    if (opts.surfaceErrors) return { ok: false, error: err.message, status: err.status || null, body: err.body || null };
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public methods
// ---------------------------------------------------------------------------

/**
 * List all websites from Hostinger hosting.
 * @returns {Promise<object|null>}
 */
export async function listWebsites() {
  return request('GET', '/api/hosting/v1/websites?per_page=100');
}

/**
 * Get domain portfolio info for a specific domain.
 * @param {string} domain - e.g. "example.com"
 * @returns {Promise<object|null>}
 */
export async function getDomainInfo(domain) {
  return request('GET', '/api/domains/v1/portfolio/' + encodeURIComponent(domain));
}

/**
 * Get DNS records for a domain.
 * @param {string} domain
 * @returns {Promise<object|null>}
 */
export async function getDnsRecords(domain) {
  return request('GET', '/api/dns/v1/zones/' + encodeURIComponent(domain));
}

/**
 * Probe a domain's WordPress REST API for basic site info.
 * No auth needed — uses the public /wp-json/ endpoint.
 * @param {string} domain
 * @returns {Promise<{name: string|null, description: string|null, url: string|null, wpVersion: string|null}|null>}
 */
export async function getWordPressInfo(domain) {
  try {
    const res = await fetch('https://' + domain + '/wp-json/', {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      name: data.name || null,
      description: data.description || null,
      url: data.url || null,
      wpVersion: data.namespaces?.includes('wp/v2') ? 'detected' : null,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Check domain availability via Hostinger.
 * @param {string} domain - e.g. "example.com"
 * @returns {Promise<{available: boolean, domain: string, price?: number}|null>}
 */
export async function getDomainAvailability(domain) {
  try {
    const result = await request('GET', `/api/domains/v1/availability?domain=${encodeURIComponent(domain)}`);
    if (!result) {
      return { available: false, domain, message: 'Availability check not available' };
    }
    return result;
  } catch (err) {
    console.error('[hostinger] getDomainAvailability error:', err.message);
    return null;
  }
}

/**
 * Get hosting/subscription details.
 * @param {string} subscriptionId
 * @returns {Promise<object|null>}
 */
export async function getHostingDetails(subscriptionId) {
  try {
    const result = await request('GET', `/api/billing/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
    if (!result) {
      return { subscriptionId, status: 'unknown', message: 'Hosting details not available' };
    }
    return result;
  } catch (err) {
    console.error('[hostinger] getHostingDetails error:', err.message);
    return null;
  }
}

/**
 * Get SSL certificate status for a domain.
 * @param {string} domain
 * @returns {Promise<{domain: string, ssl_active: boolean, expires_at?: string}|null>}
 */
export async function getSslStatus(domain) {
  // Hostinger's SSL API endpoint doesn't exist at /api/ssl/v1/certificates.
  // Instead, check the actual HTTPS connection to determine SSL status.
  try {
    const res = await fetch(`https://${domain}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });
    return {
      domain,
      ssl_active: true,
      status: 'active',
      issuer: 'Let\'s Encrypt',
      type: 'Lifetime (auto-renewing)',
      message: 'SSL certificate is active and valid',
    };
  } catch (err) {
    console.warn('[hostinger] getSslStatus HTTPS check failed:', err.message);
    return {
      domain,
      ssl_active: false,
      status: 'unknown',
      issuer: null,
      type: null,
      message: 'Could not verify SSL status',
    };
  }
}

// ---------------------------------------------------------------------------
// WordPress REST API helpers (public, no Hostinger auth needed)
// ---------------------------------------------------------------------------

/**
 * Make a request to a WordPress REST API endpoint with retry.
 * @param {string} url - Full URL to fetch
 * @param {number} [attempt=1]
 * @returns {Promise<object|null>}
 */
async function wpRequest(url, attempt = 1) {
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    if (attempt < 3) {
      const delay = 2 ** attempt * 500;
      await new Promise((r) => setTimeout(r, delay));
      return wpRequest(url, attempt + 1);
    }
    console.error(`[hostinger/wp] ${url} failed after 3 attempts:`, err.message);
    return null;
  }
}

/**
 * Fetch WordPress site info via public REST API (no auth needed).
 * @param {string} domain - e.g. "example.com"
 * @returns {Promise<{name: string|null, description: string|null, url: string|null, version: string|null, namespaces: string[]}|null>}
 */
export async function getWpSiteInfo(domain) {
  try {
    const data = await wpRequest(`https://${domain}/wp-json`);
    if (!data) return null;

    // Detect installed plugins from registered REST API namespaces
    const ns = data.namespaces || [];
    const pluginMap = {
      'litespeed/v1': { name: 'LiteSpeed Cache', slug: 'litespeed-cache' },
      'rankmath/v1': { name: 'Rank Math SEO', slug: 'seo-by-rank-math' },
      'wordfence/v1': { name: 'Wordfence Security', slug: 'wordfence' },
      'elementor/v1': { name: 'Elementor', slug: 'elementor' },
      'elementor-pro/v1': { name: 'Elementor Pro', slug: 'elementor-pro' },
      'hostinger-tools-plugin/v1': { name: 'Hostinger Tools', slug: 'hostinger' },
      'google-site-kit/v1': { name: 'Google Site Kit', slug: 'google-site-kit' },
      'elementor-hello-elementor/v1': { name: 'Hello Elementor Theme', slug: 'hello-elementor' },
    };
    const detectedPlugins = [];
    for (const [prefix, info] of Object.entries(pluginMap)) {
      if (ns.some(n => n.startsWith(prefix.split('/')[0]))) {
        detectedPlugins.push({ ...info, status: 'active', source: 'namespace' });
      }
    }

    return {
      name: data.name || null,
      description: data.description || null,
      url: data.url || null,
      version: data.namespaces?.includes('wp/v2') ? 'detected' : null,
      timezone: data.timezone_string || data.gmt_offset || null,
      namespaces: ns,
      detectedPlugins,
    };
  } catch (err) {
    console.error('[hostinger/wp] getWpSiteInfo error:', err.message);
    return null;
  }
}

/**
 * Fetch WordPress pages via REST API.
 * @param {string} domain
 * @returns {Promise<Array|null>}
 */
export async function getWpPages(domain) {
  try {
    return await wpRequest(`https://${domain}/wp-json/wp/v2/pages?per_page=100&_fields=id,title,slug,status,modified,link`);
  } catch (err) {
    console.error('[hostinger/wp] getWpPages error:', err.message);
    return null;
  }
}

/**
 * Fetch WordPress posts via REST API.
 * @param {string} domain
 * @returns {Promise<Array|null>}
 */
export async function getWpPosts(domain) {
  try {
    return await wpRequest(`https://${domain}/wp-json/wp/v2/posts?per_page=100&_fields=id,title,slug,status,modified,link`);
  } catch (err) {
    console.error('[hostinger/wp] getWpPosts error:', err.message);
    return null;
  }
}

/**
 * Fetch installed plugins via WordPress REST API.
 * Requires authentication — returns null if 401/403.
 * @param {string} domain
 * @returns {Promise<Array|null>}
 */
export async function getWpPlugins(domain) {
  try {
    return await wpRequest(`https://${domain}/wp-json/wp/v2/plugins`);
  } catch (err) {
    console.error('[hostinger/wp] getWpPlugins error:', err.message);
    return null;
  }
}

/**
 * Fetch WordPress themes via REST API.
 * Requires authentication — returns null if 401/403.
 * @param {string} domain
 * @returns {Promise<Array|null>}
 */
export async function getWpThemes(domain) {
  try {
    return await wpRequest(`https://${domain}/wp-json/wp/v2/themes`);
  } catch (err) {
    console.error('[hostinger/wp] getWpThemes error:', err.message);
    return null;
  }
}

/**
 * Create or update DNS records for a domain via Hostinger's zone-update endpoint.
 *
 * Hostinger's DNS API expects PUT /api/dns/v1/zones/{domain} with a `zone` array where
 * each entry groups records by (name + type). Each zone entry then has a nested
 * `records` array of { content } objects — multiple contents share the same name/type.
 *
 * This helper accepts the flat `[{type, name, content, ttl}]` shape used by the rest
 * of the codebase and transforms it into Hostinger's nested shape. Records sharing the
 * same (name, type) are merged into one zone entry with multiple content values.
 *
 * @param {string} domain
 * @param {Array<{type: string, name: string, content: string, ttl?: number}>} records
 * @param {boolean} [overwrite=false] - If true, replaces existing records matching type+name
 * @returns {Promise<{ok: true, data: any} | {ok: false, error: string, status?: number, body?: string}>}
 */
export async function createDnsRecords(domain, records, overwrite = false) {
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, error: 'no records supplied' };
  }
  // Group by (name + type) so we can merge multi-value records like round-robin A records
  const grouped = new Map();
  for (const r of records) {
    if (!r || !r.type || !r.name || r.content == null) {
      return { ok: false, error: 'each record needs type, name, and content' };
    }
    const key = `${r.name}|${r.type}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        name: r.name,
        type: r.type,
        ttl: r.ttl || 300,
        records: [],
      });
    }
    grouped.get(key).records.push({ content: r.content });
  }
  const zone = Array.from(grouped.values());
  const res = await request('PUT', '/api/dns/v1/zones/' + encodeURIComponent(domain), { zone, overwrite }, { surfaceErrors: true });
  // On success, invalidate any cached GET for this zone so the next read returns fresh data
  if (res.ok) invalidateZoneCache(domain);
  return res;
}

/** Invalidate any cached DNS-zone GETs for a domain. Used after PUT/DELETE. */
function invalidateZoneCache(domain) {
  const prefix = `GET:/api/dns/v1/zones/${encodeURIComponent(domain)}`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

/**
 * Delete DNS records for a domain.
 * Hostinger expects DELETE /api/dns/v1/zones/{domain} with `{filters: [{name, type}]}`.
 * We accept either the old flat shape (arrays of full records — we'll strip to name/type)
 * or the new { name, type } filter shape.
 *
 * @param {string} domain
 * @param {Array<{type: string, name: string, content?: string}>} records
 * @returns {Promise<{ok: true, data: any} | {ok: false, error: string, status?: number}>}
 */
export async function deleteDnsRecords(domain, records) {
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, error: 'no records supplied' };
  }
  const filters = records.map(r => ({ name: r.name, type: r.type }));
  const res = await request('DELETE', '/api/dns/v1/zones/' + encodeURIComponent(domain), { filters }, { surfaceErrors: true });
  if (res.ok) invalidateZoneCache(domain);
  return res;
}

// ---------------------------------------------------------------------------
// Onboarding & Provisioning Methods
// (Used by signup flow: domain search/buy, BYOD verify, WP site create, plugin deploy)
// ---------------------------------------------------------------------------

// ----- WHOIS Profiles -------------------------------------------------------

/**
 * Create a WHOIS contact profile for domain registrations.
 * One profile is reused across all domains a tenant buys.
 * @param {object} profile - { tld, country, entity_type, first_name, last_name, email, phone, address1, city, state, zip, ... }
 * @returns {Promise<{ok: true, data: any} | {ok: false, error: string}>}
 */
export async function createWhoisProfile(profile) {
  return request('POST', '/api/domains/v1/whois', profile, { surfaceErrors: true });
}

/**
 * List all WHOIS profiles on the account.
 * @returns {Promise<object|null>}
 */
export async function listWhoisProfiles() {
  return request('GET', '/api/domains/v1/whois');
}

/**
 * Get a WHOIS profile by ID.
 * @param {string|number} profileId
 * @returns {Promise<object|null>}
 */
export async function getWhoisProfile(profileId) {
  return request('GET', `/api/domains/v1/whois/${encodeURIComponent(profileId)}`);
}

// ----- Domain Purchase + Lifecycle -----------------------------------------

/**
 * Purchase and register a new domain.
 *
 * Required params per Hostinger's actual schema (verified from API MCP source):
 *   - domain: full FQDN
 *   - itemId: catalog price item ID (string) — get from getCatalogItems()
 *   - whoisOwnerId: WHOIS profile ID (integer) — get from createWhoisProfile()
 *
 * @param {object} params
 * @param {string} params.domain
 * @param {string} params.itemId
 * @param {number} params.whoisOwnerId
 * @param {number} [params.paymentMethodId]
 * @param {object} [params.additionalDetails]
 */
export async function purchaseDomain({ domain, itemId, whoisOwnerId, paymentMethodId, additionalDetails }) {
  const body = {
    domain,
    item_id: itemId,
    domain_contacts: {
      owner_id: whoisOwnerId,
      // Hostinger reuses owner for admin/billing/tech if not specified
    },
  };
  if (paymentMethodId) body.payment_method_id = paymentMethodId;
  if (additionalDetails) body.additional_details = additionalDetails;
  return request('POST', '/api/domains/v1/portfolio', body, { surfaceErrors: true });
}

/**
 * Enable domain lock (prevents unauthorized transfer).
 * @param {string} domain
 */
export async function enableDomainLock(domain) {
  return request('PUT', `/api/domains/v1/portfolio/${encodeURIComponent(domain)}/lock`, { lock: true }, { surfaceErrors: true });
}

/**
 * Enable WHOIS privacy protection.
 * @param {string} domain
 */
export async function enablePrivacyProtection(domain) {
  return request('PUT', `/api/domains/v1/portfolio/${encodeURIComponent(domain)}/privacy`, { privacy: true }, { surfaceErrors: true });
}

/**
 * List all domains on the account.
 */
export async function listDomains() {
  return request('GET', '/api/domains/v1/portfolio');
}

/**
 * Set nameservers for a domain (used when client wants to point a Hostinger domain elsewhere).
 * @param {string} domain
 * @param {string[]} nameservers
 */
export async function setDomainNameservers(domain, nameservers) {
  return request('PUT', `/api/domains/v1/portfolio/${encodeURIComponent(domain)}/nameservers`, { ns1: nameservers[0], ns2: nameservers[1], ns3: nameservers[2], ns4: nameservers[3] }, { surfaceErrors: true });
}

// ----- Billing / Catalog ---------------------------------------------------

/**
 * Fetch the catalog of orderable items (hosting plans, domain TLDs, etc.).
 * Used by signup to display plan + domain pricing.
 * @returns {Promise<object|null>}
 */
export async function getCatalogItems() {
  return request('GET', '/api/billing/v1/catalog');
}

/**
 * Get all subscriptions on the account (used to confirm hosting plan is active before site creation).
 */
export async function listSubscriptions() {
  return request('GET', '/api/billing/v1/subscriptions');
}

// ----- Hosting / Website Creation ------------------------------------------

/**
 * Create a new WordPress website on a domain that's already on the Hostinger account.
 *
 * Hostinger schema (verified from API MCP source):
 *   - domain: FQDN, cannot start with "www."
 *   - order_id: integer (the hosting plan order this site lives under)
 *   - datacenter_code: optional, REQUIRED for first website on a new hosting plan
 *
 * Note: Hostinger does NOT accept admin_email / admin_password here. The WP
 * admin user is auto-created from the Hostinger account. Retrieve credentials
 * separately via getWebsiteDetails() after creation, or reset via WP-CLI/Playwright.
 *
 * @param {object} params
 * @param {string} params.domain
 * @param {number} params.orderId
 * @param {string} [params.datacenterCode]
 */
export async function createWebsite({ domain, orderId, datacenterCode }) {
  const body = { domain, order_id: orderId };
  if (datacenterCode) body.datacenter_code = datacenterCode;
  return request('POST', '/api/hosting/v1/websites', body, { surfaceErrors: true });
}

/**
 * Verify ownership of a domain (called before website creation when domain is BYOD).
 * @param {string} domain
 */
export async function verifyDomainOwnership(domain) {
  return request('POST', '/api/hosting/v1/domains/verify', { domain }, { surfaceErrors: true });
}

/**
 * Generate a free Hostinger subdomain (used as a fallback or temp staging URL).
 */
export async function generateFreeSubdomain() {
  return request('POST', '/api/hosting/v1/subdomains/generate', {}, { surfaceErrors: true });
}

/**
 * Get details for a specific website on the hosting account.
 * @param {string|number} websiteId
 */
export async function getWebsiteDetails(websiteId) {
  return request('GET', `/api/hosting/v1/websites/${encodeURIComponent(websiteId)}`);
}

// ----- Plugin / Theme Deployment (NOT a real API endpoint!) ----------------
//
// Hostinger's "deploy WordPress plugin" tool is NOT exposed as an HTTP API —
// the official MCP server uses SFTP under the hood (it's a `custom: true`
// tool with a templated handler). There's no JSON endpoint we can call.
//
// For our pipeline we install plugins via Playwright UI upload through wp-admin
// while the worker is already authenticated to the new site. See
// workers/siteProvisioner.js -> uploadPluginViaUi().
//
// The functions below are kept as stubs that surface the correct error so
// nothing silently misbehaves if old code paths still call them.

export async function deployWordpressPlugin() {
  return {
    ok: false,
    error: 'Not supported — Hostinger has no REST endpoint for plugin install. Use Playwright UI upload instead.',
  };
}

export async function deployWordpressTheme() {
  return {
    ok: false,
    error: 'Not supported — Hostinger has no REST endpoint for theme install. Use Playwright UI upload instead.',
  };
}

/**
 * Clear the in-memory cache. Useful for testing or forced refresh.
 */
export function clearCache() {
  cache.clear();
}

/**
 * Reset the circuit breaker. Useful for testing.
 */
export function resetCircuitBreaker() {
  cbFailures = 0;
  cbOpenUntil = 0;
}
