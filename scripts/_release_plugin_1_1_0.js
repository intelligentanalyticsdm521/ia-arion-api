// One-off: register IA Plugin 1.1.0 on the LATEST channel.
// Manual release performed 2026-06-20 by Brandon.
//
// Idempotent: if (channel='latest', version='1.1.0') already exists, no-op.
// Otherwise: mark all 'latest' rows is_current=0, INSERT 1.1.0 as is_current=1.
import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";

const SHA256 = process.argv[2];
if (!SHA256 || !/^[0-9a-f]{64}$/i.test(SHA256)) {
  console.error("usage: node _release_plugin_1_1_0.js <sha256-hex>");
  process.exit(2);
}

const credential = new AzureCliCredential();
const token = await credential.getToken("https://database.windows.net/.default");
const pool = await new sql.ConnectionPool({
  server: "sql-iadm-prod-cus.database.windows.net",
  database: "iadm_services",
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();

console.log("Before:");
console.table((await pool.request().query(`
  SELECT version_id, version, channel, blob_path, sha256, is_current, released_at, released_by
  FROM arion.plugin_version
  WHERE channel = 'latest'
  ORDER BY released_at DESC
`)).recordset);

const tx = new sql.Transaction(pool);
await tx.begin();
try {
  // Idempotency check
  const existing = await new sql.Request(tx)
    .input("ver", sql.NVarChar(40), "1.1.0")
    .input("chan", sql.NVarChar(20), "latest")
    .query(`SELECT version_id FROM arion.plugin_version WHERE channel = @chan AND version = @ver`);

  if (existing.recordset.length > 0) {
    console.log("\n(channel='latest', version='1.1.0') already exists — no insert performed.");
    await tx.commit();
  } else {
    // Demote all current 'latest' rows
    await new sql.Request(tx)
      .input("chan", sql.NVarChar(20), "latest")
      .query(`UPDATE arion.plugin_version SET is_current = 0 WHERE channel = @chan`);

    // Insert the new release
    await new sql.Request(tx)
      .input("ver", sql.NVarChar(40), "1.1.0")
      .input("chan", sql.NVarChar(20), "latest")
      .input("blob", sql.NVarChar(255), "intelligent-analytics-latest.zip")
      .input("sha", sql.NVarChar(64), SHA256.toLowerCase())
      .input("relBy", sql.NVarChar(255), "manual:brandon-2026-06-20")
      .query(`
        INSERT INTO arion.plugin_version (version, channel, blob_path, sha256, released_by, is_current)
        VALUES (@ver, @chan, @blob, @sha, @relBy, 1)
      `);

    await tx.commit();
    console.log("\nInserted 1.1.0 on latest channel.");
  }
} catch (e) {
  await tx.rollback();
  throw e;
}

console.log("\nAfter (TOP 5):");
console.table((await pool.request().query(`
  SELECT TOP 5 version_id, version, channel, blob_path, sha256, is_current, released_at, released_by
  FROM arion.plugin_version
  WHERE channel = 'latest'
  ORDER BY released_at DESC
`)).recordset);

await pool.close();
console.log("Done.");
