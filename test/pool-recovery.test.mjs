// test/pool-recovery.test.mjs — the app has to survive a token Azure SQL refuses.
//
// THE INCIDENT (2026-09-16, `oliver-prod-sql-login-failing`, P0, four hours):
// an App Service instance move left oliver-api's managed identity holding a
// token `iadm_services` rejected. Every NEW connection came back
//     ConnectionError: Login failed for user '<token-identified principal>'
// (tedious 'ELOGIN', server 18456) while connections already in the pool kept
// working — and the app NEVER RECOVERED ON ITS OWN. Three deploy restarts and an
// `az webapp restart` did not clear it; only a stop+start did.
//
// WHY: the pool modules rebuilt on exactly one condition —
// `Date.now() >= poolTokenExpiresAt - 5min`. A token REJECTED while its own
// expiresOnTimestamp still says valid is therefore trusted forever.
//
// arion-api's db/platformPool.js and db/servicesPool.js are that same file
// lineage. They were healthy that night only because the instance move hit
// oliver's instance. These tests drive the REAL helper (db/poolRecovery.js), the
// REAL pool modules with nothing injected, and the REAL health route functions.
// The fake pool is the FAILURE, not the fix: it throws mssql's own
// ConnectionError shape, so a test goes red the way production went red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Set BEFORE the pool modules are imported: they read the server name at module
// load, and dotenv never overwrites a key that is already present. With no
// server configured the real getXPool() throws its own "env var is required"
// error — which is how the tests below prove the real connect is wired up
// without needing a database.
process.env.SQL_SERVER = "";
process.env.SERVICES_SQL_SERVER = "";
process.env.PLATFORM_SQL_SERVER = "";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { isLoginFailure, createPoolRecovery, rebuildMinIntervalMs } = await import("../db/poolRecovery.js");

/* ── the errors production actually throws ────────────────────────────────── */

/** What tedious raises, wrapped the way mssql wraps it (ConnectionError(err)). */
function eloginError({ message = "Login failed for user '<token-identified principal>'." } = {}) {
  const inner = new Error(message);
  inner.code = "ELOGIN";
  inner.name = "ConnectionError";
  const outer = new Error(message);
  outer.code = "ELOGIN";
  outer.name = "ConnectionError";
  Object.defineProperty(outer, "originalError", { enumerable: true, value: inner });
  return outer;
}

/** A failure that is NOT a bad login and must never be retried here. */
function timeoutError() {
  const e = new Error("Failed to connect to sql-iadm-prod-cus.database.windows.net in 15000ms");
  e.code = "ETIMEOUT";
  return e;
}

/* ── 1. classification: PRESENCE of a login marker, never absence ─────────── */

test("isLoginFailure recognises every shape Azure SQL refuses a token in", () => {
  assert.equal(isLoginFailure(eloginError()), true, "tedious ELOGIN, mssql-wrapped");

  const bareCode = Object.assign(new Error("Login failed."), { code: "ELOGIN" });
  assert.equal(isLoginFailure(bareCode), true, "bare ELOGIN code");

  const numbered = Object.assign(new Error("some other wording"), { number: 18456 });
  assert.equal(isLoginFailure(numbered), true, "SQL Server error 18456");

  // The exact text prod logged for four hours, with no code on it at all.
  assert.equal(
    isLoginFailure(new Error("Login failed for user '<token-identified principal>'.")),
    true,
    "the server's own message, even with no code",
  );

  // Nested two deep (mssql wraps tedious, tarn wraps mssql).
  const deep = new Error("pool acquire failed");
  deep.cause = eloginError();
  assert.equal(isLoginFailure(deep), true, "wrapped one more time");
});

