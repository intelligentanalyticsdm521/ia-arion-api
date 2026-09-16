import sql from "mssql";
import {
  DefaultAzureCredential,
  AzureCliCredential,
  ManagedIdentityCredential,
} from "@azure/identity";
import dotenv from "dotenv";
import { createPoolRecovery, isLoginFailure } from "./poolRecovery.js";

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
 * A FACTORY, not a cache — and that is load-bearing, not an accident.
 *
 * Both pools call this on every rebuild. An @azure/identity credential keeps
 * its token cache inside the instance, so a NEW instance means a genuinely new
 * token request; that is exactly what an ELOGIN recovery needs, because the
 * whole point of the retry is a token that did NOT come out of the cache Azure
 * SQL has already refused. oliver-api caches its credential and therefore has
 * to call `resetCredential()` from every discard; this repo gets the same
 * property from construction and has nothing to reset.
 *
 * Memoising this for performance would silently make every recovery retry with
 * the refused token. test/pool-recovery.test.mjs holds that line.
 */
export function getCredential() {
  if (authMode === "MANAGED_IDENTITY") return new ManagedIdentityCredential();
  if (authMode === "AZURE_CLI") return new AzureCliCredential();
  return new DefaultAzureCredential();
}

let poolPromise = null;
// Unix-ms timestamp when the cached pool's auth token expires.
// Managed Identity SQL tokens last ~1 hour; we proactively rebuild 5 min
// before expiry so we never serve a request with an expired token.
let poolTokenExpiresAt = 0;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Returns a connected mssql ConnectionPool for the iadm_platform database.
 *
 * Token-expiry handling: the cached pool is reused only while its auth
 * token still has >5min of life. Otherwise we tear down the old pool and
 * build a fresh one. This fixes the long-standing "token is expired" 500s
 * that would surface after the App Service had been running for 1+ hour.
 */
export async function getPlatformPool() {
  if (poolPromise && Date.now() < poolTokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
    return poolPromise;
  }

  if (poolPromise) {
    try {
      const oldPool = await poolPromise;
      oldPool.close().catch(() => {});
    } catch { /* ignore */ }
    poolPromise = null;
    poolTokenExpiresAt = 0;
  }

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
    poolTokenExpiresAt = token.expiresOnTimestamp || (Date.now() + 50 * 60 * 1000);
  } else {
    // SQL auth does not expire the way a bearer token does; keep the pool for
    // a day so the refresh path stays a single code path.
    poolTokenExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
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
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };

  poolPromise = withTimeout(
    new sql.ConnectionPool(config)
      .connect()
      .then((pool) => {
        // mssql emits 'error' on the pool whenever a connection cannot be
        // ACQUIRED — which is precisely what a refused token looks like to the
        // call sites that hold the pool directly and never see a connect
        // error. Without this listener those queries fail forever against a
        // pool nothing ever rebuilds. An unhandled 'error' on an EventEmitter
        // also throws, so this is load-bearing twice over.
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

/**
 * Foundation B — the ONE business profile (core.business_profile), the record
 * the owner fills in on Settings -> Your business and every product reads.
 *
 * Read through the SAME platform pool getSharedProfile already uses, not over
 * HTTP: this process holds a pool to iadm_platform, so an HTTP hop to
 * platform-api would add a network dependency, a token to configure and a new
 * way for site provisioning to fail, in exchange for nothing. platform-api's
 * GET /internal/business-profile/:tenantId exists for the callers that have NO
 * pool (arion-func timers, future agents).
 *
 * Returns null when the table is absent, empty or unreachable — a business
 * that has never opened the page must behave exactly as it does today.
 */
export async function getBusinessProfile(tenantId) {
  if (!tenantId) return null;
  try {
    const pool = await getPlatformPool();
    const r = await pool.request()
      .input("tid", sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT TOP 1 industry, description, tagline, target_audience, brand_voice,
               services_json, services_summary, service_area_json, version, updated_at
        FROM core.business_profile WHERE tenant_id=@tid`);
    return r.recordset[0] || null;
  } catch (e) {
    // Non-fatal by design. Before this table existed the answer was "nothing",
    // and "nothing" is still a correct answer — never a thrown error inside a
    // site build.
    console.warn("[arion platformPool] getBusinessProfile unavailable:", e.message);
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
 * THE discard for this pool: drop the cached pool promise, zero the token
 * expiry, and close the old pool in the background. Takes effect SYNCHRONOUSLY
 * (the close finishes later) so a concurrent caller cannot pick the poisoned
 * pool back up, and the next getPlatformPool() takes its token from a NEW
 * credential instance (getCredential is a factory — see its comment).
 *
 * Was a dead export until 2026-09-16; it is now the primitive the ELOGIN
 * recovery below is built on.
 */
export function invalidatePlatformPool() {
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
  label: "platform",
  connect: () => getPlatformPool(),
  discard: () => invalidatePlatformPool(),
  tokenExpiresAt: () => poolTokenExpiresAt,
});

/**
 * Run `fn(pool)` against the platform database, recovering ONCE from a refused
 * login (a managed-identity token Azure SQL will not accept) by discarding the
 * pool, taking a new token from a new credential and retrying. A second failure
 * throws the ORIGINAL error; a non-login error is never retried.
 */
export function withPlatformPool(fn) {
  return recovery.withPool(fn);
}

/** Test hooks — no production path reads these. */
export const _platformRecovery = recovery;
export { isLoginFailure };
