/**
 * IA Insights Intelligence states no tier of its own (11 Oct 2026, "one list").
 *
 * lib/intelligence/index.js carried a per-report tier table (REPORT_MIN_TIER:
 * Visibility Trajectory Standard, Backlink Velocity Pro, Crawl Budget
 * Business ...) beside an unlock table (TIER_UNLOCKS) that opened every report
 * for every tier, so the table decided nothing but still stated tiers outside
 * the feature catalog. Whether a business may open Intelligence at all is the
 * catalog's arion_ia_insights_intelligence, answered in front of the route by
 * middleware/arionRouteFeatures.js.
 *
 * Runs the REAL aggregator with an empty context (no database, no SE Ranking:
 * every calculator answers insufficient_data) for every rung word, and pins
 * that the tier table is gone from the source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAllArionIntelligence, ARION_INTEL_REPORTS } from '../lib/intelligence/index.js';
import { featureForPath } from '../middleware/arionRouteFeatures.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every report runs for every rung word; none is locked behind a tier', async () => {
  for (const tier of [undefined, '', 'starter', 'essentials', 'growth', 'authority', 'lite', 'standard', 'pro', 'business']) {
    const out = await runAllArionIntelligence({ tier });
    assert.deepEqual(Object.keys(out.reports).sort(), [...ARION_INTEL_REPORTS].sort(), String(tier));
    for (const [key, r] of Object.entries(out.reports)) {
      assert.notEqual(r.state, 'locked', `${key} at ${tier}`);
      assert.doesNotMatch(String(r.narrative || ''), /tier or above/i, `${key} at ${tier}`);
      assert.equal(r.requiredTier, undefined, `${key} at ${tier}`);
    }
    assert.deepEqual(out.unlockedReports, [...ARION_INTEL_REPORTS]);
  }
});

test('the per-report tier table is gone; the page is the catalog key in front of the route', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'intelligence', 'index.js'), 'utf8');
  assert.doesNotMatch(src, /^\s*(export\s+)?const\s+(REPORT_MIN_TIER|TIER_UNLOCKS)\b/m);
  assert.doesNotMatch(src, /\]:\s*'(lite|standard|pro|business|enterprise)'/, 'no report is mapped to a tier word');
  assert.equal(featureForPath('/arion/sites/x/intelligence')?.key, 'arion_ia_insights_intelligence');
});
