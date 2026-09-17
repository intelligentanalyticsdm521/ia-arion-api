// db/servicesPool.js — the iadm_services pool.
//
// RESILIENCE ADDED 2026-09-17 (production incidents 2026-09-16 00:05–06:15Z and
// 2026-09-17 06:20–12:10Z): the SQL server refused ~85% of NEW managed-identity
// logins to iadm_services with "Login failed for user '<token-identified
// principal>'" (tedious ELOGIN / SQL 18456), while connections ALREADY OPEN in a
// pool kept serving. oliver-api went down because its pool was max 10 / min 0 /
// idle 30s — every quiet minute forced a fresh login. This pool was built the
// same way, and on top of that it closed the whole live pool every hour on a
// token-expiry timer BEFORE trying to build the replacement.
//
// The fix is in the POOL, not in authentication — no SQL passwords, no auth-mode
// change, no new identity. All four parts live in ONE place, db/poolRecovery.js:
// the bounded login retry, the tarn options that give a connection created for a
// query the same tickets, the keep-alive sizing (min 2 / idle 10 min), and the
// lazy swap that keeps the live pool serving until its replacement is connected.
import sql from "mssql";
import { getCredential, SQL_SCOPE } from "./platformPool.js";
import {
  connectWithLoginRetry,
  createFreshCredentialBound,
  createPoolHolder,
  poolSizingOptions,
  tarnLoginRetryOptions,
  isLoginFailure,
} from "./poolRecovery.js";

// At most one forced fresh-credential build per pool per 30s.
const freshBound = createFreshCredentialBound();

const sqlServer = process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER;
const sqlDatabase = process.env.SERVICES_SQL_DATABASE || "iadm_services";

// LOCAL-DEV SQL AUTH SEAM (added 2026-07-16)
// Azure SQL only accepts AAD tokens; the local Docker container (compose.yml
// "iadm-sqlserver") speaks SQL auth and presents a self-signed cert. That
// mismatch -- not the config files -- is why local dev never actually ran.
// Active ONLY when BOTH SQL_USER and SQL_PASSWORD are set. Prod sets neither
// (verified 2026-07-16), so prod keeps the identical AAD path + encrypt:true.
// SQL_SERVER may be "localhost,1433"; the mssql driver needs server/port split.
const sqlUser = process.env.SQL_USER;
const sqlPassword = process.env.SQL_PASSWORD;
const useSqlAuth = Boolean(sqlUser && sqlPassword);
function parseServer(raw) {
  const [h, p] = String(raw || "").split(",");
  return { host: h.trim(), port: p ? Number(p.trim()) : undefined };
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// Expiry of the token the build currently in flight is presenting. Promoted to
// the holder's own expiry only when that build SUCCEEDS — a failed rebuild must
// never leave the app believing the pool it is still serving from was reissued.
let pendingTokenExpiresAt = 0;

/**
 * ONE attempt at building the pool. Called up to 4 times, 400ms apart, by
 * connectWithLoginRetry.
 *
 * `freshCredential` is accepted for shape-compatibility with oliver-api, whose
 * credential is cached and has to be dropped on the 3rd attempt. Here
 * getCredential() is a FACTORY — a new @azure/identity instance per call, each
 * with its own empty token cache — so EVERY attempt already presents a genuinely
 * new token. test/pool-login-retry.test.js pins that, because memoising the
 * factory would silently make this retry re-present the refused token.
 */
const attemptBuild = async (attempt) => {
  if (!sqlServer) throw new Error("SERVICES_SQL_SERVER (or SQL_SERVER) env var is required for arion-api");

  const connectTimeoutMs = Number(process.env.SQL_CONNECT_TIMEOUT_MS || "12000");
  const credential = getCredential();
  const token = await withTimeout(credential.getToken(SQL_SCOPE), connectTimeoutMs, "ManagedIdentity getToken");

  // Record when this token expires so the pool can be preemptively replaced.
  pendingTokenExpiresAt = token.expiresOnTimestamp || (Date.now() + 50 * 60 * 1000);

  const { host: sqlHost, port: sqlPort } = parseServer(sqlServer);
  const config = {
    server: sqlHost,
    ...(sqlPort ? { port: sqlPort } : {}),
    database: sqlDatabase,
    options: useSqlAuth
      ? { encrypt: false, trustServerCertificate: true }
      : { encrypt: true },
    connectionTimeout: connectTimeoutMs,
    requestTimeout: Number(process.env.SQL_REQUEST_TIMEOUT_MS || "15000"),
    authentication: useSqlAuth
      ? { type: "default", options: { userName: sqlUser, password: sqlPassword } }
      : { type: "azure-active-directory-access-token", options: { token: token.token } },
    pool: {
      max: 10,
      // KEEP-ALIVE: min 2 / idle 10 min, replacing min 0 / idle 30s. Holding
      // connections is the defence — the ones that survived both incidents were
      // the ones already open. No timer: a keepalive that opens connections is
      // a keepalive that opens LOGINS, which is the thing that was failing.
      ...poolSizingOptions(),
      // The same four tickets, one layer down — the layer live traffic fails at.
      // mssql's own default is propagateCreateError:true, so the FIRST refused
      // login on a connection created for a query goes straight back to that
      // query, turning an 85% login failure rate into an 85% REQUEST failure
      // rate. Bounded by acquireTimeoutMillis so a dead database still fails.
      ...tarnLoginRetryOptions(),
    },
  };

  const pool = await withTimeout(
    new sql.ConnectionPool(config).connect(),
    connectTimeoutMs,
    `SQL ConnectionPool.connect (attempt ${attempt})`,
  );
  // mssql emits 'error' on the pool whenever a connection cannot be ACQUIRED —
  // exactly what a refused login produces for a NEW connection while the pooled
  // ones keep working. LOG IT AND NOTHING ELSE: tearing the pool down here would
  // drain the live connections this fix exists to protect. Without a listener
  // Node re-throws from inside emit() and the line never reaches the log at all.
  pool.on("error", (err) => {
    console.error(`[sql-pool] pool=services pool-error ${new Date().toISOString()}`
      + ` login=${isLoginFailure(err) ? "refused" : "n/a"}`
      + ` tokenExpiresOnTimestamp=${pendingTokenExpiresAt} err=${JSON.stringify(String(err?.message || err))}`);
  });
  return pool;
};

const holder = createPoolHolder({
  label: "services",
  connect: async () => {
    const pool = await connectWithLoginRetry({
      label: "services",
      build: attemptBuild,
      tokenExpiresAt: () => pendingTokenExpiresAt,
      mayTakeFreshCredential: () => freshBound.may(),
    });
    return { pool, tokenExpiresAt: pendingTokenExpiresAt };
  },
});

/**
 * Returns a connected mssql ConnectionPool for the iadm_services database.
 *
 * The pool is reused while its auth token still has >5min of life. Past that it
 * is replaced LAZILY — see createPoolHolder: the live pool keeps serving until
 * the replacement is connected, and if the replacement cannot be built (a
 * refused login) the live pool is handed back rather than drained.
 */
export async function getServicesPool() {
  return holder.get();
}

/**
 * Force the next getServicesPool() call to rebuild from scratch.
 * Used by the request-level retry path when a query fails with a
 * token-expired error mid-flight.
 */
export function invalidateServicesPool() {
  holder.invalidate();
}

export const _servicesFreshBound = freshBound;
export const _servicesHolder = holder;
export { isLoginFailure };
