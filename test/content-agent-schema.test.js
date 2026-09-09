// test/content-agent-schema.test.js
//
// Schema contract for migration 063 — the ARION Content & Social Agent tables.
// (Written as 053 in the working copy it was built in; 053 belongs to
// 053_site_tier_hygiene.sql on release/sept-a-2026. See the migration header.)
//
// WHY A SCHEMA TEST AT ALL
//
// The platform's two documented release failure modes are (1) code shipped whose
// data dependency was hand-inserted in dev and never migrated, and (2) a frontend
// shipped without its backend. Both are "the table wasn't there" wearing different
// hats. A migration that is only ever verified by eyeballing SSMS is exactly how
// dev drifted to 048 while the repo sat at 052.
//
// So this asserts the CONTRACT, not just existence: column types, nullability,
// the CHECK constraints that bound the status vocabularies, and the two indexes
// that carry real guarantees rather than mere performance.
//
// THE TWO THAT MATTER MOST
//
//   UX_content_agent_tenant_style_active — filtered unique on (tenant_id) WHERE
//   is_active = 1. This is scope 12.12's tenant isolation expressed in schema:
//   "load the active style profile for this tenant" can never return two rows to
//   be blended, and a client's learned voice cannot leak into another tenant's
//   content. Brandon's constraint was "only the tenant they are currently
//   assigned to", and prompt discipline is not an enforcement mechanism.
//
//   content_agent_code_proposal — asserted to exist with diff_text, because
//   scope 12.13 permits the agent to WRITE code proposals and forbids it from
//   applying them. The table is the queue that makes propose-only possible.
//
// RUNNER: node:test. arion-api has no Playwright and v0.1 has no UI (scope 16);
// Playwright enters scope with the v1.5 portal screen.
//
// Skips cleanly when no database is reachable so CI stays green without one.

import test from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import sql from "mssql";

const TABLES = [
  "content_agent_run_log",
  "content_agent_output",
  "content_agent_tenant_style",
  "content_agent_style_signal",
  "content_agent_code_proposal",
  "content_keyword_candidate",
];

let pool = null;
let reachable = false;
let skipReason = "";

async function connect() {
  const [host, port] = (process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER || "localhost").split(",");
  try {
    pool = await new sql.ConnectionPool({
      server: host,
      port: Number(port || 1433),
      database: process.env.SERVICES_SQL_DATABASE || "iadm_services",
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      options: { encrypt: false, trustServerCertificate: true },
      connectionTimeout: 8000,
requestTimeout: 20000,
    }).connect();
    reachable = true;
  } catch (err) {
    skipReason = `no database reachable (${err.message})`;
  }
}

await connect();

// Guard: this suite only ever READS, but say out loud which database it read,
// because "I verified it" against the wrong server has burned this project before.
test("reports which database it verified against", async (t) => {
  if (!reachable) return t.skip(skipReason);
  const r = await pool.request().query("SELECT DB_NAME() db, @@SERVERNAME srv, SUSER_SNAME() login");
  const { db, srv, login } = r.recordset[0];
  console.log(`    [schema-contract] db=${db} server=${srv} login=${login}`);
  assert.equal(db, "iadm_services", "these tables live in iadm_services");
});

test("all six content-agent tables exist in the arion schema", async (t) => {
  if (!reachable) return t.skip(skipReason);
  const r = await pool.request().query(`
    SELECT t.name FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
     WHERE s.name = 'arion' AND t.name IN (${TABLES.map((n) => `'${n}'`).join(",")})`);
  const found = r.recordset.map((x) => x.name).sort();
  assert.deepEqual(found, [...TABLES].sort(), `missing: ${TABLES.filter((n) => !found.includes(n))}`);
});

test("every table is tenant-scoped — tenant_id UNIQUEIDENTIFIER NOT NULL", async (t) => {
  if (!reachable) return t.skip(skipReason);
  // The platform's absolute isolation rule. A nullable tenant_id would let a row
  // exist that belongs to nobody, which in a per-tenant product means a row that
  // every tenant's query might match.
  for (const table of TABLES) {
    const r = await pool.request().query(`
      SELECT ty.name tp, c.is_nullable nu
        FROM sys.columns c
        JOIN sys.tables t  ON t.object_id = c.object_id
        JOIN sys.schemas s ON s.schema_id = t.schema_id
        JOIN sys.types ty  ON ty.user_type_id = c.user_type_id
       WHERE s.name = 'arion' AND t.name = '${table}' AND c.name = 'tenant_id'`);
    assert.equal(r.recordset.length, 1, `${table}.tenant_id missing`);
    assert.equal(r.recordset[0].tp, "uniqueidentifier", `${table}.tenant_id wrong type`);
    assert.equal(r.recordset[0].nu, false, `${table}.tenant_id must be NOT NULL`);
  }
});

