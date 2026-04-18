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
