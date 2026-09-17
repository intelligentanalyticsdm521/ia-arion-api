// ─────────────────────────────────────────────────────────────────────────────
// BOUNDED LOGIN RETRY + POOL KEEP-ALIVE — the ONE mechanism, shared by
// db/servicesPool.js and db/platformPool.js. Do not write a second copy of it
// in either module.
//
// THE INCIDENTS IT EXISTS FOR
// ───────────────────────────
// 2026-09-16, 00:05–06:15Z and again 2026-09-17, 06:20–12:10Z: the production
// SQL server refused roughly 85% of NEW managed-identity logins to
// **iadm_services** with
//     ConnectionError: Login failed for user '<token-identified principal>'
// (tedious code 'ELOGIN', server error 18456), while connections ALREADY OPEN
// in a pool kept serving queries normally throughout. The contained user's
// metadata was intact; neither a database failover nor repeated app restarts
// moved the rate.
//
// oliver-api went down and arion-api did not — but not because arion is safer.
// The difference was pool shape, and arion's is the same shape:
//   · `pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }` — with min 0 every
//     quiet 30 seconds retires the last connection, so the next request has to
//     win a NEW login. At an 85% refusal rate, a pool that keeps nothing alive
//     is a pool that is down.
//   · LUMEN-API stayed up for exactly one reason: it never rebuilds its pool,
//     so it never had to log in again.
// arion-api holds its connections for 30 seconds and rebuilds the WHOLE pool
// every hour on a token-expiry timer — closing the healthy pool FIRST and only
// then trying to build its replacement. During a refusal window that timer is
// the outage: it throws away live, working connections to go and lose a
// lottery. The next refusal window hits this app.
//
// THE FIX IS RESILIENCE IN THE POOL, NOT AUTHENTICATION. No SQL passwords, no
// auth-mode change, no new identity. Four parts, in one place:
//
//   1. `isLoginFailure(err)` — recognise a refused login by the PRESENCE of a
//      login marker (tedious code / SQL error number / the server's own text),
//      never by the absence of something else. A timeout is not a bad login and
//      is never retried here. [reference_absence_based_guards_fail_open]
//   2. `connectWithLoginRetry()` — build the pool with up to 4 attempts, 400 ms
//      apart. After the last attempt the ORIGINAL error is thrown — never
//      swallowed, never a fake success. [reference_catch_swallow_report_success]
//   3. `tarnLoginRetryOptions()` — the same idea one layer down, which is the
//      layer live traffic actually fails at: mssql's own default is
//      `propagateCreateError: true`, so the FIRST refused login on a connection
//      created FOR A QUERY goes straight back to that query. With the server
//      refusing 85% of logins that turned an 85% login failure rate into an 85%
//      REQUEST failure rate. `propagateCreateError: false` +
//      `createRetryIntervalMillis: 400`, bounded by `acquireTimeoutMillis` so a
//      genuinely dead database still fails fast instead of parking the request.
//   4. `poolSizingOptions()` — the KEEP-ALIVE. `min` 2 (env SQL_POOL_MIN) and
//      `idleTimeoutMillis` 10 min (env SQL_POOL_IDLE_MS) so a quiet minute no
//      longer costs the app every connection it holds. Holding connections is
//      the whole defence: the connections that survived both incidents were the
//      ones already open. There is deliberately NO timer here — a keepalive
//      timer that opens connections would be opening new LOGINS, which is the
//      thing that fails. `min` + a long idle window is the pool library's own
//      way of holding them, and tedious's TCP keepalive keeps them live.
//
//   5. `createPoolHolder()` — THE LAZY SWAP. A replacement is built while the
//      current pool keeps serving, and the old pool is closed only once the new
//      one is connected. A rebuild that loses the lottery hands the live pool
//      straight back.
//   6. `createPoolRecovery()` — the release line's half, for the pool that is
//      ALREADY UP. `withPool(fn)` retries a refused login exactly once against a
//      re-resolved pool, and `onPoolError(err)` (the mssql pool's own 'error'
//      event) marks the pool stale so the hundreds of call sites that hold the
//      pool directly get a REBUILT one on the next call instead of the same
//      poisoned pool until somebody restarts the app. Marking stale does NOT
//      drain — `holder.markStale()`, never `holder.invalidate()` — so the
//      connections we already hold keep serving through a refused rebuild.
//
// A 30-second bound (`SQL_POOL_REBUILD_MIN_INTERVAL_MS`) caps how often a pool
// may be rebuilt / a fresh credential taken, so a genuinely broken identity
// cannot become a token-fetch storm against IMDS. (2), (5) and (6) all draw on
// that ONE window per pool — two budgets would let a broken identity take twice
// the tokens per window as either one allows.
//
// Exactly ONE loud line per event, carrying the timestamp, WHICH pool, the
// attempt, and the token's `expiresOnTimestamp` — the field that lied all night.
//
// A NOTE ON THE CREDENTIAL, because arion-api differs from oliver-api here on
// purpose. oliver-api caches one credential for the life of the process, so its
// retry must call `resetCredential()` from the 3rd attempt or it retries with
// the very token SQL just refused. arion-api's `getCredential()` in
// db/platformPool.js is a FACTORY — it constructs a new credential on every
// call, and an @azure/identity credential holds its token cache in the instance
// — so every attempt here already asks for a genuinely new token. The property
// oliver buys with `resetCredential()` this repo has structurally.
// test/pool-login-retry.test.js pins that, because the day someone memoises
// the factory for performance is the day this retry starts re-presenting the
// refused token and nothing else would notice.
// ─────────────────────────────────────────────────────────────────────────────