test("isLoginFailure refuses everything that a new token would not fix", () => {
  assert.equal(isLoginFailure(timeoutError()), false, "a connect timeout");
  assert.equal(isLoginFailure(Object.assign(new Error("socket hang up"), { code: "ESOCKET" })), false);
  assert.equal(isLoginFailure(Object.assign(new Error("deadlocked"), { number: 1205 })), false);
  assert.equal(isLoginFailure(Object.assign(new Error("String or binary data would be truncated"), { number: 2628 })), false);
  assert.equal(isLoginFailure(null), false);
  assert.equal(isLoginFailure(undefined), false);
  assert.equal(isLoginFailure("Login failed for user 'x'"), false, "a string is not an error object");
});

test("a self-referential error chain is bounded, not an infinite walk", () => {
  const a = new Error("outer"); const b = new Error("inner");
  Object.defineProperty(a, "originalError", { value: b });
  Object.defineProperty(b, "originalError", { value: a });
  assert.equal(isLoginFailure(a), false);   // and it returns at all
});

/* ── 2. the recovery itself ───────────────────────────────────────────────── */

/**
 * A harness around the REAL createPoolRecovery. `connect` and `discard` are the
 * pool module's two jobs, scripted; the recovery logic under test is untouched.
 */
function harness({ connectResults = [], clock = { t: 1_700_000_000_000 }, tokenExp = 1_700_000_003_600_000 } = {}) {
  const calls = { connect: 0, discard: 0, logs: [] };
  const recovery = createPoolRecovery({
    label: "services",
    connect: async () => {
      const r = connectResults[Math.min(calls.connect, connectResults.length - 1)];
      calls.connect += 1;
      if (r instanceof Error) throw r;
      return r ?? { id: calls.connect };
    },
    discard: () => { calls.discard += 1; },
    tokenExpiresAt: () => tokenExp,
    now: () => clock.t,
    log: (line) => calls.logs.push(line),
  });
  return { recovery, calls, clock };
}

test("a refused login at CONNECT is recovered once, and the work then succeeds", async () => {
  const h = harness({ connectResults: [eloginError(), { id: "fresh" }] });
  const out = await h.recovery.withPool(async (pool) => `ran on ${pool.id}`);

  assert.equal(out, "ran on fresh");
  assert.equal(h.calls.discard, 1, "the poisoned pool is discarded exactly once");
  assert.equal(h.calls.connect, 2, "rebuilt exactly once — no loop");
});

test("a refused login at QUERY time is recovered once, and the query then succeeds", async () => {
  const h = harness({ connectResults: [{ id: "a" }, { id: "b" }] });
  let attempts = 0;
  const out = await h.recovery.withPool(async (pool) => {
    attempts += 1;
    if (attempts === 1) throw eloginError();
    return pool.id;
  });

  assert.equal(out, "b", "the retry ran against the REBUILT pool, not the poisoned one");
  assert.equal(attempts, 2, "the operation is retried exactly once");
  assert.equal(h.calls.discard, 1);
});

test("the ONE loud line names the time, the pool and the token expiry that lied", async () => {
  const h = harness({ connectResults: [eloginError(), { id: "fresh" }] });
  await h.recovery.withPool(async () => "ok");

  assert.equal(h.calls.logs.length, 1, "exactly one line per event — not per query");
  const line = h.calls.logs[0];
  assert.match(line, /pool=services/, "which pool");
  assert.match(line, new RegExp(new Date(h.clock.t).toISOString()), "when");
  assert.match(line, /tokenExpiresOnTimestamp=1700000003600000/, "the expiry the pool still believed");
  assert.match(line, /outcome=recovered-after-rebuild/);
  assert.match(line, /Login failed for user/, "and the error itself");
});

