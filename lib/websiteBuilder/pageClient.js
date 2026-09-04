/**
 * Page transport — the ARION side of the IA plugin's site-builder routes.
 * ---------------------------------------------------------------------------
 * Auth is the SITE TOKEN, exactly as the write path already uses it
 * (`buildPluginAuth` -> `X-Arion-Site-Token`). That is decision W-2: the token
 * is present and working on all five prod sites, while `wp_app_password_ref`
 * is NULL on all five, so riding the token unblocks the editor with no
 * credential programme (SCOPE §3.4).
 *
 * Plugin routes used (IA plugin >= 1.5.0):
 *   GET  /pages
 *   GET  /pages/:id/sections
 *   POST /pages/:id/sections      (snapshot + write, via the existing writer)
 *   POST /pages/:id/undo
 *   POST /pages                   (new page, born draft)
 *   POST /media/sideload
 *
 * Every function returns a plain result object and NEVER throws, and never
 * reports success on a failed call — `reference_catch_swallow_report_success`
 * is the recurring bug this file must not add a fourteenth instance to.
 */

import { buildPluginAuth, resolveSiteHost, resolveSiteBaseUrl } from '../pluginClient.js';

const NAMESPACE = '/wp-json/intelligent-analytics/v1';
const READ_TIMEOUT_MS = 20_000;
const WRITE_TIMEOUT_MS = 45_000;

/** The plugin build that first answers these routes. */
export const MIN_PLUGIN_VERSION = '1.5.0';

function fail(reason, extra = {}) {
  return { ok: false, status: 0, data: null, error: reason, ...extra };
}

/**
 * One request to the plugin. `fetchImpl` is injectable so route tests never
 * open a socket.
 */
async function call(site, { method, path, body, timeoutMs, fetchImpl }) {
  const impl = fetchImpl || globalThis.fetch;
  if (typeof impl !== 'function') return fail('no_fetch_impl');

  const host = resolveSiteHost(site);
  if (!host) return fail('no_domain_for_site', { pluginStatus: 'unreachable' });

  const auth = buildPluginAuth(site);
  if (!auth.ok) {
    return fail('site_not_connected', {
      pluginStatus: 'token_invalid',
      message: 'This website is not connected to your account yet.',
    });
  }

  // LiteSpeed caches /wp-json on every ARION site. The header alone is not
  // enough on a response the edge already holds, so every read carries a URL
  // it has never seen (reference_arion_plugin_release).
  const sep = path.includes('?') ? '&' : '?';
  const url = `${resolveSiteBaseUrl(site)}${NAMESPACE}${path}${sep}_ia_cb=${Date.now()}`;

  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || READ_TIMEOUT_MS);
    res = await impl(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...auth.headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    return fail(err?.name === 'AbortError' ? 'timeout' : 'unreachable', {
      pluginStatus: err?.name === 'AbortError' ? 'timeout' : 'unreachable',
      message: 'We could not reach your website just now.',
      detail: err?.message,
    });
  }

  const text = await res.text().catch(() => '');
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }

  if (!res.ok) {
    const notFound = res.status === 404;
    const unauthorised = res.status === 401 || res.status === 403;
    return {
      ok: false,
      status: res.status,
      data: parsed,
      pluginStatus: unauthorised ? 'token_invalid' : 'error',
      error: unauthorised ? 'site_not_connected'
        : notFound ? 'not_found'
        : 'plugin_rejected',
      message: unauthorised
        ? 'Your website did not accept the connection. Reconnect it and try again.'
        : (parsed?.error || parsed?.message || `Your website answered with an error (${res.status}).`),
    };
  }

  return { ok: true, status: res.status, data: parsed?.data ?? parsed ?? {} };
}

/** Every page and post on the site, drafts included. */
export function fetchPages(site, opts = {}) {
  return call(site, { method: 'GET', path: '/pages', fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}

/** One page's Elementor tree, already reduced to a section list by the plugin. */
export function fetchPageSections(site, pageId, opts = {}) {
  return call(site, {
    method: 'GET',
    path: `/pages/${encodeURIComponent(pageId)}/sections`,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * Write the section list back. The plugin snapshots the previous
 * `_elementor_data` before it touches anything, then re-emits through its own
 * existing writer.
 */
export function writePageSections(site, pageId, payload, opts = {}) {
  return call(site, {
    method: 'POST',
    path: `/pages/${encodeURIComponent(pageId)}/sections`,
    body: payload,
    timeoutMs: opts.timeoutMs || WRITE_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
}

/** Put the previous version back. One tap, one step. */
export function undoPage(site, pageId, opts = {}) {
  return call(site, {
    method: 'POST',
    path: `/pages/${encodeURIComponent(pageId)}/undo`,
    body: {},
    timeoutMs: opts.timeoutMs || WRITE_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
}

/** A new page is always born a draft (W-3). */
export function createPage(site, payload, opts = {}) {
  return call(site, {
    method: 'POST',
    path: '/pages',
    body: { ...payload, status: 'draft' },
    timeoutMs: opts.timeoutMs || WRITE_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
}

/** Put a picture in the site's own media library and get its URL back. */
export function sideloadMedia(site, payload, opts = {}) {
  return call(site, {
    method: 'POST',
    path: '/media/sideload',
    body: payload,
    timeoutMs: opts.timeoutMs || WRITE_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
}

/**
 * The site's own picture library, a page at a time (IA plugin >= 1.6.0).
 * The picker asks for one page and one search term; it never pulls the whole
 * library, because a library is the one thing on a WordPress site that can be
 * arbitrarily large.
 */
export function listMedia(site, { page = 1, perPage = 24, search = '' } = {}, opts = {}) {
  const qs = new URLSearchParams();
  qs.set('page', String(Math.max(1, Number(page) || 1)));
  qs.set('per_page', String(Math.min(60, Math.max(1, Number(perPage) || 24))));
  if (search) qs.set('search', String(search).slice(0, 120));
  return call(site, {
    method: 'GET',
    path: `/media?${qs.toString()}`,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

/** Describe a picture, once, on the attachment itself. */
export function setMediaAlt(site, attachmentId, alt, opts = {}) {
  return call(site, {
    method: 'POST',
    path: `/media/${encodeURIComponent(attachmentId)}/alt`,
    body: { alt: String(alt == null ? '' : alt) },
    timeoutMs: opts.timeoutMs || WRITE_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
}

/**
 * Tell the site where its "Book now" button should point (Ops B6).
 * ARION owns the answer — does this tenant own OLIVER, is there an active
 * booking page — and the site stores it so the shortcode and the header menu
 * render with no round trip. An EMPTY url is a meaningful push: it takes the
 * button off a site whose booking page has gone away.
 */
export function pushBookingConfig(site, { bookingUrl = '' } = {}, opts = {}) {
  return call(site, {
    method: 'POST',
    path: '/booking-config',
    body: { booking_url: String(bookingUrl || '') },
    timeoutMs: opts.timeoutMs || READ_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
}

export const __test__ = { NAMESPACE };
