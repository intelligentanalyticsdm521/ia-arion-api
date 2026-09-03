// test/site-request.test.mjs
//
// Pins Foundation §3A3: ARION "request a change" is stored, not discarded.
//
// The defect: POST /arion/sites/:siteId/requests validated the body, minted a
// UUID and returned it — "arion.site_request table would need to exist; for
// now return the ID". The client saw success; nothing reached anyone.
//
// lib/siteRequests.js holds every statement; a fake mssql pool captures the SQL
// + inputs (NO database), same idiom as agency-resolver.test.js. The routes are
// pinned by source so the handler cannot quietly go back to returning a UUID.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SITE_REQUEST_STATUSES,
  createSiteRequest,
  listSiteRequests,
  listSiteRequestsForFounder,
  updateSiteRequestStatus,
  notifyFounderOfSiteRequest,
  toApi,
} from "../lib/siteRequests.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const TENANT = "12839687-67FA-4144-A152-1219D1A64901";
const SITE = "AAAAAAAA-1111-2222-3333-444444444444";

// Fake pool: records every query; INSERT/UPDATE ... OUTPUT INSERTED.* echo a row
// built from the inputs so the API mapping is exercised end to end.
function fakePool({ rows = null, notFound = false } = {}) {
  const calls = [];
  return {
    calls,
    request() {
      const inputs = {};
      const req = {
        input(name, _type, value) { inputs[name] = arguments.length >= 3 ? value : _type; return req; },
        async query(text) {
          const sqlText = text.replace(/\s+/g, " ").trim();
          calls.push({ sql: sqlText, inputs: { ...inputs } });
          if (/INSERT INTO arion\.site_request/i.test(sqlText)) {
            return { recordset: [{
              site_request_id: inputs.id, tenant_id: inputs.tenantId, site_id: inputs.siteId,
              request_type: inputs.requestType, notes: inputs.notes, status: "open",
              requested_by_email: inputs.requestedBy, created_at: "2026-09-04T00:00:00Z",
              updated_at: "2026-09-04T00:00:00Z", resolved_at: null, resolution_notes: null,
            }] };
          }
          if (/UPDATE arion\.site_request/i.test(sqlText)) {
            if (notFound) return { recordset: [] };
            return { recordset: [{
              site_request_id: inputs.id, tenant_id: TENANT, site_id: SITE, request_type: "content_update",
              notes: "n", status: inputs.status, requested_by_email: null, created_at: "c", updated_at: "u",
              resolved_at: inputs.resolved ? "2026-09-04T01:00:00Z" : null, resolution_notes: inputs.notes,
            }] };
          }
          return { recordset: rows || [] };
        },
      };
      return req;
    },
  };
}

test("createSiteRequest writes an OPEN row with the caller's identity and returns it", async () => {
  const pool = fakePool();
  const r = await createSiteRequest(pool, {
    tenantId: TENANT, siteId: SITE, requestType: "content_update",
    notes: "Change the phone number on the contact page", requestedByEmail: "owner@example.com",
  });
  const ins = pool.calls.find((c) => /INSERT INTO arion\.site_request/i.test(c.sql));
  assert.ok(ins, "an INSERT into arion.site_request ran — the row APPEARS");
  assert.match(ins.sql, /VALUES \(@id, @tenantId, @siteId, @requestType, @notes, 'open', @requestedBy\)/);
  assert.equal(ins.inputs.tenantId, TENANT);
  assert.equal(ins.inputs.siteId, SITE);
  assert.equal(ins.inputs.requestType, "content_update");
  assert.equal(ins.inputs.notes, "Change the phone number on the contact page");
  assert.equal(ins.inputs.requestedBy, "owner@example.com");
  assert.match(String(ins.inputs.id), /^[0-9a-f-]{36}$/i, "a fresh UUID is the PK");
  assert.equal(r.siteRequestId, ins.inputs.id, "the Portal keeps reading request.siteRequestId");
  assert.equal(r.status, "open");
  assert.equal(r.requestedByEmail, "owner@example.com");
});

test("createSiteRequest refuses a missing requestType before touching the DB", async () => {
  const pool = fakePool();
  await assert.rejects(() => createSiteRequest(pool, { tenantId: TENANT, siteId: SITE, requestType: "" }), /requestType/);
  assert.equal(pool.calls.length, 0);
});

