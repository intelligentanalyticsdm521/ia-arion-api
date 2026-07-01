// lib/intelligence/schemaCoverage.js — Schema Markup Coverage calculator.
//
// REPORT 5 of 6 (single-source rule honored: SE Ranking audit + IA Plugin
// site-data are both ARION-owned data sources; no SPARK/OLIVER/GBP).
//
// % of pages with valid JSON-LD structured data, broken down by type
// (Article, Product, LocalBusiness, Review, BreadcrumbList, Organization).
// Schema markup is what unlocks rich-result eligibility — without it your
// content competes on plain blue-link signals only.
//
// Single-source compliance (locked 2026-06-21): combines SE Ranking audit
// schema-section + IA Plugin's RankMath schema flags. Both are ARION-
// surface data sources — cross-platform combinations (GBP, SPARK, OLIVER)
// are excluded.
//
// Data flow:
//   - ctx.seRankingAuditId: passed to getAuditSections for schema audit codes
//   - ctx.pluginSeoAgg: optional — RankMath aggregate from the IA Plugin
//     proxy (content-aggregate endpoint). Carries per-post schema-type
//     counts when the site uses RankMath.
//
// Falls back gracefully when neither source is available.

import { fmtNum, insufficient, result, applyAgeMultiplier } from './utils.js';
import { getAuditSections, listSiteAudits } from '../seranking.js';

export const REPORT_KEY = 'schema_coverage';

// F-Onb-D7 — signals this calculator consumes. Keys must match utils.js SIGNAL_REGISTRY.
export const SIGNALS_USED = [
  { key: 'seranking.audit',  tier: 'paid-seranking', label: 'SE Ranking site audit' },
  { key: 'plugin.rankmath',  tier: 'free',           label: 'RankMath schema coverage' },
];

// SE Ranking audit codes that flag missing or invalid schema. The exact
// codes vary across audit versions, so match on substring across the
// known key/code/name fields.
const SCHEMA_ISSUE_PATTERNS = [
  /schema/i,
  /structured.?data/i,
  /json.?ld/i,
  /microdata/i,
  /rdfa/i,
];

function extractSchemaIssues(sections) {
  if (!Array.isArray(sections)) return { issuesFound: 0, breakdown: [] };
  const out = [];
  for (const s of sections) {
    const code = String(s?.code || s?.key || s?.name || s?.title || '');
    if (SCHEMA_ISSUE_PATTERNS.some((rx) => rx.test(code))) {
      out.push({
        code,
        count: Number(s?.count ?? s?.total ?? s?.urls?.length ?? 0),
        severity: s?.severity || s?.priority || 'medium',
      });
    }
  }
  const issuesFound = out.reduce((sum, x) => sum + x.count, 0);
  return { issuesFound, breakdown: out };
}

function extractPluginSchema(pluginSeoAgg) {
  // Plugin RankMath aggregate may surface per-type schema counts. Be
  // defensive — the plugin endpoint shape evolved across plugin versions.
  if (!pluginSeoAgg || typeof pluginSeoAgg !== 'object') return null;
  // Candidates: pluginSeoAgg.seo.schema_types, pluginSeoAgg.schema, etc.
  const candidates = [
    pluginSeoAgg?.seo?.schema_types,
    pluginSeoAgg?.schema_types,
    pluginSeoAgg?.schema,
    pluginSeoAgg?.structured_data,
  ];
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === 'object' && !Array.isArray(c)) {
      const types = Object.entries(c).map(([type, count]) => ({ type, count: Number(count) || 0 }))
        .filter((x) => x.count > 0)
        .sort((a, b) => b.count - a.count);
      const total = types.reduce((s, x) => s + x.count, 0);
      if (total > 0) return { totalWithSchema: total, byType: types };
    }
    if (Array.isArray(c)) {
      const types = c.map((x) => ({ type: String(x?.type || x?.name || 'unknown'), count: Number(x?.count || 0) }))
        .filter((x) => x.count > 0);
      const total = types.reduce((s, x) => s + x.count, 0);
      if (total > 0) return { totalWithSchema: total, byType: types };
    }
  }
  return null;
}

