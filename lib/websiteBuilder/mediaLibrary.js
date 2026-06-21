/**
 * Media library injector — ARION IL website builder.
 * --------------------------------------------------------------------------
 * The gallery emitter (and any future image-emitting block) returns
 * *placeholder* URLs:
 *
 *   - https://source.unsplash.com/800x600/?warehouse,clean
 *   - https://images.unsplash.com/photo-...
 *   - https://via.placeholder.com/800x600?text=Sample
 *   - https://placehold.co/800x600
 *   - https://placeholder.com/...
 *
 * Those URLs render fine for *preview*, but at publish time we need real
 * attachment_ids on the customer's WP site so Elementor's image-gallery
 * widget can link to media-library entries (lightbox, srcset, alt text from
 * media meta, etc.).
 *
 * This module:
 *   1. uploadPlaceholderToWp(site, url, opts) — fetch placeholder bytes,
 *      POST to a WP media-upload endpoint, return { attachment_id, full_url }.
 *   2. injectMediaIntoBlocks(site, elementorData, opts) — walk the assembled
 *      _elementor_data tree, find every gallery widget, upload each
 *      placeholder URL once (deduped by URL), swap url + id in place.
 *      Returns a NEW mutated copy — does not modify the input array.
 *
 * Auth model:
 *   The IA Plugin does NOT (yet) ship a dedicated /media endpoint. The
 *   built-in WordPress REST endpoint `/wp/v2/media` accepts uploads but
 *   requires an authenticated WP user with the `upload_files` capability —
 *   the `X-Arion-Site-Token` custom header DOES NOT satisfy that (it's a
 *   plugin-only check). The Basic-auth path (WordPress application password
 *   under `wp_app_password_ref`) DOES work when present.
 *
 *   So we go in this order:
 *     a. POST to the IA Plugin `/media/sideload` endpoint (NOT YET BUILT —
 *        see scope note at the bottom of this file). When that ships, ARION
 *        only needs the `X-Arion-Site-Token` header — no app password needed.
 *     b. Fallback: POST raw multipart to `/wp-json/wp/v2/media` using Basic
 *        auth from wp_app_password_ref. Works on every ARION-provisioned
 *        site today because provisioning generates an app password.
 *
 * Politeness:
 *   - Sequential per-site to avoid hammering the customer's WP host.
 *   - 8s per-image timeout for the placeholder fetch, 30s for the WP upload.
 *   - DEDUPED by URL — if 5 images point at the same placeholder, we upload
 *     once and reuse the attachment_id.
 *   - On per-image failure, we LEAVE the placeholder URL in place and add an
 *     entry to the returned `failed[]` array. We do NOT throw — a single
 *     bad image must not block the whole publish.
 *
 * This module is PURE JS — no DB calls. Inject `fetchImpl` in the verifier
 * to mock the HTTP path.
 */

import { buildPluginAuth, resolveSiteHost } from '../pluginClient.js';

const DEFAULT_PLUGIN_NAMESPACE = '/wp-json/intelligent-analytics/v1';
const PLUGIN_MEDIA_PATH        = '/media/sideload';      // PROPOSED — see bottom note
const WP_CORE_MEDIA_PATH       = '/wp-json/wp/v2/media'; // built-in WP, requires Basic auth
const FETCH_PLACEHOLDER_TIMEOUT_MS = 8_000;
const UPLOAD_TIMEOUT_MS           = 30_000;
const MAX_PLACEHOLDER_BYTES       = 5 * 1024 * 1024; // 5MB sanity cap

// Hosts allowed as a placeholder source (matches galleryEmitter.ALLOWED_HOSTS
// — we re-state here to keep this module standalone, but the lists MUST
// stay in sync).
const ALLOWED_PLACEHOLDER_HOSTS = new Set([
  'source.unsplash.com',
  'images.unsplash.com',
  'via.placeholder.com',
  'placehold.co',
  'placeholder.com',
]);

