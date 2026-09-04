// test/founder-tenant-one-module.test.mjs — SEAM-4 in arion-api.
//
// Two halves of audit §0 item 9:
//
//   1. THE GUID. `8c9527b9-…` was pasted into five runtime files here. Its
//      damage line is one sentence: nobody can change the founder tenant, ever
//      — and migration 138's `tenant_kind` model exists precisely so a SECOND
//      agency can run this platform. It lives in lib/agency.js now.
//
//   2. THE FOUNDER CHECK. This repo had TWO of the six implementations:
//      middleware/requireFounder.findFounderRole (a platform-ROLE query, with
//      a header claiming it was "the same question platform-api's
//      isFounderCaller asks" — written out again rather than asked), and
//      middleware/enforceViewAsReadOnly (a MEMBERSHIP query with its own
//      60-second cache, byte-identical to the copies in oliver and LUMEN).
//      Both ask platform-api now, each keeping the question it always asked.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  founderTenantId, isFounderTenantId, FOUNDER_TENANT_ID_DEFAULT,
  PLATFORM_OWNER_FALLBACK_TENANT_ID,
} from "../lib/agency.js";
import {
  resolveFounderFacts, clearFounderCache, FounderUnavailable, FOUNDER_TTL_MS,
} from "../lib/founderClient.js";
import { platformApiUrl, platformInternalToken } from "../lib/platformEnv.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Source with comments stripped. LINE comments first: a line comment holding
 *  a path like `/il/admin/*` otherwise reads as the start of a block. */
function code(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

/* ── 1. one module holds the GUID ───────────────────────────────────────── */

test("the founder tenant GUID appears in exactly ONE runtime module", () => {
  // Runtime source only. db/migrations is a historical record — a migration
  // that seeded a row for that tenant cannot be re-pointed at an env var —
  // and scripts/ and test/ are out of scope, as in the audit's own count.
  const DIRS = ["lib", "middleware", "routes", "services", "jobs"];
  const ALLOWED = new Set(["lib/agency.js"]);
  const hits = [];
  const walk = (dir) => {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { walk(rel); continue; }
      if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
      const body = fs.readFileSync(path.join(ROOT, rel), "utf8");
      if (/8c9527b9-8999-4b31-a306-f3d4ccc39fbd/i.test(body) && !ALLOWED.has(rel)) hits.push(rel);
    }
  };
  for (const d of DIRS) walk(d);
  const indexBody = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");
  if (/8c9527b9-8999-4b31-a306-f3d4ccc39fbd/i.test(indexBody)) hits.push("index.js");
  assert.deepEqual(hits, [],
    `the founder tenant GUID must only appear in lib/agency.js — found in: ${hits.join(", ")}`);
});

test("MUTATION: the grep catches both spellings a paste would produce", () => {
  const d = /8c9527b9-8999-4b31-a306-f3d4ccc39fbd/i;
  assert.ok(d.test('const F = "8C9527B9-8999-4B31-A306-F3D4CCC39FBD";'));
  assert.ok(d.test("tenant_id = '8c9527b9-8999-4b31-a306-f3d4ccc39fbd'"));
});

test("the constant is env-driven, uppercased, with the literal as the default", () => {
  assert.equal(founderTenantId({}), FOUNDER_TENANT_ID_DEFAULT);
  assert.equal(founderTenantId({ FOUNDER_TENANT_ID: "aaaaaaaa-0000-0000-0000-000000000001" }),
    "AAAAAAAA-0000-0000-0000-000000000001");
  assert.equal(isFounderTenantId("8c9527b9-8999-4b31-a306-f3d4ccc39fbd", {}), true);
  assert.equal(isFounderTenantId("", {}), false, "an empty tenant is never the founder");
  assert.equal(PLATFORM_OWNER_FALLBACK_TENANT_ID, founderTenantId(), "the existing export still works");
});

