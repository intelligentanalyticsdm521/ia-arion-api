// lib/audit/crawl.js
//
// Read the website: robots.txt first, then the home page and up to 9 more
// pages of the SAME host (10 pages in all — "homepage plus at most 10" in the
// contract and "10 pages max" in the task both hold), breadth-first from the
// home page's links. Then a status check on up to 30 internal links, the
// http -> https redirect, and the sitemap.
//
// Every request goes through the injected `fetch` (lib/audit/safeFetch.js in
// real use), so the SSRF guard applies to every hop of every request, and the
// tests can hand in a fake.
//
// The whole crawl has a deadline (60 s by default). When it passes we stop
// reading more pages and score what we have.

import { pageChecks, anchorsOf, securityHeaderChecks, contactChecks } from './checks.js';
import { fetchRobots, isAllowed, disallowsEverything } from './robots.js';

export const MAX_PAGES = 10;
export const MAX_LINK_CHECKS = 30;
export const CRAWL_MS = 60_000;

const ASSET_RE = /\.(?:jpe?g|png|gif|webp|svg|ico|bmp|tiff?|pdf|zip|gz|rar|7z|css|js|mjs|json|xml|txt|mp4|mov|webm|mp3|wav|ogg|woff2?|ttf|eot|otf|docx?|xlsx?|pptx?|csv|exe|dmg|apk)$/i;

/** What a visitor typed ("example.com", "https://www.Example.com/") -> a URL string. */
export function normaliseSiteUrl(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s.replace(/^\/+/, '')}`;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname || !(u.hostname.includes('.') || u.hostname === 'localhost' || u.hostname.startsWith('['))) return null;
  u.hash = '';
  return u.href;
}

/** lower(host)+path without a trailing slash: one audit per this per caller per day. */
export function urlKey(url) {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.host.toLowerCase()}${path}`.slice(0, 300);
}

const pageKey = (u) => `${u.origin}${u.pathname.replace(/\/+$/, '') || ''}`;

function internalUrl(href, base, host) {
  if (!href || /^(?:mailto|tel|javascript|data|sms|ftp):/i.test(href) || href.startsWith('#')) return null;
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.host.toLowerCase() !== host) return null;
  if (ASSET_RE.test(u.pathname)) return null;
  if (/\/wp-(?:admin|login|json)\b/i.test(u.pathname) || /\/feed\/?$/i.test(u.pathname)) return null;
  u.hash = '';
  return u;
}

const pathWithQuery = (u) => `${u.pathname}${u.search}`;

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  }
  return out;
}

/**
 * @param {string} startUrl  already normalised
 * @param {object} o
 * @param {(url: string, opts?: object) => Promise<{status, headers, body: Buffer, url: string}>} o.fetch
 * @param {number} [o.deadline]  epoch ms after which no new page is read
 */