function isAllowedPlaceholder(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  try {
    const u = new URL(rawUrl.trim());
    if (u.protocol !== 'https:') return false;
    return ALLOWED_PLACEHOLDER_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Derive a clean filename for the WP media library from the placeholder URL.
 * Unsplash query URLs (?warehouse,clean) get a deterministic-ish name; direct
 * image URLs use the last path segment.
 */
function filenameForPlaceholder(rawUrl, idx = 0) {
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase();

    // Unsplash query URLs — last path segment is "800x600" + query is keywords
    if (host === 'source.unsplash.com') {
      const kw = (u.search || '').replace(/^\?/, '').replace(/[^a-z0-9,_-]/gi, '').slice(0, 40) || 'unsplash';
      return `arion-${kw.replace(/,/g, '-')}-${idx}.jpg`;
    }
    if (host === 'images.unsplash.com') {
      const last = (u.pathname.split('/').pop() || `unsplash-${idx}`).replace(/[^a-z0-9._-]/gi, '');
      return /\.(jpe?g|png|webp|gif)$/i.test(last) ? `arion-${last}` : `arion-${last || idx}.jpg`;
    }
    if (host === 'via.placeholder.com' || host === 'placeholder.com' || host === 'placehold.co') {
      const text = (u.searchParams.get('text') || `placeholder-${idx}`).replace(/[^a-z0-9_-]/gi, '-').slice(0, 30);
      return `arion-${text}-${idx}.png`;
    }
    return `arion-img-${idx}.jpg`;
  } catch {
    return `arion-img-${idx}.jpg`;
  }
}

function inferMimeFromUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname.toLowerCase();
    if (path.endsWith('.png')) return 'image/png';
    if (path.endsWith('.gif')) return 'image/gif';
    if (path.endsWith('.webp')) return 'image/webp';
    // Unsplash dynamic URLs return JPEG by default
    return 'image/jpeg';
  } catch {
    return 'image/jpeg';
  }
}

/**
 * Fetch the placeholder image bytes. Returns { ok, bytes, mime, error }.
 * Uses fetchImpl so the verifier can mock without touching the network.
 */
async function fetchPlaceholderBytes(placeholderUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'no_fetch_impl' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || FETCH_PLACEHOLDER_TIMEOUT_MS);
  try {
    const res = await fetchImpl(placeholderUrl, {
      method: 'GET',
      // Unsplash source.unsplash.com 302-redirects to images.unsplash.com — follow.
      redirect: 'follow',
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, error: `placeholder_http_${res.status}` };
    }
    const ab = await res.arrayBuffer();
    if (ab.byteLength === 0) return { ok: false, error: 'placeholder_empty' };
    if (ab.byteLength > MAX_PLACEHOLDER_BYTES) {
      return { ok: false, error: `placeholder_too_large_${ab.byteLength}` };
    }
    const bytes = Buffer.from(ab);
    // Trust the server content-type when present, otherwise infer from URL.
    const mime = (res.headers?.get?.('content-type') || '').split(';')[0].trim() || inferMimeFromUrl(placeholderUrl);
    return { ok: true, bytes, mime };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err.name === 'AbortError' ? 'placeholder_timeout' : err.message };
  }
}

/**
 * Upload a single placeholder URL to the customer's WP media library.
 *
 * @param {object} site                  arion.site row — needs domain (or wp_admin_url)
 *                                       plus site_token_raw and/or wp_app_password_ref.
 * @param {string} placeholderUrl        the source.unsplash.com / placeholder.com URL.
 * @param {object} [opts]
 * @param {string} [opts.alt]            alt text to write to attachment meta.
 * @param {string} [opts.caption]        caption to write to attachment meta.
 * @param {number} [opts.idx]            index — used in fallback filenames only.
 * @param {object} [opts.fetchImpl]      injected fetch for testing.
 * @returns {Promise<{ ok: boolean, attachment_id?: number, full_url?: string,
 *                     error?: string, httpStatus?: number, via?: string }>}
 */
