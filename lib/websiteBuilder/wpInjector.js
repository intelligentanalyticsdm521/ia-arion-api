/**
 * WordPress injector — pushes an assembled `_elementor_data` array to a
 * customer's WP site via the IA Plugin's REST API.
 * --------------------------------------------------------------------------
 * Auth model: same as everything else in lib/pluginClient.js —
 *   - `X-Arion-Site-Token: <raw-token>` (primary)
 *   - Basic auth via wp_app_password_ref (legacy fallback)
 *
 * This module is *transport only*. The pageAssembler builds the
 * `_elementor_data` array; we serialize + slash + POST it. The plugin side
 * (separate batch — see followups in scripts/verify-page-assembler.mjs)
 * needs a `POST /pages/elementor` endpoint that:
 *   1. Validates the post belongs to this site
 *   2. update_post_meta( $post_id, '_elementor_data', wp_slash(wp_json_encode($data)) )
 *   3. update_post_meta( $post_id, '_elementor_edit_mode', 'builder' )
 *   4. update_post_meta( $post_id, '_elementor_version', ELEMENTOR_VERSION )
 *   5. Optionally clears Elementor's CSS cache for the post
 *
 * Until that endpoint ships we keep the injector behind a feature flag in
 * the route handler so we don't pretend it works. The verifier mocks the
 * fetch so we can ship the JS path and unit-test it offline.
 */

import { buildPluginAuth, resolveSiteHost, resolveSiteBaseUrl } from '../pluginClient.js';

const DEFAULT_NAMESPACE = '/wp-json/intelligent-analytics/v1';
const PAGES_ELEMENTOR_PATH = '/pages/elementor';
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Inject the assembled _elementor_data array into a WP page's post meta.
 *
 * @param {object} site                     arion.site row (needs domain or wp_admin_url,
 *                                            plus site_token_raw or wp_app_password_ref)
 * @param {number|string} pageId            WP post ID to update
 * @param {Array<object>} elementorData     output of assemblePage().elementorData
 * @param {object} [opts]
 * @param {string} [opts.title]             optional new page title
 * @param {string} [opts.status]            'publish' | 'draft' (default 'publish' if creating new)
 * @param {boolean} [opts.flipToBuilder]    set _elementor_edit_mode = 'builder' (default true)
 * @param {object} [opts.fetchImpl]         injected fetch (for testing). Defaults to globalThis.fetch.
 * @returns {Promise<{ success: boolean, postId?: number, elementorEditUrl?: string,
 *                    pluginStatus?: string, error?: string, httpStatus?: number }>}
 */
export async function injectPageToWordpress(site, pageId, elementorData, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { success: false, error: 'no_fetch_impl', httpStatus: 0 };
  }

  if (!Array.isArray(elementorData)) {
    return { success: false, error: 'elementorData must be an array', httpStatus: 0 };
  }
  if (!pageId && !opts.title) {
    return { success: false, error: 'pageId or opts.title required (cannot create page without title)', httpStatus: 0 };
  }

  const host = resolveSiteHost(site);
  if (!host) {
    return { success: false, error: 'no_domain_for_site', pluginStatus: 'unreachable', httpStatus: 0 };
  }
  const auth = buildPluginAuth(site);
  if (!auth.ok) {
    return { success: false, error: `no_auth_available (${auth.reason})`, pluginStatus: 'token_invalid', httpStatus: 0 };
  }

  const base = resolveSiteBaseUrl(site);
  const url = `${base}${DEFAULT_NAMESPACE}${PAGES_ELEMENTOR_PATH}`;
  const body = {
    // page_id absent → plugin creates a new page; present → plugin updates it
    page_id: pageId || null,
    title: opts.title || null,
    status: opts.status || 'publish',
    flip_to_builder: opts.flipToBuilder !== false,
    elementor_data: elementorData, // plugin will JSON-encode + wp_slash itself
  };

  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || REQUEST_TIMEOUT_MS);
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...auth.headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    return {
      success: false,
      error: err.message,
      pluginStatus: err.name === 'AbortError' ? 'timeout' : 'unreachable',
      httpStatus: 0,
    };
  }

  const text = await safeReadText(res);
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* ignore */ }

  if (!res.ok) {
    return {
      success: false,
      httpStatus: res.status,
      pluginStatus: res.status === 401 || res.status === 403 ? 'token_invalid' : 'error',
      error: (parsed?.message || parsed?.error || text || `HTTP ${res.status}`).toString().slice(0, 500),
    };
  }

  const data = parsed?.data ?? parsed ?? {};
  // The plugin returns `page_id` (intelligent-analytics.php upsert_elementor_page:
  // `[ 'success' => true, 'page_id' => (int) $page_id, 'edit_url' => ..., 'permalink' => ... ]`).
  // We used to read only `post_id`/`postId`, which the plugin has never sent, so
  // every NEWLY CREATED page came back with postId: null — no edit URL, and the
  // drafts were never stamped with persisted_to_post_id. `post_id`/`postId` stay
  // as fallbacks in case an older plugin build is on the site.
  const finalPostId = data.page_id || data.post_id || data.postId || pageId;
  const editUrl = data.elementor_edit_url
    || data.elementorEditUrl
    || (finalPostId ? `${base}/wp-admin/post.php?post=${finalPostId}&action=elementor` : null);

  return {
    success: true,
    httpStatus: res.status,
    pluginStatus: parsed?.plugin_status || 'connected',
    postId: finalPostId || null,
    elementorEditUrl: editUrl,
    raw: data,
  };
}

async function safeReadText(res) {
  try { return await res.text(); } catch { return ''; }
}

export const __test__ = { PAGES_ELEMENTOR_PATH, DEFAULT_NAMESPACE };
