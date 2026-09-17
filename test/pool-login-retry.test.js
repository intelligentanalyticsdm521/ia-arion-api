// test/pool-login-retry.test.js — the pool has to survive a login lottery.
//
// THE INCIDENTS (production, 2026-09-16 00:05–06:15Z and 2026-09-17 06:20–12:10Z):
// the SQL server refused roughly 85% of NEW managed-identity logins to
// **iadm_services** with
//     ConnectionError: Login failed for user '<token-identified principal>'
// (tedious 'ELOGIN', server 18456), while connections ALREADY OPEN in a pool
// kept serving queries the entire time.
//
// oliver-api went down and LUMEN-API did not, and the only difference was pool
// shape: oliver's pool was `max 10 / min 0 / idleTimeoutMillis 30000`, so every
// quiet 30 seconds retired the last connection and the next request had to win a
// fresh login; LUMEN never rebuilds its pool, so it never had to log in again.
// arion-api carried oliver's shape AND closed its live pool every hour on a
// token-expiry timer BEFORE trying to build the replacement.
//
// These tests drive the REAL helper (db/poolRecovery.js) and the REAL health
// route functions. The fake pool is the FAILURE, not the fix: it throws mssql's
// own ConnectionError shape, so a test goes red the way production went red.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

process.env.SQL_SERVER = process.env.SQL_SERVER || "";
process.env.SERVICES_SQL_SERVER = process.env.SERVICES_SQL_SERVER || "";
process.env.PLATFORM_SQL_SERVER = process.env.PLATFORM_SQL_SERVER || "";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const {
  isLoginFailure, connectWithLoginRetry, tarnLoginRetryOptions,
  poolSizingOptions, loginRetryPlan, createFreshCredentialBound, createPoolHolder,
  freshCredentialMinIntervalMs,
} = await import("../db/poolRecovery.js");

const src = (f) => readFileSync(path.join(ROOT, f), "utf8");
const POOL_MODULES = ["db/servicesPool.js", "db/platformPool.js"];

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

function timeoutError() {
  const e = new Error("Failed to connect to sql-iadm-prod-cus.database.windows.net in 15000ms");
  e.code = "ETIMEOUT";
  return e;
}

/**
 * A pool build that loses the login lottery `failures` times and then wins —
 * the real shape of the production fault, driven through the real retry.
 */
function lotteryBuild(failures) {
  const calls = [];
  return {
    calls,
    build: async (attempt, opts) => {
      calls.push({ attempt, freshCredential: Boolean(opts?.freshCredential) });
      if (calls.length <= failures) throw eloginError();
      return { id: `pool-after-${calls.length}` };
    },
  };
}

function harness(build, { tokenExp = 1_700_000_003_600_000 } = {}) {
  const slept = [];
  const logs = [];
  const run = (extra = {}) => connectWithLoginRetry({
    label: "services",
    build,
    tokenExpiresAt: () => tokenExp,
    sleep: async (ms) => { slept.push(ms); },
    now: () => 1_700_000_000_000,
    log: (l) => logs.push(l),
    ...extra,
  });
  return { run, slept, logs };
}