export async function uploadPlaceholderToWp(site, placeholderUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'no_fetch_impl' };
  }
  if (!isAllowedPlaceholder(placeholderUrl)) {
    return { ok: false, error: 'placeholder_not_allowed' };
  }
  const host = resolveSiteHost(site);
  if (!host) return { ok: false, error: 'no_domain_for_site' };

  const auth = buildPluginAuth(site);
  if (!auth.ok) return { ok: false, error: `no_auth_available (${auth.reason})` };

  // Path 1: PROPOSED IA Plugin sideload endpoint. Lets us upload by URL
  // (cheaper — WP fetches the bytes server-side rather than us round-tripping
  // them). Auth is the existing X-Arion-Site-Token header. Until the plugin
  // ships this, the route will 404 and we fall back to path 2.
  if (opts.preferPluginSideload !== false) {
    const pluginUrl = `https://${host}${DEFAULT_PLUGIN_NAMESPACE}${PLUGIN_MEDIA_PATH}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs || UPLOAD_TIMEOUT_MS);
      const res = await fetchImpl(pluginUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...auth.headers,
        },
        body: JSON.stringify({
          source_url: placeholderUrl,
          filename:   opts.filename || filenameForPlaceholder(placeholderUrl, opts.idx || 0),
          alt:        opts.alt || '',
          caption:    opts.caption || '',
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const text = await safeText(res);
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* ignore */ }
        const data = parsed?.data ?? parsed ?? {};
        const aid = data.attachment_id || data.id || data.post_id || null;
        const url = data.source_url || data.full_url || data.url || null;
        if (aid && url) {
          return { ok: true, attachment_id: Number(aid), full_url: String(url), via: 'plugin_sideload', httpStatus: res.status };
        }
        return { ok: false, error: 'plugin_sideload_bad_response', httpStatus: res.status };
      }
      // 404 = endpoint not deployed yet → fall through to core WP upload.
      // 401/403 = token rejected; do NOT fall back (token problem is global).
      if (res.status !== 404) {
        const t = await safeText(res);
        return {
          ok: false,
          error: `plugin_sideload_http_${res.status}: ${(t || '').slice(0, 200)}`,
          httpStatus: res.status,
          via: 'plugin_sideload',
        };
      }
    } catch (err) {
      // Network / abort — surface as an error but allow fallback.
      if (opts.failOnPluginSideloadError) {
        return { ok: false, error: err.name === 'AbortError' ? 'plugin_sideload_timeout' : err.message, via: 'plugin_sideload' };
      }
      // else fall through to core upload
    }
  }

  // Path 2: Fallback to built-in WP /wp/v2/media. Requires Basic auth from
  // a WordPress app password (wp_app_password_ref). If we only have a site
  // token, this path will 401 — surface a clear error.
  if (!site?.wp_app_password_ref) {
    return {
      ok: false,
      error: 'media_upload_requires_app_password (IA Plugin /media/sideload not deployed; built-in WP media endpoint needs Basic auth)',
    };
  }
  const fetched = await fetchPlaceholderBytes(placeholderUrl, { fetchImpl, timeoutMs: opts.fetchTimeoutMs });
  if (!fetched.ok) return { ok: false, error: fetched.error };

  const filename = opts.filename || filenameForPlaceholder(placeholderUrl, opts.idx || 0);
  const wpUrl = `https://${host}${WP_CORE_MEDIA_PATH}`;
  const basicAuth = 'Basic ' + Buffer.from(site.wp_app_password_ref).toString('base64');

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || UPLOAD_TIMEOUT_MS);
    const res = await fetchImpl(wpUrl, {
      method: 'POST',
      headers: {
        Authorization: basicAuth,
        Accept: 'application/json',
        'Content-Type': fetched.mime,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
      body: fetched.bytes,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const text = await safeText(res);
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* ignore */ }

    if (!res.ok) {
      return {
        ok: false,
        error: `wp_media_http_${res.status}: ${(parsed?.message || text || '').toString().slice(0, 200)}`,
        httpStatus: res.status,
        via: 'wp_core_media',
      };
    }
    const aid = parsed?.id || parsed?.attachment_id || null;
    const url = parsed?.source_url || parsed?.guid?.rendered || parsed?.media_details?.sizes?.full?.source_url || null;
    if (!aid || !url) {
      return { ok: false, error: 'wp_media_bad_response', httpStatus: res.status, via: 'wp_core_media' };
    }

    // Best-effort patch of alt + caption (separate request — WP doesn't accept
    // alt_text on the upload POST when body is raw bytes). Fail-soft.
    if (opts.alt || opts.caption) {
      try {
        await fetchImpl(`${wpUrl}/${aid}`, {
          method: 'POST',
          headers: {
            Authorization: basicAuth,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            alt_text: opts.alt || '',
            caption:  opts.caption || '',
          }),
        });
      } catch { /* swallow — attachment is already uploaded */ }
    }

    return { ok: true, attachment_id: Number(aid), full_url: String(url), via: 'wp_core_media', httpStatus: res.status };
  } catch (err) {
    return {
      ok: false,
      error: err.name === 'AbortError' ? 'wp_media_timeout' : err.message,
      via: 'wp_core_media',
    };
  }
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

