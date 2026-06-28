// Independent re-verification of migration 106 state (adversarial check).
const sql = require("mssql");
const { DefaultAzureCredential } = require("@azure/identity");

const SERVER = "sql-iadm-prod-cus.database.windows.net";
const DATABASE = "iadm_services";

async function main() {
  const credential = new DefaultAzureCredential();
  const token = await credential.getToken("https://database.windows.net/.default");
  if (!token) throw new Error("Token acquisition failed");

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
    // 1) Schema present?
    const schemaQ = await pool.request().query(`SELECT name FROM sys.schemas WHERE name = 'consulting'`);
    console.log("SCHEMA consulting present?", schemaQ.recordset.length === 1);

    // 2) Tables present + matching expected list?
    const tablesQ = await pool.request().query(`
      SELECT TABLE_SCHEMA, TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = 'consulting'
      ORDER BY TABLE_NAME`);
    console.log("TABLES:", tablesQ.recordset.map(r => r.TABLE_NAME).join(","));

    // 3) Critical columns present on consulting.project (verify lumen_contact_id type)?
    const colsQ = await pool.request().query(`
      SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA='consulting' AND TABLE_NAME='project'
      ORDER BY ORDINAL_POSITION`);
    const lcCol = colsQ.recordset.find(r => r.COLUMN_NAME === 'lumen_contact_id');
    console.log("lumen_contact_id column:", JSON.stringify(lcCol));

    // 4) FK target type alignment (claim was lumen.contact.id is INT)
    const lumenColQ = await pool.request().query(`
      SELECT DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA='lumen' AND TABLE_NAME='contact' AND COLUMN_NAME='id'`);
    console.log("lumen.contact.id type:", JSON.stringify(lumenColQ.recordset));

    // 5) Seed count
    const seedQ = await pool.request().query(`SELECT COUNT(*) AS n FROM consulting.project_category WHERE is_system_seed=1`);
    console.log("Seed categories is_system_seed=1:", seedQ.recordset[0].n);

    // 6) Index presence + filter status
    const idxQ = await pool.request().query(`
      SELECT OBJECT_SCHEMA_NAME(i.object_id) AS schema_name,
             OBJECT_NAME(i.object_id) AS table_name,
             i.name AS index_name,
             i.has_filter,
             i.filter_definition
      FROM sys.indexes i
      WHERE i.object_id IN (
        OBJECT_ID(N'consulting.project'),
        OBJECT_ID(N'consulting.project_milestone')
      )
      AND i.name LIKE 'IX_consulting_%'
      ORDER BY table_name, index_name`);
    console.log("INDEXES:");
    for (const r of idxQ.recordset) {
      console.log(`  ${r.table_name}.${r.index_name} has_filter=${r.has_filter} filter=${r.filter_definition}`);
    }

    // 7) Check schema_migrations stamping
    const smQ = await pool.request().query(`
      IF OBJECT_ID(N'db.schema_migrations') IS NOT NULL
        SELECT TOP 5 * FROM db.schema_migrations WHERE migration_id LIKE '%106%' ORDER BY applied_at DESC
      ELSE
        SELECT 'no schema_migrations table' AS note`);
    console.log("schema_migrations 106 rows:", JSON.stringify(smQ.recordset));

    // 8) FK constraints present?
    const fkQ = await pool.request().query(`
      SELECT name, OBJECT_NAME(parent_object_id) AS parent_table, OBJECT_NAME(referenced_object_id) AS referenced_table
      FROM sys.foreign_keys
      WHERE SCHEMA_NAME(schema_id) = 'consulting'
      ORDER BY name`);
    console.log("FKs:");
    for (const r of fkQ.recordset) {
      console.log(`  ${r.name}: ${r.parent_table} -> ${r.referenced_table}`);
    }

    // 9) Sample seed slugs match brief's 12?
    const slugsQ = await pool.request().query(`SELECT slug FROM consulting.project_category WHERE is_system_seed=1 ORDER BY slug`);
    console.log("Seed slugs:", slugsQ.recordset.map(r => r.slug).join(","));
  } finally {
    await pool.close();
  }
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
