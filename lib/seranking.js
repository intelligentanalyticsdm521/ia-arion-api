/**
 * SE Ranking API Client
 * Base URL: https://api4.seranking.com
 * Auth: Token header from SERANKING_API_SYSTEM_KEY env var
 *
 * Features: retry (3x), 15-minute GET cache (tenant-scoped)
 */

const SERANKING_BASE = process.env.SERANKING_API_BASE || 'https://api4.seranking.com';
// Project API key. Accept underscored + dashed Key Vault names.
const SERANKING_KEY = process.env.SERANKING_API_SYSTEM_KEY
  || process.env['SE-RANKING-API-KEY']
  || process.env.SE_RANKING_API_KEY;

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
 * Get tracked keywords metadata for a project (WITH keyword names/text).
 * This is the source of truth for the "keyword" field — /positions only
 * returns keyword_id, so to display real keyword text we must join with
 * this response.
 *
 * Endpoint: GET /sites/{projectId}/keywords
 * Returns: [{ keyword_id, keyword, group_id, volume, difficulty, ... }]
 *
 * @param {string|number} projectId
 * @param {string} [tenantId]
 * @returns {Promise<Array<object>>}
 */
export async function getProjectKeywords(projectId, tenantId) {
  try {
    const result = await request('GET', `/sites/${encodeURIComponent(projectId)}/keywords`, undefined, { tenantId });
    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.error('[seranking] getProjectKeywords error:', err.message);
    return [];
  }
}

/**
 * Get site/project overview including visibility score.
 * Endpoint: GET /sites/{projectId}
 * Returns: { id, name, url, visibility, total_keywords, ... }
 */
export async function getSiteOverview(projectId, tenantId) {
  try {
    const result = await request('GET', `/sites/${encodeURIComponent(projectId)}`, undefined, { tenantId });
    return result || null;
  } catch (err) {
    console.error('[seranking] getSiteOverview error:', err.message);
    return null;
  }
}

/**
 * Get historical positions for a project (for content decay detection).
 * Endpoint: GET /sites/{projectId}/positions?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
 */
export async function getPositionsHistory(projectId, dateFrom, dateTo, tenantId) {
  try {
    const qs = new URLSearchParams();
    if (dateFrom) qs.set('date_from', dateFrom);
    if (dateTo) qs.set('date_to', dateTo);
    const path = `/sites/${encodeURIComponent(projectId)}/positions${qs.toString() ? '?' + qs.toString() : ''}`;
    const result = await request('GET', path, undefined, { tenantId });
    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.error('[seranking] getPositionsHistory error:', err.message);
    return [];
  }
}

/**
 * Start a site audit for a project.
 * Endpoint: POST /site-audit/audits with { site_id: projectId }
 * Returns: { id, status, ... } — the new audit id is stored on the site row
 * so subsequent calls to getAuditSummary can resolve it.
 */
export async function startSiteAudit(projectId, tenantId) {
  try {
    const result = await request('POST', '/site-audit/audits', { site_id: Number(projectId) }, { tenantId });
    return result || null;
  } catch (err) {
    console.error('[seranking] startSiteAudit error:', err.message);
    return null;
  }
}

/**
 * Add a competitor to a project.
 * Endpoint: POST /sites/{projectId}/competitors with { domain }
 * Returns: { id, domain, ... }
 */
