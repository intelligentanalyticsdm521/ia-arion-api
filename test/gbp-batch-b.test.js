// test/gbp-batch-b.test.js
//
// GBP Connect Batch B (2026-07-22) — CLIENT-owned listing creation + the
// in-ARION verification flow.
//
// CONTRACTS UNDER TEST (wire level, fetch stubbed — same pattern as
// test/gbp-t5-verified.test.js):
//   * listGbpAccounts maps name/accountName/type/verificationState
//   * createGbpLocation POSTs to {accountName}/locations with
//     validateOnly=false + a requestId (idempotency), body passed through
//   * googleFetch's shared error mapping (gbp_quota_exceeded /
//     gbp_api_disabled) reaches the new helpers — one place knows the shape
//   * gbpVerifications normalizes "accounts/{a}/locations/{l}" → the
//     "locations/{l}" form the Verifications API requires, on EVERY call
//   * requestVerification builds VerifyLocationRequest from the option
//     object (method + languageCode + method-specific contact field)
//   * completeVerification hits {verificationName}:complete with { pin }
//     and does NOT mangle the 4-part verification resource name
//
// Ownership note: nothing here touches lib/iaMasterGoogle.js — the create
// path runs on the CLIENT'S token so the client is PRIMARY_OWNER (the IA
// master-account autoProvision model is superseded).

import test from "node:test";
import assert from "node:assert/strict";

import { listGbpAccounts, createGbpLocation } from "../lib/gbpApi.js";
import {
  normalizeLocationName,
  fetchVerificationOptions,
  requestVerification,
  completeVerification,
  listVerifications,
  getVoiceOfMerchantState,
} from "../lib/gbpVerifications.js";

// ── fetch stub: capture every call, serve a canned body ─────────────────────

function captureFetch(responseBody = {}, { ok = true, status = 200, rawText = null } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({
      url: String(url),
      method: init.method || "GET",
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    return {
      ok,
      status,
      text: async () => (rawText !== null ? rawText : JSON.stringify(responseBody)),
    };
  };
  fn.calls = calls;
  return fn;
}

async function withFetch(stub, run) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── 1. listGbpAccounts ───────────────────────────────────────────────────────

test("listGbpAccounts maps name/accountName/type/verificationState", async () => {
  const stub = captureFetch({
    accounts: [
      { name: "accounts/111", accountName: "Jane Client", type: "PERSONAL", verificationState: "VERIFIED" },
      { name: "accounts/222", accountName: "Acme Org", type: "ORGANIZATION" },
    ],
  });
  const out = await withFetch(stub, () => listGbpAccounts("tok"));
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].method, "GET");
  assert.equal(stub.calls[0].url, "https://mybusinessaccountmanagement.googleapis.com/v1/accounts");
  assert.deepEqual(out, [
    { name: "accounts/111", accountName: "Jane Client", type: "PERSONAL", verificationState: "VERIFIED" },
    { name: "accounts/222", accountName: "Acme Org", type: "ORGANIZATION", verificationState: null },
  ]);
});

test("listGbpAccounts tolerates an empty response", async () => {
  const out = await withFetch(captureFetch({}), () => listGbpAccounts("tok"));
  assert.deepEqual(out, []);
});

// ── 2. createGbpLocation ─────────────────────────────────────────────────────

test("createGbpLocation POSTs body to {accountName}/locations with validateOnly=false + requestId", async () => {
  const stub = captureFetch({ name: "locations/999", title: "New Biz" });
  const body = {
    title: "New Biz",
    categories: { primaryCategory: { name: "categories/gcid:plumber" } },
    phoneNumbers: { primaryPhone: "+1 555 0100" },
  };
  const created = await withFetch(stub, () => createGbpLocation("tok", "accounts/111", body, "fixed-request-id"));
  assert.equal(created.name, "locations/999");
  assert.equal(stub.calls.length, 1);
  const call = stub.calls[0];
  assert.equal(call.method, "POST");
  const u = new URL(call.url);
  assert.equal(u.origin + u.pathname, "https://mybusinessbusinessinformation.googleapis.com/v1/accounts/111/locations");
  assert.equal(u.searchParams.get("validateOnly"), "false");
  assert.equal(u.searchParams.get("requestId"), "fixed-request-id", "explicit requestId must be forwarded for idempotency");
  assert.deepEqual(call.body, body);
});

test("createGbpLocation generates a requestId when none is given", async () => {
  const stub = captureFetch({ name: "locations/1" });
  await withFetch(stub, () => createGbpLocation("tok", "accounts/111", { title: "X" }));
  const u = new URL(stub.calls[0].url);
  const rid = u.searchParams.get("requestId");
  assert.ok(rid && rid.length >= 32, `expected a generated requestId, got "${rid}"`);
});

// ── 3. shared error mapping reaches the new helpers ─────────────────────────

test("createGbpLocation surfaces gbp_quota_exceeded from a 429 quota response", async () => {
  const stub = captureFetch({}, { ok: false, status: 429, rawText: '{"error":{"status":"RESOURCE_EXHAUSTED","message":"Quota exceeded, quota_limit_value: 0"}}' });
  await assert.rejects(
    withFetch(stub, () => createGbpLocation("tok", "accounts/111", { title: "X" })),
    (err) => err.code === "gbp_quota_exceeded",
  );
});

