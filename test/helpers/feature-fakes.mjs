// test/helpers/feature-fakes.mjs — platform-api's entitlement payload with a
// `features` answer, for tests. No network, no database.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every key in this repo's copy of the catalog keys. */
export function fixtureKeys() {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'feature-keys.json'), 'utf8'));
  return Array.isArray(j) ? j : j.keys;
}

/** One features[key] entry. */
export function entry(allowed, over = {}) {
  return {
    allowed,
    reason: allowed === true ? 'ARION Pro includes it' : allowed === false ? 'needs ARION Pro; this business has ARION Lite' : 'could not tell whether ARION is in this business\'s subscription',
    needs: allowed === true ? null : 'ARION Pro',
    product: 'arion', min_tier: 'pro', addon: null, addon_min_tier: null, kind: 'page', availability: 'live',
    ...over,
  };
}

/** A getEntitlements stub answering these features (and every other catalog key allowed). */
export function planSaying(features = {}, { decided = true, catalog = 'ok', rest = true } = {}) {
  const all = {};
  if (rest) for (const k of fixtureKeys()) all[k] = entry(true);
  Object.assign(all, features);
  for (const [k, v] of Object.entries(features)) if (v === undefined) delete all[k];
  return async () => ({
    decided,
    products: { arion: { owned: true, tier: 'pro', decided } },
    addons: {},
    features: catalog === 'ok' ? all : {},
    sources: { catalog },
  });
}

/** Every catalog key allowed. */
export const ALLOW_ALL = planSaying({});
/** platform-api unreachable. */
export const UNREACHABLE = async () => null;
