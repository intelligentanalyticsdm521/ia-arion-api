/**
 * SE Ranking API Client
 * Base URL: https://api4.seranking.com
 * Auth: Token header from SERANKING_API_SYSTEM_KEY env var
 *
 * Features: retry (3x), 15-minute GET cache (tenant-scoped)
 */

// Legacy host — still serves the GET endpoints we built the integration
// around. Per the n8n SDK v2.0.0 migration notes (2026-06-17), SE Ranking
// unified all endpoints onto https://api.seranking.com/v1. Existing reads
// continue to work on api4 so we keep that as the default base for
// already-shipped functions. New AIRT / project-create / search-engines /
// backlink endpoints MUST go to the v1 host — they don't exist on api4.
const SERANKING_BASE = process.env.SERANKING_API_BASE || 'https://api4.seranking.com';
const SERANKING_V1_BASE = process.env.SERANKING_V1_API_BASE || 'https://api.seranking.com/v1';

// LEGACY Project API key — works ONLY on api4.seranking.com.
// Verified 2026-06-17: this key returns 401 on the unified v1 host.
const SERANKING_KEY = process.env.SERANKING_API_SYSTEM_KEY
  || process.env['SE-RANKING-API-KEY']
  || process.env.SE_RANKING_API_KEY;

// V1 unified API key — works on api.seranking.com/v1 for both
// project-management AND data endpoints. Historically called the
// "Data API" key in our Key Vault, but it's actually the unified key
// for the v1 host. Verified 2026-06-17 via live probe:
//   GET /v1/project-management/sites              → 200 with this key
//   GET /v1/project-management/airt/brand?site_id → 200 with this key
//   GET /v1/project-management/system/search-engines → 200 with this key
// Same key returns 401 on legacy api4 host.
const SERANKING_V1_KEY = process.env.SERANKING_DATA_API_KEY
  || process.env['SE-RANKING-DATA-API-KEY']
  || process.env.SE_RANKING_DATA_API_KEY
  || SERANKING_KEY; // last-resort fallback for envs that only have one key set

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
  const { tenantId = 'global', attempt = 1, base = SERANKING_BASE } = typeof opts === 'number' ? { attempt: opts } : opts;

  // Pick the right auth key per host (verified 2026-06-17):
  //   api4.seranking.com           → SE-RANKING-API-SYSTEM-KEY
  //   api.seranking.com/v1         → SE-RANKING-DATA-API-KEY
  // Each key returns 401 if used on the other host.
  const isV1 = base === SERANKING_V1_BASE;
  const key = isV1 ? SERANKING_V1_KEY : SERANKING_KEY;
  if (!key) {
    console.error(`[seranking] No key configured for host ${base} (need ${isV1 ? 'SE-RANKING-DATA-API-KEY' : 'SE-RANKING-API-SYSTEM-KEY'})`);
    return null;
  }

  // Cache check for GETs — tenant-scoped to prevent cross-tenant collisions.
  // Cache key includes base so the same path on legacy vs v1 doesn't collide.
  const cacheKey = `${tenantId}:${base}:${method}:${path}`;
  if (method === 'GET') {
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;
  }

  const url = `${base}${path}`;
  const headers = {
    Authorization: `Token ${key}`,
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
      return request(method, path, body, { tenantId, attempt: attempt + 1, base });
    }

    console.error(`[seranking] ${method} ${path} failed after 3 attempts:`, err.message);
    return null;
  }
}

