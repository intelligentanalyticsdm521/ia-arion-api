// Apply migration 106 (consulting Project Hub) to sql-iadm-prod-cus.iadm_services.
//
// Usage (from C:/dev/iadm/arion-api):
//   NODE_PATH=C:/dev/iadm/arion-api/node_modules node scripts/_apply_106.cjs
//
// Auth: DefaultAzureCredential (Azure CLI on dev machine). MI in prod runners.

const sql = require("mssql");
const { DefaultAzureCredential } = require("@azure/identity");
const { readFileSync } = require("fs");
const path = require("path");

const MIGRATION_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "oliver-api",
  "db",
  "migrations",
  "106_consulting_project_hub.sql"
);

const SERVER = "sql-iadm-prod-cus.database.windows.net";
const DATABASE = "iadm_services";

async function main() {
  console.log(`Reading migration: ${MIGRATION_PATH}`);
  const migration = readFileSync(MIGRATION_PATH, "utf8");

  console.log("Acquiring AAD token (DefaultAzureCredential)...");
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken("https://database.windows.net/.default");
  if (!token) {
    throw new Error("Failed to acquire AAD token for sql-iadm-prod-cus");
  }

  console.log(`Connecting to ${SERVER} / ${DATABASE}...`);
  const pool = await new sql.ConnectionPool({
    server: SERVER,
    database: DATABASE,
    options: { encrypt: true, enableArithAbort: true, trustServerCertificate: false },
    authentication: {
      type: "azure-active-directory-access-token",
      options: { token: token.token },
    },
  }).connect();

  try {
    // mssql's pool.batch handles GO-separated batches only via the
    // request().batch(...) API — but it does NOT understand GO. We split
    // manually on lines that are just "GO".
    const batches = migration
      .split(/^\s*GO\s*$/gim)
      .map((b) => b.trim())
      .filter((b) => b.length > 0);

    console.log(`Applying ${batches.length} batches...`);
    let i = 0;
    for (const batch of batches) {
      i += 1;
      const preview = batch.split("\n").find((l) => l.trim().length > 0) || "";
      process.stdout.write(`  [${i}/${batches.length}] ${preview.slice(0, 80)}\n`);
      await pool.request().batch(batch);
    }
    console.log("All batches applied.");

    // Verify all 3 tables exist.
    const verify = await pool.request().query(`
      SELECT TABLE_SCHEMA, TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = 'consulting'
        AND TABLE_NAME IN ('project_category','project','project_milestone')
      ORDER BY TABLE_NAME
    `);
    console.log("\nVerification — consulting.* tables present:");
    console.table(verify.recordset);

    const expected = ["project", "project_category", "project_milestone"];
    const got = verify.recordset.map((r) => r.TABLE_NAME).sort();
    const missing = expected.filter((t) => !got.includes(t));
    if (missing.length > 0) {
      console.error(`FAIL — missing tables: ${missing.join(", ")}`);
      process.exitCode = 1;
      return;
    }

    // Bonus: count seed categories.
    const seedCount = await pool.request().query(`
      SELECT COUNT(*) AS n FROM consulting.project_category WHERE is_system_seed = 1
    `);
    console.log(
      `\nSeed categories present (is_system_seed=1): ${seedCount.recordset[0].n} (expected 12)`
    );

    // Bonus: confirm indexes.
    const idx = await pool.request().query(`
      SELECT OBJECT_SCHEMA_NAME(i.object_id) AS schema_name,
             OBJECT_NAME(i.object_id) AS table_name,
             i.name AS index_name,
             i.has_filter
      FROM sys.indexes i
      WHERE i.object_id IN (
        OBJECT_ID(N'consulting.project'),
        OBJECT_ID(N'consulting.project_milestone')
      )
      AND i.name LIKE 'IX_consulting_%'
      ORDER BY table_name, index_name
    `);
    console.log("\nIndexes:");
    console.table(idx.recordset);

    console.log("\nPASS — migration 106 applied and verified.");
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
