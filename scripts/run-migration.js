/**
 * One-off migration runner.
 *
 * Usage:
 *   node scripts/run-migration.js <migration-file.sql>
 *
 * Uses AzureCliCredential so whoever is logged in via `az login` runs the
 * migration under their own AAD identity. That identity must be granted AAD
 * admin (or at minimum db_ddladmin) on the target database.
 *
 * Server + database default to sql-iadm-prod-cus / iadm_services.
 * Override via SQL_SERVER / SQL_DATABASE env vars.
 */
import fs from "node:fs/promises";
import path from "node:path";
import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";

const SERVER = process.env.SQL_SERVER || "sql-iadm-prod-cus.database.windows.net";
const DATABASE = process.env.SQL_DATABASE || "iadm_services";
const SCOPE = "https://database.windows.net/.default";

async function main() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error("Usage: node scripts/run-migration.js <migration-file.sql>");
    process.exit(1);
  }
  const fullPath = path.resolve(fileArg);
  const sqlText = await fs.readFile(fullPath, "utf-8");

  console.log(`[migration] server=${SERVER} database=${DATABASE}`);
  console.log(`[migration] file=${fullPath}`);
  console.log(`[migration] size=${sqlText.length} bytes`);

  const credential = new AzureCliCredential();
  const token = await credential.getToken(SCOPE);
  console.log(`[migration] acquired AAD token, expires ${new Date(token.expiresOnTimestamp).toISOString()}`);

  const pool = await new sql.ConnectionPool({
    server: SERVER,
    database: DATABASE,
    options: { encrypt: true },
    connectionTimeout: 15000,
    requestTimeout: 120000,
    authentication: {
      type: "azure-active-directory-access-token",
      options: { token: token.token },
    },
  }).connect();
  console.log("[migration] connected");

  // Split on GO statements if present (none in our migrations, but safe).
  const batches = sqlText.split(/^\s*GO\s*$/gim).map((s) => s.trim()).filter(Boolean);
  console.log(`[migration] ${batches.length} batch(es) to execute`);

  let batchNum = 0;
  for (const batch of batches) {
    batchNum++;
    try {
      console.log(`[migration] executing batch ${batchNum} (${batch.length} bytes)...`);
      await pool.request().batch(batch);
      console.log(`[migration] batch ${batchNum} ✔`);
    } catch (err) {
      console.error(`[migration] batch ${batchNum} FAILED: ${err.message}`);
      await pool.close();
      process.exit(2);
    }
  }

  await pool.close();
  console.log("[migration] done");
}

main().catch((err) => {
  console.error("[migration] fatal:", err);
  process.exit(1);
});
