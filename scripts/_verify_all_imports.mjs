// _verify_all_imports.mjs — load every route/lib file via Node's ESM resolver
// to surface ERR_MODULE_NOT_FOUND or any other import-time error BEFORE
// deploying. The pipeline succeeded yesterday but the deployed app crashed
// at startup with `Cannot find module .../lib/firePlatformEvent.js` — that
// kind of bug only manifests when index.js actually imports the route file.
//
// This script catches that class by trying to import every JS/MJS file in
// routes/ and lib/. Anything that throws at load time → FAIL.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const TARGET_DIRS = ["routes", "lib"];

const failures = [];
const passed = [];

async function tryLoad(absPath) {
  try {
    await import(pathToFileURL(absPath).href);
    passed.push(path.relative(ROOT, absPath));
  } catch (e) {
    failures.push({ file: path.relative(ROOT, absPath), error: e.message });
  }
}

async function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { await walk(p); continue; }
    if (!(f.name.endsWith(".js") || f.name.endsWith(".mjs"))) continue;
    await tryLoad(p);
  }
}

for (const d of TARGET_DIRS) {
  await walk(path.join(ROOT, d));
}

console.log(`\n=== Import scan: ${passed.length} OK · ${failures.length} BROKEN ===\n`);
if (failures.length) {
  for (const f of failures) {
    console.log(`✗ ${f.file}`);
    console.log(`    ${f.error.slice(0, 250)}`);
  }
  console.log();
  process.exit(1);
}
console.log("All files load cleanly. Safe to deploy.");
process.exit(0);
