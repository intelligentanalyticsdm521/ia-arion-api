// lib/argus/tables.js — canonical ARGUS table names for arion-api (ESM twin
// of oliver-api/lib/argus/tables.js and LUMEN-API/src/lib/argus/tables.js).
//
// The credit tables moved to the argus schema (LUMEN migration 132 — Brandon
// 2026-08-16: "it's an ARGUS service so it should be an ARGUS table"). This
// helper is the one place the names live; the split-brain defect existed
// because the names were spelled out across six files.
//
// Deploy-order safety (the migration-131 pattern): consolidated names are
// used only when argus.credit_grant actually exists, probed once per process;
// otherwise the pre-consolidation names keep working. Drop the legacy map
// once 132 is applied everywhere.

const CONSOLIDATED = {
  consolidated: true,
  CREDIT_GRANT: "argus.credit_grant",
  CREDIT_USE: "argus.credit_use",
  AI_CALL_AUDIT: "argus.ai_call_audit",
  ACTION_PRICING: "argus.action_pricing",
  AUTOTOPOFF_CONFIG: "argus.autotopoff_config",
  BALANCE_PROC: "argus.sp_balance",
};

const LEGACY = {
  consolidated: false,
  CREDIT_GRANT: "lumen.argus_credit_grant",
  CREDIT_USE: null, // no debit ledger pre-consolidation (090 audit-only model)
  AI_CALL_AUDIT: "lumen.ai_call_audit",
  ACTION_PRICING: "lumen.argus_action_pricing",
  AUTOTOPOFF_CONFIG: "lumen.argus_autotopoff_config",
  BALANCE_PROC: "lumen.sp_argus_balance",
};

let _consolidated = null; // null = not probed yet

export async function argusTables(pool) {
  if (_consolidated === null) {
    try {
      const r = await pool.request().query("SELECT OBJECT_ID('argus.credit_grant', 'U') AS id");
      _consolidated = r.recordset?.[0]?.id != null;
      if (!_consolidated) {
        console.warn("[argus] argus.credit_grant not found — using pre-consolidation table names (apply LUMEN migration 132)");
      }
    } catch {
      _consolidated = false;
    }
  }
  return _consolidated ? CONSOLIDATED : LEGACY;
}

// FAIL-CLOSED global spend gate. Only the exact value 'true' enables spend;
// absence, other values, and read errors refuse. Reads the new name first,
// falls back to the old (migration 131 carried values over).
export async function isArgusSpendEnabled(pool) {
  for (const table of ["argus.platform_config", "lumen.argus_platform_config"]) {
    try {
      const r = await pool
        .request()
        .query(`SELECT [value] FROM ${table} WHERE [key] = N'spend_enabled'`);
      if (r.recordset?.length) {
        return String(r.recordset[0].value || "").toLowerCase() === "true";
      }
    } catch {
      /* table absent — try the next name */
    }
  }
  console.warn("[argus] spend gate unreadable (no argus.platform_config or lumen.argus_platform_config row) — refusing spend");
  return false;
}

// Test seam.
export function _resetArgusTablesProbe() {
  _consolidated = null;
}
