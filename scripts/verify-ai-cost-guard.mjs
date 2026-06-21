#!/usr/bin/env node
/**
 * Verification script for the AI Website Builder per-tenant cost guard.
 * --------------------------------------------------------------------------
 * Checks lib/websiteBuilder/costGuard.js + db/migrations/026_ai_cap_config.sql
 * end-to-end against the services SQL pool.
 *
 * What this proves:
 *   1. Migration 026 is applied (lumen.ai_cap_config exists).
 *   2. assertTenantUnderCap returns ok=false when configured cap is below
 *      (spend + estimate), with the right reason code + numbers.
 *   3. assertTenantUnderCap returns ok=true after the cap is raised.
 *   4. The daily cap path triggers independently of monthly.
 *   5. Env-default fallback works when no row is configured.
 *   6. upsertCapConfig is idempotent — partial updates preserve untouched
 *      fields (no accidental cap-resets).
 *   7. callEmitter short-circuits at the cap (no Anthropic call, no audit
 *      row written) — open-fail does NOT apply when cap is real.
 *
 * Tenant fixture:
 *   We use a fixed UUID 33333333-3333-3333-3333-333333333333 as the verifier
 *   tenant (NEVER overlaps with real tenants). Seeds + cleans its own data.
 *
 * Usage:
 *   node scripts/verify-ai-cost-guard.mjs
 *   SKIP_LIVE=1 ...                  # skip the callEmitter short-circuit step
 *
 * Exit codes:
 *   0 = all checks passed
 *   1 = at least one check failed
 *
 * Touches: lumen.ai_cap_config + lumen.ai_usage for the verifier tenant only.
 * Self-cleanup at the end.
 */

import 'dotenv/config';
import sql from 'mssql';
import { getServicesPool } from '../db/servicesPool.js';
import {
  assertTenantUnderCap,
  loadCapConfig,
  upsertCapConfig,
  DEFAULT_SURFACE,
} from '../lib/websiteBuilder/costGuard.js';
import { callEmitter } from '../lib/websiteBuilder/callEmitter.js';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';

let pass = 0;
let fail = 0;
let skip = 0;

function ok(msg)   { console.log(`  ${GREEN}✔${RESET} ${msg}`); pass++; }
function bad(msg)  { console.log(`  ${RED}✘${RESET} ${msg}`);   fail++; }
function warn(msg) { console.log(`  ${YELLOW}⊘${RESET} ${msg}`); skip++; }
function section(title) { console.log(`\n${BOLD}${CYAN}=== ${title} ===${RESET}`); }

// Verifier tenant — fixed UUID, never overlaps with real tenants. (We seed
// lumen.ai_usage rows directly so no real API spend occurs.)
const VERIFIER_TENANT = '33333333-3333-3333-3333-333333333333';
const SURFACE         = DEFAULT_SURFACE; // 'arion.website_builder'

async function clean(pool) {
  await pool.request()
    .input('tid',     sql.UniqueIdentifier, VERIFIER_TENANT)
    .input('surface', sql.NVarChar(50),     SURFACE)
    .query(`DELETE FROM lumen.ai_cap_config WHERE tenant_id = @tid AND surface = @surface`);
  await pool.request()
    .input('tid',     sql.UniqueIdentifier, VERIFIER_TENANT)
    .input('surface', sql.NVarChar(50),     SURFACE)
    .query(`DELETE FROM lumen.ai_usage WHERE tenant_id = @tid AND surface = @surface`);
}

/**
 * Seed a usage row with a specific cost into a specific time bucket.
 * - bucket='month'  → occurred_at = today (counts toward MTD + DTD)
 * - bucket='month_not_day' → occurred_at = first of month + 2 hours (counts
 *                            toward MTD only, NOT DTD). Skipped if today IS
 *                            the 1st (rare; verifier still passes other paths).
 */
async function seedUsage(pool, { costUsd, bucket = 'month' }) {
  let occurredExpr;
  if (bucket === 'month_not_day') {
    occurredExpr = `DATEADD(hour, 2, DATEFROMPARTS(YEAR(SYSUTCDATETIME()), MONTH(SYSUTCDATETIME()), 1))`;
  } else {
    occurredExpr = `SYSUTCDATETIME()`;
  }
  await pool.request()
    .input('tid',     sql.UniqueIdentifier, VERIFIER_TENANT)
    .input('surface', sql.NVarChar(50),     SURFACE)
    .input('cost',    sql.Decimal(10, 4),   Number(costUsd))
    .query(`
      INSERT INTO lumen.ai_usage
        (tenant_id, surface, sub_kind, provider, model_id, cost_usd, ok, occurred_at)
      VALUES
        (@tid, @surface, 'verify', 'anthropic', 'claude-haiku-4-5', @cost, 1, ${occurredExpr})
    `);
}

