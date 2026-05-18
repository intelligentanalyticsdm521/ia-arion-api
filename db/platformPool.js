import sql from "mssql";
import {
  DefaultAzureCredential,
  AzureCliCredential,
  ManagedIdentityCredential,
} from "@azure/identity";
import dotenv from "dotenv";

dotenv.config();

const authMode = process.env.AUTH_MODE || "LOCAL_DEV";
const sqlServer = process.env.PLATFORM_SQL_SERVER || process.env.SQL_SERVER;
const sqlDatabase = process.env.PLATFORM_SQL_DATABASE || "iadm_platform";

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
  const credential = getCredential();
  const token = await withTimeout(credential.getToken(SQL_SCOPE), connectTimeoutMs, "ManagedIdentity getToken");

  poolTokenExpiresAt = token.expiresOnTimestamp || (Date.now() + 50 * 60 * 1000);

  const config = {
    server: sqlServer,
    database: sqlDatabase,
    options: { encrypt: true },
    connectionTimeout: connectTimeoutMs,
    requestTimeout: Number(process.env.SQL_REQUEST_TIMEOUT_MS || "15000"),
    authentication: {
      type: "azure-active-directory-access-token",
      options: { token: token.token },
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  };

  poolPromise = withTimeout(
    new sql.ConnectionPool(config)
      .connect()
      .then((pool) => pool)
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
  if (poolPromise) {
    poolPromise.then((p) => p.close().catch(() => {})).catch(() => {});
  }
  poolPromise = null;
  poolTokenExpiresAt = 0;
}
