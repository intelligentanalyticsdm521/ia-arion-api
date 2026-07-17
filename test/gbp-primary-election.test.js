// test/gbp-primary-election.test.js
//
// Regression tests for the GBP cross-tenant bleed and the silent wipe.
//
// WHAT HAPPENED
// -------------
// arion.business_location held 12 rows: 4 tenants x the same 3 businesses,
// 9 of 12 foreign. Rolling In It's portal listed BRIARWOOD DENTAL as its primary
// business, and returned Briarwood's and Midwest Ag Services' name/address/phone
// to RII's portal users. Every field is public Google data, so it is not a PII
// breach — the damage is commercial: it leaked IA's client roster to IA's other
// clients.
//
// The cause was NOT a shared token (four distinct OAuth grants, one Google
// identity that legitimately manages all three listings). It was gbpSync.js:134:
//
//     const shouldBePrimary = !hadPrimary && added === 0;   // first in array wins
//
// For RII nothing matches rollinginitllc.com, so every match_score is 0, the
// sort in gbpApi.js collapses to alphabetical, and "Briarwood Dental" sorts
// first. The other three tenants were correct only BY LUCK.
//
// Forty lines away, routes/oauth.js:245-248 makes the CORRECT call on the SAME
// data in the SAME request — it refuses to guess. Two code paths, identical
// input, opposite conclusions.
//
// And it is a REGRESSION: c874bc7 (2026-05-08) "SECURITY FIX: GBP location
// picker — block silent auto-pick of wrong listings" removed this exact
// anti-pattern. c296d6b (2026-06-20) reintroduced it in a new file 43 days
// later. The May fix was scoped to a FUNCTION; the invariant needed a test.
//
// WHY THE OLD SUITE STAYED GREEN
// ------------------------------
// scripts/_verify_gbp_multi_location_sync.js:203-205 asserted
//     assert.equal(primaryRows.length, 1)
// — COUNT, not IDENTITY. Electing the wrong business passes that assertion
// perfectly. It also never tested the empty-remote case. "Assert presence, not
// just absence", exactly.
//
// These tests assert WHICH business is elected, and that a degraded Google
// response cannot delete anything.

import test from "node:test";
import assert from "node:assert/strict";

// ── Minimal in-memory pool standing in for arion.business_location ───────────
function makeMockPool(initialRows = []) {
  const rows = new Map(initialRows.map((r) => [r.gbp_location_id, { ...r }]));
  const pool = {
    rows,
    request() {
      const inputs = {};
      const req = {
        input(name, _type, val) {
          // support both (name, type, value) and (name, value)
          inputs[name] = arguments.length >= 3 ? val : _type;
          return req;
        },
        async query(sqlText) {
          const s = String(sqlText);
          if (/SELECT location_id, gbp_location_id, is_primary/i.test(s)) {
            return { recordset: [...rows.values()] };
          }
          if (/^\s*DELETE FROM arion\.business_location/im.test(s)) {
            rows.delete(inputs.gbpLocationId);
            return { recordset: [], rowsAffected: [1] };
          }
          if (/INSERT INTO arion\.business_location/i.test(s)) {
            rows.set(inputs.gbpLocationId, {
              gbp_location_id: inputs.gbpLocationId,
              location_name: inputs.locationName,
              display_name: inputs.displayName,
              is_primary: inputs.isPrimary === 1,
            });
            return { recordset: [], rowsAffected: [1] };
          }
          if (/UPDATE arion\.business_location[\s\S]*SET is_primary = 1/i.test(s)) {
            const r = rows.get(inputs.gbpLocationId);
            if (r && !r.is_primary) {
              r.is_primary = true;
              return { recordset: [{ location_name: r.location_name }], rowsAffected: [1] };
            }
            return { recordset: [], rowsAffected: [0] };
          }
          if (/UPDATE arion\.business_location/i.test(s)) {
            const r = rows.get(inputs.gbpLocationId);
            if (r) Object.assign(r, { location_name: inputs.locationName ?? r.location_name });
            return { recordset: [], rowsAffected: [1] };
          }
          return { recordset: [], rowsAffected: [0] };
        },
      };
      return req;
    },
  };
  return pool;
}

