#!/usr/bin/env node
// DEV-ONLY migration applier: runs one db/migrations/NNN_*.sql against the
// LOCAL Docker SQL Server pinned in .env (SERVICES_SQL_SERVER / SQL_SERVER =
// localhost,1433), splitting on GO, and records it in db.schema_migrations
// (repo 'arion-api') so the pipeline runner reports it as applied. Refuses any
// non-local server. Prod/UAT migrations go through
// scripts/run-pipeline-migrations.js (pre-applied before the code push) —
// never through this. Mirrors LUMEN-API scripts/apply-migration-dev.cjs and
// oliver-api scripts/apply-migrations-dev.cjs.
//   node scripts/apply-migration-dev.cjs 055_site_request.sql
require("dotenv/config");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sql = require("mssql");

(async () => {
  const name = process.argv[2];
  if (!name) { console.error("usage: apply-migration-dev.cjs <NNN_name.sql>"); process.exit(2); }
  const server = String(process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER || "");
  if (!/^(localhost|127\.0\.0\.1)/i.test(server)) { console.error(`refusing: SERVICES_SQL_SERVER/SQL_SERVER=${server} is not local`); process.exit(3); }
  const database = process.env.SERVICES_SQL_DATABASE || "iadm_services";
  const file = path.join(__dirname, "..", "db", "migrations", path.basename(name));
  const text = fs.readFileSync(file, "utf8");
  const pool = await sql.connect({
    server: server.split(",")[0], port: parseInt(server.split(",")[1] || "1433", 10),
    database, user: process.env.SQL_USER, password: process.env.SQL_PASSWORD,
    options: { encrypt: false, trustServerCertificate: true },
  });
  const who = (await pool.request().query("SELECT DB_NAME() AS db, @@SERVERNAME AS srv, SUSER_SNAME() AS login")).recordset[0];
  console.log(`target: ${server}/${who.db} (srv=${who.srv} login=${who.login})  file: ${path.basename(file)}`);
  let n = 0;
  for (const batch of text.split(/^\s*GO\s*$/gim).map((b) => b.trim()).filter(Boolean)) {
    await pool.request().batch(batch);
    n++;
  }
  console.log(`applied ${n} batch(es)`);

  // Record it the way run-pipeline-migrations.js does, if the ledger exists here.
  const cols = new Set((await pool.request().query(
    `SELECT COLUMN_NAME c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='db' AND TABLE_NAME='schema_migrations'`
  )).recordset.map((r) => r.c.toLowerCase()));
  if (cols.size) {
    const id = path.basename(file).replace(/\.sql$/i, "");
    const exists = await pool.request().input("repo", sql.NVarChar(64), "arion-api").input("id", sql.NVarChar(128), id)
      .query(`SELECT 1 AS x FROM db.schema_migrations WHERE repo=@repo AND migration_id=@id`);
    if (exists.recordset.length) {
      console.log(`already recorded in db.schema_migrations (${id})`);
    } else {
      const fields = { repo: "arion-api", migration_id: id };
      if (cols.has("filename")) fields.filename = path.basename(file);
      if (cols.has("sha256")) fields.sha256 = crypto.createHash("sha256").update(text).digest("hex");
      if (cols.has("checksum")) fields.checksum = crypto.createHash("sha256").update(text).digest("hex").slice(0, 64);
      if (cols.has("applied_by")) fields.applied_by = "apply-migration-dev";
      const names = Object.keys(fields);
      const req = pool.request();
      names.forEach((k) => req.input(k, sql.NVarChar, String(fields[k])));
      await req.query(`INSERT INTO db.schema_migrations (${names.join(", ")}) VALUES (${names.map((k) => "@" + k).join(", ")})`);
      console.log(`recorded in db.schema_migrations (${id})`);
    }
  }
  await pool.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
