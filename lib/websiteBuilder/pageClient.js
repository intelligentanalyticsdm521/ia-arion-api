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
/** The build that answers the ARION pack 1 routes at the bottom of this file. */
export const MIN_BUILDER_PLUGIN_VERSION = '1.7.3';
/** The build that answers the ARION pack 2 routes (menus, kit, chrome, options). */
export const MIN_SITE_PLUGIN_VERSION = '1.7.4';

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
      // Name the site and say how to move on: a business with several websites
      // read the bare sentence as "the page is broken" (walk fail 23 Sep,
      // register arion-not-connected-message-does-not-name-the-site).
      message: `${site?.domain || 'This website'} is not connected to your account yet. Pick another website in the dropdown at the top of the page, or finish connecting this one under Website → Overview.`,
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

/* ==========================================================================
 * ARION pack 1 (IA plugin >= 1.7.3) — the jobs that were wp-admin-only.
 *
 * Every one of these rides the same site token as everything above. The
 * alternative was core WordPress REST with `arion.site.wp_app_password_ref`,
 * which is NULL on all five production sites and has no writers anywhere in
 * the platform — so the routes built on it have never run once on a client
 * site (GAP_ANALYSIS_2026-09-08, ARION).
 * ======================================================================== */

/**
 * The site's own account of itself, including — from 1.7.3 — which Elementor
 * it is running (D-ARION-E). `lib/websiteBuilder/siteCapability.js` is the
 * only caller that matters; it reads the `elementor` block and refuses the
 * editor when the site says it has none.
 */
