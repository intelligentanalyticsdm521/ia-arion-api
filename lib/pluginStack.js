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

import { runWpCli } from './hostingerSsh.js';
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
  { slug: 'shortpixel-image-optimiser', source: 'wporg', allTiers: true },
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
 * Return the ordered list of plugins to install for a given tier + options.
 *
 * @param {object} opts
 * @param {string} opts.tier             - 'lite' | 'standard' | 'pro' | 'business' | 'enterprise'
 * @param {boolean} [opts.installShop]   - questionnaire answer for "Do you need an online shop?"
 * @returns {Array}                      - filtered + ordered plugin specs
 */
export function getPluginsForTier({ tier, installShop = false }) {
  const t = String(tier || 'lite').toLowerCase();
  return PLUGIN_STACK.filter((p) => {
    if (p.allTiers) return true;
    if (p.conditional === 'installShop') {
      if (!installShop) return false;
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
 * @param {string} args.iaPluginDownloadUrl
 * @returns {Promise<{installed: string[], skipped: string[], logs: object[]}>}
 */
export async function installPluginsForTier({ domain, tier, installShop, iaPluginDownloadUrl, provisionCode, onlySlugs = null }) {
  let plan = getPluginsForTier({ tier, installShop });
  // onlySlugs lets the existing-WP path install JUST the IA Plugin without
  // touching the customer's existing plugin set (paths #2/#4/#6/#8).
  if (Array.isArray(onlySlugs) && onlySlugs.length > 0) {
    const allowed = new Set(onlySlugs);
    plan = plan.filter((p) => allowed.has(p.slug));
  }
  const installed = [];
  const skipped = [];
  const logs = [];

  for (const spec of plan) {
    try {
      let res;
      // --force overwrites any partial / stale plugin folder from a prior
      // failed run so we never get a silent "folder already exists" skip.
      if (spec.kind === 'theme' && spec.source === 'wporg') {
        res = await runWpCli(domain, `theme install ${spec.slug} --activate --force`);
      } else if (spec.source === 'wporg') {
        res = await runWpCli(domain, `plugin install ${spec.slug} --activate --force`);
        if (spec.paidLicense) {
          await activateLicense(domain, spec.slug, spec.paidLicense);
        }
      } else if (spec.source === 'blob') {
        if (!provisionCode) {
          throw new Error(`Plugin ${spec.slug} (blob source) requires provisionCode from caller`);
        }
        const url = `${ARION_API_BASE}/plugin/paid/${spec.slug}?token=${encodeURIComponent(provisionCode)}`;
        res = await runWpCli(domain, `plugin install '${url}' --activate --force`);
        if (spec.paidLicense) {
          await activateLicense(domain, spec.slug, spec.paidLicense);
        }
      } else if (spec.source === 'arion') {
        if (!iaPluginDownloadUrl) {
          throw new Error(`Plugin ${spec.slug} requires iaPluginDownloadUrl from caller`);
        }
        res = await runWpCli(domain, `plugin install '${iaPluginDownloadUrl}' --activate --force`);
      } else {
        throw new Error(`Unknown plugin source: ${spec.source}`);
      }
      installed.push(spec.slug);
      logs.push({ slug: spec.slug, ok: true, stdout: res.stdout.slice(0, 200) });
    } catch (err) {
      // With --force, the only real "skip" outcomes are when the plugin
      // doesn't exist on wp.org or the URL is unreachable. Be conservative:
      // only swallow "already active" (activating a plugin that is already
      // active is not a failure). Everything else surfaces.
      const msg = (err.stderr || err.message || '').toString().toLowerCase();
      if (/already active|already.*activated/i.test(msg)) {
        skipped.push(spec.slug);
        logs.push({ slug: spec.slug, ok: true, skipped: true });
      } else {
        logs.push({ slug: spec.slug, ok: false, error: err.message });
        throw new Error(`Plugin install failed for ${spec.slug}: ${err.message}`);
      }
    }
  }

  return { installed, skipped, logs };
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

export default { PLUGIN_STACK, getPluginsForTier, installPluginsForTier };
