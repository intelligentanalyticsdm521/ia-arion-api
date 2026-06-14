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
} from '@azure/storage-blob';
import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';
import crypto from 'node:crypto';

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

// Pinned SAS service version. The @azure/storage-blob SDK defaults to its
// shipped SERVICE_VERSION constant (currently 2026-02-06), which Azure
// Storage rejects with "Forbidden" if it hasn't rolled the new version out
// to our account yet. The version field on BlobSASSignatureValues is honored
// internally for signing but not always reflected in the serialized
// `sv=` query parameter. We sign by hand instead — small and stable.
const SAS_VERSION = '2022-11-02';

function fmtIsoNoMs(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Sign a short-lived (1h) read SAS URL for a blob in our plugin container.
 * Caller passes the blob path within the container, e.g.
 *   "elementor-pro/elementor-pro-latest.zip"
 *
 * Hand-rolled because the SDK's serializer ignores the `version` override
 * and pins the SAS to whatever SERVICE_VERSION ships in the installed SDK,
 * which is ahead of what our storage account currently accepts.
 *
 * @param {string} blobPath
 * @param {number} [ttlMinutes=60]
 * @returns {Promise<string>}
 */
export async function signPluginUrl(blobPath, ttlMinutes = 60) {
  const accountKey = await getAccountKey();
  const now = new Date();
  const expiresOn = new Date(now.getTime() + ttlMinutes * 60 * 1000);
  const startsOn = new Date(now.getTime() - 5 * 60 * 1000);

  const st = fmtIsoNoMs(startsOn);
  const se = fmtIsoNoMs(expiresOn);
  const sp = 'r';
  const sr = 'b';
  const spr = 'https';
  const sv = SAS_VERSION;
  const canonicalizedResource = `/blob/${ACCOUNT}/${CONTAINER}/${blobPath}`;

  // Per Azure REST docs, string-to-sign order for service SAS (2020-12-06+):
  // signedPermissions \n signedStart \n signedExpiry \n canonicalizedResource \n
  // signedIdentifier \n signedIP \n signedProtocol \n signedVersion \n
  // signedResource \n signedSnapshotTime \n signedEncryptionScope \n
  // rscc \n rscd \n rsce \n rscl \n rsct
  const stringToSign = [
    sp,
    st,
    se,
    canonicalizedResource,
    '',           // signed identifier
    '',           // signed IP
    spr,
    sv,
    sr,
    '',           // signed snapshot time
    '',           // signed encryption scope
    '',           // cache-control
    '',           // content-disposition
    '',           // content-encoding
    '',           // content-language
    '',           // content-type
  ].join('\n');

  const key = Buffer.from(accountKey, 'base64');
  const sig = crypto.createHmac('sha256', key).update(stringToSign, 'utf8').digest('base64');

  const params = new URLSearchParams();
  params.set('sv', sv);
  params.set('spr', spr);
  params.set('st', st);
  params.set('se', se);
  params.set('sr', sr);
  params.set('sp', sp);
  params.set('sig', sig);

  return `https://${ACCOUNT}.blob.core.windows.net/${CONTAINER}/${encodeURI(blobPath)}?${params.toString()}`;
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
