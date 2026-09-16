// ─────────────────────────────────────────────────────────────────────────────
// ELOGIN RECOVERY — the ONE mechanism, shared by db/servicesPool.js and
// db/platformPool.js. Do not write a second copy of it in either module.
//
// THE INCIDENT IT EXISTS FOR (2026-09-16, `oliver-prod-sql-login-failing`):
// after a platform-initiated App Service instance move at 00:19Z, oliver-api's
// managed identity was handed a token `iadm_services` refused. Every NEW
// connection came back
//     ConnectionError: Login failed for user '<token-identified principal>'
// (tedious code 'ELOGIN', server error 18456) while connections already in the
// pool kept working — and the app NEVER RECOVERED ON ITS OWN. Four hours, three
// deploy restarts and an `az webapp restart` did not clear it; only a full
// stop+start (which recreates the identity sidecar) did.
//
// WHY it could not recover: both pool modules rebuilt on exactly ONE condition —
// `Date.now() >= poolTokenExpiresAt - 5min`. A token that is REJECTED while its
// own `expiresOnTimestamp` still says valid is therefore trusted forever, and
// the pool's only exit from a poisoned token was a process restart.
//
// arion-api's two pools are that same file lineage, line for line. They stayed
// healthy on 2026-09-16 only because the instance move hit oliver's instance;
// the next move can hit this one. This is the same fix, in the same shape.
//
// WHAT THIS ADDS, in one place:
//   1. `isLoginFailure(err)` — recognise the failure by the PRESENCE of a login
//      marker (code / error number / server text), never by the absence of
//      something else ([reference_absence_based_guards_fail_open]).
//   2. `withPool(fn)` — run fn against the pool; on a login failure discard the
//      pool, build a NEW credential (see the note on `discard` below), rebuild
//      once and retry the operation exactly once. If the retry fails too the
//      ORIGINAL error is thrown — never swallowed, never a fake success
//      ([reference_catch_swallow_report_success]).
//   3. `onPoolError(err)` — attached to the mssql pool's own 'error' event, so
//      the hundreds of call sites that do `(await getServicesPool()).request()
//      .query()` directly still POISON the pool when their connection is
//      refused. They get no retry, but the next caller gets a REBUILT pool
//      instead of the same dead one forever. That is the "recovers on its own"
//      half of the fix, and it is the half that matters most here: almost every
//      arion call site holds the pool directly.
//   4. A bound: at most ONE forced rebuild per pool per 30s, so a genuinely
//      broken identity cannot turn into a token-fetch storm against IMDS.
//      Further login failures inside the window throw immediately.
//
// The two paths in (2) and (3) race on purpose — mssql emits 'error' on the pool
// BEFORE the caller's promise rejects (base/connection-pool.js `acquire`) — so
// they share one bound through `planRecovery()`, and a caller whose pool was
// already replaced under it ("already-rebuilt") still gets its one retry without
// spending a second rebuild.
//
// LOGGING: exactly ONE loud line per event (poisoned / recovered / retry failed /
// refused by the bound), carrying the timestamp, WHICH pool, and the token's
// `expiresOnTimestamp` — the field that lied throughout the incident — so the
// next occurrence is diagnosable from the log alone instead of from a live app.
//
// A NOTE ON THE CREDENTIAL, because arion differs from oliver here on purpose.
// oliver-api caches one `ManagedIdentityCredential` for the life of the process,
// so its discard must call `resetCredential()` or the retry reuses the very
// token SQL just refused. arion-api's `getCredential()` in db/platformPool.js is
// a FACTORY: it constructs a new credential on every call, and both pools call
// it on every rebuild. An @azure/identity credential holds its token cache in
// the instance, so a new instance means a genuinely new token request. There is
// therefore no cached credential to drop — the property oliver buys with
// `resetCredential()` this repo has structurally. `test/pool-recovery.test.mjs`
// pins that ("the credential is a FACTORY…"), because the day someone memoises
// it for performance is the day this recovery starts retrying with the refused
// token and nothing else would notice.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimum gap between two forced rebuilds of the SAME pool. The env override
 * exists for tests and for an operator who needs it wider; it is never read as
 * "off" — 0, a negative or a non-number falls back to 30s.
 */
