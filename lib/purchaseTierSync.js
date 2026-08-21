// lib/purchaseTierSync.js
//
// Writes the tier columns on arion.site from what the customer actually
// bought in Stripe:
//
//   arion.site.arion_tier      — BASE plan  (lite | standard | pro | business | enterprise)
//   arion.site.seo_addon_tier  — SEO add-on (starter | essentials | growth | authority)
//   arion.site.tier            — legacy SEO-ladder mirror still read by
//                                lib/integrationKickoff.js + lib/manifestBuilder.js
//
// Until 2026-08-21 NOTHING in the purchase path wrote seo_addon_tier (only
// ad-hoc provisioning scripts did) and routes/onboarding/webhook.js wrote the
// BASE plan key into the SEO-ladder `tier` column while arion_tier kept its
// 'lite' column default. With middleware/requireSeoAddon.js live that meant a
// self-serve buyer of Starter/Essentials/Growth/Authority was 403'd on every
// SEO page after paying, and middleware/requireArionTier.js resolved every
// self-serve tenant as Lite.
//
// Sources, per column, in order:
//   (a) Checkout-session / subscription metadata — `plan` for the base tier;
//       `seo` / `seo_addon` / `seo_addon_tier` for the add-on (oliver-api
//       routes/billing.js carries the SEO selection as `seo`).
//   (b) The subscription's line items — product names 'ARION - <Tier>'
//       (base) and 'ARION SEO - <Tier>' (add-on). This is the ONLY source
//       for carts built by oliver-api /signup/checkout-cart, whose metadata
//       has no per-product keys.
//
// Write rule (this pass): RAISE ONLY. NULL or a lower rung is overwritten; a
// higher rung is never downgraded — cancellations/downgrades are Phase B.
// Every entry point is best-effort and never throws into a Stripe webhook.

import sql from 'mssql';
import { getStripeClient } from './stripe.js';

export const SEO_ADDON_LADDER = ['starter', 'essentials', 'growth', 'authority'];
export const BASE_TIER_LADDER = ['lite', 'standard', 'pro', 'business', 'enterprise'];

const norm = (v) => String(v ?? '').trim().toLowerCase();
const ladderWord = (text, ladder) => ladder.find((w) => new RegExp(`\\b${w}\\b`).test(text)) || null;
const rank = (value, ladder) => { const i = ladder.indexOf(norm(value)); return i < 0 ? 0 : i + 1; };
const higher = (a, b, ladder) => (rank(b, ladder) > rank(a, ladder) ? norm(b) : a);

// ── Product-name classification ─────────────────────────────────────────────

/** 'ARION SEO - Growth' | 'Arion SEO Starter' → 'growth' | 'starter'; anything else → null. */
export function seoAddonTierFromProductName(name) {
  const n = norm(name);
  if (!/^arion\s*seo\b/.test(n)) return null;
  return ladderWord(n, SEO_ADDON_LADDER);
}

/** 'ARION - Pro' | 'ARION Business' → 'pro' | 'business'; SEO add-ons and other products → null. */
export function baseTierFromProductName(name) {
  const n = norm(name);
  if (!/^arion\b/.test(n) || /\bseo\b/.test(n)) return null;
  return ladderWord(n, BASE_TIER_LADDER);
}

/** Highest base + SEO tier named by a list of Stripe product names. */
export function tiersFromProductNames(names) {
  let seoAddonTier = null;
  let arionTier = null;
  for (const name of names || []) {
    seoAddonTier = higher(seoAddonTier, seoAddonTierFromProductName(name), SEO_ADDON_LADDER);
    arionTier = higher(arionTier, baseTierFromProductName(name), BASE_TIER_LADDER);
  }
  return { seoAddonTier, arionTier };
}

/** Product names on a subscription retrieved with expand: ['items.data.price.product']. */
export function productNamesFromSubscription(subscription) {
  const items = subscription?.items?.data || (Array.isArray(subscription?.items) ? subscription.items : []);
  return items
    .map((it) => it?.price?.product ?? it?.plan?.product)
    .map((p) => (p && typeof p === 'object' ? p.name : null))
    .filter(Boolean);
}

// ── Metadata classification ─────────────────────────────────────────────────

// Metadata written for another product's checkout (oliver-api single-product
// sessions carry signup_product + plan) must not be read as ARION tiers.
function metadataIsForAnotherProduct(meta) {
  const product = norm(meta?.product || meta?.signup_product);
  return !!product && product !== 'arion';
}

export function seoAddonTierFromMetadata(meta) {
  if (!meta || metadataIsForAnotherProduct(meta)) return null;
  for (const key of ['seo_addon_tier', 'seo_addon', 'seo', 'arion_seo']) {
    const v = norm(meta[key]);
    if (SEO_ADDON_LADDER.includes(v)) return v;
  }
  return null;
}