let pool = null;
try {
  pool = await getServicesPool();
} catch (e) {
  console.error(`${RED}fatal:${RESET} services pool unavailable — ${e.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 0. Migration applied
// ---------------------------------------------------------------------------
section('Migration 026 — lumen.ai_cap_config');
try {
  const r = await pool.request().query(`
    SELECT 1 AS ok
      FROM sys.tables
     WHERE name = 'ai_cap_config' AND schema_id = SCHEMA_ID('lumen')
  `);
  if (r.recordset.length === 1) ok('lumen.ai_cap_config exists');
  else bad('lumen.ai_cap_config MISSING — apply db/migrations/026_ai_cap_config.sql');
} catch (e) {
  bad(`schema check failed — ${e.message}`);
}

// ---------------------------------------------------------------------------
// 1. Pre-clean
// ---------------------------------------------------------------------------
section('Clean verifier tenant fixtures');
try {
  await clean(pool);
  ok('verifier tenant data cleared');
} catch (e) {
  bad(`clean failed — ${e.message}`);
}

// ---------------------------------------------------------------------------
// 2. Env-default fallback (no row in ai_cap_config)
// ---------------------------------------------------------------------------
section('Env-default fallback');
try {
  const cfg = await loadCapConfig(pool, { tenantId: VERIFIER_TENANT, surface: SURFACE });
  if (cfg.source === 'env_default') ok(`loadCapConfig falls back to env_default (monthly=$${cfg.monthlyCapUsd.toFixed(2)})`);
  else bad(`expected source=env_default, got ${cfg.source}`);

  const g = await assertTenantUnderCap(pool, { tenantId: VERIFIER_TENANT, surface: SURFACE, estimatedCostUsd: 0.50 });
  if (g.ok && g.source === 'env_default') ok(`assertTenantUnderCap: ok=true under env default cap (remaining=$${g.remainingUsd.toFixed(2)})`);
  else bad(`expected ok=true source=env_default, got ok=${g.ok} source=${g.source}`);
} catch (e) {
  bad(`env-default test threw — ${e.message}`);
}

// ---------------------------------------------------------------------------
// 3. Spec scenario: cap=$10, spend=$9.50, estimate=$1 → ok=false
// ---------------------------------------------------------------------------
section('Spec scenario — cap=$10, spend=$9.50, est=$1 → DENY');
try {
  await clean(pool);
  await upsertCapConfig(pool, {
    tenantId: VERIFIER_TENANT,
    surface:  SURFACE,
    monthlyCapUsd: 10.00,
    dailyCapUsd:   null,
  });
  await seedUsage(pool, { costUsd: 9.50, bucket: 'month' });

  const g = await assertTenantUnderCap(pool, {
    tenantId: VERIFIER_TENANT,
    surface:  SURFACE,
    estimatedCostUsd: 1.00,
  });
  if (!g.ok && g.reason === 'monthly_cap_exceeded' && g.scope === 'monthly') {
    ok(`DENY — reason=${g.reason}, cap=$${g.capUsd.toFixed(2)}, spent=$${g.spentUsd.toFixed(2)}, remaining=$${g.remainingUsd.toFixed(2)}`);
  } else {
    bad(`expected ok=false reason=monthly_cap_exceeded, got ok=${g.ok} reason=${g.reason}`);
  }
  if (Math.abs(g.spentUsd - 9.50) < 0.01) ok('spentUsd reflects seeded $9.50');
  else bad(`spentUsd=${g.spentUsd} expected ~9.50`);
  if (Math.abs(g.capUsd - 10.00) < 0.01) ok('capUsd reflects configured $10');
  else bad(`capUsd=${g.capUsd} expected 10.00`);
} catch (e) {
  bad(`scenario test threw — ${e.message}`);
}

// ---------------------------------------------------------------------------
// 4. Raise cap → ok=true
// ---------------------------------------------------------------------------
section('Raise cap to $50 → ALLOW');
try {
  await upsertCapConfig(pool, {
    tenantId: VERIFIER_TENANT,
    surface:  SURFACE,
    monthlyCapUsd: 50.00,
  });
  const g = await assertTenantUnderCap(pool, {
    tenantId: VERIFIER_TENANT,
    surface:  SURFACE,
    estimatedCostUsd: 1.00,
  });
  if (g.ok && g.source === 'config') {
    ok(`ALLOW — cap=$${g.capUsd.toFixed(2)}, spent=$${g.spentUsd.toFixed(2)}, remaining=$${g.remainingUsd.toFixed(2)}`);
  } else {
    bad(`expected ok=true source=config, got ok=${g.ok} source=${g.source} reason=${g.reason}`);
  }
} catch (e) {
  bad(`raise-cap test threw — ${e.message}`);
}

// ---------------------------------------------------------------------------
// 5. Daily cap path — independent of monthly
// ---------------------------------------------------------------------------
section('Daily cap path');
try {
  await clean(pool);
  await upsertCapConfig(pool, {
    tenantId: VERIFIER_TENANT,
    surface:  SURFACE,
    monthlyCapUsd: 1000.00,  // plenty of monthly room
    dailyCapUsd:   5.00,
  });
  await seedUsage(pool, { costUsd: 4.80, bucket: 'month' });  // also counts as today

  const g = await assertTenantUnderCap(pool, {
    tenantId: VERIFIER_TENANT,
    surface:  SURFACE,
    estimatedCostUsd: 0.50,
  });
  if (!g.ok && g.reason === 'daily_cap_exceeded' && g.scope === 'daily') {
    ok(`DENY on daily — cap=$${g.capUsd.toFixed(2)}, day_spent=$${g.spentUsd.toFixed(2)}`);
  } else {
    bad(`expected daily DENY, got ok=${g.ok} reason=${g.reason}`);
  }
} catch (e) {
  bad(`daily-cap test threw — ${e.message}`);
}

// ---------------------------------------------------------------------------
// 6. Idempotent partial upsert
// ---------------------------------------------------------------------------
section('upsertCapConfig partial update preserves untouched fields');
try {
  await clean(pool);
  // First write: set both.
  await upsertCapConfig(pool, {
    tenantId: VERIFIER_TENANT,
    surface:  SURFACE,
    monthlyCapUsd: 75.00,
    dailyCapUsd:   3.00,
    notes: 'initial',
  });
  // Second write: change monthly only.
  const after = await upsertCapConfig(pool, {
    tenantId: VERIFIER_TENANT,
    surface:  SURFACE,
    monthlyCapUsd: 120.00,
    // dailyCapUsd omitted → must preserve $3.00
  });
  if (Number(after.monthly_cap_usd) === 120.00) ok('monthly_cap_usd updated to $120');
  else bad(`monthly_cap_usd=${after.monthly_cap_usd} expected 120.00`);
  if (Number(after.daily_cap_usd) === 3.00) ok('daily_cap_usd preserved at $3.00 (not wiped to NULL)');
  else bad(`daily_cap_usd=${after.daily_cap_usd} expected 3.00`);
  if (after.notes === 'initial') ok('notes preserved at "initial"');
  else bad(`notes="${after.notes}" expected "initial"`);
} catch (e) {
  bad(`partial-upsert test threw — ${e.message}`);
}

// ---------------------------------------------------------------------------
// 7. callEmitter short-circuits at the cap (no Anthropic call)
// ---------------------------------------------------------------------------
section('callEmitter short-circuits at cap');
const skipLive = process.env.SKIP_LIVE === '1' || process.env.SKIP_LIVE === 'true';
if (skipLive) {
  warn('SKIP_LIVE — skipping callEmitter short-circuit test');
} else {
  try {
    await clean(pool);
    await upsertCapConfig(pool, {
      tenantId: VERIFIER_TENANT,
      surface:  SURFACE,
      monthlyCapUsd: 0.01,  // basically zero — will trip on any call
      dailyCapUsd:   null,
    });

    // Count audit rows before — we expect ZERO new rows after the call,
    // since the cap short-circuits before logUsage runs.
    const beforeRes = await pool.request()
      .input('tid', sql.UniqueIdentifier, VERIFIER_TENANT)
      .input('surface', sql.NVarChar(50), SURFACE)
      .query(`SELECT COUNT(*) AS n FROM lumen.ai_usage WHERE tenant_id=@tid AND surface=@surface`);
    const before = beforeRes.recordset[0].n;

    const res = await callEmitter({
      kind: 'hero',
      brand: {
        business_name: 'Verifier Test',
        industry: 'verifier',
        services: ['x'],
        primary_color: '#000000',
      },
      tenantId: VERIFIER_TENANT,
      siteId:   '44444444-4444-4444-4444-444444444444',
      pool,
    });

    if (!res.ok && res.error?.code === 'cap_exceeded') {
      ok(`callEmitter returned cap_exceeded — ${res.error.message?.slice(0, 80)}`);
    } else {
      bad(`expected cap_exceeded, got ok=${res.ok} code=${res.error?.code}`);
    }

    const afterRes = await pool.request()
      .input('tid', sql.UniqueIdentifier, VERIFIER_TENANT)
      .input('surface', sql.NVarChar(50), SURFACE)
      .query(`SELECT COUNT(*) AS n FROM lumen.ai_usage WHERE tenant_id=@tid AND surface=@surface`);
    const after = afterRes.recordset[0].n;
    if (after === before) ok(`no new lumen.ai_usage row written (count stayed at ${before}) — Anthropic was NOT called`);
    else bad(`expected 0 new audit rows, got ${after - before} — short-circuit did NOT prevent the provider call`);
  } catch (e) {
    bad(`short-circuit test threw — ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 8. Cleanup
// ---------------------------------------------------------------------------
section('Cleanup');
try {
  await clean(pool);
  ok('verifier tenant data cleaned');
} catch (e) {
  bad(`cleanup failed — ${e.message}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${BOLD}Summary:${RESET} ${GREEN}${pass} pass${RESET} · ${RED}${fail} fail${RESET} · ${YELLOW}${skip} skip${RESET}`);
try { await pool.close(); } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1);
