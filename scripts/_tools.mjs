#!/usr/bin/env node
/**
 * scripts/_tools.mjs — find the shared dev tooling and run one of its tools.
 *
 * Seams audit §9 / decision SEAM-9-A: the linter, the dev migration applier and
 * the schema-map refresher live ONCE, in a plain directory beside the repos
 * (`C:/dev/iadm/_tools/`), not once per repo and not as a published package.
 *
 * This file exists so `npm run lint:contracts` and `npm run migrate:dev` read
 * the same in all five backends even though the repos sit at two different
 * depths (`C:/dev/iadm/<repo>` and `C:/dev/<repo>`) and every worktree adds a
 * suffix. It walks up from the repo root looking for `_tools/` and for
 * `iadm/_tools/`, so a worktree anywhere under `C:/dev` finds it, and when it
 * does not it says exactly what is missing instead of printing MODULE_NOT_FOUND.
 *
 *   node scripts/_tools.mjs lint-sql-contracts .
 *   node scripts/_tools.mjs apply-migration-dev --all --dry
 *
 * BYTE-IDENTICAL COPY. The same file is in oliver-api, platform-api, LUMEN-API,
 * arion-api and iadm-webhooks; each repo's suite asserts it has not drifted.
 * It is copied rather than shared because it is the thing that finds the shared
 * directory — it cannot live inside what it is looking for.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where `_tools/` is, or null. Checked in the order a repo would look. */
export function findToolsDir(startDir = REPO_ROOT, exists = fs.existsSync) {
  let dir = path.resolve(startDir);
  for (let hops = 0; hops < 8; hops++) {
    for (const candidate of [path.join(dir, "_tools"), path.join(dir, "iadm", "_tools")]) {
      if (exists(path.join(candidate, "apply-migration-dev.mjs"))) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const MISSING = (start) =>
  `shared dev tooling not found.\n` +
  `Looked for a "_tools" directory containing apply-migration-dev.mjs, walking up from:\n` +
  `  ${start}\n` +
  `It should be at C:/dev/iadm/_tools (seams audit §9, decision SEAM-9-A).\n` +
  `Nothing installs it — it is a plain directory beside the repos, no package and no build.`;

function main() {
  const [tool, ...rest] = process.argv.slice(2);
  if (!tool) { console.error("usage: node scripts/_tools.mjs <tool-name> [args...]"); process.exit(2); }
  const toolsDir = findToolsDir();
  if (!toolsDir) { console.error(MISSING(REPO_ROOT)); process.exit(2); }
  const entry = path.join(toolsDir, tool.endsWith(".mjs") ? tool : `${tool}.mjs`);
  if (!fs.existsSync(entry)) { console.error(`no such tool: ${entry}`); process.exit(2); }
  const r = spawnSync(process.execPath, [entry, ...rest], { stdio: "inherit", cwd: REPO_ROOT });
  process.exit(r.status === null ? 1 : r.status);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
