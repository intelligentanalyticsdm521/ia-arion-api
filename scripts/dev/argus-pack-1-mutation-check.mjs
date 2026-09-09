// arion-api-septa-argus1/scripts/dev/argus-pack-1-mutation-check.mjs
//
// A green guard proves nothing until you make it fail on purpose
// (feedback_mutation_test_your_guards).
//
// Each mutation below BREAKS one guard ARGUS pack 1 added, runs the test that is
// supposed to catch it, and asserts the test goes RED. Then it puts the file
// back, byte for byte, and re-runs to prove the restore worked. A mutation that
// SURVIVES is printed as a survivor: the guard is decoration and the test is not
// pinning what it claims to pin.
//
//   node scripts/dev/argus-pack-1-mutation-check.mjs
//
// It edits files in the working tree and restores them from an in-memory copy in
// a finally block, so an interrupt cannot leave a mutation behind — and it
// verifies the restore rather than assuming it.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const abs = (p) => path.join(REPO, p);

/**
 * Each mutation: the file, the exact text to swap, and the test that must fail.
 *
 * `find` is asserted present before the swap. A mutation whose anchor has moved
 * is a mutation that silently tests nothing, so a missing anchor is a failure of
 * this harness and not a pass.
 */
const MUTATIONS = [
  {
    id: "M1",
    what: "the style compile writes a version even with NO new evidence",
    file: "lib/contentAgent/styleCompile.js",
    find: "    if (!signals.length) {",
    to: "    if (false) {",
    test: "test/argus-pack-1.test.js",
  },
  {
    id: "M2",
    what: "a profile below the evidence threshold is reported as IN USE",
    file: "lib/contentAgent/styleCompile.js",
    find: "      inUse: profile.evidenceCount >= MIN_EVIDENCE_FOR_CONFIDENCE,",
    to: "      inUse: true,",
    test: "test/argus-pack-1.test.js",
  },
  {
    id: "M3",
    what: "a failing compile throws into the tick and costs the drafting cycle",
    file: "lib/contentAgent/styleCompile.js",
    find: "    return { outcome: COMPILE.FAILED, tenantId, signals: null, reason: err.message };",
    to: "    throw err;",
    test: "test/argus-pack-1.test.js",
  },
  {
    id: "M4",
    what: "the compile moves AFTER drafting, so every profile is a week behind its evidence",
    file: "lib/contentAgent/tick.js",
    find: "      const learned = await compileStyleProfile({",
    to: "      const learned = { outcome: 'moved' }; // compileStyleProfile removed from the tick",
    test: "test/argus-pack-1.test.js",
  },
  {
    id: "M5",
    what: "a blank keyword is written as a candidate and collides with every other blank",
    file: "lib/contentAgent/keywordCandidates.js",
    find: "    if (!keyword || keyword.length > 300) { skipped += 1; continue; }",
    to: "    if (keyword.length > 300) { skipped += 1; continue; }",
    test: "test/argus-pack-1.test.js",
  },
  {
    id: "M6",
    what: "a research refresh resets a PUBLISHED keyword back to candidate",
    file: "lib/contentAgent/keywordCandidates.js",
    find: "            status = CASE WHEN tgt.status IN ('in_progress','published','rejected')\n                          THEN tgt.status ELSE 'candidate' END,",
    to: "            status = 'candidate',",
    test: "test/argus-pack-1.test.js",
  },
  {
    id: "M7",
    what: "a tenant-scoped write proceeds without a real tenant",
    file: "lib/contentAgent/keywordCandidates.js",
    find: "  if (!tenantId || typeof tenantId !== 'string' || !GUID_RE.test(tenantId)) {",
    to: "  if (false) {",
    test: "test/argus-pack-1.test.js",
  },
  {
    id: "M8",
    what: "an escalated draft becomes approvable from the page (AC2 broken)",
    file: "lib/agents/activity.js",
    find: "    can_decide: row.review_status === 'pending',",
    to: "    can_decide: row.review_status === 'pending' || row.review_status === 'escalated',",
    test: "test/argus-pack-1.test.js",
  },
  {
    id: "M9",
    what: "approving is treated as publishing, so one click could put it live",
    file: "lib/agents/activity.js",
    find: "    can_publish: (row.review_status === 'approved' || row.review_status === 'edited') && !published,",
    to: "    can_publish: false,",
    test: "test/argus-pack-1.test.js",
  },
  {
    id: "M10",
    what: "the client's edit is discarded and the agent's original publishes",
    file: "lib/agents/activity.js",
    find: "      body: row.body_markdown_final || row.body_markdown || null,",
    to: "      body: row.body_markdown || null,",
    test: "test/argus-pack-1.test.js",
  },
  {
    id: "M11",
    what: "our provider cost appears on a client surface (AG-1 broken)",
    file: "lib/agents/activity.js",
    find: "    cost_units: null,\n    cost_note: COST_NOTE.AI,",
    to: "    cost_units: null,\n    cost_usd: 0.0741,\n    cost_note: COST_NOTE.AI,",
    test: "test/argus-pack-1.test.js",
  },
  {
    id: "M12",
    what: "the runner stops consulting the shared governance rules",
    file: "lib/contentAgent/runner.js",
    find: "    const governance = await loadEscalationMatcher(pool, tenantId, 'arion_content');",
    to: "    const governance = { unavailable: null, ruleCount: 0, match: () => ({ escalate: false, hits: [] }) };",
    test: "test/argus-pack-1.test.js",
  },
  {
    id: "M13",
    what: "the runner stops persisting research, so the backlog stays empty for ever",
    file: "lib/contentAgent/runner.js",
    find: "        const kept = await recordResearch({",
    to: "        const kept = { written: 0, skipped: 0 }; await Promise.resolve({",
    test: "test/argus-pack-1.test.js",
  },
  {
    id: "M14",
    what: "the suite ceiling is checked AFTER the per-cycle budget, so a breached business opens a run",
    file: "lib/contentAgent/runner.js",
    find: "  const suite = await suiteCeilingCheck(pool, tenantId);",
    to: "  const suite = { allowed: true, verdict: 'ok', perAgentCeilingUsd: null, message: '' }; // suiteCeilingCheck moved",
    test: "test/argus-pack-1.test.js",
  },
  {
    id: "M15",
    what: "the price gains a hardcoded default, which then quietly becomes the real price",
    file: "routes/arion/agents.js",
    find: "  if (v === null || v === '') return null;",
    to: "  if (v === null || v === '') return 199;",
    test: "test/argus-pack-1.test.js",
  },
  {
    id: "M16",
    what: "the posts-per-week cadence is no longer clamped",
    file: "routes/arion/agents.js",
    find: "        : clampInt(p.posts_per_week, 1, 14, cur.settings.posts_per_week);",
    to: "        : Number(p.posts_per_week);",
    test: "test/argus-pack-1.test.js",
  },
  {
    id: "M17",
    what: "the migration header check stops tolerating CRLF, so a fresh worktree fails",
    file: "db/migrations/063_content_agent.sql",
    find: "-- 063_content_agent.sql",
    to: "-- 63_content_agent.sql",
    test: "test/content-agent-wiring.test.js",
  },
];

