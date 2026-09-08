// lib/contentAgent/keywordProviders.js
//
// Keyword research as a PLUGGABLE input, not the spine of the agent.
//
// Brandon 2026-08-24: "not everyone will have that [SE Ranking] so we need to
// incorporate RankMath or say make your agent smarter by adding SEO Tools."
//
// The agent's core loop is learn-the-business -> draft -> review -> publish.
// SEO research makes topic selection SHARPER; its absence must never make the
// agent refuse to work. So each provider declares what it actually knows
// (capabilities), qualification adapts to what is knowable, and the rationale
// says honestly what was not known — which is also where the upsell lives.
//
// THREE TIERS, resolved per tenant:
//
//   se_ranking  volume + KD + intent          the full keyword-first workflow
//   rankmath    site's own focus keywords     no volume/KD; knows what the site
//               (arion.site_content_item,      already targets, so dedup and
//               captured nightly by the        cannibalisation checks are real,
//               IA plugin snapshot)            and gaps in coverage are visible
//   none        the tenant's candidate table  business context only
//               + caller-supplied seeds
//
// 'auto' resolution order: se_ranking if the tenant has a working SE Ranking
// setup, else rankmath if the IA plugin has captured focus keywords, else none.
// Detection is by PRESENCE of data, never by absence of an error — the
// dual-key 401 looks exactly like "no SE Ranking" if you probe carelessly,
// which is why auto-resolution reuses the same health probe the F1 path uses.

import sql from 'mssql';
import { getKeywordData, getKeywordSuggestions } from '../serankingData.js';
import { probeDataApi, HEALTH } from './serankingHealth.js';

export const PROVIDERS = {
  SE_RANKING: 'se_ranking',
  RANKMATH: 'rankmath',
  NONE: 'none',
};

/** What each provider actually knows. Qualification reads this, not the name. */
export const CAPABILITIES = {
  [PROVIDERS.SE_RANKING]: { volume: true, kd: true, intent: true, label: 'SE Ranking' },
  [PROVIDERS.RANKMATH]: { volume: false, kd: false, intent: false, label: 'RankMath (via IA plugin)' },
  [PROVIDERS.NONE]: { volume: false, kd: false, intent: false, label: 'no SEO tool connected' },
};

export const UPSELL_LINE =
  'Search volume and difficulty were unavailable for this pick — connect an SEO tool '
  + '(SE Ranking) to make your agent smarter about which topics can actually rank.';

/**
 * Resolve which provider a tenant actually gets.
 *
 * @returns {Promise<{provider: string, detail: string}>}
 */
export async function resolveProvider(pool, tenantId, { configured = 'auto', probe = probeDataApi } = {}) {
  if (configured && configured !== 'auto') {
    return { provider: configured, detail: `pinned by tenant config` };
  }

  // SE Ranking: a healthy Data API is a positive signal. (Per-tenant SE Ranking
  // project presence is site-level; the platform key is shared, so the probe is
  // the gate that matters for research calls.)
  const p = await probe();
  if (p.verdict === HEALTH.HEALTHY) {
    return { provider: PROVIDERS.SE_RANKING, detail: 'SE Ranking Data API healthy' };
  }

  // RankMath: does the IA plugin snapshot hold focus keywords for this tenant?
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`
      SELECT COUNT(*) AS n
        FROM arion.site_content_item
       WHERE tenant_id = @tenantId
         AND focus_keyword IS NOT NULL AND LEN(focus_keyword) > 0
         AND snapshot_date >= DATEADD(DAY, -14, CAST(SYSDATETIMEOFFSET() AS DATE))`);
  if (r.recordset[0].n > 0) {
    return { provider: PROVIDERS.RANKMATH, detail: `${r.recordset[0].n} focus keyword(s) captured in the last 14 days` };
  }

  return { provider: PROVIDERS.NONE, detail: `SE Ranking unavailable (${p.verdict}) and no RankMath focus keywords captured` };
}

