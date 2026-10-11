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
// TIER SOURCE — "it's by their subscription. ARION pro has different features
// than ARION lite" (Brandon, 11 Oct 2026). CHANGED 2026-10-11:
//   0. platform-api's entitlement payload — productOf(payload, 'arion').tier,
//      the ONE answer to "what did this business buy?". A DECIDED node with a
//      real tier word STANDS, from any source: a live Stripe subscription, a
//      comp (platform-api already serves a comp at the higher of the comped
//      tier and any live Stripe tier, tier_source 'comped'), or the tier set on
//      core.tenant_services. The site row can no longer raise or lower it.
//   1. arion.site.arion_tier   — the documented FALLBACK, used only when the
//      payload has no usable tier (undecided, a null tier, or a word that is
//      not a tier such as 'website' or 'active').
//   2. arion.tenant.plan       — the fallback's own fallback (same values).
//   3. nothing found           → FAIL OPEN (allow + log). A null tier on an
//      owned ARION is never a denial. We only ever DENY on a confidently
//      resolved tier that is genuinely too low (SEAM-3-B's "allow the FEATURE"
//      half, unchanged).
//
// Before 2026-10-11 a non-Stripe tier was combined with the site row as "the
// higher of the two", so a site row stamped higher than what the business pays
// for kept unlocking features. That is the "ARION Lite customer can reach
// Business-tier ARION surfaces" leak FEATURE_TIER_MATRIX_FULL.md §0 names.
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

// Path fragment -> minimum BASE tier, FEATURE_TIER_MATRIX_FULL.md §1 (ARION),
// with §6 and §7/§13 where they supersede it. Matched against the request path
// (query string removed), so it covers /arion/* and nested routes. FIRST MATCH
// WINS; a rule with tier null is an explicit "every tier". Anything unlisted is
// available to every ARION owner (Lite+).
//
//   Matrix row                                    API path(s)                         Min
//   Website: Overview, Content, Settings, Updates (unlisted)                          Lite
//   Website: Staging                              /staging                            Pro
//   Hosting: Overview, Domain & DNS, Backups      (unlisted)                          Lite
//   Security Overview                             /plugin/security, wordfence-full,
//                                                 scan-issues (unlisted: the Lite
//                                                 Overview page reads them)           Lite
//   Security: Vulnerabilities, Firewall           /sites/:id/vulnerabilities,
//                                                 /plugin/security/wordfence-config   Standard
//   Performance: Cache, Images, Core Web Vitals   (unlisted)                          Lite
//   Analytics Overview / Traffic (GA4)            /analytics, /website-analytics, /ga4 Standard
//   IA Insights: Health, Trends, Reports          /ia-insights, /insights/metrics,
//                                                 /analytics/report, /analytics/insights Lite (§6)
//   Search Console: Performance, Indexing,        /console, /gsc, /search/performance,
//     Sitemaps                                    /search/(indexing|url-inspection|
//                                                 submit-url|sitemaps|generate-sitemap) Standard
//   Bing Copilot, Bing IndexNow                   /bing, /search/bing, /search/indexnow Standard
//   Google Business: Overview, Locations,         /gbp, /business, /my-business,
//     Reviews, Posts, Services, Performance       /business-locations, /review-replies Pro
//   Bing Places, Apple Business Connect           /my-business/:provider,
//                                                 /sites/:id/apple                    Pro
//   IA Insights: Intelligence, Cross-Platform     /intelligence                       Pro
//   SEO (every SE Ranking surface)                /seo — the SEO ADD-ON ladder
//                                                 (requireSeoAddon), never the base
//                                                 tier (§7, §13)                      add-on
const PATH_MIN_TIER = [
  // EVERY TIER — IA Insights Reports (§6, Brandon 2026-08-06: Health, Trends
  // and Reports are every tier; the Portal's Reports entry sits in the
  // every-tier band). First, so the Analytics rule below cannot catch them.
  { re: /\/analytics\/(report|insights)\b/i, tier: null },

  // STANDARD — Analytics (GA4), Search Console, Bing, Vulnerabilities, Firewall
  { re: /\/(website-)?analytics\b/i, tier: 'standard' },
  { re: /\/ga4\b/i, tier: 'standard' },
  { re: /\/(search-console|gsc|console)\b/i, tier: 'standard' },
  { re: /\/search\/(performance|indexing|sitemaps|url-inspection|submit-url|generate-sitemap|indexnow)\b/i, tier: 'standard' },
  { re: /\/bing\b/i, tier: 'standard' },
  { re: /\/security\/(vulnerabilities|firewall)\b/i, tier: 'standard' },
  { re: /\/sites\/[^/]+\/vulnerabilities\b/i, tier: 'standard' },
  { re: /\/plugin\/security\/wordfence-config\b/i, tier: 'standard' },

  // PRO — Staging, Google Business Profile (+ Bing Places, Apple), Intelligence
  { re: /\/staging\b/i, tier: 'pro' },
  { re: /\/(gbp|business-profile|google-business|my-business|business-locations|business)\b/i, tier: 'pro' },
  { re: /\/sites\/[^/]+\/apple\b/i, tier: 'pro' },
  { re: /\/review-replies\b/i, tier: 'pro' },
  { re: /\/intelligence\b/i, tier: 'pro' },

  // BUSINESS — nothing base-gated. Market Monitor left the Business base tier
  // on 2026-08-21 (it runs on SE Ranking page-change monitoring, so it is an
  // SEO add-on surface, Authority only — gated on seo_addon_tier in
  // routes/arion.js /seo/market-monitor*, not here).
];

