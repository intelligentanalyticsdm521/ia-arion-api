// The production migration-ledger audit — READ-ONLY, and provably so.
//
// §6: `db.schema_migrations` on prod records LUMEN 041 and 044 as applied and
// neither table exists. Every deploy decision since has been made on a ledger
// nobody had ever checked. `scripts/_prod_ledger_audit.mjs` is the check.
//
// The most important assertion in this file is the FIRST one. A script that
// reads production is one thing; a script that could write to it is another,
// and the difference has to be something a reader can verify in a second
// rather than something they have to trust.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { objectsCreatedBy, droppedBy, columnDroppedBy, guardedAsOptional } from "../scripts/_prod_ledger_audit.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "scripts", "_prod_ledger_audit.mjs"), "utf8");

test("it cannot write to production: every statement it sends is a SELECT", () => {
  // Only the SQL it SENDS matters, so look at what is inside .query(`...`).
  const sent = [...SRC.matchAll(/\.query\(\s*`([\s\S]*?)`\s*\)/g)].map((m) => m[1]);
  assert.ok(sent.length >= 3, `expected the three probe queries, found ${sent.length}`);
  for (const q of sent) {
    assert.match(q.trim(), /^SELECT\b/i, `not a SELECT: ${q.trim().slice(0, 60)}`);
    assert.equal(
      /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|TRUNCATE|CREATE|EXEC|GRANT|REVOKE)\b/i.test(q),
      false,
      `a write verb reached a production statement: ${q.trim().slice(0, 80)}`,
    );
  }
});

test("it names the databases the estate actually uses", () => {
  // Auditing one of them reported seven core.* objects as missing that live in
  // the other. An object is present if it is in either.
  assert.match(SRC, /'iadm_services,iadm_platform'/);
});

test("it finds the objects a migration creates", () => {
  const sql = `
    IF OBJECT_ID('lumen.user_preferences', 'U') IS NULL
    BEGIN
      CREATE TABLE lumen.user_preferences (user_id UNIQUEIDENTIFIER NOT NULL);
    END
    GO
    CREATE VIEW lumen.v_thing AS SELECT 1 AS x;
    GO
    ALTER TABLE lumen.user_preferences ADD last_leads_inbox_visit_at DATETIME2 NULL;
    GO
    CREATE OR ALTER PROCEDURE lumen.sp_thing AS SELECT 1;`;
  const out = objectsCreatedBy(sql);
  assert.deepEqual(out.tables, ["lumen.user_preferences"]);
  assert.deepEqual(out.modules.sort(), ["lumen.sp_thing", "lumen.v_thing"]);
  assert.deepEqual(out.columns, ["lumen.user_preferences.last_leads_inbox_visit_at"]);
});

test("it ignores comments and temp tables", () => {
  const sql = `
    -- CREATE TABLE lumen.commented_out (x INT);
    /* CREATE TABLE lumen.also_commented (x INT); */
    CREATE TABLE #scratch (x INT);
    CREATE TABLE lumen.real_one (x INT);`;
  assert.deepEqual(objectsCreatedBy(sql).tables, ["lumen.real_one"]);
});

test("an ADD CONSTRAINT is not a column", () => {
  const sql = `ALTER TABLE lumen.thing ADD CONSTRAINT CK_thing CHECK (x > 0);`;
  assert.deepEqual(objectsCreatedBy(sql).columns, []);
});

test("a conditional is not a claim, and an idempotent create IS", () => {
  // oliver 117: "table may not exist in all envs" — guarded IS NOT NULL.
  const conditional = `IF OBJECT_ID('oliver.consulting_document') IS NOT NULL
      ALTER TABLE oliver.consulting_document ADD is_archived BIT NOT NULL;`;
  assert.equal(guardedAsOptional(conditional, "oliver.consulting_document.is_archived"), true);

  // LUMEN 041: the ordinary idempotent create. Its absence is a REAL finding,
  // and misreading this as conditional would hide the two rows §6 caught.
  const idempotent = `IF OBJECT_ID('lumen.user_preferences', 'U') IS NULL
    BEGIN CREATE TABLE lumen.user_preferences (x INT); END`;
  assert.equal(guardedAsOptional(idempotent, "lumen.user_preferences"), false);
});

test("an object a later migration drops is not a hole", () => {
  assert.equal(droppedBy("DROP TABLE IF EXISTS lumen.old_thing;", "lumen.old_thing"), true);
  assert.equal(droppedBy("SELECT * FROM lumen.old_thing;", "lumen.old_thing"), false);
  assert.equal(
    columnDroppedBy("ALTER TABLE lumen.thing DROP COLUMN gone;", "lumen.thing.gone"), true);
  assert.equal(
    columnDroppedBy("ALTER TABLE lumen.thing ADD gone INT;", "lumen.thing.gone"), false);
});

test("the run that produced the report is written down where the estate is described", () => {
  const report = path.join(ROOT, "..", "..", "claude code", "overnight-report", "PROD_LEDGER_AUDIT_2026-09-09.md");
  if (!fs.existsSync(report)) return; // the KB is not always beside a checkout
  const text = fs.readFileSync(report, "utf8");
  assert.match(text, /READ-ONLY/);
  assert.match(text, /041_leadgen_inbox_visit/, "the two rows §6 caught must still be in it");
  assert.match(text, /044_leadgen_worker_registry/);
});

test("importing it never opens a connection to production", () => {
  // A unit test that reads the extractor must not dial prod. `npm test`
  // reaching another process is the D-71 defect; `npm test` reaching PRODUCTION
  // is that defect with the stakes turned up.
  assert.match(SRC, /const invokedDirectly = process\.argv\[1\]/);
  assert.match(SRC, /if \(invokedDirectly\) \{[\s\S]{0,200}main\(\)/,
    "main() must be behind the direct-invocation gate, not at module scope");
});
