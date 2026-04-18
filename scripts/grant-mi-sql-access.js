/**
 * Grant a Function App's system-assigned managed identity access to a SQL DB.
 *
 * Run as the SQL AAD admin (you — `az login` first).
 *
 * Usage:
 *   node scripts/grant-mi-sql-access.js <principalName> [role1 role2 ...]
 *
 * Notes:
 *   - For SQL AAD "user from external provider" the username is the function
 *     app's NAME (e.g. "func-iadm-arion-prod"), not the principalId.
 *   - Default roles: db_datareader + db_datawriter.
 */
import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";

const SERVER = process.env.SQL_SERVER || "sql-iadm-prod-cus.database.windows.net";
const DATABASE = process.env.SQL_DATABASE || "iadm_services";

const principalName = process.argv[2];
if (!principalName) {
  console.error("Usage: node scripts/grant-mi-sql-access.js <principalName> [role1 role2 ...]");
  process.exit(1);
}
const roles = process.argv.slice(3);
const effectiveRoles = roles.length > 0 ? roles : ["db_datareader", "db_datawriter"];

const credential = new AzureCliCredential();
const token = await credential.getToken("https://database.windows.net/.default");

const pool = await new sql.ConnectionPool({
  server: SERVER,
  database: DATABASE,
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();

console.log(`[grant] Creating AAD user [${principalName}] in ${DATABASE} if not exists`);
await pool.request().batch(`
  IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'${principalName}')
    CREATE USER [${principalName}] FROM EXTERNAL PROVIDER;
`);
console.log(`[grant] AAD user ensured`);

for (const role of effectiveRoles) {
  console.log(`[grant] Adding [${principalName}] to role ${role}`);
  await pool.request().batch(`
    ALTER ROLE ${role} ADD MEMBER [${principalName}];
  `);
  console.log(`[grant] ${role} ✔`);
}

await pool.close();
console.log(`[grant] done`);
