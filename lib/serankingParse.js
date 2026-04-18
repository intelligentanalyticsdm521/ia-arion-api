/**
 * SE Ranking positions parser (Phase 3.5).
 *
 * SE Ranking's /positions response is nested:
 *   [{ site_engine_id, keywords: [{ id, name, volume, cpc, competition,
 *                                   positions: [{ date, pos, change, depth, ... }] }] }]
 *
 * This module converts that shape into normalized per-keyword records with:
 *   - average position across engines (only counting engines where it ranks;
 *     keywords that don't rank on any engine are preserved with position=null)
 *   - which engines it's NOT ranking on (for tooltip)
 *   - current position for a date range (avg of range, not most recent day)
 *   - change (point-to-point: end-of-range vs start-of-range)
 *   - per-engine breakdown for drill-down
 *
 * Engine metadata (name, region, device) is injected separately once the
 * engine-metadata endpoint is known; without it, engines are labeled by id.
 */

/**
 * Normalize a /positions response into per-keyword aggregates.
 *
 * @param {Array} engineBlocks - raw /positions response
 * @param {object} opts
 * @param {Date|string} [opts.rangeStart] - ISO date or Date, inclusive. If omitted, uses full series.
 * @param {Date|string} [opts.rangeEnd] - ISO date or Date, inclusive. If omitted, uses full series.
 * @param {Set<string>} [opts.engineFilter] - if provided, only these site_engine_ids are included
 * @param {Object<string,object>} [opts.engineMetaById] - { id: {name, region, device, label} } map for enrichment
 * @returns {Array} normalized keyword records
 */
export function parsePositions(engineBlocks, opts = {}) {
  const { rangeStart, rangeEnd, engineFilter, engineMetaById } = opts;
  const start = toIsoDate(rangeStart);
  const end = toIsoDate(rangeEnd);

  const byKeyword = {};

  for (const engine of engineBlocks || []) {
    const engineId = String(engine.site_engine_id ?? '');
    if (!engineId) continue;
    if (engineFilter && engineFilter.size && !engineFilter.has(engineId)) continue;

    for (const kw of engine.keywords || []) {
      const id = String(kw.id ?? '');
      if (!id) continue;
      const series = Array.isArray(kw.positions) ? kw.positions : [];

      // Filter series to the selected range
      const inRange = series.filter((p) => {
        if (!p?.date) return false;
        if (start && p.date < start) return false;
        if (end && p.date > end) return false;
        return true;
      });

      // Only counting days when the keyword actually ranked (pos > 0).
      const ranking = inRange.filter((p) => Number(p.pos || 0) > 0);
      const sortedAsc = [...inRange].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      const firstDay = sortedAsc[0] || null;
      const lastDay = sortedAsc[sortedAsc.length - 1] || null;

      const avgRankingPos = ranking.length
        ? Math.round((ranking.reduce((s, p) => s + Number(p.pos), 0) / ranking.length) * 10) / 10
        : null;

      const rangeLength = inRange.length;
      const rankingDaysPct = rangeLength ? Math.round((ranking.length / rangeLength) * 100) : 0;

      // Point-to-point change: end-of-range position vs start-of-range position.
      // Use raw positions (even if 0) so a keyword that "left the top 100" shows a
      // negative delta. For "change" a drop from pos 80 to pos 0 reads as -20 in
      // SE Ranking's own payload so we mirror that convention: positive = improved.
      const startPos = firstDay ? Number(firstDay.pos || 0) : 0;
      const endPos = lastDay ? Number(lastDay.pos || 0) : 0;
      let posChange = 0;
      if (startPos > 0 && endPos > 0) posChange = startPos - endPos; // positive = moved up
      else if (startPos > 0 && endPos === 0) posChange = -(100 - startPos); // fell out
      else if (startPos === 0 && endPos > 0) posChange = 100 - endPos; // entered

      if (!byKeyword[id]) {
        byKeyword[id] = {
          keywordId: Number(id),
          keyword: kw.name || '',
          volume: Number(kw.volume || 0),
          difficulty: null,
          cpc: Number(kw.cpc || 0),
          competition: Number(kw.competition || 0),
          enginesRanking: [],   // engine readings where it actually ranks
          enginesNotRanking: [], // engine ids where pos=0 for the whole range
          perEngine: [],         // full readings for drill-down
        };
      }

      const meta = engineMetaById?.[engineId] || null;
      const reading = {
        engineId,
        engineLabel: meta?.label || `Engine ${engineId}`,
        engineName: meta?.name || null,
        engineRegion: meta?.region || null,
        engineDevice: meta?.device || null,
        currentPosition: avgRankingPos,
        rankingDays: ranking.length,
        rangeDays: rangeLength,
        rankingDaysPct,
        positionChange: posChange,
        startOfRangePos: startPos > 0 ? startPos : null,
        endOfRangePos: endPos > 0 ? endPos : null,
        series: sortedAsc.map((p) => ({ date: p.date, pos: Number(p.pos || 0), change: Number(p.change || 0) })),
      };

      byKeyword[id].perEngine.push(reading);
      if (avgRankingPos != null) byKeyword[id].enginesRanking.push(reading);
      else byKeyword[id].enginesNotRanking.push({ engineId, engineLabel: reading.engineLabel });
    }
  }

  // Reduce to one record per keyword: average across engines where it ranks.
  return Object.values(byKeyword).map((k) => {
    const active = k.enginesRanking;
    // Positions round to WHOLE integers. Average position of 39.7 displays as
    // 40 — no decimal fractions of a rank. This matches SE Ranking's UI.
    const avgAcrossEngines = active.length
      ? Math.round(active.reduce((s, e) => s + e.currentPosition, 0) / active.length)
      : null;
    const avgChange = active.length
      ? Math.round(active.reduce((s, e) => s + (e.positionChange || 0), 0) / active.length)
      : 0;
    const previousPosition = avgAcrossEngines != null && avgChange
      ? Math.round(avgAcrossEngines + avgChange)
      : avgAcrossEngines;

    return {
      keywordId: k.keywordId,
      keyword: k.keyword,
      currentPosition: avgAcrossEngines,
      previousPosition,
      positionChange: avgChange,
      searchVolume: k.volume,
      difficulty: k.difficulty,
      cpc: k.cpc,
      competition: k.competition,
      engineCount: k.perEngine.length,
      rankingEngineCount: active.length,
      enginesNotRanking: k.enginesNotRanking,
      perEngine: k.perEngine,
    };
  });
}

