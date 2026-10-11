// lib/featureKeys.js — every feature key arion-api names, in one list, and
// the startup check that compares it with the catalog.
//
// Scope 2.4 (SCOPE_FEATURE_CATALOG_2026-10-11.md): "A startup check per app:
// fetch /internal/feature-catalog once, log every key in ROUTE_FEATURES /
// requireFeature calls that the catalog does not have." A key the catalog
// does not have is answered as "missing" for every business (a read runs, a
// send holds), so a typo is an outage of that feature; this says so at boot,
// once, in the log.
//
// test/feature-keys.test.mjs pins two things: every key below is in this
// repo's copy of the catalog keys (test/fixtures/feature-keys.json, refreshed
// from platform-api), and every requireFeature('...') / gate key literal in
// the source is in this list. platform-api scripts/_check-feature-keys.mjs
// diffs the fixture against the seed.
import { ROUTE_FEATURES } from '../middleware/arionRouteFeatures.js';
import { SEO_ROUTE_FEATURES, SEO_DEFAULT_FEATURE } from '../middleware/requireSeoAddon.js';
import { REVIEW_REPLY_FEATURE } from './gbpReplyRunner.js';
import { platformApiUrl, platformInternalToken } from './platformEnv.js';

/** Every catalog key arion-api gates on (sorted, unique). */
export function namedFeatureKeys() {
  const keys = new Set([
    ...ROUTE_FEATURES.map((r) => r.key),
    ...SEO_ROUTE_FEATURES.map((r) => r.key),
    SEO_DEFAULT_FEATURE,
    REVIEW_REPLY_FEATURE,
  ]);
  return [...keys].sort();
}

/**
 * Fetch GET /internal/feature-catalog once and log every named key it lacks.
 * Never throws; never blocks startup. Returns what it found (for tests).
 * @returns {Promise<{checked: boolean, missing: string[], count?: number, reason?: string}>}
 */
export async function checkFeatureKeysAtStartup(deps = {}) {
  const env = deps.env || process.env;
  const log = deps.log || console;
  const base = platformApiUrl(env);
  const tok = platformInternalToken(env);
  if (!base || !tok) {
    log.warn?.('[featureKeys] PLATFORM_API_URL / PLATFORM_INTERNAL_TOKEN not set; the feature keys were not checked against the catalog');
    return { checked: false, missing: [], reason: 'not_configured' };
  }
  const doFetch = deps.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(env.ENTITLEMENT_TIMEOUT_MS || 4000));
  try {
    const res = await doFetch(`${base}/internal/feature-catalog`, { headers: { 'x-internal-token': tok }, signal: controller.signal });
    if (!res.ok) {
      log.warn?.(`[featureKeys] platform-api answered ${res.status} for the feature catalog; the feature keys were not checked`);
      return { checked: false, missing: [], reason: `http_${res.status}` };
    }
    const body = await res.json();
    const have = new Set((body?.features || []).map((f) => String(f.key)));
    const missing = namedFeatureKeys().filter((k) => !have.has(k));
    if (missing.length) {
      log.error?.(`[featureKeys] ${missing.length} feature key(s) arion-api gates on are not in the catalog; every business is answered "missing" for them (reads run, sends hold): ${missing.join(', ')}`);
    } else {
      log.log?.(`[featureKeys] all ${namedFeatureKeys().length} feature keys arion-api gates on are in the catalog (${have.size} rows, version ${body?.catalog_version || 'unknown'})`);
    }
    return { checked: true, missing, count: have.size };
  } catch (err) {
    log.warn?.(`[featureKeys] could not read the feature catalog: ${err.message}`);
    return { checked: false, missing: [], reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

export default { namedFeatureKeys, checkFeatureKeysAtStartup };