export async function crawl(startUrl, { fetch, deadline = Date.now() + CRAWL_MS, maxPages = MAX_PAGES, maxLinkChecks = MAX_LINK_CHECKS } = {}) {
  const start = new URL(startUrl);
  const robots = await fetchRobots(start.origin, fetch);
  // The site asks us not to read its home page, or the very page we were
  // given (a start address under a Disallow rule): read no page content.
  const blocked = disallowsEverything(robots) || !isAllowed(robots, pathWithQuery(start));

  const result = {
    startUrl: start.href,
    finalUrl: start.href,
    robots: { present: robots.present, blocked, sitemaps: robots.sitemaps.slice(0, 5) },
    homepage: null,
    pages: [],
    linkChecks: { checked: 0, broken: [] },
    httpsRedirect: null,
    sitemapPresent: robots.sitemaps.length > 0,
    stoppedEarly: false,
  };

  if (blocked) {
    // We do not read the pages. A HEAD of the home page still tells us whether
    // it is served securely — the response headers, not the content.
    const head = await fetch(start.href, { method: 'HEAD' });
    result.finalUrl = head.url || start.href;
    result.homepage = { status: head.status, security: securityHeaderChecks(head.headers), https: new URL(result.finalUrl).protocol === 'https:' };
  } else {
    const home = await fetch(start.href, { htmlOnly: true });
    if (home.status >= 400) {
      const err = new Error(`home page answered ${home.status}`);
      err.code = 'home_status';
      err.status = home.status;
      throw err;
    }
    const html = home.body.toString('utf8');
    result.finalUrl = home.url || start.href;
    const finalU = new URL(result.finalUrl);
    const host = finalU.host.toLowerCase();
    result.homepage = {
      status: home.status,
      security: securityHeaderChecks(home.headers),
      https: finalU.protocol === 'https:',
      contact: contactChecks(html),
    };
    result.pages.push({ url: result.finalUrl, status: home.status, checks: pageChecks(html) });

    const seen = new Set([pageKey(finalU), pageKey(start)]);
    const discovered = new Map(); // pageKey -> URL (every internal link, for the link check)
    const statusByKey = new Map([[pageKey(finalU), home.status]]);
    const queue = [];
    const enqueueFrom = (pageHtml, base) => {
      for (const a of anchorsOf(pageHtml)) {
        const u = internalUrl(a.href, base, host);
        if (!u) continue;
        const k = pageKey(u);
        if (!discovered.has(k)) discovered.set(k, u);
        if (seen.has(k) || !isAllowed(robots, pathWithQuery(u))) continue;
        seen.add(k);
        queue.push(u);
      }
    };
    enqueueFrom(html, result.finalUrl);

    while (queue.length && result.pages.length < maxPages) {
      if (Date.now() > deadline) { result.stoppedEarly = true; break; }
      const u = queue.shift();
      try {
        const res = await fetch(u.href, { htmlOnly: true });
        statusByKey.set(pageKey(u), res.status);
        if (res.status >= 200 && res.status < 300) {
          const pageHtml = res.body.toString('utf8');
          result.pages.push({ url: u.href, status: res.status, checks: pageChecks(pageHtml) });
          enqueueFrom(pageHtml, u.href);
        }
      } catch (err) {
        // A page that is not HTML, too big or slow is skipped, not counted as broken.
        statusByKey.set(pageKey(u), null);
      }
    }

    // Link check: at most 30 internal links. Already-read pages reuse their status.
    const toCheck = [...discovered.entries()]
      .filter(([, u]) => isAllowed(robots, pathWithQuery(u)))
      .slice(0, maxLinkChecks);
    const statuses = await inBatches(toCheck, 5, async ([k, u]) => {
      if (statusByKey.has(k) && statusByKey.get(k) != null) return [u.href, statusByKey.get(k)];
      if (Date.now() > deadline) return [u.href, null];
      try {
        let res = await fetch(u.href, { method: 'HEAD' });
        if (res.status === 405 || res.status === 501) res = await fetch(u.href, { maxBytes: 256 * 1024 });
        return [u.href, res.status];
      } catch {
        return [u.href, null]; // could not check: not counted either way
      }
    });
    result.linkChecks.checked = statuses.filter(([, s]) => s != null).length;
    result.linkChecks.broken = statuses.filter(([, s]) => s != null && s >= 400).map(([href]) => href);
  }

  // http -> https: ask for the plain-http home page and read where it sends us.
  try {
    const plain = new URL(result.finalUrl);
    plain.protocol = 'http:';
    const res = await fetch(plain.href, { method: 'HEAD', maxRedirects: 0 });
    const loc = res.headers.location ? new URL(res.headers.location, plain.href) : null;
    result.httpsRedirect = Boolean(res.status >= 300 && res.status < 400 && loc && loc.protocol === 'https:');
  } catch {
    result.httpsRedirect = null; // could not tell
  }

  // Robots said no: the sitemap is not fetched either (only a robots Sitemap: line counts).
  if (!result.sitemapPresent && !blocked) {
    try {
      const sm = await fetch(`${new URL(result.finalUrl).origin}/sitemap.xml`, { method: 'HEAD' });
      result.sitemapPresent = sm.status >= 200 && sm.status < 300;
    } catch {
      result.sitemapPresent = false;
    }
  }
  return result;
}

export default { crawl, normaliseSiteUrl, urlKey, MAX_PAGES, MAX_LINK_CHECKS };
