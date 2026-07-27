/**
 * ARION WordPress Plugin Stack — Golden Master matrix + installer.
 * --------------------------------------------------------------------------
 * Mirror of `reference_arion_plugin_stack.md` (Brandon's auto-memory). If you
 * change the matrix here, update that memory file in the same commit so the
 * next AI session sees the same source of truth.
 *
 * Tier names match the F-105 cross-product framing (Lite / Standard / Pro /
 * Business / Enterprise) — NOT the SEO add-on tiers
 * (Starter/Essentials/Growth/Authority) which are an independent dimension
 * controlling SE Ranking config only.
 *
 * Install order matters: theme first, free wp.org plugins next, conditional
 * WooCommerce, then Elementor Pro (with license activation), and finally the
 * IA Plugin so the provisioning manifest fires after the rest is settled.
 */

import { runWpCli, runSshCommand, whitelistSeRankingCrawler } from './hostingerSsh.js';
import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';

const KV_URI = process.env.KEY_VAULT_URI || 'https://kv-iadm-prod.vault.azure.net/';
const ARION_API_BASE = (process.env.ARION_API_BASE_URL
  || 'https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net').replace(/\/+$/, '');

/**
 * Retry helper for transient failures. Exponential backoff (1s, 3s, 7s).
 * Used by blob-source installs (paid plugin ZIPs from arion-api → blob).
 * Network blips, momentary blob 503s, and SSH stream stalls all benefit from
 * a couple of retries; persistent issues (404 blob, bad license) fall through.
 *
 * The `isRetriable(err)` predicate decides which errors are worth retrying.
 * Default predicate retries on network/timeout/5xx phrasings only — a 4xx
 * from arion-api (TOKEN_INVALID, PLUGIN_NOT_FOUND) means "wrong inputs,
 * stop trying."
 */
