/**
 * Manifest Builder — Tier → Provisioning Manifest
 * --------------------------------------------------------------------------
 * After the Hostinger AI Builder finishes, the IA Plugin activates and fetches
 * a "manifest" describing what should be installed, removed, and configured on
 * the WordPress site. The plugin executes the manifest using WordPress's
 * Plugin_Upgrader API (no SSH needed).
 *
 * Tiers map to different plugin lists per the locked SEO matrix
 * (Starter / Essentials / Growth / Authority).
 *
 * The manifest is intentionally declarative — the plugin's bootstrap class
 * reads it and figures out what to do, so we can change provisioning behavior
 * server-side without shipping plugin updates.
 */

/**
 * Plugins that ship by default in Hostinger's WP install but we don't want.
 */
const HOSTINGER_PLUGINS_TO_REMOVE = [
  'hostinger-easy-onboarding',
  'hostinger-reach',
];

/**
 * Hostinger plugins to deactivate but leave installed (in case client wants
 * to re-enable later via Settings).
 */
const HOSTINGER_PLUGINS_TO_DEACTIVATE = [
  'hostinger-ai',
];

/**
 * Hostinger plugins to keep active (they provide value or hooks we depend on).
 */
const HOSTINGER_PLUGINS_TO_KEEP = [
  'hostinger',          // Hostinger Tools — provides hosting integration hooks
  'elementor',          // The page builder our entire stack depends on
  'litespeed-cache',    // We configure this through our defaults
];

/**
 * Universal plugins installed on every tier (security + SEO floor).
 */
const UNIVERSAL_PLUGINS = [
  { slug: 'wp-simple-firewall', source: 'wp-org', activate: true, reason: 'Security baseline (Shield Security)' },
  { slug: 'safe-svg', source: 'wp-org', activate: true, reason: 'Safe SVG uploads' },
  { slug: 'wp-mail-smtp', source: 'wp-org', activate: true, reason: 'Reliable transactional email' },
  { slug: 'seo-by-rank-math', source: 'wp-org', activate: true, reason: 'On-page SEO management' },
];

/**
 * Tier-specific plugin additions.
 * Starter gets only the universal floor. Higher tiers add deeper SEO + analytics.
 */
const TIER_PLUGINS = {
  starter: [],
  essentials: [
    // Essentials adds analytics-grade SEO + first-party event tracking
    { slug: 'gtm4wp', source: 'wp-org', activate: true, reason: 'GTM container for analytics' },
  ],
  growth: [
    { slug: 'gtm4wp', source: 'wp-org', activate: true, reason: 'GTM container for analytics' },
    // Growth gets additional SEO power
    { slug: 'wp-rocket', source: 'iadm-private', activate: false, reason: 'Performance — manual activation if LiteSpeed conflicts' },
  ],
  authority: [
    { slug: 'gtm4wp', source: 'wp-org', activate: true, reason: 'GTM container for analytics' },
    { slug: 'wp-rocket', source: 'iadm-private', activate: false, reason: 'Performance — manual activation if LiteSpeed conflicts' },
    // Authority unlocks structured-data automation, schema, multilingual prep
  ],
};

/**
 * IA Plugin install descriptor — always present, always activated, always first.
 * We don't include this in the manifest's "install" list because the plugin is
 * already installed (it IS the bootstrap). It's listed here for documentation.
 */
const IA_PLUGIN = {
  slug: 'intelligent-analytics',
  source: 'iadm-private',
  activate: true,
  required: true,
};

/**
 * Build the provisioning manifest the IA Plugin will fetch on activation.
 *
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.siteId
 * @param {'starter'|'essentials'|'growth'|'authority'} params.tier
 * @param {object} [params.branding] - { primaryColor, logoUrl, fontFamily }
 * @param {string[]} [params.featureAddons] - e.g. ["seo-focus-area"]
 * @param {string} params.provisionCode - one-time token the plugin uses to authenticate
 * @returns {object} manifest JSON
 */
export function buildManifest({
  tenantId,
  siteId,
  tier,
  branding = {},
  featureAddons = [],
  provisionCode,
}) {
  const tierKey = String(tier || 'starter').toLowerCase();
  const tierPlugins = TIER_PLUGINS[tierKey] || [];

  // Combine universal + tier plugins, dedupe by slug
  const installMap = new Map();
  for (const p of [...UNIVERSAL_PLUGINS, ...tierPlugins]) {
    installMap.set(p.slug, p);
  }
  const install = Array.from(installMap.values());

  return {
    schema: 'iadm.provisioning.v1',
    issued_at: new Date().toISOString(),
    tenant_id: tenantId,
    site_id: siteId,
    tier: tierKey,
    feature_addons: featureAddons,
    provision_code: provisionCode,

    // Plugin lifecycle directives
    plugins: {
      remove: HOSTINGER_PLUGINS_TO_REMOVE,
      deactivate_only: HOSTINGER_PLUGINS_TO_DEACTIVATE,
      keep_active: HOSTINGER_PLUGINS_TO_KEEP,
      install,
    },

    // Configuration phases — plugin executes each in order
    apply: {
      ia_defaults: true,            // LiteSpeed + Shield Security + RankMath defaults
      branding: branding && (branding.primaryColor || branding.logoUrl || branding.fontFamily)
        ? {
            primary_color: branding.primaryColor || null,
            logo_url: branding.logoUrl || null,
            font_family: branding.fontFamily || null,
          }
        : null,
      smtp: {
        // Filled in by provisioning route at issue time using KV-stored credentials
        configured_server_side: true,
      },
    },

    // Tier-gated integration kickoffs (the plugin fires webhooks on completion;
    // arion-api then runs GA4/GSC/Bing/SE Ranking property creation).
    integrations: {
      analytics_pending: ['essentials', 'growth', 'authority'].includes(tierKey),
      gbp_pending: ['growth', 'authority'].includes(tierKey),
      seranking_pending: ['growth', 'authority'].includes(tierKey),
    },

    // After everything completes the plugin POSTs to this URL with status.
    callback_url: '/api/internal/provisioning/site-ready',
  };
}

/**
 * Hostinger plugin slugs — exported so the bootstrap can use them for cleanup
 * even if the manifest fetch ever fails.
 */
export const HOSTINGER_PLUGIN_LISTS = {
  remove: HOSTINGER_PLUGINS_TO_REMOVE,
  deactivate: HOSTINGER_PLUGINS_TO_DEACTIVATE,
  keep: HOSTINGER_PLUGINS_TO_KEEP,
};

export default { buildManifest, HOSTINGER_PLUGIN_LISTS };
