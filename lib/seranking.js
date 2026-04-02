/**
 * SE Ranking API Client
 * Base URL: https://api4.seranking.com
 * Auth: Token header from SERANKING_API_SYSTEM_KEY env var
 *
 * Features: retry (3x), 15-minute GET cache
 */

const SERANKING_BASE = process.env.SERANKING_API_BASE || 'https://api4.seranking.com';
const SERANKING_KEY = process.env.SERANKING_API_SYSTEM_KEY;

// ---------------------------------------------------------------------------
// In-memory cache (15 minute TTL)
// ---------------------------------------------------------------------------
const cache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

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
// Core request helper
// ---------------------------------------------------------------------------

/**
 * Make an authenticated request to the SE Ranking API with retry logic.
 * @param {string} method - HTTP method
 * @param {string} path   - API path (e.g. "/sites")
 * @param {object} [body] - JSON body for POST/PUT/PATCH
 * @param {number} [attempt=1]
 * @returns {Promise<object|null>}
 */
async function request(method, path, body = undefined, attempt = 1) {
  if (!SERANKING_KEY) {
    console.error('[seranking] SERANKING_API_SYSTEM_KEY is not set');
    return null;
  }

  // Cache check for GETs
  const cacheKey = `${method}:${path}`;
  if (method === 'GET') {
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;
  }

  const url = `${SERANKING_BASE}${path}`;
  const headers = {
    Authorization: `Token ${SERANKING_KEY}`,
    'Content-Type': 'application/json',
  };

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json().catch(() => null);

    if (method === 'GET' && data !== null) {
      cacheSet(cacheKey, data);
    }

    return data;
  } catch (err) {
    if (attempt < 3) {
      const delay = 2 ** attempt * 500; // 1s, 2s
      await new Promise((r) => setTimeout(r, delay));
      return request(method, path, body, attempt + 1);
    }

    console.error(`[seranking] ${method} ${path} failed after 3 attempts:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public methods
// ---------------------------------------------------------------------------

/**
 * List all SE Ranking projects (sites).
 * @returns {Promise<Array<object>|null>} Array of project objects or null on failure
 */
export async function listProjects() {
  try {
    const result = await request('GET', '/sites');
    return result ?? [];
  } catch (err) {
    console.error('[seranking] listProjects error:', err.message);
    return null;
  }
}

/**
 * Get details for a specific project.
 * @param {string|number} projectId
 * @returns {Promise<object|null>}
 */
export async function getProject(projectId) {
  try {
    const result = await request('GET', `/sites/${encodeURIComponent(projectId)}`);
    return result;
  } catch (err) {
    console.error('[seranking] getProject error:', err.message);
    return null;
  }
}

/**
 * Get keyword ranking positions for a project.
 * @param {string|number} projectId
 * @param {object} [params] - Optional query params (date_from, date_to, etc.)
 * @returns {Promise<Array<object>|null>}
 */
export async function getKeywordRankings(projectId, params = {}) {
  try {
    const qs = new URLSearchParams(params).toString();
    const path = `/sites/${encodeURIComponent(projectId)}/positions${qs ? '?' + qs : ''}`;
    const result = await request('GET', path);
    return result ?? [];
  } catch (err) {
    console.error('[seranking] getKeywordRankings error:', err.message);
    return null;
  }
}

/**
 * Get audit results/summary for a specific audit.
 * @param {string|number} auditId
 * @returns {Promise<object|null>}
 */
export async function getAuditSummary(auditId) {
  try {
    const result = await request('GET', `/site-audit/audits/${encodeURIComponent(auditId)}`);
    return result;
  } catch (err) {
    console.error('[seranking] getAuditSummary error:', err.message);
    return null;
  }
}

/**
 * Trigger an advanced audit recheck.
 * @param {object} auditConfig - Audit configuration body
 * @param {string|number} auditConfig.audit_id - The audit to recheck
 * @returns {Promise<object|null>}
 */
export async function triggerAuditRecheck(auditConfig) {
  try {
    const result = await request('POST', '/site-audit/audits/recheck/advanced', auditConfig);
    return result;
  } catch (err) {
    console.error('[seranking] triggerAuditRecheck error:', err.message);
    return null;
  }
}

/**
 * Clear the in-memory cache. Useful for testing or forced refresh.
 */
export function clearCache() {
  cache.clear();
}
