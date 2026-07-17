// test/dev-auth-locks.test.js
//
// devAuth is a deliberate authentication BYPASS. `x-dev-tenant: <guid>` makes
// the API treat you as a member of that tenant with no token at all. That is
// exactly what local dev needs and exactly what must never be reachable in
// production, so the locks that keep it inert get a test.
//
// WHY THIS EXISTS — the lock that wasn't a lock:
//
//   return on && String(process.env.NODE_ENV || "").toLowerCase() !== "production";
//
// Read that with NODE_ENV unset: "" !== "production" is TRUE, so the NODE_ENV
// lock PASSES. It only refuses when NODE_ENV is affirmatively "production".
//
// Verified against live prod app settings on 2026-07-17:
//   app-oliver-api-prod     NODE_ENV=production   <- lock real
//   app-arion-api-prod      NODE_ENV=production   <- lock real
//   app-lumen-api-prod      NODE_ENV=production   <- lock real
//   api-platform-iadm-prod  NODE_ENV NOT SET      <- lock VACUOUS
//
// So on the platform-api hub — the /session/verify hub every other API calls —
// DEV_AUTH being unset was the only thing between an anonymous HTTP header and
// full tenant impersonation. One `az webapp config appsettings set DEV_AUTH=1`
// away, by anyone debugging prod at 2am.
//
// Lock 3 fixes the CLASS, not the instance: it checks for the PRESENCE of a
// prod marker (WEBSITE_SITE_NAME, injected by App Service into every site)
// instead of the ABSENCE of one. Absence is what fails open.

import test from "node:test";
import assert from "node:assert/strict";

import { devAuthActive } from "../lib/devAuth.js";

// devAuthActive reads process.env live, so each case just sets the world it wants.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of ["DEV_AUTH", "NODE_ENV", "WEBSITE_SITE_NAME"]) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The local-dev case must still work. A lock that breaks dev gets removed.
// ─────────────────────────────────────────────────────────────────────────────

test("a developer laptop: DEV_AUTH=1, no NODE_ENV, no App Service -> ACTIVE", () => {
  withEnv({ DEV_AUTH: "1", NODE_ENV: undefined, WEBSITE_SITE_NAME: undefined }, () => {
    assert.equal(devAuthActive(), true,
      "local dev is the entire point of this seam — if this fails the seam is useless");
  });
});

test("NODE_ENV=development is equally fine", () => {
  withEnv({ DEV_AUTH: "1", NODE_ENV: "development", WEBSITE_SITE_NAME: undefined }, () => {
    assert.equal(devAuthActive(), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lock 1 — DEV_AUTH. The only lock that was ever load-bearing on platform-api.
// ─────────────────────────────────────────────────────────────────────────────

test("lock 1: without DEV_AUTH it is inert, whatever else is set", () => {
  for (const v of [undefined, "", "0", "false", "yes", "TRUE-ish"]) {
    withEnv({ DEV_AUTH: v, NODE_ENV: undefined, WEBSITE_SITE_NAME: undefined }, () => {
      assert.equal(devAuthActive(), false, `DEV_AUTH=${JSON.stringify(v)} must not enable the bypass`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Lock 2 — NODE_ENV. Real where it is set.
// ─────────────────────────────────────────────────────────────────────────────

test("lock 2: NODE_ENV=production refuses even with DEV_AUTH=1", () => {
  withEnv({ DEV_AUTH: "1", NODE_ENV: "production", WEBSITE_SITE_NAME: undefined }, () => {
    assert.equal(devAuthActive(), false);
  });
});

test("lock 2: PRODUCTION / Production are the same word", () => {
  for (const v of ["PRODUCTION", "Production"]) {
    withEnv({ DEV_AUTH: "1", NODE_ENV: v, WEBSITE_SITE_NAME: undefined }, () => {
      assert.equal(devAuthActive(), false, `NODE_ENV=${v} must refuse`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Lock 3 — the one that actually closes api-platform-iadm-prod.
// ─────────────────────────────────────────────────────────────────────────────

test("lock 3: THE REAL SCENARIO — App Service, no NODE_ENV, DEV_AUTH switched on", () => {
  // This is api-platform-iadm-prod exactly as it is configured today, if anyone
  // ever set DEV_AUTH=1 on it. Before lock 3 this returned TRUE: locks 1 and 2
  // both passed, and x-dev-tenant became a tenant-impersonation header on the
  // hub that every other API trusts for /session/verify.
  withEnv({ DEV_AUTH: "1", NODE_ENV: undefined, WEBSITE_SITE_NAME: "api-platform-iadm-prod" }, () => {
    assert.equal(devAuthActive(), false,
      "running inside App Service must refuse regardless of NODE_ENV — this is the hole lock 3 closes");
  });
});

test("lock 3: presence is the signal, so any site name refuses", () => {
  for (const site of ["app-oliver-api-prod", "app-arion-api-prod", "some-future-app"]) {
    withEnv({ DEV_AUTH: "1", NODE_ENV: "development", WEBSITE_SITE_NAME: site }, () => {
      assert.equal(devAuthActive(), false,
        `${site}: NODE_ENV=development inside App Service is a mistake, not permission`);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The locks are independent — a test where every case passes for the same
// reason proves only that one lock works.
// ─────────────────────────────────────────────────────────────────────────────

test("each lock refuses on its own, with the other two satisfied", () => {
  const ACTIVE = { DEV_AUTH: "1", NODE_ENV: "development", WEBSITE_SITE_NAME: undefined };
  withEnv(ACTIVE, () => assert.equal(devAuthActive(), true, "baseline must be active or the cases below prove nothing"));

  withEnv({ ...ACTIVE, DEV_AUTH: undefined }, () =>
    assert.equal(devAuthActive(), false, "lock 1 alone must be sufficient to refuse"));
  withEnv({ ...ACTIVE, NODE_ENV: "production" }, () =>
    assert.equal(devAuthActive(), false, "lock 2 alone must be sufficient to refuse"));
  withEnv({ ...ACTIVE, WEBSITE_SITE_NAME: "app-anything-prod" }, () =>
    assert.equal(devAuthActive(), false, "lock 3 alone must be sufficient to refuse"));
});