const loc = (id, title, websiteUri, matchScore) => ({
  location_name: `accounts/103357467018828514362/locations/${id}`,
  gbp_account_id: "103357467018828514362",
  title,
  address: "somewhere",
  website_uri: websiteUri,
  primary_phone: null,
  category: null,
  match_score: matchScore,
  place_id: null,
  review_uri: null,
});

/** The three businesses the one Google identity manages, sorted as gbpApi sorts. */
function riiRemote() {
  // Nothing matches rollinginitllc.com -> every score 0 -> alphabetical.
  const list = [
    loc("12493166159484644955", "Briarwood Dental", "https://briarwoodsmiles.com", 0),
    loc("22222222222222222222", "Intelligent Analytics", "https://ia-dm.com", 0),
    loc("33333333333333333333", "Midwest Ag Services", "https://midwestag.example", 0),
  ];
  list.sort((a, b) => (b.match_score - a.match_score) || a.title.localeCompare(b.title));
  return list;
}

async function loadSync() {
  return await import("../lib/integrations/gbpSync.js");
}

// ─────────────────────────────────────────────────────────────────────────────
// THE BLEED
// ─────────────────────────────────────────────────────────────────────────────

test("RII case: 3 listings, ZERO domain match -> NO primary elected (was: Briarwood Dental)", async () => {
  const { syncAllLocations } = await loadSync();
  const pool = makeMockPool([]);
  const remote = riiRemote();

  // Sanity: this is genuinely the shape that produced the bug.
  assert.equal(remote[0].title, "Briarwood Dental", "fixture must reproduce the alphabetical collapse");

  await syncAllLocations("12839687-0000-0000-0000-000000000000", "tok", {
    siteDomain: "rollinginitllc.com",
    injectedClient: async () => remote,
    injectedPool: pool,
  });

  const primaries = [...pool.rows.values()].filter((r) => r.is_primary);

  // IDENTITY, not count. `primaries.length === 1` passed happily while the
  // elected row was another company's dental practice.
  assert.equal(
    primaries.length, 0,
    `expected NO primary when nothing matches the tenant's domain, but elected: ${primaries.map((p) => p.display_name || p.location_name).join(", ")}`
  );
  assert.ok(
    !primaries.some((p) => /Briarwood/i.test(String(p.display_name || p.location_name))),
    "🔴 THE BLEED: elected another tenant's business as primary"
  );
});

test("legitimate multi-location business still gets a primary (no over-correction)", async () => {
  const { syncAllLocations } = await loadSync();
  const pool = makeMockPool([]);
  // Four branches, all on the tenant's own domain — every one is legitimately theirs.
  const remote = [
    loc("L_EAST", "Acme Plumbing — East", "https://acmeplumbing.example.com", 1.0),
    loc("L_NORTH", "Acme Plumbing — North", "https://acmeplumbing.example.com", 1.0),
    loc("L_SOUTH", "Acme Plumbing — South", "https://acmeplumbing.example.com", 1.0),
  ];

  await syncAllLocations("aaaa1111-0000-0000-0000-000000000000", "tok", {
    siteDomain: "acmeplumbing.example.com",
    injectedClient: async () => remote,
    injectedPool: pool,
  });

  const primaries = [...pool.rows.values()].filter((r) => r.is_primary);
  assert.equal(primaries.length, 1, "a genuine multi-location business must still get a default primary");
  assert.ok(/Acme Plumbing/.test(String(primaries[0].display_name)), `elected primary must be the tenant's own business, got: ${primaries[0].display_name}`);
});

test("single listing is elected", async () => {
  const { syncAllLocations } = await loadSync();
  const pool = makeMockPool([]);
  await syncAllLocations("bbbb2222-0000-0000-0000-000000000000", "tok", {
    siteDomain: "solo.example.com",
    injectedClient: async () => [loc("L_ONLY", "Solo Biz", "https://unrelated.example", 0)],
    injectedPool: pool,
  });
  const primaries = [...pool.rows.values()].filter((r) => r.is_primary);
  assert.equal(primaries.length, 1, "a single listing is unambiguously the tenant's");
});

