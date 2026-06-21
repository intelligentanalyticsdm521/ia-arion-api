/**
 * scripts/backfill-schema-migrations.mjs
 *
 * One-shot backfill of db.schema_migrations for ALL 3 backend repos that
 * write to iadm_services (arion-api, oliver-api, LUMEN-API).
 *
 * Why this exists:
 *   Batch 13 added a post-deploy migration runner (run-pipeline-migrations.js)
 *   to each of the 3 backend repos. That runner reads pending migrations from
 *   disk and applies any whose migration_id isn't already in
 *   db.schema_migrations. Until we backfill the already-applied historical
 *   migrations, the next push to any backend repo would trigger 100+ pending
 *   dry-run + apply attempts — most of which would fail re-running against
 *   schema objects that already exist.
 *
 *   This script records the already-applied migrations as applied so the
 *   runner can pick up only the truly new ones.
 *
 * Strategy — conservative-by-probe:
 *   For each migration file, we run a small fingerprint probe (e.g.
 *   "does table X exist?", "does column Y exist?"). If the probe returns
 *   truthy → mark as applied. If the probe returns falsy → leave pending
 *   so the pipeline runner picks it up.
 *
 *   For files we don't have an explicit probe for, we default to "applied"
 *   because the iadm_services DB has been live since early 2026 and Brandon
 *   has been hand-running every migration as part of each feature merge.
 *   This default is documented per repo in the DEFAULT_ASSUMPTION constant.
 *
 *   The 5 known-uncertain migrations from session memory get explicit probes:
 *     - arion-api 025 (site_block_draft.persisted_to_post_id column)
 *     - arion-api 026 (lumen.ai_cap_config table)
 *     - arion-api 027 (arion.business_location table)
 *     - oliver-api 092 (core.tenant_actas_log table)
 *     - LUMEN-API 046 (lumen.spark_task.description column)
 *
 *   The 000_schema_migrations.sql bootstrap is ALWAYS marked applied
 *   (the table itself must exist for this script to run at all).
 *
 * Usage:
 *   az login
 *   node scripts/backfill-schema-migrations.mjs              # dry-run (default)
 *   node scripts/backfill-schema-migrations.mjs --apply      # write to prod
 *
 * Idempotency:
 *   Every INSERT is guarded by NOT EXISTS on (repo, migration_id). Safe to
 *   re-run. The script also pre-fetches the existing applied set per repo
 *   and skips probes for already-recorded migrations.
 *
 * Output:
 *   Per-repo summary table: file, probe_result, action.
 *   Final cross-repo summary: per repo, how many were backfilled and how
 *   many remain pending for the pipeline runner.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER = process.env.SQL_SERVER || "sql-iadm-prod-cus.database.windows.net";
const DATABASE = process.env.SQL_DATABASE || "iadm_services";
const SCOPE = "https://database.windows.net/.default";

const MODE_APPLY = process.argv.includes("--apply");
const MODE = MODE_APPLY ? "APPLY" : "DRY-RUN";

const MIGRATION_RE = /^\d{3}_[a-z0-9_\-]+\.sql$/i;
const BOOTSTRAP_FILE = "000_schema_migrations.sql";

/**
 * Repo configuration:
 *   - repo: row key in db.schema_migrations
 *   - dir: absolute path to db/migrations on disk
 *   - defaultAssumption: 'applied' | 'pending' — what to do for files with
 *     no explicit probe. ALL 3 repos default to 'applied' per the conservative
 *     analysis (DB has been live; nearly all migrations have been hand-run).
 */
const REPOS = [
  {
    repo: "arion-api",
    dir: path.resolve("C:/dev/iadm/arion-api/db/migrations"),
    defaultAssumption: "applied",
  },
  {
    repo: "oliver-api",
    dir: path.resolve("C:/dev/oliver-api/db/migrations"),
    defaultAssumption: "applied",
  },
  {
    repo: "LUMEN-API",
    dir: path.resolve("C:/dev/iadm/LUMEN-API/db/migrations"),
    defaultAssumption: "applied",
  },
];

/**
 * Explicit per-file probes. Key format: `${repo}:${filename}`.
 *
 * Each probe is a SQL fragment that returns a single numeric column
 * indicating presence. We treat result > 0 as "migration was applied".
 *
 * These are the migrations Brandon flagged as possibly-not-yet-applied
 * in session memory. We probe rather than guess.
 */
