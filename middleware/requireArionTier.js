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
// TIER SOURCE (verified in prod 2026-08-06):
//   1. arion.site.arion_tier   — per-site, authoritative
//        IA=business · RollingInIt=pro · Briarwood=pro · MidwestAg=pro
//   2. arion.tenant.plan       — tenant-level fallback (same values)
//   3. neither found           → FAIL OPEN (allow + log). ARION's data model
//      predates this gate; refusing traffic because a row is missing would
//      break working customers. We only ever DENY on a confidently-resolved
//      tier that is genuinely too low.
//
// SEO surfaces are deliberately NOT gated here: SEO is a separate paid ADD-ON
// with its own ladder (Starter/Essentials/Growth/Authority) already enforced
// via arion.site.seo_addon_tier in seoOnboarding.js. Gating SEO paths on the
// BASE tier would double-charge the customer for one capability.

import sql from 'mssql';
import { getServicesPool } from '../db/servicesPool.js';

const TIER_LEVELS = { lite: 0, standard: 1, pro: 2, business: 3, enterprise: 4 };

function meets(current, required) {
  const c = TIER_LEVELS[String(current || '').toLowerCase()] ?? -1;
  const r = TIER_LEVELS[String(required || '').toLowerCase()] ?? 0;
  return c >= r;
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

  // BUSINESS — Market Monitor
  { re: /\/(market-monitor|marketmonitor)\b/i, tier: 'business' },
];

async function resolveArionTier(req) {
  if (req._arionTier !== undefined) return req._arionTier;
  const tenantId = req.tenant?.tenantId;
  if (!tenantId) { req._arionTier = null; return null; }
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
    req._arionTier = (row?.arion_tier || row?.plan || null);
  } catch (err) {
    console.error('[requireArionTier] tier lookup failed; allowing:', err.message);
    req._arionTier = null;
  }
  return req._arionTier;
}

export function requireArionTier() {
  return async function arionTierGate(req, res, next) {
    try {
      const path = req.originalUrl || req.path || '';
      const rule = PATH_MIN_TIER.find((x) => x.re.test(path));
      if (!rule) return next();

      const tier = await resolveArionTier(req);
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

export default requireArionTier;
