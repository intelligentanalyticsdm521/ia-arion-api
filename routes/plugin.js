// routes/plugin.js — F-139
//
// IA Plugin distribution gatekeeper. Plugin .zip lives in private blob
// storage (stiadmprod/plugins/); only arion-api's managed identity can
// read it. Two endpoints:
//
//   GET /plugin/manifest    — auth via X-Arion-Site-Token (existing).
//                              Returns { current_version, download_url, channel,
//                              changelog } for the site's selected channel.
//                              The plugin's WP-Cron polls this daily and
//                              auto-installs when current_version > installed.
//
//   GET /plugin/download    — public-ish but token-gated.
//                              Accepts ?token=<provision_code> for first-time
//                              install (wizard's WP-CLI command) OR a
//                              site_token via headers for subsequent updates.
//                              Streams the .zip via MI. Logs every download.
//
// Why this design instead of public blob:
//   - Plugin distribution stays gated to IA-onboarded sites only
//   - Stale provision codes can be revoked
//   - Audit log shows rollout status across all clients
//   - No public blob exposure (storage stays fully private behind PE)

import { Router } from 'express';
import sql from 'mssql';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { getServicesPool } from '../db/servicesPool.js';
import { hashSiteToken } from '../lib/siteToken.js';
import { hashProvisionCode } from '../lib/provisionCodes.js';
import { requireSiteToken } from '../middleware/requireSiteToken.js';

const router = Router();

const STORAGE_ACCOUNT = process.env.IA_PLUGIN_STORAGE_ACCOUNT || 'stiadmprod';
const CONTAINER = process.env.IA_PLUGIN_CONTAINER || 'plugins';
const API_BASE = process.env.ARION_API_BASE_URL
  || 'https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net';

// Blob auth — TWO modes, picked at startup:
//
//   1. Connection-string mode (preferred for prod today)
//      If process.env.IA_PLUGIN_STORAGE_CONNECTION is set, use it.
//      This is what we ship in prod because granting MI a blob-data role
//      requires Owner / User Access Administrator, which the founder
//      Contributor account doesn't have. The connection string is stored
//      as a KV secret (STIADMPROD-CONNECTION-STRING) and pulled in via a
//      KV reference on this app's settings.
//
//   2. Managed-identity mode (default fallback)
//      Used when no connection string is set — requires the MI to have
//      "Storage Blob Data Reader" on the storage account. Cleaner long-
//      term; switch back to this once role is grantable.
//
// Either way, only this server's outbound IP needs to be on the storage
// account's firewall allow list (storage stays default-deny + AzureServices
// bypass + per-IP allow).
let _blobClient = null;
function getBlobClient() {
  if (_blobClient) return _blobClient;
  const connStr = process.env.IA_PLUGIN_STORAGE_CONNECTION || '';
  if (connStr.startsWith('DefaultEndpointsProtocol=')) {
    _blobClient = BlobServiceClient.fromConnectionString(connStr);
  } else {
    _blobClient = new BlobServiceClient(
      `https://${STORAGE_ACCOUNT}.blob.core.windows.net`,
      new DefaultAzureCredential()
    );
  }
  return _blobClient;
}