test("when the retry fails too, the ORIGINAL error is thrown — never a fake success", async () => {
  const first = eloginError({ message: "Login failed for user '<token-identified principal>'." });
  const second = eloginError({ message: "Login failed AGAIN, different wording" });
  const h = harness({ connectResults: [first, second] });

  let thrown = null;
  let returned = "NOTHING-WAS-RETURNED";
  try {
    returned = await h.recovery.withPool(async () => "should never run");
  } catch (e) { thrown = e; }

  assert.equal(returned, "NOTHING-WAS-RETURNED", "no value is ever handed back on failure");
  assert.ok(thrown, "it throws");
  assert.equal(thrown, first, "and it throws the ORIGINAL error object");
  assert.equal(thrown.poolRecovery.pool, "services", "with the retry recorded on it for the log");
  assert.match(thrown.poolRecovery.retryError, /AGAIN/);
  assert.equal(h.calls.logs.filter((l) => /retry-failed-after-rebuild/.test(l)).length, 1);
});

test("a non-login failure is NOT retried and reaches the caller unchanged", async () => {
  const h = harness({ connectResults: [{ id: "a" }] });
  const boom = timeoutError();
  let attempts = 0;

  await assert.rejects(
    () => h.recovery.withPool(async () => { attempts += 1; throw boom; }),
    (e) => e === boom,
  );
  assert.equal(attempts, 1, "the operation ran once");
  assert.equal(h.calls.connect, 1, "no rebuild");
  assert.equal(h.calls.discard, 0, "and the pool was not thrown away");
  assert.equal(h.calls.logs.length, 0, "nothing loud about a plain timeout");
});

/* ── 3. the bound: a broken identity must not become a token storm ────────── */

test("at most one rebuild per 30s per pool; inside the window the error is thrown at once", async () => {
  assert.equal(rebuildMinIntervalMs(), 30_000, "the bound is 30 seconds");
  const clock = { t: 1_700_000_000_000 };
  const h = harness({ connectResults: [eloginError(), { id: "fresh" }], clock });

  await h.recovery.withPool(async () => "ok");            // spends the rebuild
  assert.equal(h.calls.discard, 1);

  clock.t += 29_000;                                      // still inside the window
  const stillBroken = attemptCounter(eloginError());
  await assert.rejects(() => h.recovery.withPool(stillBroken.fn), (e) => isLoginFailure(e));
  assert.equal(h.calls.discard, 1, "no second rebuild inside the window");
  assert.equal(stillBroken.attempts(), 1, "and no retry — it threw immediately");
  assert.ok(h.calls.logs.some((l) => /refused-rebuild-within-bound/.test(l)), "and said so");

  clock.t += 2_000;                                       // 31s after the first
  let n = 0;
  const out = await h.recovery.withPool(async () => { n += 1; if (n === 1) throw eloginError(); return "ok2"; });
  assert.equal(out, "ok2", "once the window has passed it recovers again");
  assert.equal(h.calls.discard, 2);
});

function attemptCounter(err) {
  let attempts = 0;
  return { fn: async () => { attempts += 1; throw err; }, attempts: () => attempts };
}

/* ── 4. the pool's own 'error' event — the self-heal for direct callers ───── */

test("an ELOGIN on the pool's error event poisons the pool so the NEXT caller gets a new one", () => {
  const h = harness({ connectResults: [{ id: "a" }] });
  assert.equal(h.recovery.onPoolError(eloginError()), true, "it poisons");
  assert.equal(h.calls.discard, 1, "the dead pool is dropped");
  assert.ok(h.calls.logs.some((l) => /poisoned-by-pool-error/.test(l)));

  assert.equal(h.recovery.onPoolError(eloginError()), false, "a second event inside the window does nothing");
  assert.equal(h.calls.discard, 1);
});

test("a pool error that is not a login failure is left alone", () => {
  const h = harness({ connectResults: [{ id: "a" }] });
  assert.equal(h.recovery.onPoolError(timeoutError()), false);
  assert.equal(h.calls.discard, 0, "a timeout must not throw the pool away");
  assert.equal(h.calls.logs.length, 0);
});