export function baseTierFromMetadata(meta) {
  if (!meta || metadataIsForAnotherProduct(meta)) return null;
  for (const key of ['arion_plan', 'plan']) {
    const v = norm(meta[key]);
    if (BASE_TIER_LADDER.includes(v)) return v;
  }
  return null;
}

/**
 * Metadata first (session, then subscription), line items as the fallback —
 * per column, so a session that names only the plan still gets its SEO tier
 * from the 'ARION SEO - …' line item.
 */
export function derivePurchaseTiers({ metadata = null, subscription = null } = {}) {
  const fromItems = tiersFromProductNames(productNamesFromSubscription(subscription));
  const seoAddonTier = seoAddonTierFromMetadata(metadata) || seoAddonTierFromMetadata(subscription?.metadata) || fromItems.seoAddonTier;
  const arionTier = baseTierFromMetadata(metadata) || baseTierFromMetadata(subscription?.metadata) || fromItems.arionTier;
  return { seoAddonTier, arionTier };
}

// ── SQL ─────────────────────────────────────────────────────────────────────

// Rank of a ladder word stored in a column (unknown / NULL / a word from the
// other ladder → 0, so it is always overwritten by a known rung).
const rankCase = (col, ladder) =>
  `CASE LOWER(ISNULL(${col}, '')) ${ladder.map((w, i) => `WHEN '${w}' THEN ${i + 1}`).join(' ')} ELSE 0 END`;

// @seoRank / @baseRank are 0 when that tier is unknown, so `0 > rank` is
// never true and the column is left alone. `tier` follows seo_addon_tier
// (same ladder) so the legacy readers see the SEO rung, never a base word.
export const SITE_TIER_SYNC_SQL = `
UPDATE s SET
  seo_addon_tier = CASE WHEN @seoRank  > r.seo_rank  THEN @seoTier  ELSE s.seo_addon_tier END,
  tier           = CASE WHEN @seoRank  > r.tier_rank THEN @seoTier  ELSE s.tier           END,
  arion_tier     = CASE WHEN @baseRank > r.base_rank THEN @baseTier ELSE s.arion_tier     END,
  updated_at     = SYSDATETIMEOFFSET()
FROM arion.site s
CROSS APPLY (SELECT
  seo_rank  = ${rankCase('s.seo_addon_tier', SEO_ADDON_LADDER)},
  tier_rank = ${rankCase('s.tier', SEO_ADDON_LADDER)},
  base_rank = ${rankCase('s.arion_tier', BASE_TIER_LADDER)}) r
WHERE s.tenant_id = @tenantId
  AND (@siteId IS NULL OR s.site_id = @siteId)
  AND (@seoRank > r.seo_rank OR @seoRank > r.tier_rank OR @baseRank > r.base_rank)`;

/**
 * Statement + parameters for one sync. Pure — tests pin the shape here.
 * `noop` is true when neither tier resolved (nothing would be written).
 */
export function buildSiteTierSync({ tenantId, siteId = null, seoAddonTier = null, arionTier = null }) {
  const seoTier = SEO_ADDON_LADDER.includes(norm(seoAddonTier)) ? norm(seoAddonTier) : null;
  const baseTier = BASE_TIER_LADDER.includes(norm(arionTier)) ? norm(arionTier) : null;
  return {
    sql: SITE_TIER_SYNC_SQL,
    params: {
      tenantId,
      siteId: siteId || null,
      seoTier,
      seoRank: seoTier ? rank(seoTier, SEO_ADDON_LADDER) : 0,
      baseTier,
      baseRank: baseTier ? rank(baseTier, BASE_TIER_LADDER) : 0,
    },
    noop: !seoTier && !baseTier,
  };
}

export async function applySiteTierSync(pool, args) {
  const b = buildSiteTierSync(args);
  if (b.noop) return { updated: 0, seoAddonTier: null, arionTier: null };
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, b.params.tenantId)
    .input('siteId', sql.UniqueIdentifier, b.params.siteId)
    .input('seoTier', sql.NVarChar(20), b.params.seoTier)
    .input('seoRank', sql.Int, b.params.seoRank)
    .input('baseTier', sql.NVarChar(20), b.params.baseTier)
    .input('baseRank', sql.Int, b.params.baseRank)
    .query(b.sql);
  return { updated: r?.rowsAffected?.[0] ?? 0, seoAddonTier: b.params.seoTier, arionTier: b.params.baseTier };
}

// ── Stripe + entry points ───────────────────────────────────────────────────

/** Subscription with product objects expanded; null when Stripe is not configured. */
export async function fetchSubscriptionWithProducts(subscriptionId) {
  if (!subscriptionId) return null;
  const stripe = getStripeClient();
  if (!stripe) return null;
  return stripe.subscriptions.retrieve(String(subscriptionId), { expand: ['items.data.price.product'] });
}

