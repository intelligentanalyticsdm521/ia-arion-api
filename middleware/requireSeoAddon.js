// middleware/requireSeoAddon.js
//
// SE RANKING COST GATE (Brandon 2026-08-21 — PRICING_REWORK_DECISIONS §3b):
// "no SE Ranking API call is made for a site without an active paid SEO
// add-on". SEO is an ADD-ON (Starter / Essentials / Growth / Authority) that
// stacks on any ARION base tier and is recorded per site in
// arion.site.seo_addon_tier. Every SE Ranking call burns keywords, Data API
// credits or AI prompt slots on the shared IA plan, so the gate sits in
// front of every /arion/seo/* surface that reaches SE Ranking.
//
// Mounted as router.use('/seo', requireSeoAddon()) in routes/arion.js, so
// req.path is RELATIVE to /seo ('/rankings', '/project/create', '/').
//
// Deliberately NOT gated (pass straight through):
//   GET /seo          — the SEO landing / upsell card — the surface that SELLS
//                       the add-on. It touches SE Ranking only when BOTH
//                       se_ranking_project_id AND seo_addon_tier are set
//                       (guarded in-route, routes/arion.js GET /seo); without
//                       the add-on it returns the upsell payload only.
//   /seo/project/*    — provisioning (create / reconfigure / link). These run
//                       when the add-on is purchased and already answer
//                       400 NO_TIER without seo_addon_tier.
//
// Resolution + fail-open (standing rule since the 2026-08-17 incident): only
// a POSITIVELY resolved "no add-on" is denied —
//   site row found, seo_addon_tier NULL / ''   → 403 SEO_ADDON_REQUIRED
//   site row found, known add-on tier          → allow (then the rung, below)
//   site row found, unknown tier value         → allow + console.error
//   site not found for this tenant             → 404 (what the route says)
//   siteId missing                             → 400 (what every gated route
//                                                says; also closes the
//                                                siteId-less keyword-research
//                                                hole)
//   siteId malformed                           → let the route answer
//   DB lookup threw                            → allow + console.error
//
// WHICH RUNG EACH SURFACE NEEDS comes from the feature catalog (11 Oct 2026,
// "one list"): each /seo path names its catalog key (SEO_ROUTE_FEATURES:
// arion_seo_keywords, arion_seo_ai_search, arion_seo_market_monitor ...) and
// the catalog row, served on platform-api's payload.features[key], says the
// add-on (addon 'seo') and the lowest rung it needs (addon_min_tier: growth
// for AI search and prompts, authority for Market Monitor, none for the
// rest). This file and routes/arion.js no longer hold their own "Market
// Monitor = Authority" or "AI search = Growth" rule. The RUNG A SITE HAS is
// still arion.site.seo_addon_tier: the add-on is bought per site, and
// platform-api answers the business's highest rung while this answers the
// site's.
//
// After the site's add-on is found, in order:
//   catalog says allowed false and the site's rung would do
//                                          -> 403 feature_not_in_plan (switched
//                                             off for this business, or ARION
//                                             not in the plan)
//   the site's rung is below the row's rung-> a read passes with
//                                             req.seoFeature.met = false (the
//                                             route answers its own "needs
//                                             Authority" card); a write or a
//                                             spend is refused 403
//                                             feature_not_in_plan with `needs`
//   catalog unreadable, or the key missing -> a read runs on the site's add-on
//                                             alone (logged); a spend HOLDS 503
//   allowed null and the rung would do     -> a read runs (logged); a spend
//                                             HOLDS 503
//   otherwise                              -> next(), with req.seoAddonTier and
//                                             req.seoFeature = { key, required,
//                                             rung, met, needs }
//
// Every SE Ranking call spends, so a POST under /seo and the Market Monitor
// suggestions read (SE Ranking Data API) are 'spend' intents.

import sql from 'mssql';
import { getServicesPool } from '../db/servicesPool.js';
import { featureDecision, logDecision, HELD_MESSAGE } from './requireFeature.js';

/** The SEO add-on rungs, lowest first (the same order as platform-api SEO_ADDON_RANK). */
export const SEO_ADDON_TIERS = ['starter', 'essentials', 'growth', 'authority'];

/**
 * /seo-relative path -> catalog key. FIRST MATCH WINS; anything else under
 * /seo is the SEO overview's. `spend` marks a read that calls a paid SE
 * Ranking API.
 */
export const SEO_ROUTE_FEATURES = Object.freeze([
  { re: /^\/market-monitor\/suggestions\b/i, key: 'arion_seo_market_monitor', spend: true },
  { re: /^\/market-monitor\b/i, key: 'arion_seo_market_monitor' },
  { re: /^\/ai-search\b/i, key: 'arion_seo_ai_search' },
  { re: /^\/ai-prompts\b/i, key: 'arion_seo_ai_prompts' },
  { re: /^\/keywords?\b/i, key: 'arion_seo_keywords' },
  { re: /^\/(rankings|decay)\b/i, key: 'arion_seo_rankings' },
  { re: /^\/audit\b/i, key: 'arion_seo_site_audit' },
  { re: /^\/competitors\b/i, key: 'arion_seo_competitors' },
  { re: /^\/opportunities\b/i, key: 'arion_seo_opportunities' },
  { re: /^\/reports?\b/i, key: 'arion_seo_reports' },
]);
export const SEO_DEFAULT_FEATURE = 'arion_seo_overview';