const EXPLICIT_PROBES = {
  // arion-api 025: added persisted_to_post_id column on arion.site_block_draft
  "arion-api:025_site_block_draft_persisted.sql": `
    SELECT COUNT(*) AS c FROM sys.columns
    WHERE Name = N'persisted_to_post_id'
      AND Object_ID = OBJECT_ID(N'arion.site_block_draft')
  `,
  // arion-api 026: created lumen.ai_cap_config table
  "arion-api:026_ai_cap_config.sql": `
    SELECT COUNT(*) AS c FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'lumen' AND t.name = 'ai_cap_config'
  `,
  // arion-api 027: created arion.business_location table
  "arion-api:027_arion_business_location.sql": `
    SELECT COUNT(*) AS c FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'arion' AND t.name = 'business_location'
  `,
  // oliver-api 092: created core.tenant_actas_log table
  "oliver-api:092_tenant_actas_log.sql": `
    SELECT COUNT(*) AS c FROM sys.tables t
    JOIN sys.schemas s ON s.schema_id = t.schema_id
    WHERE s.name = 'core' AND t.name = 'tenant_actas_log'
  `,
  // LUMEN-API 046: added lumen.spark_task.description column
  "LUMEN-API:046_spark_task_description.sql": `
    SELECT COUNT(*) AS c FROM sys.columns
    WHERE Name = N'description'
      AND Object_ID = OBJECT_ID(N'lumen.spark_task')
  `,
};

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

async function listMigrationFiles(dir) {
  const entries = await fs.readdir(dir);
  return entries
    .filter((f) => f === BOOTSTRAP_FILE || MIGRATION_RE.test(f))
    .sort((a, b) => a.localeCompare(b));
}

async function getAppliedSet(pool, repo) {
  const r = await pool.request()
    .input("repo", sql.NVarChar(64), repo)
    .query(`SELECT migration_id FROM db.schema_migrations WHERE repo = @repo`);
  return new Set(r.recordset.map((row) => row.migration_id));
}

async function probeApplied(pool, repo, file) {
  const key = `${repo}:${file}`;
  const probe = EXPLICIT_PROBES[key];
  if (!probe) return null; // no explicit probe — caller falls back to default
  try {
    const r = await pool.request().query(probe);
    const c = r.recordset[0]?.c ?? 0;
    return c > 0;
  } catch (err) {
    // Probe itself blew up (e.g. parent table missing) — be conservative.
    console.warn(`[backfill] probe error for ${key}: ${err.message}`);
    return false;
  }
}

async function recordApplied(pool, repo, file, fileBytes) {
  const migrationId = file.replace(/\.sql$/i, "");
  // Use file mtime as applied_at so timeline is reasonable. Falls back to
  // SYSUTCDATETIME on insert if NULL.
  const fullPath = REPOS.find((r) => r.repo === repo).dir + path.sep + file;
  let appliedAt;
  try {
    const stat = await fs.stat(fullPath);
    appliedAt = stat.mtime;
  } catch {
    appliedAt = new Date();
  }
  await pool.request()
    .input("repo", sql.NVarChar(64), repo)
    .input("migration_id", sql.NVarChar(128), migrationId)
    .input("filename", sql.NVarChar(256), file)
    .input("sha256", sql.Char(64), sha256(fileBytes))
    .input("applied_by", sql.NVarChar(128), "backfill")
    .input("applied_at", sql.DateTime2, appliedAt)
    .query(`
      IF NOT EXISTS (
        SELECT 1 FROM db.schema_migrations
        WHERE repo = @repo AND migration_id = @migration_id
      )
      BEGIN
        INSERT INTO db.schema_migrations
          (repo, migration_id, filename, sha256, applied_by, applied_at)
        VALUES
          (@repo, @migration_id, @filename, @sha256, @applied_by, @applied_at);
      END
    `);
}

function printPerRepoTable(repo, rows) {
  const w = {
    file: Math.max(4, ...rows.map((r) => r.file.length)),
    probe: Math.max(5, ...rows.map((r) => (r.probe || "").length)),
    action: Math.max(6, ...rows.map((r) => r.action.length)),
    note: Math.max(4, ...rows.map((r) => (r.note || "").length)),
  };
  const sep = "+" + "-".repeat(w.file + 2) + "+" + "-".repeat(w.probe + 2) +
              "+" + "-".repeat(w.action + 2) + "+" + "-".repeat(w.note + 2) + "+";
  console.log(`\n=== ${repo} ===`);
  console.log(sep);
  console.log("| " + "file".padEnd(w.file) + " | " + "probe".padEnd(w.probe) +
              " | " + "action".padEnd(w.action) + " | " + "note".padEnd(w.note) + " |");
  console.log(sep);
  for (const r of rows) {
    console.log(
      "| " + r.file.padEnd(w.file) +
      " | " + (r.probe || "").padEnd(w.probe) +
      " | " + r.action.padEnd(w.action) +
      " | " + (r.note || "").padEnd(w.note) + " |"
    );
  }
  console.log(sep);
}