/** Convenience wrapper for the unified v1 host. */
function v1Request(method, path, body = undefined, opts = {}) {
  return request(method, path, body, { ...(typeof opts === 'object' ? opts : { attempt: opts }), base: SERANKING_V1_BASE });
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
 * List existing audits for a project. Used as an auto-self-heal lookup when
 * arion.site.se_ranking_audit_id is null but the project itself is connected
 * (e.g. onboarding started an audit but failed to persist the returned id).
 *
 * Endpoint: GET /site-audit/audits?site_id={projectId}
 * Returns: array of { id, status, started_at, ... } — caller picks the most
 * recent completed audit.
 *
 * @param {string|number} projectId
 * @param {string} [tenantId]
 * @returns {Promise<Array<object>>}
 */
export async function listSiteAudits(projectId, tenantId) {
  try {
    const result = await request('GET', `/site-audit/audits?site_id=${encodeURIComponent(projectId)}`, undefined, { tenantId });
    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.error('[seranking] listSiteAudits error:', err.message);
    return [];
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
 *
 * Endpoint: POST /v1/project-management/sites (unified host, NOT api4)
 * Body: ARRAY of project objects (can batch-create multiple).
 *
 * Required fields per project: `url`, `title`.
 * Optional: depth, subdomain_match, exact_url, check_freq, check_day,
 *           site_group_id, auto_reports, disable_audit, is_active.
 *
 * check_freq enum: check_daily | check_1in3 | check_weekly | check_monthly | manual
 *
 * Response: 201 with `{site_id: 12345}` on success.
 *
 * Search engines are configured AFTER creation via POST
 * /v1/project-management/sites/search-engines — see setProjectEngines.
 *
 * @param {object} opts
 *   - title (required), url (required), checkFreq (default 'check_daily'),
 *     subdomainMatch (default 1), exactUrl (default 0), depth (default 100),
 *     groupId (optional), autoReports (default 1), disableAudit (default 0)
 * @returns {Promise<{site_id:number}|null>}
 */
export async function createProject(opts, tenantId) {
  const { title, url, name, checkFreq = 'check_daily', subdomainMatch = 1, exactUrl = 0, depth = 100, groupId, autoReports = 1, disableAudit = 0 } = opts || {};
  const projectTitle = title || name;
  if (!projectTitle || !url) {
    console.error('[seranking] createProject missing required params (title, url)');
    return null;
  }
  const body = [{
    url,
    title: projectTitle,
    depth: Number(depth),
    subdomain_match: subdomainMatch ? 1 : 0,
    exact_url: exactUrl ? 1 : 0,
    check_freq: checkFreq,
    auto_reports: autoReports ? 1 : 0,
    disable_audit: disableAudit ? 1 : 0,
    is_active: 1,
    ...(groupId ? { site_group_id: Number(groupId) } : {}),
  }];
  try {
    const result = await v1Request('POST', '/project-management/sites', body, { tenantId });
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
// AIRT (AI Result Tracker) — Brand + LLM engines + Prompts
// ---------------------------------------------------------------------------
//
// SE Ranking's AI tracking workflow has THREE layers (in this order):
//   1. Set the project's brand string (required before any LLM engine).
//   2. Create one or more "LLM engines" per AI provider (Google AI Mode,
//      ChatGPT, Gemini, etc.), each scoped to a country/lang.
//   3. Add prompts under each llm_id; prompts can also be organized into
//      named groups within an llm engine.
//
// All endpoints on https://api.seranking.com/v1/project-management/airt/*
// (unified host; api4 does NOT have these paths). Confirmed 2026-06-17 via
// docs + n8n SDK source.

const AIRT_ENGINE_NAMES = new Set([
  'chatgpt',
  'google_ai_overview',
  'google_ai_mode',
  'perplexity',
  'gemini',
]);

/**
 * Set the brand string for a project (required before creating any LLM
 * engine in step 2). Max 255 chars.
 *
 * Endpoint: POST /v1/project-management/airt/brand?site_id={id}
 */
export async function setAIBrand(projectId, brand, tenantId) {
  if (!brand) return null;
  try {
    const result = await v1Request('POST', `/project-management/airt/brand?site_id=${encodeURIComponent(projectId)}`, { brand: String(brand).slice(0, 255) }, { tenantId });
    return result || { site_id: projectId, brand };
  } catch (err) {
    console.error('[seranking] setAIBrand error:', err.message);
    return null;
  }
}

/**
 * Get the configured brand for a project.
 * Endpoint: GET /v1/project-management/airt/brand?site_id={id}
 */
export async function getAIBrand(projectId, tenantId) {
  try {
    const result = await v1Request('GET', `/project-management/airt/brand?site_id=${encodeURIComponent(projectId)}`, undefined, { tenantId });
    return result || null;
  } catch (err) {
    console.error('[seranking] getAIBrand error:', err.message);
    return null;
  }
}

/**
 * List all configured LLM engines (enabled AI providers) for a project.
 * Endpoint: GET /v1/project-management/airt/llm?site_id={id}
 *
 * Returns array of { llm_id, base_name, country_code, lang_code, region_name }.
 */
export async function listAIEngines(projectId, tenantId) {
  try {
    const result = await v1Request('GET', `/project-management/airt/llm?site_id=${encodeURIComponent(projectId)}`, undefined, { tenantId });
    return Array.isArray(result) ? result : (result?.engines || result?.data || []);
  } catch (err) {
    console.error('[seranking] listAIEngines error:', err.message);
    return [];
  }
}

/**
 * Enable an AI engine for a project. Brand must be set first via setAIBrand.
 *
 * Endpoint: POST /v1/project-management/airt/llm?site_id={id}
 * Body: { base_name, country_code, lang_code, region_name? }
 *
 * `base_name` enum: chatgpt | google_ai_overview | google_ai_mode | perplexity | gemini
 *
 * @returns {Promise<{llm_id:number,...}|null>}
 */
export async function enableAIEngine(projectId, opts, tenantId) {
  const { baseName, countryCode = 'us', langCode = 'en', regionName } = opts || {};
  if (!baseName || !AIRT_ENGINE_NAMES.has(baseName)) {
    console.error('[seranking] enableAIEngine invalid base_name:', baseName);
    return null;
  }
  const body = { base_name: baseName, country_code: countryCode, lang_code: langCode };
  if (regionName) body.region_name = regionName;
  try {
    const result = await v1Request('POST', `/project-management/airt/llm?site_id=${encodeURIComponent(projectId)}`, body, { tenantId });
    return result || null;
  } catch (err) {
    console.error('[seranking] enableAIEngine error:', err.message);
    return null;
  }
}

/**
 * Disable an AI engine for a project (deletes the LLM record).
 * Endpoint: DELETE /v1/project-management/airt/llm?site_id={id}&llm_id={llmId}
 */
export async function disableAIEngine(projectId, llmId, tenantId) {
  try {
    const result = await v1Request('DELETE', `/project-management/airt/llm?site_id=${encodeURIComponent(projectId)}&llm_id=${encodeURIComponent(llmId)}`, undefined, { tenantId });
    return result !== null;
  } catch (err) {
    console.error('[seranking] disableAIEngine error:', err.message);
    return false;
  }
}

/**
 * Get the per-engine tracking status for a project.
 * Endpoint: GET /v1/project-management/airt/llm/status?site_id={id}&llm_id={llmId}
 *
 * Returns { progress, prompts_count, prompts_checked, last_update_date }.
 */
export async function getAIEngineStatus(projectId, llmId, tenantId) {
  try {
    const result = await v1Request('GET', `/project-management/airt/llm/status?site_id=${encodeURIComponent(projectId)}&llm_id=${encodeURIComponent(llmId)}`, undefined, { tenantId });
    return result || null;
  } catch (err) {
    console.error('[seranking] getAIEngineStatus error:', err.message);
    return null;
  }
}

/**
 * Set the project's classic SERP search engines (Google, Bing, etc.).
 * This is the post-create configuration step; for the AIRT (AI engines)
 * use enableAIEngine instead.
 *
 * Endpoint: POST /v1/project-management/sites/search-engines?site_id={id}
 * Body: { search_engine_id, region_id?, region_name?, lang_code?, ... }
 *
 * @param {number|string} projectId
 * @param {Array<object>} engines - [{ seId, regionId, regionName?, langCode? }]
 * @returns {Promise<Array<object>>} responses, one per engine
 */
export async function setProjectEngines(projectId, engines, tenantId) {
  if (!Array.isArray(engines) || engines.length === 0) return [];
  const results = [];
  for (const e of engines) {
    const body = {
      search_engine_id: Number(e.seId ?? e.se_id ?? e.search_engine_id),
      ...(e.regionId ?? e.region_id ? { region_id: Number(e.regionId ?? e.region_id) } : {}),
      ...(e.regionName || e.region_name ? { region_name: e.regionName || e.region_name } : {}),
      ...(e.langCode || e.lang_code ? { lang_code: e.langCode || e.lang_code } : {}),
    };
    const res = await v1Request('POST', `/project-management/sites/search-engines?site_id=${encodeURIComponent(projectId)}`, body, { tenantId });
    results.push(res);
  }
  return results;
}

/**
 * List configured SERP search engines for a project.
 * Endpoint: GET /v1/project-management/sites/search-engines?site_id={id}
 */
export async function listProjectEngines(projectId, tenantId) {
  try {
    const result = await v1Request('GET', `/project-management/sites/search-engines?site_id=${encodeURIComponent(projectId)}`, undefined, { tenantId });
    return Array.isArray(result) ? result : (result?.engines || []);
  } catch (err) {
    console.error('[seranking] listProjectEngines error:', err.message);
    return [];
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

// ---------------------------------------------------------------------------
// AI Search prompts (Growth + Authority tiers)
//
// Distinct from regular keywords. "Prompts" are LLM queries the project
// tracks brand mentions/citations in — e.g. "best mobile detailing
// company in Des Moines". SE Ranking sends each prompt to the configured
// AI engines (Google AI Mode, ChatGPT, Gemini, Perplexity) and records
// the customer's brand position in the response.
//
// Per tier matrix:
//   Growth     — 5 prompts × Google AI Mode only
//   Authority — 10 prompts × (Google AI Mode + ChatGPT + Gemini) = 30 slots
// ---------------------------------------------------------------------------

/**
 * List AI prompts for a specific LLM engine in a project.
 *
 * Endpoint: GET /v1/project-management/airt/prompts?site_id={id}&llm_id={llmId}
 * Optional query params: limit, offset, group_ids[]
 *
 * Returns items with `k2site_llm_id` (use this ID for answer/delete),
 * `keyword`, `search_volume`, `intent`.
 *
 * To get ALL prompts across all engines for a project, call listAIEngines
 * first then iterate getAIPrompts per llm_id.
 */
export async function getAIPrompts(projectId, llmId, opts = {}, tenantId) {
  if (!projectId || !llmId) return [];
  const params = new URLSearchParams({
    site_id: String(projectId),
    llm_id: String(llmId),
  });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  if (Array.isArray(opts.groupIds)) {
    for (const g of opts.groupIds) params.append('group_ids[]', String(g));
  }
  try {
    const result = await v1Request('GET', `/project-management/airt/prompts?${params.toString()}`, undefined, { tenantId });
    return Array.isArray(result) ? result : (result?.prompts || result?.data || []);
  } catch (err) {
    console.error('[seranking] getAIPrompts error:', err.message);
    return [];
  }
}

/**
 * Get all AI prompts across every enabled LLM engine for a project.
 * Convenience for our tenant-facing UI where "AI prompts" is a single
 * concept regardless of which engine they target.
 *
 * Returns array of { llm_id, engine_base_name, country_code, lang_code,
 * prompts: [...] }.
 */
export async function getAllAIPrompts(projectId, tenantId) {
  const engines = await listAIEngines(projectId, tenantId);
  if (!Array.isArray(engines) || engines.length === 0) return [];
  const results = await Promise.all(
    engines.map(async (e) => {
      const llmId = e.llm_id ?? e.id;
      const prompts = await getAIPrompts(projectId, llmId, {}, tenantId);
      return {
        llm_id: llmId,
        engine_base_name: e.base_name,
        country_code: e.country_code,
        lang_code: e.lang_code,
        region_name: e.region_name,
        prompts,
      };
    })
  );
  return results;
}

/**
 * Add one or more AI prompts under a specific LLM engine.
 *
 * Endpoint: POST /v1/project-management/airt/prompts?site_id={id}&llm_id={llmId}
 * Body: { prompts: ["prompt1", "prompt2"], group_id?: int }
 *
 * Returns 201 on success.
 *
 * @param {number|string} projectId
 * @param {number|string} llmId - which AI engine to add the prompt to
 * @param {Array<string>} prompts
 * @param {object} [opts] - { groupId?: number, tenantId? }
 */
export async function addAIPrompt(projectId, llmId, prompts, opts = {}) {
  const { groupId, tenantId } = opts;
  const list = (Array.isArray(prompts) ? prompts : [prompts])
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  if (list.length === 0) return null;
  const body = { prompts: list };
  if (groupId) body.group_id = Number(groupId);
  try {
    const result = await v1Request('POST', `/project-management/airt/prompts?site_id=${encodeURIComponent(projectId)}&llm_id=${encodeURIComponent(llmId)}`, body, { tenantId });
    return result || { added: list.length };
  } catch (err) {
    console.error('[seranking] addAIPrompt error:', err.message);
    return null;
  }
}

/**
 * Delete one or more AI prompts under a specific LLM engine.
 *
 * Endpoint: POST /v1/project-management/airt/prompts/delete?site_id={id}&llm_id={llmId}
 *           (yes, it's a POST with /delete suffix, not DELETE — per SE Ranking docs)
 * Body: { k2site_llm_ids: [int, int, ...] }
 *
 * Returns 204 on success.
 */
export async function removeAIPrompt(projectId, llmId, k2siteLlmIds, tenantId) {
  const ids = (Array.isArray(k2siteLlmIds) ? k2siteLlmIds : [k2siteLlmIds]).map(Number).filter(Boolean);
  if (ids.length === 0) return false;
  try {
    const result = await v1Request('POST', `/project-management/airt/prompts/delete?site_id=${encodeURIComponent(projectId)}&llm_id=${encodeURIComponent(llmId)}`, { k2site_llm_ids: ids }, { tenantId });
    return result !== null;
  } catch (err) {
    console.error('[seranking] removeAIPrompt error:', err.message);
    return false;
  }
}

/**
 * Get the model's answer for a tracked prompt on a specific date.
 *
 * Endpoint: GET /v1/project-management/airt/prompts/answer
 *           ?site_id={id}&llm_id={llmId}&k2site_llm_id={k}&date=YYYY-MM-DD
 *
 * Cost: 0 credits. Answer text retained for 30 days.
 *
 * Returns { text, sources, brands, organic_urls (AI Overview only) }.
 */
export async function getAIPromptAnswer(projectId, llmId, k2siteLlmId, date, tenantId) {
  if (!projectId || !llmId || !k2siteLlmId) return null;
  const params = new URLSearchParams({
    site_id: String(projectId),
    llm_id: String(llmId),
    k2site_llm_id: String(k2siteLlmId),
  });
  if (date) params.set('date', date);
  try {
    const result = await v1Request('GET', `/project-management/airt/prompts/answer?${params.toString()}`, undefined, { tenantId });
    return result || null;
  } catch (err) {
    console.error('[seranking] getAIPromptAnswer error:', err.message);
    return null;
  }
}

/**
 * Get prompt ranking history. Without `mode` returns per-prompt; with
 * `mode=groups` returns aggregated daily presence per prompt group.
 *
 * Endpoint: GET /v1/project-management/airt/prompts/rankings
 *           ?site_id={id}&llm_id={llmId}&date_from=&date_to=&limit=&offset=&group_ids[]=&mode=groups
 */
export async function getAIPromptRankings(projectId, llmId, opts = {}, tenantId) {
  if (!projectId || !llmId) return [];
  const params = new URLSearchParams({
    site_id: String(projectId),
    llm_id: String(llmId),
  });
  if (opts.dateFrom) params.set('date_from', opts.dateFrom);
  if (opts.dateTo) params.set('date_to', opts.dateTo);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  if (opts.mode) params.set('mode', opts.mode);
  if (Array.isArray(opts.groupIds)) {
    for (const g of opts.groupIds) params.append('group_ids[]', String(g));
  }
  try {
    const result = await v1Request('GET', `/project-management/airt/prompts/rankings?${params.toString()}`, undefined, { tenantId });
    return Array.isArray(result) ? result : (result?.rankings || []);
  } catch (err) {
    console.error('[seranking] getAIPromptRankings error:', err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// AIRT Prompt Groups (organize prompts within an LLM engine into folders)
// ---------------------------------------------------------------------------

/**
 * List prompt groups for a project's LLM engine.
 * Endpoint: GET /v1/project-management/airt-groups?site_id={id}&llm_id={llmId}
 */
export async function listAIPromptGroups(projectId, llmId, tenantId) {
  try {
    const result = await v1Request('GET', `/project-management/airt-groups?site_id=${encodeURIComponent(projectId)}&llm_id=${encodeURIComponent(llmId)}`, undefined, { tenantId });
    return Array.isArray(result) ? result : (result?.groups || []);
  } catch (err) {
    console.error('[seranking] listAIPromptGroups error:', err.message);
    return [];
  }
}

/**
 * Create a prompt group.
 * Endpoint: POST /v1/project-management/airt-groups?site_id={id}&llm_id={llmId}
 * Body: { group_name: string }
 */
export async function createAIPromptGroup(projectId, llmId, groupName, tenantId) {
  if (!groupName) return null;
  try {
    const result = await v1Request('POST', `/project-management/airt-groups?site_id=${encodeURIComponent(projectId)}&llm_id=${encodeURIComponent(llmId)}`, { group_name: String(groupName) }, { tenantId });
    return result || null;
  } catch (err) {
    console.error('[seranking] createAIPromptGroup error:', err.message);
    return null;
  }
}

/**
 * Move prompts to a different group.
 * Endpoint: POST /v1/project-management/airt-groups/move
 * Body: { k2site_llm_ids: [...], group_id: N }
 */
export async function moveAIPromptsToGroup(k2siteLlmIds, groupId, tenantId) {
  const ids = (Array.isArray(k2siteLlmIds) ? k2siteLlmIds : [k2siteLlmIds]).map(Number).filter(Boolean);
  if (ids.length === 0) return null;
  try {
    const result = await v1Request('POST', '/project-management/airt-groups/move', { k2site_llm_ids: ids, group_id: Number(groupId) }, { tenantId });
    return result;
  } catch (err) {
    console.error('[seranking] moveAIPromptsToGroup error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Backlink monitoring (auto-enables on first backlink added)
// ---------------------------------------------------------------------------

/**
 * List backlinks for a project.
 * Endpoint: GET /v1/project-management/backlinks?site_id={id}&limit=&offset=
 * Max limit: 1000.
 */
export async function listBacklinks(projectId, opts = {}, tenantId) {
  const params = new URLSearchParams({ site_id: String(projectId) });
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.offset) params.set('offset', String(opts.offset));
  try {
    const result = await v1Request('GET', `/project-management/backlinks?${params.toString()}`, undefined, { tenantId });
    return Array.isArray(result) ? result : (result?.backlinks || []);
  } catch (err) {
    console.error('[seranking] listBacklinks error:', err.message);
    return [];
  }
}

/**
 * Add a single backlink to monitor. Adding any backlink auto-enables
 * backlink monitoring on the project — there's no separate toggle.
 *
 * Endpoint: POST /v1/project-management/backlinks
 * Body: { site_id, url, price?, currency?, charge_period?, charge_start? }
 * charge_period enum: onetime | monthly | quarterly | 6months | year
 */
export async function addBacklink(projectId, url, opts = {}, tenantId) {
  if (!url) return null;
  const body = { site_id: Number(projectId), url };
  if (opts.price != null) body.price = Number(opts.price);
  if (opts.currency) body.currency = opts.currency;
  if (opts.chargePeriod) body.charge_period = opts.chargePeriod;
  if (opts.chargeStart) body.charge_start = opts.chargeStart;
  try {
    const result = await v1Request('POST', '/project-management/backlinks', body, { tenantId });
    return result || null;
  } catch (err) {
    console.error('[seranking] addBacklink error:', err.message);
    return null;
  }
}

/**
 * Toggle Google Search Console auto-import of backlinks.
 * Endpoint: PATCH /v1/project-management/backlinks/gsc/settings
 * Body: { site_id, gsc_autoimport: true|false }
 */
export async function setBacklinkGSCAutoimport(projectId, enabled, tenantId) {
  try {
    const result = await v1Request('PATCH', '/project-management/backlinks/gsc/settings', { site_id: Number(projectId), gsc_autoimport: !!enabled }, { tenantId });
    return result !== null;
  } catch (err) {
    console.error('[seranking] setBacklinkGSCAutoimport error:', err.message);
    return false;
  }
}

/**
 * Get backlink stats for a project.
 * Endpoint: GET /v1/project-management/backlinks/stats?site_id={id}
 */
export async function getBacklinkStats(projectId, tenantId) {
  try {
    const result = await v1Request('GET', `/project-management/backlinks/stats?site_id=${encodeURIComponent(projectId)}`, undefined, { tenantId });
    return result || null;
  } catch (err) {
    console.error('[seranking] getBacklinkStats error:', err.message);
    return null;
  }
}

/**
 * Legacy alias for setAITracking — now a thin wrapper over the proper
 * brand-set + per-engine enable flow. Kept so existing callers don't break.
 *
 * Returns { ok, applied: { [engineName]: llm_id }, errors }.
 *
 * @param {number|string} projectId
 * @param {object} flags - { aiMode, chatgpt, gemini, perplexity, aiOverview, brand?, country?, lang? }
 */
export async function setAITracking(projectId, flags, tenantId) {
  const errors = [];
  const applied = {};
  const country = flags.country || 'us';
  const lang = flags.lang || 'en';

  if (flags.brand) {
    const brandRes = await setAIBrand(projectId, flags.brand, tenantId);
    if (!brandRes) errors.push('setAIBrand failed — brand must be set before enabling engines');
  }

  const engineSpec = [
    ['google_ai_mode', flags.aiMode],
    ['google_ai_overview', flags.aiOverview],
    ['chatgpt', flags.chatgpt],
    ['gemini', flags.gemini],
    ['perplexity', flags.perplexity],
  ];

  for (const [baseName, want] of engineSpec) {
    if (!want) continue;
    const res = await enableAIEngine(projectId, { baseName, countryCode: country, langCode: lang }, tenantId);
    if (res && (res.llm_id || res.id)) {
      applied[baseName] = res.llm_id || res.id;
    } else {
      errors.push(`enableAIEngine failed for ${baseName}`);
    }
  }

  return { ok: errors.length === 0, applied, errors };
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
