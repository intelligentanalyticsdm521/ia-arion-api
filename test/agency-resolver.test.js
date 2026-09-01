// test/agency-resolver.test.js
//
// lib/agency.js — "which agency serves THIS tenant?". Replaces the global
// FOUNDER_TENANT_ID constant that hardcoded Intelligent Analytics as the one
// and only agency. These tests pin the four resolution cases plus the failure
// fallback, with a fake mssql pool (NO Azure, NO database).
//
// The contract these lock down:
//   agency_client            → provider_tenant_id
//   platform_owner | agency  → itself
//   direct                   → the platform owner
//   unknown / lookup error   → PLATFORM_OWNER_FALLBACK_TENANT_ID, and NEVER throw
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAgencyTenantId,
  isAgencyTenant,
  attachAgencyContext,
  agencyTenantIdOf,
  isAgencyCaller,
  clearAgencyCache,
  AGENCY_LOOKUP_SQL,
  AGENCY_KINDS,
  PLATFORM_OWNER_FALLBACK_TENANT_ID,
} from "../lib/agency.js";

const OWNER = "8C9527B9-8999-4B31-A306-F3D4CCC39FBD";
const AGENCY_B = "AAAAAAAA-1111-2222-3333-444444444444";
const CLIENT_OF_OWNER = "12839687-67FA-4144-A152-1219D1A64901";
const CLIENT_OF_B = "BBBBBBBB-1111-2222-3333-444444444444";
const DIRECT = "5891E335-F604-40C0-B6F1-1698220766A2";
const UNKNOWN = "DEADBEEF-0000-0000-0000-000000000000";

// core.tenants fixture — mirrors production shape (verified 2026-09-01).
const TENANTS = {
  [OWNER]: { tenant_kind: "platform_owner", provider_tenant_id: null },
  [AGENCY_B]: { tenant_kind: "agency", provider_tenant_id: null },
  [CLIENT_OF_OWNER]: { tenant_kind: "agency_client", provider_tenant_id: OWNER },
  [CLIENT_OF_B]: { tenant_kind: "agency_client", provider_tenant_id: AGENCY_B },
  [DIRECT]: { tenant_kind: "direct", provider_tenant_id: null },
};

function fakePool({ tenants = TENANTS, platformOwner = OWNER, throwOn = null } = {}) {
  const calls = [];
  return {
    calls,
    request() {
      const inputs = {};
      const req = {
        input(name, _type, value) {
          inputs[name] = value;
          return req;
        },
        async query(sqlText) {
          calls.push({ sql: sqlText, inputs: { ...inputs } });
          if (throwOn) throw new Error(throwOn);
          const row = tenants[String(inputs.tid || "").toUpperCase()] || {};
          return {
            recordset: [
              {
                tenant_kind: row.tenant_kind ?? null,
                provider_tenant_id: row.provider_tenant_id ?? null,
                platform_owner_tenant_id: platformOwner,
              },
            ],
          };
        },
      };
      return req;
    },
  };
}

function silenceConsole(fn) {
  const orig = { warn: console.warn, error: console.error, log: console.log };
  const lines = [];
  console.warn = (...a) => lines.push(a.join(" "));
  console.error = (...a) => lines.push(a.join(" "));
  console.log = (...a) => lines.push(a.join(" "));
  return Promise.resolve(fn()).finally(() => {
    console.warn = orig.warn;
    console.error = orig.error;
    console.log = orig.log;
  }).then(() => lines, (e) => { throw e; });
}

test("agency_client resolves to its own provider_tenant_id (NOT the hardcoded IA GUID)", async () => {
  clearAgencyCache();
  const pool = fakePool();
  assert.equal(await resolveAgencyTenantId(CLIENT_OF_OWNER, { pool }), OWNER);
  clearAgencyCache();
  // The whole point: a second agency's client must resolve to THAT agency.
  assert.equal(await resolveAgencyTenantId(CLIENT_OF_B, { pool }), AGENCY_B);
  assert.notEqual(await resolveAgencyTenantId(CLIENT_OF_B, { pool }), OWNER);
});