function printGrandSummary(perRepo) {
  console.log("\n=== GRAND SUMMARY ===");
  const w = { repo: 12, files: 5, backfilled: 11, pending: 7, already: 16 };
  const sep = "+" + "-".repeat(w.repo + 2) + "+" + "-".repeat(w.files + 2) +
              "+" + "-".repeat(w.backfilled + 2) + "+" + "-".repeat(w.pending + 2) +
              "+" + "-".repeat(w.already + 2) + "+";
  console.log(sep);
  console.log("| " + "repo".padEnd(w.repo) + " | " + "files".padEnd(w.files) +
              " | " + "backfilled".padEnd(w.backfilled) + " | " + "pending".padEnd(w.pending) +
              " | " + "already-recorded".padEnd(w.already) + " |");
  console.log(sep);
  let totalFiles = 0, totalBackfilled = 0, totalPending = 0, totalAlready = 0;
  for (const s of perRepo) {
    totalFiles += s.fileCount;
    totalBackfilled += s.backfilled;
    totalPending += s.pending;
    totalAlready += s.already;
    console.log(
      "| " + s.repo.padEnd(w.repo) +
      " | " + String(s.fileCount).padEnd(w.files) +
      " | " + String(s.backfilled).padEnd(w.backfilled) +
      " | " + String(s.pending).padEnd(w.pending) +
      " | " + String(s.already).padEnd(w.already) + " |"
    );
  }
  console.log(sep);
  console.log(
    "| " + "TOTAL".padEnd(w.repo) +
    " | " + String(totalFiles).padEnd(w.files) +
    " | " + String(totalBackfilled).padEnd(w.backfilled) +
    " | " + String(totalPending).padEnd(w.pending) +
    " | " + String(totalAlready).padEnd(w.already) + " |"
  );
  console.log(sep);
}

async function main() {
  console.log(`[backfill] mode=${MODE} server=${SERVER} db=${DATABASE}`);

  const credential = new AzureCliCredential();
  const token = await credential.getToken(SCOPE);
  console.log(`[backfill] acquired AAD token (expires ${new Date(token.expiresOnTimestamp).toISOString()})`);

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
  console.log("[backfill] connected");

  try {
    // Verify the bootstrap table exists.
    const probe = await pool.request().query(`
      SELECT COUNT(*) AS c
      FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
      WHERE s.name = 'db' AND t.name = 'schema_migrations'
    `);
    if (probe.recordset[0].c === 0) {
      console.error("[backfill] FATAL: db.schema_migrations does not exist.");
      console.error("[backfill] Apply 000_schema_migrations.sql first:");
      console.error("[backfill]   node scripts/run-migration.js db/migrations/000_schema_migrations.sql");
      process.exit(1);
    }

    const perRepoStats = [];

    for (const { repo, dir, defaultAssumption } of REPOS) {
      console.log(`\n[backfill] === ${repo} ===`);
      console.log(`[backfill] dir=${dir}`);

      let files;
      try {
        files = await listMigrationFiles(dir);
      } catch (err) {
        console.error(`[backfill] cannot read ${dir}: ${err.message}`);
        continue;
      }
      console.log(`[backfill] ${files.length} migration file(s)`);

      const applied = await getAppliedSet(pool, repo);
      console.log(`[backfill] ${applied.size} already-recorded in db.schema_migrations`);

      const rows = [];
      let backfilled = 0;
      let pending = 0;
      let already = 0;

      for (const file of files) {
        const migrationId = file.replace(/\.sql$/i, "");

        if (applied.has(migrationId)) {
          rows.push({ file, probe: "—", action: "SKIP", note: "already recorded" });
          already++;
          continue;
        }

        // The bootstrap migration is always-applied (the table exists =>
        // 000 was run). We always backfill its row.
        if (file === BOOTSTRAP_FILE) {
          if (MODE_APPLY) {
            const text = await fs.readFile(path.join(dir, file), "utf-8");
            await recordApplied(pool, repo, file, text);
          }
          rows.push({ file, probe: "bootstrap", action: "BACKFILL", note: "table exists => applied" });
          backfilled++;
          continue;
        }

        // Explicit probe?
        const probeResult = await probeApplied(pool, repo, file);
        let isApplied;
        let probeLabel;
        let note;

        if (probeResult === null) {
          // No explicit probe — use default assumption.
          isApplied = defaultAssumption === "applied";
          probeLabel = "default";
          note = `default=${defaultAssumption}`;
        } else if (probeResult === true) {
          isApplied = true;
          probeLabel = "explicit";
          note = "probe found object => applied";
        } else {
          isApplied = false;
          probeLabel = "explicit";
          note = "probe missing object => leave pending";
        }

        if (isApplied) {
          if (MODE_APPLY) {
            const text = await fs.readFile(path.join(dir, file), "utf-8");
            await recordApplied(pool, repo, file, text);
          }
          rows.push({ file, probe: probeLabel, action: "BACKFILL", note });
          backfilled++;
        } else {
          rows.push({ file, probe: probeLabel, action: "PENDING", note });
          pending++;
        }
      }

      printPerRepoTable(repo, rows);
      perRepoStats.push({ repo, fileCount: files.length, backfilled, pending, already });
    }

    printGrandSummary(perRepoStats);

    if (!MODE_APPLY) {
      console.log("\n[backfill] DRY-RUN complete. Re-run with --apply to write rows.");
    } else {
      console.log("\n[backfill] APPLY complete.");
    }
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