// ---------------------------------------------------------------------------
// Tree walk — find every gallery widget under the elementor_data tree
// ---------------------------------------------------------------------------
/**
 * Recursively yield every image-gallery widget node. We mutate `gallery[].url`
 * and `gallery[].id` in place on the *cloned* tree (the caller of
 * injectMediaIntoBlocks is responsible for the clone).
 */
function* walkGalleryWidgets(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* walkGalleryWidgets(child);
    return;
  }
  if (node.elType === 'widget' && node.widgetType === 'image-gallery') {
    yield node;
  }
  if (Array.isArray(node.elements)) {
    for (const child of node.elements) yield* walkGalleryWidgets(child);
  }
}

/**
 * Deep-clone via structured-ish copy. The elementor_data is plain JSON, so
 * a JSON round-trip is safe and ~2x faster than structuredClone for trees
 * of this size.
 */
function deepCloneJson(x) {
  return JSON.parse(JSON.stringify(x));
}

/**
 * Walk every gallery widget in the elementor_data tree, upload each unique
 * placeholder URL once, and swap `gallery[].url` + `gallery[].id` to the
 * uploaded attachment.
 *
 * @param {object} site                arion.site row (auth + domain)
 * @param {Array<object>} elementorData output of pageAssembler.assemblePage().elementorData
 * @param {object} [opts]
 * @param {object} [opts.fetchImpl]    injected fetch for testing
 * @param {Function} [opts.uploadImpl] OPTIONAL — inject a fake
 *                                     uploadPlaceholderToWp so the verifier
 *                                     can prove the swap logic without
 *                                     touching HTTP at all.
 * @param {number} [opts.maxConcurrent] default 1 (sequential per site).
 * @returns {Promise<{
 *   elementorData: Array<object>,    // NEW tree with swapped URLs
 *   uploaded: number,                 // unique placeholders uploaded
 *   reused: number,                   // dedupe cache hits
 *   failed: Array<{ url: string, error: string }>,
 *   skipped: Array<{ url: string, reason: string }>, // URLs we left alone (already attached, not allowed, etc.)
 * }>}
 */
export async function injectMediaIntoBlocks(site, elementorData, opts = {}) {
  if (!Array.isArray(elementorData)) {
    throw new TypeError('injectMediaIntoBlocks: elementorData must be an array');
  }
  const uploadImpl = typeof opts.uploadImpl === 'function'
    ? opts.uploadImpl
    : (url, perOpts) => uploadPlaceholderToWp(site, url, { ...perOpts, fetchImpl: opts.fetchImpl });

  // Clone so the input array is never mutated.
  const tree = deepCloneJson(elementorData);

  // Dedupe cache — URL → { attachment_id, full_url } or { error }.
  const cache = new Map();
  let uploaded = 0;
  let reused = 0;
  const failed = [];
  const skipped = [];

  // Collect all (widget, image-index, url, alt, caption) tasks so we can do
  // them in a controlled, single-pass loop (and dedupe within one page).
  const tasks = [];
  for (const widget of walkGalleryWidgets(tree)) {
    const gallery = Array.isArray(widget?.settings?.gallery) ? widget.settings.gallery : [];
    const meta    = Array.isArray(widget?.settings?.ia_gallery_meta) ? widget.settings.ia_gallery_meta : [];
    gallery.forEach((g, idx) => {
      const url = g?.url;
      if (!url) {
        skipped.push({ url: '', reason: 'no_url' });
        return;
      }
      if (g.id && String(g.id).length > 0 && !isAllowedPlaceholder(url)) {
        // Already attached to a real media library entry — leave alone.
        skipped.push({ url, reason: 'already_attached' });
        return;
      }
      if (!isAllowedPlaceholder(url)) {
        // Not a known placeholder host — could be a customer-supplied URL.
        // Leave alone rather than risk uploading something we shouldn't.
        skipped.push({ url, reason: 'not_a_known_placeholder' });
        return;
      }
      const m = meta[idx] || {};
      tasks.push({ widget, idx, url, alt: m.alt || '', caption: m.caption || '' });
    });
  }

  // Sequential upload loop (politeness — customer WP boxes are often shared
  // hosting). We could increase concurrency for big galleries, but the
  // dedupe + the typical 6-12 images per page keep this fast enough.
  const maxConcurrent = Math.max(1, Math.min(4, Number(opts.maxConcurrent) || 1));
  if (maxConcurrent === 1) {
    for (const t of tasks) {
      await runOne(t);
    }
  } else {
    // Light parallel-ish: chunk by maxConcurrent.
    for (let i = 0; i < tasks.length; i += maxConcurrent) {
      const chunk = tasks.slice(i, i + maxConcurrent);
      await Promise.all(chunk.map(runOne));
    }
  }

  async function runOne(t) {
    // Cache hit?
    if (cache.has(t.url)) {
      const cached = cache.get(t.url);
      if (cached.ok) {
        applySwap(t.widget, t.idx, cached.attachment_id, cached.full_url);
        reused += 1;
      } else {
        failed.push({ url: t.url, error: cached.error });
      }
      return;
    }
    const result = await uploadImpl(t.url, {
      alt:     t.alt,
      caption: t.caption,
      idx:     t.idx,
    });
    if (result?.ok && result.attachment_id && result.full_url) {
      cache.set(t.url, { ok: true, attachment_id: result.attachment_id, full_url: result.full_url });
      applySwap(t.widget, t.idx, result.attachment_id, result.full_url);
      uploaded += 1;
    } else {
      const err = result?.error || 'unknown_upload_error';
      cache.set(t.url, { ok: false, error: err });
      failed.push({ url: t.url, error: err });
    }
  }

  return {
    elementorData: tree,
    uploaded,
    reused,
    failed,
    skipped,
  };
}

