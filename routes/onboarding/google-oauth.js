/**
 * Onboarding — Google OAuth dual-path orchestrator
 * --------------------------------------------------------------------------
 * Brandon-locked design 2026-06-23:
 *
 * The customer is asked at the top of the Google onboarding card:
 *
 *   "Do you already have Google Analytics, Search Console, and Business
 *    Profile?"  (Yes / No / Not sure)
 *
 *   YES        — standard OAuth into the customer's own Google account.
 *                Existing /arion/integrations/google/connect code path
 *                (POST returns an authUrl, we just hand it back).
 *
 *   NO         — provision GA4 + GSC + GBP under the IA master Google
 *                service account (lib/iaMasterGoogle.js), then invite the
 *                customer's primary email as Admin on each so they own
 *                the data.
 *
 *   NOT_SURE   — call lib/iaMasterGoogle.probeGoogleFootprint(domain) to
 *                see what the IA master can find. Anything found → route
 *                to YES (customer probably owns it). Nothing found → NO.
 *
 * Database columns this route writes (added in migration 034):
 *   arion.site.google_setup_mode               byo | ia_managed | auto_byo | auto_ia
 *   arion.site.google_setup_probed_at          timestamp of last probe
 *   arion.site.google_setup_evidence_json      JSON dump of probe / provision
 *   arion.site.google_ownership_transferred_at timestamp when admin invite done
 *   arion.site.google_managed_account_id       IA-master GBP account name
 *
 * Existing columns the YES path uses (already wired by routes/oauth.js
 * /google/callback): gbp_oauth_token_ref, gbp_connected, gsc_connected,
 * ga4_property_id, gsc_site_url, gbp_location_name.
 *
 * Auth: same JWT+tenant chain as the runner. Each handler asserts the
 * caller's tenant matches the body tenant_id.
 *
 * IA master key (kebab-case in KV): GOOGLE-MASTER-SERVICE-ACCOUNT-JSON.
 * NOT YET PROVISIONED in kv-IADM-prod as of 2026-06-23. Until it lands,
 * the auto-create paths return a clean 503 ('ia_master_not_configured')
 * and the wizard falls through to BYO.
 */

import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import {
  probeGoogleFootprint,
  autoProvisionGoogle,
  transferGoogleOwnership,
  isIaMasterConfigured,
} from '../../lib/iaMasterGoogle.js';
import { firePlatformEvent } from '../../lib/platformEvents.js';
import { signOAuthState } from '../../lib/oauthState.js';

const router = Router();

/* ──────────────────────────────────────────────────────────────────────
 * Tenant scope guard — same shape as runner.js so both modules behave
 * the same when the caller's bearer doesn't match the body tenant.
 * ────────────────────────────────────────────────────────────────────── */
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
    .query(`SELECT TOP 1 site_id, tenant_id, domain
              FROM arion.site
             WHERE site_id = @siteId AND tenant_id = @tenantId`);
  return r.recordset[0] || null;
}

async function getCallerEmail(req, pool) {
  // Several places stash user info on req — be defensive.
  return (
    req.user?.email
    || req.user?.preferred_username
    || req.tenant?.userEmail
    || null
  );
}

