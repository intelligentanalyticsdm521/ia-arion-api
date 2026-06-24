// lib/seoOnboarding.js — Auto-configure SE Ranking for a site based on its
// seo_addon_tier (starter | essentials | growth | authority).
//
// 2026-06-17 productization pass: replaces the audit-only flow with full
// project provisioning — creates an SE Ranking PROJECT (POST /sites), seeds
// per-tier search engines, creates keyword groups, bootstraps starter
// keywords from the site questionnaire, sets AI Search tracking, then
// creates the audit. Falls back to structured manual steps if any single
// step fails so the founder always has an actionable handoff.
//
// Tier matrix is the single source of truth from
// `project_arion_seo_tier_matrix.md` (locked 2026-04-20):
//   Starter      10 kw × 2 engines
//   Essentials   25 kw × 3 engines
//   Growth       60 kw × 3 engines + Google AI Mode
//   Authority   150 kw × 3 engines + Google AI Mode + ChatGPT + Gemini
//
// Idempotent — running twice produces the same configuration; existing
// project IDs are reused rather than recreated.

import sql from "mssql";
import {
  createProject as srCreateProject,
  addKeywords as srAddKeywords,
  createKeywordGroup as srCreateKeywordGroup,
  setAIBrand as srSetAIBrand,
  enableAIEngine as srEnableAIEngine,
  setProjectEngines as srSetProjectEngines,
  addCompetitor as srAddCompetitor,
} from "./seranking.js";
import { getKeywordData } from "./serankingData.js";

const PROJECT_BASE = process.env.SERANKING_PROJECT_API_BASE || "https://api4.seranking.com";

function projectHeaders() {
  const key = process.env.SERANKING_API_SYSTEM_KEY;
  if (!key) return null;
  return { "Authorization": `Token ${key}`, "Content-Type": "application/json" };
}

