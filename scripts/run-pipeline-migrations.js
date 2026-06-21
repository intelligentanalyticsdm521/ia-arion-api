/**
 * Pipeline migration runner.
 *
 * Runs in the Azure DevOps pipeline AFTER the app deploy step. Iterates
 * db/migrations/*.sql in numeric order, applies any that haven't already
 * been recorded in db.schema_migrations, and records each one after success.
 *
 * Auth:
 *   Uses AzureCliCredential. Must run inside an AzureCLI@2 task that has
 *   already done `az login` via the service connection. The service
 *   principal must be granted at least db_ddladmin on the target database.
 *
 * Modes:
 *   --dry-run    Print what would be applied, do not modify the database.
 *   --apply      Apply pending migrations, record each one.
 *
 *   The pipeline runs both: dry-run first (log only), then apply.
 *
 * Conventions:
 *   - Only files matching /^\d{3}_.+\.sql$/ are considered migrations.
 *   - Files are applied in lexicographic order (zero-padded numbering
 *     ensures this matches numeric order).
 *   - 000_schema_migrations.sql is treated as bootstrap-only and is NEVER
 *     applied by this runner — it must be applied manually once per
 *     environment. It IS still recorded in the registry on first dry-run
 *     so it shows up as "applied".
 *   - migration_id = filename without .sql extension (e.g. "027_foo").
 *   - Scoped by REPO env var so each repo manages its own sequence.
 *
 * Exit codes:
 *   0  success (dry-run or apply)
 *   1  fatal error (auth, connection, unhandled exception)
 *   2  a migration batch failed (apply mode)
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "..", "db", "migrations");
const REPO = process.env.MIGRATION_REPO || "arion-api";
const SERVER = process.env.SQL_SERVER || "sql-iadm-prod-cus.database.windows.net";
const DATABASE = process.env.SQL_DATABASE || "iadm_services";
const BUILD_ID = process.env.BUILD_BUILDID || process.env.BUILD_ID || null;
const SCOPE = "https://database.windows.net/.default";

const MODE_DRY_RUN = process.argv.includes("--dry-run");
const MODE_APPLY = process.argv.includes("--apply");
if (!MODE_DRY_RUN && !MODE_APPLY) {
  console.error("Usage: node scripts/run-pipeline-migrations.js (--dry-run | --apply)");
  process.exit(1);
}

const MIGRATION_RE = /^(\d{3})_[a-z0-9_\-]+\.sql$/i;
const BOOTSTRAP_FILE = "000_schema_migrations.sql";

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

async function listMigrationFiles() {
  const entries = await fs.readdir(MIGRATIONS_DIR);
  return entries
    .filter((f) => MIGRATION_RE.test(f))
    .sort((a, b) => a.localeCompare(b));
}

async function getAppliedSet(pool) {
  // If db.schema_migrations doesn't exist yet, treat as empty applied set.
  // This lets a brand-new environment see "everything pending" on first run.
  const probe = await pool.request().query(`
    SELECT COUNT(*) AS c
    FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'db' AND t.name = 'schema_migrations'
  `);
  if (probe.recordset[0].c === 0) {
    console.warn("[migrations] db.schema_migrations does not exist yet.");
    console.warn("[migrations] Apply db/migrations/000_schema_migrations.sql manually first:");
    console.warn("[migrations]   node scripts/run-migration.js db/migrations/000_schema_migrations.sql");
    return null;
  }
  const r = await pool.request()
    .input("repo", sql.NVarChar(64), REPO)
    .query(`SELECT migration_id FROM db.schema_migrations WHERE repo = @repo`);
  return new Set(r.recordset.map((row) => row.migration_id));
}

async function applyBatch(pool, batch) {
  await pool.request().batch(batch);
}

async function applyMigration(pool, file) {
  const fullPath = path.join(MIGRATIONS_DIR, file);
  const text = await fs.readFile(fullPath, "utf-8");
  const batches = text.split(/^\s*GO\s*$/gim).map((s) => s.trim()).filter(Boolean);
  const started = Date.now();
  for (let i = 0; i < batches.length; i++) {
    try {
      await applyBatch(pool, batches[i]);
    } catch (err) {
      err.batchNum = i + 1;
      throw err;
    }
  }
  const durationMs = Date.now() - started;
  const migrationId = file.replace(/\.sql$/i, "");
  await pool.request()
    .input("repo", sql.NVarChar(64), REPO)
    .input("migration_id", sql.NVarChar(128), migrationId)
    .input("filename", sql.NVarChar(256), file)
    .input("sha256", sql.Char(64), sha256(text))
    .input("build_id", sql.NVarChar(64), BUILD_ID)
    .input("duration_ms", sql.Int, durationMs)
    .input("applied_by", sql.NVarChar(128), "pipeline")
    .query(`
      INSERT INTO db.schema_migrations
        (repo, migration_id, filename, sha256, applied_by, build_id, duration_ms)
      VALUES
        (@repo, @migration_id, @filename, @sha256, @applied_by, @build_id, @duration_ms)
    `);
  return { migrationId, batchCount: batches.length, durationMs };
}

function printSummary(rows) {
  // rows: { file, status, durationMs?, note? }
  const w = {
    file: Math.max(4, ...rows.map((r) => r.file.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    duration: 10,
    note: Math.max(4, ...rows.map((r) => (r.note || "").length)),
  };
  const sep = "+" + "-".repeat(w.file + 2) + "+" + "-".repeat(w.status + 2) + "+" + "-".repeat(w.duration + 2) + "+" + "-".repeat(w.note + 2) + "+";
  console.log("\n" + sep);
  console.log("| " + "file".padEnd(w.file) + " | " + "status".padEnd(w.status) + " | " + "duration".padEnd(w.duration) + " | " + "note".padEnd(w.note) + " |");
  console.log(sep);
  for (const r of rows) {
    console.log(
      "| " + r.file.padEnd(w.file) +
      " | " + r.status.padEnd(w.status) +
      " | " + (r.durationMs != null ? (r.durationMs + " ms").padEnd(w.duration) : "".padEnd(w.duration)) +
      " | " + (r.note || "").padEnd(w.note) + " |"
    );
  }
  console.log(sep + "\n");
}

async function main() {
  const mode = MODE_APPLY ? "APPLY" : "DRY-RUN";
  console.log(`[migrations] mode=${mode} repo=${REPO} server=${SERVER} db=${DATABASE}`);

  const files = await listMigrationFiles();
  console.log(`[migrations] discovered ${files.length} migration file(s) in ${MIGRATIONS_DIR}`);

  const credential = new AzureCliCredential();
  const token = await credential.getToken(SCOPE);
  console.log(`[migrations] acquired AAD token (expires ${new Date(token.expiresOnTimestamp).toISOString()})`);

  const pool = await new sql.ConnectionPool({
    server: SERVER,
    database: DATABASE,
    options: { encrypt: true },
    connectionTimeout: 15000,
    requestTimeout: 120000,
    authentication: {
      type: "azure-active-directory-access-token",
      options: { token: token.token },
    },
  }).connect();
  console.log("[migrations] connected");

  try {
    const applied = await getAppliedSet(pool);
    if (applied === null) {
      // Bootstrap missing — fail loud in apply mode, but let dry-run report it.
      if (MODE_APPLY) {
        console.error("[migrations] FATAL: db.schema_migrations missing in APPLY mode.");
        process.exit(1);
      }
      console.log("[migrations] (dry-run) bootstrap table missing — would skip all until applied.");
      return;
    }

    const rows = [];
    const pending = [];
    for (const file of files) {
      const migrationId = file.replace(/\.sql$/i, "");
      if (file === BOOTSTRAP_FILE) {
        // Bootstrap is manual-only. Record it as applied if not already recorded,
        // so it shows up cleanly in future runs.
        if (!applied.has(migrationId)) {
          if (MODE_APPLY) {
            // Self-record the bootstrap (the table itself exists; this row was missed).
            const text = await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf-8");
            await pool.request()
              .input("repo", sql.NVarChar(64), REPO)
              .input("migration_id", sql.NVarChar(128), migrationId)
              .input("filename", sql.NVarChar(256), file)
              .input("sha256", sql.Char(64), sha256(text))
              .input("build_id", sql.NVarChar(64), BUILD_ID)
              .input("duration_ms", sql.Int, 0)
              .input("applied_by", sql.NVarChar(128), "pipeline-bootstrap-record")
              .query(`
                INSERT INTO db.schema_migrations
                  (repo, migration_id, filename, sha256, applied_by, build_id, duration_ms)
                VALUES
                  (@repo, @migration_id, @filename, @sha256, @applied_by, @build_id, @duration_ms)
              `);
            rows.push({ file, status: "RECORDED", durationMs: 0, note: "bootstrap self-record" });
            applied.add(migrationId);
          } else {
            rows.push({ file, status: "SKIP", note: "bootstrap (manual-only)" });
          }
        } else {
          rows.push({ file, status: "OK", note: "bootstrap (already recorded)" });
        }
        continue;
      }
      if (applied.has(migrationId)) {
        rows.push({ file, status: "OK", note: "already applied" });
        continue;
      }
      pending.push(file);
    }

    console.log(`[migrations] pending: ${pending.length} migration(s)`);
    for (const f of pending) console.log(`  - ${f}`);

    if (MODE_APPLY && pending.length > 0) {
      for (const file of pending) {
        process.stdout.write(`[migrations] applying ${file} ... `);
        try {
          const r = await applyMigration(pool, file);
          console.log(`OK (${r.batchCount} batch, ${r.durationMs} ms)`);
          rows.push({ file, status: "APPLIED", durationMs: r.durationMs, note: `${r.batchCount} batch` });
        } catch (err) {
          console.log("FAIL");
          console.error(`[migrations] ${file} FAILED on batch ${err.batchNum}: ${err.message}`);
          rows.push({ file, status: "FAILED", note: `batch ${err.batchNum}: ${err.message.slice(0, 60)}` });
          printSummary(rows);
          process.exit(2);
        }
      }
    } else if (MODE_DRY_RUN) {
      for (const file of pending) {
        rows.push({ file, status: "PENDING", note: "would apply" });
      }
    }

    printSummary(rows);
    console.log(`[migrations] mode=${mode} complete. pending=${pending.length} applied-this-run=${MODE_APPLY ? pending.length : 0}`);
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error("[migrations] fatal:", err);
  process.exit(1);
});
