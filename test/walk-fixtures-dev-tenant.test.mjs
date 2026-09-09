/**
 * The SPARK-ONLY walk fixture must be a dev tenant in EVERY backend, and the
 * founder tenant must still be refused.
 *
 * WHY THIS FILE EXISTS IN FOUR REPOS AT ONCE. Pre-walk pass 3 (2026-09-09)
 * found that ARGUS pack 1 had added its POC fixture to the dev-auth allow-list
 * in oliver-api, arion-api and LUMEN-API and MISSED platform-api - the first
 * API the Portal calls - so the business picker answered 401 and the whole
 * Portal half of that walk was unreachable while three back-end APIs answered
 * happily. That is what made it hard to see. A fixture added to three lists out
 * of four is a fixture that looks seeded and cannot be opened, so each repo
 * pins its own list here.
 *
 * Redbird Insurance (d0000004-...) owns SPARK and nothing else and has never
 * marketed to anybody. It exists for SPARK rows S7.1, S7.2 and S7.3 - what IA
 * Insights says when there is nothing to say, and whether a cross-product tile
 * invents a score for a product the business does not own. Seeded and deleted
 * by platform-api/scripts/dev/seed-walk-spark-only-business.cjs.
 *
 * The founder assertions are not decoration: widening the list by one fixture
 * must not have touched the thing the list exists to refuse.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { requestedDevTenant } from "../lib/devAuth.js";
import { FOUNDER_TENANT_ID_DEFAULT } from "../lib/agency.js";

const SPARK_ONLY_FIXTURE = "d0000004-0000-0000-0000-000000000004";

/** Run fn in a world where the dev seam is active and nothing else is set. */
function inDevWorld(fn) {
  const saved = {};
  for (const k of ["DEV_AUTH", "NODE_ENV", "WEBSITE_SITE_NAME", "DEV_AUTH_TENANTS"]) {
    saved[k] = process.env[k];
  }
  process.env.DEV_AUTH = "1";
  delete process.env.NODE_ENV;
  delete process.env.WEBSITE_SITE_NAME;
  delete process.env.DEV_AUTH_TENANTS;   // the built-in list is what is under test
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const asReq = (guid) => ({ headers: { "x-dev-tenant": guid } });

test("the SPARK-only walk fixture is a dev tenant here", () => {
  inDevWorld(() => {
    assert.equal(requestedDevTenant(asReq(SPARK_ONLY_FIXTURE)), SPARK_ONLY_FIXTURE);
  });
});

test("it is honoured however it is typed", () => {
  inDevWorld(() => {
    assert.equal(requestedDevTenant(asReq(SPARK_ONLY_FIXTURE.toUpperCase())), SPARK_ONLY_FIXTURE);
    assert.equal(requestedDevTenant(asReq(` ${SPARK_ONLY_FIXTURE} `)), SPARK_ONLY_FIXTURE);
  });
});

test("the founder tenant is still refused, and the seam still needs turning on", () => {
  inDevWorld(() => {
    assert.equal(requestedDevTenant(asReq(FOUNDER_TENANT_ID_DEFAULT)), null);
    assert.equal(requestedDevTenant(asReq(FOUNDER_TENANT_ID_DEFAULT.toUpperCase())), null);
    assert.equal(requestedDevTenant(asReq("not-a-guid")), null);
  });
  // DEV_AUTH off: nothing is a dev tenant, fixture included.
  const saved = process.env.DEV_AUTH;
  delete process.env.DEV_AUTH;
  try { assert.equal(requestedDevTenant(asReq(SPARK_ONLY_FIXTURE)), null); }
  finally { if (saved === undefined) delete process.env.DEV_AUTH; else process.env.DEV_AUTH = saved; }
});