/**
 * Compute aggregate stats across a set of normalized keyword records for
 * the stat-card header row.
 */
export function computeAggregateStats(keywords) {
  const ranked = keywords.filter((k) => typeof k.currentPosition === 'number' && k.currentPosition > 0);
  const avgPosition = ranked.length
    ? Math.round(ranked.reduce((s, k) => s + k.currentPosition, 0) / ranked.length)
    : null;

  // CTR-weighted visibility proxy (rank 1 = 27% CTR, rank 10 = 2%, rank 11+ = 0.5%).
  const ctrWeight = (p) => {
    if (!p || p > 30) return 0.005;
    const table = [0.27, 0.15, 0.11, 0.08, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02];
    if (p <= 10) return table[p - 1];
    return Math.max(0.005, 0.02 - (p - 10) * 0.001);
  };
  const visibilityScore = keywords.length
    ? Math.round((keywords.reduce((sum, k) => sum + ctrWeight(k.currentPosition || 0), 0) / keywords.length) * 100 * 10) / 10
    : 0;

  const buckets = {
    top1: 0,
    top2_3: 0,
    top4_5: 0,
    top6_10: 0,
    top11_30: 0,
    top31_100: 0,
    notRanking: 0,
  };
  for (const k of keywords) {
    const p = k.currentPosition;
    if (typeof p !== 'number' || p <= 0) buckets.notRanking++;
    else if (p === 1) buckets.top1++;
    else if (p <= 3) buckets.top2_3++;
    else if (p <= 5) buckets.top4_5++;
    else if (p <= 10) buckets.top6_10++;
    else if (p <= 30) buckets.top11_30++;
    else buckets.top31_100++;
  }

  // Directional counters (change > 0 means moved up — lower position number)
  const jumped = keywords.filter((k) => Number(k.positionChange || 0) > 0).length;
  const dropped = keywords.filter((k) => Number(k.positionChange || 0) < 0).length;
  const unchanged = keywords.length - jumped - dropped;

  // Estimated monthly traffic forecast: sum of (volume × CTR for current position)
  const trafficForecast = Math.round(
    keywords.reduce((s, k) => s + (k.searchVolume || 0) * ctrWeight(k.currentPosition || 0), 0)
  );

  return {
    totalKeywords: keywords.length,
    rankingKeywords: ranked.length,
    avgPosition,
    visibilityScore,
    top10Count: buckets.top1 + buckets.top2_3 + buckets.top4_5 + buckets.top6_10,
    buckets,
    movers: { jumped, dropped, unchanged },
    trafficForecast,
  };
}