let caught = 0;
let survived = 0;
const survivors = [];

function runTest(file) {
  const r = spawnSync(process.execPath, ["--test", file], { cwd: REPO, encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const m = /^# fail (\d+)$/m.exec(out);
  return { failed: m ? Number(m[1]) : (r.status === 0 ? 0 : 1), out };
}

console.log("ARGUS pack 1 — arion-api mutation check");
console.log("Each line breaks one guard and asserts the test that should catch it goes RED.\n");

for (const m of MUTATIONS) {
  const p = abs(m.file);
  const original = fs.readFileSync(p, "utf8");
  if (!original.includes(m.find)) {
    survived += 1;
    survivors.push(`${m.id}: ANCHOR MISSING in ${m.file} — this mutation tested nothing. Fix the harness.`);
    console.log(`  ????  ${m.id}  ${m.what}\n        anchor not found in ${m.file}`);
    continue;
  }
  try {
    // EVERY occurrence, not the first. A rule that appears twice in a file — the
    // same guard in two tables, the same confirm prompt in two branches — is
    // "broken" only when both copies are broken, and replacing one left the test
    // matching the survivor and reported a false SURVIVED. Found by this harness
    // being wrong about the Portal.
    const mutated = original.split(m.find).join(m.to);
    fs.writeFileSync(p, mutated, "utf8");
    const { failed } = runTest(m.test);
    if (failed > 0) {
      caught += 1;
      console.log(`  RED   ${m.id}  ${m.what}\n        caught by ${m.test} (${failed} failing)`);
    } else {
      survived += 1;
      survivors.push(`${m.id}: ${m.what} — SURVIVED ${m.test}`);
      console.log(`  GREEN ${m.id}  ${m.what}\n        !! SURVIVED ${m.test} — the guard is decoration`);
    }
  } finally {
    fs.writeFileSync(p, original, "utf8");
    if (fs.readFileSync(p, "utf8") !== original) {
      console.error(`\n!! ${m.file} was NOT restored. Fix it by hand before committing.`);
      process.exit(2);
    }
  }
}

// The suite must be green again, or the restore lied.
console.log("\nre-running both guard files to prove the restore:");
for (const f of ["test/argus-pack-1.test.js", "test/suite-ceiling-contract.test.js", "test/content-agent-wiring.test.js"]) {
  const { failed } = runTest(f);
  console.log(`  ${failed === 0 ? "PASS" : "FAIL"}  ${f} back to ${failed} failing`);
  if (failed !== 0) process.exit(2);
}

console.log(`\n${caught}/${MUTATIONS.length} mutations caught`);
if (survivors.length) {
  console.log("\nSURVIVORS — each one is a guard that does not guard:");
  for (const s of survivors) console.log(`  · ${s}`);
}
process.exit(survived === 0 ? 0 : 1);
