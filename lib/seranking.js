/**
 * SE Ranking API Client
 * Base URL: https://api4.seranking.com
 * Auth: Token header from SERANKING_API_SYSTEM_KEY env var
 *
 * Features: retry (3x), 15-minute GET cache (tenant-scoped)
 */

const SERANKING_BASE = process.env.SERANKING_API_BASE || 'https://api4.seranking.com';
const SERANKING_KEY = process.env.SERANKING_API_SYSTEM_KEY;

// ---------------------------------------------------------------------------
// In-memory cache (15 minute TTL, tenant-scoped keys)
// ---------------------------------------------------------------------------
const cache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

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
 * @param {object} [opts] - Options: { tenantId, attempt }
 * @returns {Promise<object|null>}
 */
async function request(method, path, body = undefined, opts = {}) {
  const { tenantId = 'global', attempt = 1 } = typeof opts === 'number' ? { attempt: opts } : opts;

  if (!SERANKING_KEY) {
    console.error('[seranking] SERANKING_API_SYSTEM_KEY is not set');
    return null;
  }

  // Cache check for GETs — tenant-scoped to prevent cross-tenant collisions
  const cacheKey = `${tenantId}:${method}:${path}`;
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
      return request(method, path, body, { tenantId, attempt: attempt + 1 });
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
 * @param {string} [tenantId]
 * @returns {Promise<Array<object>|null>}
 */
export async function listProjects(tenantId) {
  try {
    const result = await request('GET', '/sites', undefined, { tenantId });
    return result ?? [];
  } catch (err) {
    console.error('[seranking] listProjects error:', err.message);
    return null;
  }
}

/**
 * Get details for a specific project.
 * @param {string|number} projectId
 * @param {string} [tenantId]
 * @returns {Promise<object|null>}
 */
export async function getProject(projectId, tenantId) {
  try {
    const result = await request('GET', `/sites/${encodeURIComponent(projectId)}`, undefined, { tenantId });
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
 * @param {string} [tenantId]
 * @returns {Promise<Array<object>|null>}
 */
export async function getKeywordRankings(projectId, params = {}, tenantId) {
  try {
    const qs = new URLSearchParams(params).toString();
    const path = `/sites/${encodeURIComponent(projectId)}/positions${qs ? '?' + qs : ''}`;
    const result = await request('GET', path, undefined, { tenantId });
    return result ?? [];
  } catch (err) {
    console.error('[seranking] getKeywordRankings error:', err.message);
    return null;
  }
}

/**
 * Get keyword positions for a project (all search engines).
 * @param {string|number} projectId
 * @param {string} [tenantId]
 * @returns {Promise<Array<object>>}
 */
export async function getKeywordPositions(projectId, tenantId) {
  try {
    const result = await request('GET', `/sites/${encodeURIComponent(projectId)}/positions`, undefined, { tenantId });
    return result ?? [];
  } catch (err) {
    console.error('[seranking] getKeywordPositions error:', err.message);
    return [];
  }
}

/**
 * Get site audit issues for an audit ID.
 * @param {string|number} auditId
 * @param {string} [tenantId]
 * @returns {Promise<object|null>}
 */
export async function getAuditIssues(auditId, tenantId) {
  try {
    const result = await request('GET', `/site-audit/audits/${encodeURIComponent(auditId)}`, undefined, { tenantId });
    return result;
  } catch (err) {
    console.error('[seranking] getAuditIssues error:', err.message);
    return null;
  }
}

/**
 * Get audit sections (categorized issues).
 * @param {string|number} auditId
 * @param {string} [tenantId]
 * @returns {Promise<Array<object>>}
 */
export async function getAuditSections(auditId, tenantId) {
  try {
    const result = await request('GET', `/site-audit/audits/${encodeURIComponent(auditId)}/issues`, undefined, { tenantId });
    return result ?? [];
  } catch (err) {
    console.error('[seranking] getAuditSections error:', err.message);
    return [];
  }
}

/**
 * Get competitors for a project.
 * @param {string|number} projectId
 * @param {string} [tenantId]
 * @returns {Promise<Array<object>>}
 */
export async function getProjectCompetitors(projectId, tenantId) {
  try {
    const result = await request('GET', `/sites/${encodeURIComponent(projectId)}/competitors`, undefined, { tenantId });
    return result ?? [];
  } catch (err) {
    console.error('[seranking] getProjectCompetitors error:', err.message);
    return [];
  }
}

/**
 * Get audit results/summary for a specific audit.
 * @param {string|number} auditId
 * @param {string} [tenantId]
 * @returns {Promise<object|null>}
 */
export async function getAuditSummary(auditId, tenantId) {
  try {
    const result = await request('GET', `/site-audit/audits/${encodeURIComponent(auditId)}`, undefined, { tenantId });
    return result;
  } catch (err) {
    console.error('[seranking] getAuditSummary error:', err.message);
    return null;
  }
}

/**
 * Trigger an advanced audit recheck.
 * @param {object} auditConfig
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
 * Clear the in-memory cache.
 */
export function clearCache() {
  cache.clear();
}