test("listSiteRequests is scoped to tenant + site, newest first, capped", async () => {
  const pool = fakePool({ rows: [{ site_request_id: "x", tenant_id: TENANT, site_id: SITE, status: "open", request_type: "content_update" }] });
  const list = await listSiteRequests(pool, { tenantId: TENANT, siteId: SITE, limit: 9999 });
  const q = pool.calls[0];
  assert.match(q.sql, /WHERE tenant_id = @tenantId AND site_id = @siteId/, "another tenant's requests must never leak");
  assert.match(q.sql, /ORDER BY created_at DESC/);
  assert.equal(q.inputs.tenantId, TENANT);
  assert.equal(q.inputs.siteId, SITE);
  assert.equal(q.inputs.top, 50, "client history is capped at 50 whatever the caller asks");
  assert.equal(list.length, 1);
  assert.equal(list[0].siteRequestId, "x");
});

test("founder list joins the site domain, filters by a valid status, rejects an invalid one", async () => {
  const pool = fakePool({ rows: [{ site_request_id: "y", tenant_id: TENANT, site_id: SITE, status: "open", domain: "briarwoodsmiles.com" }] });
  const list = await listSiteRequestsForFounder(pool, { status: "open" });
  assert.match(pool.calls[0].sql, /LEFT JOIN arion\.site s ON s\.site_id = r\.site_id AND s\.tenant_id = r\.tenant_id/);
  assert.match(pool.calls[0].sql, /\(@status IS NULL OR r\.status = @status\)/);
  assert.equal(pool.calls[0].inputs.status, "open");
  assert.equal(list[0].domain, "briarwoodsmiles.com");

  const p2 = fakePool();
  await listSiteRequestsForFounder(p2, {});
  assert.equal(p2.calls[0].inputs.status, null, "no filter → every status");

  const p3 = fakePool();
  await assert.rejects(() => listSiteRequestsForFounder(p3, { status: "bogus" }), /status must be one of/);
  assert.equal(p3.calls.length, 0);
});

test("updateSiteRequestStatus: done/declined stamp resolved_at, moving back clears it, bogus is refused", async () => {
  assert.deepEqual([...SITE_REQUEST_STATUSES], ["open", "in_progress", "done", "declined"]);

  const pool = fakePool();
  const done = await updateSiteRequestStatus(pool, { siteRequestId: "r1", status: "done", resolutionNotes: "Phone number updated" });
  const upd = pool.calls[0];
  assert.match(upd.sql, /resolved_at = CASE WHEN @resolved = 1 THEN SYSUTCDATETIME\(\) ELSE NULL END/);
  assert.match(upd.sql, /resolution_notes = COALESCE\(@notes, resolution_notes\)/, "a PATCH without notes keeps the old note");
  assert.match(upd.sql, /WHERE site_request_id = @id/);
  assert.equal(upd.inputs.resolved, 1);
  assert.equal(upd.inputs.notes, "Phone number updated");
  assert.equal(done.status, "done");
  assert.ok(done.resolvedAt, "resolvedAt is returned");

  const back = await updateSiteRequestStatus(pool, { siteRequestId: "r1", status: "in_progress" });
  assert.equal(pool.calls[1].inputs.resolved, 0);
  assert.equal(back.resolvedAt, null);

  const missing = await updateSiteRequestStatus(fakePool({ notFound: true }), { siteRequestId: "nope", status: "declined" });
  assert.equal(missing, null, "unknown id → null so the route can 404");

  const p3 = fakePool();
  await assert.rejects(() => updateSiteRequestStatus(p3, { siteRequestId: "r1", status: "resolved" }), /status must be one of/);
  assert.equal(p3.calls.length, 0, "an invalid status never reaches the DB");
});