test("exactly one domain match among many is elected — and it is the MATCHING one", async () => {
  const { syncAllLocations } = await loadSync();
  const pool = makeMockPool([]);
  const remote = [
    loc("L_MINE", "My Shop", "https://myshop.example.com", 1.0),
    loc("L_OTHER1", "Aardvark Co", "https://aardvark.example", 0),
    loc("L_OTHER2", "Zebra Co", "https://zebra.example", 0),
  ];
  remote.sort((a, b) => (b.match_score - a.match_score) || a.title.localeCompare(b.title));

  await syncAllLocations("cccc3333-0000-0000-0000-000000000000", "tok", {
    siteDomain: "myshop.example.com",
    injectedClient: async () => remote,
    injectedPool: pool,
  });

  const primaries = [...pool.rows.values()].filter((r) => r.is_primary);
  assert.equal(primaries.length, 1);
  assert.ok(/My Shop/.test(String(primaries[0].display_name)), `elected the wrong business: ${primaries[0].display_name}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SILENT WIPE
// ─────────────────────────────────────────────────────────────────────────────

function seeded() {
  return makeMockPool([
    { gbp_location_id: "L_A", location_name: "accounts/1/locations/L_A", is_primary: true },
    { gbp_location_id: "L_B", location_name: "accounts/1/locations/L_B", is_primary: false },
    { gbp_location_id: "L_C", location_name: "accounts/1/locations/L_C", is_primary: false },
  ]);
}

test("a DEGRADED Google response must not delete anything", async () => {
  const { syncAllLocations } = await loadSync();
  const pool = seeded();

  // Partial result: gbpApi marks complete=false when an account failed.
  const partial = [];
  Object.defineProperty(partial, "complete", { value: false, enumerable: false });
  Object.defineProperty(partial, "partialErrors", { value: ["account accounts/111: 503 backend error"], enumerable: false });

  const res = await syncAllLocations("dddd4444-0000-0000-0000-000000000000", "tok", {
    siteDomain: "x.example.com",
    injectedClient: async () => partial,
    injectedPool: pool,
  });

  assert.equal(pool.rows.size, 3, "🔴 a degraded Google response WIPED the tenant's locations");
  assert.equal(res.removed, 0, `reported ${res.removed} removed — it must remove nothing on a partial result`);
});

test("an authoritative-but-empty response must not delete the whole set either", async () => {
  const { syncAllLocations } = await loadSync();
  const pool = seeded();

  const empty = [];
  Object.defineProperty(empty, "complete", { value: true, enumerable: false });
  Object.defineProperty(empty, "partialErrors", { value: [], enumerable: false });

  const res = await syncAllLocations("eeee5555-0000-0000-0000-000000000000", "tok", {
    siteDomain: "x.example.com",
    injectedClient: async () => empty,
    injectedPool: pool,
  });

  // Deleting 3 rows because Google had a bad second, then reporting
  // "Sync complete — 3 removed", is unrecoverable. Keeping a stale row is not.
  assert.equal(pool.rows.size, 3, "🔴 an empty response deleted the tenant's entire set");
  assert.equal(res.removed, 0);
});

test("a genuine single removal still reconciles", async () => {
  const { syncAllLocations } = await loadSync();
  const pool = seeded();

  // Google authoritatively returns A and B — C really is gone.
  const remote = [
    loc("L_A", "A Biz", "https://x.example.com", 1.0),
    loc("L_B", "B Biz", "https://x.example.com", 1.0),
  ];
  Object.defineProperty(remote, "complete", { value: true, enumerable: false });

  const res = await syncAllLocations("ffff6666-0000-0000-0000-000000000000", "tok", {
    siteDomain: "x.example.com",
    injectedClient: async () => remote,
    injectedPool: pool,
  });

  assert.equal(res.removed, 1, "a real removal must still be reconciled");
  assert.ok(!pool.rows.has("L_C"), "the genuinely-removed listing should be gone");
  assert.equal(pool.rows.size, 2);
});
