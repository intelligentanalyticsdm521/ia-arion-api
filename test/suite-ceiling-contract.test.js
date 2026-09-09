// test/suite-ceiling-contract.test.js (arion copy)
//
// The suite cost ceiling is ONE mechanism living in THREE deployments, because
// the agents run in three App Services and there is no shared package (the same
// arrangement the notification-gate client already has across five repos).
//
// The risk with three copies is silent drift: oliver halting at $25 while LUMEN
// reads a different column, or arion still calling the verdict 'over'. So the
// CONTRACT is frozen here — table names, the action list, the verdict words, the
// warn default, the fail direction — and each of the three repos asserts the
// same thing. Drift turns three tests red at once, in the same pass.
//
// The sibling-file comparison is best-effort: it runs when the other worktrees
// are checked out beside this one (which is how this platform is always laid
// out) and skips with a note when they are not. The frozen contract below is NOT
// optional, and it is the part that catches a rename.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ceiling from "../lib/argus/suiteCeiling.js";

/** THE contract. Change this only with the other two repos in the same pass. */
const CONTRACT = {
  CEILING_TABLE: "argus.governance_cost_config",
  SPEND_TABLE: "argus.ai_call_audit",
  DEFAULT_PERIOD_DAYS: 30,
  VERDICTS: ["ok", "warn", "breached", "no_ceiling_configured", "not_enforced", "ceiling_unreadable"],
  AGENT_ACTIONS: [
    "arion.content_draft",
    "arion.social_copy",
    "arion.content_quality_scan",
    "arion.topic_selection",
    "spark.campaign_agent_draft",
    "spark.campaign_agent_scan",
    "spark.responder_classify",
    "spark.responder_draft",
    "spark.responder_quote_draft",
    "oliver.qtc_agent_draft",
  ],
};

/** Where the other two copies live when the worktrees are side by side. */
const SIBLINGS = [
  { repo: "oliver-api", rel: "../../../oliver-api-septa-argus1/lib/governance/suiteCeiling.js" },
  { repo: "LUMEN-API", rel: "../../LUMEN-API-septa-argus1/src/lib/argus/suiteCeiling.js" },
];

test("the ceiling and the spend come from the tables the decision named", () => {
  assert.equal(ceiling.CEILING_TABLE, CONTRACT.CEILING_TABLE);
  assert.equal(ceiling.SPEND_TABLE, CONTRACT.SPEND_TABLE);
  assert.equal(ceiling.DEFAULT_PERIOD_DAYS, CONTRACT.DEFAULT_PERIOD_DAYS);
});

test("the verdict vocabulary is closed and identical in every repo", () => {
  assert.deepEqual(Object.values(ceiling.VERDICT).sort(), [...CONTRACT.VERDICTS].sort());
});

test("the agent action list is exactly the ten actions the agents spend on", () => {
  assert.deepEqual([...ceiling.AGENT_ACTIONS].sort(), [...CONTRACT.AGENT_ACTIONS].sort());
  // Field Ops must NOT be in it: its scorer is deterministic and spends nothing.
  assert.ok(!ceiling.AGENT_ACTIONS.some((a) => a.includes("fieldops")),
    "Field Ops has no priced action — a row for it would be a price for work that costs nothing");
  // Assist tools must NOT be in it: a business generating images must not have
  // its follow-up agent halted by its own image bill.
  for (const notAnAgent of ["my_brand.image_generate", "my_brand.write_assist", "spark.subject_lines", "il.judge"]) {
    assert.ok(!ceiling.AGENT_ACTIONS.includes(notAnAgent),
      `${notAnAgent} is an assist action, not agent spend — including it would cap the wrong budget`);
  }
});

