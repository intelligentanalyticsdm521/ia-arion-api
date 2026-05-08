/**
 * Provisioning job DB helpers.
 *
 * One row per attempted site provision. The Playwright worker reports phase
 * transitions back via /provisioning/worker-progress; this module is the only
 * thing that writes to arion.provisioning_job.
 *
 * State derivation: callers should never write `state` directly via SQL —
 * always go through transitionState() so we get consistent timestamps.
 */

import sql from 'mssql';
import crypto from 'node:crypto';

/**
 * Mapping of phase → progress percent for the live UI bar. Phases not in this
 * map keep the previous percent.
 */
export const PHASE_PROGRESS = {
  queued: 5,
  dns_verifying: 10,
  dispatched: 15,
  started: 20,
  wp_login: 30,
  ai_builder_prompt: 40,
  ai_builder_confirm: 55,
  kodee_skip: 65,
  ai_builder_finalize: 75,
  plugin_deploy: 82,
  auto_redeem_trigger: 88,
  bootstrap_running: 92,
  ready: 100,
  ready_partial: 100,
  failed: 100,
};

const TERMINAL = new Set(['ready', 'ready_partial', 'failed']);

/**
 * Create a new provisioning job row.
 *
 * @param {sql.ConnectionPool} pool
 * @param {object} args
 * @param {string} args.tenantId
 * @param {string} args.siteId
 * @param {number} [args.signupSessionPk]
 * @param {object} args.payload  - serialized at insert time, snapshot for replay
 * @returns {Promise<{job_id: string}>}
 */
export async function createJob(pool, { tenantId, siteId, signupSessionPk = null, payload }) {
  const jobId = crypto.randomUUID();
  await pool.request()
    .input('jobId', sql.UniqueIdentifier, jobId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('siteId', sql.UniqueIdentifier, siteId)
    .input('sessionPk', sql.Int, signupSessionPk)
    .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(payload))
    .query(`
      INSERT INTO arion.provisioning_job
        (job_id, tenant_id, site_id, signup_session_pk, state, progress_percent, payload_json, created_at, last_progress_at)
      VALUES
        (@jobId, @tenantId, @siteId, @sessionPk, 'queued', 5, @payload, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET())
    `);
  return { job_id: jobId };
}

/**
 * Move a job to a new state, updating progress + timestamps.
 *
 * @param {sql.ConnectionPool} pool
 * @param {string} jobId
 * @param {string} state
 * @param {object} [extra] - { message, error, screenshotB64 }
 */
export async function transitionState(pool, jobId, state, extra = {}) {
  const progress = PHASE_PROGRESS[state] ?? null;
  const isTerminal = TERMINAL.has(state);
  const isStart = state === 'started';

  const req = pool.request()
    .input('jobId', sql.UniqueIdentifier, jobId)
    .input('state', sql.NVarChar(40), state)
    .input('progress', sql.Int, progress)
    .input('message', sql.NVarChar(500), extra.message ? String(extra.message).slice(0, 500) : null)
    .input('error', sql.NVarChar(2000), extra.error ? String(extra.error).slice(0, 2000) : null)
    .input('screenshot', sql.NVarChar(sql.MAX), extra.screenshotB64 ? String(extra.screenshotB64).slice(0, 200_000) : null);

  await req.query(`
    UPDATE arion.provisioning_job
    SET state = @state,
        progress_percent = COALESCE(@progress, progress_percent),
        last_progress_at = SYSDATETIMEOFFSET(),
        last_message = COALESCE(@message, last_message),
        last_error = CASE WHEN @error IS NOT NULL THEN @error ELSE last_error END,
        last_screenshot_b64 = CASE WHEN @screenshot IS NOT NULL THEN @screenshot ELSE last_screenshot_b64 END,
        started_at = CASE WHEN ${isStart ? '1' : '0'} = 1 AND started_at IS NULL THEN SYSDATETIMEOFFSET() ELSE started_at END,
        finished_at = CASE WHEN ${isTerminal ? '1' : '0'} = 1 THEN SYSDATETIMEOFFSET() ELSE finished_at END,
        updated_at = SYSDATETIMEOFFSET()
    WHERE job_id = @jobId
  `);
}

/**
 * Get a job snapshot by ID.
 */
export async function getJob(pool, jobId) {
  const r = await pool.request()
    .input('jobId', sql.UniqueIdentifier, jobId)
    .query(`SELECT * FROM arion.provisioning_job WHERE job_id = @jobId`);
  return r.recordset[0] || null;
}

/**
 * Get the most recent job for a (tenant, site) — used by the status polling endpoint.
 */
export async function getLatestJobForSite(pool, { tenantId, siteId }) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('siteId', sql.UniqueIdentifier, siteId)
    .query(`
      SELECT TOP 1 *
      FROM arion.provisioning_job
      WHERE tenant_id = @tenantId AND site_id = @siteId
      ORDER BY created_at DESC
    `);
  return r.recordset[0] || null;
}

/**
 * Increment attempt counter (for worker retries).
 */
export async function bumpAttempts(pool, jobId) {
  await pool.request()
    .input('jobId', sql.UniqueIdentifier, jobId)
    .query(`UPDATE arion.provisioning_job SET attempts = attempts + 1, updated_at = SYSDATETIMEOFFSET() WHERE job_id = @jobId`);
}
