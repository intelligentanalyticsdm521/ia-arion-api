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

import express from "express";
import sql from "mssql";
import { getServicesPool } from "../db/servicesPool.js";
import { calculatePool } from "../lib/argus/poolCalculator.js";
import { getBalance } from "../lib/argus/callWrapper.js";

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
    const r = await pool.request()
      .input("tid", sql.UniqueIdentifier, tenantId)
      .input("days", sql.Int, days)
      .query(`
        SELECT action_type,
               COUNT(*) AS call_count,
               SUM(credits_charged) AS credits_spent,
               SUM(cost_basis_usd) AS cost_basis_total,
               SUM(CASE WHEN outlier_refunded=1 THEN 1 ELSE 0 END) AS refunded_count
          FROM lumen.ai_call_audit
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
    const pool = await getServicesPool();
    const r = await pool.request()
      .input("tid",     sql.UniqueIdentifier, tenant_id)
      .input("credits", sql.Int,              Number(credits))
      .input("type",    sql.NVarChar(64),     grant_type || "founder_grant")
      .input("notes",   sql.NVarChar(500),    notes || null)
      .input("exp",     sql.DateTime2,        expires_at ? new Date(expires_at) : null)
      .query(`INSERT INTO lumen.argus_credit_grant
                (tenant_id, credits, grant_type, notes, expires_at)
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
    const r = await pool.request().query(`
      SELECT action_type, credits_per_call, description, outlier_cap_usd, is_active, updated_at
        FROM lumen.argus_action_pricing
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

    await rq.query(`UPDATE lumen.argus_action_pricing SET ${sets.join(", ")} WHERE action_type=@at`);
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
    const r = await pool.request()
      .input("days", sql.Int, days)
      .query(`
        SELECT
          a.action_type,
          COUNT(*) AS call_count,
          SUM(a.credits_charged) AS credits_sold,
          SUM(a.cost_basis_usd) AS cost_basis_total,
          AVG(a.cost_basis_usd) AS avg_cost_basis,
          SUM(a.cost_basis_usd) / NULLIF(SUM(CAST(a.credits_charged AS DECIMAL(18,4))) * 0.10, 0) AS cost_ratio,
          1.0 - (SUM(a.cost_basis_usd) / NULLIF(SUM(CAST(a.credits_charged AS DECIMAL(18,4))) * 0.10, 0)) AS margin_ratio,
          SUM(CASE WHEN a.outlier_refunded=1 THEN 1 ELSE 0 END) AS outlier_count
        FROM lumen.ai_call_audit a
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

export default router;
