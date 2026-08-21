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
//   site row found, known add-on tier          → allow
//   site row found, unknown tier value         → allow + console.error
//   site not found for this tenant             → 404 (what the route says)
//   siteId missing                             → 400 (what every gated route
//                                                says; also closes the
//                                                siteId-less keyword-research
//                                                hole)
//   siteId malformed                           → let the route answer
//   DB lookup threw                            → allow + console.error
//
// Market Monitor additionally requires Authority. That check lives in-route,
// BEFORE any SE Ranking call (routes/arion.js /seo/market-monitor*, each
// returning the soft `authorityGated` payload the Portal renders as its
// upgrade CTA), so it is not duplicated here.

import sql from 'mssql';
import { getServicesPool } from '../db/servicesPool.js';

export const SEO_ADDON_TIERS = ['starter', 'essentials', 'growth', 'authority'];

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
 * Pure decision on the arion.site row (or null when not found).
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

/**
 * @param {{ loadSite?: (tenantId: string, siteId: string) => Promise<object|null> }} [opts]
 *        loadSite is injectable for tests; production uses the services pool.
 */
export function requireSeoAddon({ loadSite = defaultLoadSite } = {}) {
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
          message: 'This site has no SEO add-on. Add an Intelligent Analytics SEO package to unlock keywords, rankings, audits, competitors and AI search tracking.',
          status: 403,
          upgrade: { required_addon: 'seo', tiers: SEO_ADDON_TIERS },
        },
      });
    }
    if (d.reason) console.error(`[requireSeoAddon] ${d.reason} on site ${siteId}; allowing`);
    req.seoAddonTier = d.tier;
    return next();
  };
}

export default requireSeoAddon;