test("cost is DECIMAL(10,6) USD, not integer cents", async (t) => {
  if (!reachable) return t.skip(skipReason);
  // AC7 caps the whole deployment at $10/month over ~30 units, so per-unit cost
  // is around $0.05. Integer cents rounds every row before the aggregate that is
  // actually being measured. Matches lumen.ai_call_audit.cost_basis_usd.
  const r = await pool.request().query(`
    SELECT ty.name tp, c.precision pr, c.scale sc
      FROM sys.columns c
      JOIN sys.tables t  ON t.object_id = c.object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.types ty  ON ty.user_type_id = c.user_type_id
     WHERE s.name = 'arion' AND t.name = 'content_agent_run_log' AND c.name = 'cost_usd'`);
  assert.equal(r.recordset.length, 1, "content_agent_run_log.cost_usd missing");
  assert.equal(r.recordset[0].tp, "decimal");
  assert.equal(r.recordset[0].pr, 10);
  assert.equal(r.recordset[0].sc, 6);
});

test("run status vocabulary is constrained, and 'escalated' is one of them", async (t) => {
  if (!reachable) return t.skip(skipReason);
  // AC2/AC6: an escalated run is a first-class terminal state, not a failure.
  // If the CHECK is missing, a typo'd status silently creates a state no query
  // filters on — a run that is neither pending nor done and alerts on nothing.
  const r = await pool.request().query(`
    SELECT cc.definition
      FROM sys.check_constraints cc
      JOIN sys.tables t  ON t.object_id = cc.parent_object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
     WHERE s.name = 'arion' AND t.name = 'content_agent_run_log' AND cc.name = 'CK_content_agent_run_log_status'`);
  assert.equal(r.recordset.length, 1, "CK_content_agent_run_log_status missing");
  const def = r.recordset[0].definition;
  for (const v of ["pending", "running", "completed", "failed", "escalated"]) {
    assert.ok(def.includes(v), `status CHECK does not allow '${v}'`);
  }
});

test("review status vocabulary is constrained on drafted output", async (t) => {
  if (!reachable) return t.skip(skipReason);
  const r = await pool.request().query(`
    SELECT cc.definition
      FROM sys.check_constraints cc
      JOIN sys.tables t  ON t.object_id = cc.parent_object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
     WHERE s.name = 'arion' AND t.name = 'content_agent_output' AND cc.name = 'CK_content_agent_output_rev'`);
  assert.equal(r.recordset.length, 1, "CK_content_agent_output_rev missing");
  for (const v of ["pending", "approved", "edited", "rejected", "escalated"]) {
    assert.ok(r.recordset[0].definition.includes(v), `review_status CHECK does not allow '${v}'`);
  }
});

test("the edited version is stored separately from the drafted one", async (t) => {
  if (!reachable) return t.skip(skipReason);
  // AC3 + edge case E2: the APPROVED version publishes, and the original is
  // retained for comparison. One mutated column would destroy the single most
  // informative input the style-learning loop has.
  const r = await pool.request().query(`
    SELECT c.name FROM sys.columns c
      JOIN sys.tables t  ON t.object_id = c.object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
     WHERE s.name = 'arion' AND t.name = 'content_agent_output'
       AND c.name IN ('body_markdown','body_markdown_final')`);
  assert.equal(r.recordset.length, 2, "both body_markdown and body_markdown_final must exist");
});