async function sr(method, path, body) {
  const headers = projectHeaders();
  if (!headers) return { ok: false, status: 0, data: null, errorText: "SERANKING_API_SYSTEM_KEY not configured" };
  const res = await fetch(`${PROJECT_BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* no-op */ }
  return { ok: res.ok, status: res.status, data, errorText: !res.ok ? (data?.message || text || null) : null };
}

// ---------------------------------------------------------------------------
// Tier configuration
// ---------------------------------------------------------------------------
//
// Engine reference IDs are SE Ranking's canonical IDs. These are stable
// values from their /system/search-engines endpoint. Values below confirmed
// against SE Ranking docs:
//   Google US (desktop)  = 16
//   Google US (mobile)   = 17
//   Bing US              = 23
//   Yahoo US             = 22
//   Google US AI Mode    = (probed at runtime via setAITracking)
//
// Region 2840 = US (per Google's geotarget convention used by SE Ranking).

// SE Ranking search engine IDs for the v1 POST /sites/search-engines call.
// Verified live 2026-06-17 against IA's existing project (id=2465230):
//   Google US (desktop) = 200    (lang_code "en", city-level region_name)
//   Google US (mobile)  = 1540   (lang_code "en", city-level region_name)
//   Bing US             = 415    (region_name null = nationwide)
//
// Region targeting: pass `region_name` as "City, State, United States"
// (verbatim format SE Ranking uses) to bind Google to a metro. We never
// expose this to tenants — they only set city + state in the questionnaire,
// we derive the region_name from that. Bing always tracks nationwide.
//
// AI Search engines (Growth/Authority) handled separately via AIRT below.
const ENGINES = {
  google_us_desktop: { seId: 200, langCode: 'en', needsRegion: true },
  google_us_mobile: { seId: 1540, langCode: 'en', needsRegion: true },
  bing_us: { seId: 415, langCode: null, needsRegion: false },
};

/**
 * Build SE Ranking's region_name string from city + state.
 * Example: ("Des Moines", "IA") → "Des Moines, Iowa, United States"
 * SE Ranking expects full state name, not abbreviation.
 */
const US_STATE_FULL_NAME = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia',
};

export function buildRegionName(city, state) {
  if (!city) return null;
  const trimmedCity = String(city).trim();
  if (!trimmedCity) return null;
  const stateRaw = String(state || '').trim();
  // If the state is a 2-letter code, expand to full name; otherwise use as-is
  const stateFull = stateRaw.length === 2 ? (US_STATE_FULL_NAME[stateRaw.toUpperCase()] || stateRaw) : stateRaw;
  if (!stateFull) return `${trimmedCity}, United States`;
  return `${trimmedCity}, ${stateFull}, United States`;
}

// Internal engine key → SE Ranking AIRT base_name (matches API enum).
const AI_ENGINE_BASE_NAME = {
  ai_mode: 'google_ai_mode',
  chatgpt: 'chatgpt',
  gemini: 'gemini',
  perplexity: 'perplexity',
  ai_overview: 'google_ai_overview',
};

// Tier → configuration. The keyword_limit values match the LOCKED SEO tier
// matrix; engines array gates which search engines are tracked per tier.
const TIER_CONFIG = {
  starter: {
    keyword_limit: 10,
    competitor_limit: 3,
    audit_cadence_days: 30,
    check_freq: 'check_weekly',
    engines: [ENGINES.google_us_desktop, ENGINES.bing_us],
    backlink_monitoring: false,
    ai_engines: [],   // No AI tracking
    keyword_groups: 1,
    bootstrap_keywords: 5,
  },
  essentials: {
    keyword_limit: 25,
    competitor_limit: 3,
    audit_cadence_days: 30,
    check_freq: 'check_daily',
    engines: [ENGINES.google_us_desktop, ENGINES.google_us_mobile, ENGINES.bing_us],
    backlink_monitoring: false,
    ai_engines: [],
    keyword_groups: 1,
    bootstrap_keywords: 8,
  },
  growth: {
    keyword_limit: 60,
    competitor_limit: 5,
    audit_cadence_days: 14,
    check_freq: 'check_daily',
    engines: [ENGINES.google_us_desktop, ENGINES.google_us_mobile, ENGINES.bing_us],
    backlink_monitoring: true,
    ai_engines: ['ai_mode'],  // Google AI Mode only
    keyword_groups: 5,
    bootstrap_keywords: 15,
  },
  authority: {
    keyword_limit: 150,
    competitor_limit: 10,
    audit_cadence_days: 7,
    check_freq: 'check_daily',
    engines: [ENGINES.google_us_desktop, ENGINES.google_us_mobile, ENGINES.bing_us],
    backlink_monitoring: true,
    ai_engines: ['ai_mode', 'chatgpt', 'gemini'],
    keyword_groups: 15,
    bootstrap_keywords: 25,
  },
};

// ---------------------------------------------------------------------------
// Keyword bootstrap from questionnaire
// ---------------------------------------------------------------------------

/**
 * Build a list of starter keyword phrases from the site's questionnaire data.
 *
 * Strategy: combine business name, industry, services, and location into
 * commercial-intent phrases. We aim for queries the customer's IDEAL
 * customer would type, not navigational queries (the customer already ranks
 * for their own name).
 *
 * Examples for "Rolling In It" (mobile detailing, Des Moines):
 *   - "mobile detailing des moines"
 *   - "car detailing near me"
 *   - "auto detailing services"
 *   - "ceramic coating des moines"
 *   - "interior car detailing"
 *
 * @param {object} site - { domain, primary_url, questionnaire, ... }
 * @param {object} questionnaire - parsed questionnaire JSON
 * @param {number} targetCount - tier-specific target
 * @returns {Array<string>} de-duped, cap-respecting keyword list
 */
export function buildBootstrapKeywords(site, questionnaire = {}, targetCount = 5) {
  const out = new Set();
  const services = Array.isArray(questionnaire.services) ? questionnaire.services : [];
  const industry = (questionnaire.industry || '').toLowerCase().trim();
  const locations = Array.isArray(questionnaire.locations) ? questionnaire.locations : [];
  const serviceArea = (questionnaire.service_area || '').toLowerCase().trim();
  const primaryCity = locations[0]?.city?.toLowerCase().trim() || serviceArea.split(',')[0]?.trim() || '';

  // Pattern 1: each service standalone
  for (const svc of services.slice(0, 10)) {
    const name = String(svc.name || svc).toLowerCase().trim();
    if (name && name.length > 2 && name.length < 50) out.add(name);
  }

  // Pattern 2: service + city
  if (primaryCity) {
    for (const svc of services.slice(0, 10)) {
      const name = String(svc.name || svc).toLowerCase().trim();
      if (name && name.length > 2) out.add(`${name} ${primaryCity}`);
    }
  }

  // Pattern 3: service + "near me"
  for (const svc of services.slice(0, 5)) {
    const name = String(svc.name || svc).toLowerCase().trim();
    if (name && name.length > 2) out.add(`${name} near me`);
  }

  // Pattern 4: industry standalone + industry + city
  if (industry) {
    out.add(industry);
    if (primaryCity) out.add(`${industry} ${primaryCity}`);
    out.add(`${industry} near me`);
    out.add(`best ${industry}`);
  }

  // Cap to target
  return Array.from(out).slice(0, targetCount);
}

// ---------------------------------------------------------------------------
// Main provisioning function
// ---------------------------------------------------------------------------

/**
 * Configure SE Ranking for a site at a tier. Returns the full result; caller
 * writes it back to the database via persistResult().
 *
 * @param {object} site - { site_id, domain, tenant_id, primary_url, questionnaire }
 * @param {'starter'|'essentials'|'growth'|'authority'} tier
 * @returns {Promise<{ ok, projectId, auditId, config, keywords, errors, manual_steps }>}
 */
export async function configureForTier(site, tier) {
  const errors = [];
  const manualSteps = [];
  const config = TIER_CONFIG[String(tier || "").toLowerCase()];
  if (!config) {
    return { ok: false, projectId: null, auditId: null, config: null, errors: [`Unknown tier: ${tier}`], manual_steps: [], keywords: [] };
  }

  const domain = site.domain || site.primary_url?.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!domain) {
    return { ok: false, projectId: null, auditId: null, config, errors: ["No domain on site"], manual_steps: [], keywords: [] };
  }
  const url = site.primary_url || `https://${domain}`;
  const questionnaire = site.questionnaire || {};

  // -------------------------------------------------------------------------
  // Step 1: Create or look up the SE Ranking PROJECT.
  //         POST /v1/project-management/sites (single object body, field is
  //         `name` not `title` — corrected 2026-06-24 after live 400 errors).
  // -------------------------------------------------------------------------
  const businessName = questionnaire.business_name || domain;
  let projectId = site.se_ranking_project_id || null;
  if (!projectId) {
    const created = await srCreateProject({
      title: `${businessName} — ARION (${tier})`,
      url,
      checkFreq: config.check_freq,
      subdomainMatch: 1,
      exactUrl: 0,
      depth: 100,
      autoReports: 1,
    });
    // POST /sites returns either { site_id } or [{ site_id }] depending on
    // batch vs single-create response shape. Accept both.
    if (created) {
      const first = Array.isArray(created) ? created[0] : created;
      projectId = first?.site_id || first?.id || first?.project_id;
    }
    if (!projectId) {
      errors.push(`Project create failed for ${domain}`);
      manualSteps.push({
        system: "SE Ranking",
        action: "Create project manually",
        path: `Projects → New Project → URL: ${url}, title: ${businessName} (${tier})`,
      });
    }
  }

  // Step 1b: Configure classic SERP engines (Google US desktop + mobile + Bing).
  //
  // Engine model is LOCKED — tenants can never adjust which engines are
  // tracked. Always Google Desktop + Google Mobile (city-bound) + Bing
  // (nationwide). Locked decision 2026-06-17.
  //
  // For the Google engines we bind to the customer's city + state via
  // SE Ranking's `region_name` field, computed from the first questionnaire
  // location ("Des Moines", "IA" → "Des Moines, Iowa, United States").
  // Bing tracks nationwide so we pass null region_name.
  const primaryLocation = Array.isArray(questionnaire.locations) && questionnaire.locations[0]
    ? questionnaire.locations[0]
    : null;
  const primaryCity = primaryLocation?.city || null;
  const primaryState = primaryLocation?.state || null;
  const regionName = buildRegionName(primaryCity, primaryState);

  if (projectId && config.engines.length > 0) {
    // Decorate each engine with its region_name based on `needsRegion` flag.
    const engineSpecs = config.engines.map((e) => ({
      seId: e.seId,
      langCode: e.langCode,
      regionName: e.needsRegion ? regionName : null,
    }));
    const engineResults = await srSetProjectEngines(projectId, engineSpecs);
    const failed = engineResults.filter((r) => !r).length;
    if (failed > 0) {
      manualSteps.push({
        system: "SE Ranking",
        target: `Project #${projectId}`,
        action: `Verify ${failed} search engines added (Google D/M + Bing US)`,
        path: "Project Settings → Search Engines",
        details: regionName ? `Google D/M should target "${regionName}"` : "No location supplied; Google engines will be nationwide",
      });
    }
    if (!regionName) {
      manualSteps.push({
        system: "SE Ranking",
        target: `Project #${projectId}`,
        action: "Add city + state to questionnaire then re-run onboarding to bind Google to local SERPs",
        path: "Tenant questionnaire → Locations",
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: Create keyword groups (Focus Areas). Only created when groups > 1.
  // -------------------------------------------------------------------------
  const groupNameSuggestions = ['Core Services', 'Service Area', 'Products', 'Branded', 'Long Tail', 'AI Search', 'Local', 'Industry', 'Competitor Keywords', 'Question Queries', 'Educational', 'Commercial Intent', 'Informational', 'Trending', 'Seasonal'];
  const createdGroupIds = [];
  if (projectId && config.keyword_groups > 0) {
    for (let i = 0; i < config.keyword_groups; i++) {
      const name = groupNameSuggestions[i] || `Group ${i + 1}`;
      const grp = await srCreateKeywordGroup(projectId, name);
      if (grp && (grp.id || grp.group_id)) createdGroupIds.push(grp.id || grp.group_id);
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: Bootstrap starter keywords from questionnaire + Data API volume.
  // -------------------------------------------------------------------------
  let bootstrapKeywords = [];
  let addedKeywords = [];
  if (projectId && config.bootstrap_keywords > 0) {
    bootstrapKeywords = buildBootstrapKeywords(site, questionnaire, Math.min(config.bootstrap_keywords, config.keyword_limit));
    if (bootstrapKeywords.length > 0) {
      // Enrich with volume/difficulty for surfacing in the manual-step report
      const volumeRows = await getKeywordData(bootstrapKeywords, 'us').catch(() => []);
      const enriched = bootstrapKeywords.map((kw) => {
        const v = volumeRows.find((r) => r.keyword.toLowerCase() === kw.toLowerCase());
        return { keyword: kw, volume: v?.volume || 0, difficulty: v?.difficulty || 0 };
      });
      const addResult = await srAddKeywords(projectId, bootstrapKeywords, {
        groupId: createdGroupIds[0] || undefined,
      });
      addedKeywords = enriched;
      if (addResult?.errors?.length) {
        errors.push(`Keyword bootstrap partial: ${addResult.errors.join('; ')}`);
        manualSteps.push({
          system: "SE Ranking",
          target: `Project #${projectId}`,
          action: `Manually verify ${bootstrapKeywords.length} bootstrap keywords were added`,
          path: `Project → Keywords tab`,
          details: bootstrapKeywords,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: AIRT (AI Result Tracker) setup — Growth + Authority.
  //   4a. Set brand (required before any LLM engine).
  //   4b. Enable each AI engine per tier (creates llm_id records).
  //
  // Tenant adds the 5 prompts (per locked tier matrix) later via the Portal
  // AI Prompts page once engines are enabled.
  // -------------------------------------------------------------------------
  const aiLlmIds = {};
  if (projectId && config.ai_engines.length > 0) {
    // 4a. Brand
    const brandResult = await srSetAIBrand(projectId, businessName);
    if (!brandResult) {
      errors.push('AIRT brand set failed');
      manualSteps.push({
        system: "SE Ranking",
        target: `Project #${projectId}`,
        action: `Set brand to "${businessName}"`,
        path: "Project Settings → AI Search → Brand",
      });
    }

    // 4b. Enable each AI engine
    for (const engineKey of config.ai_engines) {
      const baseName = AI_ENGINE_BASE_NAME[engineKey];
      if (!baseName) continue;
      const result = await srEnableAIEngine(projectId, {
        baseName,
        countryCode: 'us',
        langCode: 'en',
      });
      if (result?.llm_id || result?.id) {
        aiLlmIds[baseName] = result.llm_id || result.id;
      } else {
        manualSteps.push({
          system: "SE Ranking",
          target: `Project #${projectId}`,
          action: `Enable ${baseName} AI engine`,
          path: `Project Settings → AI Search → ${baseName} → toggle ON`,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 5: Backlink monitoring (Growth + Authority).
  //
  // SE Ranking auto-enables backlink monitoring when the first backlink is
  // added — there's no separate "enable" toggle. For onboarding we leave
  // it implicit; tenant adds backlinks via the SE Ranking dashboard or our
  // Portal page (future). We do enable GSC autoimport on Growth+ so backlinks
  // discovered by Google Search Console flow into SE Ranking automatically.
  // -------------------------------------------------------------------------
  if (projectId && config.backlink_monitoring) {
    const { setBacklinkGSCAutoimport } = await import('./seranking.js');
    const blResult = await setBacklinkGSCAutoimport(projectId, true);
    if (!blResult) {
      manualSteps.push({
        system: "SE Ranking",
        target: `Project #${projectId}`,
        action: "Enable GSC backlink auto-import",
        path: "Project Settings → Backlinks → GSC import",
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 6: Create the site audit (per-tier cadence).
  // -------------------------------------------------------------------------
  let auditId = site.se_ranking_audit_id || null;
  if (!auditId) {
    const auditRes = await sr("POST", "/audit/create", {
      title: `${domain} (${tier})`,
      url,
      // SE Ranking applies tier-driven settings via its own UI by default;
      // we set cadence here. Full settings body documented in memory
      // `reference_seranking_audit_api.md`.
      settings: {
        source_site: 1,
        source_sitemap: 1,
        check_robots: 1,
        ignore_nofollow: 1,
        csr: 1,
        user_agent: 0,
        schedule_type: config.audit_cadence_days <= 7 ? 'week' : (config.audit_cadence_days <= 14 ? 'week' : (config.audit_cadence_days <= 30 ? 'month' : 'quarter')),
        schedule_hour: 5,
        max_pages: tier === 'authority' ? 25000 : (tier === 'growth' ? 10000 : (tier === 'essentials' ? 5000 : 1000)),
      },
    });
    if (auditRes.ok) {
      auditId = auditRes.data?.id || auditRes.data?.audit_id;
    } else {
      manualSteps.push({
        system: "SE Ranking",
        action: "Create audit manually",
        path: `Audits → New Audit → URL: ${url}, cadence: ${config.audit_cadence_days} days`,
      });
    }
  }

  return {
    ok: errors.length === 0,
    projectId,
    auditId,
    config,
    keywords: addedKeywords,
    errors,
    manual_steps: manualSteps,
  };
}

/**
 * Persist the configuration result back to arion.site.
 * Updates se_ranking_project_id, se_ranking_audit_id, and records a JSON
 * snapshot of the config + manual steps for the founder dashboard.
 */
export async function persistResult(pool, tenantId, siteId, result) {
  await pool.request()
    .input("tenantId", sql.UniqueIdentifier, tenantId)
    .input("siteId", sql.UniqueIdentifier, siteId)
    .input("projectId", sql.NVarChar(80), result.projectId ? String(result.projectId) : null)
    .input("auditId", sql.NVarChar(80), result.auditId ? String(result.auditId) : null)
    .input("snapshot", sql.NVarChar(sql.MAX), JSON.stringify({
      config: result.config,
      keywords: result.keywords,
      manual_steps: result.manual_steps,
      errors: result.errors,
      configured_at: new Date().toISOString(),
    }))
    .query(`
      UPDATE arion.site
      SET se_ranking_project_id = COALESCE(@projectId, se_ranking_project_id),
          se_ranking_audit_id = COALESCE(@auditId, se_ranking_audit_id),
          se_ranking_onboarding_snapshot = @snapshot
      WHERE site_id = @siteId AND tenant_id = @tenantId
    `).catch((err) => {
      console.warn("[seo-onboarding] snapshot column missing, falling back:", err.message);
      return pool.request()
        .input("tenantId", sql.UniqueIdentifier, tenantId)
        .input("siteId", sql.UniqueIdentifier, siteId)
        .input("projectId", sql.NVarChar(80), result.projectId ? String(result.projectId) : null)
        .query(`UPDATE arion.site SET se_ranking_project_id = COALESCE(@projectId, se_ranking_project_id)
                WHERE site_id=@siteId AND tenant_id=@tenantId`);
    });
}
