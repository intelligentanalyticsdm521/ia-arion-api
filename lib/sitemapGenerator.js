/**
 * Sitemap Generator
 *
 * Fetches pages/posts from the WordPress REST API, generates an XML sitemap,
 * and submits sitemap URLs to Google Search Console and Bing Webmaster Tools.
 */

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchWithRetry(url, options = {}, attempt = 1) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    return res;
  } catch (err) {
    if (attempt < MAX_RETRIES && (!err.status || err.status >= 500)) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      return fetchWithRetry(url, options, attempt + 1);
    }
    throw err;
  }
}

/**
 * Paginate through a WP REST API collection endpoint.
 * Returns all items across all pages.
 */
async function fetchAllWpItems(baseUrl) {
  const items = [];
  let page = 1;
  while (true) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${sep}per_page=100&page=${page}&_fields=id,link,modified,slug`;
    let res;
    try {
      res = await fetchWithRetry(url);
    } catch (err) {
      // If first page fails it's a real error; subsequent pages may 400 when past last page
      if (page === 1) throw err;
      break;
    }
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    items.push(...data);
    const totalPages = parseInt(res.headers.get('x-wp-totalpages') || '1', 10);
    if (page >= totalPages) break;
    page++;
  }
  return items;
}

// ---------------------------------------------------------------------------
// 1. Fetch all pages/posts from WP REST API
// ---------------------------------------------------------------------------

/**
 * Fetch all published pages and posts from a WordPress site.
 * @param {string} domain - The domain (e.g. "example.com")
 * @returns {Promise<Array<{url: string, lastmod: string, changefreq: string, priority: number}>>}
 */
export async function fetchWordPressPages(domain) {
  const base = `https://${domain}/wp-json/wp/v2`;

  const [pages, posts] = await Promise.all([
    fetchAllWpItems(`${base}/pages`).catch(err => {
      console.warn('[sitemapGenerator] Failed to fetch pages:', err.message);
      return [];
    }),
    fetchAllWpItems(`${base}/posts`).catch(err => {
      console.warn('[sitemapGenerator] Failed to fetch posts:', err.message);
      return [];
    }),
  ]);

  const urls = [];

  // Homepage gets priority 1.0
  const homepageUrl = `https://${domain}/`;
  urls.push({
    url: homepageUrl,
    lastmod: new Date().toISOString().split('T')[0],
    changefreq: 'daily',
    priority: 1.0,
  });

  for (const p of pages) {
    const link = p.link || `https://${domain}/${p.slug}/`;
    // Skip if it's the homepage (already added)
    if (link.replace(/\/$/, '') === homepageUrl.replace(/\/$/, '')) continue;
    urls.push({
      url: link,
      lastmod: p.modified ? p.modified.split('T')[0] : new Date().toISOString().split('T')[0],
      changefreq: 'weekly',
      priority: 0.8,
    });
  }

  for (const p of posts) {
    const link = p.link || `https://${domain}/${p.slug}/`;
    urls.push({
      url: link,
      lastmod: p.modified ? p.modified.split('T')[0] : new Date().toISOString().split('T')[0],
      changefreq: 'monthly',
      priority: 0.6,
    });
  }

  return urls;
}

// ---------------------------------------------------------------------------
// 2. Generate XML sitemap string
// ---------------------------------------------------------------------------

/**
 * Generate a standards-compliant XML sitemap string.
 * @param {Array<{url: string, lastmod: string, changefreq: string, priority: number}>} urls
 * @returns {string}
 */
export function generateSitemapXml(urls) {
  const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  const entries = urls.map(u => [
    '  <url>',
    `    <loc>${escapeXml(u.url)}</loc>`,
    u.lastmod ? `    <lastmod>${escapeXml(u.lastmod)}</lastmod>` : '',
    u.changefreq ? `    <changefreq>${escapeXml(u.changefreq)}</changefreq>` : '',
    u.priority != null ? `    <priority>${u.priority.toFixed(1)}</priority>` : '',
    '  </url>',
  ].filter(Boolean).join('\n')).join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    entries,
    '</urlset>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 3. Detect existing sitemap URL
// ---------------------------------------------------------------------------

/**
 * Check common sitemap locations and return the first one that exists.
 * @param {string} domain
 * @returns {Promise<string|null>}
 */
export async function detectSitemapUrl(domain) {
  const candidates = [
    `https://${domain}/sitemap_index.xml`,
    `https://${domain}/sitemap.xml`,
    `https://${domain}/sitemap_index.xml`, // Rank Math
    `https://${domain}/wp-sitemap.xml`,    // WP core
  ];

  // Deduplicate
  const unique = [...new Set(candidates)];

  for (const url of unique) {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
      if (res.ok) return url;
    } catch {
      // continue to next candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 4. Submit to Google Search Console
// ---------------------------------------------------------------------------

/**
 * Submit a sitemap URL to Google Search Console.
 * @param {string} accessToken - OAuth2 access token
 * @param {string} siteUrl     - The site URL registered in GSC (e.g. "https://example.com")
 * @param {string} sitemapUrl  - The full sitemap URL
 * @returns {Promise<{submitted: boolean, error?: string}>}
 */
export async function submitToGoogle(accessToken, siteUrl, sitemapUrl) {
  const encodedSite = encodeURIComponent(siteUrl);
  const encodedSitemap = encodeURIComponent(sitemapUrl);
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodedSite}/sitemaps/${encodedSitemap}`;

  try {
    const res = await fetchWithRetry(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    // Google returns 204 on success, or 200
    return { submitted: true };
  } catch (err) {
    console.error('[sitemapGenerator] Google sitemap submission failed:', err.message);
    return { submitted: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// 5. Submit to Bing Webmaster Tools
// ---------------------------------------------------------------------------

/**
 * Submit a sitemap URL to Bing Webmaster Tools.
 * @param {string} apiKey     - Bing Webmaster API key
 * @param {string} siteUrl    - The site URL (e.g. "https://example.com")
 * @param {string} sitemapUrl - The full sitemap URL
 * @returns {Promise<{submitted: boolean, error?: string}>}
 */
export async function submitToBing(apiKey, siteUrl, sitemapUrl) {
  const params = new URLSearchParams({ siteUrl, feedpath: sitemapUrl, apikey: apiKey });
  const url = `https://ssl.bing.com/webmaster/api.svc/json/SubmitSitemap?${params}`;

  try {
    const res = await fetchWithRetry(url, { method: 'GET' });
    return { submitted: true };
  } catch (err) {
    console.error('[sitemapGenerator] Bing sitemap submission failed:', err.message);
    return { submitted: false, error: err.message };
  }
}