test("the pool-error handler and a waiting caller do not eat each other's one rebuild", async () => {
  // mssql emits 'error' on the pool BEFORE the caller's promise rejects
  // (base/connection-pool.js `acquire`). If both raced for the same 30s budget
  // the handler would win it and the caller would get NO retry — the fix would
  // be dead in production while every unit test stayed green.
  const h = harness({ connectResults: [{ id: "a" }, { id: "fresh" }] });
  let attempts = 0;
  const out = await h.recovery.withPool(async (pool) => {
    attempts += 1;
    if (attempts === 1) {
      const err = eloginError();
      h.recovery.onPoolError(err);      // the event lands first, as it does in mssql
      throw err;
    }
    return pool.id;
  });

  assert.equal(out, "fresh", "the caller still got its one retry, on the rebuilt pool");
  assert.equal(attempts, 2);
  assert.equal(h.calls.discard, 1, "and only ONE rebuild was spent between them");
});

/* ── 5. the real pool modules, with NOTHING injected ──────────────────────── */
// [feedback_no_stub_guard_on_seam_defaults]: every test above supplies connect
// and discard, so none of them proves the two modules wired the real ones up.

const servicesMod = await import("../db/servicesPool.js");
const platformMod = await import("../db/platformPool.js");

test("withServicesPool / withPlatformPool really call the module's own getXPool", async () => {
  // No server is configured (set at the top of this file), so the REAL
  // getXPool throws its own env-var error. Seeing that error prove-lands two
  // things at once: the wrapper resolves the pool through the real function,
  // and a non-login error is handed straight back to the caller.
  await assert.rejects(
    () => servicesMod.withServicesPool(async () => "must not run"),
    /SERVICES_SQL_SERVER \(or SQL_SERVER\) env var is required/,
  );
  await assert.rejects(
    () => platformMod.withPlatformPool(async () => "must not run"),
    /PLATFORM_SQL_SERVER \(or SQL_SERVER\) env var is required/,
  );
});

test("the credential is a FACTORY, so an ELOGIN retry cannot reuse the refused token", () => {
  // oliver-api caches one credential and drops it in every discard. This repo
  // builds a new one per rebuild instead — same property, no cache to reset.
  // Memoising getCredential() for performance would silently make every
  // recovery retry with the very token Azure SQL just refused.
  const a = platformMod.getCredential();
  const b = platformMod.getCredential();
  assert.ok(a && typeof a.getToken === "function", "it is a real @azure/identity credential");
  assert.notEqual(a, b, "every call constructs a NEW credential instance");

  const src = readFileSync(path.join(ROOT, "db", "platformPool.js"), "utf8");
  assert.equal(/let\s+cachedCredential|_credentialCache|if\s*\(!\s*cachedCredential\)/.test(src), false,
    "db/platformPool.js must not memoise the credential — the retry's whole point is a token that did "
    + "not come out of the cache SQL has already refused");
});

