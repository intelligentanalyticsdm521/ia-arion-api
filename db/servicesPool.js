import sql from "mssql";
import { getCredential, SQL_SCOPE } from "./platformPool.js";

const sqlServer = process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER;
const sqlDatabase = process.env.SERVICES_SQL_DATABASE || "iadm_services";

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

export async function getServicesPool() {
  if (poolPromise) return poolPromise;

  if (!sqlServer) throw new Error("SERVICES_SQL_SERVER (or SQL_SERVER) env var is required for arion-api");

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
