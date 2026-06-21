import { Router } from 'express';
import sql from 'mssql';
import crypto from 'node:crypto';
import { getServicesPool } from '../../db/servicesPool.js';
import { generateSiteToken, hashSiteToken } from '../../lib/siteToken.js';
import { firePlatformEvent } from '../../lib/platformEvents.js';
import { buildAiPrompt } from '../../lib/promptBuilder.js';
import { verifyHostingerNameservers } from '../../lib/dnsVerifier.js';
import { createWebsite } from '../../lib/hostinger.js';
import { createJob, transitionState, getLatestJobForSite, PHASE_PROGRESS } from '../../lib/provisioningJobs.js';
import { dispatchJob } from '../../lib/workerClient.js';
import { createProvisionCode } from '../../lib/provisionCodes.js';
import formsRouter from './forms.js';
import bookingsRouter from './bookings.js';
import gbpRouter from './gbp.js';
import integrationsRouter from './integrations.js';
import domainsRouter from './domains.js';
// Onboarding V3 Phase 3 (Batch 14+) — close the "Set up a custom domain"
// walkthrough task when a BYOD site's nameservers have propagated to
// Hostinger (the moment ARION will actually start the build). Cross-product
// HTTP call to LUMEN-API; failure NEVER blocks site creation.
import { completeWalkthroughTaskByKind } from '../../lib/walkthroughClient.js';

const router = Router();

// Site limits per tier — used for "add another site" gating
const TIER_SITE_LIMITS = {
  starter: 1,
  essentials: 1,
  growth: 1,
  authority: 3,
};

// Mount sub-routers for site-scoped resources
router.use('/:siteId/forms', formsRouter);
router.use('/:siteId/bookings', bookingsRouter);
router.use('/:siteId/gbp', gbpRouter);
router.use('/:siteId', integrationsRouter);
router.use('/:siteId/domain', domainsRouter);

