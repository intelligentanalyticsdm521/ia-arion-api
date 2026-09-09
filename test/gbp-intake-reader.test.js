// test/gbp-intake-reader.test.js
//
// D-69 — `GET /internal/gbp/:siteId/intake`, the reader SPARK's Google Business
// Profile lead source has been waiting on since pack 2.
//
// What these pin, and why each one is a defect that has actually shipped on this
// platform in some other file:
//
//   * a listing nobody connected answers `gbp_not_connected`, not zeroes —
//     "nobody tapped Call" and "there is no listing" are different answers;
//   * a Google failure is a 502 carrying Google's reason, NOT `ok:true` with
//     zeroes (reference_catch_swallow_report_success, thirteen instances);
//   * clicks come back as NUMBERS and never as rows — Google never says who
//     tapped Call, so a lead per tap is an inbox nobody can act on;
//   * the questions half reports WHY it is empty. Google retired the public Q&A
//     API in 2022, and `[]` with no reason reads as "a quiet week".
//
// Fake pool, fake Google. No network, no database.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readGbpIntake,
  windowDaysFor,
  questionsSince,
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  MIN_WINDOW_DAYS,
  SITE_SQL,
} from "../lib/gbpIntake.js";

const SITE = "11111111-2222-4333-8444-555555555555";

const CONNECTED = {
  site_id: SITE,
  tenant_id: "a0000001-0000-0000-0000-000000000001",
  gbp_connected: 1,
  gbp_oauth_token_ref: "refresh-token",
  gbp_location_name: "accounts/1/locations/2",
  status: "active",
};

function poolWith(row) {
  return {
    request() {
      const self = {
        inputs: {},
        input(k, _t, v) { self.inputs[k] = v === undefined ? _t : v; return self; },
        async query() { return { recordset: row ? [row] : [] }; },
      };
      return self;
    },
  };
}

/** Google answered. Two calls on Tuesday, five website taps, no questions. */
const goodDeps = {
  fetchPerformance: async () => ({ data: { fake: true } }),
  summarizePerformance: () => ({ calls: 2, websiteClicks: 5 }),
  fetchQuestions: async () => ({
    unavailable: true,
    reason: "google_api_retired",
    note: "Google retired the public Business Profile Q&A API.",
    questions: [],
  }),
};

test("the site row is looked up by the SAME connected predicate the rest of ARION uses", () => {
  assert.match(SITE_SQL, /FROM arion\.site/);
  assert.match(SITE_SQL, /gbp_connected/);
  assert.match(SITE_SQL, /gbp_oauth_token_ref/);
  assert.match(SITE_SQL, /gbp_location_name/);
});

test("a site that does not exist is a 404, not an empty success", async () => {
  const out = await readGbpIntake(poolWith(null), SITE, { deps: goodDeps });
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.equal(out.code, "site_not_found");
});

test("a malformed site id is a 400, not a thrown bind that reads as ARION being broken", async () => {
  const out = await readGbpIntake(poolWith(CONNECTED), "not-a-guid", { deps: goodDeps });
  assert.equal(out.status, 400);
  assert.equal(out.code, "bad_site_id");
});

test("a business with no Google connection is told so, and is never given zeroes", async () => {
  for (const row of [
    { ...CONNECTED, gbp_connected: 0 },
    { ...CONNECTED, gbp_oauth_token_ref: null },
    { ...CONNECTED, gbp_location_name: null },
    { ...CONNECTED, status: "disconnected" },
  ]) {
    const out = await readGbpIntake(poolWith(row), SITE, { deps: goodDeps });
    assert.equal(out.ok, false, JSON.stringify(row));
    assert.equal(out.status, 409);
    assert.equal(out.code, "gbp_not_connected");
    assert.equal(out.call_clicks, undefined, "a refusal must not carry a click count at all");
  }
});