// ---------------------------------------------------------------------------
// Research functions — one per provider, same shape out
// ---------------------------------------------------------------------------
// All return Array<{keyword, volume?, difficulty?, intent?, source}>. Missing
// numbers stay ABSENT rather than being faked to zero — a fabricated zero would
// trip the volume floor and silently reject everything.

/** SE Ranking: seed expansion + enrichment. The existing full-fat path. */
export async function researchSeRanking({ seeds = [], regionId = 'us', limit = 25 }) {
  const out = [];
  for (const seed of seeds.slice(0, 5)) {
    const rows = await getKeywordSuggestions(seed, regionId, limit);
    out.push(...rows.map((r) => ({ ...r, source: 'se_ranking' })));
  }
  if (out.length === 0 && seeds.length > 0) {
    const rows = await getKeywordData(seeds, regionId);
    out.push(...rows.map((r) => ({ ...r, source: 'se_ranking' })));
  }
  return out;
}

/**
 * RankMath: the site's own focus keywords, read tenant-scoped from the nightly
 * plugin snapshot. Two uses:
 *   coveredKeywords — what the site already targets (feeds dedup/cannibalisation)
 *   candidates      — pages whose focus keyword is thin/underperforming, i.e.
 *                     topics the site has claimed but not served well; plus the
 *                     tenant's own candidate table.
 */
export async function researchRankMath(pool, tenantId, { limit = 25 } = {}) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('limit', sql.Int, limit)
    .query(`
      SELECT TOP (@limit) focus_keyword AS keyword,
             MAX(seo_score) AS best_seo_score,
             MAX(word_count) AS best_word_count
        FROM arion.site_content_item
       WHERE tenant_id = @tenantId
         AND focus_keyword IS NOT NULL AND LEN(focus_keyword) > 0
         AND snapshot_date = (SELECT MAX(snapshot_date) FROM arion.site_content_item WHERE tenant_id = @tenantId)
       GROUP BY focus_keyword
       ORDER BY MAX(seo_score) ASC`); // weakest coverage first — those pages need support content
  return r.recordset.map((row) => ({
    keyword: row.keyword,
    source: 'rankmath',
    rm_seo_score: row.best_seo_score,
    rm_word_count: row.best_word_count,
  }));
}

/** None: the tenant's own candidate table plus caller-supplied seeds. */
export async function researchNone(pool, tenantId, { seeds = [], limit = 25 } = {}) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('limit', sql.Int, limit)
    .query(`
      SELECT TOP (@limit) keyword, search_volume AS volume,
             keyword_difficulty AS difficulty, intent, source
        FROM arion.content_keyword_candidate
       WHERE tenant_id = @tenantId AND status IN ('candidate','backlog')
       ORDER BY created_at DESC`);
  const table = r.recordset.map((row) => ({ ...row, source: row.source || 'candidate_table' }));
  const seeded = seeds.map((s) => ({ keyword: s, source: 'business_context' }));
  return [...table, ...seeded];
}

/**
 * The single entry the runner calls.
 *
 * @returns {Promise<{provider, capabilities, rows, detail}>}
 */
export async function research(pool, tenantId, {
  configured = 'auto', seeds = [], regionId = 'us', limit = 25, probe = probeDataApi,
} = {}) {
  const { provider, detail } = await resolveProvider(pool, tenantId, { configured, probe });
  const capabilities = CAPABILITIES[provider];

  let rows;
  if (provider === PROVIDERS.SE_RANKING) {
    rows = await researchSeRanking({ seeds, regionId, limit });
  } else if (provider === PROVIDERS.RANKMATH) {
    rows = await researchRankMath(pool, tenantId, { limit });
  } else {
    rows = await researchNone(pool, tenantId, { seeds, limit });
  }
  return { provider, capabilities, rows, detail };
}

export default { PROVIDERS, CAPABILITIES, UPSELL_LINE, resolveProvider, researchSeRanking, researchRankMath, researchNone, research };
