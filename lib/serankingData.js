/**
 * SE Ranking Data API Client (keyword research / volumes / difficulty / cpc)
 * Base URL: https://api.seranking.com/v1
 * Auth: Token header from SERANKING_DATA_API_KEY env var
 *
 * IMPORTANT: This is a SEPARATE key and endpoint from the Project API
 * (api4.seranking.com). Using the wrong key = silent 401.
 *
 * Only called from Phase 3+ features that need search volume/difficulty
 * enrichment. Basic ranking data comes from the Project API.
 */

const DATA_BASE = process.env.SERANKING_DATA_API_BASE || 'https://api.seranking.com/v1';
// Accept both naming conventions. Azure Key Vault secret is named
// SE-RANKING-DATA-API-KEY (with dashes); some App Service setups map it
// to process.env with dashes preserved, others normalize to underscores.
const DATA_KEY = process.env.SERANKING_DATA_API_KEY
  || process.env['SE-RANKING-DATA-API-KEY']
  || process.env.SE_RANKING_DATA_API_KEY;

// 60-minute cache — keyword volume/difficulty move slowly, don't hammer the API.
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return undefined; }
  return entry.value;
}
function cacheSet(key, value) { cache.set(key, { value, ts: Date.now() }); }

async function dataRequest(method, path, body = undefined, attempt = 1) {
  if (!DATA_KEY) {
    console.error('[serankingData] SERANKING_DATA_API_KEY is not set');
    return null;
  }
  const cacheKey = `${method}:${path}:${body ? JSON.stringify(body) : ''}`;
  if (method === 'GET') {
    const cached = cacheGet(cacheKey);
    if (cached !== undefined) return cached;
  }
  const url = `${DATA_BASE}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Token ${DATA_KEY}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => null);
    if (method === 'GET' && data !== null) cacheSet(cacheKey, data);
    return data;
  } catch (err) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
      return dataRequest(method, path, body, attempt + 1);
    }
    console.error(`[serankingData] ${method} ${path} failed:`, err.message);
    return null;
  }
}

/**
 * Get keyword volume / difficulty / CPC data for one or more keywords.
 * SE Ranking Data API: POST /research/{source}/overview or /keywords/overview
 * Returns: [{ keyword, volume, difficulty, cpc, competition }]
 *
 * @param {string[]} keywords
 * @param {string} [regionId] - SE Ranking region code, default "us"
 */
export async function getKeywordData(keywords, regionId = 'us') {
  if (!Array.isArray(keywords) || keywords.length === 0) return [];
  // SE Ranking Data API expects GET /keywords/overview?source=us&keywords[]=kw1&keywords[]=kw2
  const params = new URLSearchParams();
  params.set('source', regionId);
  for (const kw of keywords.slice(0, 100)) params.append('keywords[]', kw);
  const result = await dataRequest('GET', `/keywords/overview?${params.toString()}`);
  if (!Array.isArray(result)) return [];
  return result.map((row) => ({
    keyword: row.keyword || row.name || '',
    volume: Number(row.volume ?? row.search_volume ?? 0),
    difficulty: Number(row.difficulty ?? row.kei ?? 0),
    cpc: Number(row.cpc ?? 0),
    competition: Number(row.competition ?? 0),
  }));
}

// ---------------------------------------------------------------------------
// Keyword research methods (Phase: SE Ranking productization 2026-06-17)
// ---------------------------------------------------------------------------

/**
 * Get keyword suggestions (similar / related queries) for a seed keyword.
 * SE Ranking Data API: GET /research/keywords/similar?source=<region>&keyword=<seed>
 *
 * Returns an array of { keyword, volume, difficulty, cpc } objects.
 * Falls back to empty array on error.
 *
 * @param {string} seed - the source keyword
 * @param {string} [regionId] - default 'us'
 * @param {number} [limit] - default 50
 */
export async function getKeywordSuggestions(seed, regionId = 'us', limit = 50) {
  if (!seed || typeof seed !== 'string') return [];
  const params = new URLSearchParams();
  params.set('source', regionId);
  params.set('keyword', seed.trim());
  params.set('limit', String(limit));
  const result = await dataRequest('GET', `/research/keywords/similar?${params.toString()}`);
  return Array.isArray(result) ? normalizeKeywordRows(result) : [];
}

/**
 * Get related keywords for a seed keyword (semantically related, not just SERP-overlap).
 * SE Ranking Data API: GET /research/keywords/related?source=<region>&keyword=<seed>
 *
 * @param {string} seed
 * @param {string} [regionId]
 * @param {number} [limit]
 */
export async function getRelatedKeywords(seed, regionId = 'us', limit = 50) {
  if (!seed || typeof seed !== 'string') return [];
  const params = new URLSearchParams();
  params.set('source', regionId);
  params.set('keyword', seed.trim());
  params.set('limit', String(limit));
  const result = await dataRequest('GET', `/research/keywords/related?${params.toString()}`);
  return Array.isArray(result) ? normalizeKeywordRows(result) : [];
}

/**
 * Get longtail keyword variants (3+ word combinations from the seed).
 * SE Ranking Data API: GET /research/keywords/longtail?source=<region>&keyword=<seed>
 */
export async function getLongtailKeywords(seed, regionId = 'us', limit = 50) {
  if (!seed || typeof seed !== 'string') return [];
  const params = new URLSearchParams();
  params.set('source', regionId);
  params.set('keyword', seed.trim());
  params.set('limit', String(limit));
  const result = await dataRequest('GET', `/research/keywords/longtail?${params.toString()}`);
  return Array.isArray(result) ? normalizeKeywordRows(result) : [];
}

/**
 * Get question-style keyword variants (how/what/why/when/where/who).
 * SE Ranking Data API: GET /research/keywords/questions?source=<region>&keyword=<seed>
 */
export async function getQuestionKeywords(seed, regionId = 'us', limit = 50) {
  if (!seed || typeof seed !== 'string') return [];
  const params = new URLSearchParams();
  params.set('source', regionId);
  params.set('keyword', seed.trim());
  params.set('limit', String(limit));
  const result = await dataRequest('GET', `/research/keywords/questions?${params.toString()}`);
  return Array.isArray(result) ? normalizeKeywordRows(result) : [];
}

/**
 * Bundle all 4 research dimensions into a single response.
 * Useful for the Portal keyword research wizard.
 *
 * @param {string} seed
 * @param {object} [opts] - { regionId, limit }
 * @returns {Promise<{ overview: object, suggestions: array, related: array, longtail: array, questions: array }>}
 */
export async function researchKeyword(seed, opts = {}) {
  const { regionId = 'us', limit = 25 } = opts;
  const [overview, suggestions, related, longtail, questions] = await Promise.all([
    getKeywordData([seed], regionId).then((rows) => rows[0] || null).catch(() => null),
    getKeywordSuggestions(seed, regionId, limit).catch(() => []),
    getRelatedKeywords(seed, regionId, limit).catch(() => []),
    getLongtailKeywords(seed, regionId, limit).catch(() => []),
    getQuestionKeywords(seed, regionId, limit).catch(() => []),
  ]);
  return { seed, overview, suggestions, related, longtail, questions };
}

function normalizeKeywordRows(rows) {
  return rows.map((row) => ({
    keyword: row.keyword || row.name || '',
    volume: Number(row.volume ?? row.search_volume ?? 0),
    difficulty: Number(row.difficulty ?? row.kei ?? 0),
    cpc: Number(row.cpc ?? 0),
    competition: Number(row.competition ?? 0),
  }));
}

export function clearDataCache() { cache.clear(); }