export function fetchStatus(site, opts = {}) {
  return call(site, { method: 'GET', path: '/status', fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}

/** A page's address, layout, parent and whether it is the home page. */
export function fetchPageSettings(site, pageId, opts = {}) {
  return call(site, {
    method: 'GET',
    path: `/pages/${encodeURIComponent(pageId)}/settings`,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * Change them. The plugin reads every value back before answering, so a 200
 * here means the website is actually holding what was asked for.
 */
export function writePageSettings(site, pageId, payload, opts = {}) {
  return call(site, {
    method: 'POST',
    path: `/pages/${encodeURIComponent(pageId)}/settings`,
    body: payload,
    timeoutMs: opts.timeoutMs || WRITE_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
}

/** The three SEO fields, from Rank Math's own post meta. */
export function fetchPageSeo(site, pageId, opts = {}) {
  return call(site, {
    method: 'GET',
    path: `/pages/${encodeURIComponent(pageId)}/seo`,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
}

export function writePageSeo(site, pageId, payload, opts = {}) {
  return call(site, {
    method: 'POST',
    path: `/pages/${encodeURIComponent(pageId)}/seo`,
    body: payload,
    timeoutMs: opts.timeoutMs || WRITE_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
}

/**
 * A preview WordPress itself renders (D-ARION-B): the candidate sections go
 * onto a companion draft and come back as a signed link that needs no
 * WordPress login. The page being previewed is not touched.
 */
export function previewPage(site, pageId, payload, opts = {}) {
  return call(site, {
    method: 'POST',
    path: `/pages/${encodeURIComponent(pageId)}/preview`,
    body: payload,
    timeoutMs: opts.timeoutMs || WRITE_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
}

/** Into the bin — WordPress keeps it for 30 days, so this is reversible. */
export function trashPage(site, pageId, opts = {}) {
  return call(site, {
    method: 'POST',
    path: `/pages/${encodeURIComponent(pageId)}/trash`,
    body: {},
    timeoutMs: opts.timeoutMs || WRITE_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
}

/** Back out of the bin, as a draft. */
export function restorePage(site, pageId, opts = {}) {
  return call(site, {
    method: 'POST',
    path: `/pages/${encodeURIComponent(pageId)}/restore`,
    body: {},
    timeoutMs: opts.timeoutMs || WRITE_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
}

/** Where a picture is used — the answer that decides whether delete is offered. */
export function fetchMediaUsage(site, attachmentId, opts = {}) {
  return call(site, {
    method: 'GET',
    path: `/media/${encodeURIComponent(attachmentId)}/usage`,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs || WRITE_TIMEOUT_MS,
  });
}

/** Only when the usage answer is nowhere; the plugin re-checks on the way in. */
export function deleteMedia(site, attachmentId, opts = {}) {
  return call(site, {
    method: 'DELETE',
    path: `/media/${encodeURIComponent(attachmentId)}`,
    timeoutMs: opts.timeoutMs || WRITE_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
}

/** New file, SAME attachment id, so every page using it updates at once. */
export function replaceMedia(site, attachmentId, payload, opts = {}) {
  return call(site, {
    method: 'POST',
    path: `/media/${encodeURIComponent(attachmentId)}/replace`,
    body: payload,
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

/**
 * Tell the site what the business's subscription lets it do on its own pages
 * (11 Oct 2026, "If you don't have the subscription you don't get any
 * features"). The plugin stores the two values as WordPress options:
 *
 *   ia_spark_capture  true only when SPARK is decided owned AND the site has at
 *                     least one form switched on to "Send this form to my SPARK
 *                     inbox". The plugin decides locally from it whether to
 *                     send the SPARK identify call and load the chat tag.
 *   ia_tier           the ARION tier the business pays for (lite | standard |
 *                     pro | business). Sent only when the subscription names
 *                     one; ABSENT means "keep what you have". A lower tier than
 *                     the site holds IS written: a downgrade reaches the site.
 *
 * Plugin route: POST /subscription-config (site token). The first 2.0.3 build
 * (ia-plugin 0709817) took the same two keys on POST /site/options instead,
 * site token only, and has no /subscription-config. So a 404 there is tried
 * once more on /site/options: without it a site on that build answered
 * plugin_too_old forever and never got the capture switch (on OR off). A
 * plugin older than 2.0.3 refuses both (404, or 400 not_in_whitelist), which
 * comes back as `error: 'not_found'`: callers treat that as "update pending",
 * not as a fault. `via` says which route took it.
 */
export async function pushSubscriptionConfig(site, body = {}, opts = {}) {
  const wire = { ia_spark_capture: body.ia_spark_capture === true };
  if (body.ia_tier) wire.ia_tier = String(body.ia_tier);
  const timeoutMs = opts.timeoutMs || READ_TIMEOUT_MS;
  const first = await call(site, {
    method: 'POST', path: '/subscription-config', body: wire, timeoutMs, fetchImpl: opts.fetchImpl,
  });
  if (first.ok || first.error !== 'not_found') return { ...first, via: 'subscription-config' };

  const viaOptions = await call(site, {
    method: 'POST', path: '/site/options', body: wire, timeoutMs, fetchImpl: opts.fetchImpl,
  });
  if (viaOptions.ok) {
    // /site/options reads back `spark_capture` and `tier`; give the caller the
    // same two names /subscription-config answers with.
    const d = viaOptions.data && typeof viaOptions.data === 'object' ? viaOptions.data : {};
    const held = { ...d };
    if (!Object.prototype.hasOwnProperty.call(held, 'ia_spark_capture') && Object.prototype.hasOwnProperty.call(d, 'spark_capture')) {
      held.ia_spark_capture = d.spark_capture;
    }
    if (!held.ia_tier && d.tier) held.ia_tier = d.tier;
    return { ...viaOptions, data: held, via: 'site/options' };
  }
  const tooOld = viaOptions.error === 'not_found'
    || (viaOptions.status === 400 && viaOptions.data?.code === 'not_in_whitelist');
  return tooOld ? { ...first, via: 'none' } : { ...viaOptions, via: 'site/options' };
}

/* ==========================================================================
 * ARION pack 2 (IA plugin >= 1.7.4) — the last wp-admin-only jobs.
 *
 * Menus, the Elementor brand kit, the header and footer through the active
 * theme's own options, and the two site switches. Same site token as
 * everything above; the plugin reads every value back before it answers, so
 * a 200 here means the website is actually holding what was asked for.
 * ======================================================================== */

/** Every nav menu, its items, the theme's menu positions, and what can be added. */
export function fetchMenus(site, opts = {}) {
  return call(site, { method: 'GET', path: '/menus', fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}

/** A new, empty menu. */
export function createMenu(site, name, opts = {}) {
  return call(site, {
    method: 'POST',
    path: '/menus',
    body: { name: String(name || '') },
    timeoutMs: opts.timeoutMs || WRITE_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
}

/**
 * The WHOLE ordered item list, every time — the same contract the section
 * editor uses. No "move item 3 up" verbs that go wrong when two people edit
 * at once, and the plugin snapshots before it writes.
 */
export function writeMenu(site, menuId, payload, opts = {}) {
  return call(site, {
    method: 'PUT',
    path: `/menus/${encodeURIComponent(menuId)}`,
    body: payload,
    timeoutMs: opts.timeoutMs || WRITE_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
}

/** One tap back. Undo POPS, so pressing it twice walks two steps back. */
export function undoMenu(site, menuId, opts = {}) {
  return call(site, {
    method: 'POST',
    path: `/menus/${encodeURIComponent(menuId)}/undo`,
    body: {},
    timeoutMs: opts.timeoutMs || WRITE_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
}

/** The brand colours and fonts, from Elementor's own live kit. */
export function fetchKit(site, opts = {}) {
  return call(site, { method: 'GET', path: '/site/kit', fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}

export function writeKit(site, payload, opts = {}) {
  return call(site, {
    method: 'POST',
    path: '/site/kit',
    body: payload,
    timeoutMs: opts.timeoutMs || WRITE_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
}

/** The header and the footer, through the ACTIVE THEME's own options (D-ARION-A). */
export function fetchChrome(site, opts = {}) {
  return call(site, { method: 'GET', path: '/site/chrome', fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}

export function writeChrome(site, payload, opts = {}) {
  return call(site, {
    method: 'POST',
    path: '/site/chrome',
    body: payload,
    timeoutMs: opts.timeoutMs || WRITE_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
}

/** The website chat bubble and the Book now button. */
export function fetchSiteOptions(site, opts = {}) {
  return call(site, { method: 'GET', path: '/site/options', fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
}

export function writeSiteOptions(site, payload, opts = {}) {
  return call(site, {
    method: 'POST',
    path: '/site/options',
    body: payload,
    timeoutMs: opts.timeoutMs || WRITE_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl,
  });
}

export const __test__ = { NAMESPACE };
