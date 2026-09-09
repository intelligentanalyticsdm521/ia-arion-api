// test/argus-pack-1.test.js — the guards ARGUS pack 1 added, in arion-api.
//
// Three capabilities that did not exist, and the guards that keep them honest:
//
//   1. THE AGENT LEARNS. `buildProfile` / `saveProfileVersion` /
//      `unconsumedSignals` had no caller anywhere, so
//      `arion.content_agent_tenant_style` had zero rows, `loadActiveProfile`
//      always returned null and every draft was written with
//      `style_profile_id = NULL`. The compile step is what closes that loop, and
//      the thing to guard is that it never INVENTS a profile out of nothing.
//   2. THE KEYWORD TRACKER IS WRITTEN. Nothing wrote
//      `arion.content_keyword_candidate`, so research was used once and thrown
//      away and the F1/F6 backlog only ever held hand-typed rows.
//   3. THE AGENT CAN BE SWITCHED ON. `content_agent_tenant_config` IS the
//      product, and the only write to it was the sticky halt.
//
// No database and no network: the pure halves are pure on purpose.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { COMPILE, compileStyleProfile } from "../lib/contentAgent/styleCompile.js";
import {
  buildProfile, measureStyle, confidenceFor, renderStyleContext,
  MIN_EVIDENCE_FOR_CONFIDENCE, SIGNAL_KIND,
} from "../lib/contentAgent/styleProfile.js";
import { CANDIDATE_STATUS, recordResearch } from "../lib/contentAgent/keywordCandidates.js";
import ceiling from "../lib/argus/suiteCeiling.js";
import gov from "../lib/argus/governanceRules.js";
import runs from "../lib/agents/runs.js";
import { ARION_AGENTS, normaliseContentRow } from "../lib/agents/activity.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ── 1. it learns, and only from real evidence ────────────────────────── */

test("no new evidence compiles NOTHING — a version number is not a milestone", async () => {
  // A profile version identical to the last one would burn a version, re-stamp
  // learned_through, and make "it learned something" indistinguishable from
  // "the tick ran".
  let saved = 0;
  const r = await compileStyleProfile({
    pool: {}, tenantId: "a0000001-0000-0000-0000-000000000001",
    deps: {
      unconsumedSignals: async () => [],
      saveProfileVersion: async () => { saved += 1; return "x"; },
    },
  });
  assert.equal(r.outcome, COMPILE.NO_NEW_EVIDENCE);
  assert.equal(r.signals, 0);
  assert.equal(saved, 0, "nothing may be written when there is nothing to learn from");
});

test("one human edit compiles one version, and it traces to that edit", async () => {
  const signals = [{
    signal_kind: SIGNAL_KIND.EDITED, field_name: "body", edit_distance: 42,
    before_text: "This is a genuinely transformative solution for your business.",
    after_text: "This does one specific thing for your business.",
    reviewer_note: "no hype",
  }];
  let written = null;
  const r = await compileStyleProfile({
    pool: {}, tenantId: "a0000001-0000-0000-0000-000000000001",
    deps: {
      unconsumedSignals: async () => signals,
      publishedTexts: async () => ["## A heading\n\nA short paragraph. Another one.\n"],
      loadActiveProfile: async () => null,
      saveProfileVersion: async (_p, _t, profile) => { written = profile; return "style-1"; },
    },
  });
  assert.equal(r.outcome, COMPILE.COMPILED);
  assert.equal(r.version, 1);
  assert.equal(r.exemplars, 1, "the edit itself is kept as the example to write like");
  assert.ok(written.vocabulary.banned.includes("transformative"),
    "a word the human took out is a word the agent stops using");
  assert.ok(written.formatting.measured, "and the measurable half is measured, not guessed");
});

test("a profile below the evidence threshold EXISTS but is not USED", async () => {
  // "It learned" and "it is drafting from what it learned" are different claims,
  // and conflating them is how a POC over-promises.
  const few = Array.from({ length: MIN_EVIDENCE_FOR_CONFIDENCE - 1 }, () => ({
    signal_kind: SIGNAL_KIND.APPROVED_AS_IS,
  }));
  const r = await compileStyleProfile({
    pool: {}, tenantId: "a0000001-0000-0000-0000-000000000001",
    deps: {
      unconsumedSignals: async () => few,
      publishedTexts: async () => [],
      loadActiveProfile: async () => null,
      saveProfileVersion: async () => "s",
    },
  });
  assert.equal(r.outcome, COMPILE.COMPILED);
  assert.equal(r.inUse, false);
  assert.equal(confidenceFor(few.length), 0);
  // And rendering it into a prompt returns nothing, so drafts fall back to the
  // declared brand voice rather than a voice invented from four data points.
  assert.equal(renderStyleContext(buildProfile({ signals: few })), "");
});

