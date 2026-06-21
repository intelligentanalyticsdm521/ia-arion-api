/**
 * Per-tenant AI spend guard for the ARION IL website builder.
 * --------------------------------------------------------------------------
 * Reads month-to-date (and optionally day-to-date) spend from lumen.ai_usage
 * and compares against the tenant's configured cap in lumen.ai_cap_config
 * (or env-var defaults). Refuses calls that would push spend over the cap.
 *
 * Pattern mirrors lib/argus/callWrapper.js — that guard works in credits
 * against a tenant pool; this one works in raw $ against a per-tenant cap.
 * The website builder bills against the ARGUS Data Plan tier, but caller
 * sees a $ cap floor here as a public-beta safety net.
 *
 * API:
 *   assertTenantUnderCap(pool, { tenantId, surface, estimatedCostUsd })
 *     → { ok: true,  capUsd, spentUsd, remainingUsd, source }
 *     → { ok: false, reason, capUsd, spentUsd, remainingUsd, source, scope }
 *
 *   `reason` is a stable code: 'monthly_cap_exceeded' | 'daily_cap_exceeded'
 *   `source` is 'config' (row in ai_cap_config) or 'env_default'.
 *   `scope`  is 'monthly' | 'daily' on a deny — tells the caller which one.
 *
 * Defaults:
 *   AI_BUILDER_DEFAULT_MONTHLY_CAP_USD (env, default 100.00)
 *   AI_BUILDER_DEFAULT_DAILY_CAP_USD   (env, default null = no daily floor)
 *
 * Never throws on DB read errors — open-fail to ok=true with source='error'
 * so a transient DB blip doesn't take the builder offline. The audit row in
 * lumen.ai_usage written by callEmitter is still the canonical audit trail.
 *
 * References:
 *   db/migrations/026_ai_cap_config.sql
 *   lib/websiteBuilder/callEmitter.js  (the caller)
 */

import sql from 'mssql';

export const DEFAULT_SURFACE = 'arion.website_builder';

