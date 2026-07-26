/**
 * benchmarks.js — the three-tier industry benchmark ladder (Brandon
 * 2026-07-26). Resolves a tenant's researched benchmarks from
 * arion.ia_insights_benchmark:
 *
 *   detail (local:{metro}:{vertical})  ← seeded from our own competitor/CrUX
 *                                        pulls (Ingestion Phase 2)
 *   → medium (vertical, e.g. dental_practice / pressure_washing)
 *   → high   (service industry, e.g. medical_practice / home_services)
 *   → default
 *
 * Tenant category comes from lumen.tenant_settings 'service_category'
 * (seeded 2026-07-26 for all four prod tenants). Returns
 * { metric_key: benchmark_value } with the most specific tier winning.
 * 'model' tier rows (scoring constants like serp_ctr_p1) are excluded here.
 */
import sql from 'mssql';

// medium vertical → high service-industry parent
export const CATEGORY_PARENT = {
  dental_practice: 'medical_practice',
  chiropractic: 'medical_practice',
  veterinary: 'medical_practice',
  med_spa: 'medical_practice',
  lawn_landscape: 'home_services',
  snow_removal: 'home_services',
  pressure_washing: 'home_services',
  junk_removal: 'home_services',
  hvac: 'home_services',
  plumbing: 'home_services',
  roofing: 'home_services',
  electrician: 'home_services',
  ag_services: 'agriculture',
  software_agency: 'professional_services',
  legal: 'professional_services',
  accounting: 'professional_services',
  cafe_coffee: 'food_beverage',
};

export async function getTenantCategory(pool, tenantId) {
  try {
    const r = await pool.request()
      .input('tid', sql.NVarChar(100), String(tenantId).toLowerCase())
      .query(`SELECT setting_value FROM lumen.tenant_settings
              WHERE tenant_id=@tid AND setting_key='service_category'`);
    return r.recordset[0]?.setting_value || null;
  } catch { return null; }
}

/** Resolve the benchmark map for a tenant: most specific tier wins. */
export async function resolveBenchmarks(pool, tenantId, { localKey = null } = {}) {
  const category = await getTenantCategory(pool, tenantId);
  const parent = category ? CATEGORY_PARENT[category] || null : null;
  // priority: local detail > medium (category) > high (parent) > default
  const cats = [localKey, category, parent, 'default'].filter(Boolean);
  const req = pool.request();
  const params = cats.map((c, i) => { req.input(`c${i}`, sql.NVarChar(100), c); return `@c${i}`; });
  const r = await req.query(`
    SELECT service_category, metric_key, benchmark_value
    FROM arion.ia_insights_benchmark
    WHERE service_category IN (${params.join(',')}) AND (tier IS NULL OR tier <> 'model')`);
  const rank = new Map(cats.map((c, i) => [c, i]));
  const out = {};
  const best = new Map();
  for (const row of r.recordset) {
    const pri = rank.get(row.service_category);
    if (pri == null) continue;
    if (!best.has(row.metric_key) || pri < best.get(row.metric_key)) {
      best.set(row.metric_key, pri);
      out[row.metric_key] = Number(row.benchmark_value);
    }
  }
  return { category, benchmarks: out };
}
