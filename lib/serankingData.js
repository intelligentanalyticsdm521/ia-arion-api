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
const DATA_KEY = process.env.SERANKING_DATA_API_KEY;

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

export function clearDataCache() { cache.clear(); }
