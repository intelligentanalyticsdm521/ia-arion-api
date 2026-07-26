#!/usr/bin/env npx tsx
/** READ-ONLY: per-data-point score decomposition for a site — WHY is the
 *  score what it is. Movement vs level vs benchmark, one row per data point. */
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';
import { buildArionDashboards } from '../../Portal-mybrand/src/analytics/arionDashboards';

const SITE = { name: 'Briarwood Dental', siteId: '46F87A02-49E0-475C-8D4A-C88D536A0E7E' };

const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net', database: 'iadm_services',
  options: { encrypt: true },
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();

const MONTHS: string[] = [];
{ const now = new Date(); for (let m = 11; m >= 0; m--) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1)); MONTHS.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`); } }

const mm = (await pool.request().input('site', sql.UniqueIdentifier, SITE.siteId).query(`
  SELECT FORMAT(period_month,'yyyy-MM') ym, metric_key, value
  FROM arion.metric_monthly WHERE site_id=@site AND dimension IS NULL`)).recordset;
await pool.close();

const byKey = new Map<string, Map<string, number>>();
for (const r of mm) {
  if (!byKey.has(r.metric_key)) byKey.set(r.metric_key, new Map());
  byKey.get(r.metric_key)!.set(r.ym, Number(r.value));
}
const metrics: Record<string, Array<number | null>> = {};
for (const [k, m] of byKey) metrics[k] = MONTHS.map((ym) => m.get(ym) ?? null);

const ds = buildArionDashboards({ metrics } as any);
console.log(`${SITE.name} — per-data-point autopsy (last month in series = ${MONTHS[11]})\n`);
for (const d of ds) {
  if (d.score == null) continue;
  console.log(`▶ ${d.label}: ${d.score}`);
  for (const s of d.sections) {
    if (s.score == null) continue;
    console.log(`  ${s.label}: ${s.score}`);
    for (const dp of s.dataPoints) {
      if (dp.unmeasured) continue;
      console.log(
        `    ${dp.key.padEnd(20)} score ${String(dp.score).padStart(3)}  ` +
        `mov ${String(dp.movementScore).padStart(3)} (${dp.movementPct == null ? '  n/a' : (dp.movementPct > 0 ? '+' : '') + dp.movementPct.toFixed(0).padStart(3) + '%'})  ` +
        `lvl ${dp.levelScore == null ? ' — ' : String(Math.round(dp.levelScore)).padStart(3)} (${dp.levelKind ?? 'no benchmark'})  ` +
        `cur ${dp.current == null ? '—' : Math.round(dp.current)}`
      );
    }
  }
}
