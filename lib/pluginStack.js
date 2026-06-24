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

import { runWpCli, whitelistSeRankingCrawler } from './hostingerSsh.js';
import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';

const KV_URI = process.env.KEY_VAULT_URI || 'https://kv-iadm-prod.vault.azure.net/';
const ARION_API_BASE = (process.env.ARION_API_BASE_URL
  || 'https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net').replace(/\/+$/, '');

let _kv = null;
function kv() {
  if (!_kv) _kv = new SecretClient(KV_URI, new DefaultAzureCredential());
  return _kv;
}

/**
 * The canonical plugin matrix. Keep aligned with the memory doc.
 * `licenseTier` is the *minimum* tier that gets the paid version of the
 * plugin (Elementor Pro is Pro license at all tiers; Wordfence Premium is
 * deferred until revenue, so all tiers stay on Free for now).
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
  // Wordfence Free plugin from wp.org; if a Premium license is present in
  // KV (`wordfence-license`), the install flow will try to activate Premium
  // features via wp option + Wordfence's own API call. Falls back silently
  // to Free if activation fails — customer can finish in wp-admin.
  {
    slug: 'wordfence',
    source: 'wporg',
    paidLicense: 'wordfence-license',
    allTiers: true,
  },

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
          try { await activateLicense(domain, spec.slug, spec.paidLicense); }
          catch (licErr) { failed.push({ slug: spec.slug, error: `license activation: ${licErr.message.slice(0, 200)}` }); }
        }
      } else if (spec.source === 'blob') {
        if (!provisionCode) throw new Error(`Plugin ${spec.slug} (blob source) requires provisionCode from caller`);
        const url = `${ARION_API_BASE}/plugin/paid/${spec.slug}?token=${encodeURIComponent(provisionCode)}`;
        res = await runWpCli(domain, `plugin install '${url}' --activate --force`);
        if (spec.paidLicense) {
          try { await activateLicense(domain, spec.slug, spec.paidLicense); }
          catch (licErr) { failed.push({ slug: spec.slug, error: `license activation: ${licErr.message.slice(0, 200)}` }); }
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
      // wordfence → whitelist SE Ranking's audit crawler so the WAF and
      // PHP-level rate-limiter don't 403 it. Without this, ARION Intelligence
      // reports that depend on SE Ranking (schema_coverage, crawl_depth,
      // competitive_presence) silently fail on every freshly-provisioned
      // site until ops adds the allowlist by hand. Best-effort — failure
      // here surfaces in `failed[]` but does NOT abort provisioning.
      if (spec.slug === 'wordfence') {
        try {
          const wlRes = await whitelistSeRankingCrawler(domain);
          logs.push({ slug: 'wordfence', step: 'seranking_whitelist', ok: wlRes.ok, details: wlRes.details });
          if (!wlRes.ok) {
            failed.push({ slug: 'wordfence', error: `seranking whitelist: ${wlRes.details.slice(0, 200)}` });
          }
        } catch (wlErr) {
          logs.push({ slug: 'wordfence', step: 'seranking_whitelist', ok: false, error: wlErr.message });
          failed.push({ slug: 'wordfence', error: `seranking whitelist: ${wlErr.message.slice(0, 200)}` });
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
        // Ranking allowlist is in place (Wordfence Free re-applies defaults
        // on certain auto-updates).
        if (spec.slug === 'wordfence') {
          try {
            const wlRes = await whitelistSeRankingCrawler(domain);
            logs.push({ slug: 'wordfence', step: 'seranking_whitelist', ok: wlRes.ok, details: wlRes.details, viaSkippedBranch: true });
            if (!wlRes.ok) {
              failed.push({ slug: 'wordfence', error: `seranking whitelist (post-skip): ${wlRes.details.slice(0, 200)}` });
            }
          } catch (wlErr) {
            logs.push({ slug: 'wordfence', step: 'seranking_whitelist', ok: false, error: wlErr.message });
            failed.push({ slug: 'wordfence', error: `seranking whitelist (post-skip): ${wlErr.message.slice(0, 200)}` });
          }
        }
        // EWWW: re-assert defaults on idempotent skip — wp option update is
        // safe to re-run and the bulk-optimize will short-circuit if nothing
        // new needs optimizing.
        if (spec.slug === 'ewww-image-optimizer') {
          await applyEwwwInstallConfig(domain, logs, failed, { viaSkippedBranch: true });
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
 * Apply EWWW Image Optimizer install-time configuration via wp-cli over SSH.
 * Iterates EWWW_INSTALL_CONFIG sequentially; each command is best-effort and
 * failures are pushed to `failed[]` (NOT thrown) so a single misbehaving
 * option setter doesn't abort the rest of the stack.
 *
 * Idempotent by construction — `wp option update` writes the same value on
 * every call, and `ewwwio optimize media --noprompt` short-circuits when
 * there's nothing left to optimize.
 */
async function applyEwwwInstallConfig(domain, logs, failed, { viaSkippedBranch = false } = {}) {
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
 * Activate a paid plugin's license via wp-cli. Per-plugin commands differ;
 * we dispatch on slug. New paid plugins added to the stack need a branch here.
 */
async function activateLicense(domain, slug, kvSecretName) {
  const secret = await kv().getSecret(kvSecretName);
  const licenseKey = secret.value;

  if (slug === 'elementor-pro') {
    // Elementor Pro: the `wp elementor-pro license activate` CLI was added in
    // Pro 3.20 and removed/renamed in 4.x. We always set the option key
    // first — Elementor's license registration checks this on admin_init
    // regardless of CLI. Then we attempt the CLI call BEST-EFFORT and
    // swallow ALL failures (invalid key, CLI not available, etc.) so a
    // missing/wrong license doesn't block site provisioning. The plugin
    // still works without an active license; Elementor just shows a
    // notice in wp-admin that the customer (or ops) can resolve later.
    await runWpCli(domain, `option update elementor_pro_license_key '${licenseKey}'`);
    try {
      await runWpCli(domain, `elementor-pro license activate '${licenseKey}'`);
    } catch (err) {
      console.warn(`[pluginStack] elementor-pro license activation failed (best-effort, continuing): ${err.message.slice(0, 200)}`);
    }
    return;
  }

  if (slug === 'wordfence') {
    // Wordfence Premium activation: set the API key + isPaid flag via wfConfig.
    // The actual server-side license sync happens on Wordfence's next scheduled
    // sync. Customer can also click "Activate License" in wp-admin if needed.
    // Keep the eval'd PHP minimal — older wp-cli phars wrap eval'd code in a
    // way that's intolerant of complex expressions (parse errors on `(new X)->`).
    try {
      const escaped = licenseKey.replace(/'/g, `'\\''`);
      const phpSnippet = `if (!class_exists('wfConfig')) { echo 'wordfence: plugin not loaded'; return; } wfConfig::set('apiKey', '${escaped}'); wfConfig::set('isPaid', 1); echo 'wordfence: license-key set';`;
      await runWpCli(domain, `eval ${JSON.stringify(phpSnippet)}`);
    } catch (err) {
      console.warn(`[pluginStack] wordfence license activation failed (best-effort, continuing): ${err.message.slice(0, 200)}`);
    }
    return;
  }

  // Slot for future paid plugins (RankMath Pro, WP Rocket, etc.) when
  // Brandon decides to add them. Unknown slug → log + best-effort skip
  // so an unmapped paid license never blocks provisioning.
  console.warn(`[pluginStack] no license-activation handler for ${slug} — skipping`);
}

export default { PLUGIN_STACK, EWWW_INSTALL_CONFIG, getPluginsForTier, installPluginsForTier };