test("notifyFounderOfSiteRequest: emails the configured inbox, skips loudly when unset, never throws", async () => {
  const request = { siteRequestId: "abc", tenantId: TENANT, siteId: SITE, requestType: "content_update", notes: "Change <the> phone", requestedByEmail: "owner@example.com" };
  const site = { domain: "briarwoodsmiles.com" };
  const tenant = { tenantName: "briarwood", tenantFullName: "Briarwood Smiles" };

  const saved = process.env.SITE_REQUEST_NOTIFY_EMAIL;
  try {
    delete process.env.SITE_REQUEST_NOTIFY_EMAIL;
    let sent = [];
    const r0 = await notifyFounderOfSiteRequest({ request, site, tenant }, async (m) => { sent.push(m); return { ok: true }; });
    assert.deepEqual(r0, { ok: false, error: "not_configured" });
    assert.equal(sent.length, 0, "no address → no send, and the result says why");

    process.env.SITE_REQUEST_NOTIFY_EMAIL = "brandon@example.com";
    const r1 = await notifyFounderOfSiteRequest({ request, site, tenant }, async (m) => { sent.push(m); return { ok: true, message_id: "m1" }; });
    assert.equal(r1.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "brandon@example.com");
    assert.equal(sent[0].subject, "Change request — Briarwood Smiles / briarwoodsmiles.com");
    assert.match(sent[0].html, /Change &lt;the&gt; phone/, "client text is escaped, not injected");
    assert.match(sent[0].text, /owner@example\.com/);
    assert.equal(sent[0].tag, "site-request");
    assert.equal(sent[0].metadata.site_request_id, "abc");

    const r2 = await notifyFounderOfSiteRequest({ request, site, tenant }, async () => { throw new Error("postmark down"); });
    assert.equal(r2.ok, false, "a failed email is reported, not thrown into the route");
  } finally {
    if (saved === undefined) delete process.env.SITE_REQUEST_NOTIFY_EMAIL; else process.env.SITE_REQUEST_NOTIFY_EMAIL = saved;
  }
});

test("toApi maps every column and only adds domain when joined", () => {
  const api = toApi({ site_request_id: "1", tenant_id: "t", site_id: "s", request_type: "content_update", notes: "n", status: "open", requested_by_email: "e", created_at: "c", updated_at: "u", resolved_at: null, resolution_notes: null });
  assert.deepEqual(Object.keys(api), ["siteRequestId", "tenantId", "siteId", "requestType", "notes", "status", "requestedByEmail", "createdAt", "updatedAt", "resolvedAt", "resolutionNotes"]);
  assert.equal(toApi(null), null);
});

// ── the wiring, pinned by source ────────────────────────────────────────
test("POST /arion/sites/:siteId/requests writes the row and GET lists it", () => {
  const src = read("routes/arion.js");
  assert.ok(!/would need to exist/.test(src), "the discard-and-return-a-UUID comment is gone");
  assert.match(src, /router\.post\('\/sites\/:siteId\/requests'[\s\S]*?createSiteRequest\(pool, \{/, "POST persists through createSiteRequest");
  assert.match(src, /requestedByEmail: getEmailFromClaims\(req\.auth \|\| \{\}\)/, "the caller's email is recorded");
  assert.match(src, /notifyFounderOfSiteRequest\(\{ request, site, tenant: req\.tenant \}\)\s*\.catch/, "founder email is fire-and-forget");
  assert.match(src, /router\.get\('\/sites\/:siteId\/requests'[\s\S]*?listSiteRequests\(pool, \{ tenantId, siteId \}\)/, "GET returns the tenant's history");
  assert.match(src, /res\.json\(\{ request \}\)/, "the Portal's { request: { siteRequestId } } shape is kept");
});

test("the founder queue sits behind the FOUNDER_ADMIN_TOKEN gate and is mounted", () => {
  const admin = read("routes/admin/siteRequests.js");
  assert.match(admin, /router\.get\("\/site-requests", requireFounderAuth/);
  assert.match(admin, /router\.patch\("\/site-requests\/:id", requireFounderAuth/);
  assert.match(read("routes/admin/onboardExisting.js"), /export function requireFounderAuth/);
  const index = read("index.js");
  assert.match(index, /import adminSiteRequestsRouter from '\.\/routes\/admin\/siteRequests\.js'/);
  assert.match(index, /app\.use\('\/admin', adminSiteRequestsRouter\)/);
});

test("migration 055 creates arion.site_request idempotently with the status CHECK", () => {
  const m = read("db/migrations/055_site_request.sql");
  assert.match(m, /IF OBJECT_ID\('arion\.site_request', 'U'\) IS NULL/);
  assert.match(m, /CHECK \(status IN \('open', 'in_progress', 'done', 'declined'\)\)/);
  for (const col of ["site_request_id", "tenant_id", "site_id", "request_type", "notes", "status", "requested_by_email", "created_at", "updated_at", "resolved_at", "resolution_notes"]) {
    assert.match(m, new RegExp(`^\\s+${col}\\s`, "m"), `column ${col} present`);
  }
  assert.ok((m.match(/^GO\s*$/gm) || []).length >= 2, "GO-separated");
});