/** Restore an env var exactly, including "it was not set at all". */
function withEnv(vars, fn) {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

/* ── 1. classification ────────────────────────────────────────────────────── */

test("isLoginFailure recognises every shape Azure SQL refuses a login in", () => {
  assert.equal(isLoginFailure(eloginError()), true, "tedious ELOGIN, mssql-wrapped");
  assert.equal(isLoginFailure(Object.assign(new Error("Login failed."), { code: "ELOGIN" })), true);
  assert.equal(isLoginFailure(Object.assign(new Error("other wording"), { number: 18456 })), true);
  assert.equal(
    isLoginFailure(new Error("Login failed for user '<token-identified principal>'.")),
    true,
    "the server's own text, even with no code — this is what prod logged for hours",
  );
  const deep = new Error("pool acquire failed"); deep.cause = eloginError();
  assert.equal(isLoginFailure(deep), true);
});

test("isLoginFailure refuses everything another ticket would not fix", () => {
  assert.equal(isLoginFailure(timeoutError()), false);
  assert.equal(isLoginFailure(Object.assign(new Error("socket hang up"), { code: "ESOCKET" })), false);
  assert.equal(isLoginFailure(Object.assign(new Error("deadlocked"), { number: 1205 })), false);
  assert.equal(isLoginFailure(null), false);
  assert.equal(isLoginFailure("Login failed for user 'x'"), false, "a string is not an error object");
});

test("a self-referential error chain is bounded, not an infinite walk", () => {
  const a = new Error("outer"); const b = new Error("inner");
  Object.defineProperty(a, "originalError", { value: b });
  Object.defineProperty(b, "originalError", { value: a });
  assert.equal(isLoginFailure(a), false);
});

/* ── 2. (c) THE RETRY PLAN IS BOUNDED ─────────────────────────────────────── */

test("the plan is four attempts, 400ms apart, new credential from the third", () => {
  assert.deepEqual(loginRetryPlan(), { attempts: 4, delayMs: 400, freshCredentialFromAttempt: 3 });
});

test("the retry plan is clamped — a nonsense env var cannot make it unbounded", () => {
  withEnv({ SQL_LOGIN_RETRY_ATTEMPTS: "9999", SQL_LOGIN_RETRY_DELAY_MS: "-1" }, () => {
    const p = loginRetryPlan();
    assert.equal(p.attempts, 4, "out of range falls back to the default, never to 9999 attempts");
    assert.equal(p.delayMs, 400);
  });
  withEnv({ SQL_LOGIN_RETRY_ATTEMPTS: "2" }, () => {
    assert.equal(loginRetryPlan().attempts, 2, "an in-range override IS honoured");
  });
});

test("a login refused twice is won on the third attempt", async () => {
  const l = lotteryBuild(2);
  const h = harness(l.build);
  const pool = await h.run();

  assert.equal(pool.id, "pool-after-3", "the third ticket won");
  assert.equal(l.calls.length, 3);
  assert.deepEqual(h.slept, [400, 400], "400ms apart, exactly twice");
  assert.deepEqual(l.calls.map((c) => c.freshCredential), [false, false, true],
    "the first two reuse the credential; the THIRD asks for a brand-new one");
  assert.equal(h.logs.length, 1, "one loud line, on recovery");
  assert.match(h.logs[0], /pool=services/);
  assert.match(h.logs[0], /tokenExpiresOnTimestamp=1700000003600000/, "the expiry the pool still believed");
  assert.match(h.logs[0], /recovered-on-attempt-3-with-new-credential/);
});

test("four refusals throw the ORIGINAL error — never a fifth attempt, never a fake pool", async () => {
  const first = eloginError({ message: "Login failed for user '<token-identified principal>'." });
  let n = 0;
  const build = async () => { n += 1; throw n === 1 ? first : eloginError({ message: `refusal ${n}` }); };
  const h = harness(build);

  let returned = "NOTHING-WAS-RETURNED";
  let thrown = null;
  try { returned = await h.run(); } catch (e) { thrown = e; }

  assert.equal(returned, "NOTHING-WAS-RETURNED", "no value is ever handed back on failure");
  assert.equal(thrown, first, "the ORIGINAL error object, not the last one");
  assert.equal(n, 4, "bounded at four attempts");
  assert.deepEqual(h.slept, [400, 400, 400], "three gaps between four attempts, no trailing wait");
  assert.ok(h.logs.some((l) => /gave-up-after-4-attempts/.test(l)), "and it says so, once, loudly");
});

test("a non-login failure is NOT retried and reaches the caller unchanged", async () => {
  const boom = timeoutError();
  let n = 0;
  const h = harness(async () => { n += 1; throw boom; });
  await assert.rejects(() => h.run(), (e) => e === boom);
  assert.equal(n, 1, "one attempt — a timeout is not a refused login");
  assert.deepEqual(h.slept, [], "and no waiting");
});

test("the first attempt succeeding stays silent and costs nothing", async () => {
  const l = lotteryBuild(0);
  const h = harness(l.build);
  assert.equal((await h.run()).id, "pool-after-1");
  assert.deepEqual(h.slept, []);
  assert.deepEqual(h.logs, [], "a healthy build must not print an incident line");
});

test("at most one fresh credential per pool per 30s — the retry still runs, on the cached one", async () => {
  const clock = { t: 1_700_000_000_000 };
  const bound = createFreshCredentialBound({ now: () => clock.t });

  const l1 = lotteryBuild(2);
  await harness(l1.build).run({ mayTakeFreshCredential: () => bound.may() });
  assert.deepEqual(l1.calls.map((c) => c.freshCredential), [false, false, true]);

  clock.t += 29_000;                       // still inside the window
  const l2 = lotteryBuild(2);
  const out = await harness(l2.build).run({ mayTakeFreshCredential: () => bound.may() });
  assert.equal(out.id, "pool-after-3", "the retry still happens — the bound gates the TOKEN, not the retry");
  assert.deepEqual(l2.calls.map((c) => c.freshCredential), [false, false, false],
    "no second IMDS fetch inside the window: a broken identity must not become a token storm");

  clock.t += 2_000;                        // 31s after the first
  const l3 = lotteryBuild(2);
  await harness(l3.build).run({ mayTakeFreshCredential: () => bound.may() });
  assert.deepEqual(l3.calls.map((c) => c.freshCredential), [false, false, true], "the window reopens");
});

/* ── 3. (a) THE CONFIG CARRIES THE KEEP-ALIVE DEFAULTS AND ENV OVERRIDES ──── */

test("the keep-alive defaults are min 2 and a ten-minute idle window", () => {
  withEnv({ SQL_POOL_MIN: undefined, SQL_POOL_IDLE_MS: undefined }, () => {
    assert.deepEqual(poolSizingOptions(), { min: 2, idleTimeoutMillis: 600_000 },
      "min 0 / idle 30s is the shape that took OLIVER down: every quiet minute forced a fresh login");
  });
});

test("SQL_POOL_MIN and SQL_POOL_IDLE_MS override, and are CLAMPED so a typo cannot restore the outage", () => {
  withEnv({ SQL_POOL_MIN: "4", SQL_POOL_IDLE_MS: "900000" }, () => {
    assert.deepEqual(poolSizingOptions(), { min: 4, idleTimeoutMillis: 900_000 }, "in-range overrides are honoured");
  });
  withEnv({ SQL_POOL_MIN: "0", SQL_POOL_IDLE_MS: "30000" }, () => {
    assert.deepEqual(poolSizingOptions(), { min: 0, idleTimeoutMillis: 30_000 },
      "the edges of the allowed range are still reachable on purpose, for an operator who needs them");
  });
  withEnv({ SQL_POOL_MIN: "99", SQL_POOL_IDLE_MS: "1000" }, () => {
    assert.deepEqual(poolSizingOptions(), { min: 2, idleTimeoutMillis: 600_000 },
      "out of range falls back to the DEFAULT, never to an idle window short enough to drain the pool");
  });
  withEnv({ SQL_POOL_MIN: "two", SQL_POOL_IDLE_MS: "" }, () => {
    assert.deepEqual(poolSizingOptions(), { min: 2, idleTimeoutMillis: 600_000 }, "and garbage is not a number");
  });
});

test("a connection created FOR A QUERY gets the same four tickets, bounded", () => {
  const o = tarnLoginRetryOptions();
  assert.equal(o.propagateCreateError, false,
    "mssql's own default is true, which hands the FIRST refused login straight to the waiting query — "
    + "that default is why a server refusing 85% of logins refused 85% of requests");
  assert.equal(o.createRetryIntervalMillis, 400);
  assert.ok(o.acquireTimeoutMillis >= 1_000 && o.acquireTimeoutMillis <= 60_000,
    "bounded, so a genuinely dead database still fails instead of parking the request");
  withEnv({ SQL_ACQUIRE_TIMEOUT_MS: "12000" }, () => {
    assert.equal(tarnLoginRetryOptions().acquireTimeoutMillis, 12_000, "and it is tunable");
  });
});

test("BOTH pool modules actually spread the keep-alive and the tarn options into mssql's config", () => {
  // The option objects existing proves nothing if nobody passes them.
  for (const file of POOL_MODULES) {
    const s = src(file);
    assert.match(s, /\.\.\.poolSizingOptions\(\),/, `${file} must pass the keep-alive sizing to mssql`);
    assert.match(s, /\.\.\.tarnLoginRetryOptions\(\),/, `${file} must pass the retry options to mssql`);
    assert.equal(/min: 0,/.test(s), false, `${file} must not hardcode min: 0 — that IS the outage`);
    assert.equal(/idleTimeoutMillis: 30000,/.test(s), false,
      `${file} must not hardcode a 30s idle window — 30 quiet seconds cost the app every connection`);
    assert.match(s, /max: 10,/, `${file} keeps its existing maximum — max is deliberately unchanged`);
  }
});

test("arion's THIRD live pool — the section library — gets the same mechanism, not a copy", () => {
  // lib/websiteBuilder/sectionLibrary.js opens its own pool against
  // iadm_services, the database that refused the logins. It ran on mssql's
  // DEFAULT sizing (min 0 / idle 30s) with no retry at all.
  const s = src("lib/websiteBuilder/sectionLibrary.js");
  assert.match(s, /from '\.\.\/\.\.\/db\/poolRecovery\.js'/, "it imports the ONE shared helper");
  assert.match(s, /connectWithLoginRetry\(\{/, "its pool build is retried");
  assert.match(s, /\.\.\.poolSizingOptions\(\),/, "and carries the keep-alive sizing");
  assert.match(s, /\.\.\.tarnLoginRetryOptions\(\),/, "and the per-query tickets");
  assert.match(s, /if \(freshCredential\) _credential = null;/,
    "its credential IS cached, so the retry must drop it or the 'new token' is the refused one");
  assert.match(s, /pool\.on\('error'/, "and a listener, or Node re-throws from inside emit()");
  assert.equal(/function isLoginFailure/.test(s), false, "no second classifier");
});

/* ── 4. (b) AN ELOGIN ON A NEW CONNECTION DOES NOT DRAIN THE LIVE POOL ────── */

function fakePool(id) {
  const p = { id, closed: 0, closedAt: null };
  p.close = async () => { p.closed += 1; p.closedAt = order.push(`close:${id}`); };
  return p;
}
let order = [];

function holderHarness() {
  const clock = { t: 1_700_000_000_000 };
  const logs = [];
  const script = [];        // queue of () => Promise<{pool, tokenExpiresAt}>
  let connects = 0;
  const holder = createPoolHolder({
    label: "services",
    connect: async () => {
      connects += 1;
      const next = script.shift();
      if (!next) throw new Error("test script exhausted");
      return next();
    },
    now: () => clock.t,
    log: (l) => logs.push(l),
  });
  return { holder, clock, logs, script, connects: () => connects };
}

test("a refused login while a pool is HELD returns the live pool and never closes it", async () => {
  order = [];
  const h = holderHarness();
  const live = fakePool("live");
  const tokenExp = h.clock.t + 60 * 60 * 1000;

  h.script.push(async () => ({ pool: live, tokenExpiresAt: tokenExp }));
  assert.equal(await h.holder.get(), live, "cold start builds the pool");

  // Past the 5-minute refresh buffer: the old code closed this live pool FIRST.
  h.clock.t = tokenExp - 60_000;
  h.script.push(async () => { throw eloginError(); });
  const still = await h.holder.get();
  await new Promise((r) => setImmediate(r));   // let any premature close land

  assert.equal(still, live, "the SAME live pool is handed back — its open connections still work");
  assert.equal(live.closed, 0,
    "and it is NOT closed: draining the connections that still work is exactly how OLIVER went down");
  assert.equal(h.logs.length, 1, "one loud line");
  assert.match(h.logs[0], /outcome=kept-live-pool-after-failed-rebuild/);
  assert.match(h.logs[0], /login=refused/, "and it names the reason as a refused login");
});

test("a failed rebuild is not re-attempted for the bound — no login storm", async () => {
  order = [];
  const h = holderHarness();
  const live = fakePool("live");
  const tokenExp = h.clock.t + 60 * 60 * 1000;
  h.script.push(async () => ({ pool: live, tokenExpiresAt: tokenExp }));
  await h.holder.get();

  h.clock.t = tokenExp - 60_000;
  h.script.push(async () => { throw eloginError(); });
  await h.holder.get();
  assert.equal(h.connects(), 2);

  // Inside the 30s bound: serve from the live pool without touching SQL at all.
  h.clock.t += freshCredentialMinIntervalMs() - 1_000;
  assert.equal(await h.holder.get(), live);
  assert.equal(h.connects(), 2, "no second connect attempt inside the bound");
  assert.equal(h.logs.length, 1, "and no second log line");

  // The window reopens, the login is won, and the pool is swapped.
  h.clock.t += 2_000;
  const fresh = fakePool("fresh");
  h.script.push(async () => ({ pool: fresh, tokenExpiresAt: h.clock.t + 60 * 60 * 1000 }));
  assert.equal(await h.holder.get(), fresh, "the replacement takes over once it connects");
  assert.equal(h.connects(), 3);
});

test("the old pool is closed only AFTER the replacement is connected, never before", async () => {
  order = [];
  const h = holderHarness();
  const live = fakePool("live");
  const tokenExp = h.clock.t + 60 * 60 * 1000;
  h.script.push(async () => ({ pool: live, tokenExpiresAt: tokenExp }));
  await h.holder.get();

  h.clock.t = tokenExp - 60_000;
  const fresh = fakePool("fresh");
  h.script.push(async () => {
    // Yield a tick first: a premature close is fire-and-forget, so without this
    // the assertion below could run before it lands and prove nothing.
    await new Promise((r) => setImmediate(r));
    assert.equal(live.closed, 0, "the live pool is still open while its replacement is being built");
    order.push("connected:fresh");
    return { pool: fresh, tokenExpiresAt: h.clock.t + 60 * 60 * 1000 };
  });
  assert.equal(await h.holder.get(), fresh);
  await new Promise((r) => setImmediate(r));   // the close is fire-and-forget

  assert.deepEqual(order, ["connected:fresh", "close:live"],
    "connected first, closed second — the reverse order is the hourly self-inflicted outage");
  assert.equal(live.closed, 1, "closed exactly once");
  assert.equal(fresh.closed, 0);
});

test("with NO pool yet held, a refused login is thrown — never swallowed into a fake success", async () => {
  const h = holderHarness();
  const boom = eloginError();
  h.script.push(async () => { throw boom; });

  let returned = "NOTHING-WAS-RETURNED";
  let thrown = null;
  try { returned = await h.holder.get(); } catch (e) { thrown = e; }
  assert.equal(returned, "NOTHING-WAS-RETURNED");
  assert.equal(thrown, boom, "the original error reaches the caller on a cold start");
  assert.equal(h.logs.length, 0, "the fall-back line is only for a pool that actually survived");
});

test("concurrent callers share ONE rebuild, not one login attempt each", async () => {
  const h = holderHarness();
  const live = fakePool("live");
  const tokenExp = h.clock.t + 60 * 60 * 1000;
  h.script.push(async () => ({ pool: live, tokenExpiresAt: tokenExp }));
  await h.holder.get();

  h.clock.t = tokenExp - 60_000;
  const fresh = fakePool("fresh");
  h.script.push(async () => {
    await new Promise((r) => setTimeout(r, 5));
    return { pool: fresh, tokenExpiresAt: h.clock.t + 60 * 60 * 1000 };
  });
  const all = await Promise.all([h.holder.get(), h.holder.get(), h.holder.get()]);
  assert.deepEqual(all, [fresh, fresh, fresh]);
  assert.equal(h.connects(), 2, "three callers, one replacement build — not three logins");
});

test("the healthy path never rebuilds: a pool inside its token life is returned untouched", async () => {
  const h = holderHarness();
  const live = fakePool("live");
  h.script.push(async () => ({ pool: live, tokenExpiresAt: h.clock.t + 60 * 60 * 1000 }));
  await h.holder.get();
  h.clock.t += 50 * 60 * 1000;         // still >5min of token life left
  assert.equal(await h.holder.get(), live);
  assert.equal(h.connects(), 1, "no rebuild while the pool is healthy");
  assert.equal(live.closed, 0);
});

/* ── 5. the real modules, with nothing injected ───────────────────────────── */

const platformMod = await import("../db/platformPool.js");
const servicesMod = await import("../db/servicesPool.js");

test("getCredential is a FACTORY — a new instance per call, so every retry presents a NEW token", () => {
  const a = platformMod.getCredential();
  const b = platformMod.getCredential();
  assert.ok(a && b, "a credential is built");
  assert.notEqual(a, b,
    "memoising this would make the login retry re-present the very token SQL just refused — "
    + "oliver-api has to call resetCredential() to buy what this factory gives structurally");
});

test("both pool modules go through the ONE shared helper — no second copy of any of it", () => {
  for (const [file, label] of [["db/servicesPool.js", "services"], ["db/platformPool.js", "platform"]]) {
    const s = src(file);
    assert.match(s, /from "\.\/poolRecovery\.js"/, `${file} imports the shared helper`);
    assert.match(s, /connectWithLoginRetry\(\{/, `${file} builds its pool through it`);
    assert.match(s, /createPoolHolder\(\{/, `${file} holds its pool through the lazy swap`);
    assert.match(s, new RegExp(`label: "${label}"`), `${file} names itself in the log`);
    assert.match(s, /mayTakeFreshCredential: \(\) =>/, `${file} passes the 30s bound`);
    assert.equal(/function isLoginFailure/.test(s), false, `${file} must not define its own classifier`);
    assert.equal(/["']ELOGIN["']/.test(s), false, `${file} must not compare against the ELOGIN literal itself`);
    assert.equal(/oldPool\.close\(\)/.test(s), false,
      `${file} must not close a pool before its replacement exists — that is the hourly self-inflicted outage`);
  }
});

test("the pool 'error' listener LOGS and does nothing else — it must never drain the pool", () => {
  for (const file of POOL_MODULES) {
    const s = src(file);
    const m = /pool\.on\("error", \(err\) => \{([\s\S]*?)\n  \}\);/.exec(s);
    assert.ok(m, `${file} must attach an 'error' listener — without one Node re-throws from inside emit()`);
    const body = m[1];
    assert.match(body, /console\.error\(/, `${file}: the listener reports the refusal`);
    assert.match(body, /isLoginFailure\(err\)/, `${file}: and says whether the login was refused`);
    for (const forbidden of [/\.close\(/, /invalidate/, /holder\./]) {
      assert.equal(forbidden.test(body), false,
        `${file}: the listener must not tear the pool down — the pooled connections are what keep the app alive`);
    }
  }
});

test("both invalidate functions go through the holder, so nothing keeps a stale pool behind its back", () => {
  assert.equal(typeof servicesMod.invalidateServicesPool, "function");
  assert.equal(typeof platformMod.invalidatePlatformPool, "function");
  servicesMod.invalidateServicesPool();
  platformMod.invalidatePlatformPool();
  assert.equal(servicesMod._servicesHolder._held(), null, "services: the held pool is dropped");
  assert.equal(platformMod._platformHolder._held(), null, "platform: the held pool is dropped");
  assert.equal(servicesMod._servicesHolder._blockedUntil(), 0, "and the failed-rebuild bound is cleared");
});

/* ── 6. /health names the database and the reason ─────────────────────────── */

const health = await import("../routes/health.js");

test("probe reports a refused login BY CODE, and never throws", async () => {
  const bad = await health.probe(async () => { throw eloginError(); });
  assert.deepEqual({ ok: bad.ok, code: bad.code }, { ok: false, code: "ELOGIN" });
  assert.match(bad.message, /Login failed for user/);

  const timedOut = await health.probe(async () => { throw timeoutError(); });
  assert.equal(timedOut.code, "ETIMEOUT");

  const good = await health.probe(async () => ({ request: () => ({ query: async () => ({ recordset: [{ ok: 1 }] }) }) }));
  assert.deepEqual(good, { ok: true });
});

test("a failing database is NAMED, with its message — never null and never absent", () => {
  const down = health.buildHealthBody(
    { ok: false, code: "ELOGIN", message: "Login failed for user '<token-identified principal>'." },
    { ok: true },
  );
  assert.equal(down.status, 503);
  assert.equal(down.body.platformDb, "error");
  assert.equal(down.body.platformDbCode, "ELOGIN");
  assert.match(down.body.platformDbError, /Login failed for user/, "the MESSAGE, not null");
  assert.equal(down.body.servicesDb, "ok",
    "the healthy database is still named — both incidents were ONE database, not two");
  assert.match(down.body.details, /Login failed/, "the old `details` field still answers");
});

test("the services database can be the failing one, and is named as such", () => {
  const down = health.buildHealthBody(
    { ok: true },
    { ok: false, code: "ELOGIN", message: "Login failed for user '<token-identified principal>'." },
  );
  assert.equal(down.status, 503);
  assert.equal(down.body.servicesDbCode, "ELOGIN");
  assert.match(down.body.servicesDbError, /Login failed for user/);
  assert.equal("platformDbError" in down.body, false, "and the healthy one carries no error fields");
});

test("a healthy pair is still a plain 200 with both databases named", () => {
  const up = health.buildHealthBody({ ok: true }, { ok: true });
  assert.equal(up.status, 200);
  assert.deepEqual({ s: up.body.status, p: up.body.platformDb, v: up.body.servicesDb }, { s: "ok", p: "ok", v: "ok" });
  assert.equal("platformDbCode" in up.body, false, "no error fields when there is no error");
});

test("the route probes both databases independently and answers with that status", () => {
  const s = src("routes/health.js");
  assert.match(s, /probe\(getPlatformPool\)/);
  assert.match(s, /probe\(getServicesPool\)/);
  assert.match(s, /Promise\.all/, "both are probed even when the first one is dead");
  assert.match(s, /res\.status\(status\)\.json\(body\)/);
});
