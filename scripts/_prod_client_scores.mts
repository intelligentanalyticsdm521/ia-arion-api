#!/usr/bin/env npx tsx
/**
 * READ-ONLY prod client scoring run (Brandon 2026-07-25):
 * "run this on our production clients — where the actual data would score them."
 *
 * Derives 12-month series from REAL prod tables only, runs them through the
 * SAME scoring engine + catalogs the app uses, and reports scores WITH
 * coverage. Metrics with no real source stay unmeasured — excluded and
 * renormalized, never scored as zero (the locked model).
 *
 * Real sources found by inventory (2026-07-25):
 *   ARION  — arion.se_ranking_position_history (224k rows, all 4 sites),
 *            se_ranking_backlink_snapshot, site_form_submission (IA only)
 *   SPARK  — lumen.contact + lumen.campaign (IA tenant only)
 *   OLIVER — oliver.invoice / job / quote (IA tenant only)
 *   Empty in prod: GSC (1 month), GA4, GBP insights/profile, PSI series, page views.
 *
 * Run from C:\dev\iadm\arion-api:  npx tsx scripts/_prod_client_scores.mts
 */
import sql from 'mssql';
import { AzureCliCredential } from '@azure/identity';
import { buildArionDashboards } from '../../Portal-mybrand/src/analytics/arionDashboards';
import { buildSparkDashboards } from '../../Portal-mybrand/src/analytics/sparkDashboards';
import { buildOliverDashboards } from '../../Portal-mybrand/src/analytics/oliverDashboards';
import { buildIntelligenceMirror, ARION_MIRROR, SPARK_MIRROR, OLIVER_MIRROR } from '../../Portal-mybrand/src/analytics/intelligenceMirror';
import { businessPulse, type DashboardScore } from '../../Portal-mybrand/src/analytics/scoring';

const TENANTS = [
  { name: 'Intelligent Analytics', id: '8C9527B9-8999-4B31-A306-F3D4CCC39FBD', siteId: '64C43F2F-B4FE-40C2-B023-0F06F7D275FA', domain: 'intelligentanalyticsdm.com' },
  { name: 'Rolling In It', id: '12839687-67FA-4144-A152-1219D1A64901', siteId: '4E3B2AE2-4133-4813-84AA-4196661ED6F9', domain: 'rollinginitllc.com' },
  { name: 'Briarwood Dental', id: '45E93346-DBA9-48D5-802B-A4E09A1B03A9', siteId: '46F87A02-49E0-475C-8D4A-C88D536A0E7E', domain: 'briarwoodsmiles.com' },
  { name: 'Midwest Ag Services', id: '777C1093-F725-424B-8293-E6881190C40C', siteId: 'CFE34569-780C-4548-8F06-CFC27EBC69B7', domain: 'midwestagservices.com' },
];

// ── 12 calendar months ending this month ──────────────────────────────────
const MONTHS: string[] = [];
{
  const now = new Date();
  for (let m = 12; m >= 0; m--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1));
    MONTHS.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
}
const idxOf = (ym: string) => MONTHS.indexOf(ym);

/** rows [{ym, v}] → 12-length series; null BEFORE first activity, 0 after. */
function toSeries(rows: Array<{ ym: string; v: number | null }>, opts?: { zeroFill?: boolean }): Array<number | null> {
  const s: Array<number | null> = new Array(MONTHS.length).fill(null);
  for (const r of rows) { const i = idxOf(r.ym); if (i >= 0 && r.v != null) s[i] = Number(r.v); }
  if (opts?.zeroFill !== false) {
    const first = s.findIndex((v) => v != null);
    if (first >= 0) for (let i = first; i < s.length; i++) if (s[i] == null) s[i] = 0;
  }
  return s;
}
const hasData = (s: Array<number | null>) => s.some((v) => v != null);

const token = await new AzureCliCredential().getToken('https://database.windows.net/.default');
const pool = await new sql.ConnectionPool({
  server: 'sql-iadm-prod-cus.database.windows.net',
  database: 'iadm_services',
  options: { encrypt: true },
  authentication: { type: 'azure-active-directory-access-token', options: { token: token.token } },
}).connect();

const Q = async (query: string, inputs: Record<string, string> = {}) => {
  const req = pool.request();
  for (const [k, v] of Object.entries(inputs)) req.input(k, v);
  return (await req.query(query)).recordset;
};

