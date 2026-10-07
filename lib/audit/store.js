// lib/audit/store.js
//
// Where the audit PDFs live: container 'site-audits', PRIVATE (no public
// access), path <caller_id>/<run_id>/website-audit.pdf. Same storage account
// and pattern as lib/contentAgent/assetStore.js (STORAGE_CONNECTION_STRING —
// Azurite on dev). A blob path is returned, never a SAS: the file is reached
// only through GET /audit/files/:runId?k=<key> (routes/audit.js), which checks
// the key first. That is why no storage-account key is needed anywhere.
//
// FAILS CLOSED: no connection string throws AuditStoreNotConfigured; the run
// is marked failed with a plain reason. It never writes "somewhere else".

import { BlobServiceClient } from '@azure/storage-blob';

export const CONTAINER = 'site-audits';
export const FILE_NAME = 'website-audit.pdf';

export class AuditStoreNotConfigured extends Error {
  constructor() {
    super('[audit store] STORAGE_CONNECTION_STRING is not set — cannot store audit reports.');
    this.name = 'AuditStoreNotConfigured';
  }
}

let _client = null;
function client() {
  if (_client) return _client;
  const cs = process.env.STORAGE_CONNECTION_STRING;
  if (!cs) throw new AuditStoreNotConfigured();
  _client = BlobServiceClient.fromConnectionString(cs);
  return _client;
}

/** For tests. */
export function _resetClient() { _client = null; }

export function blobPathFor(callerId, runId) {
  return `${CONTAINER}/${String(callerId).toLowerCase()}/${String(runId).toLowerCase()}/${FILE_NAME}`;
}

function splitPath(blobPath) {
  const prefix = `${CONTAINER}/`;
  if (!String(blobPath || '').startsWith(prefix)) throw new Error('[audit store] not an audit blob path');
  return String(blobPath).slice(prefix.length);
}

/** Store a PDF; returns the blob path ("site-audits/..."). */
export async function storePdf({ callerId, runId, buffer }) {
  if (!callerId || !runId || !buffer?.length) throw new Error('[audit store] callerId, runId and the PDF bytes are required');
  const container = client().getContainerClient(CONTAINER);
  await container.createIfNotExists(); // private by default — no public access level
  const blobPath = blobPathFor(callerId, runId);
  await container.getBlockBlobClient(splitPath(blobPath)).uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: 'application/pdf' },
  });
  return blobPath;
}

/** A readable stream of a stored PDF. */
export async function openPdf(blobPath) {
  const blob = client().getContainerClient(CONTAINER).getBlockBlobClient(splitPath(blobPath));
  const res = await blob.download();
  return res.readableStreamBody;
}

export default { CONTAINER, FILE_NAME, AuditStoreNotConfigured, storePdf, openPdf, blobPathFor, _resetClient };