/**
 * Resolve the date range for a named window + period-over-period comparison.
 * Returns { current: {start,end}, prior: {start,end}, label }.
 *
 * Ranges supported: 7d, 30d, 90d, 365d, current_month, current_quarter, current_year
 */
export function resolveRange(rangeCode, today = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const dayMs = 86400000;
  const t = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));

  const windowDays = (n) => {
    const end = new Date(t);
    const start = new Date(t.getTime() - (n - 1) * dayMs);
    const priorEnd = new Date(start.getTime() - dayMs);
    const priorStart = new Date(priorEnd.getTime() - (n - 1) * dayMs);
    return {
      current: { start: ymd(start), end: ymd(end) },
      prior: { start: ymd(priorStart), end: ymd(priorEnd) },
      days: n,
    };
  };

  const firstOfMonth = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const firstOfQuarter = (d) => {
    const q = Math.floor(d.getUTCMonth() / 3);
    return new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1));
  };
  const firstOfYear = (d) => new Date(Date.UTC(d.getUTCFullYear(), 0, 1));

  const currentPeriodElapsed = (startDate, end = t) => {
    // Shift prior period to same elapsed length, ending on the day-before-start
    const elapsed = Math.round((end.getTime() - startDate.getTime()) / dayMs) + 1;
    const priorEnd = new Date(startDate.getTime() - dayMs);
    const priorStart = new Date(priorEnd.getTime() - (elapsed - 1) * dayMs);
    return {
      current: { start: ymd(startDate), end: ymd(end) },
      prior: { start: ymd(priorStart), end: ymd(priorEnd) },
      days: elapsed,
    };
  };

  switch ((rangeCode || '30d').toLowerCase()) {
    case '7d': return { ...windowDays(7), label: 'Last 7 days' };
    case '30d': return { ...windowDays(30), label: 'Last 30 days' };
    case '90d': return { ...windowDays(90), label: 'Last 90 days' };
    case '365d':
    case '12m': return { ...windowDays(365), label: 'Last 12 months' };
    case 'current_month': return { ...currentPeriodElapsed(firstOfMonth(t)), label: 'Current month' };
    case 'current_quarter': return { ...currentPeriodElapsed(firstOfQuarter(t)), label: 'Current quarter' };
    case 'current_year': return { ...currentPeriodElapsed(firstOfYear(t)), label: 'Current year' };
    default: return { ...windowDays(30), label: 'Last 30 days' };
  }
}

/* Helpers */
function toIsoDate(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  }
  return null;
}

/**
 * Build engine-id → {name, region, device, label} map from a SE Ranking
 * engines metadata response. Shape is assumed as:
 *   [{ id, name, country, city, lang, device }] or similar.
 * We try multiple key variants because SE Ranking's docs are inconsistent.
 */
export function buildEngineMetaMap(enginesResponse) {
  const map = {};
  const rows = Array.isArray(enginesResponse) ? enginesResponse : [];
  for (const r of rows) {
    const id = r.id ?? r.engine_id ?? r.site_engine_id;
    if (id == null) continue;
    const name = r.name || r.engine_name || r.search_engine || null;
    const region = r.country || r.country_name || r.region || r.location || null;
    const city = r.city || r.location_name || null;
    const device = (r.device || r.platform || '').toLowerCase() || null;
    const lang = r.lang || r.language || null;
    const parts = [];
    if (name) parts.push(name);
    if (region) parts.push(region);
    if (city && city !== region) parts.push(city);
    if (device) parts.push(device === 'mobile' ? 'Mobile' : 'Desktop');
    const label = parts.join(' · ') || `Engine ${id}`;
    map[String(id)] = { id: String(id), name, region, city, device, lang, label };
  }
  return map;
}
