// scripts/verify-emergency-readonly.mjs
//
// Verifier for enforceEmergencyReadOnly middleware on arion-api.
//
// Injects a stub pool via the factory's `{ getPool }` option — no real DB
// connection is made, but the middleware code path (including the
// fail-open-on-missing-table branch) is exercised byte-for-byte.
//
// Run from C:/dev/iadm/arion-api:
//   node scripts/verify-emergency-readonly.mjs

import { enforceEmergencyReadOnly } from "../middleware/enforceEmergencyReadOnly.js";

const updates = [];
let mockState = {};
function makePoolStub() {
  return {
    request() {
      const inputs = {};
      const reqObj = {
        input(name, _type, value) { inputs[name] = value; return reqObj; },
        async query(q) {
          if (mockState.throwOn && mockState.throwOn(q, inputs)) {
            const e = new Error(mockState.throwMessage || "Invalid object name 'core.tenant_actas_log'.");
            e.number = 208;
            throw e;
          }
          if (/FROM core\.users/i.test(q)) return { recordset: mockState.userRows || [] };
          if (/FROM core\.tenant_actas_log/i.test(q)) return { recordset: mockState.sessRows || [] };
          if (/UPDATE core\.tenant_actas_log/i.test(q)) {
            updates.push({ sql: q, inputs: { ...inputs } });
            return { rowsAffected: [1] };
          }
          return { recordset: [] };
        },
      };
      return reqObj;
    },
  };
}

const mw = enforceEmergencyReadOnly({ getPool: async () => makePoolStub() });

let passed = 0, failed = 0;
function ok(label) { console.log(`  PASS  ${label}`); passed++; }
function fail(label, detail) {
  console.error(`  FAIL  ${label}${detail ? `: ${detail}` : ""}`);
  failed++;
}

function makeReq({ method = "GET", path = "/arion/dashboard", headers = {}, auth = null }) {
  return {
    method,
    originalUrl: path,
    url: path,
    headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    header(name) { return this.headers[(name || "").toLowerCase()]; },
    auth,
  };
}
function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.body = p; return this; },
  };
}

async function run(label, { req, expect }) {
  updates.length = 0;
  const res = makeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  try {
    if (expect.next === true) {
      if (!nextCalled) return fail(label, "expected next() but middleware short-circuited");
      if (res.body) return fail(label, `expected no body, got ${JSON.stringify(res.body)}`);
    } else {
      if (nextCalled) return fail(label, "expected short-circuit, but next() was called");
      if (res.statusCode !== expect.status) {
        return fail(label, `expected ${expect.status}, got ${res.statusCode} body=${JSON.stringify(res.body)}`);
      }
      if (expect.errorKey && res.body?.error !== expect.errorKey) {
        return fail(label, `expected error '${expect.errorKey}', got '${res.body?.error}'`);
      }
    }
    if (expect.updateStamped) {
      const stamped = updates.find((u) => /SET ended_at/i.test(u.sql));
      if (!stamped) return fail(label, "expected ended_at UPDATE, none seen");
    }
    ok(label);
  } catch (e) {
    fail(label, e.message);
  }
}

const FOUNDER_USER_ID = "00000000-0000-0000-0000-000000000111";
const TENANT_ID = "00000000-0000-0000-0000-000000000222";
const ACTAS_ID = 42;
function activeSession({ expired = false } = {}) {
  return {
    userRows: [{ user_id: FOUNDER_USER_ID }],
    sessRows: [{
      actas_log_id: ACTAS_ID,
      tenant_id: TENANT_ID,
      started_at: new Date(Date.now() - 60_000),
      expires_at: new Date(Date.now() + (expired ? -60_000 : 30 * 60_000)),
      ended_at: null,
    }],
  };
}

console.log("\nenforceEmergencyReadOnly verifier (arion-api)\n");

mockState = {};
await run("no x-actas-mode header (normal traffic) → passes through", {
  req: makeReq({ method: "POST", path: "/arion/anything" }),
  expect: { next: true },
});

