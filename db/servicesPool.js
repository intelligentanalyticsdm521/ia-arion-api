import sql from "mssql";
import { getCredential, SQL_SCOPE } from "./platformPool.js";
import { createPoolRecovery, isLoginFailure } from "./poolRecovery.js";

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

let poolPromise = null;
// Unix-ms timestamp when the cached pool's auth token expires.
// Managed Identity SQL tokens last ~1 hour; we proactively rebuild 5 min
// before expiry so we never serve a request with an expired token.
let poolTokenExpiresAt = 0;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Returns a connected mssql ConnectionPool for the iadm_services database.
 *
 * Token-expiry handling: the cached pool is reused only while its auth
 * token still has >5min of life. Otherwise we tear down the old pool and
 * build a fresh one. This fixes the long-standing "token is expired" 500s
 * that would surface after the App Service had been running for 1+ hour.
 */
export async function getServicesPool() {
  if (poolPromise && Date.now() < poolTokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return poolPromise;
  }

  // Token expired or expiring soon — drop the old pool first
  if (poolPromise) {
    try {
      const oldPool = await poolPromise;
      oldPool.close().catch(() => {});
    } catch { /* ignore */ }
    poolPromise = null;
    poolTokenExpiresAt = 0;
  }

  if (!sqlServer) throw new Error("SERVICES_SQL_SERVER (or SQL_SERVER) env var is required for arion-api");

  const connectTimeoutMs = Number(process.env.SQL_CONNECT_TIMEOUT_MS || "12000");
  const credential = getCredential();
  const token = await withTimeout(credential.getToken(SQL_SCOPE), connectTimeoutMs, "ManagedIdentity getToken");

  // Record when this token expires so we can preemptively rebuild
  poolTokenExpiresAt = token.expiresOnTimestamp || (Date.now() + 50 * 60 * 1000);

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
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };

  poolPromise = withTimeout(
    new sql.ConnectionPool(config)
      .connect()
      .then((pool) => {
        // mssql emits 'error' on the pool whenever a connection cannot be
        // ACQUIRED — precisely what a refused token looks like to the call
        // sites that hold the pool directly and never see a connect error.
        // Without this listener those queries fail forever against a pool
        // nothing ever rebuilds. An unhandled 'error' on an EventEmitter also
        // throws, so this is load-bearing twice over.
        pool.on("error", (err) => recovery.onPoolError(err));
        return pool;
      })
      .catch((err) => {
        poolPromise = null;
        poolTokenExpiresAt = 0;
        throw err;
      }),
    connectTimeoutMs,
    "SQL ConnectionPool.connect"
  );

  return poolPromise;
}

/**
 * THE discard for this pool: drop the cached pool promise, zero the token
 * expiry, and close the old pool in the background. Takes effect SYNCHRONOUSLY
 * (the close finishes later) so a concurrent caller cannot pick the poisoned
 * pool back up, and the next getServicesPool() takes its token from a NEW
 * credential instance (getCredential is a factory — see its comment in
 * db/platformPool.js).
 */
export function invalidateServicesPool() {
  if (poolPromise) {
    poolPromise.then((p) => p.close().catch(() => {})).catch(() => {});
  }
  poolPromise = null;
  poolTokenExpiresAt = 0;
}

// ── ELOGIN recovery ──────────────────────────────────────────────────────────
// One shared helper (db/poolRecovery.js); this module only supplies the four
// things that differ per pool. See that file for the incident this exists for.
const recovery = createPoolRecovery({
  label: "services",
  connect: () => getServicesPool(),
  discard: () => invalidateServicesPool(),
  tokenExpiresAt: () => poolTokenExpiresAt,
});

/**
 * Run `fn(pool)` against the services database, recovering ONCE from a refused
 * login by discarding the pool, taking a new token from a new credential and
 * retrying. A second failure throws the ORIGINAL error; a non-login error is
 * never retried.
 */
export function withServicesPool(fn) {
  return recovery.withPool(fn);
}

/** Test hooks — no production path reads these. */
export const _servicesRecovery = recovery;
export { isLoginFailure };
