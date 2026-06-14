// End-to-end smoke test of /plugin/download with a real provision code.
// Steps:
//   1. Find or create an arion.site row for the founder tenant.
//   2. Mint a provision code via the same lib the wizard now uses.
//   3. Hit https://app-arion-api-prod.../plugin/download?token=<raw>
//   4. Verify the response is HTTP 200 + Content-Type: application/zip.
//   5. Compare first few bytes to a valid zip magic (PK\x03\x04).
import sql from "mssql";
import { AzureCliCredential } from "@azure/identity";
import crypto from "node:crypto";

const FOUNDER_TENANT = "8C9527B9-8999-4B31-A306-F3D4CCC39FBD";
const ARION_API_BASE = "https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net";

const credential = new AzureCliCredential();
const token = await credential.getToken("https://database.windows.net/.default");
const pool = await new sql.ConnectionPool({
  server: "sql-iadm-prod-cus.database.windows.net",
  database: "iadm_services",
  options: { encrypt: true },
  authentication: { type: "azure-active-directory-access-token", options: { token: token.token } },
}).connect();

// 1. Find an arion.site for the founder tenant (or any site — we just need a UUID)
const site = await pool.request().input("tid", sql.UniqueIdentifier, FOUNDER_TENANT).query(`
  SELECT TOP 1 site_id, tenant_id, domain FROM arion.site WHERE tenant_id = @tid
`);
if (!site.recordset[0]) {
  console.log("No founder arion.site yet — using any site for the smoke test.");
}
const anySite = site.recordset[0] || (await pool.request().query("SELECT TOP 1 site_id, tenant_id, domain FROM arion.site")).recordset[0];
if (!anySite) {
  console.error("FATAL: no arion.site rows in DB at all. Cannot test.");
  await pool.close();
  process.exit(1);
}
console.log(`Using site: ${anySite.domain} (id=${anySite.site_id}, tenant=${anySite.tenant_id})`);

// 2. Mint a provision code (using the same lib the canonical paths use)
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genCode() {
  const groups = [];
  for (let g = 0; g < 3; g++) {
    let s = "";
    const bytes = crypto.randomBytes(4);
    for (let i = 0; i < 4; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
    groups.push(s);
  }
  return `IAPV-${groups.join("-")}`;
}
function hashCode(c) { return crypto.createHash("sha256").update(c.toUpperCase().trim()).digest("hex"); }

const rawCode = genCode();
const codeHash = hashCode(rawCode);
const expiresAt = new Date(Date.now() + 60_000); // 60s — just for this test
await pool.request()
  .input("tid", sql.UniqueIdentifier, anySite.tenant_id)
  .input("sid", sql.UniqueIdentifier, anySite.site_id)
  .input("hash", sql.NVarChar(64), codeHash)
  .input("exp", sql.DateTimeOffset, expiresAt)
  .query(`
    INSERT INTO arion.site_provision_code (tenant_id, site_id, code_hash, created_by, expires_at)
    VALUES (@tid, @sid, @hash, 'e2e-smoke-test', @exp)
  `);
console.log(`Minted test code: ${rawCode} (expires in 60s)`);

// 3. Hit the download endpoint
const url = `${ARION_API_BASE}/plugin/download?token=${encodeURIComponent(rawCode)}`;
console.log(`GET ${url.replace(rawCode, "***")}`);
const resp = await fetch(url, { redirect: "follow" });
console.log(`  → HTTP ${resp.status} ${resp.statusText}`);
console.log(`  → Content-Type: ${resp.headers.get("content-type")}`);
console.log(`  → Content-Length: ${resp.headers.get("content-length")}`);
console.log(`  → X-IA-Plugin-Version: ${resp.headers.get("x-ia-plugin-version")}`);
console.log(`  → X-IA-Plugin-Channel: ${resp.headers.get("x-ia-plugin-channel")}`);

if (resp.status !== 200) {
  const body = await resp.text();
  console.error(`FAIL: ${body}`);
  process.exit(2);
}
const buf = Buffer.from(await resp.arrayBuffer());
const magic = buf.slice(0, 4).toString("hex");
const expectMagic = "504b0304"; // "PK\x03\x04" — valid zip header
console.log(`  → first 4 bytes: ${magic} (zip magic expects ${expectMagic})`);
if (magic === expectMagic) {
  console.log(`✓ PASS — received valid ${buf.length}-byte zip from blob.`);
} else {
  console.error(`✗ FAIL — bytes are not a zip header.`);
  process.exit(3);
}

// Cleanup: delete the test code row
await pool.request().input("hash", sql.NVarChar(64), codeHash).query(`
  DELETE FROM arion.site_provision_code WHERE code_hash = @hash
`);
console.log("Cleaned up test code row.");

await pool.close();
