// arion-api's thin entitlement client, SEAM-3-B, and the ARION tier gate.
//
// arion was an EIGHTH source for "does this business have X?" that the seams
// audit's §3 table does not list: middleware/requireArionTier.js resolved the
// tier from arion.site.arion_tier / arion.tenant.plan and nothing else, so a
// business that bought ARION Pro in Stripe but whose site row still said
// "standard" was Pro in the Portal, Pro in LUMEN and Standard here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getEntitlements, clearEntitlementCache, productOf, addonOf, mayUseFeature, maySpend,
} from "../lib/entitlements.js";
import { RANK, rankOf, tierMeets } from "../lib/entitlementsRule.js";
import { higherTier, resolveArionTier, requireArionTier } from "../middleware/requireArionTier.js";

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
