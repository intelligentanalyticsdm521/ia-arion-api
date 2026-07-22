// test/gbp-t5-verified.test.js
//
// T5 — is_verified ← Google's metadata.hasVoiceOfMerchant (GBP Connect,
// August batch). The signal was always on the wire (readMask includes
// `metadata`) and was discarded at the mapping layer, so
// arion.business_location.is_verified sat at its DEFAULT 0 for everyone —
// including genuinely verified listings (Briarwood / IA / MWAG, proven live
// 2026-07-16).
//
// CONTRACT UNDER TEST (fail-closed, per scope failure-mode F3):
//   * only an explicit hasVoiceOfMerchant === true maps to verified
//   * missing / undefined / null / falsy → UNVERIFIED, never an error
//   * sync UPDATE refreshes the bit on every pass, so a Google suspension
//     (hasVoiceOfMerchant flipping false) propagates without a reconnect
//     (scope edge-case E3)

import test from "node:test";
import assert from "node:assert/strict";

import { listAllGbpLocations } from "../lib/gbpApi.js";
import { syncAllLocations, mapToColumns, parseLocationName } from "../lib/integrations/gbpSync.js";

// ── 1. Wire-level extraction: metadata.hasVoiceOfMerchant → is_verified ─────

function googleFixtureFetch(locationsByAccount) {
  return async (url) => {
    const u = String(url);
    let body;
    if (u.includes("mybusinessaccountmanagement")) {
      body = { accounts: Object.keys(locationsByAccount).map((name) => ({ name, accountName: name })) };
    } else {
      const acct = Object.keys(locationsByAccount).find((name) => u.includes(name));
      body = { locations: locationsByAccount[acct] || [] };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    };
  };
}

