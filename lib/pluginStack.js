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
import { signPluginUrl } from './azureBlob.js';
import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';

const KV_URI = process.env.KEY_VAULT_URI || 'https://kv-iadm-prod.vault.azure.net/';

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
  // Wordfence Free everywhere; Premium deferred until revenue (locked 2026-06-14).
  { slug: 'wordfence', source: 'wporg', allTiers: true },

  // 3. Conditional — only when questionnaire's `installShop` is true. Lite
  //    tier blocks the question upstream so we never reach here for Lite.
  {
    slug: 'woocommerce',
    source: 'wporg',
    conditional: 'installShop',
    minTier: 'standard',
  },

  // 4. Elementor Pro from Azure Blob + license activation.
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
export async function installPluginsForTier({ domain, tier, installShop, iaPluginDownloadUrl }) {
  const plan = getPluginsForTier({ tier, installShop });
  const installed = [];
  const skipped = [];
  const logs = [];

  for (const spec of plan) {
    try {
      let res;
      if (spec.kind === 'theme' && spec.source === 'wporg') {
        // wp.org theme: install + activate.
        res = await runWpCli(domain, `theme install ${spec.slug} --activate`);
      } else if (spec.source === 'wporg') {
        res = await runWpCli(domain, `plugin install ${spec.slug} --activate`);
      } else if (spec.source === 'blob') {
        const url = await signPluginUrl(spec.blobPath, 60);
        res = await runWpCli(domain, `plugin install '${url}' --activate`);
        if (spec.paidLicense) {
          await activateLicense(domain, spec.slug, spec.paidLicense);
        }
      } else if (spec.source === 'arion') {
        if (!iaPluginDownloadUrl) {
          throw new Error(`Plugin ${spec.slug} requires iaPluginDownloadUrl from caller`);
        }
        res = await runWpCli(domain, `plugin install '${iaPluginDownloadUrl}' --activate`);
      } else {
        throw new Error(`Unknown plugin source: ${spec.source}`);
      }
      installed.push(spec.slug);
      logs.push({ slug: spec.slug, ok: true, stdout: res.stdout.slice(0, 200) });
    } catch (err) {
      // wp-cli "already installed" / "already active" are non-failures; log
      // and continue. Anything else gets re-thrown so the caller fails loud.
      const msg = (err.stderr || err.message || '').toString().toLowerCase();
      if (msg.includes('already') || msg.includes('exists')) {
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
    // Elementor Pro CLI: `wp elementor-pro license activate <key>` (added in
    // Elementor Pro 3.20+). Older versions used an option key; we set both
    // for safety.
    await runWpCli(domain, `option update elementor_pro_license_key '${licenseKey}'`);
    try {
      await runWpCli(domain, `elementor-pro license activate '${licenseKey}'`);
    } catch (err) {
      // CLI command may not exist on older versions — option update above is
      // enough for the license to register at next admin_init.
      if (!/unknown command|invalid command/i.test(err.message || '')) {
        throw err;
      }
    }
    return;
  }

  // Slot for future paid plugins (Wordfence Premium, RankMath Pro, WP
  // Rocket) when Brandon decides to add them.
  throw new Error(`No license-activation handler for ${slug}`);
}

export default { PLUGIN_STACK, getPluginsForTier, installPluginsForTier };
