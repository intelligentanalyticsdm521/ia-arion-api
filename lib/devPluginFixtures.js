/**
 * devPluginFixtures.js — canned IA Plugin responses for the dev fixture sites.
 *
 * WHY THIS EXISTS
 * Every plugin-backed ARION page (Website, Content SEO, Security, Performance,
 * Hosting) calls the site's own WordPress REST API live. The dev fixture sites
 * are *.example.com and do not resolve, so every one of those pages renders
 * "IA Plugin not available" and NOTHING on them can be reviewed — including the
 * reports hanging off them. Brandon, 2026-08-14: "everything says IA plugin not
 * available... I don't understand how to see the reports for content SEO if I
 * can't select anything."
 *
 * SAFETY
 * Gated on the PRESENCE of two dev markers, never on the absence of a prod one
 * — an absence-based guard fails open, which is how fixtures end up in front of
 * a client:
 *   1. ARION_DEV_PLUGIN_FIXTURES === 'true'   (set only by the dev stack)
 *   2. the domain ends in .example.com        (a real client domain never does)
 * Both must hold. In production the flag is unset and this file is inert.
 *
 * The shapes mirror what the real plugin returns so the pages and reports are
 * exercised honestly; the values are invented.
 */

const ENABLED = () => process.env.ARION_DEV_PLUGIN_FIXTURES === 'true';
const IS_FIXTURE_HOST = (host) => typeof host === 'string' && /\.example\.com$/i.test(host);

export function devFixturesActive(host) {
  return ENABLED() && IS_FIXTURE_HOST(host);
}

// Deterministic per host so a page shows the same numbers on every reload.
function rnd(host, salt) {
  let h = 0;
  for (const c of `${host}:${salt}`) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h % 1000) / 1000;
}
const pick = (host, salt, lo, hi) => Math.round(lo + rnd(host, salt) * (hi - lo));

const PLUGINS = [
  ['Elementor', 'elementor/elementor.php', '3.21.4', '3.23.1', true],
  ['Elementor Pro', 'elementor-pro/elementor-pro.php', '3.21.0', '3.23.0', true],
  ['Rank Math SEO', 'seo-by-rank-math/rank-math.php', '1.0.219', '1.0.221', true],
  ['LiteSpeed Cache', 'litespeed-cache/litespeed-cache.php', '6.2.0', '6.2.0', true],
  ['Shield Security', 'wp-simple-firewall/icwp-wpsf.php', '19.1.6', '19.1.6', true],
  ['Contact Form 7', 'contact-form-7/wp-contact-form-7.php', '5.9.3', '5.9.8', true],
  ['WooCommerce', 'woocommerce/woocommerce.php', '8.6.1', '9.1.2', false],
  ['Duplicate Page', 'duplicate-page/duplicatepage.php', '4.5.3', '4.5.3', false],
  ['Intelligent Analytics', 'intelligent-analytics/intelligent-analytics.php', '1.4.0', '1.4.0', true],
];

