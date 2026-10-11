// lib/purchasedArionTier.js — the ARION tier the business PAYS for, for the
// places that used to read arion.site.arion_tier on its own.
//
// Brandon, 11 Oct 2026: "it's by their subscription. ARION pro has different
// features than ARION lite."
//
// arion.site.arion_tier is written RAISE ONLY (lib/purchaseTierSync.js): an
// upgrade lifts it, a downgrade never lowers it. So a business that moved from
// Pro to Lite kept a site row that still said 'pro', and every check that read
// only the site row kept handing it Pro features: Google review auto-replies,
// the AI page editor, and the tier the plugin is told at provisioning.
// Feature gates now read the feature catalog (lib/featureGate.js); this is
// left for the AI page editor (routes/arion/pages.js, until the catalog has
// a row for it) and the tier the plugin is told (routes/submit.js).
//
// THE RULE:
//   - platform-api's payload (lib/entitlements.js, the thin client) is the one
//     answer. A DECIDED ARION node with a real tier word STANDS, from any
//     source (Stripe, a comp, core.tenant_services), and may be LOWER than the
//     site row.
//   - No usable tier (platform-api unreachable, an undecided node, a null tier,
//     or a word that is not a tier) -> the site row, as before. A null tier on
//     an owned ARION is never a denial on its own.
// Nothing here reads core.tenant_services and nothing here decides ownership.
import { getEntitlements, productOf } from './entitlements.js';

export const ARION_TIER_WORDS = Object.freeze(['lite', 'standard', 'pro', 'business', 'enterprise']);

/**
 * What the subscription says about ARION for one business. Never throws.
 * @returns {Promise<{ state: 'owned'|'not_owned'|'undecided', tier: string|null }>}
 */
export async function purchasedArionTier(tenantId, deps = {}) {
  if (!tenantId) return { state: 'undecided', tier: null };
  let node = null;
  try {
    node = productOf(await (deps.getEntitlements || getEntitlements)(tenantId), 'arion');
  } catch (err) {
    console.warn(`[purchasedArionTier] could not read the subscription for ${tenantId}: ${err?.message}`);
    node = null;
  }
  if (!node || node.decided === false) return { state: 'undecided', tier: null };
  const word = node.tier ? String(node.tier).trim().toLowerCase() : null;
  const tier = word && ARION_TIER_WORDS.includes(word) ? word : null;
  if (node.owned === true) {
    if (!tier) console.warn(`[purchasedArionTier] ARION is owned by ${tenantId} but the subscription carries no tier (${node.tier ?? 'null'}); using the site row`);
    return { state: 'owned', tier };
  }
  if (node.owned === false) return { state: 'not_owned', tier: null };
  return { state: 'undecided', tier: null };
}

/**
 * The tier a check should compare: the purchased tier when there is one,
 * otherwise the site row's arion_tier (the documented fallback).
 */
export function effectiveArionTier(purchased, siteTier) {
  return purchased?.tier || (siteTier ? String(siteTier).trim().toLowerCase() : null) || null;
}

/**
 * A copy of an arion.site row whose arion_tier is the tier the business pays
 * for. Used where a whole site row is handed on to a tier check
 * (lib/websiteBuilder/aiEdit.js aiTierGate). The row itself is not changed.
 */
export async function siteWithPurchasedTier(site, tenantId, deps = {}) {
  if (!site) return site;
  const purchased = await purchasedArionTier(tenantId || site.tenant_id, deps);
  const tier = effectiveArionTier(purchased, site.arion_tier);
  return tier === site.arion_tier ? site : { ...site, arion_tier: tier };
}

export default { ARION_TIER_WORDS, purchasedArionTier, effectiveArionTier, siteWithPurchasedTier };
