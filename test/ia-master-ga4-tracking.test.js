// autoProvisionGoogle() — a GA4 property with no measurement id is not
// "analytics is set up" (2026-10-08).
//
// THE DEFECT. The data-stream step sat in its own try/catch, and the line
//
//     result.ga4.ok = true;
//
// ran AFTER it, inside the outer try. So when the data stream could not be
// created - or was created but returned no measurement id - the failure was
// swallowed to a console.warn and the provisioner still reported
// `ga4: { ok: true, measurement_id: null }`. The measurement id is what the IA
// WordPress plugin injects gtag with (F-Onb-D1), so the client got a GA4
// property that would never record a page view, while onboarding said
// analytics was done and the ownership-transfer step
// (routes/onboarding/google-oauth.js:296, which gates on `provision.ga4.ok`)
// went ahead on it. The only record was a log line nobody reads.
// (reference_catch_swallow_report_success)
//
// THE RULE. `ok` keeps its documented meaning - the PROPERTY exists, which is
// what the transfer needs - and `tracking_ready` is the honest half, with
// `tracking_error` carrying the reason. GSC and GBP already set their `ok`
// inside their own try, after the call that earns it; only GA4 had this shape.
//
// Driven, not inspected: a stubbed global fetch answers the token exchange and
// each Google Admin endpoint, with a generated RSA key so the real RS256 JWT
// path runs.
//
// MUTATION-TESTED (each broken on purpose, the catching assertion named):
//   · tracking_ready hard-coded true   -> "a data stream that fails is not tracking"
//   · tracking_error never set         -> "the reason is carried, not only logged"
//   · ok moved inside the inner try    -> "the property still counts as created"
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

process.env.GOOGLE_MASTER_SERVICE_ACCOUNT_JSON = JSON.stringify({
  client_email: "ia-master@example.iam.gserviceaccount.com",
  private_key: privateKey,
  private_key_id: "kid-1",
});

const { autoProvisionGoogle } = await import("../lib/iaMasterGoogle.js");

const realFetch = global.fetch;

/**
 * @param {object} stream what POST .../dataStreams does:
 *   { measurementId }  created, and the id comes back
 *   { bare: true }     created, no webStreamData (forces the list call)
 *   { fail: true }     the create itself throws
 * @param {object} list  what GET .../dataStreams does when it is reached
 */
function stubGoogle({ stream = {}, list = null } = {}) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || "GET";
    calls.push(`${method} ${u}`);
    // masterFetch reads .text(); mintAccessToken reads .json().
    const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body });
    const bad = (status, body) => ({ ok: false, status, text: async () => body, json: async () => ({}) });

    // TOKEN_URL is a module constant (Google's real endpoint), not the
    // service account's token_uri.
    if (u.startsWith("https://oauth2.googleapis.com/token")) return ok({ access_token: "tok", expires_in: 3600 });
    if (u.endsWith("/v1beta/accounts")) return ok({ accounts: [{ name: "accounts/1" }] });
    if (u.endsWith("/v1beta/properties") && method === "POST") return ok({ name: "properties/9" });
    if (u.endsWith("/dataStreams") && method === "POST") {
      if (stream.fail) return bad(403, "caller does not have permission");
      if (stream.bare) return ok({ name: "properties/9/dataStreams/1" });
      return ok({ name: "properties/9/dataStreams/1", webStreamData: { measurementId: stream.measurementId } });
    }
    if (u.endsWith("/dataStreams") && method === "GET") {
      if (!list) return bad(500, "list unavailable");
      return ok(list);
    }
    // GSC and GBP are not what this file is about: let them fail cleanly.
    if (u.includes("webmasters")) return ok({});
    if (u.includes("mybusinessaccountmanagement")) return ok({ accounts: [] });
    return bad(404, "unexpected call: " + u);
  };
  return calls;
}

test.after(() => { global.fetch = realFetch; });

const provision = () => autoProvisionGoogle({ domain: "example.com", businessName: "Example Co" });

test("the happy path: the property exists AND tracking is ready", async () => {
  stubGoogle({ stream: { measurementId: "G-ABC123" } });
  const r = await provision();
  assert.equal(r.ga4.ok, true);
  assert.equal(r.ga4.property_id, "9");
  assert.equal(r.ga4.measurement_id, "G-ABC123");
  assert.equal(r.ga4.tracking_ready, true);
  assert.equal(r.ga4.tracking_error, undefined, "nothing to report");
});

test("a data stream that fails is not tracking, and the property still counts as created", async () => {
  stubGoogle({ stream: { fail: true } });
  const r = await provision();
  // The property exists, which is what the ownership transfer needs.
  assert.equal(r.ga4.ok, true, "the property still counts as created");
  assert.equal(r.ga4.property_id, "9");
  // But nothing will ever be recorded, and that is now said.
  assert.equal(r.ga4.measurement_id, null);
  assert.equal(r.ga4.tracking_ready, false, "a property with no measurement id records nothing");
  assert.match(r.ga4.tracking_error, /data stream not created/);
  assert.match(r.ga4.tracking_error, /403/, "the reason is carried, not only logged");
});

test("created but the measurement id could not be read: still not tracking", async () => {
  stubGoogle({ stream: { bare: true }, list: null });   // the list call fails
  const r = await provision();
  assert.equal(r.ga4.ok, true);
  assert.equal(r.ga4.measurement_id, null);
  assert.equal(r.ga4.tracking_ready, false);
  assert.match(r.ga4.tracking_error, /measurement id could not be read/);
});

test("created, the list answers, and the id is found there", async () => {
  stubGoogle({
    stream: { bare: true },
    list: { dataStreams: [{ type: "WEB_DATA_STREAM", webStreamData: { measurementId: "G-FROMLIST" } }] },
  });
  const r = await provision();
  assert.equal(r.ga4.measurement_id, "G-FROMLIST");
  assert.equal(r.ga4.tracking_ready, true);
  assert.equal(r.ga4.tracking_error, undefined);
});

test("the list answers with no web stream at all: not tracking, and it says why", async () => {
  stubGoogle({ stream: { bare: true }, list: { dataStreams: [{ type: "IOS_APP_DATA_STREAM" }] } });
  const r = await provision();
  assert.equal(r.ga4.tracking_ready, false);
  assert.match(r.ga4.tracking_error, /no measurement id/);
});

test("GSC and GBP still earn their own ok inside their own try", async () => {
  stubGoogle({ stream: { measurementId: "G-ABC123" } });
  const r = await provision();
  assert.equal(r.gsc.ok, true, "the PUT succeeded");
  assert.equal(r.gbp.ok, false, "no writable GBP account, so it is not ok");
  assert.match(r.gbp.error, /No GBP account/);
});
