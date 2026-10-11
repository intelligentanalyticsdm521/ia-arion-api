// middleware/arionRouteFeatures.js — which catalog feature each ARION route
// belongs to, read by ONE mounted gate in front of /arion and /intelligence.
//
// Replaces middleware/requireArionTier.js and its PATH_MIN_TIER table (15 path
// patterns -> a minimum tier), deleted on 11 Oct 2026. That table was the
// third hand-written copy of "which ARION tier gets what" (beside the Portal's
// SubNav rules and FEATURE_TIER_MATRIX_FULL.md), and it fell back to the
// raise-only arion.site.arion_tier when the subscription carried no tier.
// Brandon, 11 Oct 2026: "I would think we have a feature list and then a
// subscription tier list and those are synced up."
//
// NOW: a path names a FEATURE KEY, never a tier. What the key needs (ARION
// Pro, ARION Standard, the SEO add-on) lives only in core.features, and
// whether this business has it is platform-api's answer, payload.features[key],
// read by middleware/requireFeature.js. FIRST MATCH WINS. A path that matches
// nothing is every ARION owner's (requireArionAccess already answered "do you
// own ARION?"). Routes added later declare requireFeature(key) directly.
//
// SEO (/arion/seo/*) is NOT in this table: SEO is the add-on, gated per site
// by middleware/requireSeoAddon.js, which reads the same catalog rows
// (arion_seo_*, addon seo, and the rung each needs).
//
// Each row's key is the catalog row whose `source` names the old pattern
// (platform-api db/seed/feature_catalog.json, "arion:PATH_MIN_TIER:<regex>").
// Where the old single pattern covered several pages that a path can tell
// apart (Search Console vs Sitemaps vs IndexNow; Business reviews vs posts vs
// locations), the row is split so a per-business override of one page does
// not move the others.
//
// ANALYTICS: GET /arion/analytics answers every GA4 panel in one response
// (sessions, users, channels, devices, top pages), so it cannot tell the
// Audience / Content / Conversions pages apart; it is arion_analytics_overview.
// The Portal gates those three pages on their own keys.
import { requireFeature, featureDecision, intentForMethod, logDecision, answerRefusal } from './requireFeature.js';

// intent: a POST that spends model credits or posts publicly names it, so an
// undecided plan holds it instead of letting it run (requireFeature's rule).
const SPEND_ON_POST = (req) => (String(req.method).toUpperCase() === 'POST' ? 'spend' : intentForMethod(req.method));
const SEND_ON_POST = (req) => (String(req.method).toUpperCase() === 'POST' ? 'send' : intentForMethod(req.method));

export const ROUTE_FEATURES = Object.freeze([
  // IA Insights Reports, every tier (matrix §6). First, so Analytics cannot catch them.
  { re: /\/analytics\/(report|insights)\b/i, key: 'arion_ia_insights_reports' },

  // Analytics (GA4)
  { re: /\/(website-)?analytics\b/i, key: 'arion_analytics_overview' },
  { re: /\/ga4\b/i, key: 'arion_analytics_overview' },

  // Bing Places and Apple Business Connect, before the Bing Webmaster rows
  { re: /\/my-business\/apple\b/i, key: 'arion_business_apple_overview' },
  { re: /\/my-business\/bing\b/i, key: 'arion_business_bing_overview' },

  // Search Console, Bing Webmaster
  { re: /\/console\/bing\b/i, key: 'arion_search_bing_copilot' },
  { re: /\/(search-console|gsc|console)\b/i, key: 'arion_search_performance' },
  { re: /\/search\/performance\b/i, key: 'arion_search_performance' },
  { re: /\/search\/(indexing|url-inspection|submit-url)\b/i, key: 'arion_search_indexing' },
  { re: /\/search\/(sitemaps|generate-sitemap)\b/i, key: 'arion_search_sitemaps' },
  { re: /\/search\/indexnow\b/i, key: 'arion_search_bing_indexnow' },
  { re: /\/bing\b/i, key: 'arion_search_bing_copilot' },

  // Security
  { re: /\/security\/firewall\b/i, key: 'arion_website_security_firewall' },
  { re: /\/plugin\/security\/wordfence-config\b/i, key: 'arion_website_security_firewall' },
  { re: /\/security\/vulnerabilities\b/i, key: 'arion_website_security_vulnerabilities' },
  { re: /\/sites\/[^/]+\/vulnerabilities\b/i, key: 'arion_website_security_vulnerabilities' },

  // Website, Hosting
  { re: /\/staging\b/i, key: 'arion_website_staging' },
  { re: /\/hosting\/dns\b/i, key: 'arion_hosting_domain_dns' },

  // Business Profile (Google, Bing Places, Apple)
  { re: /\/review-replies\b/i, key: 'arion_business_reviews', intent: SEND_ON_POST },
  { re: /\/sites\/[^/]+\/apple\b/i, key: 'arion_business_apple_overview' },
  { re: /\/business\/reviews\/[^/]+\/draft-reply\b/i, key: 'arion_business_reviews', intent: SPEND_ON_POST },
  { re: /\/(business|gbp)\/reviews\b/i, key: 'arion_business_reviews', intent: SEND_ON_POST },
  { re: /\/business\/posts\b/i, key: 'arion_business_posts', intent: SEND_ON_POST },
  { re: /\/business\/services\b/i, key: 'arion_business_services' },
  { re: /\/business\/insights\b/i, key: 'arion_business_insights' },
  { re: /\/(business-locations|gbp\/locations)\b/i, key: 'arion_business_locations' },
  { re: /\/(gbp|business-profile|google-business|my-business|business)\b/i, key: 'arion_business_overview' },

  // IA Insights Intelligence (matrix §6)
  { re: /\/intelligence\b/i, key: 'arion_ia_insights_intelligence' },
]);

/** The first ROUTE_FEATURES row for a path (query string ignored), or null. */
export function featureForPath(path) {
  const p = String(path || '').split('?')[0];
  return ROUTE_FEATURES.find((x) => x.re.test(p)) || null;
}

/**
 * The mounted gate: finds the path's feature and applies requireFeature's
 * rule to it. A path with no feature passes straight through.
 * @param {object} [deps] { getEntitlements } test seam
 */
export function arionRouteFeatures(deps = {}) {
  return async function arionRouteFeatureGate(req, res, next) {
    const path = String(req.originalUrl || req.path || '').split('?')[0];
    const row = featureForPath(path);
    if (!row) return next();
    const tenantId = req.tenant?.tenantId;
    if (!tenantId) return next();
    const intent = typeof row.intent === 'function' ? row.intent(req) : intentForMethod(req.method);
    const d = await featureDecision(tenantId, row.key, intent, deps);
    logDecision(d, tenantId, path);
    if (answerRefusal(res, d)) return undefined;
    req.feature = { key: row.key, allowed: d.entry ? d.entry.allowed : null, needs: d.needs || null };
    return next();
  };
}

export { requireFeature };
export default arionRouteFeatures;
