// ARGUS AI credit endpoints — balance, usage, manual grant, action pricing
// admin. Mounted at /argus on arion-api. Auth + tenant resolution applied
// by the parent router; this file only handles the credit/audit logic.
//
// Routes:
//   GET    /argus/balance                  current balance + monthly allocation
//   GET    /argus/usage?days=30            usage rollup by action_type
//   POST   /argus/grant                    founder-only: issue a credit grant
//   GET    /argus/pricing                  current per-action credit pricing
//   PATCH  /argus/pricing/:action_type     founder-only: edit pricing
//   GET    /argus/margin?days=30           founder-only: per-action margin dashboard data
//   GET    /argus/auto-topoff              current auto-topoff config for the tenant
//   PATCH  /argus/auto-topoff              update auto-topoff config (whitelisted fields)

import express from "express";
import sql from "mssql";
import { getServicesPool } from "../db/servicesPool.js";
import { calculatePool } from "../lib/argus/poolCalculator.js";
import { getBalance } from "../lib/argus/callWrapper.js";
import { argusTables } from "../lib/argus/tables.js";

const router = express.Router();

const FOUNDER_TENANT_ID = "8C9527B9-8999-4B31-A306-F3D4CCC39FBD";
function isFounderTenant(req) {
  const t = String(req?.tenant?.tenantId || "").toUpperCase();
  return t === FOUNDER_TENANT_ID.toUpperCase();
}

// ─── GET /argus/balance ────────────────────────────────────────────────
// Returns current balance + monthly allocation + status hint for badge color.
router.get("/balance", async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;
    const pool = await getServicesPool();
    const bal = await getBalance(pool, tenantId);

    // Tier sniff — read tenant's products + tiers from core.tenants.
    // For now we read the single subscription_tier column (legacy). When
    // multi-product tier breakdown ships, expand this to a per-product
    // join. ARION/SPARK/OLIVER live on iadm_services for ARION's purposes;
    // platform-side core.tenants is mirrored.
    const tr = await pool.request()
      .input("tid", sql.UniqueIdentifier, tenantId)
      .query(`SELECT TOP 1 subscription_tier FROM core.tenants WHERE tenant_id=@tid`);
    const tier = tr.recordset[0]?.subscription_tier || "lite";

    const calc = calculatePool([tier]);
    // % of monthly allocation remaining drives the badge color tier.
    let badge = "red";
    if (calc.monthly_credits > 0) {
      const pct = Number(bal.balance) / calc.monthly_credits;
      badge = pct >= 0.5 ? "green" : pct >= 0.2 ? "yellow" : "red";
    } else if (Number(bal.balance) > 0) {
      badge = "green"; // Lite tenant who purchased a pack
    }

    res.json({
      data: {
        tenant_id: tenantId,
        balance: Number(bal.balance),
        lifetime_granted: Number(bal.lifetime_granted),
        lifetime_spent: Number(bal.lifetime_spent),
        lifetime_refunded: Number(bal.lifetime_refunded),
        monthly_allocation: calc.monthly_credits,
        pool_base: calc.base,
        pool_bonus: calc.bonus,
        base_tier: calc.base_tier,
        badge_color: badge,
      },
    });
  } catch (err) {
    console.error("[argus/balance]", err);
    res.status(500).json({ error: { code: "balance_error", message: err.message } });
  }
});

// ─── GET /argus/usage ──────────────────────────────────────────────────
// Returns usage rollup by action_type for the date range.
router.get("/usage", async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;
    const days = Math.max(1, Math.min(365, Number(req.query.days || 30)));
    const pool = await getServicesPool();
    const T = await argusTables(pool);
    const r = await pool.request()
      .input("tid", sql.UniqueIdentifier, tenantId)
      .input("days", sql.Int, days)
      .query(`
        SELECT action_type,
               COUNT(*) AS call_count,
               SUM(credits_charged) AS credits_spent,
               SUM(cost_basis_usd) AS cost_basis_total,
               SUM(CASE WHEN outlier_refunded=1 THEN 1 ELSE 0 END) AS refunded_count
          FROM ${T.AI_CALL_AUDIT}
         WHERE tenant_id = @tid
           AND created_at > DATEADD(day, -@days, SYSUTCDATETIME())
         GROUP BY action_type
         ORDER BY credits_spent DESC
      `);
    res.json({ data: { days, by_action: r.recordset } });
  } catch (err) {
    console.error("[argus/usage]", err);
    res.status(500).json({ error: { code: "usage_error", message: err.message } });
  }
});