test("listAllGbpLocations maps hasVoiceOfMerchant true → is_verified true", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = googleFixtureFetch({
    "accounts/111": [
      {
        name: "locations/aaa",
        title: "Briarwood Dental",
        metadata: { hasVoiceOfMerchant: true, placeId: "p1" },
      },
      {
        name: "locations/bbb",
        title: "Rolling In It",
        // metadata present but NO hasVoiceOfMerchant — the live RII shape
        metadata: { placeId: "p2" },
      },
      {
        name: "locations/ccc",
        title: "No Metadata At All",
        // no metadata key — degraded payload must not throw
      },
    ],
  });
  try {
    const out = await listAllGbpLocations("tok");
    const byTitle = Object.fromEntries(out.map((l) => [l.title, l]));
    assert.equal(byTitle["Briarwood Dental"].is_verified, true);
    assert.equal(byTitle["Rolling In It"].is_verified, false, "missing signal must read unverified (fail closed)");
    assert.equal(byTitle["No Metadata At All"].is_verified, false, "absent metadata must read unverified, not throw");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("listAllGbpLocations maps hasVoiceOfMerchant false (suspension) → is_verified false", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = googleFixtureFetch({
    "accounts/111": [
      { name: "locations/ddd", title: "Suspended Biz", metadata: { hasVoiceOfMerchant: false } },
    ],
  });
  try {
    const out = await listAllGbpLocations("tok");
    assert.equal(out[0].is_verified, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── 2. Column mapping: fail-closed at the sync layer too ────────────────────

const entry = (id, title, isVerified) => ({
  location_name: `accounts/111/locations/${id}`,
  title,
  address: "1 Main St, Springfield, IL 62701",
  website_uri: "https://example.com",
  primary_phone: null,
  category: null,
  match_score: 1.0,
  place_id: null,
  review_uri: null,
  ...(isVerified === undefined ? {} : { is_verified: isVerified }),
});

test("mapToColumns: is_verified true → 1, false → 0, MISSING → 0", () => {
  const parsed = parseLocationName("accounts/111/locations/x");
  assert.equal(mapToColumns(entry("x", "V", true), parsed).isVerified, 1);
  assert.equal(mapToColumns(entry("x", "U", false), parsed).isVerified, 0);
  assert.equal(mapToColumns(entry("x", "M", undefined), parsed).isVerified, 0, "pre-T5 fixture shape must fail closed");
});

// ── 3. Sync flow: INSERT carries the bit; UPDATE refreshes it (E3) ──────────

function makeBindCapturePool(initialRows = []) {
  const rows = new Map(initialRows.map((r) => [r.gbp_location_id, { ...r }]));
  const captured = { inserts: [], updates: [] };
  const pool = {
    rows,
    captured,
    request() {
      const inputs = {};
      const req = {
        input(name, _type, val) {
          inputs[name] = arguments.length >= 3 ? val : _type;
          return req;
        },
        async query(sqlText) {
          const s = String(sqlText);
          if (/SELECT location_id, gbp_location_id, is_primary/i.test(s)) {
            return { recordset: [...rows.values()] };
          }
          if (/FROM arion\.site/i.test(s)) {
            return { recordset: [] };
          }
          if (/SELECT TOP 1 1 AS hit[\s\S]*is_primary = 1/i.test(s)) {
            return { recordset: [...rows.values()].some((r) => r.is_primary) ? [{ hit: 1 }] : [] };
          }
          if (/INSERT INTO arion\.business_location/i.test(s)) {
            captured.inserts.push({ ...inputs });
            rows.set(inputs.gbpLocationId, {
              gbp_location_id: inputs.gbpLocationId,
              is_primary: inputs.isPrimary === 1,
              is_verified: inputs.isVerified,
            });
            return { recordset: [], rowsAffected: [1] };
          }
          if (/UPDATE arion\.business_location[\s\S]*SET gbp_account_id/i.test(s)) {
            captured.updates.push({ ...inputs });
            const r = rows.get(inputs.gbpLocationId);
            if (r) r.is_verified = inputs.isVerified;
            return { recordset: [], rowsAffected: [1] };
          }
          if (/UPDATE arion\.business_location[\s\S]*SET is_primary = 1/i.test(s)) {
            const r = rows.get(inputs.gbpLocationId);
            if (r && !r.is_primary) {
              r.is_primary = true;
              return { recordset: [{ location_name: r.location_name || null }], rowsAffected: [1] };
            }
            return { recordset: [], rowsAffected: [0] };
          }
          return { recordset: [], rowsAffected: [0] };
        },
      };
      return req;
    },
  };
  return pool;
}

const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("sync INSERT binds is_verified 1 for verified, 0 for unverified", async () => {
  const pool = makeBindCapturePool();
  const fixture = [entry("v1", "Verified Biz", true), entry("v2", "Unverified Biz", false)];
  await syncAllLocations(TENANT, null, {
    injectedClient: async () => fixture,
    injectedPool: pool,
    siteDomain: "example.com",
  });
  assert.equal(pool.captured.inserts.length, 2);
  const byId = Object.fromEntries(pool.captured.inserts.map((i) => [i.gbpLocationId, i]));
  assert.equal(byId.v1.isVerified, 1);
  assert.equal(byId.v2.isVerified, 0);
});

test("sync UPDATE refreshes is_verified — suspension flips 1 → 0 without reconnect (E3)", async () => {
  const pool = makeBindCapturePool([
    { gbp_location_id: "v1", is_primary: true, is_verified: 1 },
  ]);
  // Same listing, but Google now reports it unverified (suspended).
  const fixture = [entry("v1", "Formerly Verified Biz", false)];
  await syncAllLocations(TENANT, null, {
    injectedClient: async () => fixture,
    injectedPool: pool,
    siteDomain: "example.com",
  });
  assert.equal(pool.captured.updates.length, 1);
  assert.equal(pool.captured.updates[0].isVerified, 0);
  assert.equal(pool.rows.get("v1").is_verified, 0, "stored row must reflect the flip");
});