async function resolveArionTier(req, deps = {}) {
  if (req._arionTier !== undefined) return req._arionTier;
  const tenantId = req.tenant?.tenantId;
  if (!tenantId) { req._arionTier = null; return null; }

  // 0. The one answer. Only a DECIDED node with a real tier word counts —
  //    SEAM-3-B: an undecided entitlement must never demote a working
  //    customer, so it is simply not a tier and the site row answers instead.
  let purchased = null;
  try {
    const node = productOf(await (deps.getEntitlements || getEntitlements)(tenantId), 'arion');
    if (node && node.decided) {
      const word = node.tier ? String(node.tier).toLowerCase() : null;
      if (word && Object.prototype.hasOwnProperty.call(TIER_LEVELS, word)) purchased = word;
      else if (node.owned === true) {
        console.warn(`[requireArionTier] ARION is owned by ${tenantId} but the subscription carries no tier (${node.tier ?? 'null'}, ${node.tier_source || 'no source'}); using the site row, allowing if there is none`);
      }
    }
  } catch (err) {
    console.warn('[requireArionTier] entitlement lookup failed; using the site row:', err.message);
  }

  // BY THE SUBSCRIPTION (2026-10-11): a decided, real tier from the payload
  // stands, from ANY source, and may be lower than the site row. (F4, 10-07,
  // let only a Stripe-sourced tier stand and combined every other source with
  // the site row; a comp is now served by platform-api itself.)
  if (purchased) {
    req._arionTier = purchased;
    return purchased;
  }

  try {
    const pool = await (deps.getServicesPool || getServicesPool)();
    const r = await pool.request()
      .input('tenant_id', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT TOP 1 s.arion_tier, t.[plan]
          FROM arion.tenant t
     LEFT JOIN arion.site s ON s.tenant_id = t.tenant_id
         WHERE t.tenant_id = @tenant_id
         ORDER BY CASE WHEN s.arion_tier IS NOT NULL THEN 0 ELSE 1 END`);
    const row = r.recordset[0];
    // Only reached when the payload had no usable tier: the documented fallback.
    req._arionTier = row?.arion_tier || row?.plan || null;
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
      const path = String(req.originalUrl || req.path || '').split('?')[0];
      const rule = minTierFor(path);
      if (!rule || !rule.tier) return next();

      const tier = await resolveArionTier(req, deps);
      // Unknown tier -> fail OPEN (see header note). Never lock out a working
      // customer because a row is missing.
      if (!tier) {
        console.warn(`[requireArionTier] no ARION tier for ${req.tenant?.tenantId} on ${path} (needs ${rule.tier}); allowing`);
        return next();
      }
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

/** The first PATH_MIN_TIER rule for a path (query string ignored), or null. */
function minTierFor(path) {
  const p = String(path || '').split('?')[0];
  return PATH_MIN_TIER.find((x) => x.re.test(p)) || null;
}

export { resolveArionTier, higherTier, minTierFor, PATH_MIN_TIER };
export default requireArionTier;