test("a compile that fails NEVER costs the drafting cycle that follows it", async () => {
  const r = await compileStyleProfile({
    pool: {}, tenantId: "a0000001-0000-0000-0000-000000000001",
    deps: { unconsumedSignals: async () => { throw new Error("permission denied"); } },
  });
  assert.equal(r.outcome, COMPILE.FAILED);
  assert.match(r.reason, /permission denied/);
});

test("the compile runs BEFORE drafting, so this week uses last week's lessons", () => {
  const tick = fs.readFileSync(path.join(HERE, "..", "lib", "contentAgent", "tick.js"), "utf8");
  const compileAt = tick.indexOf("compileStyleProfile({");
  const cycleAt = tick.indexOf("const result = await cycle({");
  assert.ok(compileAt > -1 && cycleAt > -1, "both steps must be in the tick");
  assert.ok(compileAt < cycleAt, "compiling AFTER drafting leaves every profile a week behind its evidence");
});

test("style measurement counts what is countable and nothing else", () => {
  const m = measureStyle(["## H\n\nOne two three four five!\n\nSix seven.\n"]);
  assert.equal(typeof m.avgSentenceWords, "number");
  assert.equal(m.usesHeadings, true);
  assert.ok(m.exclamationsPer1k > 0);
  assert.equal(measureStyle([]), null, "no samples means no measurement, not a zero");
});

/* ── 2. the keyword tracker ───────────────────────────────────────────── */

test("a blank keyword is not a candidate — it would collide with every other blank", async () => {
  const seen = [];
  const pool = {
    request() {
      return { input() { return this; }, async query(q) { seen.push(q); return { recordset: [] }; } };
    },
  };
  const r = await recordResearch({
    pool, tenantId: "a0000001-0000-0000-0000-000000000001",
    rows: [{ keyword: "" }, { keyword: "   " }, { keyword: null }, { keyword: "real keyword" }],
  });
  assert.equal(r.written, 1);
  assert.equal(r.skipped, 3);
  assert.equal(seen.length, 1, "three blanks must produce no statements at all");
});

test("research REFRESHES a keyword and never walks its status back", async () => {
  const seen = [];
  const pool = {
    request() {
      return { input() { return this; }, async query(q) { seen.push(q); return { recordset: [] }; } };
    },
  };
  await recordResearch({
    pool, tenantId: "a0000001-0000-0000-0000-000000000001",
    rows: [{ keyword: "website audit", volume: 300, kd: 12, intent: "informational" }],
    source: "se_ranking",
  });
  const q = seen[0];
  assert.match(q, /MERGE arion\.content_keyword_candidate/, "the unique index is the arbiter, not a pre-SELECT");
  assert.match(q, /WHEN MATCHED THEN UPDATE/);
  assert.match(q, /last_researched_at = SYSDATETIMEOFFSET\(\)/, "so E4's staleness re-pull has something to read");
  assert.match(q, /status IN \('in_progress','published','rejected'\)\s*\n?\s*THEN tgt\.status/,
    "a refresh must not reset the tracker's memory of what has been written");
  assert.match(q, /COALESCE\(@vol, tgt\.search_volume\)/, "a missing volume must not erase a known one");
});

test("a tenant-scoped write refuses to run without a real tenant", async () => {
  for (const bad of [null, "", "not-a-guid", 42]) {
    await assert.rejects(
      () => recordResearch({ pool: {}, tenantId: bad, rows: [{ keyword: "x" }] }),
      /valid tenant scope/,
    );
  }
});

test("the status vocabulary matches the CHECK constraint the migration declares", () => {
  const sqlText = fs.readFileSync(path.join(HERE, "..", "db", "migrations", "063_content_agent.sql"), "utf8");
  for (const v of Object.values(CANDIDATE_STATUS)) {
    assert.ok(sqlText.includes(`'${v}'`), `status '${v}' is not in the CHECK constraint`);
  }
});

/* ── 3. switching it on, and what a client can see ────────────────────── */