// ─── POST /argus/grant ─────────────────────────────────────────────────
// Founder-only manual credit grant. Used for: refunds (already auto), promos,
// service recovery credits, monthly allocation backfills.
router.post("/grant", async (req, res) => {
  try {
    if (!isFounderTenant(req)) return res.status(403).json({ error: { code: "forbidden", message: "Founder-only" } });
    const { tenant_id, credits, grant_type, notes, expires_at } = req.body || {};
    if (!tenant_id || !Number.isInteger(Number(credits))) {
      return res.status(400).json({ error: { code: "bad_request", message: "tenant_id + integer credits required" } });
    }
    // 2026-06-27 (M-03) Reject body-supplied tenant_id that doesn't match the session tenant to prevent cross-tenant grant minting.
    if (String(tenant_id).toUpperCase() !== String(req.tenant.tenantId).toUpperCase()) {
      return res.status(403).json({ error: { code: "TENANT_MISMATCH" } });
    }
    const pool = await getServicesPool();
    const T = await argusTables(pool);
    // Consolidated schema calls the grant-type column plan_key (values are
    // the same vocabulary: founder_grant / pack_purchase_* / auto_topoff).
    const typeCol = T.consolidated ? "plan_key" : "grant_type";
    const r = await pool.request()
      .input("tid",     sql.UniqueIdentifier, tenant_id)
      .input("credits", sql.Int,              Number(credits))
      .input("type",    sql.NVarChar(64),     grant_type || "founder_grant")
      .input("notes",   sql.NVarChar(500),    notes || null)
      .input("exp",     sql.DateTime2,        expires_at ? new Date(expires_at) : null)
      .query(`INSERT INTO ${T.CREDIT_GRANT}
                (tenant_id, credits, ${typeCol}, notes, expires_at)
              OUTPUT INSERTED.grant_id
              VALUES (@tid, @credits, @type, @notes, @exp)`);
    res.json({ data: { grant_id: r.recordset[0].grant_id } });
  } catch (err) {
    console.error("[argus/grant]", err);
    res.status(500).json({ error: { code: "grant_error", message: err.message } });
  }
});

// ─── GET /argus/pricing ────────────────────────────────────────────────
// Returns current per-action credit pricing. Available to any auth user
// (they need to know the cost to show "this action costs 25 credits" in UI).
router.get("/pricing", async (_req, res) => {
  try {
    const pool = await getServicesPool();
    const T = await argusTables(pool);
    const r = await pool.request().query(`
      SELECT action_type, credits_per_call, description, outlier_cap_usd, is_active, updated_at
        FROM ${T.ACTION_PRICING}
       WHERE is_active = 1
       ORDER BY credits_per_call ASC
    `);
    res.json({ data: r.recordset });
  } catch (err) {
    console.error("[argus/pricing]", err);
    res.status(500).json({ error: { code: "pricing_error", message: err.message } });
  }
});

// ─── PATCH /argus/pricing/:action_type ─────────────────────────────────
// Founder-only: edit per-action credit pricing. Takes effect next call.
router.patch("/pricing/:action_type", async (req, res) => {
  try {
    if (!isFounderTenant(req)) return res.status(403).json({ error: { code: "forbidden" } });
    const { action_type } = req.params;
    const { credits_per_call, outlier_cap_usd, description, is_active } = req.body || {};
    const pool = await getServicesPool();
    const T = await argusTables(pool);

    const sets = [];
    const rq = pool.request().input("at", sql.NVarChar(64), action_type);
    if (credits_per_call !== undefined) { sets.push("credits_per_call=@cpc"); rq.input("cpc", sql.Int, Number(credits_per_call)); }
    if (outlier_cap_usd !== undefined)  { sets.push("outlier_cap_usd=@ocu");  rq.input("ocu", sql.Decimal(10,4), Number(outlier_cap_usd)); }
    if (description !== undefined)       { sets.push("description=@d");        rq.input("d",   sql.NVarChar(500), description); }
    if (is_active !== undefined)         { sets.push("is_active=@ia");          rq.input("ia",  sql.Bit, is_active ? 1 : 0); }
    if (sets.length === 0) return res.status(400).json({ error: { code: "no_changes" } });
    sets.push("updated_at=SYSUTCDATETIME()");

    rq.input("uid", sql.UniqueIdentifier, req.user?.userId || null);
    sets.push("updated_by=@uid");

    await rq.query(`UPDATE ${T.ACTION_PRICING} SET ${sets.join(", ")} WHERE action_type=@at`);
    res.json({ data: { action_type, updated: true } });
  } catch (err) {
    console.error("[argus/pricing/patch]", err);
    res.status(500).json({ error: { code: "patch_error", message: err.message } });
  }
});

