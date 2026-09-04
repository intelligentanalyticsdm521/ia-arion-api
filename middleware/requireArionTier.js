// middleware/requireArionTier.js
//
// TIER GATE for ARION (Layer 2). requireArionAccess answers "do you own
// ARION?"; this answers "does your ARION tier include this feature?".
//
// WHY THIS EXISTS INSTEAD OF lib/tierCheck.js requireTier():
// `requireTier` reads `req.siteRecord?.arion_tier`, but NOTHING in the live
// tree ever populates `req.siteRecord` (only a stale worktree does). Wiring it
// as-is would evaluate every request as tier "lite" and lock out EVERY ARION
// customer — including Rolling In It and the founder tenant. This middleware
// resolves the tier itself, from data that is actually populated in prod.
//
// TIER SOURCE — CHANGED 2026-09-06, seams pack 3 (SEAM-3-A):
//   0. platform-api's entitlement service — the ONE answer to "does this
//      business have X?" on this platform. It resolves the ARION tier from the
//      live Stripe subscription and core.tenant_services, neither of which this
//      file could see. This repo was an EIGHTH source for that question and the
//      audit's §3 table does not list it (recorded in the pack 3 report).
//   1. arion.site.arion_tier   — per-site, authoritative for a business with
//      several sites, which the tenant-level payload cannot express. Kept.
//        IA=business · RollingInIt=pro · Briarwood=pro · MidwestAg=pro
//   2. arion.tenant.plan       — tenant-level fallback (same values)
//   3. neither found           → FAIL OPEN (allow + log). ARION's data model
//      predates this gate; refusing traffic because a row is missing would
//      break working customers. We only ever DENY on a confidently-resolved
//      tier that is genuinely too low. That is SEAM-3-B's "allow the FEATURE"
//      half, and it is unchanged.
//
// ORDER, and why 1 still exists: the payload answers what the business BOUGHT;
// the site row answers what a PARTICULAR site was provisioned at. A site row
// that is HIGHER than the purchased tier is a comp or a migration artefact and
// must keep working, so the resolution takes the HIGHER of the two rather than
// letting either one demote the other. Only a positively-resolved tier from
// either source can deny.
//
// SEO surfaces are deliberately NOT gated here: SEO is a separate paid ADD-ON
// with its own ladder (Starter/Essentials/Growth/Authority) already enforced
// via arion.site.seo_addon_tier in seoOnboarding.js. Gating SEO paths on the
// BASE tier would double-charge the customer for one capability.

import sql from 'mssql';
import { getServicesPool } from '../db/servicesPool.js';
import { getEntitlements, productOf } from '../lib/entitlements.js';
import { rankOf } from '../lib/entitlementsRule.js';

// Kept as the LOCAL ladder for arion_tier words, which include the same five
// rungs. rankOf() from lib/entitlementsRule.js is the platform ladder and is
// what the payload's tier is compared on; a test pins the two orderings to the
// same sequence so a rung cannot be added to one and not the other.
const TIER_LEVELS = { lite: 0, standard: 1, pro: 2, business: 3, enterprise: 4 };

function meets(current, required) {
  const c = TIER_LEVELS[String(current || '').toLowerCase()] ?? -1;
  const r = TIER_LEVELS[String(required || '').toLowerCase()] ?? 0;
  return c >= r;
}

/** The higher of two tier words; either may be null. */
function higherTier(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return rankOf(a) >= rankOf(b) ? a : b;
}

// Path fragment -> minimum BASE tier. Mirrors FEATURE_TIER_MATRIX_FULL.md §1.
// Matched against the full request path, so it covers /arion/* and nested
// routes. Anything unlisted is available to every ARION owner (Lite+).
const PATH_MIN_TIER = [
  // STANDARD — analytics + search console integrations (GA4/GSC/Bing)
  { re: /\/(analytics|ga4)\b/i, tier: 'standard' },
  { re: /\/(search-console|gsc|search\/(performance|indexing|sitemaps))\b/i, tier: 'standard' },
  { re: /\/bing\b/i, tier: 'standard' },
  { re: /\/(security\/(vulnerabilities|firewall))\b/i, tier: 'standard' },

  // PRO — staging, Google Business Profile, modelled intelligence
  { re: /\/staging\b/i, tier: 'pro' },
  { re: /\/(gbp|business-profile|google-business)\b/i, tier: 'pro' },
  { re: /\/intelligence\b/i, tier: 'pro' },

  // BUSINESS — nothing base-gated today. Market Monitor left the Business
  // base tier on 2026-08-21 (it runs on SE Ranking page-change monitoring, so
  // it is an SEO add-on surface, Authority only — gated on seo_addon_tier in
  // routes/arion.js /seo/market-monitor*, not here).
];

async function resolveArionTier(req, deps = {}) {
  if (req._arionTier !== undefined) return req._arionTier;
  const tenantId = req.tenant?.tenantId;
  if (!tenantId) { req._arionTier = null; return null; }

  // 0. The one answer. Only a DECIDED node counts — SEAM-3-B: an undecided
  //    entitlement must never demote a working customer, so it is simply not a
  //    tier and the site row below answers on its own.
  let purchased = null;
  try {
    const node = productOf(await (deps.getEntitlements || getEntitlements)(tenantId), 'arion');
    if (node && node.decided && node.tier) purchased = String(node.tier).toLowerCase();
  } catch (err) {
    console.warn('[requireArionTier] entitlement lookup failed; using the site row:', err.message);
  }

  try {
    const pool = await getServicesPool();
    const r = await pool.request()
      .input('tenant_id', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT TOP 1 s.arion_tier, t.[plan]
          FROM arion.tenant t
     LEFT JOIN arion.site s ON s.tenant_id = t.tenant_id
         WHERE t.tenant_id = @tenant_id
         ORDER BY CASE WHEN s.arion_tier IS NOT NULL THEN 0 ELSE 1 END`);
    const row = r.recordset[0];
    req._arionTier = higherTier(purchased, row?.arion_tier || row?.plan || null);
  } catch (err) {
    console.error('[requireArionTier] tier lookup failed; allowing:', err.message);
    // The site row is unreadable. The purchased tier still stands if we have
    // one — losing it here would deny on a database blip, which is exactly what
    // this gate has always refused to do.
    req._arionTier = purchased;
  }
  return req._arionTier;
}

export function requireArionTier(deps = {}) {
  return async function arionTierGate(req, res, next) {
    try {
      const path = req.originalUrl || req.path || '';
      const rule = PATH_MIN_TIER.find((x) => x.re.test(path));
      if (!rule) return next();

      const tier = await resolveArionTier(req, deps);
      // Unknown tier -> fail OPEN (see header note). Never lock out a working
      // customer because a row is missing.
      if (!tier) return next();
      if (meets(tier, rule.tier)) return next();

      return res.status(402).json({
        error: {
          code: 'TIER_LIMIT_REACHED',
          message: `This feature requires ARION ${rule.tier.charAt(0).toUpperCase() + rule.tier.slice(1)} or above.`,
          status: 402,
          upgrade: { current_tier: tier, required_tier: rule.tier },
        },
      });
    } catch (err) {
      console.error('[requireArionTier] gate error; allowing:', err.message);
      return next();
    }
  };
}

export { resolveArionTier, higherTier };
export default requireArionTier;
