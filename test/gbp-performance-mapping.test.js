// test/gbp-performance-mapping.test.js
//
// summarizePerformance hardening (GBP August batch, 2026-07-22): Google's
// Business Profile Performance API may split the requested dailyMetrics
// across MULTIPLE outer multiDailyMetricTimeSeries entries. The old code
// read only entry [0], silently zeroing whichever metrics landed in later
// entries — one route to the "Insights stat cards show nothing" symptom.

import test from "node:test";
import assert from "node:assert/strict";
import { summarizePerformance } from "../lib/gbpApi.js";

const day = (y, m, d) => ({ year: y, month: m, day: d });
const seriesOf = (metric, values) => ({
  dailyMetric: metric,
  timeSeries: {
    datedValues: values.map((v, i) => ({ date: day(2026, 7, i + 1), value: String(v) })),
  },
});

test("sums metrics split across multiple outer multiDailyMetricTimeSeries entries", () => {
  const payload = {
    multiDailyMetricTimeSeries: [
      { dailyMetricTimeSeries: [
        seriesOf("BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", [10, 20]),
        seriesOf("BUSINESS_IMPRESSIONS_MOBILE_SEARCH", [5, 5]),
      ] },
      // Google put the click/call metrics in a SECOND outer entry.
      { dailyMetricTimeSeries: [
        seriesOf("WEBSITE_CLICKS", [3, 4]),
        seriesOf("CALL_CLICKS", [1, 2]),
        seriesOf("BUSINESS_DIRECTION_REQUESTS", [7, 0]),
      ] },
    ],
  };
  const out = summarizePerformance(payload);
  assert.equal(out.impressions, 40, "both impression metrics counted");
  assert.equal(out.websiteClicks, 7, "second-entry metric must not be zeroed");
  assert.equal(out.calls, 3);
  assert.equal(out.directionsRequests, 7);
  assert.equal(out.dailyBreakdown.length, 2);
  assert.equal(out.dailyBreakdown[0].websiteClicks, 3);
});

test("single-entry payloads (the common case) are unchanged", () => {
  const payload = {
    multiDailyMetricTimeSeries: [
      { dailyMetricTimeSeries: [
        seriesOf("BUSINESS_IMPRESSIONS_DESKTOP_MAPS", [8]),
        seriesOf("WEBSITE_CLICKS", [2]),
      ] },
    ],
  };
  const out = summarizePerformance(payload);
  assert.equal(out.impressions, 8);
  assert.equal(out.websiteClicks, 2);
});

test("empty / missing payloads degrade to zeros, never throw", () => {
  for (const p of [null, undefined, {}, { multiDailyMetricTimeSeries: [] }]) {
    const out = summarizePerformance(p);
    assert.equal(out.impressions, 0);
    assert.deepEqual(out.dailyBreakdown, []);
  }
});