/** Returns a fixture body for a plugin endpoint, or null if we don't fake it. */
export function devPluginFixture(host, path) {
  if (!devFixturesActive(host)) return null;
  const p = String(path).split('?')[0];
  const r = (salt, lo, hi) => pick(host, salt, lo, hi);

  switch (p) {
    case '/health':
      return {
        plugin_version: '1.4.0',
        wp_version: '6.9.5',
        php_version: '8.3.30',
        active_plugins: PLUGINS.filter((x) => x[4]).map(([name, , version]) => ({ name, version, active: true })),
        litespeed_active: true,
        wordfence_active: false,
        rank_math_active: true,
        site_url: `https://${host}`,
        admin_email: `owner@${host}`,
      };

    case '/status':
      return {
        plugin_version: '1.4.0', site_configured: true, tenant_configured: true,
        token_configured: true, api_url_configured: true,
        tier: 'business', seo_addon: 'authority', last_health_check: new Date().toISOString(),
      };

    // 2026-08-24 — this returned an OBJECT `{ plugins: [...] }`, but the real
    // plugin route returns a BARE ARRAY: routes/arion.js:7163 gates the
    // inventory upsert on `Array.isArray(r.data)`, and the Portal maps over it
    // directly (WebsiteUpdates.tsx PluginInventoryTable). So in the dev stack
    // the inventory silently never populated and the page threw on .map —
    // meaning plugin/theme control could not be exercised locally at all, and
    // the standing "exhaustive UI test in dev before Brandon walks it" rule was
    // impossible to satisfy for this surface. Field names corrected too: the
    // code reads `file`, `current_version` and `core_update`, not
    // `plugin_file`/`version`.
    case '/plugins':
      return PLUGINS.map(([name, file, version, latest, active]) => ({
        name,
        file,
        plugin_file: file,          // kept: some older callers still read this
        current_version: version,
        version,                    // kept for the same reason
        new_version: latest,
        update_available: version !== latest,
        active,
        author: 'Various',
      }));

    case '/updates/available':
      return {
        plugins: PLUGINS.filter((x) => x[2] !== x[3]).map(([name, file, version, latest]) => ({ name, plugin_file: file, version, new_version: latest })),
        themes: [], core: { update_available: false, current: '6.9.5' },
      };

    case '/theme':
      return { name: 'Hello Elementor', version: '3.1.1', update_available: false, parent: null, child_active: true };

    case '/security/wordfence':
      return {
        installed: true, provider: 'shield', firewall_enabled: true,
        blocked_attacks_24h: r('atk', 3, 180), last_scan_at: new Date(Date.now() - 86400000).toISOString(),
        malware_found: 0, issues: r('iss', 0, 4),
      };

    case '/security/core-health':
      return {
        critical_count: r('crit', 0, 2), recommended_count: r('rec', 2, 9),
        checks: [
          { label: 'PHP version', status: 'good', value: '8.3.30' },
          { label: 'HTTPS', status: 'good', value: 'enabled' },
          { label: 'Auto-updates', status: r('crit', 0, 2) ? 'recommended' : 'good', value: 'plugins only' },
          { label: 'Database version', status: 'good', value: 'current' },
        ],
      };

    case '/security/users':
      return {
        total: r('usr', 2, 7),
        admins: r('adm', 1, 3),
        users: [
          { login: 'owner', role: 'administrator', last_login: new Date(Date.now() - 3 * 86400000).toISOString(), two_factor: true },
          { login: 'editor1', role: 'editor', last_login: new Date(Date.now() - 21 * 86400000).toISOString(), two_factor: false },
        ],
      };

    case '/security/scan-issues':
      return { issues: [], total: 0 };

    case '/performance/litespeed':
      return { installed: true, cache_enabled: true, object_cache: true, css_minify: true, js_minify: true, image_webp: true, ttl: 604800 };

    case '/performance/server':
      return { php_version: '8.3.30', memory_limit: '256M', max_execution_time: 120, opcache: true, server: 'LiteSpeed' };

    case '/performance/cron':
      return { queued_events: r('cron', 20, 70), overdue_events: r('over', 0, 3), disabled: false };

    case '/performance/shortpixel':
    case '/performance/ewww':
      return { installed: false };

    case '/performance/image-optimize':
      return { optimized: r('imgo', 40, 400), remaining: r('imgr', 0, 120), savings_kb: r('imgs', 500, 22000) };

    case '/content/summary':
      return { posts: r('posts', 4, 40), pages: r('pages', 5, 30), drafts: r('draft', 0, 6), categories: r('cat', 2, 9), tags: r('tag', 3, 30) };

    case '/content/seo-aggregate':
      // `installed` is the flag the Content SEO page gates on — without it the
      // page renders "Rank Math not detected" no matter how good the data is.
      return {
        installed: true, plugin: 'rank-math', version: '1.0.219',
        avg_seo_score: r('seo', 28, 82), posts_missing_meta: r('meta', 0, 24),
        avg_word_count: r('wc', 180, 1400), focus_keywords_set: r('fk', 2, 26),
        posts_analyzed: r('pa', 8, 40), avg_readability: r('rd', 45, 88),
        schema_counts: { Article: r('sc1', 0, 12), LocalBusiness: 1, none: r('sc2', 2, 20) },
      };

    case '/content/publishing-pace':
      return { last_90_days: r('p90', 0, 12), last_30_days: r('p30', 0, 5), last_published_at: new Date(Date.now() - r('lp', 3, 200) * 86400000).toISOString() };

    case '/content/age-distribution':
      return { buckets: [
        { label: 'Under 3 months', count: r('a1', 0, 8) },
        { label: '3-12 months', count: r('a2', 1, 12) },
        { label: '1-2 years', count: r('a3', 0, 10) },
        { label: 'Over 2 years', count: r('a4', 0, 14) },
      ] };

    case '/forms/summary':
      return { forms: [{ id: 1, title: 'Contact', submissions_30d: r('f1', 0, 25) }], total_submissions_30d: r('fs', 0, 30) };

    case '/status/indexnow-key':
    case '/indexnow-key':
      return { key: 'dev-fixture-indexnow-key', configured: true };

    default:
      // Anything not faked returns null so the caller takes its normal
      // "endpoint unavailable" path rather than receiving a made-up shape.
      return null;
  }
}

export default { devPluginFixture, devFixturesActive };
