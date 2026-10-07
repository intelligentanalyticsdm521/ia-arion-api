// lib/audit/runs.js
//
// arion.site_audit_run, read and written in one place. The route and the
// runner take this as `repo`, so the tests hand in an in-memory twin with the
// same functions (test/site-audit.test.mjs) and the SQL here is exercised by
// scripts/dev/exercise-site-audit-dev.mjs against the dev database.
//
// Owner reads are scoped by the CALLER's owner_tenant_id joined in SQL, never
// by anything the request says about itself.

import sql from 'mssql';

const RUN_COLS = `r.run_id, r.caller_id, r.external_run_id, r.url, r.url_key, r.audit_day, r.status,
  r.score, r.summary_plain, r.findings_json, r.psi_json, r.crawl_json, r.blob_path,
  r.visitor_key_hash, r.owner_key_hash, r.visitor_link_expires_at, r.callback_url,
  r.callback_attempts, r.callback_last_error, r.error_plain, r.business_json, r.visitor_json,
  r.created_at, r.started_at, r.finished_at`;

const isUniqueViolation = (err) => err && (err.number === 2601 || err.number === 2627);

export function createSqlRepo(getPool) {
  const q = async () => (await getPool()).request();

  const repo = {
    async getRun(runId) {
      const r = await (await q()).input('id', sql.UniqueIdentifier, runId)
        .query(`SELECT ${RUN_COLS} FROM arion.site_audit_run r WHERE r.run_id = @id`);
      return r.recordset[0] || null;
    },

    async findByExternal(callerId, externalRunId) {
      const r = await (await q())
        .input('c', sql.UniqueIdentifier, callerId)
        .input('e', sql.NVarChar(80), externalRunId)
        .query(`SELECT ${RUN_COLS} FROM arion.site_audit_run r WHERE r.caller_id = @c AND r.external_run_id = @e`);
      return r.recordset[0] || null;
    },

    /** The newest finished audit of this URL today for this caller (with a stored report). */
    async findDoneToday(callerId, urlKey, day) {
      const r = await (await q())
        .input('c', sql.UniqueIdentifier, callerId)
        .input('u', sql.NVarChar(300), urlKey)
        .input('d', sql.Date, day)
        .query(`SELECT TOP 1 ${RUN_COLS} FROM arion.site_audit_run r
                 WHERE r.caller_id = @c AND r.url_key = @u AND r.audit_day = @d
                   AND r.status IN ('done','callback_failed') AND r.blob_path IS NOT NULL
                 ORDER BY r.finished_at DESC`);
      return r.recordset[0] || null;
    },

    async countToday(callerId, day) {
      const r = await (await q())
        .input('c', sql.UniqueIdentifier, callerId)
        .input('d', sql.Date, day)
        .query(`SELECT COUNT(*) AS n FROM arion.site_audit_run WHERE caller_id = @c AND audit_day = @d`);
      return r.recordset[0].n;
    },

    /**
     * Insert a run. A unique violation on (caller_id, external_run_id) — two
     * identical POSTs racing — returns the row that won instead of a second run.
     */
    async insertRun(p) {
      try {
        const r = await (await q())
          .input('c', sql.UniqueIdentifier, p.caller_id)
          .input('e', sql.NVarChar(80), p.external_run_id)
          .input('url', sql.NVarChar(1000), p.url)
          .input('uk', sql.NVarChar(300), p.url_key)
          .input('d', sql.Date, p.audit_day)
          .input('s', sql.NVarChar(16), p.status)
          .input('cb', sql.NVarChar(1000), p.callback_url)
          .input('bj', sql.NVarChar(sql.MAX), p.business_json ?? null)
          .input('vj', sql.NVarChar(sql.MAX), p.visitor_json ?? null)
          .input('score', sql.Int, p.score ?? null)
          .input('sum', sql.NVarChar(1000), p.summary_plain ?? null)
          .input('fj', sql.NVarChar(sql.MAX), p.findings_json ?? null)
          .input('pj', sql.NVarChar(sql.MAX), p.psi_json ?? null)
          .input('cj', sql.NVarChar(sql.MAX), p.crawl_json ?? null)
          .input('bp', sql.NVarChar(400), p.blob_path ?? null)
          .input('vh', sql.Char(64), p.visitor_key_hash ?? null)
          .input('oh', sql.Char(64), p.owner_key_hash ?? null)
          .input('vx', sql.DateTime2, p.visitor_link_expires_at ?? null)
          .input('fin', sql.DateTime2, p.finished_at ?? null)
          .query(`INSERT INTO arion.site_audit_run
                    (caller_id, external_run_id, url, url_key, audit_day, status, callback_url, business_json, visitor_json,
                     score, summary_plain, findings_json, psi_json, crawl_json, blob_path,
                     visitor_key_hash, owner_key_hash, visitor_link_expires_at, finished_at)
                  OUTPUT INSERTED.run_id
                  VALUES (@c, @e, @url, @uk, @d, @s, @cb, @bj, @vj, @score, @sum, @fj, @pj, @cj, @bp, @vh, @oh, @vx, @fin)`);
        return { run_id: r.recordset[0].run_id, inserted: true };
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        const existing = await repo.findByExternal(p.caller_id, p.external_run_id);
        return { run_id: existing.run_id, inserted: false };
      }
    },

    /** queued -> running, once. False when another worker already took it. */
    async markRunning(runId) {
      const r = await (await q()).input('id', sql.UniqueIdentifier, runId)
        .query(`UPDATE arion.site_audit_run SET status = 'running', started_at = SYSUTCDATETIME()
                 WHERE run_id = @id AND status = 'queued'`);
      return r.rowsAffected[0] === 1;
    },

    async markDone(runId, p) {
      await (await q())
        .input('id', sql.UniqueIdentifier, runId)
        .input('score', sql.Int, p.score ?? null)
        .input('sum', sql.NVarChar(1000), p.summary_plain ?? null)
        .input('fj', sql.NVarChar(sql.MAX), p.findings_json ?? null)
        .input('pj', sql.NVarChar(sql.MAX), p.psi_json ?? null)
        .input('cj', sql.NVarChar(sql.MAX), p.crawl_json ?? null)
        .input('bp', sql.NVarChar(400), p.blob_path)
        .input('vh', sql.Char(64), p.visitor_key_hash)
        .input('oh', sql.Char(64), p.owner_key_hash)
        .input('vx', sql.DateTime2, p.visitor_link_expires_at)
        .query(`UPDATE arion.site_audit_run
                   SET status = 'done', score = @score, summary_plain = @sum, findings_json = @fj,
                       psi_json = @pj, crawl_json = @cj, blob_path = @bp, visitor_key_hash = @vh,
                       owner_key_hash = @oh, visitor_link_expires_at = @vx, error_plain = NULL,
                       finished_at = SYSUTCDATETIME()
                 WHERE run_id = @id`);
    },

    async markFailed(runId, errorPlain) {
      await (await q())
        .input('id', sql.UniqueIdentifier, runId)
        .input('e', sql.NVarChar(500), String(errorPlain || '').slice(0, 500))
        .query(`UPDATE arion.site_audit_run SET status = 'failed', error_plain = @e, finished_at = SYSUTCDATETIME()
                 WHERE run_id = @id`);
    },

    async setLinks(runId, p) {
      await (await q())
        .input('id', sql.UniqueIdentifier, runId)
        .input('vh', sql.Char(64), p.visitor_key_hash)
        .input('oh', sql.Char(64), p.owner_key_hash)
        .input('vx', sql.DateTime2, p.visitor_link_expires_at)
        .query(`UPDATE arion.site_audit_run SET visitor_key_hash = @vh, owner_key_hash = @oh, visitor_link_expires_at = @vx
                 WHERE run_id = @id`);
    },

    async recordCallback(runId, { attempts, lastError = null, callbackFailed = false }) {
      await (await q())
        .input('id', sql.UniqueIdentifier, runId)
        .input('a', sql.Int, attempts)
        .input('e', sql.NVarChar(300), lastError ? String(lastError).slice(0, 300) : null)
        .input('f', sql.Bit, callbackFailed ? 1 : 0)
        .query(`UPDATE arion.site_audit_run
                   SET callback_attempts = @a, callback_last_error = @e,
                       status = CASE WHEN @f = 1 THEN 'callback_failed' ELSE status END
                 WHERE run_id = @id`);
    },

    async listForOwner(tenantId, limit = 50) {
      const r = await (await q())
        .input('t', sql.UniqueIdentifier, tenantId)
        .input('n', sql.Int, Math.min(200, Math.max(1, limit)))
        .query(`SELECT TOP (@n) ${RUN_COLS} FROM arion.site_audit_run r
                  JOIN arion.site_audit_caller c ON c.caller_id = r.caller_id
                 WHERE c.owner_tenant_id = @t
                 ORDER BY r.created_at DESC`);
      return r.recordset;
    },

    async getForOwner(tenantId, runId) {
      const r = await (await q())
        .input('t', sql.UniqueIdentifier, tenantId)
        .input('id', sql.UniqueIdentifier, runId)
        .query(`SELECT ${RUN_COLS} FROM arion.site_audit_run r
                  JOIN arion.site_audit_caller c ON c.caller_id = r.caller_id
                 WHERE c.owner_tenant_id = @t AND r.run_id = @id`);
      return r.recordset[0] || null;
    },
  };
  return repo;
}

export default { createSqlRepo };