test("routes/argus asks the TENANT question, which is the shape a GUID compare is right for", () => {
  const src = code("routes/argus.js");
  assert.match(src, /isFounderTenantId\(req\?\.tenant\?\.tenantId\)/);
  assert.ok(!/const FOUNDER_TENANT_ID = "/.test(src), "no local copy of the id");
});

test("the dev seam blocks the PRODUCTION founder tenant, not the configured one", () => {
  // This repo's siblings point FOUNDER_TENANT_ID at a fixture agency in dev,
  // and that fixture IS in the allow-list. What must never be a dev tenant is
  // the production founder tenant, whose GUID the shared CIAM directory shares.
  const src = code("lib/devAuth.js");
  assert.match(src, /FOUNDER_TENANT_ID_DEFAULT/);
  assert.ok(!/founderTenantId\(\)\.toLowerCase\(\)/.test(src));
});

/* ── 2. one env-reading module ──────────────────────────────────────────── */

test("SEAM-11: one place reads the platform-api address and token", () => {
  assert.equal(typeof platformApiUrl, "function");
  assert.equal(typeof platformInternalToken, "function");
  assert.equal(platformApiUrl({ PLATFORM_API_URL: "https://x.test/" }), "https://x.test");
  assert.equal(platformApiUrl({ PLATFORM_API_BASE_URL: "https://y.test" }), "https://y.test",
    "the legacy name is still accepted for one release");
  assert.equal(platformInternalToken({ PLATFORM_INTERNAL_TOKEN: "a" }), "a");
  assert.equal(platformInternalToken({ LUMEN_INTERNAL_SERVICE_TOKEN: "b" }), "b");

  // lib/entitlements.js had its own private copy of both, with a different
  // alias list — the SEAM-11 shape one repo lower down.
  const ent = code("lib/entitlements.js");
  assert.ok(!/env\.PLATFORM_API_BASE_URL/.test(ent), "no second env-reading copy");
  assert.match(ent, /from "\.\/platformEnv\.js"/);
});

/* ── 3. the two founder gates ───────────────────────────────────────────── */

function withEnv(fn) {
  const prev = { u: process.env.PLATFORM_API_URL, t: process.env.PLATFORM_INTERNAL_TOKEN };
  process.env.PLATFORM_API_URL = "http://127.0.0.1:9";
  process.env.PLATFORM_INTERNAL_TOKEN = "s3cret";
  return Promise.resolve(fn()).finally(() => {
    if (prev.u === undefined) delete process.env.PLATFORM_API_URL; else process.env.PLATFORM_API_URL = prev.u;
    if (prev.t === undefined) delete process.env.PLATFORM_INTERNAL_TOKEN; else process.env.PLATFORM_INTERNAL_TOKEN = prev.t;
  });
}

test("one call per identity per minute, and the email never enters a URL", async () => {
  clearFounderCache();
  await withEnv(async () => {
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls += 1;
      assert.match(url, /\/internal\/founder$/);
      assert.ok(!url.includes("brandon@"), "an email address must never appear in a URL");
      assert.equal(init.method, "POST");
      return { ok: true, status: 200, json: async () => ({ is_founder: true, is_founder_team: true, agency_grant: null, role_key: "founder" }) };
    };
    let t = 100;
    const now = () => t;
    await resolveFounderFacts({ email: "brandon@ia.test", oid: "s" }, { fetchImpl, now });
    await resolveFounderFacts({ email: "brandon@ia.test", oid: "s" }, { fetchImpl, now });
    assert.equal(calls, 1);
    t += FOUNDER_TTL_MS + 1;
    await resolveFounderFacts({ email: "brandon@ia.test", oid: "s" }, { fetchImpl, now });
    assert.equal(calls, 2);
  });
});

test("MUTATION: no answer THROWS — it never becomes 'not a founder'", async () => {
  clearFounderCache();
  await withEnv(async () => {
    await assert.rejects(
      () => resolveFounderFacts({ email: "b@ia.test" }, { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) }),
      (e) => e instanceof FounderUnavailable
    );
  });
  clearFounderCache();
  // BOTH names have to go: `PLATFORM_API_BASE_URL` is the legacy alias this
  // repo's .env still carries, and lib/platformEnv.js accepts it for one more
  // release. Clearing only the canonical name and calling the result
  // "unconfigured" would have tested nothing — the alias answered.
  const prev = { u: process.env.PLATFORM_API_URL, a: process.env.PLATFORM_API_BASE_URL };
  delete process.env.PLATFORM_API_URL;
  delete process.env.PLATFORM_API_BASE_URL;
  try {
    await assert.rejects(
      () => resolveFounderFacts({ email: "b@ia.test" }, { fetchImpl: async () => { throw new Error("must not be called"); } }),
      (e) => e.reason === "founder_not_configured"
    );
  } finally {
    if (prev.u !== undefined) process.env.PLATFORM_API_URL = prev.u;
    if (prev.a !== undefined) process.env.PLATFORM_API_BASE_URL = prev.a;
  }
});

test("both gates hold no SQL, and each keeps the question it always asked", () => {
  const rf = code("middleware/requireFounder.js");
  assert.match(rf, /resolveFounderFacts/);
  assert.match(rf, /facts\.is_founder/, "requireFounder asks the platform ROLE");
  assert.ok(!/core\.user_platform_roles/.test(rf), "its inline role SQL is gone");
  assert.match(rf, /matchesFounderAdminToken/,
    "the static bearer stays for scripts — documented, and unchanged");

  const va = code("middleware/enforceViewAsReadOnly.js");
  assert.match(va, /resolveFounderFacts/);
  assert.match(va, /is_founder_team/, "view-as asks MEMBERSHIP, the population it always admitted");
  assert.ok(!/core\.tenant_users/.test(va), "its inline membership SQL is gone");
  assert.ok(!/founderCache/.test(va), "and the second 60s cache with it");
  assert.match(va, /founder_lookup_unavailable/,
    "a check we could not RUN must be distinguishable from a caller we refused");
});
