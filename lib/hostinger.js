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
async function request(method, path, body = undefined, attempt = 1) {
  if (!HOSTINGER_TOKEN) {
    console.error('[hostinger] HOSTINGER_API_TOKEN is not set');
    return null;
  }

  if (cbIsOpen()) {
    console.error('[hostinger] Circuit breaker is OPEN – skipping request');
    return null;
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
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json().catch(() => null);
    cbRecordSuccess();

    if (method === 'GET' && data !== null) {
      cacheSet(cacheKey, data);
    }

    return data;
  } catch (err) {
    cbRecordFailure();

    if (attempt < 3) {
      const delay = 2 ** attempt * 500; // 1s, 2s
      await new Promise((r) => setTimeout(r, delay));
      return request(method, path, body, attempt + 1);
    }

    console.error(`[hostinger] ${method} ${path} failed after 3 attempts:`, err.message);
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
  try {
    const result = await request('GET', `/api/ssl/v1/certificates?domain=${encodeURIComponent(domain)}`);
    if (!result) {
      return { domain, ssl_active: false, message: 'SSL status not available' };
    }
    return result;
  } catch (err) {
    console.error('[hostinger] getSslStatus error:', err.message);
    return null;
  }
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
