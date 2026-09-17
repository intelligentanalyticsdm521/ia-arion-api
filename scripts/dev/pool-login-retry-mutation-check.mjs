// scripts/dev/pool-login-retry-mutation-check.mjs
//
// A green guard proves nothing until you make it fail on purpose
// (feedback_mutation_test_your_guards). Each mutation below reintroduces one
// piece of the 2026-09-16 / 2026-09-17 production incidents (the SQL server
// refusing ~85% of NEW managed-identity logins to iadm_services while already
// open pooled connections kept working), runs test/pool-login-retry.test.js, and
// asserts it goes RED — then restores the file byte for byte and re-runs to
// prove the restore worked.
//
//   node scripts/dev/pool-login-retry-mutation-check.mjs
//
// A mutation whose pattern does not match is reported as a HARNESS failure, not
// skipped: a mutation that silently no-ops is a green run proving nothing.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST = "test/pool-login-retry.test.js";

const MUTATIONS = [
  {
    id: "M1",
    what: "no retry at all — the first refused login is the answer (the code that went down)",
    file: "db/poolRecovery.js",
    find: `      if (!isLoginFailure(err)) throw err;
      if (!firstError) firstError = err;`,
    replace: `      throw err; // MUTANT M1
      if (!firstError) firstError = err;`,
  },
  {
    id: "M2",
    what: "retry EVERY error, not only a refused login",
    file: "db/poolRecovery.js",
    find: `      if (!isLoginFailure(err)) throw err;
      if (!firstError) firstError = err;`,
    replace: `      if (false) throw err; // MUTANT M2
      if (!firstError) firstError = err;`,
  },
  {
    id: "M3",
    what: "throw the LAST error instead of the original",
    file: "db/poolRecovery.js",
    find: `        throw firstError;   // the ORIGINAL error, never a swallowed one`,
    replace: `        throw err; // MUTANT M3`,
  },
  {
    id: "M4",
    what: "never take a new credential on retry",
    file: "db/poolRecovery.js",
    find: `    const wantsFresh = attempt >= freshCredentialFromAttempt;`,
    replace: `    const wantsFresh = false; // MUTANT M4`,
  },
  {
    id: "M5",
    what: "remove the 30s bound on fetching a new token (IMDS storm)",
    file: "db/poolRecovery.js",
    find: `      if (lastAt && at - lastAt < freshCredentialMinIntervalMs()) return false;`,
    replace: `      if (false) return false; // MUTANT M5`,
  },
  {
    id: "M6",
    what: "leave mssql's propagateCreateError:true — a query's first refused login is final",
    file: "db/poolRecovery.js",
    find: `    propagateCreateError: false,`,
    replace: `    propagateCreateError: true, // MUTANT M6`,
  },
  {
    id: "M7",
    what: "stop passing the tarn retry options to the services pool",
    file: "db/servicesPool.js",
    find: `      ...tarnLoginRetryOptions(),`,
    replace: `      // MUTANT M7: options not passed`,
  },
  {
    id: "M8",
    what: "KEEP-ALIVE: pool min back to 0 — every quiet minute forces a fresh login",
    file: "db/poolRecovery.js",
    find: `    min: envNum("SQL_POOL_MIN", 2, 0, 10),`,
    replace: `    min: 0, // MUTANT M8`,
  },
  {
    id: "M9",
    what: "KEEP-ALIVE: idle window back to 30s — 30 quiet seconds drain the pool",
    file: "db/poolRecovery.js",
    find: `    idleTimeoutMillis: envNum("SQL_POOL_IDLE_MS", 600_000, 30_000, 3_600_000),`,
    replace: `    idleTimeoutMillis: 30_000, // MUTANT M9`,
  },
  {
    id: "M10",
    what: "the env clamps are gone — a typo'd SQL_POOL_MIN/IDLE is taken at face value",
    file: "db/poolRecovery.js",
    find: `  return Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback;`,
    replace: `  return Number.isFinite(raw) ? raw : fallback; // MUTANT M10`,
  },
  {
    id: "M11",
    what: "stop spreading the keep-alive sizing into the platform pool's mssql config",
    file: "db/platformPool.js",
    find: `      ...poolSizingOptions(),`,
    replace: `      // MUTANT M11: keep-alive sizing not passed`,
  },
  {
    id: "M12",
    what: "LAZY SWAP: close the live pool BEFORE its replacement connects (the hourly outage)",
    file: "db/poolRecovery.js",
    find: `    const started = connect().then(({ pool, tokenExpiresAt }) => {`,
    replace: `    if (current) current.then((p) => p.close().catch(() => {})).catch(() => {}); // MUTANT M12
    const started = connect().then(({ pool, tokenExpiresAt }) => {`,
  },
  {
    id: "M13",
    what: "LAZY SWAP: a failed rebuild throws instead of handing back the live pool",
    file: "db/poolRecovery.js",
    find: `      if (!previous) throw err;      // cold start: nothing to fall back to`,
    replace: `      throw err; // MUTANT M13`,
  },
  {
    id: "M14",
    what: "no bound on re-attempting a failed rebuild — every request retries the refused login",
    file: "db/poolRecovery.js",
    find: `    if (current && now() < blockedUntil) return current;`,
    replace: `    if (false) return current; // MUTANT M14`,
  },
  {
    id: "M15",
    what: "the services pool's 'error' listener tears the pool down, draining live connections",
    file: "db/servicesPool.js",
    find: `  pool.on("error", (err) => {
    console.error(`,
    replace: `  pool.on("error", (err) => {
    holder.invalidate(); // MUTANT M15
    console.error(`,
  },
  {
    id: "M15b",
    what: "the section-library pool (arion's third, on iadm_services) loses the keep-alive sizing",
    file: "lib/websiteBuilder/sectionLibrary.js",
    find: `          ...poolSizingOptions(),`,
    replace: `          // MUTANT M15b: keep-alive sizing not passed`,
  },
  {
    id: "M15c",
    what: "the section-library retry keeps the cached credential — it re-presents the refused token",
    file: "lib/websiteBuilder/sectionLibrary.js",
    find: `      if (freshCredential) _credential = null;`,
    replace: `      // MUTANT M15c: cached credential kept`,
  },
  {
    id: "M16",
    what: "/health answers 200 while a database refuses every login",
    file: "routes/health.js",
    find: `  return { status: healthy ? 200 : 503, body };`,
    replace: `  return { status: 200, body }; // MUTANT M16`,
  },
  {
    id: "M17",
    what: "/health reports the failing database with no message (the null it used to report)",
    file: "routes/health.js",
    find: `    ...(platform.ok ? {} : { platformDbCode: platform.code, platformDbError: platform.message }),`,
    replace: `    ...(platform.ok ? {} : { platformDbCode: platform.code, platformDbError: null }), // MUTANT M17`,
  },
];