/** The catalog key and intent for a /seo-relative path and method. */
export function seoFeatureFor(relPath, method = 'GET') {
  const p = String(relPath || '');
  const row = SEO_ROUTE_FEATURES.find((x) => x.re.test(p));
  const m = String(method || 'GET').toUpperCase();
  const reading = m === 'GET' || m === 'HEAD' || m === 'OPTIONS';
  const intent = m === 'POST' || (reading && row?.spend) ? 'spend' : reading ? 'read' : 'write';
  return { key: row ? row.key : SEO_DEFAULT_FEATURE, intent };
}

/** Does a site's rung reach the rung a feature needs? required null = any rung. */
export function rungMeets(siteRung, required) {
  if (!required) return true;
  const need = SEO_ADDON_TIERS.indexOf(String(required).toLowerCase());
  if (need < 0) return true; // a rung word this code does not know is never a denial
  return SEO_ADDON_TIERS.indexOf(String(siteRung || '').toLowerCase()) >= need;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UNGATED_PATHS = [
  /^\/?$/,              // GET /seo — upsell overview
  /^\/project(\/|$)/i,  // /seo/project/* — provisioning
];

/** True when a /seo-relative path is one of the deliberately ungated surfaces. */
export function isUngatedSeoPath(relPath) {
  return UNGATED_PATHS.some((re) => re.test(String(relPath || '')));
}

/**
 * Pure decision on the arion.site row (or null when not found): does the SITE
 * have the add-on at all?
 * @returns {{ action: 'allow'|'deny'|'not_found', tier: string|null, reason?: string }}
 */
export function seoAddonDecision(row) {
  if (!row) return { action: 'not_found', tier: null };
  const tier = String(row.seo_addon_tier || '').trim().toLowerCase();
  if (!tier) return { action: 'deny', tier: null };
  if (!SEO_ADDON_TIERS.includes(tier)) {
    return { action: 'allow', tier, reason: `unknown seo_addon_tier "${tier}"` };
  }
  return { action: 'allow', tier };
}

async function defaultLoadSite(tenantId, siteId) {
  const pool = await getServicesPool();
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('siteId', sql.UniqueIdentifier, siteId)
    .query('SELECT TOP 1 seo_addon_tier FROM arion.site WHERE tenant_id = @tenantId AND site_id = @siteId');
  return r.recordset[0] || null;
}

const ADDON_WORDS = 'the ARION SEO add-on';
const rungWord = (r) => `${String(r)[0].toUpperCase()}${String(r).slice(1)}`;

function held(res, key) {
  return res.status(503).json({ error: 'plan_not_confirmed', feature: key, message: HELD_MESSAGE });
}

/**
 * @param {{ loadSite?: (tenantId: string, siteId: string) => Promise<object|null>, getEntitlements?: Function }} [opts]
 *        loadSite and getEntitlements are injectable for tests; production
 *        uses the services pool and platform-api (lib/entitlements.js).
 */
export function requireSeoAddon({ loadSite = defaultLoadSite, getEntitlements } = {}) {
  return async function seoAddonGate(req, res, next) {
    if (isUngatedSeoPath(req.path)) return next();

    const tenantId = req.tenant?.tenantId;
    const siteId = req.query?.siteId || req.body?.siteId || null;
    if (!tenantId) return next(); // tenantResolution already ran upstream; nothing to gate on
    if (!siteId) {
      return res.status(400).json({ error: { code: 'MISSING_PARAM', message: 'siteId required', status: 400 } });
    }
    if (!GUID_RE.test(String(siteId))) return next(); // route validation answers malformed ids

    let row;
    try {
      row = await loadSite(tenantId, String(siteId));
    } catch (err) {
      console.error('[requireSeoAddon] site lookup failed; allowing:', err.message);
      return next();
    }

    const d = seoAddonDecision(row);
    if (d.action === 'not_found') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    }
    if (d.action === 'deny') {
      return res.status(403).json({
        error: {
          code: 'SEO_ADDON_REQUIRED',
          message: `This website has no SEO add-on. Keywords, rankings, audits, competitors and AI search tracking need ${ADDON_WORDS}.`,
          status: 403,
          needs: ADDON_WORDS,
          upgrade: { required_addon: 'seo', tiers: SEO_ADDON_TIERS },
        },
      });
    }
    if (d.reason) console.error(`[requireSeoAddon] ${d.reason} on site ${siteId}; allowing`);

    // The catalog: which rung this surface needs, and whether the business has it.
    const { key, intent } = seoFeatureFor(req.path, req.method);
    const plan = await featureDecision(tenantId, key, intent, { getEntitlements });
    const where = `/seo${req.path}`;
    const entry = plan.entry;
    let required = null;
    if (entry) {
      if (entry.addon !== 'seo') console.error(`[requireSeoAddon] catalog row ${key} is not an SEO add-on row (addon ${entry.addon ?? 'none'}); checking the site's add-on only`);
      else required = entry.addon_min_tier || null;
    }
    logDecision(plan, tenantId, where);
    const met = rungMeets(d.tier, required);
    const needs = (entry && entry.needs) || (required ? `${ADDON_WORDS} (${rungWord(required)})` : ADDON_WORDS);

    // No catalog answer for this key: the site's add-on is all we know.
    if (!entry && plan.action === 'hold') return held(res, key);

    if (entry && met) {
      // The site's rung would do, so a refusal is for another reason
      // (switched off for this business, or ARION not in the plan).
      if (plan.action === 'refuse') return res.status(403).json(plan.body);
      if (plan.action === 'hold') return held(res, key);
    }
    if (!met && intent !== 'read') {
      return res.status(403).json({
        error: 'feature_not_in_plan',
        feature: key,
        needs,
        message: `Not in your plan. This needs ${needs}.`,
      });
    }

    req.seoAddonTier = d.tier;
    req.seoFeature = { key, required, rung: d.tier, met, needs };
    return next();
  };
}

export default requireSeoAddon;
