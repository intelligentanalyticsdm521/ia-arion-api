/**
 * Onboarding — Bing Webmaster dual-path orchestrator
 * --------------------------------------------------------------------------
 * Brandon-locked design 2026-06-23: same pattern as Google.
 *
 *   YES        — customer has their own Bing Webmaster account. They paste
 *                their API key into the wizard (existing path:
 *                POST /arion/bing/verify which stores the key on
 *                arion.site.bing_api_key and flips bing_connected = 1).
 *   NO         — provision under the IA master Bing account
 *                (existing path: POST /arion/bing/auto-connect which
 *                adds the site under BING_WMT_API_KEY's account + writes
 *                the DNS verification CNAME via Hostinger DNS API).
 *                After verification we invite the customer's Microsoft
 *                account email as an OWNER on the site via
 *                lib/iaMasterBing.inviteBingSiteUser().
 *   NOT_SURE   — probe via lib/iaMasterBing.probeBingFootprint(domain).
 *                If the master already has the site, route to YES (the
 *                customer is likely the original owner); else NO.
 *
 * arion.site columns this writes (added in migration 034):
 *   bing_setup_mode               byo | ia_managed | auto_byo | auto_ia
 *   bing_setup_probed_at          timestamp of last probe
 *   bing_ownership_transferred_at timestamp when invitation sent
 *
 * The existing /arion/bing/auto-connect already covers the IA-master site-add
 * + DNS verification work. This module's `/auto-provision` is a one-call
 * wrapper that fires auto-connect then immediately attempts the ownership
 * invite — surfaces the multi-step status to the runner as a single step.
 *
 * Master key: BING-WMT-API-KEY (verified present in kv-IADM-prod 2026-06-23).
 */

import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import {
  probeBingFootprint,
  inviteBingSiteUser,
  isBingMasterConfigured,
} from '../../lib/iaMasterBing.js';
import { firePlatformEvent } from '../../lib/platformEvents.js';

const router = Router();

function assertTenantScope(req, res, bodyTenant) {
  const callerTenant = String(req.tenant?.tenantId || '').toUpperCase();
  const bodyTid = String(bodyTenant || '').toUpperCase();
  if (!callerTenant) {
    res.status(401).json({ error: { code: 'NO_TENANT', message: 'No tenant resolved', status: 401 } });
    return false;
  }
  if (bodyTid && bodyTid !== callerTenant) {
    res.status(403).json({ error: { code: 'TENANT_MISMATCH', message: 'Body tenant_id does not match auth tenant', status: 403 } });
    return false;
  }
  return true;
}

async function getSiteRow(pool, tenantId, siteId) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('siteId', sql.UniqueIdentifier, siteId)
    .query(`SELECT TOP 1 site_id, tenant_id, domain, primary_url, bing_connected, bing_site_url
              FROM arion.site
             WHERE site_id = @siteId AND tenant_id = @tenantId`);
  return r.recordset[0] || null;
}