test("the settings route is the only writer of the config row besides the halt", () => {
  const route = fs.readFileSync(path.join(HERE, "..", "routes", "arion", "agents.js"), "utf8");
  assert.match(route, /MERGE arion\.content_agent_tenant_config/, "it must UPSERT — a business with no row is the normal start");
  assert.match(route, /price_usd_monthly/);
  assert.match(route, /slots_per_cycle/);
  // A price comes from CONFIGURATION, never from code. `cleanPrice` must never
  // hand back a number of its own: a default here would quietly become the real
  // price for every business nobody had priced (no-fabricated-catalog).
  const cleanPrice = /function cleanPrice\([\s\S]*?\n\}/.exec(route);
  assert.ok(cleanPrice, "cleanPrice is where a default would sneak in — it must still be there to check");
  assert.equal(/return\s+\d/.test(cleanPrice[0]), false,
    "cleanPrice returns a numeric literal, which is a fabricated price");
  assert.match(cleanPrice[0], /return null;/, "an empty price stays empty, and that is a real answer");
  assert.match(route, /clampInt\(p\.posts_per_week, 1, 14/, "an absurd cadence is clamped");
});

test("an escalated draft is not approvable from the page, and says why", () => {
  const row = normaliseContentRow({
    output_id: "o1", content_type: "blog_post", primary_keyword: "website audit",
    title: "A title", body_markdown: "body", review_status: "escalated",
    created_at: new Date().toISOString(), decision_rule_flags_json: "[]",
  });
  assert.equal(row.can_decide, false, "AC2 — a held draft in the normal list is the mistake escalation prevents");
  assert.match(row.status_label, /Held back/);
  assert.match(row.hold_note, /not approvable/);
});

test("approving is not publishing — they are two states and two presses", () => {
  const approved = normaliseContentRow({
    output_id: "o2", content_type: "blog_post", title: "A title", body_markdown: "body",
    review_status: "approved", approved_at: new Date().toISOString(), published_at: null,
    created_at: new Date().toISOString(), decision_rule_flags_json: "[]",
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.can_publish, true);
  assert.match(approved.hold_note, /separate button/);

  const live = normaliseContentRow({
    output_id: "o3", content_type: "blog_post", title: "A title", body_markdown: "body",
    review_status: "approved", approved_at: new Date().toISOString(),
    published_at: new Date().toISOString(), url_slug: "a-title", wordpress_post_id: 41,
    created_at: new Date().toISOString(), decision_rule_flags_json: "[]",
  });
  assert.equal(live.can_publish, false);
  assert.match(live.status_label, /Live on your website/);
});

test("your edit is what publishes, and the agent's original is kept beside it", () => {
  const row = normaliseContentRow({
    output_id: "o4", content_type: "blog_post", title: "A title",
    body_markdown: "what the agent wrote", body_markdown_final: "what you approved",
    review_status: "edited", created_at: new Date().toISOString(), decision_rule_flags_json: "[]",
  });
  assert.equal(row.detail.body, "what you approved");
  assert.equal(row.detail.agent_original, "what the agent wrote");
});

test("a carousel with no rendered slides says so rather than showing a gap", () => {
  const row = normaliseContentRow({
    output_id: "o5", content_type: "social_carousel", title: "A carousel",
    body_markdown: "copy", review_status: "pending", asset_uri: null,
    created_at: new Date().toISOString(), decision_rule_flags_json: "[]",
  });
  assert.equal(row.detail.needs_manual_render, true);
});

test("no client surface carries a dollar figure", () => {
  const row = normaliseContentRow({
    output_id: "o6", content_type: "blog_post", title: "t", body_markdown: "b",
    review_status: "pending", created_at: new Date().toISOString(), decision_rule_flags_json: "[]",
  });
  assert.equal("cost_usd" in row, false);
  assert.match(row.cost_note, /ARGUS AI/);
  assert.match(row.attribution, /^Created by Intelligent Analytics — /);
  assert.equal(ARION_AGENTS.content.drafts_with_ai, true);
});

test("the run history explains an empty week rather than looking broken", () => {
  assert.match(
    runs.outcomeWords({ status: "completed", drafted: 0, flags: [{ rule: "no_qualifying_topic" }] }).label,
    /worth writing about/);
  assert.equal(
    runs.outcomeWords({ status: "completed", drafted: 0, flags: [{ rule: "suite_ceiling_breached" }] }).outcome,
    "halted");
  for (const rule of Object.keys(runs.FLAG_WORDS)) {
    assert.ok(runs.flagSentence({ rule }).length > 10, `${rule} has no sentence`);
  }
});

/* ── 4. the shared ARGUS contracts, same as the other two repos ───────── */

test("the ceiling and the rules are the same contract here as in oliver", () => {
  assert.equal(ceiling.CEILING_TABLE, "argus.governance_cost_config");
  assert.equal(ceiling.SPEND_TABLE, "argus.ai_call_audit");
  assert.equal(ceiling.verdictFor({ totalUsd: 30, ceilingUsd: 25, warnRatio: 0.75, enforced: true }).allowed, false);
  const rules = [{
    rule_id: "r", name: "n", active: true, rule_type: "escalation",
    applies_to_agents: null, rule_definition: { match: { any_of: ["guarantee"] } },
  }];
  assert.equal(gov.evaluateEscalation("we guarantee", rules, "arion_content").escalate, true);
});

test("the content agent's runner consults both rings and the shared rules", () => {
  const src = fs.readFileSync(path.join(HERE, "..", "lib", "contentAgent", "runner.js"), "utf8");
  assert.match(src, /suiteCeilingCheck\(pool, tenantId\)/);
  assert.match(src, /loadEscalationMatcher\(pool, tenantId, 'arion_content'\)/);
  assert.match(src, /recordResearch\(/, "research must be persisted, not used once and thrown away");
  assert.match(src, /markInProgress\(/);
  assert.ok(src.indexOf("suiteCeilingCheck") < src.indexOf("checkCycleBudget(pool, tenantId,"),
    "the suite ceiling is checked before the per-cycle budget");
});
