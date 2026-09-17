// db/platformPool.js — the iadm_platform pool (and the shared credential).
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
import {
  DefaultAzureCredential,
  AzureCliCredential,
  ManagedIdentityCredential,
} from "@azure/identity";
import dotenv from "dotenv";
import {
  connectWithLoginRetry,
  createFreshCredentialBound,
  createPoolHolder,
  poolSizingOptions,
  tarnLoginRetryOptions,
  isLoginFailure,
} from "./poolRecovery.js";

dotenv.config();

const authMode = process.env.AUTH_MODE || "LOCAL_DEV";
const sqlServer = process.env.PLATFORM_SQL_SERVER || process.env.SQL_SERVER;
const sqlDatabase = process.env.PLATFORM_SQL_DATABASE || "iadm_platform";

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

export const SQL_SCOPE = "https://database.windows.net/.default";

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

/**
 * A FACTORY, deliberately: a NEW @azure/identity credential on every call, each
 * with its own empty token cache, so every login-retry attempt presents a
 * genuinely new token rather than the one Azure SQL has already refused.
 * oliver-api caches this and has to call resetCredential() on its 3rd attempt to
 * buy the same property; this repo has it structurally. Do NOT memoise it —
 * test/pool-login-retry.test.js pins it for exactly that reason.
 */
export function getCredential() {
  if (authMode === "MANAGED_IDENTITY") return new ManagedIdentityCredential();
  if (authMode === "AZURE_CLI") return new AzureCliCredential();
  return new DefaultAzureCredential();
}

// At most one forced fresh-credential build per pool per 30s, so a genuinely
// broken identity cannot become a token-fetch storm against IMDS.
const freshBound = createFreshCredentialBound();

// Expiry of the token the build currently in flight is presenting. Promoted to
// the holder's own expiry only when that build SUCCEEDS — a failed rebuild must
// never leave the app believing the pool it is still serving from was reissued.
let pendingTokenExpiresAt = 0;

/**
 * ONE attempt at building the pool. Called up to 4 times, 400ms apart, by
 * connectWithLoginRetry. See getCredential() on why no credential is dropped.
 */
const attemptBuild = async (attempt) => {
  if (!sqlServer) throw new Error("PLATFORM_SQL_SERVER (or SQL_SERVER) env var is required for arion-api");

  const connectTimeoutMs = Number(process.env.SQL_CONNECT_TIMEOUT_MS || "12000");

  // Only reach for an Entra token when the connection will actually USE one.
  // The config below already branches on useSqlAuth, but this fetch did not:
  // with SQL_USER/SQL_PASSWORD set for local dev the token was discarded and
  // yet still had to succeed, so every request died on
  // "ChainedTokenCredential authentication failed" and surfaced as
  // "dev auth failed". Same defect as oliver-api's platformPool.
  let token = null;
  if (!useSqlAuth) {
    const credential = getCredential();
    token = await withTimeout(credential.getToken(SQL_SCOPE), connectTimeoutMs, "ManagedIdentity getToken");
    pendingTokenExpiresAt = token.expiresOnTimestamp || (Date.now() + 50 * 60 * 1000);
  } else {
    // SQL auth does not expire the way a bearer token does; keep the pool for
    // a day so the refresh path stays a single code path.
    pendingTokenExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
  }

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
    console.error(`[sql-pool] pool=platform pool-error ${new Date().toISOString()}`
      + ` login=${isLoginFailure(err) ? "refused" : "n/a"}`
      + ` tokenExpiresOnTimestamp=${pendingTokenExpiresAt} err=${JSON.stringify(String(err?.message || err))}`);
  });
  return pool;
};

const holder = createPoolHolder({
  label: "platform",
  connect: async () => {
    const pool = await connectWithLoginRetry({
      label: "platform",
      build: attemptBuild,
      tokenExpiresAt: () => pendingTokenExpiresAt,
      mayTakeFreshCredential: () => freshBound.may(),
    });
    return { pool, tokenExpiresAt: pendingTokenExpiresAt };
  },
});

/**
 * Returns a connected mssql ConnectionPool for the iadm_platform database.
 *
 * The pool is reused while its auth token still has >5min of life. Past that it
 * is replaced LAZILY — see createPoolHolder: the live pool keeps serving until
 * the replacement is connected, and if the replacement cannot be built (a
 * refused login) the live pool is handed back rather than drained.
 */
export async function getPlatformPool() {
  return holder.get();
}

/**
 * The shared org/business profile from core.tenants — the SINGLE source of
 * truth shared across OLIVER / SPARK / ARION (same record OLIVER reads in
 * oliver-api/routes/onboarding.js). Returns null if absent or unavailable;
 * onboarding must never break because the platform DB is unreachable.
 */
export async function getSharedProfile(tenantId) {
  if (!tenantId) return null;
  try {
    const pool = await getPlatformPool();
    const r = await pool.request()
      .input("tid", sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT TOP 1 business_name, full_name, primary_contact_email,
               primary_contact_phone, website_url, logo_url, brand_color,
               address_line1, city, state_province, postal_code, country_region
        FROM core.tenants WHERE tenant_id=@tid`);
    return r.recordset[0] || null;
  } catch (e) {
    console.warn("[arion platformPool] getSharedProfile failed:", e.message);
    return null;
  }
}

// API field → core.tenants column + max length. Only the CANONICAL org fields
// ARION onboarding can supply; ARION-specific website answers (industry,
// services, pages, voice…) stay ARION-local and are NOT written here.
const SHARED_PROFILE_COLUMNS = {
  businessName: { col: "business_name", len: 1000 },
  brandColor:   { col: "brand_color",   len: 20 },
  websiteUrl:   { col: "website_url",   len: 500 },
};

/**
 * Write canonical org fields back to the shared core.tenants record. Returns
 * true on success, false on any failure — callers MUST treat this as
 * best-effort so a platform-DB hiccup never blocks site provisioning.
 */
export async function updateSharedProfile(tenantId, fields) {
  if (!tenantId || !fields || typeof fields !== "object") return false;
  try {
    const sets = [];
    const pool = await getPlatformPool();
    const reqDb = pool.request().input("tid", sql.UniqueIdentifier, tenantId);
    for (const [apiKey, def] of Object.entries(SHARED_PROFILE_COLUMNS)) {
      if (!(apiKey in fields)) continue;
      let v = fields[apiKey];
      if (v === undefined || v === null) continue;
      v = String(v).trim();
      if (v === "") continue;
      if (v.length > def.len) v = v.slice(0, def.len);
      const p = `p_${apiKey}`;
      sets.push(`${def.col} = @${p}`);
      reqDb.input(p, sql.NVarChar(def.len), v);
    }
    if (sets.length === 0) return false;
    await reqDb.query(`
      UPDATE core.tenants
         SET ${sets.join(", ")}
       WHERE tenant_id = @tid`);
    return true;
  } catch (e) {
    console.warn("[arion platformPool] updateSharedProfile failed:", e.message);
    return false;
  }
}

/**
 * Force the next getPlatformPool() call to rebuild from scratch.
 */
export function invalidatePlatformPool() {
  holder.invalidate();
}

export const _platformFreshBound = freshBound;
export const _platformHolder = holder;
export { isLoginFailure };
