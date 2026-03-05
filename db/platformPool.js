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

export async function getPlatformPool() {
  if (poolPromise) return poolPromise;

  if (!sqlServer) throw new Error("PLATFORM_SQL_SERVER (or SQL_SERVER) env var is required for arion-api");

  const connectTimeoutMs = Number(process.env.SQL_CONNECT_TIMEOUT_MS || "12000");
  const credential = getCredential();
  const token = await withTimeout(credential.getToken(SQL_SCOPE), connectTimeoutMs, "ManagedIdentity getToken");

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
        throw err;
      }),
    connectTimeoutMs,
    "SQL ConnectionPool.connect"
  );

  return poolPromise;
}