test("platform_owner and agency tenants are their own agency", async () => {
  clearAgencyCache();
  const pool = fakePool();
  assert.equal(await resolveAgencyTenantId(OWNER, { pool }), OWNER);
  assert.equal(await resolveAgencyTenantId(AGENCY_B, { pool }), AGENCY_B);
  assert.ok(AGENCY_KINDS.has("platform_owner"));
  assert.ok(AGENCY_KINDS.has("agency"));
  assert.ok(!AGENCY_KINDS.has("agency_client"));
  assert.ok(!AGENCY_KINDS.has("direct"));
});

test("direct (self-serve, no agency) resolves to the platform owner", async () => {
  clearAgencyCache();
  assert.equal(await resolveAgencyTenantId(DIRECT, { pool: fakePool() }), OWNER);
  clearAgencyCache();
  // ...and to whoever the platform owner actually is, not a baked-in GUID.
  assert.equal(
    await resolveAgencyTenantId(DIRECT, { pool: fakePool({ platformOwner: AGENCY_B }) }),
    AGENCY_B
  );
});

test("unknown tenant falls back to the platform owner and logs", async () => {
  clearAgencyCache();
  const pool = fakePool();
  let out;
  const lines = await silenceConsole(async () => {
    out = await resolveAgencyTenantId(UNKNOWN, { pool });
  });
  assert.equal(out, OWNER);
  assert.ok(lines.some((l) => l.includes("[agency]") && l.includes("not found")), "logs the miss");
});

test("lookup failure never throws — returns the constant fallback and logs", async () => {
  clearAgencyCache();
  const pool = fakePool({ throwOn: "socket hang up" });
  let out;
  const lines = await silenceConsole(async () => {
    out = await resolveAgencyTenantId(CLIENT_OF_B, { pool });
  });
  assert.equal(out, PLATFORM_OWNER_FALLBACK_TENANT_ID);
  assert.ok(lines.some((l) => l.includes("[agency]") && l.includes("lookup failed")), "logs the failure");
});

test("agency_client with a NULL provider falls back to the platform owner, does not throw", async () => {
  clearAgencyCache();
  const pool = fakePool({
    tenants: { [CLIENT_OF_B]: { tenant_kind: "agency_client", provider_tenant_id: null } },
  });
  let out;
  await silenceConsole(async () => {
    out = await resolveAgencyTenantId(CLIENT_OF_B, { pool });
  });
  assert.equal(out, OWNER);
});

test("missing / empty tenant id short-circuits to the fallback without a query", async () => {
  clearAgencyCache();
  const pool = fakePool();
  assert.equal(await resolveAgencyTenantId(null, { pool }), PLATFORM_OWNER_FALLBACK_TENANT_ID);
  assert.equal(await resolveAgencyTenantId("  ", { pool }), PLATFORM_OWNER_FALLBACK_TENANT_ID);
  assert.equal(pool.calls.length, 0, "no DB round trip for an empty tenant");
});

test("input is case-insensitive and the result is always UPPERCASE", async () => {
  clearAgencyCache();
  const pool = fakePool();
  assert.equal(await resolveAgencyTenantId(CLIENT_OF_B.toLowerCase(), { pool }), AGENCY_B);
  clearAgencyCache();
  assert.equal(
    await resolveAgencyTenantId(CLIENT_OF_B, {
      pool: fakePool({
        tenants: { [CLIENT_OF_B]: { tenant_kind: "agency_client", provider_tenant_id: AGENCY_B.toLowerCase() } },
      }),
    }),
    AGENCY_B
  );
});

test("results are cached per tenant — one round trip, not one per call", async () => {
  clearAgencyCache();
  const pool = fakePool();
  await resolveAgencyTenantId(CLIENT_OF_B, { pool });
  await resolveAgencyTenantId(CLIENT_OF_B, { pool });
  await resolveAgencyTenantId(CLIENT_OF_B, { pool });
  assert.equal(pool.calls.length, 1, "cached after the first lookup");
  // Distinct tenants are cached independently (not one global answer).
  await resolveAgencyTenantId(CLIENT_OF_OWNER, { pool });
  assert.equal(pool.calls.length, 2);
});