function applySwap(widget, idx, attachmentId, fullUrl) {
  const g = widget?.settings?.gallery?.[idx];
  if (!g) return;
  g.id = attachmentId;
  g.url = fullUrl;
}

// ---------------------------------------------------------------------------
// PLUGIN ENDPOINT SCOPE (not implemented in this commit — separate plugin batch)
// ---------------------------------------------------------------------------
//
// The IA Plugin should expose:
//
//   POST /wp-json/intelligent-analytics/v1/media/sideload
//   Headers: X-Arion-Site-Token: <raw> (or admin Basic auth)
//   Body (JSON):
//     {
//       "source_url": "https://source.unsplash.com/800x600/?warehouse,clean",
//       "filename":   "arion-warehouse-clean-0.jpg",
//       "alt":        "Polished warehouse floor under daylight",
//       "caption":    "Cedar Rapids distribution center"
//     }
//
//   Implementation (WP-side):
//     1. permission_callback: check_token_or_admin (same as /pages/elementor)
//     2. Validate source_url against an allowlist (same hosts as
//        galleryEmitter.ALLOWED_HOSTS) — DO NOT trust arbitrary URLs.
//     3. require_once ABSPATH . 'wp-admin/includes/file.php'   // download_url
//        require_once ABSPATH . 'wp-admin/includes/media.php'  // media_handle_sideload
//        require_once ABSPATH . 'wp-admin/includes/image.php'
//     4. $tmp = download_url( $source_url );  // 8s default timeout
//        if ( is_wp_error( $tmp ) ) → 502 with the WP_Error message.
//     5. $file = [ 'name' => $filename, 'tmp_name' => $tmp ];
//        $attachment_id = media_handle_sideload( $file, 0, null );
//        if ( is_wp_error( $attachment_id ) ) { @unlink( $tmp ); → 500 }
//     6. if ( $alt )     update_post_meta( $attachment_id, '_wp_attachment_image_alt', sanitize_text_field( $alt ) );
//        if ( $caption ) wp_update_post( [ 'ID' => $attachment_id, 'post_excerpt' => sanitize_text_field( $caption ) ] );
//     7. Return: { success: true, attachment_id, source_url: wp_get_attachment_url( $attachment_id ) }
//
// Until that endpoint ships, ARION falls back to the built-in /wp/v2/media
// endpoint using the wp_app_password_ref Basic auth. Every ARION-provisioned
// site has an app password set during onboarding, so the fallback is viable
// today — but the plugin endpoint should still ship in v1.2.x because:
//   - it's 1 round-trip instead of 2 (ARION → WP rather than ARION fetch → WP)
//   - it uses the same X-Arion-Site-Token everything else does
//   - it can enforce the placeholder host allowlist server-side, which the
//     core WP endpoint cannot.

export const __test__ = {
  isAllowedPlaceholder,
  filenameForPlaceholder,
  inferMimeFromUrl,
  walkGalleryWidgets,
  deepCloneJson,
  ALLOWED_PLACEHOLDER_HOSTS,
  PLUGIN_MEDIA_PATH,
  WP_CORE_MEDIA_PATH,
};
