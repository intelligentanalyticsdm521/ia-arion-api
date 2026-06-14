/**
 * Azure Blob helper — SAS URL signing for plugin downloads.
 * --------------------------------------------------------------------------
 * Used by the onboarding flow to hand wp-cli a short-lived URL to install
 * paid plugins (Elementor Pro) from our private Azure Blob container.
 *
 * Auth model: storage account key from KV (`STIADMPROD-ACCOUNT-KEY`) — the
 * arion-api MI does NOT have RBAC on the storage account (granting RBAC
 * requires Owner on the subscription which Brandon doesn't have). Key-auth
 * sidesteps that and is just as secure given the key lives in KV.
 *
 * Container layout:
 *   plugins/
 *     elementor-pro/
 *       elementor-pro-<version>.zip   versioned, immutable
 *       elementor-pro-latest.zip      alias for the install code
 *       manifest.json                 {"plugin", "current_version", "uploaded_at"}
 */

import {
  BlobServiceClient,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
} from '@azure/storage-blob';
import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';

const KV_URI = process.env.KEY_VAULT_URI || 'https://kv-iadm-prod.vault.azure.net/';
const ACCOUNT = process.env.PLUGIN_BLOB_ACCOUNT || 'stiadmprod';
const CONTAINER = process.env.PLUGIN_BLOB_CONTAINER || 'plugins';

let _kv = null;
function kv() {
  if (!_kv) _kv = new SecretClient(KV_URI, new DefaultAzureCredential());
  return _kv;
}

let _credCache = null;
const CRED_TTL_MS = 60 * 60 * 1000;

async function getAccountKey() {
  if (_credCache && Date.now() - _credCache.ts < CRED_TTL_MS) return _credCache.value;
  // App Setting STIADMPROD_ACCOUNT_KEY is a KV reference; resolve via env first.
  // Falls back to direct KV fetch when the env var isn't a resolved KV ref.
  const fromEnv = process.env.STIADMPROD_ACCOUNT_KEY;
  if (fromEnv && fromEnv.length > 30 && !fromEnv.startsWith('@Microsoft.KeyVault')) {
    _credCache = { value: fromEnv, ts: Date.now() };
    return fromEnv;
  }
  const secret = await kv().getSecret('STIADMPROD-ACCOUNT-KEY');
  _credCache = { value: secret.value, ts: Date.now() };
  return secret.value;
}

/**
 * Sign a short-lived (1h) read SAS URL for a blob in our plugin container.
 * Caller passes the blob path within the container, e.g.
 *   "elementor-pro/elementor-pro-latest.zip"
 *
 * @param {string} blobPath
 * @param {number} [ttlMinutes=60]
 * @returns {Promise<string>}
 */
export async function signPluginUrl(blobPath, ttlMinutes = 60) {
  const accountKey = await getAccountKey();
  const cred = new StorageSharedKeyCredential(ACCOUNT, accountKey);
  const now = new Date();
  const expiresOn = new Date(now.getTime() + ttlMinutes * 60 * 1000);
  // Start 5 minutes in the past to avoid clock-skew rejections on Hostinger.
  const startsOn = new Date(now.getTime() - 5 * 60 * 1000);

  const sas = generateBlobSASQueryParameters(
    {
      containerName: CONTAINER,
      blobName: blobPath,
      permissions: BlobSASPermissions.parse('r'),
      startsOn,
      expiresOn,
      protocol: 'https',
      // Pin the SAS API version to a known-stable release. The SDK defaults
      // to its latest supported version, which can be ahead of what the
      // storage account accepts and returns Forbidden on the download.
      version: '2022-11-02',
    },
    cred,
  ).toString();

  return `https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/${encodeURI(blobPath)}?${sas}`;
}

/**
 * Read a small JSON file from the plugin container (manifest etc).
 * Used to discover the current version of a paid plugin without hardcoding it.
 *
 * @param {string} blobPath
 * @returns {Promise<object>}
 */
export async function readPluginJson(blobPath) {
  const accountKey = await getAccountKey();
  const cred = new StorageSharedKeyCredential(ACCOUNT, accountKey);
  const svc = new BlobServiceClient(
    `https://${ACCOUNT}.blob.core.windows.net`,
    cred,
  );
  const blob = svc.getContainerClient(CONTAINER).getBlobClient(blobPath);
  const buf = await blob.downloadToBuffer();
  return JSON.parse(buf.toString('utf8'));
}

export default { signPluginUrl, readPluginJson };