mockState = {};
await run("x-actas-mode=switch → passes through", {
  req: makeReq({ method: "POST", path: "/arion/anything", headers: { "x-actas-mode": "switch" } }),
  expect: { next: true },
});

mockState = activeSession();
await run("emergency + GET /arion/dashboard → passes through", {
  req: makeReq({
    method: "GET", path: "/arion/dashboard",
    headers: { "x-actas-mode": "emergency" },
    auth: { email: "founder@ia.com", oid: "abc" },
  }),
  expect: { next: true },
});

mockState = activeSession();
await run("emergency + HEAD → passes through", {
  req: makeReq({
    method: "HEAD", path: "/arion/anything",
    headers: { "x-actas-mode": "emergency" },
    auth: { email: "founder@ia.com" },
  }),
  expect: { next: true },
});

mockState = activeSession();
await run("emergency + POST /arion/foo (non-allowlisted) → 403 emergency_read_only", {
  req: makeReq({
    method: "POST", path: "/arion/foo",
    headers: { "x-actas-mode": "emergency" },
    auth: { email: "founder@ia.com" },
  }),
  expect: { status: 403, errorKey: "emergency_read_only" },
});

mockState = activeSession();
await run("emergency + DELETE /plugin/manifest → allowlisted, passes through", {
  req: makeReq({
    method: "DELETE", path: "/plugin/manifest",
    headers: { "x-actas-mode": "emergency" },
    auth: { email: "founder@ia.com" },
  }),
  expect: { next: true },
});

mockState = activeSession();
await run("emergency + POST /plugin/download → allowlisted, passes through", {
  req: makeReq({
    method: "POST", path: "/plugin/download",
    headers: { "x-actas-mode": "emergency" },
    auth: { email: "founder@ia.com" },
  }),
  expect: { next: true },
});

mockState = activeSession();
await run("emergency + POST /super/end-session → allowlisted, passes through", {
  req: makeReq({
    method: "POST", path: "/super/end-session",
    headers: { "x-actas-mode": "emergency" },
    auth: { email: "founder@ia.com" },
  }),
  expect: { next: true },
});

mockState = activeSession({ expired: true });
await run("emergency + expired session → 419 + auto-stamp ended_at", {
  req: makeReq({
    method: "GET", path: "/arion/dashboard",
    headers: { "x-actas-mode": "emergency" },
    auth: { email: "founder@ia.com" },
  }),
  expect: { status: 419, errorKey: "emergency_session_expired", updateStamped: true },
});

mockState = { userRows: [{ user_id: FOUNDER_USER_ID }], sessRows: [] };
await run("emergency + no active session → 419 emergency_session_expired", {
  req: makeReq({
    method: "GET", path: "/arion/dashboard",
    headers: { "x-actas-mode": "emergency" },
    auth: { email: "founder@ia.com" },
  }),
  expect: { status: 419, errorKey: "emergency_session_expired" },
});

mockState = {
  throwOn: (q) => /FROM core\.tenant_actas_log|FROM core\.users/i.test(q),
  throwMessage: "Invalid object name 'core.tenant_actas_log'.",
};
await run("emergency + table missing (migration 092 not applied) → FAIL OPEN", {
  req: makeReq({
    method: "POST", path: "/arion/foo",
    headers: { "x-actas-mode": "emergency" },
    auth: { email: "founder@ia.com" },
  }),
  expect: { next: true },
});

mockState = {};
await run("emergency + no Bearer token / no claims → 401 unauthenticated", {
  req: makeReq({
    method: "GET", path: "/arion/dashboard",
    headers: { "x-actas-mode": "emergency" },
  }),
  expect: { status: 401, errorKey: "unauthenticated" },
});

mockState = { userRows: [], sessRows: [] };
await run("emergency + claims present but founder not in core.users → 403 forbidden", {
  req: makeReq({
    method: "GET", path: "/arion/dashboard",
    headers: { "x-actas-mode": "emergency" },
    auth: { email: "not-the-founder@example.com", oid: "xyz" },
  }),
  expect: { status: 403, errorKey: "forbidden" },
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