const roll = (ds: DashboardScore[]) => businessPulse(ds.map((d) => d.score));
const blend = (t: number | null, i: number | null) => (t == null ? i : i == null ? t : Math.round(t * 0.5 + i * 0.5));
const measuredOf = (ds: DashboardScore[]) => {
  let meas = 0, tot = 0;
  for (const d of ds) for (const s of d.sections) for (const dp of s.dataPoints) { tot++; if (!dp.unmeasured) meas++; }
  return { meas, tot };
};

try {
  for (const t of TENANTS) {
    // ── ARION: read arion.metric_monthly — the EXACT artifact the app's prod
    // path serves. This makes the script the acceptance test for the backfill
    // (kw_* rows are aggregated on the canonical Google-desktop engine).
    const mm = await Q(`
      SELECT FORMAT(period_month,'yyyy-MM') ym, metric_key, value
      FROM arion.metric_monthly
      WHERE site_id=@site AND dimension IS NULL`, { site: t.siteId });
    // Every stored overall metric feeds the engine directly — the metric_key
    // vocabulary IS the catalog vocabulary (gsc_* / ga_* / gbp_* / kw_*).
    const byKey = new Map<string, Array<{ ym: string; v: number }>>();
    for (const r of mm) {
      if (!byKey.has(r.metric_key)) byKey.set(r.metric_key, []);
      byKey.get(r.metric_key)!.push({ ym: r.ym, v: Number(r.value) });
    }
    // per-keyword dimension rows → latest-month summary (real substance line)
    const dimRows = await Q(`
      SELECT FORMAT(period_month,'yyyy-MM') ym, dimension_value kw, value pos
      FROM arion.metric_monthly
      WHERE site_id=@site AND metric_key='kw_position' AND dimension='keyword'`, { site: t.siteId });
    const byMonth = new Map<string, number[]>();
    for (const r of dimRows) {
      if (!byMonth.has(r.ym)) byMonth.set(r.ym, []);
      byMonth.get(r.ym)!.push(Number(r.pos));
    }
    const backlinks = await Q(`
      SELECT FORMAT(snapshot_date,'yyyy-MM') ym, COUNT(*) links, COUNT(DISTINCT referring_domain) doms
      FROM arion.se_ranking_backlink_snapshot WHERE site_id=@site
      GROUP BY FORMAT(snapshot_date,'yyyy-MM')`, { site: t.siteId });
    const forms = await Q(`
      SELECT FORMAT(created_at,'yyyy-MM') ym, COUNT(*) v FROM arion.site_form_submission
      WHERE tenant_id=@tid GROUP BY FORMAT(created_at,'yyyy-MM')`, { tid: t.id });

    const arionMetrics: Record<string, Array<number | null>> = {};
    const put = (k: string, s: Array<number | null>) => { if (hasData(s)) arionMetrics[k] = s; };
    for (const [key, rows] of byKey) put(key, toSeries(rows, { zeroFill: false }));
    put('backlinks', toSeries(backlinks.map((r: any) => ({ ym: r.ym, v: r.links })), { zeroFill: false }));
    put('referring_domains', toSeries(backlinks.map((r: any) => ({ ym: r.ym, v: r.doms })), { zeroFill: false }));
    put('form_submissions', toSeries(forms.map((r: any) => ({ ym: r.ym, v: r.v }))));

    // Running-month + unmeasured guards — mirror arionMetrics.js prod path
    // (score the last COMPLETE month for sums; all-zero series = unmeasured).
    const ARION_SUM_KEYS = new Set(['gsc_impressions', 'gsc_clicks', 'bing_impressions', 'bing_clicks', 'gbp_impressions', 'gbp_impr_maps', 'gbp_impr_search', 'gbp_calls', 'gbp_directions', 'gbp_website_clicks', 'gbp_posts', 'ga_sessions', 'ga_users', 'ga_new_users', 'ga_conversions', 'form_submissions', 'content_pageviews']);
    for (const key of Object.keys(arionMetrics)) {
      if (ARION_SUM_KEYS.has(key)) arionMetrics[key][MONTHS.length - 1] = null;
      const vals = arionMetrics[key].filter((v) => v != null);
      if (!vals.length || vals.every((v) => v === 0)) delete arionMetrics[key];
    }

    // ── SPARK: lumen contacts + campaigns ──────────────────────────────────
    const cNew = await Q(`
      SELECT FORMAT(created_at,'yyyy-MM') ym, COUNT(*) v FROM lumen.contact
      WHERE tenant_id=@tid AND is_deleted=0 GROUP BY FORMAT(created_at,'yyyy-MM')`, { tid: t.id.toLowerCase() });
    const camps = await Q(`
      SELECT FORMAT(sent_at,'yyyy-MM') ym, COUNT(*) runs, SUM(total_sent) sent, SUM(total_opened) opened,
             SUM(total_clicked) clicked, SUM(total_bounced) bounced, SUM(total_unsubscribed) unsub
      FROM lumen.campaign WHERE tenant_id=@tid AND sent_at IS NOT NULL
      GROUP BY FORMAT(sent_at,'yyyy-MM')`, { tid: t.id.toLowerCase() });

    const sparkMetrics: Record<string, Array<number | null>> = {};
    const sput = (k: string, s: Array<number | null>) => { if (hasData(s)) sparkMetrics[k] = s; };
    const newSeries = toSeries(cNew.map((r: any) => ({ ym: r.ym, v: r.v })));
    if (hasData(newSeries)) {
      sput('contacts_new', newSeries);
      // cumulative total at month end
      let run = 0; const totalS: Array<number | null> = newSeries.map((v) => (v == null ? null : (run += v)));
      sput('contacts_total', totalS);
    }
    const rate = (num: any, den: any) => (den > 0 ? (Number(num) / Number(den)) * 100 : null);
    sput('campaigns_run', toSeries(camps.map((r: any) => ({ ym: r.ym, v: r.runs }))));
    sput('emails_sent', toSeries(camps.map((r: any) => ({ ym: r.ym, v: r.sent }))));
    sput('unique_opens', toSeries(camps.map((r: any) => ({ ym: r.ym, v: r.opened }))));
    sput('open_rate', toSeries(camps.map((r: any) => ({ ym: r.ym, v: rate(r.opened, r.sent) })), { zeroFill: false }));
    sput('click_rate', toSeries(camps.map((r: any) => ({ ym: r.ym, v: rate(r.clicked, r.sent) })), { zeroFill: false }));
    sput('click_to_open', toSeries(camps.map((r: any) => ({ ym: r.ym, v: rate(r.clicked, r.opened) })), { zeroFill: false }));
    sput('bounce_rate', toSeries(camps.map((r: any) => ({ ym: r.ym, v: rate(r.bounced, r.sent) })), { zeroFill: false }));
    sput('delivery_rate', toSeries(camps.map((r: any) => ({ ym: r.ym, v: r.sent > 0 ? ((r.sent - (r.bounced || 0)) / r.sent) * 100 : null })), { zeroFill: false }));
    sput('unsub_rate', toSeries(camps.map((r: any) => ({ ym: r.ym, v: rate(r.unsub, r.sent) })), { zeroFill: false }));
    for (const key of ['contacts_new', 'campaigns_run', 'emails_sent', 'unique_opens']) {
      if (sparkMetrics[key]) sparkMetrics[key][MONTHS.length - 1] = null; // running month
    }
    for (const key of Object.keys(sparkMetrics)) {
      const vals = sparkMetrics[key].filter((v) => v != null);
      if (!vals.length || vals.every((v) => v === 0)) delete sparkMetrics[key];
    }

    // ── OLIVER: invoices / jobs / quotes ───────────────────────────────────
    const inv = await Q(`
      SELECT FORMAT(created_at,'yyyy-MM') ym, COUNT(*) n, SUM(total) revenue, AVG(total) avg_inv
      FROM oliver.invoice WHERE tenant_id=@tid AND (is_archived IS NULL OR is_archived=0)
      GROUP BY FORMAT(created_at,'yyyy-MM')`, { tid: t.id });
    const jobs = await Q(`
      SELECT FORMAT(COALESCE(actual_end, scheduled_start, created_at),'yyyy-MM') ym,
             SUM(CASE WHEN status IN ('completed','done','closed') THEN 1 ELSE 0 END) done,
             COUNT(*) sched
      FROM oliver.job WHERE tenant_id=@tid GROUP BY FORMAT(COALESCE(actual_end, scheduled_start, created_at),'yyyy-MM')`, { tid: t.id });
    const quotes = await Q(`
      SELECT FORMAT(created_at,'yyyy-MM') ym, COUNT(*) sent,
             SUM(CASE WHEN accepted_at IS NOT NULL THEN 1 ELSE 0 END) accepted, AVG(total) avg_q
      FROM oliver.quote WHERE tenant_id=@tid AND deleted_at IS NULL GROUP BY FORMAT(created_at,'yyyy-MM')`, { tid: t.id });

    const oliverMetrics: Record<string, Array<number | null>> = {};
    const oput = (k: string, s: Array<number | null>) => { if (hasData(s)) oliverMetrics[k] = s; };
    oput('revenue_invoiced', toSeries(inv.map((r: any) => ({ ym: r.ym, v: r.revenue }))));
    oput('avg_invoice', toSeries(inv.map((r: any) => ({ ym: r.ym, v: r.avg_inv })), { zeroFill: false }));
    oput('jobs_completed', toSeries(jobs.map((r: any) => ({ ym: r.ym, v: r.done }))));
    oput('jobs_scheduled', toSeries(jobs.map((r: any) => ({ ym: r.ym, v: r.sched }))));
    oput('quotes_sent', toSeries(quotes.map((r: any) => ({ ym: r.ym, v: r.sent }))));
    oput('quotes_accepted', toSeries(quotes.map((r: any) => ({ ym: r.ym, v: r.accepted }))));
    oput('avg_quote_value', toSeries(quotes.map((r: any) => ({ ym: r.ym, v: r.avg_q })), { zeroFill: false }));
    for (const key of ['revenue_invoiced', 'jobs_completed', 'jobs_scheduled', 'quotes_sent', 'quotes_accepted']) {
      if (oliverMetrics[key]) oliverMetrics[key][MONTHS.length - 1] = null; // running month
    }
    for (const key of Object.keys(oliverMetrics)) {
      const vals = oliverMetrics[key].filter((v) => v != null);
      if (!vals.length || vals.every((v) => v === 0)) delete oliverMetrics[key];
    }

    // ── score through the real engine ──────────────────────────────────────
    const score = (label: string, trendDs: DashboardScore[], intelDs: DashboardScore[]) => {
      const tS = roll(trendDs), iS = roll(intelDs);
      const { meas, tot } = measuredOf(trendDs);
      return { label, trend: tS, intel: iS, platform: blend(tS, iS), meas, tot };
    };
    const a = score('ARION', buildArionDashboards({ metrics: arionMetrics } as any), buildIntelligenceMirror({ metrics: arionMetrics } as any, ARION_MIRROR).dashboards);
    const s = score('SPARK', buildSparkDashboards({ metrics: sparkMetrics } as any), buildIntelligenceMirror({ metrics: sparkMetrics } as any, SPARK_MIRROR).dashboards);
    const o = score('OLIVER', buildOliverDashboards({ metrics: oliverMetrics } as any), buildIntelligenceMirror({ metrics: oliverMetrics } as any, OLIVER_MIRROR).dashboards);
    const pulse = businessPulse([a.platform, s.platform, o.platform]);

    console.log(`\n══ ${t.name} (${t.domain}) ═══════════════════════════`);
    console.log(`  Business Pulse: ${pulse ?? '— (no measurable platform)'}`);
    for (const p of [a, s, o]) {
      if (p.platform == null) { console.log(`  ${p.label.padEnd(6)} — not connected (0 of ${p.tot} data points measurable)`); continue; }
      console.log(`  ${p.label.padEnd(6)} platform ${p.platform}  (trend ${p.trend} / intel ${p.intel})  · ${p.meas} of ${p.tot} data points from real data`);
    }
    // substance: current keyword standing
    const lastYm = [...byMonth.keys()].sort().slice(-1)[0];
    if (lastYm) {
      const cur = byMonth.get(lastYm)!;
      console.log(`  SE Ranking [${lastYm}]: ${cur.length} keywords tracked · avg pos ${(cur.reduce((x, y) => x + y, 0) / cur.length).toFixed(1)} · top10 ${cur.filter((p) => p <= 10).length} · top3 ${cur.filter((p) => p <= 3).length}`);
    }
  }
} finally {
  await pool.close();
}