test("the verdict rule: at the ceiling is breached, and breached is not allowed", () => {
  const at = ceiling.verdictFor({ totalUsd: 25, ceilingUsd: 25, warnRatio: 0.75, enforced: true });
  assert.equal(at.verdict, "breached");
  assert.equal(at.allowed, false, "a breach that still allows the run is the defect this pack exists to fix");

  const over = ceiling.verdictFor({ totalUsd: 40, ceilingUsd: 25, warnRatio: 0.75, enforced: true });
  assert.equal(over.verdict, "breached");
  assert.equal(over.allowed, false);

  const warn = ceiling.verdictFor({ totalUsd: 20, ceilingUsd: 25, warnRatio: 0.75, enforced: true });
  assert.equal(warn.verdict, "warn");
  assert.equal(warn.allowed, true, "a warning must not stop the work — it is a warning");

  const ok = ceiling.verdictFor({ totalUsd: 1, ceilingUsd: 25, warnRatio: 0.75, enforced: true });
  assert.equal(ok.verdict, "ok");
  assert.equal(ok.allowed, true);
});

test("no ceiling, and enforcement off, both allow the run and both SAY SO", () => {
  const none = ceiling.verdictFor({ totalUsd: 99, ceilingUsd: null, warnRatio: 0.75, enforced: true });
  assert.equal(none.verdict, "no_ceiling_configured");
  assert.equal(none.allowed, true);

  const off = ceiling.verdictFor({ totalUsd: 99, ceilingUsd: 25, warnRatio: 0.75, enforced: false });
  assert.equal(off.verdict, "not_enforced");
  assert.equal(off.allowed, true, "a switched-off ceiling caps nothing — that is what switched off means");
  assert.equal(off.ratio, 3.96, "it still reports the ratio, so 'off' is not the same as 'unknown'");
});

test("a zero or negative ceiling is not a ceiling of zero", () => {
  // A founder typing 0 into the box must not silently halt every agent forever.
  for (const bad of [0, -5]) {
    const v = ceiling.verdictFor({ totalUsd: 1, ceilingUsd: bad, warnRatio: 0.75, enforced: true });
    assert.equal(v.verdict, "no_ceiling_configured", `ceiling ${bad} must read as unset, not as a ceiling of ${bad}`);
    assert.equal(v.allowed, true);
  }
});

test("the message says what happened, in words, for every verdict", () => {
  for (const verdict of CONTRACT.VERDICTS) {
    const msg = ceiling.ceilingMessage(
      { verdict, totalUsd: 12.3456, ceilingUsd: 25, ratio: 0.4938, reason: "no permission" },
      "a0000001-0000-0000-0000-000000000001",
    );
    assert.ok(typeof msg === "string" && msg.length > 20, `${verdict} has no sentence`);
  }
  assert.match(
    ceiling.ceilingMessage({ verdict: "ceiling_unreadable", totalUsd: 0, ceilingUsd: null, ratio: null, reason: "denied" }, "t"),
    /NOT being checked/,
    "an unreadable ceiling must say out loud that nothing is being checked — 'we could not check' reading as 'it was fine' is the recurring bug on this platform",
  );
});

test("the other two repos hold the same contract", (t) => {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  let checked = 0;
  for (const s of SIBLINGS) {
    const p = path.resolve(here, s.rel);
    if (!fs.existsSync(p)) continue;
    checked += 1;
    const src = fs.readFileSync(p, "utf8");
    assert.match(src, new RegExp(`CEILING_TABLE = "${CONTRACT.CEILING_TABLE.replace(".", "\\.")}"`), `${s.repo}: ceiling table drifted`);
    assert.match(src, new RegExp(`SPEND_TABLE = "${CONTRACT.SPEND_TABLE.replace(".", "\\.")}"`), `${s.repo}: spend table drifted`);
    for (const a of CONTRACT.AGENT_ACTIONS) {
      assert.ok(src.includes(`"${a}"`), `${s.repo}: missing agent action ${a}`);
    }
    for (const v of CONTRACT.VERDICTS) {
      assert.ok(src.includes(`"${v}"`), `${s.repo}: missing verdict word ${v}`);
    }
  }
  if (checked === 0) {
    t.diagnostic("sibling worktrees not checked out beside this one — the frozen contract above still ran");
  }
});
