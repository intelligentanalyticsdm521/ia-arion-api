/**
 * IA Plugin HTTP client.
 *
 * ARION → Plugin authentication model:
 *   The plugin accepts either `X-Arion-Site-Token: <raw-token>` OR a
 *   WordPress application password via `Authorization: Basic` (for the
 *   `check_token_or_admin` endpoints). Because ARION stores only the
 *   SHA-256 hash of site_token (we can verify incoming, but cannot send
 *   the raw value back), we use WP app-password auth for outbound calls.
 *
 * All calls are best-effort with timeouts + optional response caching.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_NAMESPACE = '/wp-json/intelligent-analytics/v1';

/**
 * Build the Authorization headers for outbound plugin calls.
 *
 * Auth priority:
 *   1. site_token_raw + X-Arion-Site-Token header (primary — zero-config,
 *      set on every redeem/rotate)
 *   2. wp_app_password_ref + Basic auth (legacy fallback — works only if
 *      an IA staffer manually created an app password in WP admin)
 *
 * We send BOTH when available so the plugin's check_token_or_admin
 * permission callback passes on either path.
 *
 * @param {object} site arion.site row — may have site_token_raw and/or wp_app_password_ref
 * @returns {{ headers: Record<string,string>, ok: boolean, reason?: string }}
 */
export function buildPluginAuth(site) {
  const headers = {};

  if (site?.site_token_raw) {
    headers['X-Arion-Site-Token'] = site.site_token_raw;
  }
  if (site?.wp_app_password_ref) {
    headers['Authorization'] = 'Basic ' + Buffer.from(site.wp_app_password_ref).toString('base64');
  }

  if (Object.keys(headers).length === 0) {
    return { headers: {}, ok: false, reason: 'no_auth_available' };
  }
  return { headers, ok: true };
}

/** Resolve the domain to call — prefer `domain`, fall back to wp_admin_url host. */
export function resolveSiteHost(site) {
  if (site?.domain) return String(site.domain).replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (site?.wp_admin_url) {
    try {
      return new URL(site.wp_admin_url).host;
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Generic GET to a plugin endpoint with timeout + error normalization.
 * Returns { ok, status, data, pluginStatus, errorText } — never throws.
 *
 * @param {object} site
 * @param {string} path e.g. '/security/wordfence'
 * @param {object} opts { timeoutMs?, query? }
 */
export async function pluginGet(site, path, opts = {}) {
  const host = resolveSiteHost(site);
  if (!host) return { ok: false, status: 0, data: null, pluginStatus: 'unreachable', errorText: 'No domain configured for site' };

  const auth = buildPluginAuth(site);
  if (!auth.ok) {
    return { ok: false, status: 0, data: null, pluginStatus: 'token_invalid', errorText: `WP app password missing (${auth.reason})` };
  }

  const qs = opts.query ? '?' + new URLSearchParams(opts.query).toString() : '';
  const url = `https://${host}${DEFAULT_NAMESPACE}${path}${qs}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || REQUEST_TIMEOUT_MS);
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...auth.headers,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    const body = await res.text();
    let data = null;
    try { data = body ? JSON.parse(body) : null; } catch { /* ignore */ }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data,
        pluginStatus: res.status === 401 || res.status === 403 ? 'token_invalid' : 'error',
        errorText: (data?.message || body || '').slice(0, 500),
      };
    }

    return {
      ok: true,
      status: res.status,
      data: data?.data ?? data,
      pluginStatus: data?.plugin_status || 'connected',
      errors: data?.errors || [],
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      pluginStatus: err.name === 'AbortError' ? 'timeout' : 'unreachable',
      errorText: err.message,
    };
  }
}

/**
 * Generic POST — used for update actions (updates/plugin, updates/theme,
 * updates/core, purge-cache, etc.).
 */
export async function pluginPost(site, path, body = {}, opts = {}) {
  const host = resolveSiteHost(site);
  if (!host) return { ok: false, status: 0, data: null, pluginStatus: 'unreachable', errorText: 'No domain configured for site' };

  const auth = buildPluginAuth(site);
  if (!auth.ok) {
    return { ok: false, status: 0, data: null, pluginStatus: 'token_invalid', errorText: `WP app password missing (${auth.reason})` };
  }

  const url = `https://${host}${DEFAULT_NAMESPACE}${path}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 45_000); // longer for updates
    const res = await fetch(url, {
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

    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* ignore */ }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data: parsed,
        pluginStatus: res.status === 401 || res.status === 403 ? 'token_invalid' : 'error',
        errorText: (parsed?.message || parsed?.error || text || '').slice(0, 500),
      };
    }

    return {
      ok: true,
      status: res.status,
      data: parsed?.data ?? parsed,
      pluginStatus: parsed?.plugin_status || 'connected',
      errors: parsed?.errors || [],
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      pluginStatus: err.name === 'AbortError' ? 'timeout' : 'unreachable',
      errorText: err.message,
    };
  }
}

/** Fetch multiple plugin endpoints in parallel — gathers the full site picture. */
export async function pluginFetchAll(site, paths) {
  const results = await Promise.all(paths.map(async (p) => {
    const r = await pluginGet(site, p);
    return [p, r];
  }));
  return Object.fromEntries(results);
}

/** Convenience wrappers for each endpoint. */
export const plugin = {
  health:             (site) => pluginGet(site, '/health'),
  status:             (site) => pluginGet(site, '/status'),
  plugins:            (site) => pluginGet(site, '/plugins'),
  contentStats:       (site) => pluginGet(site, '/content-stats'),
  contentSummary:     (site) => pluginGet(site, '/content/summary'),
  contentSeoAgg:      (site) => pluginGet(site, '/content/seo-aggregate'),
  cacheStatus:        (site) => pluginGet(site, '/cache-status'),
  purgeCache:         (site) => pluginPost(site, '/purge-cache'),
  seoMeta:            (site, postId) => pluginGet(site, `/seo-meta/${encodeURIComponent(postId)}`),

  securityWordfence:  (site) => pluginGet(site, '/security/wordfence'),
  securityCoreHealth: (site) => pluginGet(site, '/security/core-health'),
  securityUsers:      (site) => pluginGet(site, '/security/users'),

  perfLitespeed:      (site) => pluginGet(site, '/performance/litespeed'),
  perfServer:         (site) => pluginGet(site, '/performance/server'),
  perfCron:           (site) => pluginGet(site, '/performance/cron'),
  imageOptimize:      (site) => pluginPost(site, '/performance/image-optimize'),

  theme:              (site) => pluginGet(site, '/theme'),
  formsSummary:       (site) => pluginGet(site, '/forms/summary'),

  updatesAvailable:   (site) => pluginGet(site, '/updates/available'),
  updatePlugin:       (site, pluginFile) => pluginPost(site, '/updates/plugin', { plugin: pluginFile }),
  updateTheme:        (site, stylesheet) => pluginPost(site, '/updates/theme', { stylesheet }),
  updateCore:         (site) => pluginPost(site, '/updates/core'),

  autoUpdateConfig:   (site) => pluginGet(site, '/updates/auto-config'),
  setAutoUpdate:      (site, body) => pluginPost(site, '/updates/auto-config', body),
};

export default plugin;
