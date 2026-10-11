// lib/featureGate.js — the feature catalog's rule, as code, for routes AND
// background runners. middleware/requireFeature.js is the Express face of it;
// a runner (lib/gbpReplyRunner.js) calls featureDecision() directly with the
// intent 'send' / 'spend' / 'job'. The full description is in
// middleware/requireFeature.js.
import { getEntitlements as defaultGetEntitlements } from './entitlements.js';

/** The intents that HOLD on an undecided answer. Everything else a signed-in person does runs and logs. */
export const HOLDING_INTENTS = Object.freeze(['send', 'cross_write', 'spend', 'job']);

/** What a held request is told, in plain words. */
export const HELD_MESSAGE = 'We could not confirm your plan just now, so nothing was done. Try again in a minute.';

/**
 * THE RULE, as code. A verbatim copy of platform-api lib/featureCatalog.js
 * featureGate (scope 2.3). Pure.
 *
 * @param {object} features  payload.features
 * @param {string} key       a catalog feature key
 * @param {string} [intent]  "read" | "write" | "send" | "cross_write" | "spend" | "job"
 * @returns {{action: "run"|"refuse"|"hold", log: null|"info"|"error", feature: string, reason: string, needs: string|null, body?: object}}
 */
export function featureGate(features, key, intent = "read") {
  const holds = HOLDING_INTENTS.includes(intent);
  const entry = features && Object.prototype.hasOwnProperty.call(features, key) ? features[key] : null;
  if (!entry) {
    const reason = `feature ${key} is not in the catalog answer`;
    return { action: holds ? "hold" : "run", log: "error", feature: key, reason, needs: null };
  }
  if (entry.allowed === true) return { action: "run", log: null, feature: key, reason: entry.reason, needs: null };
  if (entry.allowed === false) {
    return {
      action: "refuse", log: null, feature: key, reason: entry.reason, needs: entry.needs || null,
      body: {
        error: "feature_not_in_plan",
        feature: key,
        needs: entry.needs || null,
        message: entry.needs ? `Not in your plan. This needs ${entry.needs}.` : "Not available for this business.",
      },
    };
  }
  return { action: holds ? "hold" : "run", log: "info", feature: key, reason: entry.reason, needs: entry.needs || null };
}

/** A signed-in request's intent from its method: GET/HEAD/OPTIONS read, everything else writes. */
export function intentForMethod(method) {
  const m = String(method || 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD' || m === 'OPTIONS' ? 'read' : 'write';
}

/** payload.features when platform-api could read its catalog, else null. */
export function featuresOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.sources && payload.sources.catalog === 'unreadable') return null;
  return payload.features && typeof payload.features === 'object' ? payload.features : null;
}

/**
 * The catalog's entry for one key, or null (no payload, catalog unreadable, or
 * the key is not in the answer). Used where a caller needs the row's facts
 * (addon_min_tier for the SEO rung) rather than the verdict.
 */
export function featureEntry(payload, key) {
  const f = featuresOf(payload);
  return f && Object.prototype.hasOwnProperty.call(f, key) ? f[key] : null;
}

/**
 * The decision for one business and one key. Never throws.
 * @returns {Promise<{action, log, feature, reason, needs, body?, undecided?: boolean, entry: object|null, payload: object|null}>}
 */
export async function featureDecision(tenantId, key, intent = 'read', deps = {}) {
  let payload = null;
  try {
    payload = tenantId ? await (deps.getEntitlements || defaultGetEntitlements)(tenantId) : null;
  } catch (err) {
    console.warn(`[requireFeature] could not read the plan for ${tenantId}: ${err?.message}`);
    payload = null;
  }
  const features = featuresOf(payload);
  if (!features) {
    const holds = HOLDING_INTENTS.includes(intent);
    return {
      action: holds ? 'hold' : 'run', log: 'warn', feature: key, undecided: true, entry: null, payload,
      reason: payload ? 'the feature list could not be read' : "this business's plan could not be read",
      needs: null,
    };
  }
  const d = featureGate(features, key, intent);
  return { ...d, entry: features[key] || null, payload };
}


export default { featureGate, featureDecision, featuresOf, featureEntry, intentForMethod, HOLDING_INTENTS, HELD_MESSAGE };
