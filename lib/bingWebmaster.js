/**
 * Bing Webmaster Tools API Client
 * Base URL: https://ssl.bing.com/webmaster/api.svc/json
 * Auth: API key passed as query param `apikey`
 *
 * Features: retry (3x with exponential backoff), error handling
 */

const BING_WMT_BASE = 'https://ssl.bing.com/webmaster/api.svc/json';

// ---------------------------------------------------------------------------
// Core request helper
// ---------------------------------------------------------------------------

/**
 * Make a request to the Bing Webmaster Tools API with retry logic.
 * @param {string} method   - HTTP method (GET or POST)
 * @param {string} path     - API path (e.g. "/GetQueryStats")
 * @param {string} apiKey   - Bing Webmaster API key
 * @param {object} [params] - Query parameters (added to URL)
 * @param {object} [body]   - JSON body for POST requests
 * @param {number} [attempt=1]
 * @returns {Promise<object|null>}
 */
async function request(method, path, apiKey, params = {}, body = undefined, attempt = 1) {
  if (!apiKey) {
    console.error('[bingWebmaster] No API key provided');
    return null;
  }

  const qs = new URLSearchParams({ ...params, apikey: apiKey });
  const url = `${BING_WMT_BASE}${path}?${qs}`;
  const headers = { 'Content-Type': 'application/json' };

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

    return await res.json().catch(() => null);
  } catch (err) {
    if (attempt < 3) {
      const delay = 2 ** attempt * 500; // 1s, 2s
      await new Promise((r) => setTimeout(r, delay));
      return request(method, path, apiKey, params, body, attempt + 1);
    }

    console.error(`[bingWebmaster] ${method} ${path} failed after 3 attempts:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public methods
// ---------------------------------------------------------------------------

/**
 * Get query-level traffic (search analytics) data for a site.
 * @param {string} apiKey  - Bing Webmaster API key
 * @param {string} siteUrl - The site URL registered in Bing Webmaster Tools
 * @param {number} [days=28] - Not used by API directly but kept for interface parity
 * @returns {Promise<object|null>}
 */
export async function getTrafficData(apiKey, siteUrl, days = 28) {
  try {
    return await request('GET', '/GetQueryStats', apiKey, { siteUrl });
  } catch (err) {
    console.error('[bingWebmaster] getTrafficData error:', err.message);
    return null;
  }
}

/**
 * Get page-level traffic stats for a site.
 * @param {string} apiKey  - Bing Webmaster API key
 * @param {string} siteUrl - The site URL
 * @returns {Promise<object|null>}
 */
export async function getPageTrafficData(apiKey, siteUrl) {
  try {
    return await request('GET', '/GetPageStats', apiKey, { siteUrl });
  } catch (err) {
    console.error('[bingWebmaster] getPageTrafficData error:', err.message);
    return null;
  }
}

/**
 * Get sitemaps submitted for a site.
 * @param {string} apiKey  - Bing Webmaster API key
 * @param {string} siteUrl - The site URL
 * @returns {Promise<Array<object>|null>}
 */
export async function getSitemaps(apiKey, siteUrl) {
  try {
    return await request('GET', '/GetSitemaps', apiKey, { siteUrl });
  } catch (err) {
    console.error('[bingWebmaster] getSitemaps error:', err.message);
    return null;
  }
}

/**
 * Submit a URL for indexing.
 * @param {string} apiKey  - Bing Webmaster API key
 * @param {string} siteUrl - The site URL
 * @param {string} url     - The specific URL to submit
 * @returns {Promise<object|null>}
 */
export async function submitUrl(apiKey, siteUrl, url) {
  try {
    return await request('POST', '/SubmitUrl', apiKey, { siteUrl }, { siteUrl, url });
  } catch (err) {
    console.error('[bingWebmaster] submitUrl error:', err.message);
    return null;
  }
}

/**
 * Get URL submission quota for a site.
 * @param {string} apiKey  - Bing Webmaster API key
 * @param {string} siteUrl - The site URL
 * @returns {Promise<object|null>}
 */
export async function getUrlSubmissionQuota(apiKey, siteUrl) {
  try {
    return await request('GET', '/GetUrlSubmissionQuota', apiKey, { siteUrl });
  } catch (err) {
    console.error('[bingWebmaster] getUrlSubmissionQuota error:', err.message);
    return null;
  }
}

/**
 * Get crawl statistics for a site.
 * @param {string} apiKey  - Bing Webmaster API key
 * @param {string} siteUrl - The site URL
 * @returns {Promise<object|null>}
 */
export async function getCrawlStats(apiKey, siteUrl) {
  try {
    return await request('GET', '/GetCrawlStats', apiKey, { siteUrl });
  } catch (err) {
    console.error('[bingWebmaster] getCrawlStats error:', err.message);
    return null;
  }
}

/**
 * Get Bing's info about a specific URL — HTTP code, discovered date, last crawl, size.
 * @param {string} apiKey  - Bing Webmaster API key
 * @param {string} siteUrl - The site URL registered in Bing Webmaster Tools
 * @param {string} url     - The specific URL to query
 * @returns {Promise<object|null>}
 */
export async function getUrlInfo(apiKey, siteUrl, url) {
  try {
    return await request('GET', '/GetUrlInfo', apiKey, { siteUrl, url });
  } catch (err) {
    console.error('[bingWebmaster] getUrlInfo error:', err.message);
    return null;
  }
}

/**
 * Verify an API key by listing the sites it has access to.
 * Returns { valid, sites, siteMatches } where siteMatches is the first entry
 * whose Url contains the provided siteHost. Bing accepts url variations
 * (http/https, www/non-www) — we treat any match as success.
 *
 * Instead of using the shared request() helper we call Bing directly so we
 * can distinguish (a) invalid-key errors from (b) network errors, and
 * return a structured result.
 */
export async function verifyKey(apiKey, siteHost) {
  if (!apiKey) return { valid: false, error: 'missing_key' };
  const url = `${BING_WMT_BASE}/GetUserSites?apikey=${encodeURIComponent(apiKey)}`;
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'Content-Type': 'application/json' } });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      if (text && /InvalidApiKey/i.test(text)) return { valid: false, error: 'invalid_key' };
      return { valid: false, error: `HTTP ${res.status}`, body: text.slice(0, 200) };
    }
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-json */ }
    if (!data) return { valid: false, error: 'invalid_response' };
    // Bing SDK wraps the array under `d` in some cases
    const sites = Array.isArray(data?.d) ? data.d : Array.isArray(data) ? data : (data?.sites || []);
    if (!Array.isArray(sites)) return { valid: false, error: 'no_sites_in_response' };
    const needleHost = (siteHost || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();
    const matched = sites.find(s => {
      const u = (s.Url || s.url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();
      return u === needleHost || u.endsWith('.' + needleHost) || needleHost.endsWith('.' + u) || u.includes(needleHost);
    }) || null;
    return { valid: true, sites, siteMatches: matched };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * Search performance summary + daily breakdown for a site. Uses GetRankAndTrafficStats
 * which returns a daily series of clicks / impressions / position.
 * CTR is computed client-side as (clicks / impressions) * 100 to match the GSC
 * convention (percentage-number). Position is Bing's avgPosition as returned.
 */
export async function getRankAndTrafficStats(apiKey, siteUrl, days = 30) {
  try {
    const raw = await request('GET', '/GetRankAndTrafficStats', apiKey, { siteUrl });
    const arr = Array.isArray(raw?.d) ? raw.d : Array.isArray(raw) ? raw : [];
    // Each entry: { Clicks, Impressions, AvgImpressionPosition, AvgClickPosition, Date: "/Date(ms)/" }
    const rows = arr.map(r => {
      const clicks = Number(r.Clicks || 0);
      const impressions = Number(r.Impressions || 0);
      const ctr = impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0;
      const position = r.AvgImpressionPosition != null ? Number(Number(r.AvgImpressionPosition).toFixed(2)) : (r.AvgClickPosition != null ? Number(Number(r.AvgClickPosition).toFixed(2)) : null);
      let date = null;
      const m = /\/Date\((\d+)\)\//.exec(r.Date || '');
      if (m) { date = new Date(Number(m[1])).toISOString().slice(0, 10); }
      return { date, clicks, impressions, ctr, position };
    }).filter(r => r.date);
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const recent = days > 0 ? rows.slice(-days) : rows;
    const totals = recent.reduce((acc, r) => {
      acc.clicks += r.clicks;
      acc.impressions += r.impressions;
      if (r.position != null) { acc.posSum += r.position; acc.posCount += 1; }
      return acc;
    }, { clicks: 0, impressions: 0, posSum: 0, posCount: 0 });
    const summary = {
      clicks: totals.clicks,
      impressions: totals.impressions,
      ctr: totals.impressions > 0 ? Number(((totals.clicks / totals.impressions) * 100).toFixed(2)) : 0,
      avgPosition: totals.posCount > 0 ? Number((totals.posSum / totals.posCount).toFixed(2)) : null,
    };
    return { summary, dailyBreakdown: recent };
  } catch (err) {
    console.error('[bingWebmaster] getRankAndTrafficStats error:', err.message);
    return null;
  }
}

/**
 * Top queries for a site. GetKeywordStats returns the top keywords Bing observed.
 * Bing's API returns { Broad, Clicks, Impressions, Position, Query, ... }
 */
export async function getKeywordStats(apiKey, siteUrl, limit = 25) {
  try {
    const raw = await request('GET', '/GetKeywordStats', apiKey, { q: '', country: '', language: '' });
    // GetKeywordStats sometimes requires additional params; fall back to GetQueryStats
    const first = Array.isArray(raw?.d) ? raw.d : Array.isArray(raw) ? raw : null;
    if (first && first.length > 0) {
      return first.slice(0, limit).map(mapQueryRow);
    }
    // Fallback: GetQueryStats (site-level query performance)
    const q = await request('GET', '/GetQueryStats', apiKey, { siteUrl });
    const rows = Array.isArray(q?.d) ? q.d : Array.isArray(q) ? q : [];
    return rows.slice(0, limit).map(mapQueryRow);
  } catch (err) {
    console.error('[bingWebmaster] getKeywordStats error:', err.message);
    return null;
  }
}

function mapQueryRow(r) {
  const clicks = Number(r.Clicks || 0);
  const impressions = Number(r.Impressions || 0);
  const ctr = impressions > 0 ? Number(((clicks / impressions) * 100).toFixed(2)) : 0;
  const position = r.Position != null ? Number(Number(r.Position).toFixed(2)) : null;
  return { query: r.Query || r.Keyword || '', clicks, impressions, ctr, avgPosition: position };
}