function envNumber(key, fallback) {
  const raw = process.env[key];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envNumberOrNull(key) {
  const raw = process.env[key];
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function defaultMonthlyCap() {
  return envNumber('AI_BUILDER_DEFAULT_MONTHLY_CAP_USD', 100.00);
}

function defaultDailyCap() {
  return envNumberOrNull('AI_BUILDER_DEFAULT_DAILY_CAP_USD');
}

/**
 * Load the configured caps for a tenant+surface. Returns env defaults when
 * no row exists. Returns null on DB error (caller decides — we open-fail).
 *
 * Public so admin endpoints and tests can introspect.
 */
export async function loadCapConfig(pool, { tenantId, surface }) {
  const s = surface || DEFAULT_SURFACE;
  if (!pool) {
    return {
      monthlyCapUsd: defaultMonthlyCap(),
      dailyCapUsd:   defaultDailyCap(),
      source:        'env_default',
    };
  }
  try {
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('surface',  sql.NVarChar(50),     s)
      .query(`
        SELECT TOP 1 monthly_cap_usd, daily_cap_usd, updated_at
          FROM lumen.ai_cap_config
         WHERE tenant_id = @tenantId
           AND surface   = @surface
      `);
    const row = r.recordset[0];
    if (!row) {
      return {
        monthlyCapUsd: defaultMonthlyCap(),
        dailyCapUsd:   defaultDailyCap(),
        source:        'env_default',
      };
    }
    return {
      monthlyCapUsd: Number(row.monthly_cap_usd),
      dailyCapUsd:   row.daily_cap_usd == null ? null : Number(row.daily_cap_usd),
      source:        'config',
      updatedAt:     row.updated_at,
    };
  } catch (e) {
    console.warn(`[costGuard:loadCapConfig] DB error (open-fail): ${e?.message?.slice(0, 200)}`);
    return null;
  }
}

/**
 * Read month-to-date AND day-to-date spend for this tenant on this surface.
 * One round-trip; returns { monthSpentUsd, daySpentUsd }.
 *
 * Note: we sum only rows where ok=1 OR cost_usd > 0. Failed Anthropic calls
 * with cost_usd populated (caller still spent tokens on the failed call)
 * count against the cap — we did pay for them. We do NOT include rows where
 * cost_usd IS NULL (e.g. provider 401 before any tokens were spent).
 */
export async function readSpend(pool, { tenantId, surface }) {
  const s = surface || DEFAULT_SURFACE;
  if (!pool) return { monthSpentUsd: 0, daySpentUsd: 0 };
  try {
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('surface',  sql.NVarChar(50),     s)
      .query(`
        SELECT
          COALESCE(SUM(CASE
            WHEN occurred_at >= DATEFROMPARTS(YEAR(SYSUTCDATETIME()), MONTH(SYSUTCDATETIME()), 1)
            THEN cost_usd ELSE 0 END), 0) AS month_spent,
          COALESCE(SUM(CASE
            WHEN occurred_at >= CAST(CAST(SYSUTCDATETIME() AS date) AS datetime2)
            THEN cost_usd ELSE 0 END), 0) AS day_spent
        FROM lumen.ai_usage
        WHERE tenant_id = @tenantId
          AND surface   = @surface
          AND cost_usd IS NOT NULL
      `);
    const row = r.recordset[0] || {};
    return {
      monthSpentUsd: Number(row.month_spent || 0),
      daySpentUsd:   Number(row.day_spent || 0),
    };
  } catch (e) {
    console.warn(`[costGuard:readSpend] DB error (open-fail): ${e?.message?.slice(0, 200)}`);
    return { monthSpentUsd: 0, daySpentUsd: 0, _error: e.message };
  }
}

/**
 * THE guard. Call this BEFORE the Anthropic call. Cheap (two indexed
 * lookups). On any DB error: open-fail (ok=true, source='error') — we never
 * let an audit-table issue break the build flow, mirroring logUsage's
 * non-fatal policy in callEmitter.js.
 *
 * @param {import('mssql').ConnectionPool} pool
 * @param {object}  args
 * @param {string}  args.tenantId
 * @param {string} [args.surface]            default 'arion.website_builder'
 * @param {number} [args.estimatedCostUsd]   default $0.50 (typical haiku block)
 * @returns {Promise<{
 *   ok: boolean,
 *   reason?: string,
 *   scope?: 'monthly' | 'daily',
 *   capUsd: number,
 *   spentUsd: number,
 *   remainingUsd: number,
 *   source: 'config' | 'env_default' | 'error',
 *   dailyCapUsd?: number | null,
 *   daySpentUsd?: number,
 * }>}
 */
export async function assertTenantUnderCap(pool, {
  tenantId,
  surface,
  estimatedCostUsd = 0.50,
}) {
  if (!tenantId) {
    return {
      ok: false,
      reason: 'bad_tenant',
      capUsd: 0, spentUsd: 0, remainingUsd: 0, source: 'error',
    };
  }
  const s = surface || DEFAULT_SURFACE;
  const est = Number.isFinite(estimatedCostUsd) && estimatedCostUsd >= 0
    ? Number(estimatedCostUsd) : 0.50;

  const cfg = await loadCapConfig(pool, { tenantId, surface: s });
  if (!cfg) {
    // DB error during config read — open-fail. callEmitter still writes the
    // audit row; founder sees the cost in lumen.ai_usage and can lower cap.
    return {
      ok: true,
      capUsd: defaultMonthlyCap(),
      spentUsd: 0,
      remainingUsd: defaultMonthlyCap(),
      source: 'error',
    };
  }

  const spend = await readSpend(pool, { tenantId, surface: s });

  // Daily check first (tighter cap typically). Only if a daily cap is set.
  if (cfg.dailyCapUsd != null && cfg.dailyCapUsd > 0) {
    const dayRemaining = cfg.dailyCapUsd - spend.daySpentUsd;
    if (spend.daySpentUsd + est > cfg.dailyCapUsd) {
      return {
        ok: false,
        reason: 'daily_cap_exceeded',
        scope: 'daily',
        capUsd: cfg.dailyCapUsd,
        spentUsd: spend.daySpentUsd,
        remainingUsd: Math.max(0, dayRemaining),
        source: cfg.source,
        // surface monthly too so caller can render both numbers if useful
        monthlyCapUsd: cfg.monthlyCapUsd,
        monthSpentUsd: spend.monthSpentUsd,
      };
    }
  }

  // Monthly check.
  const monthRemaining = cfg.monthlyCapUsd - spend.monthSpentUsd;
  if (spend.monthSpentUsd + est > cfg.monthlyCapUsd) {
    return {
      ok: false,
      reason: 'monthly_cap_exceeded',
      scope: 'monthly',
      capUsd: cfg.monthlyCapUsd,
      spentUsd: spend.monthSpentUsd,
      remainingUsd: Math.max(0, monthRemaining),
      source: cfg.source,
      dailyCapUsd: cfg.dailyCapUsd,
      daySpentUsd: spend.daySpentUsd,
    };
  }

  return {
    ok: true,
    capUsd: cfg.monthlyCapUsd,
    spentUsd: spend.monthSpentUsd,
    remainingUsd: monthRemaining,
    source: cfg.source,
    dailyCapUsd: cfg.dailyCapUsd,
    daySpentUsd: spend.daySpentUsd,
  };
}

/**
 * Upsert a cap config row. Used by the admin endpoint
 * PATCH /arion/sites/:siteId/ai-cap. Parameterized SQL only.
 *
 * Accepts partial updates — pass null/undefined for a field to leave it
 * unchanged on an existing row. On INSERT, undefined monthly_cap_usd falls
 * back to the table's DEFAULT (100.00); undefined daily_cap_usd stays NULL.
 *
 * @returns the row as stored after the upsert.
 */
export async function upsertCapConfig(pool, {
  tenantId,
  surface,
  monthlyCapUsd,
  dailyCapUsd,
  updatedBy,
  notes,
}) {
  const s = surface || DEFAULT_SURFACE;
  const req = pool.request()
    .input('tenantId',  sql.UniqueIdentifier, tenantId)
    .input('surface',   sql.NVarChar(50),     s)
    .input('monthly',   sql.Decimal(10, 2),   monthlyCapUsd == null ? null : Number(monthlyCapUsd))
    .input('daily',     sql.Decimal(10, 2),   dailyCapUsd   == null ? null : Number(dailyCapUsd))
    .input('updatedBy', sql.UniqueIdentifier, updatedBy || null)
    .input('notes',     sql.NVarChar(500),    notes || null);

  // MERGE: on existing row, only overwrite columns whose new value is
  // non-null. On insert, NULL monthly_cap_usd → table DEFAULT (100.00).
  await req.query(`
    MERGE lumen.ai_cap_config WITH (HOLDLOCK) AS target
      USING (SELECT @tenantId AS tenant_id, @surface AS surface) AS src
         ON target.tenant_id = src.tenant_id
        AND target.surface   = src.surface
    WHEN MATCHED THEN UPDATE SET
      monthly_cap_usd = COALESCE(@monthly, target.monthly_cap_usd),
      daily_cap_usd   = CASE WHEN @daily IS NULL THEN target.daily_cap_usd ELSE @daily END,
      updated_at      = SYSDATETIMEOFFSET(),
      updated_by      = COALESCE(@updatedBy, target.updated_by),
      notes           = COALESCE(@notes,     target.notes)
    WHEN NOT MATCHED THEN
      INSERT (tenant_id, surface, monthly_cap_usd, daily_cap_usd, updated_at, updated_by, notes)
      VALUES (@tenantId, @surface,
              COALESCE(@monthly, 100.00),
              @daily,
              SYSDATETIMEOFFSET(),
              @updatedBy,
              @notes);
  `);

  // Return the row as stored. Separate SELECT so the response is honest
  // about what's in the table (CASE-merged daily can be tricky).
  const out = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('surface',  sql.NVarChar(50),     s)
    .query(`
      SELECT tenant_id, surface, monthly_cap_usd, daily_cap_usd, updated_at, updated_by, notes
        FROM lumen.ai_cap_config
       WHERE tenant_id = @tenantId AND surface = @surface
    `);
  return out.recordset[0] || null;
}