// ─── GET /argus/margin ──────────────────────────────────────────────────
// Founder-only: per-action margin dashboard data.
router.get("/margin", async (req, res) => {
  try {
    if (!isFounderTenant(req)) return res.status(403).json({ error: { code: "forbidden" } });
    const days = Math.max(1, Math.min(365, Number(req.query.days || 30)));
    const pool = await getServicesPool();
    const T = await argusTables(pool);
    const r = await pool.request()
      .input("days", sql.Int, days)
      .query(`
        SELECT
          a.action_type,
          COUNT(*) AS call_count,
          -- Net credits actually kept as revenue. An outlier-refunded row keeps
          -- credits_charged (so the spend + provider cost stay visible) but
          -- contributes ZERO revenue — otherwise the refunded credits inflate
          -- the margin. credits_refunded surfaces the offset explicitly.
          SUM(CASE WHEN a.outlier_refunded = 1 THEN 0 ELSE a.credits_charged END) AS credits_sold,
          SUM(CASE WHEN a.outlier_refunded = 1 THEN a.credits_charged ELSE 0 END) AS credits_refunded,
          SUM(a.cost_basis_usd) AS cost_basis_total,
          AVG(a.cost_basis_usd) AS avg_cost_basis,
          -- Margin math runs on NET (non-refunded) credits at $0.10/credit, so an
          -- outlier correctly reads as pure cost with no offsetting revenue.
          SUM(a.cost_basis_usd)
            / NULLIF(SUM(CASE WHEN a.outlier_refunded = 1 THEN 0 ELSE CAST(a.credits_charged AS DECIMAL(18,4)) END) * 0.10, 0) AS cost_ratio,
          1.0 - (SUM(a.cost_basis_usd)
            / NULLIF(SUM(CASE WHEN a.outlier_refunded = 1 THEN 0 ELSE CAST(a.credits_charged AS DECIMAL(18,4)) END) * 0.10, 0)) AS margin_ratio,
          SUM(CASE WHEN a.outlier_refunded = 1 THEN 1 ELSE 0 END) AS outlier_count
        FROM ${T.AI_CALL_AUDIT} a
       WHERE a.created_at > DATEADD(day, -@days, SYSUTCDATETIME())
         AND a.credits_charged > 0
       GROUP BY a.action_type
       ORDER BY cost_basis_total DESC
      `);
    res.json({ data: { days, by_action: r.recordset } });
  } catch (err) {
    console.error("[argus/margin]", err);
    res.status(500).json({ error: { code: "margin_error", message: err.message } });
  }
});

// ─── GET /argus/auto-topoff ────────────────────────────────────────────
// Returns the tenant's current auto-topoff config. Lazily seeds a default
// row (disabled, threshold=50, pack=100, cap=$300/mo) the first time a
// tenant looks at the page so the PATCH below can always assume a row.
router.get("/auto-topoff", async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;
    const pool = await getServicesPool();
    const T = await argusTables(pool);

    let r = await pool.request()
      .input("tid", sql.UniqueIdentifier, tenantId)
      .query(`SELECT enabled, threshold_credits, refill_pack_size, max_per_month_usd,
                     month_spent_usd, month_period_start, last_charge_at, last_charge_amount_usd
                FROM ${T.AUTOTOPOFF_CONFIG}
               WHERE tenant_id = @tid`);

    if (r.recordset.length === 0) {
      await pool.request()
        .input("tid", sql.UniqueIdentifier, tenantId)
        .query(`INSERT INTO ${T.AUTOTOPOFF_CONFIG} (tenant_id) VALUES (@tid)`);
      r = await pool.request()
        .input("tid", sql.UniqueIdentifier, tenantId)
        .query(`SELECT enabled, threshold_credits, refill_pack_size, max_per_month_usd,
                       month_spent_usd, month_period_start, last_charge_at, last_charge_amount_usd
                  FROM ${T.AUTOTOPOFF_CONFIG}
                 WHERE tenant_id = @tid`);
    }

    const row = r.recordset[0];
    res.json({
      data: {
        enabled: !!row.enabled,
        threshold_credits: Number(row.threshold_credits),
        refill_pack_size: Number(row.refill_pack_size),
        max_per_month_usd: Number(row.max_per_month_usd),
        month_spent_usd: Number(row.month_spent_usd),
        month_period_start: row.month_period_start,
        last_charge_at: row.last_charge_at,
        last_charge_amount_usd: row.last_charge_amount_usd == null ? null : Number(row.last_charge_amount_usd),
      },
    });
  } catch (err) {
    console.error("[argus/auto-topoff:get]", err);
    res.status(500).json({ error: { code: "autotopoff_get_error", message: err.message } });
  }
});

