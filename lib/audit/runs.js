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
  r.created_at, r.started_at, r.finished_at, r.run_attempts, r.copied_from_run_id`;

const isUniqueViolation = (err) => err && (err.number === 2601 || err.number === 2627);

/** When a run is "lost" (its worker died): see reviveStale. */
export const STALE = {
  queuedSeconds: 60, // queued this long and nobody took it
  runningSeconds: 7 * 60, // running past the 5-minute cap plus two minutes
  maxAttempts: 2, // started at most twice in all
};

function bindRun(req, p) {
  return req
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
    .input('cf', sql.UniqueIdentifier, p.copied_from_run_id ?? null);
}

const INSERT_SQL = `INSERT INTO arion.site_audit_run
    (caller_id, external_run_id, url, url_key, audit_day, status, callback_url, business_json, visitor_json,
     score, summary_plain, findings_json, psi_json, crawl_json, blob_path,
     visitor_key_hash, owner_key_hash, visitor_link_expires_at, finished_at, copied_from_run_id)
  OUTPUT INSERTED.run_id
  VALUES (@c, @e, @url, @uk, @d, @s, @cb, @bj, @vj, @score, @sum, @fj, @pj, @cj, @bp, @vh, @oh, @vx, @fin, @cf)`;

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

    /**
     * Insert a run. A unique violation on (caller_id, external_run_id) — two
     * identical POSTs racing — returns the row that won instead of a second run.
     *
     * With `dailyLimit`, the count and the insert happen under one per-caller,
     * per-day application lock in one transaction, so a burst of POSTs cannot
     * all pass the count before any of them inserts. Only checks that really
     * run are counted (copied_from_run_id IS NULL); a same-website copy costs
     * nothing. Over the limit: { overLimit: true } and nothing is written.
     */
    async insertRun(p, { dailyLimit = null } = {}) {
      const pool = await getPool();
      if (dailyLimit == null) {
        try {
          const r = await bindRun(pool.request(), p).query(INSERT_SQL);
          return { run_id: r.recordset[0].run_id, inserted: true };
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          const existing = await repo.findByExternal(p.caller_id, p.external_run_id);
          return { run_id: existing.run_id, inserted: false };
        }
      }
      const tx = new sql.Transaction(pool);
      await tx.begin();
      try {
        const r = await bindRun(new sql.Request(tx), p)
          .input('lim', sql.Int, dailyLimit)
          .input('res', sql.NVarChar(255), `site-audit-limit:${String(p.caller_id).toLowerCase()}:${p.audit_day}`)
          .query(`
            DECLARE @lock INT;
            EXEC @lock = sp_getapplock @Resource = @res, @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 10000;
            IF @lock < 0 THROW 50001, 'The daily-limit lock was not granted.', 1;
            IF (SELECT COUNT(*) FROM arion.site_audit_run
                 WHERE caller_id = @c AND audit_day = @d AND copied_from_run_id IS NULL) >= @lim
              SELECT CAST(NULL AS UNIQUEIDENTIFIER) AS run_id, 1 AS over_limit;
            ELSE
              ${INSERT_SQL.replace('OUTPUT INSERTED.run_id', 'OUTPUT INSERTED.run_id, 0 AS over_limit')};`);
        await tx.commit();
        const row = r.recordset[0];
        if (row.over_limit) return { overLimit: true, inserted: false, run_id: null };
        return { run_id: row.run_id, inserted: true };
      } catch (err) {
        await tx.rollback().catch(() => {});
        if (!isUniqueViolation(err)) throw err;
        const existing = await repo.findByExternal(p.caller_id, p.external_run_id);
        return { run_id: existing.run_id, inserted: false };
      }
    },

    /** queued -> running, once (and count the start). False when another worker already took it. */
    async markRunning(runId) {
      const r = await (await q()).input('id', sql.UniqueIdentifier, runId)
        .query(`UPDATE arion.site_audit_run
                   SET status = 'running', started_at = SYSUTCDATETIME(), run_attempts = run_attempts + 1
                 WHERE run_id = @id AND status = 'queued'`);
      return r.rowsAffected[0] === 1;
    },

    /**
     * A run whose worker died (a restart or a deploy drops the in-memory
     * queue). Atomic, so two instances asking at once cannot both act:
     *   - running past STALE.runningSeconds with attempts left -> queued again: 'restart'
     *   - running past it with no attempts left -> failed with `failPlain`: 'failed'
     *   - queued for more than STALE.queuedSeconds -> 'restart' (markRunning decides who runs it)
     *   - anything else -> null (leave it alone)
     */
    async reviveStale(runId, { failPlain, stale = STALE } = {}) {
      const r = await (await q())
        .input('id', sql.UniqueIdentifier, runId)
        .input('qs', sql.Int, stale.queuedSeconds)
        .input('rs', sql.Int, stale.runningSeconds)
        .input('max', sql.Int, stale.maxAttempts)
        .input('fp', sql.NVarChar(500), String(failPlain || '').slice(0, 500))
        .query(`
          DECLARE @out NVARCHAR(10) = NULL;
          UPDATE arion.site_audit_run SET status = 'failed', error_plain = @fp, finished_at = SYSUTCDATETIME()
           WHERE run_id = @id AND status = 'running' AND run_attempts >= @max
             AND started_at < DATEADD(second, -@rs, SYSUTCDATETIME());
          IF @@ROWCOUNT = 1 SET @out = 'failed';
          ELSE
          BEGIN
            UPDATE arion.site_audit_run SET status = 'queued', started_at = NULL
             WHERE run_id = @id AND status = 'running' AND run_attempts < @max
               AND started_at < DATEADD(second, -@rs, SYSUTCDATETIME());
            IF @@ROWCOUNT = 1 SET @out = 'restart';
            ELSE IF EXISTS (SELECT 1 FROM arion.site_audit_run
                             WHERE run_id = @id AND status = 'queued'
                               AND created_at < DATEADD(second, -@qs, SYSUTCDATETIME()))
              SET @out = 'restart';
          END
          SELECT @out AS result;`);
      return r.recordset[0]?.result || null;
    },

    /** Run ids that look lost (for the sweep). */
    async listStale({ stale = STALE, limit = 20 } = {}) {
      const r = await (await q())
        .input('qs', sql.Int, stale.queuedSeconds)
        .input('rs', sql.Int, stale.runningSeconds)
        .input('n', sql.Int, limit)
        .query(`SELECT TOP (@n) run_id FROM arion.site_audit_run
                 WHERE (status = 'queued' AND created_at < DATEADD(second, -@qs, SYSUTCDATETIME()))
                    OR (status = 'running' AND started_at < DATEADD(second, -@rs, SYSUTCDATETIME()))
                 ORDER BY created_at`);
      return r.recordset.map((x) => x.run_id);
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

    /** First links for a row that has none yet. Never replaces hashes already set (links already sent stay good). */
    async setLinks(runId, p) {
      await (await q())
        .input('id', sql.UniqueIdentifier, runId)
        .input('vh', sql.Char(64), p.visitor_key_hash)
        .input('oh', sql.Char(64), p.owner_key_hash)
        .input('vx', sql.DateTime2, p.visitor_link_expires_at)
        .query(`UPDATE arion.site_audit_run SET visitor_key_hash = @vh, owner_key_hash = @oh, visitor_link_expires_at = @vx
                 WHERE run_id = @id AND visitor_key_hash IS NULL AND owner_key_hash IS NULL`);
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

export default { createSqlRepo, STALE };
