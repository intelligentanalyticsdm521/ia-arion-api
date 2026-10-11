// middleware/requireFeature.js — ONE gate for every ARION feature, read from
// the feature catalog's answer.
//
// Brandon, 11 Oct 2026: "I would think we have a feature list and then a
// subscription tier list and those are synced up." The list is core.features
// (platform-api db/seed/feature_catalog.json). platform-api decides, for one
// business, every feature on it and serves the answer beside the subscription
// as payload.features[key] = { allowed: true|false|null, reason, needs,
// product, min_tier, addon, addon_min_tier, kind, availability }. This file
// only READS that answer through the repo's one entitlements client
// (lib/entitlements.js). Nothing in arion-api states a tier for a feature any
// more: a gate names a key, the catalog says what the key needs.
//
// THE RULE (the same in every repo; platform-api lib/featureCatalog.js
// featureGate, copied verbatim below and pinned by test/require-feature.test.mjs):
//
//   allowed true                       -> run
//   allowed false                      -> refuse: 403 { error:'feature_not_in_plan',
//                                         feature, needs, message } ("Not in your plan.
//                                         This needs ARION Pro.")
//   allowed null, a signed-in request  -> run, and log (a paying business is never
//                                         locked out by a hiccup)
//   allowed null, a send / cross-product
//     write / model spend / job        -> HOLD (nothing is done; asked again next time)
//   the key is missing from the answer -> a catalog mismatch: log at ERROR, run a
//                                         signed-in request, hold the rest
//
// No payload at all (platform-api unreachable or unset) or a catalog platform-api
// could not read (sources.catalog 'unreadable') is the same "undecided" outcome
// as allowed null: reads run, sends hold. It is logged at warn rather than
// error, because it is an outage, not a missing key.
//
// Overrides (core.tenant_feature_overrides) are already folded into `allowed`
// by platform-api; platform-level features (no product) always come back
// allowed true; FORGE / Consulting features come back allowed true.
import { featureDecision, intentForMethod, HELD_MESSAGE } from '../lib/featureGate.js';

export { featureGate, featureDecision, featuresOf, featureEntry, intentForMethod, HOLDING_INTENTS, HELD_MESSAGE } from '../lib/featureGate.js';

/** One log line per decision that asks for one. */
export function logDecision(d, tenantId, where) {
  if (!d || !d.log) return;
  const line = `[requireFeature] ${d.feature} for ${tenantId}${where ? ` on ${where}` : ''}: ${d.reason} -> ${d.action}`;
  if (d.log === 'error') console.error(line);
  else console.warn(line);
}

/** The HTTP answer for a decision that does not run. Returns true when it answered. */
export function answerRefusal(res, d) {
  if (d.action === 'refuse') {
    res.status(403).json(d.body || { error: 'feature_not_in_plan', feature: d.feature, needs: d.needs || null, message: 'Not available for this business.' });
    return true;
  }
  if (d.action === 'hold') {
    res.status(503).json({ error: 'plan_not_confirmed', feature: d.feature, message: HELD_MESSAGE });
    return true;
  }
  return false;
}

/**
 * Express middleware: the feature `key` must be in this business's plan.
 *
 * @param {string} key  a catalog feature key (must also be in test/fixtures/feature-keys.json)
 * @param {object} [opts]
 * @param {string|function} [opts.intent]  a fixed intent, or (req) => intent; default by method
 * @param {function} [opts.getEntitlements] test seam
 */
export function requireFeature(key, opts = {}) {
  if (!key || typeof key !== 'string') throw new Error('requireFeature needs a catalog feature key');
  return async function featureGateMiddleware(req, res, next) {
    const tenantId = req.tenant?.tenantId;
    if (!tenantId) return next(); // tenantResolution answers "which business?" upstream
    const intent = typeof opts.intent === 'function' ? opts.intent(req) : (opts.intent || intentForMethod(req.method));
    const d = await featureDecision(tenantId, key, intent, opts);
    logDecision(d, tenantId, String(req.originalUrl || req.path || '').split('?')[0]);
    if (answerRefusal(res, d)) return undefined;
    req.feature = { key, allowed: d.entry ? d.entry.allowed : null, needs: d.needs || null };
    return next();
  };
}

export default requireFeature;
