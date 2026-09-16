#!/usr/bin/env node
// scripts/dev/pool-recovery-mutation-check.mjs
//
// A green test proves nothing until you have made it fail on purpose
// ([feedback_mutation_test_your_guards]). This breaks the ELOGIN pool recovery
// one named way at a time and asserts test/pool-recovery.test.mjs goes RED for
// each, then restores the file byte-for-byte.
//
// IT REFUSES TO RUN A MUTATION WHOSE PATTERN DOES NOT MATCH EXACTLY ONCE. The
// first run of the oliver-api version of this script silently no-opped two
// mutations and reported them "red" for the wrong reason (that repo is CRLF,
// [feedback_bash_heredoc_backslashes]); a mutation that changes nothing is a
// green check with no meaning, so it is a hard error here.
//
//   node scripts/dev/pool-recovery-mutation-check.mjs
//
// Read-only on anything but the files it names, and it always restores them —
// including on Ctrl-C.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const TEST = "test/pool-recovery.test.mjs";

const MUTATIONS = [
  {
    id: "M1",
    what: "remove the retry entirely — a refused login is just thrown",
    file: "db/poolRecovery.js",
    find: "if (!isLoginFailure(err)) throw err;    // a timeout is not a bad login",
    replace: "throw err;",
  },
  {
    id: "M2",
    what: "retry EVERY error, not only a refused login",
    file: "db/poolRecovery.js",
    find: "if (!isLoginFailure(err)) throw err;    // a timeout is not a bad login",
    replace: "if (false) throw err;",
  },
  {
    id: "M3",
    what: "swallow the second failure and answer success",
    file: "db/poolRecovery.js",
    find: 'loud("retry-failed-after-rebuild", secondError);',
    replace: 'loud("retry-failed-after-rebuild", secondError); return undefined;',
  },
  {
    id: "M4",
    what: "remove the 30-second bound — a broken identity becomes a token storm",
    file: "db/poolRecovery.js",
    find: 'if (lastRebuildAt && at - lastRebuildAt < rebuildMinIntervalMs()) return "refused";',
    replace: 'if (false) return "refused";',
  },
  {
    id: "M5",
    what: "memoise the credential, so every retry reuses the token SQL just refused",
    file: "db/platformPool.js",
    find: "  return new DefaultAzureCredential();",
    replace: "  return (globalThis.__credMemo ||= new DefaultAzureCredential());",
  },
  {
    id: "M6",
    what: "drop the mssql pool's 'error' listener — the self-heal for direct callers",
    file: "db/servicesPool.js",
    find: 'pool.on("error", (err) => recovery.onPoolError(err));',
    replace: "/* no listener */;",
  },
  {
    id: "M7",
    what: "/health answers 200 while a database refuses every login",
    file: "routes/health.js",
    find: "return { status: healthy ? 200 : 503, body };",
    replace: "return { status: 200, body };",
  },
  {
    id: "M8",
    what: "the pool-error handler and the caller share ONE naive bound (the retry dies in prod, tests stay green)",
    file: "db/poolRecovery.js",
    find: 'if (generation !== seenGeneration) return "already-rebuilt";',
    replace: "/* naive bound */;",
  },
  {
    id: "M9",
    what: "the services pool stops rebuilding before its token expires",
    file: "db/servicesPool.js",
    find: "if (poolPromise && Date.now() < poolTokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {",
    replace: "if (poolPromise) {",
  },
  {
    id: "M10",
    what: "the section library goes back to a private pool of its own",
    file: "lib/websiteBuilder/sectionLibrary.js",
    find: "const getPool = getServicesPool;",
    replace: "const getPool = async () => new sql.ConnectionPool({}).connect();",
  },
  {
    id: "M11",
    what: "a module caches the pool at module scope, outliving every rebuild",
    file: "lib/coreTenants.js",
    find: "import { getPlatformPool } from '../db/platformPool.js';",
    replace: "import { getPlatformPool } from '../db/platformPool.js';\nconst pool = await getPlatformPool();",
  },
  {
    id: "M12",
    what: "the SQL token audience goes back to the doubled slash LUMEN hotfixed in production",
    file: "db/platformPool.js",
    find: 'export const SQL_SCOPE = "https://database.windows.net/.default";',
    replace: 'export const SQL_SCOPE = "https://database.windows.net//.default";',
  },
];

const originals = new Map();
function restoreAll() {
  for (const [file, bytes] of originals) writeFileSync(path.join(ROOT, file), bytes);
}
process.on("SIGINT", () => { restoreAll(); process.exit(130); });

function runTests() {
  const r = spawnSync(process.execPath, ["--test", TEST], { cwd: ROOT, encoding: "utf8" });
  const out = `${r.stdout || ""}${r.stderr || ""}`;
  const failed = Number((out.match(/^# fail (\d+)$/m) || [])[1] ?? -1);
  return { failed, ok: r.status === 0, out };
}

// The suite must be GREEN before any of this means anything.
const baseline = runTests();
if (!baseline.ok || baseline.failed !== 0) {
  console.error(`BASELINE IS NOT GREEN (fail=${baseline.failed}) — fix that first.\n`);
  console.error(baseline.out.slice(-3000));
  process.exit(2);
}
const passed = Number((baseline.out.match(/^# pass (\d+)$/m) || [])[1] ?? 0);
console.log(`baseline: ${passed} passing, 0 failing\n`);

let bad = 0;
for (const m of MUTATIONS) {
  const abs = path.join(ROOT, m.file);
  const src = readFileSync(abs, "utf8");
  if (!originals.has(m.file)) originals.set(m.file, readFileSync(abs));

  // CR-tolerant: this repo is checked out CRLF (core.autocrlf=true) but files
  // written on the LF side of that conversion are LF on disk, so a multi-line
  // pattern has to be tried both ways or it silently finds nothing.
  let find = m.find;
  let replace = m.replace;
  if (!src.includes(find) && find.includes("\n")) {
    find = find.replace(/\n/g, "\r\n");
    replace = replace.replace(/\n/g, "\r\n");
  }

  const hits = src.split(find).length - 1;
  if (hits !== 1) {
    // A mutation that changes nothing "passes" for no reason at all.
    restoreAll();
    console.error(`${m.id} REFUSED: its pattern matched ${hits} times in ${m.file} (need exactly 1).`);
    console.error(`  pattern: ${JSON.stringify(find)}`);
    process.exit(3);
  }

  writeFileSync(abs, src.replace(find, replace));
  const r = runTests();
  writeFileSync(abs, originals.get(m.file));

  if (r.failed > 0) {
    console.log(`${m.id} RED  (${r.failed} failing) — ${m.what}`);
  } else {
    bad += 1;
    console.log(`${m.id} GREEN — NOT CAUGHT — ${m.what}`);
  }
}

restoreAll();
const after = runTests();
console.log(`\nrestored: ${after.ok ? "suite green again" : "SUITE STILL RED — investigate"}`);
if (bad || !after.ok) process.exit(1);
console.log(`all ${MUTATIONS.length} mutations caught`);
