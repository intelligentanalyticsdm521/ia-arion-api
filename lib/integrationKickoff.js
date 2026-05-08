/**
 * Integration Kickoff — fires when a freshly-provisioned site goes ready.
 * --------------------------------------------------------------------------
 * Reads the site's tier and seeds integration setup tasks accordingly.
 * Different integrations have different setup paths:
 *
 *   - GA4 / GSC / GBP   → require user OAuth (we can't auto-provision)
 *                          → mark as 'pending_user_oauth' so the dashboard
 *                            shows a "Connect Google" CTA on the right cards
 *   - Bing Webmaster    → uses our shared API key
 *                          → enqueue an 'auto' setup task; backend worker
 *                            adds the site to Bing programmatically
 *   - SE Ranking        → uses our system API key
 *                          → enqueue 'auto' setup; creates project + audit
 *
 * This module never makes the API calls itself — it just declares intent in
 * the DB and fires platform events. A separate background processor (TBD or
 * existing Functions) consumes the events and runs the actual setups. That
 * keeps onboarding latency low and recoveries simple.
 *
 * Tier matrix (matches lib/manifestBuilder.js):
 *   starter      → none
 *   essentials   → GA4, GSC, Bing
 *   growth       → + GBP, SE Ranking (basic)
 *   authority    → + SE Ranking (full Market Monitor)
 */

import sql from 'mssql';
import { firePlatformEvent } from './platformEvents.js';

const TIER_INTEGRATIONS = {
  starter: [],
  essentials: ['ga4', 'gsc', 'bing'],
  growth: ['ga4', 'gsc', 'bing', 'gbp', 'seranking'],
  authority: ['ga4', 'gsc', 'bing', 'gbp', 'seranking'],
};

const USER_OAUTH_REQUIRED = new Set(['ga4', 'gsc', 'gbp']);
const AUTO_SETUP = new Set(['bing', 'seranking']);

/**
 * Run integration kickoff for a freshly-provisioned site.
 *
 * @param {sql.ConnectionPool} pool
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.siteId
 * @returns {Promise<{seeded: string[], skipped: string[], tier: string}>}
 */
export async function runForSite(pool, { tenantId, siteId }) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('siteId', sql.UniqueIdentifier, siteId)
    .query(`SELECT TOP 1 tier, domain FROM arion.site WHERE tenant_id = @tenantId AND site_id = @siteId`);

  const row = r.recordset[0];
  if (!row) return { seeded: [], skipped: [], tier: 'unknown' };

  const tier = String(row.tier || 'starter').toLowerCase();
  const applicable = TIER_INTEGRATIONS[tier] || [];
  const seeded = [];
  const skipped = [];

  for (const integration of applicable) {
    try {
      await seedIntegrationStatus(pool, {
        tenantId, siteId,
        integration,
        domain: row.domain,
      });
      seeded.push(integration);

      // Fire event so downstream processors can run auto-setup
      const eventType = USER_OAUTH_REQUIRED.has(integration)
        ? 'arion.integration.pending_user_oauth'
        : 'arion.integration.pending_auto_setup';
      await firePlatformEvent(pool, {
        tenantId,
        eventType,
        eventRefId: siteId,
        payload: { site_id: siteId, integration, tier, domain: row.domain },
      });
    } catch (err) {
      console.warn(`[integrationKickoff] ${integration} seeding failed:`, err.message);
      skipped.push(integration);
    }
  }

  return { seeded, skipped, tier };
}

/**
 * Insert / upsert the integration status row for a (site, integration) pair.
 * Uses arion.site_integration_status (created in migration 017).
 */
async function seedIntegrationStatus(pool, { tenantId, siteId, integration, domain }) {
  const initialStatus = USER_OAUTH_REQUIRED.has(integration)
    ? 'pending_user_oauth'
    : (AUTO_SETUP.has(integration) ? 'pending_auto_setup' : 'pending');

  await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('siteId', sql.UniqueIdentifier, siteId)
    .input('integration', sql.NVarChar(40), integration)
    .input('status', sql.NVarChar(40), initialStatus)
    .input('domain', sql.NVarChar(253), domain || null)
    .query(`
      MERGE arion.site_integration_status AS target
      USING (SELECT @tenantId AS tenant_id, @siteId AS site_id, @integration AS integration_key) AS source
      ON target.tenant_id = source.tenant_id
        AND target.site_id = source.site_id
        AND target.integration_key = source.integration_key
      WHEN MATCHED THEN
        UPDATE SET status = @status,
                   domain = @domain,
                   updated_at = SYSDATETIMEOFFSET()
      WHEN NOT MATCHED THEN
        INSERT (tenant_id, site_id, integration_key, status, domain, created_at)
        VALUES (@tenantId, @siteId, @integration, @status, @domain, SYSDATETIMEOFFSET());
    `);
}

export default { runForSite };