// ─── PATCH /argus/auto-topoff ──────────────────────────────────────────
// Updates the tenant's auto-topoff config. Only the four user-controlled
// fields are writable here; bookkeeping columns are owned by the job.
// Pack size is constrained to the existing Stripe catalog values.
const ALLOWED_PACK_SIZES = new Set([50, 100, 150, 200, 250, 300, 400, 500, 750, 1000]);

router.patch("/auto-topoff", async (req, res) => {
  try {
    const tenantId = req.tenant.tenantId;
    const body = req.body || {};

    const sets = [];
    const pool = await getServicesPool();
    const T = await argusTables(pool);
    const rq = pool.request().input("tid", sql.UniqueIdentifier, tenantId);

    if (body.enabled !== undefined) {
      sets.push("enabled = @enabled");
      rq.input("enabled", sql.Bit, body.enabled ? 1 : 0);
    }
    if (body.threshold_credits !== undefined) {
      const n = Number(body.threshold_credits);
      if (!Number.isInteger(n) || n <= 0 || n > 100000) {
        return res.status(400).json({ error: { code: "bad_threshold", message: "threshold_credits must be a positive integer ≤ 100000" } });
      }
      sets.push("threshold_credits = @th");
      rq.input("th", sql.Int, n);
    }
    if (body.refill_pack_size !== undefined) {
      const n = Number(body.refill_pack_size);
      if (!ALLOWED_PACK_SIZES.has(n)) {
        return res.status(400).json({ error: { code: "bad_pack_size", message: `refill_pack_size must be one of: ${[...ALLOWED_PACK_SIZES].join(", ")}` } });
      }
      sets.push("refill_pack_size = @ps");
      rq.input("ps", sql.Int, n);
    }
    if (body.max_per_month_usd !== undefined) {
      const n = Number(body.max_per_month_usd);
      if (!Number.isInteger(n) || n < 0 || n > 100000) {
        return res.status(400).json({ error: { code: "bad_max", message: "max_per_month_usd must be a non-negative integer ≤ 100000" } });
      }
      sets.push("max_per_month_usd = @mx");
      rq.input("mx", sql.Int, n);
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: { code: "no_changes", message: "No writable fields supplied" } });
    }

    sets.push("updated_at = SYSUTCDATETIME()");
    sets.push("updated_by = @uid");
    rq.input("uid", sql.UniqueIdentifier, req.user?.userId || null);

    // Upsert: if no row exists yet, INSERT a defaults row first so the
    // UPDATE below has something to hit. Avoids a MERGE here for clarity.
    await pool.request()
      .input("tid", sql.UniqueIdentifier, tenantId)
      .query(`IF NOT EXISTS (SELECT 1 FROM ${T.AUTOTOPOFF_CONFIG} WHERE tenant_id=@tid)
                INSERT INTO ${T.AUTOTOPOFF_CONFIG} (tenant_id) VALUES (@tid)`);

    await rq.query(`UPDATE ${T.AUTOTOPOFF_CONFIG}
                       SET ${sets.join(", ")}
                     WHERE tenant_id = @tid`);

    const r = await pool.request()
      .input("tid", sql.UniqueIdentifier, tenantId)
      .query(`SELECT enabled, threshold_credits, refill_pack_size, max_per_month_usd,
                     month_spent_usd, month_period_start, last_charge_at, last_charge_amount_usd
                FROM ${T.AUTOTOPOFF_CONFIG}
               WHERE tenant_id = @tid`);
    const row = r.recordset[0];

    res.json({
      data: {
        enabled: !!row.enabled,
        threshold_credits: Number(row.threshold_credits),
        refill_pack_size: Number(row.refill_pack_size),
        max_per_month_usd: Number(row.max_per_month_usd),
        month_spent_usd: Number(row.month_spent_usd),
        month_period_start: row.month_period_start,
        last_charge_at: row.last_charge_at,
        last_charge_amount_usd: row.last_charge_amount_usd == null ? null : Number(row.last_charge_amount_usd),
      },
    });
  } catch (err) {
    console.error("[argus/auto-topoff:patch]", err);
    res.status(500).json({ error: { code: "autotopoff_patch_error", message: err.message } });
  }
});

export default router;
