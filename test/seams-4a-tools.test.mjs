// SEAM-9-A — the shared dev tooling, and the applier that must not come back.
//
// Seams audit §9. `lint-sql-contracts.mjs` and `apply-migration-dev.mjs` now
// live ONCE, at C:/dev/iadm/_tools/, and every backend reaches them through a
// byte-identical `scripts/_tools.mjs`. Two things can quietly undo that:
//
//   1. `scripts/_tools.mjs` drifting in one repo. It is copied rather than
//      shared because it is the thing that FINDS the shared directory — it
//      cannot live inside what it is looking for — so the only thing keeping
//      five copies honest is each repo asserting the same sha256.
//
//   2. Somebody adding a new bespoke `_apply_migration_NNN.js`. That is not a
//      hypothetical: this repo had seven of them and every one hardcoded
//      `sql-iadm-prod-cus.database.windows.net` as its target, with no flag,
//      no token and no confirmation. oliver-api had 61. They are deleted, and
//      this test is what stops the 62nd.
//
// The guard below is on the PRESENCE of the shared wiring (the pinned hash,
// the named npm scripts), never on the absence of something bad.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHIM = path.join(REPO_ROOT, "scripts", "_tools.mjs");

// The one hash, shared by oliver-api, platform-api, LUMEN-API, arion-api and
// iadm-webhooks. If you change scripts/_tools.mjs you change it in all five and
// update this literal in all five — that is the whole point of pinning it.
const SHIM_SHA256 = "acb669ce587c0b4f643c914da214b900ff866716d9cae5bf6543545b2c991ecc";

test("scripts/_tools.mjs is the declared byte-identical copy", () => {
  const bytes = fs.readFileSync(SHIM);
  assert.equal(
    crypto.createHash("sha256").update(bytes).digest("hex"),
    SHIM_SHA256,
    "scripts/_tools.mjs has drifted from the copy the other four backends carry"
  );
  // .gitattributes pins this path to eol=lf. core.autocrlf is true on the dev
  // machines, so without that pin a fresh checkout would arrive with CRLF and
  // the hash above could never match anywhere.
  assert.ok(!bytes.includes(0x0d), "scripts/_tools.mjs must be LF, not CRLF");
});

test("npm run lint:contracts goes through the shared tooling", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["lint:contracts"], "node scripts/_tools.mjs lint-sql-contracts .");
});

test("npm run migrate:dev goes through the shared tooling", () => {
  // arion-api has db/migrations of its own, so it gets the applier script. The
  // two Azure Functions apps on this seam (iadm-webhooks, arion-func)
  // deliberately do not — they own no migrations, and a migrate:dev that
  // applies somebody else's is worse than no script at all.
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["migrate:dev"], "node scripts/_tools.mjs apply-migration-dev");
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "db", "migrations")));
});

test("no bespoke migration applier has reappeared in scripts/", () => {
  // Deleted here: apply-migration-dev.cjs (superseded by the shared applier),
  // _apply_migration.mjs, _apply_migration_012/040/041.js,
  // _apply_onboarding_migrations.js and _apply_106/107.cjs (each of the last
  // seven opened a connection straight to prod).
  //
  // KEPT ON PURPOSE, and why the pattern below does not match them:
  //   · run-pipeline-migrations.js — THE prod/UAT path, run by the DevOps
  //     pipeline. The shared applier is not a replacement for it.
  //   · run-migration.js — the documented bootstrap for
  //     db/migrations/000_schema_migrations.sql, which the pipeline runner
  //     never applies. It authenticates with AzureCliCredential; the shared
  //     applier only speaks SQL auth, so it does not cover this job.
  //   · _apply_047_dev_and_recopy_benchmarks.mjs — applies 047 to dev AND
  //     re-copies the prod benchmark set. The second half is not migration
  //     application and the shared applier does not do it.
  //   · _apply_argus_grants_prod.mjs — GRANTs, not a migration file.
  const offenders = [];
  const walk = (dir, rel = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(path.join(dir, entry.name), relPath); continue; }
      if (/^_?apply[-_]migration/i.test(entry.name)) offenders.push(relPath);
    }
  };
  walk(path.join(REPO_ROOT, "scripts"));
  assert.deepEqual(
    offenders,
    [],
    "a bespoke migration applier is back in scripts/. Use `npm run migrate:dev` " +
      "(C:/dev/iadm/_tools/apply-migration-dev.mjs) — it refuses any server it " +
      "cannot prove is loopback, which is exactly what these files never did."
  );
});
