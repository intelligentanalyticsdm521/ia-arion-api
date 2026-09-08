// lib/contentAgent/assetStore.js
//
// Where rendered carousel PNGs live. Open Question Q2 asked "reuse the existing
// Blob Storage artifact-store pattern, or a new container?" — this implements
// the recommendation: SAME storage account, NEW container 'content-agent'.
// No new Azure resource (free-tier rule), no mixing with the plugin artifact
// container (different lifecycle: plugin zips are platform-global, these are
// tenant content).
//
// TENANT SCOPING IS IN THE BLOB PATH: content-agent/<tenantId>/<outputId>/...
// so a listing for one tenant can never enumerate another's assets, and a
// future per-tenant SAS can be scoped to a prefix.
//
// FAILS CLOSED: no connection string -> throws a clear NotConfigured, and the
// caller records the render as manual-fallback (F7). It never writes to a
// default location "to be helpful".
//
// Dev safety: the dev stack's STORAGE_CONNECTION_STRING points at Azurite
// (devstoreaccount1) — verified before this module was first run. If a dev
// path ever writes to a prod resource, that is a seam gap to fix, not accept.

import { BlobServiceClient } from '@azure/storage-blob';

export const CONTAINER = 'content-agent';

export class AssetStoreNotConfigured extends Error {
  constructor() {
    super('[assetStore] STORAGE_CONNECTION_STRING is not set — cannot store rendered assets. Rendered content falls back to manual handling (F7).');
    this.name = 'AssetStoreNotConfigured';
  }
}

let _client = null;
function client() {
  if (_client) return _client;
  const cs = process.env.STORAGE_CONNECTION_STRING;
  if (!cs) throw new AssetStoreNotConfigured();
  _client = BlobServiceClient.fromConnectionString(cs);
  return _client;
}

/** For tests. */
export function _resetClient() { _client = null; }

/**
 * Store one rendered asset. Returns the blob path (not a SAS URL — signing is
 * the reader's concern and TTL'd at read time, same split as azureBlob.js).
 *
 * @param {object} p
 * @param {string} p.tenantId
 * @param {string} p.outputId
 * @param {string} p.name      e.g. 'slide-01.png'
 * @param {Buffer} p.buffer
 * @param {string} [p.contentType]
 * @returns {Promise<string>} blob path within the container
 */
export async function storeAsset({ tenantId, outputId, name, buffer, contentType = 'image/png' }) {
  if (!tenantId || !outputId || !name || !buffer) {
    throw new Error('[assetStore] tenantId, outputId, name and buffer are all required');
  }
  const container = client().getContainerClient(CONTAINER);
  await container.createIfNotExists(); // private by default — no public access
  const path = `${tenantId}/${outputId}/${name}`;
  await container.getBlockBlobClient(path).uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
  return `${CONTAINER}/${path}`;
}

/** List a tenant's assets for one output. Prefix-scoped to the tenant. */
export async function listAssets({ tenantId, outputId }) {
  const container = client().getContainerClient(CONTAINER);
  const out = [];
  for await (const blob of container.listBlobsFlat({ prefix: `${tenantId}/${outputId}/` })) {
    out.push({ name: blob.name, size: blob.properties.contentLength });
  }
  return out;
}

export default { CONTAINER, AssetStoreNotConfigured, storeAsset, listAssets, _resetClient };