export function rebuildMinIntervalMs() {
  const raw = Number(process.env.SQL_POOL_REBUILD_MIN_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 30_000;
}

const LOGIN_FAILED_RE = /login failed for user/i;

/**
 * True when Azure SQL refused the LOGIN itself — as opposed to a timeout, a
 * socket reset, a deadlock, a constraint violation or anything else, none of
 * which a new token would fix and none of which may be retried here.
 *
 * mssql wraps the tedious error (`new ConnectionError(err)` in
 * mssql/lib/tedious/connection-pool.js), copying `code` and keeping the inner
 * error on `originalError`, so the chain is walked — bounded and cycle-safe,
 * because these chains can point back at themselves.
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
 * Build the recovery for ONE pool.
 *
 * @param {object}   o
 * @param {string}   o.label          "services" | "platform" — named in every log line.
 * @param {Function} o.connect        () => Promise<pool>   the module's getXPool.
 * @param {Function} o.discard        () => void            drop the cached pool promise
 *                                    and close the old pool. MUST take effect
 *                                    synchronously (the close itself may finish later)
 *                                    so a concurrent caller cannot pick the poisoned
 *                                    pool back up. The next connect() must build its
 *                                    token from a NEW credential instance.
 * @param {Function} o.tokenExpiresAt () => number  what the module currently believes the
 *                                    token is good until — the field that lied.
 * @param {Function} [o.now]          clock seam for tests.
 * @param {Function} [o.log]          logger seam for tests (defaults to console.error).
 */
export function createPoolRecovery({ label, connect, discard, tokenExpiresAt, now = Date.now, log = (...a) => console.error(...a) }) {
  let lastRebuildAt = 0;
  let generation = 0;     // bumped by every forced rebuild; lets a racing caller
                          // tell "nobody has fixed this yet" from "already fixed".

  const loud = (outcome, err) => {
    const exp = Number(tokenExpiresAt() || 0);
    const expIso = exp > 0 && Number.isFinite(exp) && exp < 8.64e15 ? new Date(exp).toISOString() : "none";
    log(
      `[sql-pool] ELOGIN ${new Date(now()).toISOString()} pool=${label} outcome=${outcome}`
      + ` tokenExpiresOnTimestamp=${exp} (${expIso})`
      + ` lastRebuildAt=${lastRebuildAt ? new Date(lastRebuildAt).toISOString() : "never"}`
      + ` generation=${generation}`
      + ` err=${JSON.stringify(String(err && err.message ? err.message : err))}`
    );
  };

  /**
   * Decide, synchronously, what this caller may do about a login failure it saw
   * while holding generation `seenGeneration`.
   *   "rebuild"        — you own the rebuild; call discard() then connect().
   *   "already-rebuilt"— somebody replaced the pool under you; just connect() + retry.
   *   "refused"        — inside the bound; throw, do not touch the credential.
   */
  function planRecovery(seenGeneration) {
    if (generation !== seenGeneration) return "already-rebuilt";
    const at = now();
    if (lastRebuildAt && at - lastRebuildAt < rebuildMinIntervalMs()) return "refused";
    lastRebuildAt = at;
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
      loud("refused-rebuild-within-bound", firstError);
      throw firstError;
    }
    if (plan === "rebuild") discard();

    try {
      const fresh = await connect();
      const out = await fn(fresh);
      loud(plan === "rebuild" ? "recovered-after-rebuild" : "recovered-on-rebuilt-pool", firstError);
      return out;
    } catch (secondError) {
      // The retry failed too. Say so once, loudly, and throw the ORIGINAL error:
      // the caller's failure is the first one, the second is context on it.
      loud("retry-failed-after-rebuild", secondError);
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
   * exactly what a poisoned token produces on every query needing a NEW
   * connection while the pooled ones keep working.
   *
   * It retries nothing — it poisons the pool so the next getXPool() builds a new
   * one from a new credential. Returns whether it poisoned, for the tests.
   */
  function onPoolError(err) {
    if (!isLoginFailure(err)) return false;
    if (planRecovery(generation) !== "rebuild") return false;   // already handled / inside the bound
    loud("poisoned-by-pool-error", err);
    discard();
    return true;
  }

  return {
    withPool,
    onPoolError,
    /** Test/ops introspection — never read by a production code path. */
    _lastRebuildAt: () => lastRebuildAt,
    _generation: () => generation,
    _reset: () => { lastRebuildAt = 0; generation = 0; },
  };
}

export default { isLoginFailure, createPoolRecovery, rebuildMinIntervalMs };