function runTests() {
  try {
    const out = execFileSync("node", ["--test", TEST], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { fail: Number(/^# fail (\d+)$/m.exec(out)?.[1] ?? -1), pass: Number(/^# pass (\d+)$/m.exec(out)?.[1] ?? -1) };
  } catch (e) {
    const out = String(e.stdout || "") + String(e.stderr || "");
    return { fail: Number(/^# fail (\d+)$/m.exec(out)?.[1] ?? -1), pass: Number(/^# pass (\d+)$/m.exec(out)?.[1] ?? -1) };
  }
}

const base = runTests();
console.log(`BASELINE pass=${base.pass} fail=${base.fail}`);
if (base.fail !== 0) { console.error("baseline is not green — stopping"); process.exit(1); }

for (const m of MUTATIONS) {
  const full = path.join(ROOT, m.file);
  const original = readFileSync(full, "utf8");
  // This repo is CRLF (core.autocrlf=true). Match on a normalised copy and put
  // the file's own endings back, or every multi-line mutation silently no-ops.
  const wasCrlf = original.includes("\r\n");
  const norm = original.replace(/\r\n/g, "\n");
  const hits = norm.split(m.find).length - 1;
  if (hits !== 1) {
    console.error(`${m.id} PATTERN MATCHED ${hits} TIMES in ${m.file} — the mutation would be a no-op. FIX THE HARNESS.`);
    process.exitCode = 1;
    continue;
  }
  const mutated = norm.replace(m.find, m.replace);
  writeFileSync(full, wasCrlf ? mutated.replace(/\n/g, "\r\n") : mutated, "utf8");
  const r = runTests();
  writeFileSync(full, original, "utf8");
  const verdict = r.fail > 0 ? "RED (good)" : "*** SURVIVED — the guard is worthless ***";
  console.log(`${m.id} ${verdict}  fail=${r.fail} pass=${r.pass}  — ${m.what}`);
  if (r.fail <= 0) process.exitCode = 1;
}

const after = runTests();
console.log(`RESTORED pass=${after.pass} fail=${after.fail}`);