test("fetchVerificationOptions surfaces gbp_api_disabled from a 403 SERVICE_DISABLED response", async () => {
  const stub = captureFetch({}, { ok: false, status: 403, rawText: '{"error":{"status":"PERMISSION_DENIED","message":"My Business Verifications API has not been used in project x or it is disabled (SERVICE_DISABLED)"}}' });
  await assert.rejects(
    withFetch(stub, () => fetchVerificationOptions("tok", "accounts/1/locations/2")),
    (err) => err.code === "gbp_api_disabled",
  );
});

// ── 4. location-name normalization (the Verifications API quirk) ────────────

test("normalizeLocationName strips the account half, tolerates all three shapes", () => {
  assert.equal(normalizeLocationName("accounts/123/locations/456"), "locations/456");
  assert.equal(normalizeLocationName("locations/456"), "locations/456");
  assert.equal(normalizeLocationName("456"), "locations/456");
  assert.equal(normalizeLocationName(null), null);
});

test("fetchVerificationOptions posts languageCode to the NORMALIZED location path", async () => {
  const stub = captureFetch({ options: [{ verificationMethod: "PHONE_CALL", phoneNumber: "+1 555 0100" }] });
  const out = await withFetch(stub, () => fetchVerificationOptions("tok", "accounts/123/locations/456"));
  assert.equal(out.options.length, 1);
  const call = stub.calls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://mybusinessverifications.googleapis.com/v1/locations/456:fetchVerificationOptions");
  assert.deepEqual(call.body, { languageCode: "en-US" });
});

// ── 5. requestVerification body shapes ───────────────────────────────────────

test("requestVerification builds {method, languageCode, phoneNumber} from a phone option", async () => {
  const stub = captureFetch({ verification: { name: "locations/456/verifications/789", method: "PHONE_CALL", state: "PENDING" } });
  const option = { verificationMethod: "PHONE_CALL", phoneNumber: "+1 555 0100" };
  const out = await withFetch(stub, () => requestVerification("tok", "accounts/123/locations/456", option));
  assert.equal(out.verification.state, "PENDING");
  const call = stub.calls[0];
  assert.equal(call.url, "https://mybusinessverifications.googleapis.com/v1/locations/456:verify");
  assert.deepEqual(call.body, { method: "PHONE_CALL", languageCode: "en-US", phoneNumber: "+1 555 0100" });
});

test("requestVerification derives emailAddress from emailData, accepts bare method strings", async () => {
  const stub = captureFetch({ verification: { name: "locations/456/verifications/1", method: "EMAIL", state: "PENDING" } });
  await withFetch(stub, () => requestVerification("tok", "locations/456", { verificationMethod: "EMAIL", emailData: { user: "info", domain: "example.com" } }));
  assert.deepEqual(stub.calls[0].body, { method: "EMAIL", languageCode: "en-US", emailAddress: "info@example.com" });

  const stub2 = captureFetch({ verification: { method: "AUTO", state: "COMPLETED" } });
  await withFetch(stub2, () => requestVerification("tok", "locations/456", "AUTO"));
  assert.deepEqual(stub2.calls[0].body, { method: "AUTO", languageCode: "en-US" });
});

test("requestVerification refuses an option with no method (fail closed, no Google call)", async () => {
  const stub = captureFetch({});
  await assert.rejects(
    withFetch(stub, () => requestVerification("tok", "locations/456", {})),
    (err) => err.code === "gbp_invalid_verification_option",
  );
  assert.equal(stub.calls.length, 0, "must not hit Google with a malformed request");
});

// ── 6. completeVerification — PIN body, untouched resource name ─────────────

test("completeVerification posts {pin} to {verificationName}:complete without normalizing", async () => {
  const stub = captureFetch({ verification: { name: "locations/456/verifications/789", state: "COMPLETED" } });
  const out = await withFetch(stub, () => completeVerification("tok", "locations/456/verifications/789", "123456"));
  assert.equal(out.verification.state, "COMPLETED");
  const call = stub.calls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.url, "https://mybusinessverifications.googleapis.com/v1/locations/456/verifications/789:complete");
  assert.deepEqual(call.body, { pin: "123456" });
});

test("completeVerification requires both verificationName and pin", async () => {
  const stub = captureFetch({});
  await assert.rejects(
    withFetch(stub, () => completeVerification("tok", "", "123456")),
    (err) => err.code === "gbp_invalid_verification_complete",
  );
  await assert.rejects(
    withFetch(stub, () => completeVerification("tok", "locations/1/verifications/2", "")),
    (err) => err.code === "gbp_invalid_verification_complete",
  );
  assert.equal(stub.calls.length, 0);
});

// ── 7. listVerifications + VoiceOfMerchantState reads ────────────────────────

test("listVerifications GETs the normalized verifications collection", async () => {
  const stub = captureFetch({ verifications: [{ name: "locations/456/verifications/789", state: "PENDING" }] });
  const out = await withFetch(stub, () => listVerifications("tok", "accounts/123/locations/456"));
  assert.equal(out.verifications.length, 1);
  assert.equal(stub.calls[0].method, "GET");
  assert.equal(stub.calls[0].url, "https://mybusinessverifications.googleapis.com/v1/locations/456/verifications");
});

test("getVoiceOfMerchantState GETs locations/{l}/VoiceOfMerchantState", async () => {
  const stub = captureFetch({ hasVoiceOfMerchant: true, hasBusinessAuthority: true });
  const out = await withFetch(stub, () => getVoiceOfMerchantState("tok", "accounts/123/locations/456"));
  assert.equal(out.hasVoiceOfMerchant, true);
  assert.equal(stub.calls[0].method, "GET");
  assert.equal(stub.calls[0].url, "https://mybusinessverifications.googleapis.com/v1/locations/456/VoiceOfMerchantState");
});
