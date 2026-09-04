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
  sendSiteRequestResolvedEmail,
  summarizeRequest,
  RESOLVED_TEMPLATE_KEY,
  toApi,
} from "../lib/siteRequests.js";
import { requireFounder, matchesFounderAdminToken, findFounderRole } from "../middleware/requireFounder.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const TENANT = "12839687-67FA-4144-A152-1219D1A64901";
const SITE = "AAAAAAAA-1111-2222-3333-444444444444";

// Fake pool: records every query; INSERT/UPDATE ... OUTPUT INSERTED.* echo a row
// built from the inputs so the API mapping is exercised end to end.
function fakePool({ rows = null, notFound = false, previousStatus = "open" } = {}) {
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
              previous_status: previousStatus,
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

test("the founder queue sits behind the founder gate and is mounted", () => {
  const admin = read("routes/admin/siteRequests.js");
  assert.match(admin, /router\.get\("\/site-requests", requireFounder/);
  assert.match(admin, /router\.patch\("\/site-requests\/:id", requireFounder/);
  assert.match(read("middleware/requireFounder.js"), /export function requireFounder/);
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

// ── the founder gate the Portal can use ─────────────────────────────────
test("the founder gate accepts the static admin token", () => {
  const saved = process.env.FOUNDER_ADMIN_TOKEN;
  try {
    process.env.FOUNDER_ADMIN_TOKEN = "s3cret";
    assert.equal(matchesFounderAdminToken({ headers: { authorization: "Bearer s3cret" } }), true);
    assert.equal(matchesFounderAdminToken({ headers: { authorization: "Bearer nope" } }), false);
    assert.equal(matchesFounderAdminToken({ headers: {} }), false);

    let nexted = false;
    const req = { headers: { authorization: "Bearer s3cret" } };
    requireFounder(req, {}, () => { nexted = true; });
    assert.equal(nexted, true, "a server-to-server caller still gets straight through");
    assert.equal(req.founderAuth.via, "admin_token");
  } finally {
    if (saved === undefined) delete process.env.FOUNDER_ADMIN_TOKEN; else process.env.FOUNDER_ADMIN_TOKEN = saved;
  }
});

test("an unset FOUNDER_ADMIN_TOKEN never matches — no empty-string bypass", () => {
  const saved = process.env.FOUNDER_ADMIN_TOKEN;
  try {
    delete process.env.FOUNDER_ADMIN_TOKEN;
    assert.equal(matchesFounderAdminToken({ headers: { authorization: "Bearer " } }), false);
    assert.equal(matchesFounderAdminToken({ headers: { authorization: "Bearer anything" } }), false);
  } finally {
    if (saved === undefined) delete process.env.FOUNDER_ADMIN_TOKEN; else process.env.FOUNDER_ADMIN_TOKEN = saved;
  }
});

test("the role path asks the platform DB the SAME founder question as onboard-client.js", async () => {
  const pool = fakePool({ rows: [{ user_id: "u1", email: "brandon@example.com", full_name: "Brandon", role_key: "founder" }] });
  const found = await findFounderRole(pool, { oid: "sub-1", email: "brandon@example.com" });
  const q = pool.calls[0];
  assert.match(q.sql, /JOIN core\.user_platform_roles upr ON upr\.user_id = u\.user_id AND upr\.is_active = 1/);
  assert.match(q.sql, /JOIN core\.platform_roles pr ON pr\.platform_role_id = upr\.platform_role_id AND pr\.is_active = 1/);
  assert.match(q.sql, /pr\.role_key IN \('founder', 'super_admin'\) OR pr\.name = 'SUPER_ADMIN'/);
  assert.equal(q.inputs.sub, "sub-1");
  assert.equal(q.inputs.email, "brandon@example.com");
  assert.equal(found.role_key, "founder");

  const none = await findFounderRole(fakePool({ rows: [] }), { oid: "sub-2", email: "client@example.com" });
  assert.equal(none, null, "a client with no platform role is not a founder");

  const anon = fakePool();
  assert.equal(await findFounderRole(anon, {}), null);
  assert.equal(anon.calls.length, 0, "no identity → no query");
});

test("a signed-in non-founder is refused with 403, and a lookup failure closes the gate", () => {
  const src = read("middleware/requireFounder.js");
  assert.match(src, /code: "FORBIDDEN", message: "Founder access required", status: 403/);
  assert.match(src, /console\.error\("\[requireFounder\] role lookup failed/);
  assert.match(src, /code: "INTERNAL_ERROR"[\s\S]{0,120}status: 500/, "a DB failure must not open the queue to everyone");
});

// ── the resolved email ──────────────────────────────────────────────────
test("updateSiteRequestStatus reports the status it moved FROM", async () => {
  const pool = fakePool({ previousStatus: "in_progress" });
  const r = await updateSiteRequestStatus(pool, { siteRequestId: "r1", status: "done" });
  assert.match(pool.calls[0].sql, /OUTPUT DELETED\.status AS previous_status, INSERTED\.\*/);
  assert.equal(r.previousStatus, "in_progress");
  assert.equal(r.status, "done");
});

test("the resolved email posts LUMEN's send-by-template-key with the seeded template", async () => {
  const savedBase = process.env.LUMEN_API_BASE_URL;
  const savedTok = process.env.LUMEN_INTERNAL_SERVICE_TOKEN;
  try {
    process.env.LUMEN_API_BASE_URL = "https://lumen.example.com/";
    process.env.LUMEN_INTERNAL_SERVICE_TOKEN = "int-tok";
    const calls = [];
    const r = await sendSiteRequestResolvedEmail({
      request: { siteRequestId: "abc", tenantId: TENANT, siteId: SITE, status: "done", notes: "Update the phone number", resolutionNotes: "Changed it", requestedByEmail: "owner@example.com" },
      site: { domain: "briarwoodsmiles.com" },
      senderTenantId: "AGENCY-1",
      senderName: "Intelligent Analytics",
      recipientFirstName: "Dana",
    }, async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => "{}" }; });

    assert.equal(r.ok, true);
    assert.equal(calls[0].url, "https://lumen.example.com/api/v1/internal/email/send-by-template-key");
    assert.equal(calls[0].init.headers["x-internal-token"], "int-tok");
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.templateKey, "arion.site_request_resolved");
    assert.equal(sent.templateKey, RESOLVED_TEMPLATE_KEY);
    assert.equal(sent.recipientEmail, "owner@example.com", "the person who asked is the person told");
    assert.equal(sent.tenantId, "AGENCY-1", "LUMEN picks the from-address off the agency tenant");
    assert.equal(sent.context.contact.first_name, "Dana");
    assert.equal(sent.context.site.domain, "briarwoodsmiles.com");
    assert.equal(sent.context.request.status, "done");
    assert.equal(sent.context.request.resolution_notes, "Changed it");
    assert.equal(sent.context.request.summary, "Update the phone number");
    assert.equal(sent.context.tenant.name, "Intelligent Analytics");
  } finally {
    if (savedBase === undefined) delete process.env.LUMEN_API_BASE_URL; else process.env.LUMEN_API_BASE_URL = savedBase;
    if (savedTok === undefined) delete process.env.LUMEN_INTERNAL_SERVICE_TOKEN; else process.env.LUMEN_INTERNAL_SERVICE_TOKEN = savedTok;
  }
});

test("the resolved email refuses to send for the wrong reasons, and says which", async () => {
  const savedEnv = {};
  const KEYS = ["LUMEN_API_BASE_URL", "SPARK_API_BASE_URL", "LUMEN_INTERNAL_SERVICE_TOKEN", "LUMEN_EMAIL_INTERNAL_TOKEN", "LUMEN_WALKTHROUGH_SEED_TOKEN", "WALKTHROUGH_SEED_INTERNAL_TOKEN"];
  for (const k of KEYS) savedEnv[k] = process.env[k];
  try {
    for (const k of KEYS) delete process.env[k];
    process.env.LUMEN_API_BASE_URL = "https://lumen.example.com";
    process.env.LUMEN_INTERNAL_SERVICE_TOKEN = "int-tok";
    let called = false;
    const spy = async () => { called = true; return { ok: true, status: 200, text: async () => "" }; };
    const base = { siteRequestId: "abc", tenantId: TENANT, siteId: SITE, status: "done", requestedByEmail: "owner@example.com" };

    assert.deepEqual(
      await sendSiteRequestResolvedEmail({ request: { ...base, requestedByEmail: null } }, spy),
      { ok: false, error: "missing_recipient_email" });
    assert.deepEqual(
      await sendSiteRequestResolvedEmail({ request: { ...base, status: "in_progress" } }, spy),
      { ok: false, error: "status_not_resolved" }, "moving to in_progress is not a resolution");
    assert.equal(called, false, "no send on any of those paths");

    delete process.env.LUMEN_API_BASE_URL;
    assert.deepEqual(await sendSiteRequestResolvedEmail({ request: base }, spy), { ok: false, error: "not_configured" });
    assert.equal(called, false);

    // A LUMEN failure is reported, never swallowed into a success.
    process.env.LUMEN_API_BASE_URL = "https://lumen.example.com";
    const bad = await sendSiteRequestResolvedEmail({ request: base }, async () => ({ ok: false, status: 500, text: async () => "boom" }));
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 500);
    const threw = await sendSiteRequestResolvedEmail({ request: base }, async () => { throw new Error("dns"); });
    assert.deepEqual(threw, { ok: false, error: "dns" }, "a throw is caught and reported, not raised at the route");
  } finally {
    for (const k of KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  }
});

test("summarizeRequest gives the template a short one-line 'Request: ...'", () => {
  assert.equal(summarizeRequest({ notes: "  Change the\n  phone number  " }), "Change the phone number");
  assert.equal(summarizeRequest({ notes: "", requestType: "content_update" }), "content update");
  assert.equal(summarizeRequest({}), "your change request");
  assert.equal(summarizeRequest({ notes: "x".repeat(300) }).length, 158, "long notes are trimmed with an ellipsis");
});

test("PATCH emails the client only when the status actually MOVED to done/declined", () => {
  const src = read("routes/admin/siteRequests.js");
  assert.match(src, /const movedToResolved = RESOLVED_STATUSES\.includes\(request\.status\)\s*&&\s*request\.previousStatus !== request\.status/,
    "re-saving 'done' to fix a typo must not send a second email");
  assert.match(src, /if \(movedToResolved\) \{/);
  assert.match(src, /sendSiteRequestResolvedEmail\(\{ request, \.\.\.inputs \}\)/);
  assert.match(src, /\.catch\(\(e\) => console\.error\("\[admin\/site-requests\] resolved email:/, "email failure never fails the PATCH");
  assert.match(src, /clientEmailQueued: movedToResolved/, "the founder UI can say whether the client was told");
});