const LOGIN_FAILED_RE = /login failed for user/i;

/** Read an env number, falling back unless it is finite and inside [min,max]. */
function envNum(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback;
}

/** Attempts, spacing, and the attempt from which a NEW credential is used. */
export function loginRetryPlan() {
  return {
    attempts: envNum("SQL_LOGIN_RETRY_ATTEMPTS", 4, 1, 10),
    delayMs: envNum("SQL_LOGIN_RETRY_DELAY_MS", 400, 0, 5_000),
    freshCredentialFromAttempt: envNum("SQL_LOGIN_RETRY_FRESH_TOKEN_FROM", 3, 1, 10),
  };
}

/**
 * THE KEEP-ALIVE. The sizing every pool in this repo is built with.
 *
 * `min: 2` is the fix for the incident: with the old `min: 0` +
 * `idleTimeoutMillis: 30000`, thirty idle seconds retired the last connection
 * and the next request had to win a fresh login — at an 85% refusal rate, that
 * is an outage. Holding two connections and keeping them for ten minutes means
 * a quiet period costs nothing and the app rides out a refusal window on the
 * connections it already has, which is exactly what LUMEN-API did by accident.
 *
 * `max` is NOT set here — each module keeps its own existing maximum.
 *
 * Both values are clamped, so a typo'd env var degrades to the default rather
 * than to `min: 0` (the outage) or an idle window short enough to reintroduce it.
 */
export function poolSizingOptions() {
  return {
    min: envNum("SQL_POOL_MIN", 2, 0, 10),
    idleTimeoutMillis: envNum("SQL_POOL_IDLE_MS", 600_000, 30_000, 3_600_000),
  };
}