test("ISOLATION: at most one active style profile per tenant, enforced by index", async (t) => {
  if (!reachable) return t.skip(skipReason);
  // Scope 12.12, Brandon's hard constraint: "only the tenant they are currently
  // assigned to". A filtered unique index on (tenant_id) WHERE is_active = 1
  // makes "load this tenant's active profile" structurally single-valued, so no
  // query can blend two profiles and no client's voice can bleed into another's.
  const r = await pool.request().query(`
    SELECT i.name, i.is_unique, i.has_filter, i.filter_definition
      FROM sys.indexes i
      JOIN sys.tables t  ON t.object_id = i.object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
     WHERE s.name = 'arion' AND t.name = 'content_agent_tenant_style'
       AND i.name = 'UX_content_agent_tenant_style_active'`);
  assert.equal(r.recordset.length, 1, "UX_content_agent_tenant_style_active missing — isolation is unenforced");
  assert.equal(r.recordset[0].is_unique, true, "the active-profile index must be UNIQUE");
  assert.equal(r.recordset[0].has_filter, true, "must be filtered to is_active = 1");
});

test("ISOLATION holds against a real double-activation attempt", async (t) => {
  if (!reachable) return t.skip(skipReason);
  // Asserting the index exists is necessary but not sufficient — assert it BITES.
  // Two active profiles for one tenant is the exact shape of a voice leak, so it
  // must fail at the database, not merely be discouraged in application code.
  const tenant = "a0000001-0000-0000-0000-000000000001"; // Test Company A
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const ins = (v) => new sql.Request(tx)
      .input("t", sql.UniqueIdentifier, tenant)
      .input("v", sql.Int, v)
      .query("INSERT INTO arion.content_agent_tenant_style (tenant_id, profile_version, is_active) VALUES (@t, @v, 1)");
    // Clear this tenant's active profile INSIDE the transaction first. The test
    // is about the index biting on the SECOND insert; if a fixture (or another
    // builder's exercise) has already left an active profile here, the FIRST
    // insert fails and the test reports a red that is about the database's
    // contents rather than about the guard. The rollback below takes the delete
    // with it, so nothing survives either way. Found 2026-09-09.
    await new sql.Request(tx)
      .input("t", sql.UniqueIdentifier, tenant)
      .query("DELETE FROM arion.content_agent_tenant_style WHERE tenant_id = @t AND is_active = 1");
    await ins(9001);
    await assert.rejects(
      () => ins(9002),
      /duplicate key|UNIQUE KEY|UX_content_agent_tenant_style_active/i,
      "a second ACTIVE profile for the same tenant must be rejected by the database",
    );
  } finally {
    await tx.rollback(); // read-only by construction: nothing survives this test
  }
});

test("the code-proposal queue exists and holds a diff", async (t) => {
  if (!reachable) return t.skip(skipReason);
  // Scope 12.13. The agent may write proposals here; nothing reads diff_text and
  // executes it, by design. This test pins the queue's existence so the
  // propose-only contract has something concrete to stand on.
  const r = await pool.request().query(`
    SELECT c.name FROM sys.columns c
      JOIN sys.tables t  ON t.object_id = c.object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
     WHERE s.name = 'arion' AND t.name = 'content_agent_code_proposal'
       AND c.name IN ('diff_text','rationale','review_status','applied_commit')`);
  assert.equal(r.recordset.length, 4, "the code-proposal queue is missing required columns");
});

test("keyword dedup is guaranteed per tenant, not merely intended", async (t) => {
  if (!reachable) return t.skip(skipReason);
  // Decision Rule 21.1 / AC5. One row per keyword per tenant.
  const r = await pool.request().query(`
    SELECT i.is_unique FROM sys.indexes i
      JOIN sys.tables t  ON t.object_id = i.object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
     WHERE s.name = 'arion' AND t.name = 'content_keyword_candidate'
       AND i.name = 'UX_content_keyword_candidate_kw'`);
  assert.equal(r.recordset.length, 1, "UX_content_keyword_candidate_kw missing");
  assert.equal(r.recordset[0].is_unique, true);
});

test("output rows cannot outlive their run — FK to the audit spine", async (t) => {
  if (!reachable) return t.skip(skipReason);
  // AC6 says every run is logged. An output with no run row would be a content
  // unit with no cost, no tokens and no flags — invisible to the audit trail.
  const r = await pool.request().query(`
    SELECT fk.name FROM sys.foreign_keys fk
      JOIN sys.tables t  ON t.object_id = fk.parent_object_id
      JOIN sys.schemas s ON s.schema_id = t.schema_id
     WHERE s.name = 'arion' AND t.name = 'content_agent_output'
       AND fk.name = 'FK_content_agent_output_run'`);
  assert.equal(r.recordset.length, 1, "FK_content_agent_output_run missing");
});

test.after(async () => {
  if (pool) await pool.close();
});