async function persistGoogleEvidence(pool, siteId, { mode, evidence, transferred }) {
  // Each guard is independent so partial column coverage on older DB
  // snapshots still records what it can.
  if (mode) {
    await pool.request()
      .input('sid', sql.UniqueIdentifier, siteId)
      .input('mode', sql.NVarChar(20), mode)
      .query(`IF COL_LENGTH('arion.site', 'google_setup_mode') IS NOT NULL
                UPDATE arion.site SET google_setup_mode = @mode, updated_at = GETUTCDATE() WHERE site_id = @sid;`)
      .catch(() => {});
  }
  await pool.request()
    .input('sid', sql.UniqueIdentifier, siteId)
    .query(`IF COL_LENGTH('arion.site', 'google_setup_probed_at') IS NOT NULL
              UPDATE arion.site SET google_setup_probed_at = SYSDATETIMEOFFSET() WHERE site_id = @sid;`)
    .catch(() => {});
  if (evidence) {
    await pool.request()
      .input('sid', sql.UniqueIdentifier, siteId)
      .input('ev', sql.NVarChar(sql.MAX), JSON.stringify(evidence))
      .query(`IF COL_LENGTH('arion.site', 'google_setup_evidence_json') IS NOT NULL
                UPDATE arion.site SET google_setup_evidence_json = @ev WHERE site_id = @sid;`)
      .catch(() => {});
  }
  if (transferred?.account_name) {
    await pool.request()
      .input('sid', sql.UniqueIdentifier, siteId)
      .input('a', sql.NVarChar(80), transferred.account_name)
      .query(`IF COL_LENGTH('arion.site', 'google_managed_account_id') IS NOT NULL
                UPDATE arion.site SET google_managed_account_id = @a WHERE site_id = @sid;`)
      .catch(() => {});
  }
  if (transferred?.at) {
    await pool.request()
      .input('sid', sql.UniqueIdentifier, siteId)
      .query(`IF COL_LENGTH('arion.site', 'google_ownership_transferred_at') IS NOT NULL
                UPDATE arion.site SET google_ownership_transferred_at = SYSDATETIMEOFFSET() WHERE site_id = @sid;`)
      .catch(() => {});
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * POST /onboarding/google-oauth/setup-probe
 *   Body: { tenant_id, site_id, answer }
 *     answer = 'yes' | 'no' | 'not_sure'
 *   Output: { data: { route: 'byo'|'ia', mode, probe?, configured } }
 *
 * Persists google_setup_mode and the probe evidence to the site row.
 * Does NOT itself talk to Google when the answer is YES or NO — those
 * just record the customer's intent and route to the right next step.
 * Only the NOT_SURE branch hits Google (read-only probe).
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
      await persistGoogleEvidence(pool, site_id, { mode: 'byo', evidence: { answer: 'yes' } });
      return res.json({ data: { route: 'byo', mode: 'byo', configured: true } });
    }
    if (norm === 'no') {
      const configured = await isIaMasterConfigured();
      await persistGoogleEvidence(pool, site_id, {
        mode: configured ? 'ia_managed' : 'byo',
        evidence: { answer: 'no', ia_configured: configured },
      });
      return res.json({
        data: {
          route: configured ? 'ia' : 'byo',
          mode: configured ? 'ia_managed' : 'byo',
          configured,
          warning: configured ? null : 'IA master Google service account not yet configured — falling back to BYO.',
        },
      });
    }

    // not_sure — probe the IA master account for the customer's domain
    const probe = await probeGoogleFootprint(site.domain);
    const route = probe.route;        // 'byo' or 'ia'
    const mode = !probe.configured ? 'byo' : (route === 'ia' ? 'auto_ia' : 'auto_byo');
    await persistGoogleEvidence(pool, site_id, { mode, evidence: { answer: 'not_sure', probe } });
    return res.json({
      data: {
        route,
        mode,
        configured: probe.configured,
        probe,
        warning: probe.configured ? null : 'IA master Google service account not yet configured — defaulting to BYO.',
      },
    });
  } catch (err) {
    console.error('[onboarding/google-oauth/setup-probe]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

/* ──────────────────────────────────────────────────────────────────────
 * POST /onboarding/google-oauth/byo-start
 *   Body: { tenant_id, site_id, returnUrl }
 *   Output: { data: { authUrl } }
 *
 * Thin re-export of the existing /arion/integrations/google/connect logic
 * with the right setupMode so the OAuth state round-trip writes the runner
 * status_phase column on callback (downstream change in routes/oauth.js
 * is small: read setup_mode from state, set status_phase = 'google_connected').
 * ────────────────────────────────────────────────────────────────────── */
router.post('/byo-start', async (req, res) => {
  const { tenant_id, site_id, returnUrl } = req.body || {};
  if (!assertTenantScope(req, res, tenant_id)) return;
  if (!site_id) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'site_id required', status: 400 } });
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || '';
  const scope = process.env.GOOGLE_OAUTH_SCOPE || 'openid profile email';
  if (!clientId || !redirectUri) {
    return res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'Google OAuth not configured', status: 503 } });
  }
  const tid = String(req.tenant.tenantId).toUpperCase();
  // 2026-06-27 — HMAC-signed state + initiator email (see lib/oauthState.js).
  const initiatorEmail = (req.user?.email || req.tenant?.userEmail || '').toLowerCase() || null;
  let state;
  try {
    state = signOAuthState({
      tenantId: tid,
      siteId: site_id,
      setupMode: 'ARION_AUTO_SETUP',
      returnUrl,
      initiatorEmail,
    });
  } catch (e) {
    console.error('[google-oauth/byo-start] sign state failed:', e.message);
    return res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'OAuth state signing key not configured', status: 503 } });
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    state,
    access_type: 'offline',
    prompt: 'select_account consent',
  });
  return res.json({
    data: {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString(),
      mode: 'byo',
    },
  });
});

