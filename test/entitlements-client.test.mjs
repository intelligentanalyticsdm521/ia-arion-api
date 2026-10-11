// arion-api's thin entitlement client, SEAM-3-B, and the ARION tier gate.
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
const { higherTier, resolveArionTier, requireArionTier } =
  await import("../middleware/requireArionTier.js");

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

/* ── the ARION tier gate ──────────────────────────────────────────────────── */

const TENANT_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

/** A services pool that returns one arion.site / arion.tenant row. */
function poolWith(row, { throws = false } = {}) {
  return {
    request() {
      const r = {
        input() { return r; },
        async query() {
          if (throws) throw new Error("services db down");
          return { recordset: row ? [row] : [] };
        },
      };
      return r;
    },
  };
}

function reqFor() {
  return { tenant: { tenantId: TENANT_ID }, originalUrl: "/arion/staging/publish", path: "/arion/staging/publish" };
}

const entSaying = (tier, decided = true) => async () => ({
  decided, products: { arion: { owned: true, tier, tier_source: "stripe", decided } }, addons: {},
});

test("higherTier never lets either source demote the other", () => {
  assert.equal(higherTier("pro", "standard"), "pro");
  assert.equal(higherTier("standard", "pro"), "pro");
  assert.equal(higherTier(null, "pro"), "pro");
  assert.equal(higherTier("pro", null), "pro");
  assert.equal(higherTier(null, null), null);
});

test("a business that bought Pro is Pro here even when the site row still says standard", async () => {
  // This is the disagreement the pack removes: Portal and LUMEN said Pro, this
  // gate said standard, and /staging 402'd for a paying customer.
  const req = reqFor();
  const tier = await resolveArionTier(req, {
    getEntitlements: entSaying("pro"),
    // eslint-disable-next-line no-unused-vars
  });
  assert.equal(tier, "pro");
});

test("an UNDECIDED entitlement never demotes the site row", async () => {
  const req = reqFor();
  const tier = await resolveArionTier(req, { getEntitlements: entSaying("lite", false) });
  assert.equal(tier, null, "undecided is not a tier; the site row answers alone (and here there is none)");
});

test("the gate still fails OPEN when nothing resolves, and only denies a resolved shortfall", async () => {
  const calls = [];
  const res = { status(c) { calls.push(c); return { json() { return this; } }; } };

  let nexted = false;
  await requireArionTier({ getEntitlements: async () => null })(
    { ...reqFor() }, res, () => { nexted = true; },
  );
  assert.equal(nexted, true, "nothing resolved → allow, never 402");
  assert.deepEqual(calls, []);

  nexted = false;
  await requireArionTier({ getEntitlements: entSaying("standard") })(
    { ...reqFor(), _arionTier: undefined }, res, () => { nexted = true; },
  );
  // /staging needs Pro and the business positively resolved to Standard.
  assert.equal(nexted, false);
  assert.deepEqual(calls, [402]);
});

test("an unlisted path is never gated at all, and never asks the service", async () => {
  let asked = 0;
  let nexted = false;
  await requireArionTier({ getEntitlements: async () => { asked++; return null; } })(
    { tenant: { tenantId: TENANT_ID }, originalUrl: "/arion/pages", path: "/arion/pages" },
    { status() { throw new Error("must not respond"); } },
    () => { nexted = true; },
  );
  assert.equal(nexted, true);
  assert.equal(asked, 0);
});

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

/* ── F4 (2026-10-07): a decided Stripe tier stands, even when it is LOWER ─── */

const sitePool = (arion_tier) => async () => ({
  request() {
    const rq = { input() { return rq; }, async query() { return { recordset: [{ arion_tier, plan: null }] }; } };
    return rq;
  },
});
const entFrom = (tier, tier_source, decided = true) => async () => ({
  decided, products: { arion: { owned: true, tier, tier_source, decided } }, addons: {},
});

test("F4 decided Stripe 'standard' with the site row at 'pro' gives standard — an ARION downgrade lowers ARION's tier", async () => {
  const tier = await resolveArionTier(reqFor(), { getEntitlements: entFrom("standard", "stripe"), getServicesPool: sitePool("pro") });
  assert.equal(tier, "standard");
});

test("F4 undecided gives the site row", async () => {
  const tier = await resolveArionTier(reqFor(), { getEntitlements: entFrom("standard", "stripe", false), getServicesPool: sitePool("pro") });
  assert.equal(tier, "pro");
});

// CHANGED 2026-10-11 (Brandon: "it's by their subscription"): a decided, real
// tier from the payload stands from ANY source. Until then a non-Stripe tier
// (comped, set by hand on core.tenant_services) was combined with the site row
// as "the higher of", so a site row stamped above what the business pays for
// kept unlocking features. The site row is now only the fallback.
test("by the subscription: a tier set on core.tenant_services stands, even below the site row", async () => {
  const tier = await resolveArionTier(reqFor(), { getEntitlements: entFrom("standard", "core.tenant_services"), getServicesPool: sitePool("pro") });
  assert.equal(tier, "standard");
});

test("F12 a COMPED ARION is the comped tier platform-api serves; the site row neither raises nor lowers it", async () => {
  // platform-api serves a comped row at the higher of the comped tier and any
  // live Stripe tier, with tier_source 'comped' (platform-api b4495d1), so the
  // comp is already protected there. Here that tier simply stands.
  assert.equal(await resolveArionTier(reqFor(), { getEntitlements: entFrom("business", "comped"), getServicesPool: sitePool("lite") }), "business");
  assert.equal(await resolveArionTier(reqFor(), { getEntitlements: entFrom("standard", "comped"), getServicesPool: sitePool("pro") }), "standard");
});

test("F4 a Stripe tier word that is not a tier ('website') never demotes: the site row is the fallback", async () => {
  const tier = await resolveArionTier(reqFor(), { getEntitlements: entFrom("website", "stripe"), getServicesPool: sitePool("pro") });
  assert.equal(tier, "pro");
});

test("migration 041: a paid ARION grant is billing_source 'stripe'; the founder's onboard-existing is 'manual'", () => {
  const core = fs.readFileSync(path.join(ROOT, "lib", "coreTenants.js"), "utf8");
  assert.match(core, /INSERT INTO core\.tenant_services \(tenant_id, service_id, is_enabled, billing_source\) VALUES \(@tid, @sid, 1, 'stripe'\)/);
  const onb = fs.readFileSync(path.join(ROOT, "routes", "admin", "onboardExisting.js"), "utf8");
  assert.match(onb, /INSERT INTO core\.tenant_services \(tenant_id, service_id, is_enabled, billing_source\) VALUES \(@tid, @sid, 1, 'manual'\)/);
});