async function persistBingMode(pool, siteId, { mode, probed = true, transferredAt = null }) {
  if (mode) {
    await pool.request()
      .input('sid', sql.UniqueIdentifier, siteId)
      .input('mode', sql.NVarChar(20), mode)
      .query(`IF COL_LENGTH('arion.site', 'bing_setup_mode') IS NOT NULL
                UPDATE arion.site SET bing_setup_mode = @mode, updated_at = GETUTCDATE() WHERE site_id = @sid;`)
      .catch(() => {});
  }
  if (probed) {
    await pool.request()
      .input('sid', sql.UniqueIdentifier, siteId)
      .query(`IF COL_LENGTH('arion.site', 'bing_setup_probed_at') IS NOT NULL
                UPDATE arion.site SET bing_setup_probed_at = SYSDATETIMEOFFSET() WHERE site_id = @sid;`)
      .catch(() => {});
  }
  if (transferredAt) {
    await pool.request()
      .input('sid', sql.UniqueIdentifier, siteId)
      .query(`IF COL_LENGTH('arion.site', 'bing_ownership_transferred_at') IS NOT NULL
                UPDATE arion.site SET bing_ownership_transferred_at = SYSDATETIMEOFFSET() WHERE site_id = @sid;`)
      .catch(() => {});
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * POST /onboarding/bing-oauth/setup-probe
 *   Body: { tenant_id, site_id, answer }
 *   Output: { data: { route, mode, configured, probe? } }
 * ────────────────────────────────────────────────────────────────────── */
router.post('/setup-probe', async (req, res) => {
  const { tenant_id, site_id, answer } = req.body || {};
  if (!assertTenantScope(req, res, tenant_id)) return;
  if (!site_id) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'site_id required', status: 400 } });
  const norm = String(answer || '').toLowerCase().trim();
  if (!['yes', 'no', 'not_sure'].includes(norm)) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: "answer must be 'yes', 'no', or 'not_sure'", status: 400 } });
  }
  try {
    const pool = await getServicesPool();
    const tid = String(req.tenant.tenantId).toUpperCase();
    const site = await getSiteRow(pool, tid, site_id);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    if (norm === 'yes') {
      await persistBingMode(pool, site_id, { mode: 'byo' });
      return res.json({ data: { route: 'byo', mode: 'byo', configured: true } });
    }
    if (norm === 'no') {
      const configured = await isBingMasterConfigured();
      await persistBingMode(pool, site_id, { mode: configured ? 'ia_managed' : 'byo' });
      return res.json({
        data: {
          route: configured ? 'ia' : 'byo',
          mode: configured ? 'ia_managed' : 'byo',
          configured,
          warning: configured ? null : 'Bing master API key not configured — falling back to BYO.',
        },
      });
    }

    // not_sure
    const probe = await probeBingFootprint(site.domain);
    const mode = !probe.configured ? 'byo' : (probe.route === 'ia' ? 'auto_ia' : 'auto_byo');
    await persistBingMode(pool, site_id, { mode });
    return res.json({
      data: {
        route: probe.route,
        mode,
        configured: probe.configured,
        probe,
        warning: probe.configured ? null : 'Bing master API key not configured — defaulting to BYO.',
      },
    });
  } catch (err) {
    console.error('[onboarding/bing-oauth/setup-probe]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

/* ──────────────────────────────────────────────────────────────────────
 * POST /onboarding/bing-oauth/auto-provision
 *   Body: { tenant_id, site_id, contact_email? }
 *
 * Two-step: (1) call the existing internal /arion/bing/auto-connect logic
 * inline by direct require of the bing site-add helpers; (2) once the site
 * is added (verification may still be pending), fire the ownership
 * invitation to contact_email. The runner's waitFor() polls
 * GET /arion/bing/check-verification + this module's /status to know when
 * both pieces have landed.
 *
 * Implementation note: rather than HTTP-hop from this in-process route into
 * /arion/bing/auto-connect, we call the underlying libs directly so we
 * stay within the same request context (auth + tenant).
 * ────────────────────────────────────────────────────────────────────── */
router.post('/auto-provision', async (req, res) => {
  const { tenant_id, site_id, contact_email } = req.body || {};
  if (!assertTenantScope(req, res, tenant_id)) return;
  if (!site_id) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'site_id required', status: 400 } });

  try {
    const pool = await getServicesPool();
    const tid = String(req.tenant.tenantId).toUpperCase();
    const site = await getSiteRow(pool, tid, site_id);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    const configured = await isBingMasterConfigured();
    if (!configured) {
      return res.status(503).json({
        error: { code: 'BING_MASTER_NOT_CONFIGURED', message: 'BING_WMT_API_KEY not set', status: 503 },
      });
    }

    const siteUrl = `https://${site.domain}/`;
    // Step 1: ensure site is on the master account.
    const { addSite, getSiteEntry } = await import('../../lib/bingWebmaster.js');
    const masterKey = process.env.BING_WMT_API_KEY;
    const addRes = await addSite(masterKey, siteUrl);
    if (!addRes.ok) {
      return res.json({
        data: {
          mode: 'ia_managed',
          stage: 'add_site',
          ok: false,
          error: addRes.error,
        },
      });
    }

    let entry = await getSiteEntry(masterKey, siteUrl);
    if (!entry) {
      await new Promise((r) => setTimeout(r, 1500));
      entry = await getSiteEntry(masterKey, siteUrl);
    }

    // Step 2: write DNS verification record via Hostinger if not yet verified
    let dnsResult = null;
    if (entry && !entry.IsVerified) {
      const dnsCode = entry.DnsVerificationCode || '';
      const dotIdx = dnsCode.indexOf('.');
      const subdomain = dotIdx > 0 ? dnsCode.slice(0, dotIdx) : dnsCode;
      if (subdomain) {
        try {
          const { createDnsRecords } = await import('../../lib/hostinger.js');
          dnsResult = await createDnsRecords(
            site.domain,
            [{ type: 'CNAME', name: subdomain, content: 'verify.bing.com.', ttl: 300 }],
            true,
          );
        } catch (e) {
          dnsResult = { ok: false, error: e.message };
        }
      }
    }

    // Step 3: ownership invitation (fire-and-forget — Bing email-not-found
    // is a soft-pending state until the customer signs into Bing).
    let transfer = null;
    if (contact_email) {
      transfer = await inviteBingSiteUser({ siteUrl, email: contact_email });
    }

    if (entry?.IsVerified) {
      await pool.request()
        .input('tenantId', sql.UniqueIdentifier, tid)
        .input('siteId', sql.UniqueIdentifier, site_id)
        .input('siteUrl', sql.NVarChar(300), entry.Url || siteUrl)
        .input('now', sql.DateTime2, new Date())
        .query(`UPDATE arion.site
                   SET bing_api_key = NULL, bing_site_url = @siteUrl,
                       bing_connected = 1, bing_connected_at = @now
                 WHERE tenant_id = @tenantId AND site_id = @siteId`);
    }

    await persistBingMode(pool, site_id, {
      mode: 'ia_managed',
      transferredAt: transfer?.ok ? new Date() : null,
    });

    await firePlatformEvent(pool, {
      tenantId: tid,
      eventType: 'arion.onboarding.bing_ia_auto_provisioned',
      eventRefId: site_id,
      payload: { site_id, domain: site.domain, entry, dnsResult, transfer },
    }).catch(() => {});

    return res.json({
      data: {
        mode: 'ia_managed',
        stage: entry?.IsVerified ? 'verified' : (dnsResult?.ok ? 'dns_written' : 'pending'),
        ok: true,
        verified: !!entry?.IsVerified,
        siteUrl,
        dnsResult,
        transfer,
        warnings: [
          !contact_email ? 'No customer email provided — ownership invite not sent.' : null,
          transfer && !transfer.ok && transfer.pending ? 'Ownership invite is pending: invitee has not yet signed into Bing Webmaster Tools.' : null,
        ].filter(Boolean),
      },
    });
  } catch (err) {
    console.error('[onboarding/bing-oauth/auto-provision]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

/* ──────────────────────────────────────────────────────────────────────
 * GET /onboarding/bing-oauth/status/:siteId
 *   Returns the booleans the runner waitFor() polls.
 * ────────────────────────────────────────────────────────────────────── */
router.get('/status/:siteId', async (req, res) => {
  const tid = String(req.tenant?.tenantId || '').toUpperCase();
  const { siteId } = req.params;
  if (!tid || !siteId) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'tenant + siteId required', status: 400 } });
  }
  try {
    const pool = await getServicesPool();
    const r = await pool.request()
      .input('sid', sql.UniqueIdentifier, siteId)
      .input('tid', sql.UniqueIdentifier, tid)
      .query(`SELECT TOP 1
                bing_connected, bing_site_url,
                (CASE WHEN COL_LENGTH('arion.site', 'bing_setup_mode') IS NOT NULL THEN
                  (SELECT bing_setup_mode FROM arion.site WHERE site_id = @sid) ELSE NULL END) AS bing_setup_mode,
                (CASE WHEN COL_LENGTH('arion.site', 'bing_ownership_transferred_at') IS NOT NULL THEN
                  CONVERT(NVARCHAR(40), (SELECT bing_ownership_transferred_at FROM arion.site WHERE site_id = @sid), 127) ELSE NULL END) AS bing_ownership_transferred_at
              FROM arion.site WHERE site_id = @sid AND tenant_id = @tid;`);
    const row = r.recordset[0];
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    return res.json({
      data: {
        bing_connected: !!row.bing_connected,
        bing_site_url: row.bing_site_url || null,
        bing_setup_mode: row.bing_setup_mode || null,
        bing_ownership_transferred_at: row.bing_ownership_transferred_at || null,
        done: row.bing_setup_mode === 'ia_managed'
          ? !!row.bing_connected && !!row.bing_ownership_transferred_at
          : !!row.bing_connected,
      },
    });
  } catch (err) {
    console.error('[onboarding/bing-oauth/status]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

export default router;
