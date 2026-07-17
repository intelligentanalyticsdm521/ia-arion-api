// test/seo-onboarding-idempotency.test.js
//
// Pins the SE Ranking duplicate-project bug. This is a MONEY path: SE Ranking
// bills by keywords tracked, so a duplicate project is a duplicate bill, forever,
// silently.
//
// WHAT WAS WRONG — two independent bugs, stacked:
//
//   1. routes/internal.js loadSiteRow() did NOT select se_ranking_project_id.
//      configureForTier (seoOnboarding.js:270) reads
//          let projectId = site.se_ranking_project_id || null;
//      to decide whether a project already exists. With the column absent it was
//      always undefined, so :271's `if (!projectId)` was ALWAYS true and it
//      created a BRAND NEW, BILLABLE project every time — even for a site that
//      already had one. The guard was not weak; it was BLIND.
//
//   2. persistResult is declared (pool, tenantId, siteId, result) — four args —
//      and was called with two: persistResult(site_id, result). `pool` became a
//      string, pool.request() threw, the catch swallowed it, and the route still
//      returned ok:true. So the new project's id was never recorded, and the next
//      run could not learn it existed.
//
// 🪤 FIXING ONLY ONE IS WORSE THAN THE BUG:
//    - arity only  -> the guard is still blind, so it still creates the
//                     duplicate, and now SUCCESSFULLY SAVES it over the real id.
//    - SELECT only -> the guard works, but nothing is ever recorded.
//    Both, or neither. (Third time this shape appeared: campaign_recipient needed
//    the NOT NULL too; suppression_list needed `domain` relaxed, not just `email`
//    added.)
//
// A real orphan came from this: project 4537010 (shimsremodeling.com) was billing
// 220 keywords on daily checks for a CANCELLED client, with no arion.site row
// pointing at it. Deleted 2026-07-16 (saved 220 of 801 billed keywords).

import test from "node:test";
import assert from "node:assert/strict";

import { configureForTier } from "../lib/seoOnboarding.js";

// ─────────────────────────────────────────────────────────────────────────────
// THE GUARD — the half that decides whether we get billed
// ─────────────────────────────────────────────────────────────────────────────

test("a site that ALREADY has a project must not create another (the money bug)", async () => {
  // Exactly what loadSiteRow now returns for Briarwood: a real, existing project.
  const site = {
    site_id: "45e93346-0000-0000-0000-000000000000",
    tenant_id: "45e93346-1111-0000-0000-000000000000",
    domain: "briarwoodsmiles.com",
    tier: "growth",
    se_ranking_project_id: "2671555", // ← the column loadSiteRow used to omit
  };

  const result = await configureForTier(site, "growth");

  // configureForTier reuses the id rather than creating. If this comes back as
  // anything else, we just bought a second subscription for a site we already pay
  // for. Note it may still report errors (no live API key in a unit test) — what
  // matters is that it did not decide to CREATE.
  assert.equal(
    String(result.projectId ?? ""),
    "2671555",
    `expected the EXISTING project to be reused; got ${result.projectId} — this is a duplicate paid project`
  );
});

test("the blind-guard reproduction: an absent column reads as 'no project'", () => {
  // This is precisely what loadSiteRow's old SELECT produced — the property is
  // simply not there, which is indistinguishable from "this site has no project".
  const siteFromOldSelect = {
    site_id: "x", tenant_id: "y", domain: "briarwoodsmiles.com", tier: "growth",
    // se_ranking_project_id — NOT SELECTED
  };
  const siteFromNewSelect = { ...siteFromOldSelect, se_ranking_project_id: "2671555" };

  // seoOnboarding.js:270 — verbatim.
  const decide = (s) => s.se_ranking_project_id || null;

  assert.equal(decide(siteFromOldSelect), null,
    "the old SELECT made every site look brand new -> always create -> always bill");
  assert.equal(decide(siteFromNewSelect), "2671555",
    "the new SELECT lets the guard see the truth");
});

// ─────────────────────────────────────────────────────────────────────────────
// THE RECORDING — the half that stops the NEXT run duplicating
// ─────────────────────────────────────────────────────────────────────────────

function mockPool() {
  const calls = [];
  return {
    calls,
    request() {
      const inputs = {};
      const req = {
        input(n, _t, v) { inputs[n] = arguments.length >= 3 ? v : _t; return req; },
        async query(sqlText) { calls.push({ sql: String(sqlText), inputs }); return { rowsAffected: [1] }; },
      };
      return req;
    },
  };
}

test("persistResult records the project id with the arity it actually declares", async () => {
  const { persistResult } = await import("../lib/seoOnboarding.js");
  const pool = mockPool();

  // The signature is (pool, tenantId, siteId, result). Called with two args, as
  // it used to be, `pool` is a string and pool.request() is a TypeError.
  await persistResult(pool, "45e93346-1111-0000-0000-000000000000", "45e93346-0000-0000-0000-000000000000", {
    projectId: "2671555",
    auditId: "aud-1",
  });

  assert.equal(pool.calls.length, 1, "persistResult did not reach the database");
  const { sql: text, inputs } = pool.calls[0];
  assert.match(text, /UPDATE arion\.site/i);
  assert.match(text, /se_ranking_project_id\s*=\s*COALESCE/i, "the project id is not being written");
  assert.equal(inputs.projectId, "2671555");
});

test("persistResult ALSO writes the audit id (the fallback used to drop it)", async () => {
  const { persistResult } = await import("../lib/seoOnboarding.js");
  const pool = mockPool();
  await persistResult(pool, "t", "s", { projectId: "111", auditId: "aud-9" });

  const { sql: text, inputs } = pool.calls[0];
  // The old statement also wrote se_ranking_onboarding_snapshot — a PHANTOM column
  // — so it always threw Msg 207, always hit the .catch, and the fallback saved
  // only the project id. se_ranking_audit_id is real and was silently never
  // written, because of a phantom sibling in the same statement.
  assert.match(text, /se_ranking_audit_id\s*=\s*COALESCE/i, "audit id is not written");
  assert.equal(inputs.auditId, "aud-9");
  assert.doesNotMatch(text, /se_ranking_onboarding_snapshot/i,
    "still writing the phantom snapshot column — this forces the whole UPDATE down the fallback");
});

test("a single UPDATE, not a fallback — a fallback that always fires is the code path", async () => {
  const { persistResult } = await import("../lib/seoOnboarding.js");
  const pool = mockPool();
  await persistResult(pool, "t", "s", { projectId: "111", auditId: "a" });
  assert.equal(pool.calls.length, 1, "more than one statement — the dead fallback is still in play");
});