test("a Google failure is a 502 carrying Google's reason — NEVER ok:true with zeroes", async () => {
  const out = await readGbpIntake(poolWith(CONNECTED), SITE, {
    deps: { ...goodDeps, fetchPerformance: async () => ({ error: "gbp_quota_exceeded" }) },
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 502);
  assert.equal(out.code, "gbp_performance_unavailable");
  assert.match(out.message, /gbp_quota_exceeded/);
});

test("a real zero is a real answer and comes back as ok", async () => {
  const out = await readGbpIntake(poolWith(CONNECTED), SITE, {
    deps: { ...goodDeps, summarizePerformance: () => ({ calls: 0, websiteClicks: 0 }) },
  });
  assert.equal(out.ok, true);
  assert.equal(out.call_clicks, 0);
  assert.equal(out.website_clicks, 0);
});

test("clicks come back as NUMBERS, and nothing that could become a lead row", async () => {
  const out = await readGbpIntake(poolWith(CONNECTED), SITE, { deps: goodDeps });
  assert.equal(out.ok, true);
  assert.equal(typeof out.call_clicks, "number");
  assert.equal(typeof out.website_clicks, "number");
  assert.equal(out.call_clicks, 2);
  assert.equal(out.website_clicks, 5);
  assert.deepEqual(out.questions, [], "a tap is not a person and must never arrive as a question");
});

test("the questions half says WHY it is empty", async () => {
  const out = await readGbpIntake(poolWith(CONNECTED), SITE, { deps: goodDeps });
  assert.equal(out.questions_available, false);
  assert.equal(out.questions_unavailable_reason, "google_api_retired");
  assert.ok(out.questions_unavailable_note.length > 0, "the reason has to be readable, not just a code");
});

test("if Google ever restores Q&A, the questions flow through unchanged", async () => {
  const out = await readGbpIntake(poolWith(CONNECTED), SITE, {
    deps: {
      ...goodDeps,
      fetchQuestions: async () => ({
        questions: [
          { name: "q/1", text: "Do you do gutters?", createTime: "2026-09-08T10:00:00Z" },
          { name: "q/2", text: "Old one", createTime: "2026-08-01T10:00:00Z" },
        ],
      }),
    },
    since: "2026-09-01T00:00:00Z",
  });
  assert.equal(out.questions_available, true);
  assert.equal(out.questions_unavailable_reason, null);
  assert.deepEqual(out.questions.map((q) => q.name), ["q/1"], "only what SPARK has not seen");
});

test("the click window is sized by when SPARK last looked, and clamped", () => {
  const now = new Date("2026-09-09T00:00:00Z");
  assert.equal(windowDaysFor(null, now), DEFAULT_WINDOW_DAYS);
  assert.equal(windowDaysFor("nonsense", now), DEFAULT_WINDOW_DAYS);
  assert.equal(windowDaysFor("2026-09-06T00:00:00Z", now), 3);
  assert.equal(windowDaysFor("2020-01-01T00:00:00Z", now), MAX_WINDOW_DAYS, "never ask Google for years");
  assert.equal(windowDaysFor("2026-09-09T00:00:00Z", now), MIN_WINDOW_DAYS, "and never for zero days");
});

test("a question with no timestamp is kept — losing a real one is worse than a duplicate", () => {
  const rows = questionsSince([{ name: "q/1" }], "2026-09-01T00:00:00Z");
  assert.equal(rows.length, 1, "the far side has an idempotency key; this side must not silently drop");
});

/* ── the route itself ──────────────────────────────────────────────────────
   Every /internal route is behind the ingest key, and since D-49 an unset key
   REFUSES rather than skipping. This one hands over a client's Google numbers,
   so it is worth naming rather than trusting the neighbours. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const internalSrc = fs.readFileSync(path.join(ROOT, "routes", "internal.js"), "utf8");

test("the intake route exists, and it is behind the ingest key", () => {
  assert.match(
    internalSrc,
    /router\.get\('\/gbp\/:siteId\/intake', requireIngestKey,/,
    "the reader must be mounted, and never without requireIngestKey",
  );
});

test("a refusal from the reader keeps its own status — 404/409/502 must not become 200 or 500", () => {
  const block = internalSrc.slice(internalSrc.indexOf("router.get('/gbp/:siteId/intake'"));
  assert.match(block.slice(0, 1400), /res\.status\(out\.status\)/);
});
