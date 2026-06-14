/**
 * Provisioning phase tracker — writes the current onboarding step into
 * arion.site.provisioning_details_json so the Portal's ProvisioningStatus
 * page can show a friendly progress bar without polling external services.
 *
 * The phase data lives inside the existing provisioning_details_json column
 * (NVARCHAR(MAX)) so no migration is needed. Phases ride alongside the
 * `wp_admin_login`, `provision_code`, etc. fields that get persisted at the
 * end of a successful run.
 *
 * Phase shape on disk (merged into the JSON):
 *   {
 *     current_phase: 'installing_plugins',
 *     current_percent: 72,
 *     current_message: 'Installing your plugin suite (8/10)',
 *     current_phase_started_at: '2026-06-14T15:30:00Z',
 *     phase_history: [
 *       { phase: 'creating_hosting_account', started_at: '…', completed_at: '…' },
 *       ...
 *     ]
 *   }
 *
 * The /onboarding/status endpoint surfaces current_phase + current_percent
 * directly to the UI.
 */

import sql from 'mssql';

export const PHASES = {
  queued:                    { percent: 2,  label: 'Preparing your site' },
  dns_verifying:             { percent: 5,  label: 'Verifying your domain' },
  creating_hosting:          { percent: 10, label: 'Setting up your hosting' },
  creating_database:         { percent: 15, label: 'Provisioning your database' },
  installing_wordpress:      { percent: 25, label: 'Installing WordPress' },
  waiting_for_wp:            { percent: 30, label: 'Waiting for your site to come online' },
  resetting_admin_password:  { percent: 33, label: 'Setting up admin access' },
  kodee_building:            { percent: 35, label: 'AI is designing your site (this may take a few minutes)' },
  stripping_hostinger:       { percent: 70, label: 'Cleaning up provisioning tools' },
  creating_editor_user:      { percent: 72, label: 'Creating your login' },
  installing_plugins:        { percent: 75, label: 'Installing your plugin suite' },
  applying_branding:         { percent: 90, label: 'Integrating your brand colors' },
  finishing_up:              { percent: 95, label: 'Wrapping up' },
  sending_welcome:           { percent: 98, label: 'Sending your welcome email' },
  ready:                     { percent: 100, label: 'Your site is ready!' },
  failed:                    { percent: 0, label: 'Something went wrong' },
};

/**
 * Update the phase on arion.site. Merges into provisioning_details_json so
 * the per-step credentials (admin password, provision code, etc.) that
 * accumulate in the JSON are preserved.
 *
 * Best-effort: a failed update doesn't throw — phase tracking should never
 * block provisioning.
 *
 * @param {object} pool             mssql pool
 * @param {string} siteId           arion.site.site_id
 * @param {string} phase            one of PHASES keys
 * @param {string} [overrideMessage] friendly override message
 * @returns {Promise<void>}
 */
export async function updatePhase(pool, siteId, phase, overrideMessage) {
  const cfg = PHASES[phase];
  if (!cfg) {
    console.warn(`[provisioningPhase] unknown phase: ${phase}`);
    return;
  }
  const now = new Date().toISOString();
  try {
    await pool.request()
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('phase', sql.NVarChar(64), phase)
      .input('percent', sql.Int, cfg.percent)
      .input('message', sql.NVarChar(500), overrideMessage || cfg.label)
      .input('now', sql.NVarChar(40), now)
      .query(`
        UPDATE arion.site
        SET provisioning_details_json = JSON_MODIFY(
              JSON_MODIFY(
                JSON_MODIFY(
                  JSON_MODIFY(
                    COALESCE(provisioning_details_json, '{}'),
                    '$.current_phase', @phase
                  ),
                  '$.current_percent', @percent
                ),
                '$.current_message', @message
              ),
              '$.current_phase_started_at', @now
            ),
            updated_at = GETUTCDATE()
        WHERE site_id = @siteId
      `);
  } catch (err) {
    console.warn(`[provisioningPhase] update failed (non-fatal): ${err.message}`);
  }
}

/**
 * Mark provisioning as failed and store the error for the UI.
 */
export async function markFailed(pool, siteId, error) {
  const now = new Date().toISOString();
  const msg = (error?.message || String(error || 'Unknown error')).slice(0, 500);
  try {
    await pool.request()
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('msg', sql.NVarChar(500), msg)
      .input('now', sql.NVarChar(40), now)
      .query(`
        UPDATE arion.site
        SET provisioning_state = 'failed',
            provisioning_details_json = JSON_MODIFY(
              JSON_MODIFY(
                JSON_MODIFY(
                  COALESCE(provisioning_details_json, '{}'),
                  '$.current_phase', 'failed'
                ),
                '$.current_message', @msg
              ),
              '$.failed_at', @now
            ),
            updated_at = GETUTCDATE()
        WHERE site_id = @siteId
      `);
  } catch (err) {
    console.error(`[provisioningPhase] markFailed write failed: ${err.message}`);
  }
}

export default { PHASES, updatePhase, markFailed };