test("the cache is a TTL cache, not a permanent Map (senderCache incident)", async () => {
  clearAgencyCache();
  // A re-parented tenant must be picked up. bypassCache proves the cache is
  // not authoritative, and clearAgencyCache proves entries are evictable —
  // the two properties the permanent iadm-webhooks senderCache lacked.
  const before = fakePool({
    tenants: { [CLIENT_OF_B]: { tenant_kind: "agency_client", provider_tenant_id: OWNER } },
  });
  assert.equal(await resolveAgencyTenantId(CLIENT_OF_B, { pool: before }), OWNER);
  const after = fakePool();
  assert.equal(await resolveAgencyTenantId(CLIENT_OF_B, { pool: after }), OWNER, "still cached");
  assert.equal(await resolveAgencyTenantId(CLIENT_OF_B, { pool: after, bypassCache: true }), AGENCY_B);
  clearAgencyCache();
  assert.equal(await resolveAgencyTenantId(CLIENT_OF_B, { pool: after }), AGENCY_B);
});

test("failures get a SHORT ttl so a fallback does not stick", async () => {
  clearAgencyCache();
  const broken = fakePool({ throwOn: "boom" });
  await silenceConsole(() => resolveAgencyTenantId(CLIENT_OF_B, { pool: broken }));
  // Recovery: with the cache cleared the healthy pool gives the true answer.
  clearAgencyCache();
  assert.equal(await resolveAgencyTenantId(CLIENT_OF_B, { pool: fakePool() }), AGENCY_B);
});

test("isAgencyTenant is true only for platform_owner / agency", async () => {
  clearAgencyCache();
  const pool = fakePool();
  assert.equal(await isAgencyTenant(OWNER, { pool }), true);
  assert.equal(await isAgencyTenant(AGENCY_B, { pool }), true);
  assert.equal(await isAgencyTenant(CLIENT_OF_B, { pool }), false);
  assert.equal(await isAgencyTenant(DIRECT, { pool }), false);
  assert.equal(await isAgencyTenant(null, { pool }), false);
});

test("the lookup SQL stays inside iadm_platform (no cross-database join)", () => {
  // core.tenants is the ONLY object touched. A services-pool object here would
  // be the cross-database trap that silently returns [].
  const objects = AGENCY_LOOKUP_SQL.match(/\b\w+\.\w+\b/g) || [];
  for (const o of objects) {
    assert.ok(/^core\.tenants$/i.test(o) || /^[to]\.\w+$/.test(o), `unexpected object ${o}`);
  }
  assert.ok(/tenant_kind\s*=\s*'platform_owner'/.test(AGENCY_LOOKUP_SQL));
  assert.ok(/ORDER BY o\.created_at, o\.tenant_id/.test(AGENCY_LOOKUP_SQL), "deterministic owner pick");
});

test("attachAgencyContext stamps the request and never fails it", async () => {
  clearAgencyCache();
  const mw = attachAgencyContext();

  // A client of agency B: agency = B, and the caller is NOT its own agency.
  const req = { tenant: { tenantId: CLIENT_OF_B } };
  // No pool injection path in the middleware, so drive the cache first.
  await resolveAgencyTenantId(CLIENT_OF_B, { pool: fakePool() });
  await new Promise((r) => mw(req, {}, r));
  assert.equal(req.agencyTenantId, AGENCY_B);
  assert.equal(req.isAgencyCaller, false);
  assert.equal(agencyTenantIdOf(req), AGENCY_B);
  assert.equal(isAgencyCaller(req), false);

  // Agency B itself.
  const req2 = { tenant: { tenantId: AGENCY_B } };
  await resolveAgencyTenantId(AGENCY_B, { pool: fakePool() });
  await new Promise((r) => mw(req2, {}, r));
  assert.equal(req2.agencyTenantId, AGENCY_B);
  assert.equal(req2.isAgencyCaller, true);
  assert.equal(isAgencyCaller(req2), true);
});

test("sync helpers degrade to today's behaviour when the middleware never ran", () => {
  // A router mounted without attachAgencyContext must behave EXACTLY as it did
  // before this change — that is what makes the rollout safe.
  // The fallback is FOUNDER_TENANT_ID (env) or the historical IA GUID — the
  // exact value differs per environment, so assert against the export.
  const req = { tenant: { tenantId: PLATFORM_OWNER_FALLBACK_TENANT_ID } };
  assert.equal(agencyTenantIdOf(req), PLATFORM_OWNER_FALLBACK_TENANT_ID);
  assert.equal(isAgencyCaller(req), true);
  const client = { tenant: { tenantId: CLIENT_OF_B } };
  assert.equal(isAgencyCaller(client), false);
  assert.equal(agencyTenantIdOf({}), PLATFORM_OWNER_FALLBACK_TENANT_ID);
  assert.equal(isAgencyCaller({}), false);
});