/**
 * Derive the purchased tiers and raise them on the tenant's site(s) — one
 * site when `siteId` is given, every site of the tenant otherwise.
 * NEVER throws: returns { ok:false, error } so a webhook stays 200.
 *
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string|null} [args.siteId]
 * @param {object|null} [args.metadata]        checkout-session metadata
 * @param {string|null} [args.subscriptionId]  fetched (expanded) when `subscription` is absent
 * @param {object|null} [args.subscription]    already-expanded subscription
 * @param {string} [args.source]               log label
 * @param {Function} [args.fetchSubscription]  injectable for tests
 */
export async function syncSiteTiersFromPurchase(pool, {
  tenantId, siteId = null, metadata = null, subscriptionId = null, subscription = null,
  source = 'purchase', fetchSubscription = fetchSubscriptionWithProducts,
} = {}) {
  const tag = `[purchaseTierSync:${source}]`;
  try {
    if (!tenantId) return { ok: false, error: 'tenantId required', updated: 0 };
    let sub = subscription;
    if (!sub && subscriptionId) {
      try {
        sub = await fetchSubscription(subscriptionId);
      } catch (err) {
        console.error(`${tag} subscription ${subscriptionId} fetch failed (metadata only):`, err?.message || err);
      }
    }
    const derived = derivePurchaseTiers({ metadata, subscription: sub });
    if (!derived.seoAddonTier && !derived.arionTier) {
      console.warn(`${tag} nothing to write for tenant=${tenantId} — no ARION tier in metadata or line items`);
      return { ok: true, updated: 0, ...derived };
    }
    const r = await applySiteTierSync(pool, { tenantId, siteId, ...derived });
    console.log(`${tag} tenant=${tenantId} site=${siteId || '*'} arion_tier=${derived.arionTier || '-'} seo_addon_tier=${derived.seoAddonTier || '-'} rows=${r.updated}`);
    return { ok: true, ...derived, updated: r.updated };
  } catch (err) {
    console.error(`${tag} failed for tenant=${tenantId}:`, err?.message || err);
    return { ok: false, error: err?.message || String(err), updated: 0 };
  }
}

/**
 * Site-provisioning hook (Phase B1, 2026-08-22): a site row was just created
 * for a tenant that may already hold a Stripe subscription — look the
 * subscription up on arion.tenant and raise the new site's tiers from its
 * line items. Tenants with no arion.tenant row or no subscription (founder
 * onboarding, migrated sites) return quickly with no Stripe call. NEVER
 * throws — provisioning must not fail because Stripe or the lookup did.
 */
export async function syncSiteTiersFromTenantSubscription(pool, { tenantId, siteId = null, source = 'provisioning', fetchSubscription } = {}) {
  if (!tenantId) return { ok: false, error: 'tenantId required', updated: 0 };
  let subscriptionId = null;
  try {
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query('SELECT TOP 1 stripe_subscription_id FROM arion.tenant WHERE tenant_id = @tenantId');
    subscriptionId = r.recordset?.[0]?.stripe_subscription_id || null;
  } catch (err) {
    console.error(`[purchaseTierSync:${source}] tenant lookup failed for tenant ${tenantId}:`, err?.message || err);
    return { ok: false, error: err?.message || String(err), updated: 0 };
  }
  if (!subscriptionId) return { ok: true, updated: 0, skipped: 'no stripe subscription on arion.tenant' };
  return syncSiteTiersFromPurchase(pool, {
    tenantId, siteId, subscriptionId: String(subscriptionId), source,
    ...(fetchSubscription ? { fetchSubscription } : {}),
  });
}

/**
 * Subscription-level events (invoice.paid, customer.subscription.updated):
 * find the ARION tenant that owns the subscription, then sync its sites.
 * Subscriptions with no arion.tenant (OLIVER/SPARK/ARGUS renewals) return
 * quickly with no Stripe call. NEVER throws.
 */
export async function syncTenantBySubscription(pool, { subscriptionId, source = 'subscription', fetchSubscription } = {}) {
  const subId = typeof subscriptionId === 'object' ? subscriptionId?.id : subscriptionId;
  if (!subId) return { ok: true, updated: 0, skipped: 'no subscription id' };
  let tenantId;
  try {
    const r = await pool.request()
      .input('subId', sql.NVarChar(200), String(subId))
      .query('SELECT TOP 1 tenant_id FROM arion.tenant WHERE stripe_subscription_id = @subId');
    tenantId = r.recordset?.[0]?.tenant_id;
  } catch (err) {
    console.error(`[purchaseTierSync:${source}] tenant lookup failed for subscription ${subId}:`, err?.message || err);
    return { ok: false, error: err?.message || String(err), updated: 0 };
  }
  if (!tenantId) return { ok: true, updated: 0, skipped: 'no arion.tenant on this subscription' };
  return syncSiteTiersFromPurchase(pool, {
    tenantId, subscriptionId: String(subId), source,
    ...(fetchSubscription ? { fetchSubscription } : {}),
  });
}
