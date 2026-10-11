// arion-api's thin entitlement client and SEAM-3-B.
//
// arion was an EIGHTH source for "does this business have X?" that the seams
// audit's §3 table does not list: middleware/requireArionTier.js resolved the
// tier from arion.site.arion_tier / arion.tenant.plan and nothing else, so a
// business that bought ARION Pro in Stripe but whose site row still said
// "standard" was Pro in the Portal, Pro in LUMEN and Standard here.
//
// No .env, no pool. resolveArionTier genuinely reaches db/servicesPool.js for
// the site row, so a developer with a .env and the dev container up had this
// file opening a REAL connection to read a fixture tenant that is not in that
// database — the gate's own catch already answers with the purchased tier when
// the row is unreadable, so the assertions are identical either way. Blanking it
// stopped being optional on 2026-09-17: the production keep-alive holds a pooled
// connection for TEN MINUTES (min 2 / SQL_POOL_IDLE_MS 600000, db/poolRecovery.js)
// instead of the 30 seconds it used to, so one accidental connection stops this
// process exiting at all.
//
// The three app modules are therefore imported DYNAMICALLY, below the
// assignments: a static `import` is hoisted above every statement in this file,
// so db/servicesPool.js would read the real env at load and the blanking would
// arrive too late to mean anything.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.SQL_SERVER = "";
process.env.SERVICES_SQL_SERVER = "";
process.env.PLATFORM_SQL_SERVER = "";

const {
  getEntitlements, clearEntitlementCache, productOf, addonOf, mayUseFeature, maySpend,
} = await import("../lib/entitlements.js");
const { RANK, rankOf, tierMeets } = await import("../lib/entitlementsRule.js");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CASES = JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "entitlement-rule-cases.json"), "utf8"));

/* ── SEAM-3-B, from the shared fixture ────────────────────────────────────── */

test("every SEAM-3-B case in the shared fixture answers the same here as everywhere else", () => {
  for (const c of CASES.cases) {
    assert.equal(mayUseFeature(c.entry, c.min_tier), c.feature, `FEATURE — ${c.why}`);
    assert.equal(maySpend(c.entry, c.min_tier), c.spend, `SPEND — ${c.why}`);
  }
  const undecided = CASES.cases.filter((c) => c.entry && c.entry.decided === false);
  assert.ok(undecided.length >= 4);
  assert.ok(undecided.every((c) => c.feature === true));
  assert.ok(undecided.every((c) => c.spend === false));
});

test("the platform ladder and arion's own tier words are in the same order", () => {
  assert.deepEqual({ ...RANK }, CASES.rank);
  const order = ["lite", "standard", "pro", "business", "enterprise"];
  for (let i = 1; i < order.length; i++) {
    assert.ok(rankOf(order[i]) > rankOf(order[i - 1]), `${order[i]} > ${order[i - 1]}`);
  }
  assert.ok(tierMeets("business", "pro"));
  assert.ok(!tierMeets("standard", "pro"));
});

/* ── the client ───────────────────────────────────────────────────────────── */

const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const ENV = { PLATFORM_API_URL: "http://platform.test", PLATFORM_INTERNAL_TOKEN: "shh" };

function fetchReturning(payload, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
  impl.calls = calls;
  return impl;
}

test("one GET with the shared secret; a decided answer is cached, an undecided one is not", async () => {
  clearEntitlementCache();
  const good = fetchReturning({ decided: true, products: { arion: { tier: "pro", decided: true } } });
  await getEntitlements(TENANT, { env: ENV, fetchImpl: good });
  await getEntitlements(TENANT, { env: ENV, fetchImpl: good });
  assert.equal(good.calls.length, 1);
  assert.match(good.calls[0].url, /\/internal\/entitlements\//);
  assert.equal(good.calls[0].opts.headers["x-internal-token"], "shh");

  clearEntitlementCache();
  const bad = fetchReturning({ decided: false, products: {} });
  await getEntitlements(TENANT, { env: ENV, fetchImpl: bad });
  await getEntitlements(TENANT, { env: ENV, fetchImpl: bad });
  assert.equal(bad.calls.length, 2);
  clearEntitlementCache();
});

test("an unconfigured or unreachable service yields null — features open, spending shut", async () => {
  clearEntitlementCache();
  assert.equal(await getEntitlements(TENANT, { env: {}, fetchImpl: fetchReturning({}) }), null);
  assert.equal(await getEntitlements(TENANT, {
    env: ENV, fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  }), null);
  assert.equal(mayUseFeature(productOf(null, "arion"), "pro"), true);
  assert.equal(maySpend(addonOf(null, "responder")), false);
  clearEntitlementCache();
});

/* ── the ARION feature gate ───────────────────────────────────────────────
 * middleware/requireArionTier.js (and its site-row fallback, higherTier,
 * resolveArionTier) was deleted on 11 Oct 2026: a route names a catalog
 * feature key and platform-api's payload.features[key] answers it, tier and
 * all. Those cases now live in test/require-feature.test.mjs and
 * test/arion-route-features.test.mjs. */

test("the client is thin — no Stripe, no tier SQL of its own", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib", "entitlements.js"), "utf8")
    .split("\n").filter((l) => { const x = l.trim(); return !(x.startsWith("//") || x.startsWith("*") || x.startsWith("/*")); })
    .join("\n");
  assert.doesNotMatch(src, /from "stripe"|require\("stripe"\)/);
  assert.doesNotMatch(src, /arion_tier|core\.tenant_services/);
  assert.match(src, /\/internal\/entitlements\//);
  assert.match(src, /PLATFORM_API_URL/);
  assert.match(src, /PLATFORM_INTERNAL_TOKEN/);
});

test("migration 041: a paid ARION grant is billing_source 'stripe'; the founder's onboard-existing is 'manual'", () => {
  const core = fs.readFileSync(path.join(ROOT, "lib", "coreTenants.js"), "utf8");
  assert.match(core, /INSERT INTO core\.tenant_services \(tenant_id, service_id, is_enabled, billing_source\) VALUES \(@tid, @sid, 1, 'stripe'\)/);
  const onb = fs.readFileSync(path.join(ROOT, "routes", "admin", "onboardExisting.js"), "utf8");
  assert.match(onb, /INSERT INTO core\.tenant_services \(tenant_id, service_id, is_enabled, billing_source\) VALUES \(@tid, @sid, 1, 'manual'\)/);
});
