// Apply migration 107 (F2 Payment Splits — OLIVER side) to
// sql-iadm-prod-cus.iadm_services.
//
// Usage (from C:/dev/iadm/arion-api):
//   NODE_PATH=C:/dev/iadm/arion-api/node_modules node scripts/_apply_107.cjs
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
  "107_oliver_payment_splits.sql"
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

    // ---------- Verification ----------

    // 5a. New oliver.* tables.
    const tables = await pool.request().query(`
      SELECT TABLE_SCHEMA, TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = 'oliver'
        AND TABLE_NAME IN ('payment_milestone','payment_charge')
      ORDER BY TABLE_NAME
    `);
    console.log("\nVerification - oliver.payment_* tables present:");
    console.table(tables.recordset);

    const expectedTables = ["payment_charge", "payment_milestone"];
    const gotTables = tables.recordset.map((r) => r.TABLE_NAME).sort();
    const missingTables = expectedTables.filter((t) => !gotTables.includes(t));
    if (missingTables.length > 0) {
      console.error(`FAIL - missing tables: ${missingTables.join(", ")}`);
      process.exitCode = 1;
      return;
    }

    // 5b. New columns on oliver.quote.
    const quoteCols = await pool.request().query(`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'oliver' AND TABLE_NAME = 'quote'
        AND COLUMN_NAME IN ('payment_split_kind','charge_strategy','currency','tax_cents')
      ORDER BY COLUMN_NAME
    `);
    console.log("\nVerification - oliver.quote new columns:");
    console.table(quoteCols.recordset);

    const expectedQuoteCols = [
      "charge_strategy",
      "currency",
      "payment_split_kind",
      "tax_cents",
    ];
    const gotQuoteCols = quoteCols.recordset.map((r) => r.COLUMN_NAME).sort();
    const missingQuoteCols = expectedQuoteCols.filter(
      (c) => !gotQuoteCols.includes(c)
    );
    if (missingQuoteCols.length > 0) {
      console.error(
        `FAIL - missing oliver.quote columns: ${missingQuoteCols.join(", ")}`
      );
      process.exitCode = 1;
      return;
    }

    // 5c. New columns on oliver.proposal.
    const propCols = await pool.request().query(`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = 'oliver' AND TABLE_NAME = 'proposal'
        AND COLUMN_NAME IN ('payment_split_kind','charge_strategy','currency','tax_cents')
      ORDER BY COLUMN_NAME
    `);
    console.log("\nVerification - oliver.proposal new/existing columns:");
    console.table(propCols.recordset);

    const expectedPropCols = [
      "charge_strategy",
      "currency",
      "payment_split_kind",
      "tax_cents",
    ];
    const gotPropCols = propCols.recordset.map((r) => r.COLUMN_NAME).sort();
    const missingPropCols = expectedPropCols.filter(
      (c) => !gotPropCols.includes(c)
    );
    if (missingPropCols.length > 0) {
      console.error(
        `FAIL - missing oliver.proposal columns: ${missingPropCols.join(", ")}`
      );
      process.exitCode = 1;
      return;
    }

    // 5d. Foreign keys (incl. the deferred circular FK).
    const fks = await pool.request().query(`
      SELECT
        fk.name AS fk_name,
        OBJECT_SCHEMA_NAME(fk.parent_object_id) + '.' + OBJECT_NAME(fk.parent_object_id) AS parent_table,
        OBJECT_SCHEMA_NAME(fk.referenced_object_id) + '.' + OBJECT_NAME(fk.referenced_object_id) AS referenced_table,
        fk.delete_referential_action_desc
      FROM sys.foreign_keys fk
      WHERE fk.parent_object_id IN (
        OBJECT_ID(N'oliver.payment_milestone'),
        OBJECT_ID(N'oliver.payment_charge')
      )
      ORDER BY fk_name
    `);
    console.log("\nForeign keys on payment_* tables:");
    console.table(fks.recordset);

    const fkNames = fks.recordset.map((r) => r.fk_name);
    const expectedFKs = [
      "FK_oliver_payment_charge_milestone",
      "FK_oliver_payment_charge_parent",
      "FK_oliver_payment_milestone_charge",
    ];
    const missingFKs = expectedFKs.filter((f) => !fkNames.includes(f));
    if (missingFKs.length > 0) {
      console.error(`FAIL - missing FKs: ${missingFKs.join(", ")}`);
      process.exitCode = 1;
      return;
    }

    // 5e. Indexes.
    const idx = await pool.request().query(`
      SELECT OBJECT_SCHEMA_NAME(i.object_id) AS schema_name,
             OBJECT_NAME(i.object_id) AS table_name,
             i.name AS index_name,
             i.has_filter
      FROM sys.indexes i
      WHERE i.object_id IN (
        OBJECT_ID(N'oliver.payment_milestone'),
        OBJECT_ID(N'oliver.payment_charge')
      )
        AND i.name LIKE 'IX_payment_%'
      ORDER BY table_name, index_name
    `);
    console.log("\nIndexes on payment_* tables:");
    console.table(idx.recordset);

    // 5f. Check constraints (charge / milestone status enum + parent_kind).
    const checks = await pool.request().query(`
      SELECT cc.name AS check_name,
             OBJECT_SCHEMA_NAME(cc.parent_object_id) + '.' + OBJECT_NAME(cc.parent_object_id) AS parent_table
      FROM sys.check_constraints cc
      WHERE cc.parent_object_id IN (
        OBJECT_ID(N'oliver.payment_milestone'),
        OBJECT_ID(N'oliver.payment_charge'),
        OBJECT_ID(N'oliver.quote'),
        OBJECT_ID(N'oliver.proposal')
      )
        AND cc.name LIKE 'CK_oliver_%payment%'
         OR cc.name LIKE 'CK_oliver_quote_payment%'
         OR cc.name LIKE 'CK_oliver_quote_charge%'
         OR cc.name LIKE 'CK_oliver_proposal_payment%'
         OR cc.name LIKE 'CK_oliver_proposal_charge%'
      ORDER BY parent_table, check_name
    `);
    console.log("\nNew CHECK constraints:");
    console.table(checks.recordset);

    console.log("\nPASS - migration 107 applied and verified.");
  } finally {
    await pool.close();
  }
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