/* ──────────────────────────────────────────────────────────────────────
 * POST /onboarding/google-oauth/auto-provision
 *   Body: { tenant_id, site_id, business_name?, contact_email? }
 *
 * Creates GA4 + GSC + GBP under the IA master account, then invites the
 * customer (contact_email or fall back to req.user.email) as Admin /
 * Owner on each. Persists the result to arion.site columns + writes the
 * status_phase transitions the runner polls.
 *
 * Returns 503 ia_master_not_configured when the KV secret is missing.
 * ────────────────────────────────────────────────────────────────────── */
router.post('/auto-provision', async (req, res) => {
  const { tenant_id, site_id, business_name, contact_email } = req.body || {};
  if (!assertTenantScope(req, res, tenant_id)) return;
  if (!site_id) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'site_id required', status: 400 } });

  try {
    const pool = await getServicesPool();
    const tid = String(req.tenant.tenantId).toUpperCase();
    const site = await getSiteRow(pool, tid, site_id);
    if (!site) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });

    const configured = await isIaMasterConfigured();
    if (!configured) {
      return res.status(503).json({
        error: {
          code: 'IA_MASTER_NOT_CONFIGURED',
          message: 'IA master Google service account is not provisioned in this environment',
          status: 503,
        },
      });
    }

    const provision = await autoProvisionGoogle({
      domain: site.domain,
      businessName: business_name,
      contactEmail: contact_email,
    });

    const customerEmail = contact_email || (await getCallerEmail(req, pool));
    let transfer = { configured: true, ga4: { ok: false }, gsc: { ok: false }, gbp: { ok: false } };
    if (customerEmail && (provision.ga4.ok || provision.gsc.ok || provision.gbp.ok)) {
      transfer = await transferGoogleOwnership({
        customerEmail,
        ga4PropertyId: provision.ga4.property_id,
        gscSiteUrl: provision.gsc.site_url,
        gbpAccountName: provision.gbp.account_name,
        gbpLocationName: provision.gbp.location_name,
      });
    }

    // Mirror the GA4 / GSC / GBP success flags onto the existing
    // arion.site columns so the integrations-status endpoint and the
    // runner's verify() readback both see the IA-managed state.
    try {
      await pool.request()
        .input('sid', sql.UniqueIdentifier, site_id)
        .input('ga4', sql.NVarChar(40), provision.ga4.property_id || null)
        .input('ga4mid', sql.NVarChar(100), provision.ga4.measurement_id || null)
        .input('gsc', sql.NVarChar(500), provision.gsc.site_url || null)
        .input('gbpLoc', sql.NVarChar(200), provision.gbp.location_name || null)
        .input('gbpFlag', sql.Bit, provision.gbp.ok ? 1 : 0)
        .input('gscFlag', sql.Bit, provision.gsc.ok ? 1 : 0)
        .query(`UPDATE arion.site
                   SET ga4_property_id = COALESCE(@ga4, ga4_property_id),
                       ga4_measurement_id = COALESCE(@ga4mid, ga4_measurement_id),
                       gsc_site_url    = COALESCE(@gsc, gsc_site_url),
                       gsc_connected   = CASE WHEN @gscFlag = 1 THEN 1 ELSE gsc_connected END,
                       gbp_location_name = COALESCE(@gbpLoc, gbp_location_name),
                       gbp_connected   = CASE WHEN @gbpFlag = 1 THEN 1 ELSE gbp_connected END,
                       updated_at = GETUTCDATE()
                 WHERE site_id = @sid;`);
    } catch (e) {
      console.warn('[onboarding/google-oauth/auto-provision] integration mirror failed:', e.message);
    }

    const ownershipOk = transfer.ga4.ok || transfer.gsc.ok || transfer.gbp.ok;
    await persistGoogleEvidence(pool, site_id, {
      mode: 'ia_managed',
      evidence: { provision, transfer, contact_email: customerEmail || null },
      transferred: ownershipOk ? { at: new Date().toISOString(), account_name: provision.gbp.account_name } : undefined,
    });

    await firePlatformEvent(pool, {
      tenantId: tid,
      eventType: 'arion.onboarding.google_ia_auto_provisioned',
      eventRefId: site_id,
      payload: {
        site_id,
        domain: site.domain,
        provision,
        transfer,
      },
    }).catch(() => {});

    return res.json({
      data: {
        mode: 'ia_managed',
        provision,
        transfer,
        ownership_transferred: ownershipOk,
        warnings: [
          provision.gsc.ok && provision.gsc.verification_pending ? 'GSC: domain property added under IA master; DNS TXT verification needs to be placed by the next Hostinger DNS step.' : null,
          provision.gbp.ok && provision.gbp.verification_pending ? 'GBP: location created under IA master; final postcard/phone/video verification is the customer\'s — we cannot do it for them.' : null,
          !ownershipOk ? 'No customer email available to transfer ownership — provisioned under IA master only.' : null,
        ].filter(Boolean),
      },
    });
  } catch (err) {
    console.error('[onboarding/google-oauth/auto-provision]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

/* ──────────────────────────────────────────────────────────────────────
 * GET /onboarding/google-oauth/status/:siteId
 *   Returns the booleans + mode the runner waitFor() polls.
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
                gbp_connected, gsc_connected, ga4_property_id,
                (CASE WHEN COL_LENGTH('arion.site', 'google_setup_mode') IS NOT NULL THEN
                  (SELECT google_setup_mode FROM arion.site WHERE site_id = @sid) ELSE NULL END) AS google_setup_mode,
                (CASE WHEN COL_LENGTH('arion.site', 'google_ownership_transferred_at') IS NOT NULL THEN
                  CONVERT(NVARCHAR(40), (SELECT google_ownership_transferred_at FROM arion.site WHERE site_id = @sid), 127) ELSE NULL END) AS google_ownership_transferred_at
              FROM arion.site WHERE site_id = @sid AND tenant_id = @tid;`);
    const row = r.recordset[0];
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    return res.json({
      data: {
        ga4_connected: !!row.ga4_property_id,
        gsc_connected: !!row.gsc_connected,
        gbp_connected: !!row.gbp_connected,
        google_setup_mode: row.google_setup_mode || null,
        google_ownership_transferred_at: row.google_ownership_transferred_at || null,
        // The runner treats either flow as "done" once at least one of
        // GA4/GSC/GBP is connected. For ia_managed mode we additionally
        // require the ownership invite to have gone out.
        done: row.google_setup_mode === 'ia_managed'
          ? !!row.google_ownership_transferred_at && (!!row.ga4_property_id || !!row.gsc_connected || !!row.gbp_connected)
          : (!!row.ga4_property_id || !!row.gsc_connected || !!row.gbp_connected),
      },
    });
  } catch (err) {
    console.error('[onboarding/google-oauth/status]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

export default router;
