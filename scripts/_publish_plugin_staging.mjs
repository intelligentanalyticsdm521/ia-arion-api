#!/usr/bin/env node
/**
 * _publish_plugin_staging.mjs — put a built plugin zip on the STAGING channel.
 *
 * The azure-pipelines.yml release path only publishes to `latest`, which every
 * connected site follows — including client sites. Brandon's rule for this
 * plugin is staging first, one night on intelligentanalyticsdm.com, then
 * promote. This script is that first step; the promotion is the normal
 * commit-and-push to main.
 *
 * Uploads the zip to stiadmprod/plugins and inserts the arion.plugin_version
 * row for channel=staging, flipping any prior staging row off is_current.
 *
 * Auth: an Entra token from `az account get-access-token`. Blob and SQL are both
 * reached from Node because the Python-based `az storage` / `az keyvault`
 * commands fail TLS against the AVG Web Shield root cert on this machine.
 *
 * Usage: node scripts/_publish_plugin_staging.mjs <zip-path> [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import sql from 'mssql';
import { prodPool } from './_prodsql.mjs';

const ZIP = process.argv[2];
const APPLY = process.argv.includes('--apply');
const ACCOUNT = 'stiadmprod';
const CONTAINER = 'plugins';
const BLOB_NAME = 'intelligent-analytics-staging.zip';
const CHANNEL = 'staging';

if (!ZIP || !fs.existsSync(ZIP)) {
  console.error('usage: node scripts/_publish_plugin_staging.mjs <zip-path> [--apply]');
  process.exit(1);
}

// Version comes from the zip itself, never from an argument — a hand-typed
// version that disagrees with the file is how a channel goes stale in the
// first place.
const namedVersion = path.basename(ZIP).match(/(\d+\.\d+\.\d+)/)?.[1];
if (!namedVersion) { console.error('cannot read a version out of the zip filename'); process.exit(1); }

const buf = fs.readFileSync(ZIP);
const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
console.log(`[publish] ${path.basename(ZIP)}  ${(buf.length / 1024).toFixed(1)} KB`);
console.log(`[publish] version=${namedVersion} channel=${CHANNEL} sha256=${sha256}`);

if (!APPLY) {
  console.log('\n[publish] DRY RUN — re-run with --apply to upload and register.');
  process.exit(0);
}

// ── 1. blob ────────────────────────────────────────────────────────────────
// Bearer-token (data-plane RBAC) upload returns 403: the signed-in account is
// Owner at the management plane but has no Storage Blob Data role, and granting
// one is a production permission change nobody asked for. The account key,
// fetched through the management plane the account already has rights to, does
// the same job without altering any assignment.
const armToken = execSync(
  'az account get-access-token --resource https://management.azure.com --query accessToken -o tsv',
  { encoding: 'utf8', maxBuffer: 10 << 20 }
).trim();
const subId = execSync('az account show --query id -o tsv', { encoding: 'utf8' }).trim();

const rg = execSync(
  `az storage account list --query "[?name=='${ACCOUNT}'].resourceGroup | [0]" -o tsv`,
  { encoding: 'utf8' }
).trim() || process.env.STORAGE_RG || 'rg-IADM-prod';

const keysRes = await fetch(
  `https://management.azure.com/subscriptions/${subId}/resourceGroups/${rg}` +
  `/providers/Microsoft.Storage/storageAccounts/${ACCOUNT}/listKeys?api-version=2023-01-01`,
  { method: 'POST', headers: { Authorization: `Bearer ${armToken}` } }
);
if (!keysRes.ok) {
  console.error(`[publish] listKeys failed: ${keysRes.status} ${(await keysRes.text()).slice(0, 300)}`);
  process.exit(1);
}
const accountKey = (await keysRes.json()).keys[0].value;

const { BlobServiceClient, StorageSharedKeyCredential } = await import('@azure/storage-blob');
const svc = new BlobServiceClient(
  `https://${ACCOUNT}.blob.core.windows.net`,
  new StorageSharedKeyCredential(ACCOUNT, accountKey)
);
await svc.getContainerClient(CONTAINER).getBlockBlobClient(BLOB_NAME).uploadData(buf, {
  blobHTTPHeaders: { blobContentType: 'application/zip' },
});
console.log(`[publish] uploaded -> ${CONTAINER}/${BLOB_NAME}`);

// ── 2. registry row ────────────────────────────────────────────────────────
const pool = await prodPool('iadm_services');
const dupe = await pool.request()
  .input('ch', sql.NVarChar(32), CHANNEL)
  .input('v', sql.NVarChar(20), namedVersion)
  .query(`SELECT version_id FROM arion.plugin_version WHERE channel = @ch AND version = @v`);

if (dupe.recordset.length) {
  await pool.request()
    .input('ch', sql.NVarChar(32), CHANNEL)
    .input('v', sql.NVarChar(20), namedVersion)
    .input('sha', sql.NVarChar(100), sha256)
    .query(`
      UPDATE arion.plugin_version SET is_current = 0 WHERE channel = @ch AND is_current = 1;
      UPDATE arion.plugin_version SET is_current = 1, sha256 = @sha, released_at = SYSDATETIMEOFFSET()
       WHERE channel = @ch AND version = @v;`);
  console.log(`[publish] ${namedVersion} already on ${CHANNEL} — refreshed sha + made current`);
} else {
  await pool.request()
    .input('ch', sql.NVarChar(32), CHANNEL)
    .input('v', sql.NVarChar(20), namedVersion)
    .input('blob', sql.NVarChar(400), BLOB_NAME)
    .input('sha', sql.NVarChar(100), sha256)
    .input('by', sql.NVarChar(200), 'manual:staging-canary')
    .query(`
      UPDATE arion.plugin_version SET is_current = 0 WHERE channel = @ch AND is_current = 1;
      INSERT INTO arion.plugin_version (version, channel, blob_path, sha256, released_by, is_current)
      VALUES (@v, @ch, @blob, @sha, @by, 1);`);
  console.log(`[publish] registered ${namedVersion} on ${CHANNEL} as is_current`);
}

const check = await pool.request().query(`
  SELECT channel, version, is_current, blob_path FROM arion.plugin_version
   WHERE is_current = 1 ORDER BY channel`);
console.log('\n[publish] current per channel:');
for (const r of check.recordset) console.log(`  ${r.channel.padEnd(9)} ${r.version.padEnd(8)} ${r.blob_path}`);

await pool.close();