// ── GET /plugin/manifest ────────────────────────────────────────────────
// Auth: X-Arion-Site-Token + X-Site-Id (handled by requireSiteToken).
// Returns the current version info for THIS site's selected channel
// (default 'latest', or 'staging' for founder beta sites).
//
// Plugin polls this on a daily WP-Cron and compares to its installed
// version. If newer, fetches download_url and runs Plugin_Upgrader.
router.get('/manifest', requireSiteToken, async (req, res) => {
  try {
    const pool = await getServicesPool();

    // Get this site's channel (default 'latest' from column default)
    const siteR = await pool.request()
      .input('sid', sql.UniqueIdentifier, req.site.site_id)
      .query(`SELECT plugin_channel FROM arion.site WHERE site_id = @sid`);
    const channel = siteR.recordset[0]?.plugin_channel || 'latest';

    // Get current version for that channel
    const verR = await pool.request()
      .input('ch', sql.NVarChar(20), channel)
      .query(`
        SELECT TOP 1 version, blob_path, changelog, sha256, released_at
        FROM arion.plugin_version
        WHERE channel = @ch AND is_current = 1
        ORDER BY released_at DESC`);
    if (!verR.recordset[0]) {
      return res.status(404).json({
        error: { code: 'NO_VERSION', message: `No current version published for channel "${channel}"`, status: 404 },
      });
    }
    const v = verR.recordset[0];

    res.json({
      data: {
        current_version: v.version,
        channel,
        download_url: `${API_BASE}/plugin/download?site_id=${encodeURIComponent(req.site.site_id)}`,
        // Plugin sends X-Arion-Site-Token on the download call same as here,
        // so the URL alone is not enough — gated by token.
        download_auth_required: true,
        changelog: v.changelog || null,
        sha256: v.sha256 || null,
        released_at: v.released_at,
      },
    });
  } catch (err) {
    console.error('[plugin/manifest]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// ── GET /plugin/download ────────────────────────────────────────────────
// Streams the .zip from private blob via MI.
//
// Auth: TWO accepted paths (whichever the caller provides):
//   1. ?token=<provision_code>  — first-time install via WP-CLI
//      (the wizard's handoff command embeds this in the URL)
//   2. X-Arion-Site-Token + X-Site-Id headers — auto-update polls
//      from an already-provisioned plugin
//
// Logs every download to arion.plugin_download_log.
router.get('/download', async (req, res) => {
  const startedAt = Date.now();
  const userAgent = req.headers['user-agent'] || null;
  const ipAddress = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
                 || req.socket?.remoteAddress || null;

  let siteId = null;
  let tenantId = null;
  let channel = 'latest';
  let downloadType = 'install';

  try {
    const pool = await getServicesPool();

    // Path 1: ?token=<provision_code>
    const provisionCode = req.query.token ? String(req.query.token) : null;
    // Path 2: X-Arion-Site-Token + X-Site-Id (auto-update)
    const authHeader = req.headers.authorization || '';
    const siteToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7)
                     : (req.headers['x-arion-site-token'] || req.headers['x-site-token'] || null);
    const queryStringSiteId = req.query.site_id ? String(req.query.site_id) : null;
    const headerSiteId = req.headers['x-site-id'] || null;

    if (provisionCode) {
      // Validate provision code against arion.site_provision_code (the
      // canonical table from migration 010). Codes are stored as SHA-256
      // hashes, never raw. Hash here and compare. The download endpoint
      // does NOT mark the code as redeemed — that happens when the plugin
      // self-redeems on first admin_init via the /provision/redeem route.
      // We just need a valid + unexpired + unredeemed + unrevoked row.
      const codeHash = hashProvisionCode(provisionCode);
      const r = await pool.request()
        .input('codeHash', sql.NVarChar(64), codeHash)
        .query(`
          SELECT TOP 1 site_id, tenant_id
          FROM arion.site_provision_code
          WHERE code_hash = @codeHash
            AND expires_at > SYSDATETIMEOFFSET()
            AND revoked_at IS NULL`);
      if (!r.recordset[0]) {
        return res.status(403).json({ error: { code: 'INVALID_PROVISION_CODE', message: 'Invalid or expired provision code', status: 403 } });
      }
      siteId = r.recordset[0].site_id;
      tenantId = r.recordset[0].tenant_id;
      downloadType = 'install';
    } else if (siteToken) {
      const sId = headerSiteId || queryStringSiteId;
      if (!sId) {
        return res.status(400).json({ error: { code: 'MISSING_SITE_ID', message: 'site_id required (header X-Site-Id or query ?site_id=)', status: 400 } });
      }
      const tokenHash = hashSiteToken(siteToken);
      const r = await pool.request()
        .input('sid', sql.UniqueIdentifier, sId)
        .input('th', sql.NVarChar(64), tokenHash)
        .query(`SELECT TOP 1 site_id, tenant_id FROM arion.site WHERE site_id = @sid AND site_token_hash = @th`);
      if (!r.recordset[0]) {
        return res.status(401).json({ error: { code: 'INVALID_TOKEN', message: 'Invalid site token', status: 401 } });
      }
      siteId = r.recordset[0].site_id;
      tenantId = r.recordset[0].tenant_id;
      downloadType = 'update';
    } else {
      return res.status(401).json({
        error: { code: 'AUTH_REQUIRED', message: 'Provide ?token=<provision_code> OR X-Arion-Site-Token header + X-Site-Id', status: 401 },
      });
    }

    // Resolve channel + current version for this site
    const chR = await pool.request()
      .input('sid', sql.UniqueIdentifier, siteId)
      .query(`SELECT plugin_channel FROM arion.site WHERE site_id = @sid`);
    channel = chR.recordset[0]?.plugin_channel || 'latest';

    const verR = await pool.request()
      .input('ch', sql.NVarChar(20), channel)
      .query(`SELECT TOP 1 version, blob_path FROM arion.plugin_version WHERE channel = @ch AND is_current = 1 ORDER BY released_at DESC`);
    if (!verR.recordset[0]) {
      return res.status(404).json({ error: { code: 'NO_VERSION', message: `No current version for channel "${channel}"`, status: 404 } });
    }
    const { version, blob_path } = verR.recordset[0];

    // Stream the blob
    const blob = getBlobClient().getContainerClient(CONTAINER).getBlobClient(blob_path);
    let bytesStreamed = 0;
    try {
      const props = await blob.getProperties();
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', String(props.contentLength || 0));
      res.setHeader('Content-Disposition', `attachment; filename="intelligent-analytics-${version}.zip"`);
      res.setHeader('X-IA-Plugin-Version', version);
      res.setHeader('X-IA-Plugin-Channel', channel);

      const downloadResponse = await blob.download();
      downloadResponse.readableStreamBody.on('data', (chunk) => { bytesStreamed += chunk.length; });
      await new Promise((resolve, reject) => {
        downloadResponse.readableStreamBody.pipe(res);
        downloadResponse.readableStreamBody.on('end', resolve);
        downloadResponse.readableStreamBody.on('error', reject);
      });

      // Audit log (best-effort)
      pool.request()
        .input('sid', sql.UniqueIdentifier, siteId)
        .input('tid', sql.UniqueIdentifier, tenantId)
        .input('type', sql.NVarChar(20), downloadType)
        .input('ver', sql.NVarChar(40), version)
        .input('ch', sql.NVarChar(20), channel)
        .input('bytes', sql.BigInt, bytesStreamed)
        .input('ip', sql.NVarChar(64), ipAddress)
        .input('ua', sql.NVarChar(500), userAgent)
        .query(`
          INSERT INTO arion.plugin_download_log
            (site_id, tenant_id, download_type, version, channel, bytes_streamed, ip_address, user_agent, succeeded)
          VALUES (@sid, @tid, @type, @ver, @ch, @bytes, @ip, @ua, 1)`)
        .catch((e) => console.warn('[plugin/download] audit log failed:', e.message));
    } catch (blobErr) {
      console.error('[plugin/download] blob stream error:', blobErr);
      // Log the failure too
      pool.request()
        .input('sid', sql.UniqueIdentifier, siteId)
        .input('tid', sql.UniqueIdentifier, tenantId)
        .input('type', sql.NVarChar(20), downloadType)
        .input('ver', sql.NVarChar(40), version)
        .input('ch', sql.NVarChar(20), channel)
        .input('ip', sql.NVarChar(64), ipAddress)
        .input('ua', sql.NVarChar(500), userAgent)
        .input('err', sql.NVarChar(500), blobErr.message.slice(0, 500))
        .query(`
          INSERT INTO arion.plugin_download_log
            (site_id, tenant_id, download_type, version, channel, ip_address, user_agent, succeeded, error_message)
          VALUES (@sid, @tid, @type, @ver, @ch, @ip, @ua, 0, @err)`)
        .catch(() => {});
      if (!res.headersSent) {
        return res.status(502).json({ error: { code: 'BLOB_STREAM_FAILED', message: blobErr.message, status: 502 } });
      }
    }
  } catch (err) {
    console.error('[plugin/download]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
    }
  }
});

// ── GET /plugin/paid/:slug ──────────────────────────────────────────────
// Streams a paid third-party plugin (e.g. elementor-pro) from the same
// plugins container. Token-gated like /download. The blob path is
// `<slug>/<slug>-latest.zip`. Used by the onboarding plugin-stack installer
// so wp-cli on the Hostinger box pulls the .zip from arion-api instead of
// directly from blob storage (sidesteps SAS-version + egress-IP issues).
//
// Auth: ?token=<provision_code>. Only an active, unconsumed provision
// code can fetch the .zip.
//
// Uses StorageSharedKeyCredential built from the KV secret
// STIADMPROD-ACCOUNT-KEY so we don't depend on managed-identity RBAC
// against the storage account (which the founder account can't grant).
import { StorageSharedKeyCredential as _SSC, BlobServiceClient as _BSC } from '@azure/storage-blob';
import { SecretClient as _SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential as _DAC } from '@azure/identity';
import { hashProvisionCode as _hpc } from '../lib/provisionCodes.js';

const _KV_URI = process.env.KEY_VAULT_URI || 'https://kv-iadm-prod.vault.azure.net/';
let _kvForPaid = null;
function _kv() {
  if (!_kvForPaid) _kvForPaid = new _SecretClient(_KV_URI, new _DAC());
  return _kvForPaid;
}

let _paidBlobClient = null;
async function _getPaidBlobClient() {
  if (_paidBlobClient) return _paidBlobClient;
  const fromEnv = process.env.STIADMPROD_ACCOUNT_KEY;
  let key;
  if (fromEnv && fromEnv.length > 30 && !fromEnv.startsWith('@Microsoft.KeyVault')) {
    key = fromEnv;
  } else {
    const secret = await _kv().getSecret('STIADMPROD-ACCOUNT-KEY');
    key = secret.value;
  }
  const cred = new _SSC(STORAGE_ACCOUNT, key);
  _paidBlobClient = new _BSC(`https://${STORAGE_ACCOUNT}.blob.core.windows.net`, cred);
  return _paidBlobClient;
}

router.get('/paid/:slug', async (req, res) => {
  const { slug } = req.params;
  const token = (req.query.token || '').toString().trim();

  if (!/^[a-z0-9-]+$/.test(slug)) {
    return res.status(400).json({ error: { code: 'BAD_SLUG', message: 'slug must be lowercase alphanumeric + hyphens', status: 400 } });
  }
  if (!token) {
    return res.status(401).json({ error: { code: 'TOKEN_REQUIRED', message: 'provision code required as ?token=', status: 401 } });
  }

  try {
    const pool = await getServicesPool();
    const tokenHash = _hpc(token);
    const r = await pool.request()
      .input('th', sql.NVarChar(80), tokenHash)
      .query(`
        SELECT TOP 1 site_id, tenant_id, expires_at, redeemed_at, revoked_at
        FROM arion.site_provision_code
        WHERE code_hash = @th
      `);
    const row = r.recordset[0];
    if (!row) {
      return res.status(401).json({ error: { code: 'TOKEN_INVALID', status: 401 } });
    }
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return res.status(401).json({ error: { code: 'TOKEN_EXPIRED', status: 401 } });
    }

    const blobPath = `${slug}/${slug}-latest.zip`;
    const svc = await _getPaidBlobClient();
    const blob = svc.getContainerClient(CONTAINER).getBlobClient(blobPath);
    let props;
    try {
      props = await blob.getProperties();
    } catch (probeErr) {
      return res.status(404).json({ error: { code: 'PLUGIN_NOT_FOUND', message: `No blob at ${blobPath}: ${probeErr.message}`, status: 404 } });
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(props.contentLength || 0));
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-latest.zip"`);

    const dlRes = await blob.download();
    await new Promise((resolve, reject) => {
      dlRes.readableStreamBody.pipe(res);
      dlRes.readableStreamBody.on('end', resolve);
      dlRes.readableStreamBody.on('error', reject);
    });
  } catch (err) {
    console.error('[plugin/paid]', err);
    if (!res.headersSent) {
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
    }
  }
});

// ── GET /plugin/versions ────────────────────────────────────────────────
// Admin-style endpoint: list all published versions per channel. Useful for
// the Portal's "plugin releases" admin view + founder visibility.
// No auth gate other than the standard arion mount (mounted under
// /arion/* in index.js with requireAuth + requireArionAccess).
router.get('/versions', async (req, res) => {
  try {
    const pool = await getServicesPool();
    const r = await pool.request().query(`
      SELECT version_id, version, channel, blob_path, changelog, sha256, released_at, released_by, is_current
      FROM arion.plugin_version
      ORDER BY released_at DESC`);
    res.json({ data: { versions: r.recordset } });
  } catch (err) {
    console.error('[plugin/versions]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

export default router;