export async function addCompetitor(projectId, domain, tenantId) {
  try {
    const result = await request('POST', `/sites/${encodeURIComponent(projectId)}/competitors`, { domain }, { tenantId });
    return result || null;
  } catch (err) {
    console.error('[seranking] addCompetitor error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Project CRUD (Phase: SE Ranking productization 2026-06-17)
// ---------------------------------------------------------------------------

/**
 * Create a new SE Ranking project (site).
 * Endpoint: POST /sites
 *
 * Body schema (per SE Ranking v4 docs):
 *   - name (string, required): human-readable project name
 *   - url (string, required): full URL of site to track
 *   - search_engines (array of objects, required): [{ se_id, region_id, lang_id }]
 *   - check_freq (int): position-check frequency in days (1, 3, 7, 14, 30)
 *   - group_id (int, optional): project group id
 *   - subdomain_match (0/1)
 *   - exact_match (0/1)
 *
 * @param {object} opts
 *   - name (required), url (required), engines (array), checkFreqDays (int)
 * @returns {Promise<object|null>} { id, name, url, ... } on success
 */
export async function createProject(opts, tenantId) {
  const { name, url, engines, checkFreqDays = 7, groupId } = opts || {};
  if (!name || !url || !Array.isArray(engines) || engines.length === 0) {
    console.error('[seranking] createProject missing required params');
    return null;
  }
  const body = {
    name,
    url,
    search_engines: engines.map((e) => ({
      se_id: Number(e.seId ?? e.se_id),
      region_id: e.regionId ?? e.region_id ?? null,
      lang_id: e.langId ?? e.lang_id ?? null,
    })),
    check_freq: Number(checkFreqDays),
    subdomain_match: 0,
    exact_match: 0,
  };
  if (groupId) body.group_id = Number(groupId);
  try {
    const result = await request('POST', '/sites', body, { tenantId });
    return result || null;
  } catch (err) {
    console.error('[seranking] createProject error:', err.message);
    return null;
  }
}

/**
 * Update SE Ranking project settings.
 * Endpoint: POST /sites/{projectId} or PATCH
 * SE Ranking accepts a partial body; only changed fields will be applied.
 *
 * @param {number|string} projectId
 * @param {object} updates
 * @returns {Promise<object|null>}
 */
export async function updateProject(projectId, updates, tenantId) {
  try {
    const result = await request('POST', `/sites/${encodeURIComponent(projectId)}`, updates, { tenantId });
    return result || null;
  } catch (err) {
    console.error('[seranking] updateProject error:', err.message);
    return null;
  }
}

/**
 * Delete an SE Ranking project.
 * Endpoint: DELETE /sites/{projectId}
 * Returns true on 200, false on failure.
 */
export async function deleteProject(projectId, tenantId) {
  try {
    const result = await request('DELETE', `/sites/${encodeURIComponent(projectId)}`, undefined, { tenantId });
    return result !== null;
  } catch (err) {
    console.error('[seranking] deleteProject error:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Keyword management
// ---------------------------------------------------------------------------

/**
 * Add keywords to a project.
 * Endpoint: POST /sites/{projectId}/keywords with { keywords: [...] }
 *
 * SE Ranking enforces a per-project keyword cap based on the customer's
 * SE Ranking plan. Our tier matrix caps below this (10/25/60/150) so
 * project-cap is rarely the binding constraint, but we surface it on error.
 *
 * @param {number|string} projectId
 * @param {Array<string|object>} keywords - strings or { keyword, group_id }
 * @param {object} [opts] - { tenantId, groupId }
 * @returns {Promise<{added: Array, errors: Array}|null>}
 */
export async function addKeywords(projectId, keywords, opts = {}) {
  const { tenantId, groupId } = opts;
  if (!Array.isArray(keywords) || keywords.length === 0) return { added: [], errors: [] };
  const items = keywords.map((kw) => {
    if (typeof kw === 'string') {
      const row = { keyword: kw.trim() };
      if (groupId) row.group_id = Number(groupId);
      return row;
    }
    return {
      keyword: String(kw.keyword || kw.term || '').trim(),
      group_id: kw.group_id ?? kw.groupId ?? (groupId || undefined),
    };
  }).filter((k) => k.keyword);
  if (items.length === 0) return { added: [], errors: ['no valid keywords'] };
  try {
    const result = await request('POST', `/sites/${encodeURIComponent(projectId)}/keywords`, { keywords: items }, { tenantId });
    return result || { added: items, errors: [] };
  } catch (err) {
    console.error('[seranking] addKeywords error:', err.message);
    return { added: [], errors: [err.message] };
  }
}

/**
 * Remove keywords from a project.
 * Endpoint: DELETE /sites/{projectId}/keywords with { keyword_ids: [...] }
 *
 * Note: SE Ranking may accept individual DELETE /sites/{id}/keywords/{kwId}
 * instead of bulk. We try bulk first; caller can fall back to single deletes.
 *
 * @param {number|string} projectId
 * @param {Array<number>} keywordIds
 * @returns {Promise<boolean>}
 */
export async function removeKeywords(projectId, keywordIds, tenantId) {
  if (!Array.isArray(keywordIds) || keywordIds.length === 0) return true;
  try {
    const result = await request('DELETE', `/sites/${encodeURIComponent(projectId)}/keywords`, { keyword_ids: keywordIds.map(Number) }, { tenantId });
    return result !== null;
  } catch (err) {
    console.error('[seranking] removeKeywords error:', err.message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Keyword groups (Focus Areas)
// ---------------------------------------------------------------------------

/**
 * List keyword groups for a project.
 * Endpoint: GET /sites/{projectId}/groups
 */
export async function getKeywordGroups(projectId, tenantId) {
  try {
    const result = await request('GET', `/sites/${encodeURIComponent(projectId)}/groups`, undefined, { tenantId });
    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.error('[seranking] getKeywordGroups error:', err.message);
    return [];
  }
}

/**
 * Create a keyword group inside a project.
 * Endpoint: POST /sites/{projectId}/groups with { name }
 */
export async function createKeywordGroup(projectId, name, tenantId) {
  if (!name) return null;
  try {
    const result = await request('POST', `/sites/${encodeURIComponent(projectId)}/groups`, { name: String(name) }, { tenantId });
    return result || null;
  } catch (err) {
    console.error('[seranking] createKeywordGroup error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// AI Search tracking + project settings (tier-driven)
// ---------------------------------------------------------------------------

/**
 * Configure AI Search engine tracking for a project.
 *
 * SE Ranking exposes AI Search (Google AI Mode, ChatGPT, Gemini, Perplexity)
 * via the Project Settings or via dedicated endpoints — the public docs
 * don't pin down the exact path, so we try both shapes:
 *   1. POST /sites/{id}/ai-search/settings with { ai_mode, chatgpt, gemini }
 *   2. Fallback: POST /sites/{id} with the same flags
 *
 * @param {number|string} projectId
 * @param {object} flags - { aiMode, chatgpt, gemini, perplexity }
 * @returns {Promise<{ok: boolean, applied: object, errorText: string|null}>}
 */
export async function setAITracking(projectId, flags, tenantId) {
  const payload = {
    ai_mode: !!flags.aiMode,
    chatgpt: !!flags.chatgpt,
    gemini: !!flags.gemini,
    perplexity: !!flags.perplexity,
  };
  // Try dedicated endpoint first
  let result = await request('POST', `/sites/${encodeURIComponent(projectId)}/ai-search/settings`, payload, { tenantId });
  if (result !== null) return { ok: true, applied: payload, endpoint: 'ai-search/settings' };
  // Fallback: try project update
  result = await request('POST', `/sites/${encodeURIComponent(projectId)}`, payload, { tenantId });
  if (result !== null) return { ok: true, applied: payload, endpoint: 'project_update_fallback' };
  return { ok: false, applied: payload, errorText: 'Both AI Search endpoint attempts returned null — likely 404 or 400. Surface as manual step.' };
}

/**
 * Configure search engines for an existing project (e.g., add Bing to a Google-only project).
 * Endpoint: POST /sites/{projectId}/search-engines (or similar — probe).
 *
 * @param {number|string} projectId
 * @param {Array<object>} engines - [{ seId, regionId, langId }]
 */
export async function setProjectEngines(projectId, engines, tenantId) {
  if (!Array.isArray(engines)) return null;
  const body = {
    search_engines: engines.map((e) => ({
      se_id: Number(e.seId ?? e.se_id),
      region_id: e.regionId ?? e.region_id ?? null,
      lang_id: e.langId ?? e.lang_id ?? null,
    })),
  };
  try {
    const result = await request('POST', `/sites/${encodeURIComponent(projectId)}/search-engines`, body, { tenantId });
    return result || null;
  } catch (err) {
    console.error('[seranking] setProjectEngines error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Engine reference data
// ---------------------------------------------------------------------------

/**
 * Get the list of available SE Ranking search engines (Google US, Bing US, etc.)
 * Endpoint: GET /system/search-engines
 *
 * Cached aggressively — engine IDs don't change.
 */
export async function listSearchEngines(tenantId) {
  try {
    const result = await request('GET', '/system/search-engines', undefined, { tenantId });
    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.error('[seranking] listSearchEngines error:', err.message);
    return [];
  }
}

/**
 * Clear the in-memory cache.
 */
export function clearCache() {
  cache.clear();
}

/**
 * Diagnostic-only raw request. Unlike `request()`, never swallows errors —
 * returns a structured result so callers can surface HTTP status + body
 * when debugging connectivity. Do NOT use for production traffic.
 *
 * @returns {Promise<{ok: boolean, status: number, url: string, data: any, errorText: string|null, keyConfigured: boolean}>}
 */
export async function rawRequest(method, path, body = undefined) {
  const url = `${SERANKING_BASE}${path}`;
  if (!SERANKING_KEY) {
    return { ok: false, status: 0, url, data: null, errorText: 'SERANKING_API_SYSTEM_KEY is not set', keyConfigured: false };
  }
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Token ${SERANKING_KEY}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* leave as null, keep raw text */ }
    return {
      ok: res.ok,
      status: res.status,
      url,
      data,
      errorText: res.ok ? null : (text ? text.slice(0, 500) : `HTTP ${res.status}`),
      keyConfigured: true,
    };
  } catch (err) {
    return { ok: false, status: 0, url, data: null, errorText: err.message, keyConfigured: true };
  }
}
