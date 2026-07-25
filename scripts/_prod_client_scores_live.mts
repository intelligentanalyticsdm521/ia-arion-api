#!/usr/bin/env npx tsx
/**
 * READ-ONLY prod client ARION scoring from the LIVE SE Ranking API.
 *
 * The arion-func capture job only ever wrote position history for the IA
 * site, so the DB has zero client keyword rows — but all four SE Ranking
 * projects exist and hold the real history. This pulls positions straight
 * from the API (no DB writes anywhere) and scores them through the same
 * engine. SPARK/OLIVER stay unmeasured for clients — no real CRM/ops data.
 *
 * Run from C:\dev\iadm\arion-api:  npx tsx scripts/_prod_client_scores_live.mts
 */
import fs from 'node:fs';
import { DefaultAzureCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import { buildArionDashboards } from '../../Portal-mybrand/src/analytics/arionDashboards';
import { buildIntelligenceMirror, ARION_MIRROR } from '../../Portal-mybrand/src/analytics/intelligenceMirror';
import { businessPulse, type DashboardScore } from '../../Portal-mybrand/src/analytics/scoring';

const PROJECTS = [
  { name: 'Intelligent Analytics', domain: 'intelligentanalyticsdm.com', projectId: 2465230 },
  { name: 'Rolling In It', domain: 'rollinginitllc.com', projectId: 12497786 },
  { name: 'Briarwood Dental', domain: 'briarwoodsmiles.com', projectId: 2671555 },
  { name: 'Midwest Ag Services', domain: 'midwestagservices.com', projectId: 2688562 },
];

// ── API key: Key Vault first, fall back to the existing verify script ──────
async function getKey(): Promise<string> {
  try {
    const kv = new SecretClient('https://kv-iadm-prod.vault.azure.net/', new DefaultAzureCredential());
    for (const n of ['SE-RANKING-API-KEY', 'SERANKING-API-KEY', 'SE-RANKING-KEY', 'seranking-api-key']) {
      try { const s = await kv.getSecret(n); if (s?.value) { console.log(`[key] from KV secret ${n}`); return s.value.trim(); } } catch {}
    }
  } catch {}
  const src = fs.readFileSync(new URL('./_verify_seranking_rii.mjs', import.meta.url), 'utf8');
  const m = src.match(/SR_KEY = '([0-9a-f]{20,})'/);
  if (!m) throw new Error('No SE Ranking key found');
  console.log('[key] from existing verify script');
  return m[1];
}

const KEY = await getKey();
const api = async (path: string) => {
  const r = await fetch(`https://api4.seranking.com${path}`, { headers: { Authorization: `Token ${KEY}` } });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
};

// ── 12 calendar months ending this month ──────────────────────────────────
const MONTHS: string[] = [];
{
  const now = new Date();
  for (let m = 11; m >= 0; m--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
    MONTHS.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
}
const dateFrom = `${MONTHS[0]}-01`;
const dateTo = new Date().toISOString().slice(0, 10);
const idxOfMonth = (ym: string) => MONTHS.indexOf(ym);

const roll = (ds: DashboardScore[]) => businessPulse(ds.map((d) => d.score));
const blend = (t: number | null, i: number | null) => (t == null ? i : i == null ? t : Math.round(t * 0.5 + i * 0.5));

for (const p of PROJECTS) {
  try {
    // v4 shape (probed): array of SITE ENGINES, each { site_engine_id,
    // keywords: [{ id, name, volume, positions: [{date, pos}] }] }.
    // Score the PRIMARY engine (first) so desktop/mobile/local engines don't
    // triple-count the same keyword.
    const raw = await api(`/sites/${p.projectId}/positions?date_from=${dateFrom}&date_to=${dateTo}&with_landing_pages=0`);
    const engines: any[] = Array.isArray(raw) ? raw : [];
    const kwList: any[] = engines[0]?.keywords || [];
    console.log(`\n[${p.name}] engines: ${engines.length} · keywords on primary engine: ${kwList.length}`);
    // month → keyword → ranked positions[]. A month counts as CHECKED when any
    // position entry exists for it (even unranked) — "checked and ranking for
    // nothing" is a real zero, not missing data.
    const byMonthKw = new Map<string, Map<string, number[]>>();
    const checkedMonths = new Set<string>();
    for (const kw of kwList) {
      const kid = String(kw.name ?? kw.id);
      const posArr: any[] = Array.isArray(kw.positions) ? kw.positions : [];
      for (const pt of posArr) {
        const date = String(pt.date || '');
        if (!date) continue;
        const ym = date.slice(0, 7);
        if (idxOfMonth(ym) < 0) continue;
        checkedMonths.add(ym);
        const pos = Number(pt.pos ?? pt.position);
        if (!isFinite(pos) || pos < 1 || pos > 100) continue; // 0/""/absent = not ranked
        if (!byMonthKw.has(ym)) byMonthKw.set(ym, new Map());
        const mk = byMonthKw.get(ym)!;
        if (!mk.has(kid)) mk.set(kid, []);
        mk.get(kid)!.push(pos);
      }
    }

    const monthAvgs = (mk: Map<string, number[]> | undefined) =>
      mk ? [...mk.values()].map((a) => a.reduce((s, v) => s + v, 0) / a.length) : [];
    /** checked months get real values (zeros count); unchecked months stay null */
    const series = (fn: (avgs: number[]) => number | null): Array<number | null> =>
      MONTHS.map((ym) => (checkedMonths.has(ym) ? fn(monthAvgs(byMonthKw.get(ym))) : null));

    const metrics: Record<string, Array<number | null>> = {};
    if (checkedMonths.size) {
      metrics.kw_tracked = series(() => kwList.length);
      metrics.kw_top3 = series((a) => a.filter((x) => x <= 3).length);
      metrics.kw_top10 = series((a) => a.filter((x) => x <= 10).length);
      metrics.kw_top30 = series((a) => a.filter((x) => x <= 30).length);
      metrics.gsc_avg_position = series((a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null));
    }

    const trendDs = buildArionDashboards({ metrics } as any);
    const intelDs = buildIntelligenceMirror({ metrics } as any, ARION_MIRROR).dashboards;
    const tS = roll(trendDs), iS = roll(intelDs);
    let meas = 0, tot = 0;
    for (const d of trendDs) for (const s of d.sections) for (const dp of s.dataPoints) { tot++; if (!dp.unmeasured) meas++; }

    console.log(`\n══ ${p.name} (${p.domain}) — SE Ranking project ${p.projectId} ══`);
    console.log(`  keywords tracked: ${kwList.length} · months checked: ${checkedMonths.size}`);
    // month-by-month movement context so the score is judgeable
    const line = (label: string, s: Array<number | null> | undefined, fmt = (v: number) => String(Math.round(v))) =>
      s && console.log(`  ${label.padEnd(9)} ${MONTHS.map((ym, i) => (s[i] == null ? '  ·' : fmt(s[i]!).padStart(3))).join(' ')}`);
    console.log(`  months:   ${MONTHS.map((m) => m.slice(2).replace('-', '/')).join(' ')}`);
    line('top10', metrics.kw_top10);
    line('top30', metrics.kw_top30);
    line('avg pos', metrics.gsc_avg_position, (v) => v.toFixed(0));
    console.log(`  ARION score (real keyword data only): platform ${blend(tS, iS) ?? '—'} (trend ${tS ?? '—'} / intel ${iS ?? '—'}) · ${meas} of ${tot} data points measurable`);
  } catch (e: any) {
    console.log(`\n══ ${p.name} — [ERR] ${e.message}`);
  }
}