test("both pool modules use the ONE shared helper and hand the pool's error event to it", () => {
  for (const [file, label, invalidate] of [
    ["db/servicesPool.js", "services", "invalidateServicesPool"],
    ["db/platformPool.js", "platform", "invalidatePlatformPool"],
  ]) {
    const src = readFileSync(path.join(ROOT, file), "utf8");
    assert.match(src, /from "\.\/poolRecovery\.js"/, `${file} imports the shared helper`);
    assert.match(src, /createPoolRecovery\(\{/, `${file} builds its recovery from it`);
    assert.match(src, new RegExp(`label: "${label}"`), `${file} names itself in the log`);
    assert.match(src, /pool\.on\("error", \(err\) => recovery\.onPoolError\(err\)\)/,
      `${file} must hand the mssql pool's own 'error' event to the recovery — without it every call site `
      + "that holds the pool directly never poisons it and never recovers");
    assert.match(src, new RegExp(`discard: \\(\\) => ${invalidate}\\(\\)`), `${file} discards through the one primitive`);
    // No second copy of the mechanism.
    assert.equal(/function isLoginFailure/.test(src), false, `${file} must not define its own classifier`);
    assert.equal(/["']ELOGIN["']/.test(src), false,
      `${file} must not compare against the ELOGIN literal itself — classification lives in poolRecovery.js only`);
  }
});

test("the pool still rebuilds itself 5 minutes before the token expires", () => {
  // The routine half of the fix, which arion already had and must keep: the
  // recovery above is for a token that is refused EARLY, not for one that ages
  // out. Losing this would put the hourly 'token is expired' 500s back.
  for (const file of ["db/servicesPool.js", "db/platformPool.js"]) {
    const src = readFileSync(path.join(ROOT, file), "utf8");
    assert.match(src, /TOKEN_REFRESH_BUFFER_MS = 5 \* 60 \* 1000/, `${file} keeps the 5-minute buffer`);
    assert.match(src, /Date\.now\(\) < poolTokenExpiresAt - TOKEN_REFRESH_BUFFER_MS/,
      `${file} reuses the cached pool only while the token has life left`);
    assert.match(src, /poolTokenExpiresAt = token\.expiresOnTimestamp/, `${file} records the real expiry`);
  }
});

/* ── 6. the token audience — one scope, and it is the standard one ────────── */
// LUMEN shipped a production hotfix on 2026-09-16 for `//.default` (a doubled
// slash) in this exact call. arion has always had it right and has never had a
// test saying so.

test("the SQL token is requested for the standard audience, from ONE constant", () => {
  assert.equal(platformMod.SQL_SCOPE, "https://database.windows.net/.default",
    "the audience both pools hand to credential.getToken()");

  for (const [file, want] of [
    ["db/platformPool.js", /export const SQL_SCOPE = "https:\/\/database\.windows\.net\/\.default";/],
    ["db/servicesPool.js", /import \{ getCredential, SQL_SCOPE \} from "\.\/platformPool\.js";/],
  ]) {
    assert.match(readFileSync(path.join(ROOT, file), "utf8"), want, `${file}`);
  }
  // PRESENCE of the real call, not merely absence of the bad literal: a module
  // that lost its getToken() call entirely would otherwise pass.
  for (const file of ["db/platformPool.js", "db/servicesPool.js"]) {
    assert.match(readFileSync(path.join(ROOT, file), "utf8"), /credential\.getToken\(SQL_SCOPE\)/,
      `${file} takes the scope from the shared constant, never an inline literal`);
  }
});

test("no shipped module asks for the SQL token with a doubled slash", () => {
  // Checked against RAW source (not comment-stripped): the second slash of
  // `.net//.default` reads as the start of a line comment, so a stripper would
  // delete the very text this is looking for — that is how LUMEN's first draft
  // of this guard passed on mutated source [feedback_absence_based_guards_fail_open].
  const offenders = [];
  for (const f of shippedJsFiles()) {
    const src = readFileSync(f, "utf8");
    if (/getToken\(\s*["'`][^"'`]*database\.windows\.net\/\/\.default/.test(src)) {
      offenders.push(path.relative(ROOT, f));
    }
  }
  assert.deepEqual(offenders, [], "the doubled slash is the bug LUMEN hotfixed in production");
});

/* ── 7. /health says which database, with the code, and answers 503 ───────── */

const health = await import("../routes/health.js");

test("probe reports a refused login BY CODE, not just as a message", async () => {
  const bad = await health.probe(async () => { throw eloginError(); });
  assert.deepEqual(
    { ok: bad.ok, code: bad.code },
    { ok: false, code: "ELOGIN" },
    "'ELOGIN' is the difference between a token problem and a network problem",
  );
  assert.match(bad.message, /Login failed for user/);

  const timedOut = await health.probe(async () => { throw timeoutError(); });
  assert.equal(timedOut.code, "ETIMEOUT");

  const good = await health.probe(async (fn) => fn({ request: () => ({ query: async () => ({ recordset: [{ ok: 1 }] }) }) }));
  assert.deepEqual(good, { ok: true });
});

test("a failing database is NAMED with its code and answers 503, never a bare 200", () => {
  const down = health.buildHealthBody(
    { ok: false, code: "ELOGIN", message: "Login failed for user '<token-identified principal>'." },
    { ok: true },
  );
  assert.equal(down.status, 503, "503 — the dependency is unavailable");
  assert.equal(down.body.platformDb, "error");
  assert.equal(down.body.platformDbCode, "ELOGIN");
  assert.equal(down.body.servicesDb, "ok", "the healthy one is still reported, not hidden by the dead one");
  assert.match(down.body.details, /Login failed/, "the old `details` field still answers");
});

test("the OTHER database is still named when the first one is dead", () => {
  const down = health.buildHealthBody(
    { ok: true },
    { ok: false, code: "ETIMEOUT", message: "Failed to connect" },
  );
  assert.equal(down.status, 503);
  assert.equal(down.body.platformDb, "ok");
  assert.equal(down.body.servicesDb, "error");
  assert.equal(down.body.servicesDbCode, "ETIMEOUT");
  assert.equal("platformDbCode" in down.body, false, "no error fields for the healthy one");
});

test("a healthy pair is still a plain 200 with both databases named", () => {
  const up = health.buildHealthBody({ ok: true }, { ok: true });
  assert.equal(up.status, 200);
  assert.deepEqual(
    { s: up.body.status, p: up.body.platformDb, v: up.body.servicesDb },
    { s: "ok", p: "ok", v: "ok" },
  );
  assert.equal("platformDbCode" in up.body, false, "no error fields when there is no error");
  assert.equal("details" in up.body, false);
});

test("the route hands the real withXPool to probe and answers with buildHealthBody's status", () => {
  const src = readFileSync(path.join(ROOT, "routes", "health.js"), "utf8");
  assert.match(src, /probe\(withPlatformPool\)/);
  assert.match(src, /probe\(withServicesPool\)/);
  assert.match(src, /res\.status\(status\)\.json\(body\)/);
  assert.match(src, /Promise\.all/, "both databases are probed even when the first one is dead");
});

/* ── 7b. /health states WHICH COMMIT is deployed ──────────────────────────── */
// Same mechanism, same file and the same three key names as oliver-api and
// LUMEN-API: the pipeline writes build-info.json into the zip, the route reads
// it once at boot, and the body carries it on every path.

test("a healthy body carries the deployed build identity", () => {
  const up = health.buildHealthBody({ ok: true }, { ok: true });
  for (const k of ["commit", "builtAt", "buildId"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(up.body, k),
      `${k} must be present — a curl of /health is how a release is confirmed`);
  }
});

test("the build identity is stated even while both databases are down", () => {
  const down = health.buildHealthBody(
    { ok: false, code: "ELOGIN", message: "Login failed" },
    { ok: false, code: "ELOGIN", message: "Login failed" },
  );
  for (const k of ["commit", "builtAt", "buildId"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(down.body, k),
      `${k} must be present on the error path — on 2026-09-16 /health could not be used to confirm a deploy `
      + "because it dropped the build identity the moment SQL stopped answering");
  }
  assert.equal(down.body.servicesDbCode, "ELOGIN");
  assert.equal(down.body.status, "error");
});

test("a missing build-info.json reads as \"unknown\" — the loader never throws", () => {
  const stamp = path.join(ROOT, "build-info.json");
  const { body } = health.buildHealthBody({ ok: true }, { ok: true });
  if (existsSync(stamp)) {
    // If a stamp IS on disk it must be REPORTED, not quietly ignored.
    const onDisk = JSON.parse(readFileSync(stamp, "utf8"));
    assert.equal(body.commit, onDisk.commit, "the stamped commit is what /health states");
    assert.equal(body.buildId, String(onDisk.buildId));
  } else {
    // Local/dev: no stamp, so the body says so instead of blowing up at import.
    assert.deepEqual(
      { commit: body.commit, builtAt: body.builtAt, buildId: body.buildId },
      { commit: "unknown", builtAt: "unknown", buildId: "unknown" },
    );
  }
});

test("the pipeline actually writes the file the route reads", () => {
  // The route reading build-info.json is worth nothing if nothing stamps it —
  // that is the whole defect this fixes [feedback_assert_presence_not_just_absence].
  const yml = readFileSync(path.join(ROOT, "azure-pipelines.yml"), "utf8");
  assert.match(yml, /build-info\.json/, "azure-pipelines.yml must stamp build-info.json");
  assert.match(yml, /Build\.SourceVersion/, "…with the commit the build was made from");
  assert.match(yml, /Build\.BuildId/, "…and the build id");
});

/* ── 8. nothing may CACHE a pool across ticks, or build its own ───────────── */
// A rebuilt pool only reaches the app if every caller re-resolves it. One
// module-level `const pool = await getServicesPool()` would pin the dead pool
// for the life of the process and quietly undo all of the above — and so would
// a module that quietly keeps a connection pool of its own.

function jsFilesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...jsFilesUnder(full));
    else if (name.endsWith(".js") || name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

/** Every file the App Service actually runs: lib/, routes/, db/, index.js. */
function shippedJsFiles() {
  return [
    ...jsFilesUnder(path.join(ROOT, "lib")),
    ...jsFilesUnder(path.join(ROOT, "routes")),
    ...jsFilesUnder(path.join(ROOT, "db")),
    path.join(ROOT, "index.js"),
  ];
}

test("no module resolves a pool at module scope (it would outlive every rebuild)", () => {
  const files = shippedJsFiles();
  // Print what was read: a silent zero over three files is not a clean bill of
  // health [feedback_mutation_test_your_guards].
  assert.ok(files.length > 100, `expected to scan the whole service, scanned ${files.length} files`);

  const offenders = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    // Column 0 = module scope (top-level await), the only way to cache a pool
    // for the life of the process.
    if (/^(const|let|var)\s+[\w{}\s,]+=\s*await\s+(getServicesPool|getPlatformPool|getPool)\s*\(/m.test(src)) {
      offenders.push(`${path.relative(ROOT, f)}: module-scope pool`);
    }
    // A resolved pool handed to something long-lived — `startXTimer(await
    // getServicesPool())` pins one pool into every future tick.
    if (/\b(start|schedule)[A-Za-z]*\(\s*await\b/.test(src)) {
      offenders.push(`${path.relative(ROOT, f)}: awaited value passed to a long-lived starter`);
    }
  }
  assert.deepEqual(offenders, [], "these would hold a dead pool forever");
});

test("only db/ may build a SQL connection pool — nothing else keeps one of its own", () => {
  // lib/websiteBuilder/sectionLibrary.js had exactly this until 2026-09-16: a
  // third pool with its own credential, its own token, NO expiry tracking and a
  // server that defaulted to production. It is now read through the shared
  // services pool, and this stops the next one being written.
  const offenders = [];
  for (const f of shippedJsFiles()) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    if (rel.startsWith("db/")) continue;
    if (/new\s+sql\.ConnectionPool\s*\(/.test(readFileSync(f, "utf8"))) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], "a private pool inherits none of the token refresh or the ELOGIN recovery");
});

test("the section library reads through the shared services pool", () => {
  const src = readFileSync(path.join(ROOT, "lib", "websiteBuilder", "sectionLibrary.js"), "utf8");
  assert.match(src, /import \{ getServicesPool \} from '\.\.\/\.\.\/db\/servicesPool\.js';/);
  assert.match(src, /const getPool = getServicesPool;/, "and resolves it per call, never caching one");
  assert.equal(/getToken\(/.test(src) && /ConnectionPool/.test(src), false,
    "it must not fetch its own SQL token or build its own pool again");
});