export async function calculateSchemaCoverage(ctx) {
  const { seRankingProjectId, tenantId, pluginSeoAgg = null, totalPages = null } = ctx;
  let { seRankingAuditId } = ctx;

  // 2026-06-22 — Auto-self-heal: same lookup pattern as crawlDepth. If the
  // site row has no audit id but the project is connected, fall back to
  // SE Ranking's audit list so onboarding-persistence gaps don't block this
  // report.
  if (!seRankingAuditId && seRankingProjectId) {
    const audits = await listSiteAudits(seRankingProjectId, tenantId).catch(() => []);
    const sorted = (audits || []).slice().sort((a, b) => {
      const ta = Date.parse(b?.finished_at || b?.completed_at || b?.updated_at || b?.started_at || b?.created_at || 0) || 0;
      const tb = Date.parse(a?.finished_at || a?.completed_at || a?.updated_at || a?.started_at || a?.created_at || 0) || 0;
      return ta - tb;
    });
    const completed = sorted.find((a) => /complete|finished|done|ready/i.test(String(a?.status || '')));
    const pick = completed || sorted[0] || null;
    if (pick?.id) {
      seRankingAuditId = pick.id;
    }
  }

  // Pull SE Ranking schema audit sections (when an audit exists).
  let seRankingSection = null;
  if (seRankingAuditId) {
    const sections = await getAuditSections(seRankingAuditId, tenantId).catch(() => []);
    seRankingSection = extractSchemaIssues(sections);
  }

  const pluginSchema = extractPluginSchema(pluginSeoAgg);

  if (!seRankingSection && !pluginSchema) {
    if (!seRankingProjectId && !pluginSeoAgg) {
      return insufficient(
        REPORT_KEY,
        'No structured-data signal available',
        'Connect SE Ranking + install the IA Plugin to surface schema-markup coverage.',
        ['Schema Markup Coverage combines SE Ranking audit signals with the IA Plugin\'s RankMath schema aggregate. Neither is connected yet.'],
      );
    }
    return insufficient(
      REPORT_KEY,
      'Schema data not yet reported',
      'Audit + plugin are connected but neither has surfaced schema data. Run a fresh audit or trigger plugin sync.',
      ['SE Ranking audit ran but did not return schema sections. IA Plugin did not surface RankMath schema types. May indicate the site uses no structured data, or the audit predates schema coverage.'],
    );
  }

  // Determine denominator (total pages). Prefer explicit totalPages, else
  // fall back to plugin-reported page count, else use SE Ranking
  // crawled-pages estimate from totals.
  const denominator = Number(totalPages) > 0
    ? Number(totalPages)
    : Number(pluginSeoAgg?.summary?.totalPosts || pluginSeoAgg?.totals?.posts || 0);

  // Compute coverage % using plugin data when present (more reliable since
  // it knows the publish-status universe directly); fall back to inverse
  // of SE Ranking schema-issue rate.
  let coveragePct = null;
  let pagesWithSchema = 0;
  let byType = [];

  if (pluginSchema && denominator > 0) {
    pagesWithSchema = pluginSchema.totalWithSchema;
    coveragePct = Math.min(100, Math.round((pagesWithSchema / denominator) * 100));
    byType = pluginSchema.byType;
  } else if (seRankingSection && denominator > 0) {
    // Without explicit pluginSchema, infer coverage from issue density.
    const issueRate = seRankingSection.issuesFound / denominator;
    coveragePct = Math.max(0, Math.min(100, Math.round((1 - issueRate) * 100)));
  } else if (pluginSchema) {
    // No denominator — score on diversity (count of types in use).
    pagesWithSchema = pluginSchema.totalWithSchema;
    byType = pluginSchema.byType;
    coveragePct = Math.min(100, pluginSchema.byType.length * 20); // 5 types = full credit
  }

  if (coveragePct == null) {
    return insufficient(
      REPORT_KEY,
      'Unable to compute coverage %',
      'Schema signals returned but page-count denominator unavailable. Verify IA Plugin sync.',
      ['Need either a plugin-reported total post count or an SE Ranking audit page-count to compute coverage %.'],
    );
  }

  // Score: 60-100 maps to coveragePct 60-100. Below 60% coverage cuts hard.
  const rawScore = coveragePct >= 60 ? coveragePct : coveragePct * 0.5;
  const dampened = applyAgeMultiplier(rawScore, ctx?.siteAgeMultiplier ?? 1.0);
  const score = Math.round(Math.max(0, Math.min(100, dampened)));

  const observations = [];
  if ((ctx?.siteAgeMultiplier ?? 1.0) < 1.0) {
    observations.push(`Site age multiplier: ${ctx.siteAgeMultiplier.toFixed(2)} — score dampened for new site`);
  }
  if (denominator > 0) {
    observations.push(`Schema coverage: ${coveragePct}% of ${fmtNum(denominator)} indexable pages have valid structured data${pagesWithSchema > 0 ? ` (${fmtNum(pagesWithSchema)} pages)` : ''}.`);
  } else {
    observations.push(`Schema coverage: ${coveragePct}% (estimated from issue density — exact page count unavailable).`);
  }
  if (byType.length > 0) {
    const topTypes = byType.slice(0, 4).map((t) => `${t.type} (${fmtNum(t.count)})`).join(', ');
    observations.push(`Schema types in use: ${topTypes}${byType.length > 4 ? ` + ${byType.length - 4} more` : ''}.`);
  }
  if (seRankingSection?.issuesFound > 0) {
    observations.push(`SE Ranking flagged ${fmtNum(seRankingSection.issuesFound)} pages with schema-related issues (missing, invalid, or duplicate markup).`);
  }
  observations.push('Each schema type unlocks a different rich-result class (Article → article rich snippets, LocalBusiness → knowledge panel, Review → star ratings, BreadcrumbList → breadcrumb display).');

  const actions = [];
  if (coveragePct < 60) {
    actions.push('Add LocalBusiness schema to your contact page + every service-area page. This is the single highest-leverage schema for service-business search visibility.');
  }
  if (coveragePct < 80 && byType.length < 3) {
    actions.push('Diversify schema types — at minimum add Article on blog/news posts and BreadcrumbList site-wide.');
  }
  if (seRankingSection?.issuesFound >= 5) {
    actions.push(`Audit the ${fmtNum(seRankingSection.issuesFound)} pages flagged with schema issues. Most are missing required @type properties or duplicate Organization markup.`);
  }
  if (coveragePct >= 80 && byType.length >= 3) {
    actions.push('Coverage is healthy. Next move: add Review schema to testimonial pages to unlock star-rating rich results.');
  }

  return result(
    REPORT_KEY,
    score,
    [
      { key: 'coverage_pct', value: coveragePct, weight: 0.65, note: 'pages with schema vs total' },
      { key: 'schema_type_diversity', value: byType.length, weight: 0.2, note: 'distinct @type values in use' },
      { key: 'schema_issues_flagged', value: seRankingSection?.issuesFound ?? 0, weight: 0.15, note: 'SE Ranking audit flags' },
    ],
    denominator > 0
      ? `${coveragePct}% coverage · ${byType.length} types in use`
      : `${coveragePct}% (estimated) · ${byType.length} types in use`,
    observations,
    actions,
  );
}