/** Minimum gap between two forced rebuilds / fresh credentials of the SAME pool. */
export function freshCredentialMinIntervalMs() {
  const raw = Number(process.env.SQL_POOL_REBUILD_MIN_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

/**
 * True when Azure SQL refused the LOGIN itself — as opposed to a timeout, a
 * socket reset, a deadlock or a constraint, none of which another ticket would
 * fix. mssql wraps the tedious error (`new ConnectionError(err)`), copying
 * `code` and keeping the inner error on `originalError`, so the chain is walked
 * — bounded and cycle-safe, because these chains can point back at themselves.
 */
export function isLoginFailure(err) {
  const seen = new Set();
  let e = err;
  for (let depth = 0; e && typeof e === "object" && depth < 6; depth++) {
    if (seen.has(e)) break;
    seen.add(e);
    if (String(e.code || "").toUpperCase() === "ELOGIN") return true;
    if (Number(e.number) === 18456) return true;
    if (LOGIN_FAILED_RE.test(String(e.message || ""))) return true;
    e = e.originalError || e.innerError || e.cause;
  }
  return false;
}

/**
 * The tarn options that give a connection created FOR A QUERY the same four
 * tickets the pool build gets. mssql's own default is `propagateCreateError:
 * true`, which hands the first refused login straight to the waiting query —
 * that default is why a server refusing 85% of logins refused 85% of requests.
 *
 * `acquireTimeoutMillis` is the bound: a dead database still fails inside it
 * rather than parking the request forever.
 */
export function tarnLoginRetryOptions() {
  const { delayMs } = loginRetryPlan();
  return {
    propagateCreateError: false,
    createRetryIntervalMillis: delayMs,
    acquireTimeoutMillis: envNum("SQL_ACQUIRE_TIMEOUT_MS", 8_000, 1_000, 60_000),
  };
}

/**
 * Build a pool, retrying a REFUSED LOGIN only.
 *
 * @param {object}   o
 * @param {string}   o.label          "services" | "platform" — named in every log line.
 * @param {Function} o.build          (attempt, { freshCredential }) => Promise<pool>
 * @param {Function} o.tokenExpiresAt () => number  what the module believes the token is
 *                                    good until — the field that lied.
 * @param {Function} [o.mayTakeFreshCredential] () => boolean  the 30s bound.
 * @param {Function} [o.sleep]        (ms) => Promise  seam for tests.
 * @param {Function} [o.now]          clock seam for tests.
 * @param {Function} [o.log]          logger seam for tests.
 */
export async function connectWithLoginRetry({
  label,
  build,
  tokenExpiresAt = () => 0,
  mayTakeFreshCredential = () => true,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = Date.now,
  log = (...a) => console.error(...a),
}) {
  const { attempts, delayMs, freshCredentialFromAttempt } = loginRetryPlan();
  let firstError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // A new credential is only worth taking once per bound window; inside it we
    // still retry, just against the credential we already hold.
    const wantsFresh = attempt >= freshCredentialFromAttempt;
    const freshCredential = wantsFresh ? mayTakeFreshCredential() : false;
    try {
      const pool = await build(attempt, { freshCredential });
      if (firstError) {
        loud(log, label, tokenExpiresAt, now, `recovered-on-attempt-${attempt}`
          + (freshCredential ? "-with-new-credential" : ""), firstError);
      }
      return pool;
    } catch (err) {
      // Only a refused login is retried. A timeout, a socket error or a bad
      // config must surface at once, unchanged.
      if (!isLoginFailure(err)) throw err;
      if (!firstError) firstError = err;
      if (attempt === attempts) {
        loud(log, label, tokenExpiresAt, now, `gave-up-after-${attempts}-attempts`, firstError);
        throw firstError;   // the ORIGINAL error, never a swallowed one
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  /* c8 ignore next */
  throw firstError;   // unreachable: the last attempt always throws or returns
}

/** One loud line, the same shape from every path in this file. */
function loud(log, label, tokenExpiresAt, now, outcome, err, extra = "") {
  const exp = Number(tokenExpiresAt() || 0);
  const expIso = exp > 0 && Number.isFinite(exp) && exp < 8.64e15 ? new Date(exp).toISOString() : "none";
  log(
    `[sql-pool] ELOGIN ${new Date(now()).toISOString()} pool=${label} outcome=${outcome}`
    + ` tokenExpiresOnTimestamp=${exp} (${expIso})`
    + extra
    + ` err=${JSON.stringify(String(err && err.message ? err.message : err))}`
  );
}

/**
 * One 30-second gate per pool. It guards TWO things that must not become a
 * storm: taking a brand-new credential, and re-attempting a pool rebuild that
 * just failed while a working pool is still held. Same concern, same knob, one
 * mechanism.
 */
export function createFreshCredentialBound({ now = Date.now } = {}) {
  let lastAt = 0;
  return {
    may() {
      const at = now();
      if (lastAt && at - lastAt < freshCredentialMinIntervalMs()) return false;
      lastAt = at;
      return true;
    },
    _lastAt: () => lastAt,
    _reset: () => { lastAt = 0; },
  };
}

/**
 * THE LAZY SWAP. Holds ONE pool and never throws a healthy one away to go and
 * fetch a replacement.
 *
 * The old code did the opposite: on the hourly token-expiry check it closed the
 * live pool FIRST and only then tried to build the new one, so during a refusal
 * window the timer itself was the outage — it discarded working connections to
 * go and lose a login lottery, and there was nothing to fall back to.
 *
 * Here the replacement is built while the current pool keeps serving, and the
 * old pool is closed only once the new one is CONNECTED (mssql's
 * `ConnectionPool.connect()` acquires and releases a real connection before it
 * resolves, so "connected" means at least one live connection). If the
 * replacement cannot be built, the pool we already hold is handed back and the
 * rebuild is not re-attempted for `SQL_POOL_REBUILD_MIN_INTERVAL_MS` — the same
 * knob, the same bound, one mechanism. That is the difference between the two
 * incidents' survivors and casualties: the apps that kept their open
 * connections kept working.
 *
 * Nothing here retries a QUERY and nothing here swallows an error: with no pool
 * yet held there is nothing to fall back to and the original error is thrown.
 *
 * @param {object}   o
 * @param {string}   o.label   "services" | "platform" — named in every log line.
 * @param {Function} o.connect () => Promise<{ pool, tokenExpiresAt }>
 * @param {number}   [o.refreshBufferMs] rebuild this long before the token expires.
 * @param {Function} [o.now]   clock seam for tests.
 * @param {Function} [o.log]   logger seam for tests.
 */
export function createPoolHolder({
  label,
  connect,
  refreshBufferMs = 5 * 60 * 1000,
  now = Date.now,
  log = (...a) => console.error(...a),
}) {
  let current = null;          // Promise<pool> currently IN USE
  let currentExpiresAt = 0;    // expiry of the token THAT pool was built with
  let inFlight = null;         // de-duped replacement build
  let blockedUntil = 0;        // a rebuild failed; do not hammer it

  function rebuild() {
    if (inFlight) return inFlight;
    const started = connect().then(({ pool, tokenExpiresAt }) => {
      const old = current;
      current = Promise.resolve(pool);
      currentExpiresAt = Number(tokenExpiresAt) || 0;
      blockedUntil = 0;
      // Only NOW is the old pool safe to retire — after the replacement has a
      // live connection, never before it.
      if (old) old.then((p) => p.close().catch(() => {})).catch(() => {});
      return pool;
    });
    inFlight = started.finally(() => { inFlight = null; });
    return inFlight;
  }

  async function get() {
    // The overwhelmingly common path: a pool whose token is still good.
    if (current && now() < currentExpiresAt - refreshBufferMs) return current;
    // A rebuild failed recently. The pool we hold still has live connections —
    // 85% of NEW logins being refused does not touch them.
    if (current && now() < blockedUntil) return current;

    const previous = current;
    try {
      return await rebuild();
    } catch (err) {
      if (!previous) throw err;      // cold start: nothing to fall back to
      blockedUntil = now() + freshCredentialMinIntervalMs();
      log(
        `[sql-pool] ${new Date(now()).toISOString()} pool=${label}`
        + ` outcome=kept-live-pool-after-failed-rebuild`
        + ` login=${isLoginFailure(err) ? "refused" : "n/a"}`
        + ` tokenExpiresOnTimestamp=${currentExpiresAt}`
        + ` retryNotBefore=${new Date(blockedUntil).toISOString()}`
        + ` err=${JSON.stringify(String(err && err.message ? err.message : err))}`
      );
      return previous;
    }
  }

  /**
   * THE DISCARD, and it does NOT drain. Mark the held pool stale so the very
   * next get() builds a replacement — through the lazy swap above, with the live
   * pool still in hand.
   *
   * This is what a refused login must do. The connections already in the pool
   * were accepted at login and are never re-authenticated, so they keep working
   * right through a refusal window; closing them to go and lose a login lottery
   * is the outage, not the recovery. Clearing `blockedUntil` is deliberate: the
   * caller has new evidence (a refused token) that the pool needs replacing, so
   * it may try once now rather than wait out a backoff set by an older failure.
   */
  function markStale() {
    currentExpiresAt = 0;
    blockedUntil = 0;
  }

  /**
   * Drop the held pool AND close it. Only for a caller that knows the pool is
   * unusable rather than merely stale — nothing in production calls this today.
   * A refused login is NOT that case: use markStale().
   */
  function invalidate() {
    if (current) current.then((p) => p.close().catch(() => {})).catch(() => {});
    current = null;
    currentExpiresAt = 0;
    blockedUntil = 0;
  }

  return {
    get,
    markStale,
    invalidate,
    /** Test/ops introspection — never read by a production code path. */
    _expiresAt: () => currentExpiresAt,
    _blockedUntil: () => blockedUntil,
    _held: () => current,
  };
}

/**
 * Build the pool-level recovery for ONE pool.
 *
 * THE OTHER HALF OF "RECOVERS ON ITS OWN". `connectWithLoginRetry` buys extra
 * tickets while a pool is being BUILT, and `createPoolHolder` makes sure a build
 * that loses the lottery costs nothing. Neither helps a pool that is ALREADY UP
 * and whose token the server has started refusing: almost every arion call site
 * does `(await getServicesPool()).request().query()` directly, and nothing on
 * that path ever asks for a replacement. On 2026-09-16 oliver-api sat in exactly
 * that state for four hours — three deploy restarts and an `az webapp restart`
 * did not clear it, only a full stop+start did.
 *
 *   · `withPool(fn)` — run fn against the pool; on a refused login mark the pool
 *     stale, re-resolve and retry the operation exactly once. A second failure
 *     throws the ORIGINAL error, never a swallowed one
 *     ([reference_catch_swallow_report_success]).
 *   · `onPoolError(err)` — attached to the mssql pool's own 'error' event, so a
 *     direct caller's refused connection still marks the pool stale and the NEXT
 *     caller gets a rebuilt one instead of the same poisoned pool forever.
 *
 * MARKING STALE IS NOT DRAINING (2026-09-17). `discard` must be the holder's
 * `markStale()`, never its `invalidate()`. Azure SQL checks a token at LOGIN and
 * never again, so the connections already in the pool keep serving right through
 * a refusal window — tearing them down to chase a login that is being refused is
 * what took oliver-api down. The lazy swap does the replacing, and hands the old
 * pool straight back if the replacement is refused.
 *
 * ONE BOUND. The connect retry's fresh credential, the holder's failed-rebuild
 * backoff and this recovery all draw on the same 30-second window per pool
 * (`SQL_POOL_REBUILD_MIN_INTERVAL_MS`), so a genuinely broken identity cannot
 * become a token-fetch storm against IMDS. Pass the module's own
 * `createFreshCredentialBound()` instance as `bound`.
 *
 * The two paths race on purpose — mssql emits 'error' on the pool BEFORE the
 * caller's promise rejects (base/connection-pool.js `acquire`) — so they share
 * the bound through `planRecovery()` and a generation counter, and a caller
 * whose pool was already replaced under it ("already-rebuilt") still gets its
 * one retry without spending a second rebuild.
 *
 * @param {object}   o
 * @param {string}   o.label          "services" | "platform" — named in every log line.
 * @param {Function} o.connect        () => Promise<pool>   the module's getXPool.
 * @param {Function} o.discard        () => void  mark the pool stale. MUST take effect
 *                                    synchronously and MUST NOT close the pool.
 * @param {Function} o.tokenExpiresAt () => number  what the module currently believes the
 *                                    token is good until — the field that lied.
 * @param {object}   [o.bound]        the pool's SHARED 30s bound.
 * @param {Function} [o.now]          clock seam for tests.
 * @param {Function} [o.log]          logger seam for tests (defaults to console.error).
 */
export function createPoolRecovery({
  label, connect, discard, tokenExpiresAt,
  now = Date.now,
  bound = null,
  log = (...a) => console.error(...a),
}) {
  // Default to a private bound so a caller that does not share one still gets
  // the 30s behaviour; the pool modules DO share one.
  const budget = bound || createFreshCredentialBound({ now });
  let lastRebuildAt = 0;
  let generation = 0;     // bumped by every forced rebuild; lets a racing caller
                          // tell "nobody has fixed this yet" from "already fixed".

  const say = (outcome, err) => loud(
    log, label, tokenExpiresAt, now, outcome, err,
    ` lastRebuildAt=${lastRebuildAt ? new Date(lastRebuildAt).toISOString() : "never"}`
    + ` generation=${generation}`,
  );

  /**
   * Decide, synchronously, what this caller may do about a login failure it saw
   * while holding generation `seenGeneration`.
   *   "rebuild"        — you own the rebuild; call discard() then connect().
   *   "already-rebuilt"— somebody replaced the pool under you; just connect() + retry.
   *   "refused"        — inside the bound; throw, do not touch the pool.
   */
  function planRecovery(seenGeneration) {
    if (generation !== seenGeneration) return "already-rebuilt";
    if (!budget.may()) return "refused";
    lastRebuildAt = now();
    generation += 1;
    return "rebuild";
  }

  /**
   * Run `fn(pool)` with ONE ELOGIN recovery. Resolving the pool is INSIDE the
   * try, because the login is refused at connect time as often as at query time
   * and both have to recover.
   */
  async function withPool(fn) {
    const seenGeneration = generation;
    let firstError;
    try {
      const pool = await connect();
      return await fn(pool);
    } catch (err) {
      if (!isLoginFailure(err)) throw err;    // a timeout is not a bad login
      firstError = err;
    }

    const plan = planRecovery(seenGeneration);
    if (plan === "refused") {
      say("refused-rebuild-within-bound", firstError);
      throw firstError;
    }
    if (plan === "rebuild") discard();

    try {
      const fresh = await connect();
      const out = await fn(fresh);
      say(plan === "rebuild" ? "recovered-after-rebuild" : "recovered-on-rebuilt-pool", firstError);
      return out;
    } catch (secondError) {
      // The retry failed too. Say so once, loudly, and throw the ORIGINAL error:
      // the caller's failure is the first one, the second is context on it.
      say("retry-failed-after-rebuild", secondError);
      try {
        Object.defineProperty(firstError, "poolRecovery", {
          value: {
            pool: label,
            retriedAt: now(),
            retryError: String(secondError && secondError.message ? secondError.message : secondError),
          },
          enumerable: false,
          configurable: true,
        });
      } catch { /* a frozen error is still an error worth throwing */ }
      throw firstError;
    }
  }

  /**
   * Handler for the mssql pool's own 'error' event. mssql emits it whenever a
   * connection cannot be ACQUIRED (base/connection-pool.js `acquire`), which is
   * exactly what a refused token produces on every query needing a NEW
   * connection while the pooled ones keep working.
   *
   * It retries nothing and CLOSES NOTHING — it marks the pool stale so the next
   * getXPool() lazily swaps in a replacement, keeping the connections we already
   * hold until that replacement is actually up. Returns whether it marked, for
   * the tests.
   *
   * An unhandled 'error' on an EventEmitter also throws, so a listener has to
   * exist here whatever it decides to do.
   */
  function onPoolError(err) {
    if (!isLoginFailure(err)) return false;   // a timeout is not a bad login
    if (planRecovery(generation) !== "rebuild") return false;   // already handled / inside the bound
    say("poisoned-by-pool-error", err);
    discard();
    return true;
  }

  return {
    withPool,
    onPoolError,
    /** Test/ops introspection — never read by a production code path. */
    _lastRebuildAt: () => lastRebuildAt,
    _generation: () => generation,
    _bound: budget,
    _reset: () => { lastRebuildAt = 0; generation = 0; budget._reset(); },
  };
}

export default {
  isLoginFailure,
  connectWithLoginRetry,
  createPoolHolder,
  createPoolRecovery,
  tarnLoginRetryOptions,
  poolSizingOptions,
  loginRetryPlan,
  createFreshCredentialBound,
  freshCredentialMinIntervalMs,
};