async function retryWithBackoff(fn, { attempts = 3, backoffMs = [1000, 3000, 7000], isRetriable, label = 'op' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      const retriable = isRetriable ? isRetriable(err) : defaultRetriable(err);
      const isLast = i === attempts - 1;
      if (!retriable || isLast) {
        if (!isLast) console.warn(`[pluginStack] ${label}: not retriable, aborting after attempt ${i + 1}: ${(err.message || '').slice(0, 200)}`);
        throw err;
      }
      const wait = backoffMs[i] || 5000;
      console.warn(`[pluginStack] ${label}: attempt ${i + 1}/${attempts} failed, retrying in ${wait}ms: ${(err.message || '').slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

function defaultRetriable(err) {
  const msg = ((err && (err.stderr || err.message)) || '').toString();
  // Retry on transient phrasings only. Do NOT retry on:
  //   - PLUGIN_NOT_FOUND (blob missing — needs ops upload, not a retry)
  //   - TOKEN_INVALID / TOKEN_EXPIRED (provision code bad — caller bug)
  //   - "already installed" / "already active" (idempotent OK, not an error)
  if (/PLUGIN_NOT_FOUND|TOKEN_INVALID|TOKEN_EXPIRED|already (installed|active)/i.test(msg)) return false;
  return /timeout|ECONN|ETIMED|503|502|504|EAI_AGAIN|stream.*reset|connection.*(reset|closed)|network/i.test(msg);
}

let _kv = null;
function kv() {
  if (!_kv) _kv = new SecretClient(KV_URI, new DefaultAzureCredential());
  return _kv;
}

/**
 * The canonical plugin matrix. Keep aligned with the memory doc.
 * `licenseTier` is the *minimum* tier that gets the paid version of the
 * plugin (Elementor Pro is Pro license at all tiers; Shield Security runs
 * on its Free version at all tiers).
 *
 * `source`:
 *   'wporg' → `wp plugin install <slug> --activate`
 *   'blob'  → SAS URL from stiadmprod/plugins/<path>
 *   'arion' → arion-api gated `/plugin/download?token=<provision_code>`
 *
 * `paidLicense` (when present) names the KV secret containing the license
 * key. The installer activates the license via wp-cli after install.
 */
export const PLUGIN_STACK = [
  // 1. Companion theme FIRST so Elementor (Pro) has its theme.
  {
    slug: 'hello-elementor',
    kind: 'theme',
    source: 'wporg',
    allTiers: true,
  },

  // 2. Free wp.org plugins — order within this group doesn't matter; we
  //    install sequentially because parallel SSH wp-cli would interleave
  //    output in our logs.
  { slug: 'seo-by-rank-math', source: 'wporg', allTiers: true },
  { slug: 'wp-mail-smtp', source: 'wporg', allTiers: true },
  { slug: 'safe-svg', source: 'wporg', allTiers: true },
  { slug: 'litespeed-cache', source: 'wporg', allTiers: true },
  { slug: 'ewww-image-optimizer', source: 'wporg', allTiers: true },
  // Advanced Custom Fields (Free) — ubiquitous field-builder dependency
  // for many themes/blueprints and an explicit Brandon-locked default.
  // Free version only registers basic field types (Repeater / Flexible /
  // Gallery / Clone / Options Pages are Pro-only); if a template needs
  // those, swap to a paid entry with the same slug.
  { slug: 'advanced-custom-fields', source: 'wporg', allTiers: true },
  // Astra Starter Templates — drives `wp starter-templates import <id>`
  // which seeds the new site from a curated Elementor template. Free tier.
  { slug: 'astra-sites', source: 'wporg', allTiers: true },
  // Shield Security (wp-simple-firewall) Free plugin from wp.org. Sensible
  // defaults out of the box — no special post-install config needed. Runs on
  // all tiers as the security baseline (WAF + login firewall).
  { slug: 'wp-simple-firewall', source: 'wporg', allTiers: true },

  // 3. Conditional — only when questionnaire's `installShop` is true. Lite
  //    tier blocks the question upstream so we never reach here for Lite.
  {
    slug: 'woocommerce',
    source: 'wporg',
    conditional: 'installShop',
    minTier: 'standard',
  },

  // 3b. Conditional — PDF Embedder only when questionnaire's `publishPdfs`
  //     is true. Free version gives a working inline viewer; Premium adds
  //     mobile/secure/full-screen features. All tiers (no minTier) — any
  //     customer publishing PDFs benefits regardless of plan.
  {
    slug: 'pdf-embedder',
    source: 'wporg',
    conditional: 'publishPdfs',
  },

  // 4a. Elementor (free) from wp.org — REQUIRED as the base for Elementor Pro.
  //     Pro is an addon to the free plugin and won't activate without it.
  { slug: 'elementor', source: 'wporg', allTiers: true },

  // 4b. Elementor Pro from Azure Blob + license activation.
  {
    slug: 'elementor-pro',
    source: 'blob',
    blobPath: 'elementor-pro/elementor-pro-latest.zip',
    paidLicense: 'elementor-pro', // KV secret name
    allTiers: true,
  },

  // 5. IA Plugin last so the provisioning manifest fires after the stack is
  //    settled. The download URL is arion-api's own `/plugin/download?token`
  //    endpoint; the caller passes that URL in.
  {
    slug: 'intelligent-analytics',
    source: 'arion',
    allTiers: true,
  },
];

const TIER_RANK = { lite: 1, standard: 2, pro: 3, business: 4, enterprise: 5 };

function tierAtLeast(actual, required) {
  return (TIER_RANK[actual] || 0) >= (TIER_RANK[required] || 0);
}

/**
 * Post-install wp-cli option-set commands keyed by plugin slug. Each command
 * runs sequentially over SSH AFTER the plugin install/activate succeeds, and
 * is re-run on the idempotent "already active" skip branch so re-provisioning
 * an existing site still re-asserts the defaults. `wp option update` is
 * idempotent (it writes the same value on every call), so re-runs are safe.
 *
 * EWWW notes (verified against docs.ewww.io 2026-06-24):
 *   - jpg_level=10 / png_level=10 → free LOCAL pixel-perfect lossless. Setting
 *     20/30/40 silently degrades to 10 without an EWWW.io API key — do NOT
 *     use 30 thinking it means "lossy free"; that's the paid Premium API.
 *   - png_level=30 is OBSOLETE — valid PNG values are 0/10/20/40/50.
 *   - webp + webp_for_cdn enable .webp generation AND the JS/<picture>
 *     rewriter (needed on nginx / LiteSpeed where .htaccess rewrites don't
 *     fire reliably).
 *   - lazy_load is INTENTIONALLY LEFT OFF: LiteSpeed Cache (also in the
 *     stack) owns lazy-loading. Enabling both double-processes <img> tags,
 *     breaks dimensions, and can hide LCP images.
 *   - jpg_quality=82 matches WP core default.
 *
 * The trailing `ewwwio optimize media --noprompt` triggers a background
 * bulk-optimize over existing media; on a freshly provisioned site the
 * library is small (just our seeded images) so this finishes quickly.
 */
export const EWWW_INSTALL_CONFIG = [
  { cmd: 'option update ewww_image_optimizer_jpg_level 10', desc: 'JPEG: free local pixel-perfect lossless' },
  { cmd: 'option update ewww_image_optimizer_png_level 10', desc: 'PNG: free local pixel-perfect lossless' },
  { cmd: 'option update ewww_image_optimizer_webp 1', desc: 'Generate .webp companion files' },
  { cmd: 'option update ewww_image_optimizer_webp_for_cdn 1', desc: 'JS/<picture> WebP delivery (nginx/LiteSpeed-safe)' },
  { cmd: 'option update ewww_image_optimizer_metadata_remove 1', desc: 'Strip EXIF metadata' },
  { cmd: 'option update ewww_image_optimizer_jpg_quality 82', desc: 'JPEG quality (matches WP core default)' },
  // Lazy load INTENTIONALLY OFF — LiteSpeed Cache owns it. See JSDoc above.
  { cmd: 'option update ewww_image_optimizer_lazy_load 0', desc: 'EWWW lazy load OFF (LiteSpeed Cache handles it)' },
  // Backfill existing media library. Best-effort, soft-fails on shared
  // hosts that block exec() if the cloud API key isn't set.
  { cmd: 'ewwwio optimize media --noprompt', desc: 'Bulk-optimize existing media library' },
];

/**
 * RankMath post-install configuration — bypasses the in-WP "Setup Wizard"
 * that fires on first activation and blocks the plugin until completed in a
 * browser. RankMath stores wizard answers across three serialized PHP
 * option arrays (`rank_math_general`, `rank_math_titles`, `rank_math_sitemap`)
 * plus a top-level `rank_math_modules` array and `rank_math_wizard_completed`
 * flag. Writing all of these via wp-cli short-circuits the wizard.
 *
 * Defaults below match what the wizard would set for a small service-business
 * (the dominant ARION client profile — Rolling In It, Briarwood Dental, MWAG):
 *   - Business type = "Small Business / Local" (knowledgegraph_type=person OR
 *     company — we pick `company` because all ARION clients are LLCs/Inc).
 *   - Knowledgegraph_name pulled from blogname at runtime (NOT hard-coded
 *     here — `${BLOGNAME}` is substituted by applyRankMathInstallConfig).
 *   - Title separator: `-` (default, neutral for service businesses).
 *   - Sitemap on for posts + pages + attachments-off (attachments-as-posts is
 *     a RankMath footgun that surfaces /?attachment_id=N URLs to Google).
 *   - Modules activated: 404-monitor (catches dead links), redirections,
 *     sitemap, rich-snippet (schema), bbpress + buddypress OFF, role-manager
 *     OFF (RankMath's role gating fights WP core capabilities; we don't want
 *     it interfering with our iaadmin user), analytics OFF (we use GA4 +
 *     GSC direct via arion-api).
 *   - Auto-update OFF (we manage plugin updates centrally).
 *
 * The actual write happens via a single `wp eval` invocation since RankMath's
 * options are PHP-serialized associative arrays — `wp option update` with a
 * --format=json flag would JSON-encode them and break the plugin's
 * `maybe_unserialize` reads. The eval'd snippet uses `update_option()` which
 * handles serialization internally.
 *
 * Idempotent — re-running update_option() with the same payload is a no-op,
 * and the wizard_completed=1 flag prevents the wizard from re-triggering on
 * subsequent activations.
 *
 * References:
 *   - rank-math/includes/wizard/class-wizard.php (step keys + option mapping)
 *   - rank-math/includes/modules/class-module-manager.php (`rank_math_modules`)
 *   - https://rankmath.com/kb/configuration-wizard/ (defaults per step)
 */
export const RANK_MATH_DEFAULTS = {
  // 'rank_math_general' option array
  general: {
    setup_mode: 'easy',
    enable_link_suggestions: 'on',
    link_suggestions_post_types: ['post', 'page'],
    nofollow_external_links: 'off',
    nofollow_image_links: 'off',
    new_window_external_links: 'on',
    add_img_alt: 'on',
    img_alt_format: '%title% %count(alt)%',
    add_img_title: 'off',
    img_title_format: '%title% %count(title)%',
    breadcrumbs: 'on',
    breadcrumbs_separator: '/',
    breadcrumbs_home: 'on',
    breadcrumbs_home_label: 'Home',
    breadcrumbs_archive_format: 'Archives for %s',
    breadcrumbs_search_format: 'Results for %s',
    breadcrumbs_404_label: '404 Error: page not found',
    usage_tracking: 'off',
  },
  // 'rank_math_titles' option array — service-business knowledge graph defaults.
  titles: {
    title_separator: '-',
    knowledgegraph_type: 'company',     // company (vs. person) — all ARION clients are businesses
    knowledgegraph_name: '${BLOGNAME}', // substituted at runtime
    knowledgegraph_logo: '',            // populated later via My Brand once logo lands
    homepage_title: '%sitename% %page% %sep% %sitedesc%',
    homepage_description: '%sitedesc%',
    homepage_custom_robots: 'off',
    post_title: '%title% %sep% %sitename%',
    post_description: '%excerpt%',
    post_custom_robots: 'off',
    post_robots: ['index'],
    post_add_meta_box: 'on',
    page_title: '%title% %sep% %sitename%',
    page_description: '%excerpt%',
    page_custom_robots: 'off',
    page_robots: ['index'],
    page_add_meta_box: 'on',
    attachment_redirect_urls: 'on',     // attachments redirect to parent post — closes the /?attachment_id leak
    attachment_redirect_default: 'attachment',
    local_seo: 'on',
    local_business_type: 'LocalBusiness',
    local_address_format: '{address} {locality}, {region} {postalcode}',
    local_address: { streetAddress: '', addressLocality: '', addressRegion: '', postalCode: '', addressCountry: 'US' },
    phone_numbers: [{ type: 'customer support', number: '' }],
    geo: '',
    opening_hours_format: 'off',
    opening_hours: [],
    maps_api_key: '',
  },
  // 'rank_math_sitemap' option array — index Pages + Posts only.
  sitemap: {
    items_per_page: 200,
    include_images: 'on',
    include_featured_image: 'on',
    exclude_roles: [],
    ping_search_engines: 'on',
    html_sitemap: 'on',
    html_sitemap_display: 'shortcode',
    html_sitemap_sort: 'published',
    html_sitemap_seo_titles: 'titles',
    posts_sitemap: 'on',
    posts_image_customfields: '',
    pages_sitemap: 'on',
    pages_image_customfields: '',
    attachment_sitemap: 'off',          // attachments OFF — leak prevention
  },
  // 'rank_math_modules' option array — activated module slugs.
  modules: [
    '404-monitor',
    'link-counter',
    'redirections',
    'rich-snippet',
    'sitemap',
    'local-seo',
    'seo-analysis',
  ],
};

/**
 * Return the ordered list of plugins to install for a given tier + options.
 *
 * @param {object} opts
 * @param {string} opts.tier             - 'lite' | 'standard' | 'pro' | 'business' | 'enterprise'
 * @param {boolean} [opts.installShop]   - questionnaire answer for "Do you need an online shop?"
 * @param {boolean} [opts.publishPdfs]   - questionnaire answer for "Do you publish PDFs?"
 * @returns {Array}                      - filtered + ordered plugin specs
 */
export function getPluginsForTier({ tier, installShop = false, publishPdfs = false }) {
  const t = String(tier || 'lite').toLowerCase();
  return PLUGIN_STACK.filter((p) => {
    if (p.allTiers) return true;
    if (p.conditional === 'installShop') {
      if (!installShop) return false;
      if (p.minTier && !tierAtLeast(t, p.minTier)) return false;
      return true;
    }
    if (p.conditional === 'publishPdfs') {
      if (!publishPdfs) return false;
      if (p.minTier && !tierAtLeast(t, p.minTier)) return false;
      return true;
    }
    return false;
  });
}

/**
 * Drive the full plugin install for a freshly-provisioned WP site over SSH.
 * Caller passes the IA Plugin download URL (built with the provision code).
 *
 * @param {object} args
 * @param {string} args.domain
 * @param {string} args.tier
 * @param {boolean} [args.installShop]
 * @param {boolean} [args.publishPdfs]
 * @param {string} args.iaPluginDownloadUrl
 * @returns {Promise<{installed: string[], skipped: string[], logs: object[]}>}
 */
export async function installPluginsForTier({ domain, tier, installShop, publishPdfs, iaPluginDownloadUrl, provisionCode, onlySlugs = null }) {
  let plan = getPluginsForTier({ tier, installShop, publishPdfs });
  // onlySlugs lets the existing-WP path install JUST the IA Plugin without
  // touching the customer's existing plugin set (paths #2/#4/#6/#8).
  if (Array.isArray(onlySlugs) && onlySlugs.length > 0) {
    const allowed = new Set(onlySlugs);
    plan = plan.filter((p) => allowed.has(p.slug));
  }
  // R2 — Critical plugins MUST install (theme + IA Plugin). Others soft-fail
  // and get surfaced in `failed` so the Portal can show a "fix this" button.
  const CRITICAL = new Set(['hello-elementor', 'intelligent-analytics']);

  const installed = [];
  const skipped = [];
  const failed = [];  // [{slug, error}]
  const logs = [];

  for (const spec of plan) {
    try {
      let res;
      if (spec.kind === 'theme' && spec.source === 'wporg') {
        res = await runWpCli(domain, `theme install ${spec.slug} --activate --force`);
      } else if (spec.source === 'wporg') {
        res = await runWpCli(domain, `plugin install ${spec.slug} --activate --force`);
        if (spec.paidLicense) {
          try { await activateLicense(domain, spec.slug, spec.paidLicense, { optional: !!spec.paidLicenseOptional, logs }); }
          catch (licErr) {
            // Optional licenses must NEVER block install — a missing KV secret
            // is the expected state today. Log it but don't surface to failed[]
            // when paidLicenseOptional=true.
            if (spec.paidLicenseOptional && /KV_SECRET_MISSING|secret.*not.*found|SecretNotFound/i.test(licErr.message)) {
              logs.push({ slug: spec.slug, step: 'license_activation', ok: true, skipped: 'optional_secret_missing' });
            } else {
              failed.push({ slug: spec.slug, error: `license activation: ${licErr.message.slice(0, 200)}` });
            }
          }
        }
      } else if (spec.source === 'blob') {
        if (!provisionCode) throw new Error(`Plugin ${spec.slug} (blob source) requires provisionCode from caller`);
        const url = `${ARION_API_BASE}/plugin/paid/${spec.slug}?token=${encodeURIComponent(provisionCode)}`;
        // 2026-06-24 — Hardened paid-plugin install (Elementor Pro fix).
        //   - Pre-flight HEAD probe of arion-api `/plugin/paid/:slug` from the
        //     remote box. Catches 404 PLUGIN_NOT_FOUND (blob missing) and 401
        //     TOKEN_INVALID/EXPIRED with clean typed errors BEFORE wp-cli ever
        //     runs — previously these produced opaque "could not download"
        //     output classified as a generic install failure.
        //   - Stage to /tmp/<slug>.zip via curl --fail-with-body --retry, then
        //     `wp plugin install /tmp/<slug>.zip --activate --force` against
        //     the LOCAL file. Two wins: real HTTP status surfaces in `failed[]`,
        //     and the zip is reusable for an immediate retry without re-paying
        //     the arion-api round-trip cost.
        //   - Retry transient download failures (network reset, 5xx) up to 3x
        //     with exponential backoff. Hard 4xx errors short-circuit.
        //   - Post-install verify via `wp plugin is-installed <slug>` so a
        //     half-extracted ZIP can't silently slip into installed[].
        // After install succeeds, license activation runs via activateLicense
        // (same path as before) and writes elementor_pro_license_key + the
        // best-effort wp-cli `elementor-pro license activate` call.
        res = await installBlobPluginViaTempZip({ domain, slug: spec.slug, url, logs });
        if (spec.paidLicense) {
          try { await activateLicense(domain, spec.slug, spec.paidLicense, { optional: !!spec.paidLicenseOptional, logs }); }
          catch (licErr) {
            if (spec.paidLicenseOptional && /KV_SECRET_MISSING|secret.*not.*found|SecretNotFound/i.test(licErr.message)) {
              logs.push({ slug: spec.slug, step: 'license_activation', ok: true, skipped: 'optional_secret_missing' });
            } else {
              failed.push({ slug: spec.slug, error: `license activation: ${licErr.message.slice(0, 200)}` });
            }
          }
        }
      } else if (spec.source === 'arion') {
        if (!iaPluginDownloadUrl) throw new Error(`Plugin ${spec.slug} requires iaPluginDownloadUrl from caller`);
        res = await runWpCli(domain, `plugin install '${iaPluginDownloadUrl}' --activate --force`);
      } else {
        throw new Error(`Unknown plugin source: ${spec.source}`);
      }
      installed.push(spec.slug);
      logs.push({ slug: spec.slug, ok: true, stdout: res.stdout.slice(0, 200) });

      // POST-INSTALL HOOKS — keyed by slug. Kept here (vs. a separate
      // post-install table) so the side-effect lives next to the install
      // it depends on and the failure mode stays inside the same try/catch.
      //
      // wp-simple-firewall (Shield) → whitelist SE Ranking's audit crawler so
      // the WAF and PHP-level rate-limiter don't 403 it. Without this, ARION
      // Intelligence reports that depend on SE Ranking (schema_coverage,
      // crawl_depth, competitive_presence) silently fail on every freshly-
      // provisioned site until ops adds the allowlist by hand. Best-effort —
      // failure here surfaces in `failed[]` but does NOT abort provisioning.
      // Shield runs on sensible defaults; no extra post-install config needed.
      if (spec.slug === 'wp-simple-firewall') {
        try {
          const wlRes = await whitelistSeRankingCrawler(domain);
          logs.push({ slug: 'wp-simple-firewall', step: 'seranking_whitelist', ok: wlRes.ok, details: wlRes.details });
          if (!wlRes.ok) {
            failed.push({ slug: 'wp-simple-firewall', error: `seranking whitelist: ${wlRes.details.slice(0, 200)}` });
          }
        } catch (wlErr) {
          logs.push({ slug: 'wp-simple-firewall', step: 'seranking_whitelist', ok: false, error: wlErr.message });
          failed.push({ slug: 'wp-simple-firewall', error: `seranking whitelist: ${wlErr.message.slice(0, 200)}` });
        }
      }

      // ewww-image-optimizer → apply Brandon-locked defaults (lossless free
      // levels, WebP on, lazy-load OFF so LiteSpeed Cache owns it) + kick a
      // background bulk-optimize for already-uploaded media. Each command is
      // idempotent — wp option update writes the same value on every call.
      // Best-effort: a single failed wp-cli line surfaces in failed[] but
      // does NOT abort provisioning.
      if (spec.slug === 'ewww-image-optimizer') {
        await applyEwwwInstallConfig(domain, logs, failed);
      }

      // seo-by-rank-math → skip the in-WP Setup Wizard by writing wizard
      // outputs directly. RankMath blocks normal admin operation until the
      // wizard completes; without this, an "onboarded" tenant lands on a
      // 6-step modal the next time they open wp-admin. Best-effort —
      // failure surfaces in failed[] but does NOT abort provisioning.
      if (spec.slug === 'seo-by-rank-math') {
        await applyRankMathInstallConfig(domain, logs, failed);
      }

      // wp-mail-smtp → route form mail through ACS SMTP (noreply@ia-dm.com) so
      // Elementor/WP form submissions actually deliver. Without this the plugin
      // installs on "Default (none)" and Hostinger throttles unauthenticated
      // PHP mail(). Best-effort; a missing KV secret surfaces in failed[].
      if (spec.slug === 'wp-mail-smtp') {
        await applyWpMailSmtpConfig(domain, logs, failed);
      }
    } catch (err) {
      // Upstream Hostinger provisioning never ran for this site — the
      // public_html directory does not exist on the box. Abort the install
      // loop with a structured signal so the runner-advance endpoint can
      // graceful-skip instead of marking the row hard-failed. Happens when
      // the row was seeded directly at status_phase='installing_plugins'
      // (test fixtures, runner walks) without the create-hosting +
      // install-wp phases having provisioned the directory.
      if (err.code === 'NO_WP_INSTALL' || err.noWpInstall) {
        const noWpErr = new Error(`no_wp_install: ${err.message}`);
        noWpErr.code = 'NO_WP_INSTALL';
        noWpErr.noWpInstall = true;
        noWpErr.firstFailedSlug = spec.slug;
        throw noWpErr;
      }
      const msg = (err.stderr || err.message || '').toString().toLowerCase();
      if (/already active|already.*activated/i.test(msg)) {
        skipped.push(spec.slug);
        logs.push({ slug: spec.slug, ok: true, skipped: true });
        // Mirror the post-install hook on the skipped-because-already-active
        // branch so idempotent re-runs of provisioning still ensure the SE
        // Ranking allowlist is in place.
        if (spec.slug === 'wp-simple-firewall') {
          try {
            const wlRes = await whitelistSeRankingCrawler(domain);
            logs.push({ slug: 'wp-simple-firewall', step: 'seranking_whitelist', ok: wlRes.ok, details: wlRes.details, viaSkippedBranch: true });
            if (!wlRes.ok) {
              failed.push({ slug: 'wp-simple-firewall', error: `seranking whitelist (post-skip): ${wlRes.details.slice(0, 200)}` });
            }
          } catch (wlErr) {
            logs.push({ slug: 'wp-simple-firewall', step: 'seranking_whitelist', ok: false, error: wlErr.message });
            failed.push({ slug: 'wp-simple-firewall', error: `seranking whitelist (post-skip): ${wlErr.message.slice(0, 200)}` });
          }
        }
        // EWWW: re-assert defaults on idempotent skip — wp option update is
        // safe to re-run and the bulk-optimize will short-circuit if nothing
        // new needs optimizing.
        if (spec.slug === 'ewww-image-optimizer') {
          await applyEwwwInstallConfig(domain, logs, failed, { viaSkippedBranch: true });
        }
        // RankMath: re-assert wizard-complete + defaults on idempotent skip.
        // Covers the case where RankMath's auto-update re-arms the wizard
        // (it has done this on some 1.0.x → 1.0.y bumps).
        if (spec.slug === 'seo-by-rank-math') {
          await applyRankMathInstallConfig(domain, logs, failed, { viaSkippedBranch: true });
        }
        // wp-mail-smtp: re-assert the ACS SMTP config on idempotent skip so a
        // re-provision (or a plugin auto-update that reset options) keeps form
        // mail wired to noreply@ia-dm.com.
        if (spec.slug === 'wp-mail-smtp') {
          await applyWpMailSmtpConfig(domain, logs, failed, { viaSkippedBranch: true });
        }
      } else if (CRITICAL.has(spec.slug)) {
        logs.push({ slug: spec.slug, ok: false, error: err.message });
        throw new Error(`Critical plugin install failed for ${spec.slug}: ${err.message}`);
      } else {
        failed.push({ slug: spec.slug, error: err.message.slice(0, 300) });
        logs.push({ slug: spec.slug, ok: false, error: err.message });
      }
    }
  }

  return { installed, skipped, failed, logs };
}

/**
 * Apply WP Mail SMTP config via wp-cli — routes ALL WordPress/Elementor form
 * mail through Azure Communication Services SMTP (smtp.azurecomm.net) using the
 * shared, verified sender noreply@ia-dm.com. Fixes the default unauthenticated
 * PHP mail() path that Hostinger throttles/blocks → "form submission failed"
 * (see IA WP Mail SMTP SOP). ACS SMTP supports basic username/password auth, so
 * the generic "Other SMTP" mailer works.
 *
 * Credential = the ACS Entra-app client secret in KV `ACS-SMTP-PASSWORD`
 * (send-only, revocable — NOT a mailbox password). Unlike the optional EWWW
 * cloud key, this one is REQUIRED for forms to send: if it's absent we do NOT
 * abort provisioning, but we push to failed[] + log clearly so onboarding shows
 * email isn't wired yet.
 *
 * Idempotent — `wp option update wp_mail_smtp --format=json` writes the same
 * value every call. smtp.pass is redacted in logs.
 */
async function applyWpMailSmtpConfig(domain, logs, failed, { viaSkippedBranch = false } = {}) {
  const slug = 'wp-mail-smtp';
  const tag = viaSkippedBranch ? { viaSkippedBranch: true } : {};
  let pass = null;
  try {
    const secret = await kv().getSecret('ACS-SMTP-PASSWORD');
    pass = (secret && secret.value && String(secret.value).trim()) || null;
  } catch (kvErr) {
    logs.push({ slug, step: 'kv:ACS-SMTP-PASSWORD', ok: false, error: `kv lookup: ${kvErr.message.slice(0, 160)}`, ...tag });
  }
  if (!pass) {
    const msg = 'ACS-SMTP-PASSWORD not set in Key Vault — form email NOT configured (set the secret, then re-run provisioning).';
    logs.push({ slug, step: 'configure wp_mail_smtp', ok: false, error: msg, ...tag });
    failed.push({ slug, error: `${viaSkippedBranch ? 'config (post-skip)' : 'config'}: ${msg}` });
    return;
  }
  // WP Mail SMTP "Other SMTP" mailer. encryption 'tls' = STARTTLS on port 587.
  // from_email_force ON so EVERY plugin/theme mail uses the verified sender
  // (fixes the Section-6 "From pointed at the wrong address" failure mode).
  const optionValue = {
    mail: { from_email: 'noreply@ia-dm.com', from_name: '', mailer: 'smtp', from_email_force: true, from_name_force: false, return_path: false },
    smtp: { host: 'smtp.azurecomm.net', port: 587, encryption: 'tls', autotls: true, auth: true, user: 'noreply@ia-dm.com', pass },
  };
  const json = JSON.stringify(optionValue).replace(/'/g, `'\\''`);
  try {
    const res = await runWpCli(domain, `option update wp_mail_smtp --format=json '${json}'`);
    logs.push({ slug, step: 'option update wp_mail_smtp <smtp.pass redacted>', desc: 'Route form mail through ACS SMTP (noreply@ia-dm.com)', ok: true, stdout: (res.stdout || '').slice(0, 200), ...tag });
  } catch (cfgErr) {
    logs.push({ slug, step: 'option update wp_mail_smtp <redacted>', ok: false, error: cfgErr.message, ...tag });
    failed.push({ slug, error: `${viaSkippedBranch ? 'config (post-skip)' : 'config'}: wp_mail_smtp set: ${cfgErr.message.slice(0, 160)}` });
  }
}

/**
 * Apply EWWW Image Optimizer install-time configuration via wp-cli over SSH.
 * Iterates EWWW_INSTALL_CONFIG sequentially; each command is best-effort and
 * failures are pushed to `failed[]` (NOT thrown) so a single misbehaving
 * option setter doesn't abort the rest of the stack.
 *
 * Idempotent by construction — `wp option update` writes the same value on
 * every call, and `ewwwio optimize media --noprompt` short-circuits when
 * there's nothing left to optimize.
 *
 * PAID CLOUD KEY (OPTIONAL): if KV secret `EWWW-CLOUD-KEY` exists and is
 * non-empty, we pre-seed `ewww_image_optimizer_cloud_key` so EWWW.io API
 * (lossy compression, AVIF, larger PDF/JPG limits) lights up immediately
 * for new sites. Missing/empty/404 secret → silently skip — the free
 * defaults in EWWW_INSTALL_CONFIG keep the plugin fully functional without
 * a paid key. Read once per call (cache miss is fine, sites are small N).
 */
async function applyEwwwInstallConfig(domain, logs, failed, { viaSkippedBranch = false } = {}) {
  // STEP 0 — Optional EWWW.io cloud key. Best-effort: a missing KV secret is
  // the EXPECTED state today (no paid plan yet) and must not surface as a
  // failure. We only push to failed[] if the secret EXISTS but the wp-cli
  // write blows up, which would indicate a real provisioning problem.
  try {
    let cloudKey = null;
    try {
      const secret = await kv().getSecret('EWWW-CLOUD-KEY');
      cloudKey = (secret && secret.value && String(secret.value).trim()) || null;
    } catch (kvErr) {
      // SecretNotFound / 404 / Forbidden → treat as "no paid plan, use free
      // defaults." Log at info level so the runner trail still shows we
      // checked. Do NOT push to failed[] — this is the default state.
      logs.push({
        slug: 'ewww-image-optimizer',
        step: 'kv:EWWW-CLOUD-KEY',
        desc: 'Optional EWWW.io cloud key (free defaults if absent)',
        ok: true,
        skipped: true,
        reason: `kv lookup: ${kvErr.message.slice(0, 160)}`,
        ...(viaSkippedBranch ? { viaSkippedBranch: true } : {}),
      });
    }
    if (cloudKey) {
      try {
        const escaped = cloudKey.replace(/'/g, `'\\''`);
        const res = await runWpCli(domain, `option update ewww_image_optimizer_cloud_key '${escaped}'`);
        logs.push({
          slug: 'ewww-image-optimizer',
          step: 'option update ewww_image_optimizer_cloud_key <redacted>',
          desc: 'EWWW.io paid cloud key — enables lossy/AVIF/larger limits',
          ok: true,
          stdout: (res.stdout || '').slice(0, 200),
          ...(viaSkippedBranch ? { viaSkippedBranch: true } : {}),
        });
      } catch (cfgErr) {
        logs.push({
          slug: 'ewww-image-optimizer',
          step: 'option update ewww_image_optimizer_cloud_key <redacted>',
          desc: 'EWWW.io paid cloud key',
          ok: false,
          error: cfgErr.message,
          ...(viaSkippedBranch ? { viaSkippedBranch: true } : {}),
        });
        failed.push({
          slug: 'ewww-image-optimizer',
          error: `${viaSkippedBranch ? 'config (post-skip)' : 'config'}: cloud_key set: ${cfgErr.message.slice(0, 160)}`,
        });
      }
    }
  } catch (outerErr) {
    // Belt-and-suspenders: if kv() itself blows up (unlikely; same singleton
    // used elsewhere), don't take down the rest of the config loop.
    logs.push({
      slug: 'ewww-image-optimizer',
      step: 'kv:EWWW-CLOUD-KEY',
      ok: false,
      error: outerErr.message,
      ...(viaSkippedBranch ? { viaSkippedBranch: true } : {}),
    });
  }

  for (const step of EWWW_INSTALL_CONFIG) {
    try {
      const res = await runWpCli(domain, step.cmd);
      logs.push({
        slug: 'ewww-image-optimizer',
        step: step.cmd,
        desc: step.desc,
        ok: true,
        stdout: (res.stdout || '').slice(0, 200),
        ...(viaSkippedBranch ? { viaSkippedBranch: true } : {}),
      });
    } catch (cfgErr) {
      logs.push({
        slug: 'ewww-image-optimizer',
        step: step.cmd,
        desc: step.desc,
        ok: false,
        error: cfgErr.message,
        ...(viaSkippedBranch ? { viaSkippedBranch: true } : {}),
      });
      failed.push({
        slug: 'ewww-image-optimizer',
        error: `${viaSkippedBranch ? 'config (post-skip)' : 'config'}: ${step.cmd}: ${cfgErr.message.slice(0, 160)}`,
      });
    }
  }
}

/**
 * Apply RankMath install-time configuration via wp-cli over SSH, bypassing the
 * in-WP Setup Wizard. RankMath's wizard is a 6-step modal that blocks normal
 * admin operation on first activation; without writing the wizard outputs
 * directly, every freshly-provisioned tenant lands on the wizard on first
 * wp-admin visit.
 *
 * Strategy:
 *   1. Fetch the current `blogname` via `wp option get` so the knowledgegraph
 *      `name` field gets the live site title (rather than a hard-coded
 *      placeholder). This is the one field whose default depends on per-site
 *      runtime state.
 *   2. Build the three RankMath option arrays from RANK_MATH_DEFAULTS,
 *      substituting `${BLOGNAME}` in `knowledgegraph_name`.
 *   3. Write all four options (`rank_math_general`, `rank_math_titles`,
 *      `rank_math_sitemap`, `rank_math_modules`) plus the wizard-completed
 *      flags in ONE `wp eval` call so RankMath's `update_option` hooks see
 *      a single consistent flush rather than four partial states.
 *   4. Wizard-complete markers written: `rank_math_registration_skip = 1`,
 *      `rank_math_wizard_completed = 1`, `rank_math_wizard_step = done`,
 *      `rank_math_is_configured = 1`. Each is checked at a different
 *      decision point in RankMath's wizard router — covering all of them
 *      avoids version-specific re-trigger bugs.
 *   5. Flush rewrites so the sitemap permastructs (`/sitemap_index.xml`)
 *      register without an admin visit.
 *
 * Idempotent — every option write replaces in-place; re-running yields the
 * same end state with no errors.
 *
 * Best-effort: any single sub-step failure is pushed to failed[] but does NOT
 * abort the rest of the stack. RankMath is non-critical to the install — if
 * the wizard write fails, the customer can complete it manually in wp-admin
 * (the same fallback that exists today before this fix).
 */
async function applyRankMathInstallConfig(domain, logs, failed, { viaSkippedBranch = false } = {}) {
  const tag = viaSkippedBranch ? 'config (post-skip)' : 'config';

  // STEP 1 — Pull live blogname for the knowledgegraph_name substitution.
  let blogname = '';
  try {
    const r = await runWpCli(domain, 'option get blogname');
    blogname = (r.stdout || '').trim();
  } catch (err) {
    logs.push({
      slug: 'seo-by-rank-math',
      step: 'option get blogname',
      ok: false,
      error: err.message,
      ...(viaSkippedBranch ? { viaSkippedBranch: true } : {}),
    });
    // Continue without blogname — the rest of the wizard config is more
    // important than this one field. blogname='' just means knowledgegraph
    // gets an empty name, which the customer can fix in My Brand later.
  }

  // STEP 2 — Materialize the option payloads with runtime substitution.
  const titles = { ...RANK_MATH_DEFAULTS.titles };
  if (titles.knowledgegraph_name === '${BLOGNAME}') {
    titles.knowledgegraph_name = blogname || '';
  }

  const payload = {
    general: RANK_MATH_DEFAULTS.general,
    titles,
    sitemap: RANK_MATH_DEFAULTS.sitemap,
    modules: RANK_MATH_DEFAULTS.modules,
  };

  // STEP 3 — Write all four options + wizard-complete markers in one eval.
  // We pass the payload as JSON, then PHP-decode + update_option inside the
  // snippet. This keeps the shell-escaping surface small (JSON has no '$' or
  // backtick to worry about, and JSON.stringify handles inner quotes).
  const payloadJson = JSON.stringify(payload);
  const phpSnippet = [
    `$p = json_decode(${JSON.stringify(payloadJson)}, true);`,
    `if (!is_array($p)) { echo 'RM_PAYLOAD_BAD'; return; }`,
    // update_option handles serialization for associative arrays.
    `update_option('rank_math_general', $p['general']);`,
    `update_option('rank_math_titles', $p['titles']);`,
    `update_option('rank_math_sitemap', $p['sitemap']);`,
    `update_option('rank_math_modules', $p['modules']);`,
    // Wizard-completion markers (cover every code path RankMath checks).
    `update_option('rank_math_registration_skip', 1);`,
    `update_option('rank_math_wizard_completed', 1);`,
    `update_option('rank_math_wizard_step', 'done');`,
    `update_option('rank_math_is_configured', 1);`,
    // Suppress the "connect your account" admin notice that lives outside the
    // wizard but pops on every admin page until dismissed.
    `update_option('rank_math_already_install', current_time('mysql'));`,
    `update_option('rank_math_first_install', current_time('mysql'));`,
    // Flush rewrites so /sitemap_index.xml registers without an admin visit.
    `if (function_exists('flush_rewrite_rules')) { flush_rewrite_rules(false); }`,
    `echo 'RM_CONFIG_OK';`,
  ].join(' ');

  try {
    const evalRes = await runWpCli(domain, `eval ${JSON.stringify(phpSnippet)}`);
    const out = (evalRes.stdout || '').trim();
    if (out.includes('RM_PAYLOAD_BAD')) {
      logs.push({ slug: 'seo-by-rank-math', step: 'install_config', ok: false, error: 'json_decode failed inside wp eval', ...(viaSkippedBranch ? { viaSkippedBranch: true } : {}) });
      failed.push({ slug: 'seo-by-rank-math', error: `${tag}: payload json_decode failed in wp eval` });
      return;
    }
    if (!out.includes('RM_CONFIG_OK')) {
      logs.push({ slug: 'seo-by-rank-math', step: 'install_config', ok: false, error: `unexpected stdout: ${out.slice(0, 200)}`, ...(viaSkippedBranch ? { viaSkippedBranch: true } : {}) });
      failed.push({ slug: 'seo-by-rank-math', error: `${tag}: unexpected stdout '${out.slice(0, 120)}'` });
      return;
    }
    logs.push({
      slug: 'seo-by-rank-math',
      step: 'install_config',
      ok: true,
      applied: ['rank_math_general', 'rank_math_titles', 'rank_math_sitemap', 'rank_math_modules', 'rank_math_wizard_completed'],
      blogname: blogname || '(empty)',
      ...(viaSkippedBranch ? { viaSkippedBranch: true } : {}),
    });
  } catch (cfgErr) {
    logs.push({ slug: 'seo-by-rank-math', step: 'install_config', ok: false, error: cfgErr.message, ...(viaSkippedBranch ? { viaSkippedBranch: true } : {}) });
    failed.push({ slug: 'seo-by-rank-math', error: `${tag}: ${cfgErr.message.slice(0, 200)}` });
  }
}

/**
 * Install a `source: 'blob'` plugin (today: just elementor-pro) via the
 * staged-tempfile path. Replaces the previous one-shot
 * `wp plugin install '<URL>' --activate --force` which:
 *   (a) hides the upstream HTTP status from us (wp-cli says "could not
 *       download" whether the response was a 404 PLUGIN_NOT_FOUND or a 500),
 *   (b) is not retriable per-step (the whole thing either works or doesn't),
 *   (c) classifies a missing-blob into a generic non-critical failure,
 *       letting elementor-pro silently never install on Pro-tier sites.
 *
 * New flow:
 *   1. HEAD probe `${url}` from the remote box. Distinguishes:
 *        404 → blob_missing (typed, NOT retried — ops must upload)
 *        401 → token_invalid_or_expired (typed, NOT retried — caller bug)
 *        5xx → download_failed (retried with backoff)
 *        2xx → proceed
 *   2. GET the zip to /tmp/<slug>-install.zip with curl --fail-with-body
 *      --retry 2 (so we still benefit from curl's built-in transient retry
 *      on top of our outer retry).
 *   3. Verify size > 100KB (legit elementor-pro is ~3.8MB; a sub-100KB response
 *      is almost certainly an error body or stub).
 *   4. `wp plugin install /tmp/<slug>-install.zip --activate --force` against
 *      the local file.
 *   5. Verify with `wp plugin is-installed <slug>` (exit 0 = installed).
 *   6. Clean up the tempfile.
 *
 * Returns the wp-cli install result (so the caller can read stdout in logs[]).
 * Throws on terminal failure (blob_missing, token_invalid, persistent 5xx,
 * size check fail, wp-cli install rejection). The outer install loop's
 * catch records the error in failed[]/CRITICAL branch as usual.
 *
 * @param {object} args
 * @param {string} args.domain
 * @param {string} args.slug
 * @param {string} args.url         arion-api `/plugin/paid/:slug?token=<provisionCode>` URL
 * @param {Array}  [args.logs]      install-loop logs[] for stepwise breadcrumbs
 * @param {number} [args.minBytes]  minimum acceptable zip size (default 100KB)
 * @returns {Promise<{stdout:string,stderr:string,code:number}>}
 */
async function installBlobPluginViaTempZip({ domain, slug, url, logs = null, minBytes = 100 * 1024 }) {
  const tmpPath = `/tmp/ia-plugin-${slug}-${Date.now()}.zip`;
  // Escape single quotes in URL for safe embedding inside the shell command.
  const safeUrl = url.replace(/'/g, `'\\''`);

  // Step 1 — HEAD probe. Use curl -I (HEAD) with --fail to get a non-zero exit
  // on >=400 responses, but capture the HTTP status code from -w '%{http_code}'
  // so we can distinguish 404 vs 401 vs 5xx in the failure path.
  const probeCmd = `curl -sS -o /dev/null -w '%{http_code}' -I '${safeUrl}' || echo 'curl_err'`;
  let probeStatus;
  try {
    const probe = await runSshCommand(probeCmd);
    probeStatus = ((probe.stdout || '') + (probe.stderr || '')).trim().slice(-3);
  } catch (probeErr) {
    if (logs) logs.push({ slug, step: 'preflight', ok: false, error: `probe transport: ${probeErr.message.slice(0, 200)}` });
    throw new Error(`paid plugin preflight transport failed: ${probeErr.message}`);
  }
  if (probeStatus === '404') {
    const err = new Error(`blob_missing: arion-api returned 404 PLUGIN_NOT_FOUND for ${slug}. Upload via scripts/upload-${slug}.mjs (target: stiadmprod/plugins/${slug}/${slug}-latest.zip).`);
    err.code = 'PLUGIN_NOT_FOUND';
    if (logs) logs.push({ slug, step: 'preflight', ok: false, httpStatus: 404, error: 'blob_missing' });
    throw err;
  }
  if (probeStatus === '401' || probeStatus === '403') {
    const err = new Error(`token_invalid_or_expired: arion-api returned ${probeStatus} for ${slug} — provision code may be expired or revoked.`);
    err.code = 'TOKEN_INVALID';
    if (logs) logs.push({ slug, step: 'preflight', ok: false, httpStatus: Number(probeStatus), error: 'token_invalid_or_expired' });
    throw err;
  }
  if (!probeStatus || !/^2\d\d$/.test(probeStatus)) {
    // 5xx or unexpected — fall through to retry path. Don't throw yet; curl
    // download below has its own --retry that may succeed.
    if (logs) logs.push({ slug, step: 'preflight', ok: false, httpStatus: probeStatus, note: 'non-2xx, attempting download with retry' });
  } else {
    if (logs) logs.push({ slug, step: 'preflight', ok: true, httpStatus: Number(probeStatus) });
  }

  // Step 2 — Download to tempfile, with retry. We wrap in retryWithBackoff so
  // a network reset between probe and GET still gets a shot. curl's own
  // --retry handles in-process transient drops; the outer retry handles
  // entire-attempt failures.
  await retryWithBackoff(
    async (attempt) => {
      // --fail-with-body: non-zero exit on 4xx/5xx but still write body to file
      //   (so curl_err captures the JSON error envelope for log inspection).
      // --retry 2 --retry-delay 2: curl-level transient retry.
      // -w '%{http_code}': writes the final HTTP status to stdout for parsing.
      const downloadCmd = `curl -sS --fail-with-body --retry 2 --retry-delay 2 -o ${tmpPath} -w '%{http_code}' '${safeUrl}'`;
      const dl = await runSshCommand(downloadCmd);
      const status = ((dl.stdout || '') + '').trim().slice(-3);
      if (!/^2\d\d$/.test(status)) {
        // Capture the response body for the error message (curl wrote it to
        // tmpPath when --fail-with-body kicked in).
        let body = '';
        try {
          const peek = await runSshCommand(`head -c 400 ${tmpPath} 2>/dev/null || true`);
          body = (peek.stdout || '').slice(0, 400);
        } catch (_) { /* ignore */ }
        throw new Error(`download_failed: HTTP ${status || '???'} from arion-api${body ? ` — body: ${body}` : ''}`);
      }
    },
    {
      attempts: 3,
      backoffMs: [1000, 3000, 7000],
      label: `download ${slug}`,
      isRetriable: (err) => {
        const m = (err.message || '').toString();
        // Don't retry on terminal errors. PLUGIN_NOT_FOUND already caught above;
        // here we'd see download_failed: HTTP 4xx for token issues if the probe
        // was racy.
        if (/HTTP 40[134]/.test(m)) return false;
        return /HTTP 5\d\d|HTTP \?\?\?|timeout|reset|ECONN|network/i.test(m);
      },
    },
  );

  // Step 3 — Size check. A "successful" 200 that's tiny is almost certainly
  // an error stub or empty body that slipped past --fail. The legit Elementor
  // Pro zip is ~3.8MB; anything < 100KB is rejected.
  let sizeBytes = 0;
  try {
    const sizeRes = await runSshCommand(`stat -c%s ${tmpPath} 2>/dev/null || wc -c < ${tmpPath}`);
    sizeBytes = Number(((sizeRes.stdout || '').trim().split(/\s+/)[0] || '0'));
  } catch (sizeErr) {
    if (logs) logs.push({ slug, step: 'size_check', ok: false, error: sizeErr.message.slice(0, 200) });
    sizeBytes = 0;
  }
  if (!sizeBytes || sizeBytes < minBytes) {
    // Clean up before throwing — don't leave a stub on disk for ops to wonder about.
    await runSshCommand(`rm -f ${tmpPath}`).catch(() => {});
    const err = new Error(`download_too_small: ${slug} ZIP was ${sizeBytes} bytes (expected >= ${minBytes}). Likely an error response body, not a real plugin archive.`);
    err.code = 'DOWNLOAD_TOO_SMALL';
    if (logs) logs.push({ slug, step: 'size_check', ok: false, sizeBytes });
    throw err;
  }
  if (logs) logs.push({ slug, step: 'download', ok: true, sizeBytes, tmpPath });

  // Step 4 — Install from local file.
  let installRes;
  try {
    installRes = await runWpCli(domain, `plugin install ${tmpPath} --activate --force`);
  } catch (installErr) {
    await runSshCommand(`rm -f ${tmpPath}`).catch(() => {});
    // Re-throw with a typed prefix so the dashboard can distinguish from a
    // download_failed (which would have a different fix path).
    const wrapped = new Error(`install_failed: wp plugin install rejected /tmp ZIP for ${slug}: ${(installErr.stderr || installErr.message || '').toString().slice(0, 240)}`);
    wrapped.code = installErr.code || 'INSTALL_FAILED';
    wrapped.noWpInstall = installErr.noWpInstall;
    if (installErr.noWpInstall) wrapped.code = 'NO_WP_INSTALL';
    throw wrapped;
  }

  // Step 5 — Verify with `wp plugin is-installed`. wp-cli returns exit 0 if
  // installed, non-zero otherwise. If exit non-zero, the prior install line
  // claimed success but the plugin is somehow not present — surface clearly.
  try {
    await runWpCli(domain, `plugin is-installed ${slug}`);
    if (logs) logs.push({ slug, step: 'verify_installed', ok: true });
  } catch (verifyErr) {
    await runSshCommand(`rm -f ${tmpPath}`).catch(() => {});
    const err = new Error(`install_unverified: ${slug} install command succeeded but plugin is-installed returned exit ${verifyErr.exitCode ?? verifyErr.code}. Filesystem extraction likely failed silently.`);
    err.code = 'INSTALL_UNVERIFIED';
    throw err;
  }

  // Step 6 — Cleanup tempfile (best-effort; don't fail the install if rm errors).
  await runSshCommand(`rm -f ${tmpPath}`).catch(() => {});
  return installRes;
}

/**
 * Activate a paid plugin's license via wp-cli. Per-plugin commands differ;
 * we dispatch on slug. New paid plugins added to the stack need a branch here.
 */
async function activateLicense(domain, slug, kvSecretName, { optional = false, logs = null } = {}) {
  // Fetch the KV secret. When `optional` is true (not every IA tenant has a
  // paid license today), a missing secret throws a normalized
  // KV_SECRET_MISSING error that the caller swallows silently.
  let licenseKey;
  try {
    const secret = await kv().getSecret(kvSecretName);
    licenseKey = secret.value;
  } catch (kvErr) {
    const status = kvErr.statusCode || kvErr.code;
    const looksMissing = status === 404
      || /SecretNotFound|not found|was not found/i.test(kvErr.message || '');
    if (optional && looksMissing) {
      const err = new Error(`KV_SECRET_MISSING:${kvSecretName}`);
      err.kvSecretMissing = true;
      throw err;
    }
    throw kvErr;
  }
  if (!licenseKey) {
    if (optional) {
      const err = new Error(`KV_SECRET_MISSING:${kvSecretName} (empty value)`);
      err.kvSecretMissing = true;
      throw err;
    }
    throw new Error(`license key empty in KV secret ${kvSecretName}`);
  }

  if (slug === 'elementor-pro') {
    // Elementor Pro: the `wp elementor-pro license activate` CLI was added in
    // Pro 3.20 and removed/renamed in 4.x. We always set the option key
    // first — Elementor's license registration checks this on admin_init
    // regardless of CLI. The CLI call is BEST-EFFORT: a failure (invalid key,
    // CLI not available on older Pro releases, license-server rate-limit) is
    // logged but does NOT throw, because the option-write alone is enough for
    // Elementor to activate the license on next admin_init. The plugin still
    // works without an active license; the dashboard's plugins_failed list
    // would only have surfaced "license activate" errors that ops can fix
    // later in wp-admin Settings → License.
    //
    // R5 2026-06-24 — Option-update IS hard-failed (because if we can't write
    // elementor_pro_license_key, the license is definitely not going to
    // activate). The CLI call is logged but soft-failed.
    await runWpCli(domain, `option update elementor_pro_license_key '${licenseKey}'`);
    if (logs) logs.push({ slug, step: 'license_option_written', ok: true });
    try {
      const actRes = await runWpCli(domain, `elementor-pro license activate '${licenseKey}'`);
      if (logs) logs.push({ slug, step: 'license_cli_activate', ok: true, stdout: (actRes.stdout || '').slice(0, 200) });
    } catch (cliErr) {
      // Soft-fail: option-write is the canonical activation channel; the CLI
      // is a nicety. Logged so ops sees it in provisioning_details_json.
      const msg = (cliErr.stderr || cliErr.message || '').toString().slice(0, 240);
      console.warn(`[pluginStack] elementor-pro CLI license activate failed (option already written; continuing): ${msg}`);
      if (logs) logs.push({ slug, step: 'license_cli_activate', ok: false, error: msg, note: 'option write succeeded — Elementor will pick up on next admin_init' });
    }
    return;
  }

  // Slot for future paid plugins (RankMath Pro, WP Rocket, etc.) when
  // Brandon decides to add them. Unknown slug → throw so the caller's
  // catch records "unmapped license slug" in failed[] and the dashboard
  // surfaces it instead of letting the paid license silently no-op.
  // R5 2026-06-24 — Previously console.warn'd; now thrown.
  throw new Error(`no license-activation handler for ${slug} (unmapped paid plugin — add a branch in activateLicense)`);
}

export default { PLUGIN_STACK, EWWW_INSTALL_CONFIG, RANK_MATH_DEFAULTS, getPluginsForTier, installPluginsForTier };