// ---------------------------------------------------------------------------
// POST /arion/sites/provision
// Creates a new site under the authenticated tenant and dispatches a
// provisioning job to the Playwright worker. Same backend mechanics as the
// /onboarding/submit flow used by new signups, but assumes the tenant already
// exists (so no Stripe/Entra user creation, no welcome email).
//
// Body: { domain: { mode, domain }, answers: { ...questionnaire }, whois?: {...} }
// Returns: { site_id, job_id, state }
// ---------------------------------------------------------------------------
router.post('/provision', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { domain, answers, whois } = req.body || {};

  // Validation
  if (!domain || !domain.mode || !['purchase', 'byod'].includes(domain.mode) || !domain.domain) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'domain.mode and domain.domain required', status: 400 } });
  }
  if (!answers || !answers.businessName || !answers.industry) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'answers.businessName and answers.industry required', status: 400 } });
  }

  try {
    const pool = await getServicesPool();

    // Resolve tenant tier + email from arion.tenant (created at signup time).
    // If the tenant existed before the signup flow shipped, fall back to starter.
    const tenantRow = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`SELECT TOP 1 [plan], primary_email FROM arion.tenant WHERE tenant_id = @tenantId`);
    const tenantTier = String(tenantRow.recordset[0]?.plan || 'starter').toLowerCase();
    const tenantEmail = tenantRow.recordset[0]?.primary_email || '';

    // Site-limit gate
    const siteCountRes = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`SELECT COUNT(*) AS site_count FROM arion.site WHERE tenant_id = @tenantId`);
    const siteCount = siteCountRes.recordset[0]?.site_count || 0;
    const limit = TIER_SITE_LIMITS[tenantTier] ?? 1;
    if (siteCount >= limit) {
      return res.status(403).json({
        error: {
          code: 'SITE_LIMIT_REACHED',
          message: `Your ${tenantTier} plan supports up to ${limit} site(s). Upgrade to Authority for additional sites.`,
          status: 403,
          details: { current: siteCount, limit, tier: tenantTier },
        },
      });
    }

    // BYOD verification gate
    if (domain.mode === 'byod') {
      const nsCheck = await verifyHostingerNameservers(domain.domain);
      if (!nsCheck.pointsToHostinger) {
        return res.status(425).json({
          error: {
            code: 'DNS_NOT_PROPAGATED',
            message: 'Domain nameservers haven\'t propagated to Hostinger yet. Update them and we\'ll start the build automatically.',
            status: 425,
            details: { current_nameservers: nsCheck.nameservers },
          },
        });
      }
      // Walkthrough hook — verified BYOD nameservers count as "custom domain
      // set up" for the purposes of the onboarding task. Fire-and-forget so
      // a walkthrough failure NEVER blocks the site-create flow.
      completeWalkthroughTaskByKind(req, 'arion_custom_domain').catch(() => {});
    }

    // Create the WP install on Hostinger
    const orderId = Number(process.env.HOSTINGER_DEFAULT_ORDER_ID || 0);
    if (!orderId) {
      return res.status(503).json({
        error: { code: 'NOT_CONFIGURED', message: 'HOSTINGER_DEFAULT_ORDER_ID env var not set on the server.', status: 503 },
      });
    }
    const wpCreate = await createWebsite({
      domain: domain.domain,
      orderId,
      datacenterCode: process.env.HOSTINGER_DEFAULT_DATACENTER || undefined,
    });
    if (!wpCreate.ok) {
      return res.status(502).json({ error: { code: 'WP_CREATE_FAILED', message: wpCreate.error, status: 502 } });
    }
    const websiteId = wpCreate.data?.website_id || wpCreate.data?.id;
    const wpAdminUrl = wpCreate.data?.wp_admin_url || `https://${domain.domain}/wp-admin/`;
    const adminPassword = wpCreate.data?.admin_password || '';
    const wpUser = wpCreate.data?.admin_username || tenantEmail;

    // Insert the new site row
    const siteId = crypto.randomUUID();
    await pool.request()
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('domain', sql.NVarChar(253), domain.domain)
      .input('domainMode', sql.NVarChar(20), domain.mode)
      .input('tier', sql.NVarChar(40), tenantTier)
      .input('hostingerWebsiteId', sql.NVarChar(80), String(websiteId || ''))
      .input('wpAdminUrl', sql.NVarChar(500), wpAdminUrl)
      .input('primaryColor', sql.NVarChar(20), answers.primaryColor || null)
      .query(`
        INSERT INTO arion.site
          (site_id, tenant_id, domain, domain_mode, tier, hostinger_website_id,
           wp_admin_url, branding_primary_color, provisioning_state, created_at)
        VALUES
          (@siteId, @tenantId, @domain, @domainMode, @tier, @hostingerWebsiteId,
           @wpAdminUrl, @primaryColor, 'queued', SYSDATETIMEOFFSET())
      `);

    // Build prompt + provisioning code
    const { prompt } = buildAiPrompt(answers);
    const codeRes = await createProvisionCode(pool, {
      tenantId, siteId,
      createdBy: 'add_site',
      ttlDays: 14,
    });

    // Job + dispatch
    const payload = {
      tenantId, siteId,
      domain: domain.domain, websiteId,
      wpAdminUrl, wpUser, wpPass: adminPassword,
      prompt,
      brandName: answers.businessName,
      language: 'English',
      provisionCode: codeRes.code,
    };
    const job = await createJob(pool, { tenantId, siteId, payload });

    dispatchJob({ jobId: job.job_id, ...payload })
      .then(async (r) => {
        if (r.ok) {
          await transitionState(pool, job.job_id, 'dispatched', { message: 'queued in worker' });
        } else {
          await transitionState(pool, job.job_id, 'failed', { error: 'Worker dispatch failed: ' + r.error });
        }
      })
      .catch((err) => console.error('[arion/sites/provision] dispatch error:', err));

    return res.status(202).json({
      data: { site_id: siteId, job_id: job.job_id, state: 'queued' },
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[arion/sites/provision]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// ---------------------------------------------------------------------------
// GET /arion/sites/:siteId/provisioning-status
// In-app polling for the AddSiteFlow UI. Same shape as /onboarding/status.
// ---------------------------------------------------------------------------
router.get('/:siteId/provisioning-status', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;

  try {
    const pool = await getServicesPool();
    const siteRow = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query(`
        SELECT TOP 1 domain, wp_admin_url, provisioning_state
        FROM arion.site
        WHERE tenant_id = @tenantId AND site_id = @siteId
      `);
    if (siteRow.recordset.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    }
    const site = siteRow.recordset[0];

    const job = await getLatestJobForSite(pool, { tenantId, siteId });
    let phase = 'queued';
    let progressPct = 5;
    let lastError = null;
    let lastMessage = null;

    if (job) {
      phase = phasePreferringIaBootstrap(job.state, site.provisioning_state);
      progressPct = PHASE_PROGRESS[phase] ?? job.progress_percent;
      lastError = ['failed'].includes(phase) ? job.last_error : null;
      lastMessage = job.last_message;
    } else if (site.provisioning_state === 'ready') {
      phase = 'ready';
      progressPct = 100;
    }

    const wpLoginUrl = site.wp_admin_url
      ? String(site.wp_admin_url).replace(/\/+$/, '').replace(/\/wp-admin$/, '') + '/wp-login.php'
      : null;
    const previewUrl = site.domain ? `https://${site.domain}` : null;

    return res.json({
      data: {
        phase,
        progress_percent: progressPct,
        message: lastMessage,
        error: lastError,
        wp_admin_url: site.wp_admin_url || null,
        wp_login_url: wpLoginUrl,
        preview_url: previewUrl,
      },
      meta: { tenant_id: tenantId, site_id: siteId, timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[arion/sites/provisioning-status]', err);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

function phasePreferringIaBootstrap(workerState, siteState) {
  if (siteState === 'ready') return 'ready';
  if (siteState === 'ready_partial') return 'ready_partial';
  if (siteState === 'failed') return 'failed';
  if (siteState === 'manifest_fetched' && !['ready', 'ready_partial', 'failed'].includes(workerState)) {
    return 'bootstrap_running';
  }
  return workerState;
}

// GET /arion/sites - list sites for tenant
router.get('/', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(req.query.per_page) || 25));
  const offset = (page - 1) * perPage;
  try {
    const pool = await getServicesPool();
    const [dataRes, countRes] = await Promise.all([
      pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('offset', sql.Int, offset)
        .input('perPage', sql.Int, perPage)
        .query(`
          SELECT site_id, domain, hosting_plan, status, ssl_expiry, arion_tier,
                 gbp_connected, gsc_connected, google_ads_linked, apple_claimed,
                 plugin_version, created_at, updated_at
          FROM arion.site
          WHERE tenant_id = @tenantId
          ORDER BY created_at DESC
          OFFSET @offset ROWS FETCH NEXT @perPage ROWS ONLY
        `),
      pool.request()
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .query('SELECT COUNT(*) AS total FROM arion.site WHERE tenant_id = @tenantId')
    ]);
    res.json({
      data: dataRes.recordset,
      meta: { total: countRes.recordset[0].total, page, per_page: perPage }
    });
  } catch (err) {
    console.error('[sites:list]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// GET /arion/sites/:siteId - site detail
router.get('/:siteId', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query(`
        SELECT site_id, domain, hosting_plan, wp_admin_url, status, ssl_expiry, arion_tier,
               gbp_connected, gbp_place_id, gsc_connected, google_ads_linked, apple_claimed,
               plugin_version, site_token_last_rotated, created_at, updated_at
        FROM arion.site
        WHERE tenant_id = @tenantId AND site_id = @siteId
      `);
    if (result.recordset.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    }
    res.json({
      data: result.recordset[0],
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() }
    });
  } catch (err) {
    console.error('[sites:get]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// POST /arion/sites - provision new site
router.post('/', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { domain, hosting_plan, arion_tier } = req.body;
  if (!domain) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'domain is required', status: 400 } });
  }
  try {
    const pool = await getServicesPool();
    const siteId = crypto.randomUUID();
    const rawToken = generateSiteToken();
    const tokenHash = hashSiteToken(rawToken);
    const now = new Date().toISOString();

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      await transaction.request()
        .input('siteId', sql.UniqueIdentifier, siteId)
        .input('tenantId', sql.UniqueIdentifier, tenantId)
        .input('domain', sql.NVarChar(253), domain)
        .input('hostingPlan', sql.NVarChar(50), hosting_plan || 'starter')
        .input('tier', sql.NVarChar(20), arion_tier || 'lite')
        .input('tokenHash', sql.NVarChar(64), tokenHash)
        .input('status', sql.NVarChar(30), 'provisioning')
        .query(`
          INSERT INTO arion.site
            (site_id, tenant_id, domain, hosting_plan, arion_tier, site_token_hash,
             site_token_last_rotated, status, gbp_connected, gsc_connected,
             google_ads_linked, apple_claimed, created_at, updated_at)
          VALUES
            (@siteId, @tenantId, @domain, @hostingPlan, @tier, @tokenHash,
             SYSDATETIMEOFFSET(), @status, 0, 0, 0, 0,
             SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())
        `);

      await firePlatformEvent(transaction, {
        tenantId,
        eventType: 'arion.site.provisioned',
        eventRefId: siteId,
        payload: { site_id: siteId, domain, arion_tier: arion_tier || 'lite' }
      });

      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    res.status(202).json({
      data: { site_id: siteId, domain, status: 'provisioning', site_token: rawToken },
      meta: { tenant_id: tenantId, timestamp: now }
    });
  } catch (err) {
    console.error('[sites:create]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

// GET /arion/sites/:siteId/editor-link - generate Elementor deep link
router.get('/:siteId/editor-link', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { siteId } = req.params;
  try {
    const pool = await getServicesPool();
    const result = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query('SELECT wp_admin_url FROM arion.site WHERE tenant_id = @tenantId AND site_id = @siteId');
    if (result.recordset.length === 0) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Site not found', status: 404 } });
    }
    const wpAdminUrl = result.recordset[0].wp_admin_url;
    if (!wpAdminUrl) {
      return res.status(409).json({ error: { code: 'NOT_READY', message: 'Site not yet provisioned', status: 409 } });
    }
    const editorUrl = `${wpAdminUrl}/post.php?action=elementor`;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    res.json({
      data: { editor_url: editorUrl, expires_at: expiresAt },
      meta: { tenant_id: tenantId, timestamp: new Date().toISOString() }
    });
  } catch (err) {
    console.error('[sites:editor-link]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 } });
  }
});

export default router;
