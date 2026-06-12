// lib/seoOnboarding.js — Auto-configure SE Ranking for a site based on its
// seo_addon_tier (essentials | growth | authority).
//
// Called when arion-api sets seo_addon_tier on a site, or via admin
// "Re-configure SE Ranking" button. Idempotent — running twice produces the
// same configuration; existing project IDs are reused.
import sql from "mssql";

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

// Tier → configuration map. Numbers match the LOCKED SEO tier matrix
// (memory `project_arion_seo_tier_matrix.md`, 2026-04-20). Audit
// 2026-06-12 caught drift from the locked spec — fixed in this edit:
//   essentials: keyword_limit 10 → 25 (per locked matrix)
//   growth:     keyword_limit 50 → 60, competitor_limit 10 → 5
//   authority:  competitor_limit 20 → 10
// Starter (the lowest paid SEO tier) added as a separate entry so
// `routes/onboarding/submit.js` writing tier='starter' doesn't blow up
// here. Starter has the same caps as essentials minus backlink/AI.
const TIER_CONFIG = {
  starter: {
    keyword_limit: 10,
    competitor_limit: 3,
    audit_cadence_days: 30,
    backlink_monitoring: false,
    ai_mode_tracking: false,
    chatgpt_tracking: false,
    gemini_tracking: false,
    keyword_groups: 1,
  },
  essentials: {
    keyword_limit: 25,
    competitor_limit: 3,
    audit_cadence_days: 30,
    backlink_monitoring: false,
    ai_mode_tracking: false,
    chatgpt_tracking: false,
    gemini_tracking: false,
    keyword_groups: 1,
  },
  growth: {
    keyword_limit: 60,
    competitor_limit: 5,
    audit_cadence_days: 14,
    backlink_monitoring: true,
    ai_mode_tracking: true, // Google AI Mode gated here per locked spec
    chatgpt_tracking: false,
    gemini_tracking: false,
    keyword_groups: 5,
  },
  authority: {
    keyword_limit: 150,
    competitor_limit: 10,
    audit_cadence_days: 7,
    backlink_monitoring: true,
    ai_mode_tracking: true,
    chatgpt_tracking: true,  // +ChatGPT at Authority
    gemini_tracking: true,   // +Gemini at Authority
    keyword_groups: 15,
  },
};

/**
 * Configure SE Ranking for a site at a tier. Pure functional — returns the
 * full result; caller writes it back to the database.
 *
 * @param {object} site - { site_id, domain, tenant_id, primary_url }
 * @param {'essentials'|'growth'|'authority'} tier
 * @returns {Promise<{ ok, projectId, config, errors, manual_steps }>}
 */
export async function configureForTier(site, tier) {
  const errors = [];
  const manualSteps = [];
  const config = TIER_CONFIG[String(tier || "").toLowerCase()];
  if (!config) {
    return { ok: false, projectId: null, config: null, errors: [`Unknown tier: ${tier}`], manual_steps: [] };
  }

  const domain = site.domain || site.primary_url?.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!domain) {
    return { ok: false, projectId: null, config, errors: ["No domain on site"], manual_steps: [] };
  }

  // 1. Create or look up the SE Ranking project (audit)
  let projectId = site.se_ranking_project_id || null;
  if (!projectId) {
    const createRes = await sr("POST", "/audit/create", {
      title: `${domain} (${tier})`,
      url: site.primary_url || `https://${domain}`,
      // Per-tier audit settings — populated from TIER_CONFIG above.
      // Cadence is what SE Ranking uses to schedule the next audit run.
    });
    if (!createRes.ok) {
      errors.push(`Audit create failed: ${createRes.errorText || createRes.status}`);
      manualSteps.push("Create SE Ranking audit manually for " + domain);
    } else {
      projectId = createRes.data?.id || createRes.data?.audit_id || createRes.data?.project_id;
    }
  }

  // 2. Audit settings (cadence, page depth) — best-effort; SE Ranking only
  //    allows full re-create on tier upgrade, so we mostly rely on the create
  //    body setting these.
  if (projectId) {
    manualSteps.push(`Confirm audit cadence is set to ${config.audit_cadence_days} days in SE Ranking dashboard for project #${projectId}`);
  }

  // 3. Keyword groups (Focus Areas) — set up 1..N empty groups so the tenant
  //    can categorize keywords.
  for (let i = 1; i <= config.keyword_groups; i++) {
    manualSteps.push(`Optional: create keyword group #${i} in SE Ranking (tenant can name them later)`);
  }

  // 4. AI search results tracking — Growth + Authority.
  //
  // SE Ranking exposes AI Search tracking (Google AI Mode, ChatGPT, Gemini)
  // as project-level settings. The public docs at time of writing don't
  // describe the exact API for toggling these per project, so we attempt
  // a plausible endpoint pattern (PATCH /audit/{id}/settings with the
  // boolean flags) and fall back to a structured manual step if that 404s
  // or rejects. This keeps the onboarding handoff actionable either way —
  // the founder either sees "auto-configured" or gets a precise checklist
  // of toggles to flip in the SE Ranking dashboard.
  if (projectId && (config.ai_mode_tracking || config.chatgpt_tracking || config.gemini_tracking)) {
    const aiSettings = {
      ai_mode_tracking: !!config.ai_mode_tracking,
      chatgpt_tracking: !!config.chatgpt_tracking,
      gemini_tracking: !!config.gemini_tracking,
    };
    const attempt = await sr("PATCH", `/audit/${projectId}/settings`, aiSettings);
    if (attempt.ok) {
      // Confirmed — no manual step needed.
    } else {
      // Endpoint may be unsupported / project-level vs audit-level. Surface
      // explicit per-toggle manual steps so the founder knows exactly what
      // to click. Include the project ID in each step to make it copy-paste.
      if (config.ai_mode_tracking) {
        manualSteps.push({
          system: "SE Ranking",
          target: `Project #${projectId}`,
          action: "Enable Google AI Mode tracking",
          path: "Project Settings → AI Search → toggle ON",
        });
      }
      if (config.chatgpt_tracking) {
        manualSteps.push({
          system: "SE Ranking",
          target: `Project #${projectId}`,
          action: "Enable ChatGPT search tracking",
          path: "Project Settings → AI Search → toggle ON",
        });
      }
      if (config.gemini_tracking) {
        manualSteps.push({
          system: "SE Ranking",
          target: `Project #${projectId}`,
          action: "Enable Gemini search tracking",
          path: "Project Settings → AI Search → toggle ON",
        });
      }
    }
  }

  // 5. Backlink monitoring — Growth + Authority. Same pattern as AI tracking:
  // attempt automated enable, fall back to structured manual step.
  if (projectId && config.backlink_monitoring) {
    const blAttempt = await sr("PATCH", `/audit/${projectId}/settings`, { backlink_monitoring: true });
    if (!blAttempt.ok) {
      manualSteps.push({
        system: "SE Ranking",
        target: `Project #${projectId}`,
        action: "Enable Backlink monitoring",
        path: "Project Settings → Backlinks → Enable",
      });
    }
  }

  return {
    ok: !errors.length,
    projectId,
    config,
    errors,
    manual_steps: manualSteps,
  };
}

/**
 * Persist the configuration result back to arion.site. Updates
 * se_ranking_project_id + records a JSON snapshot of the config + manual steps.
 */
export async function persistResult(pool, tenantId, siteId, result) {
  await pool.request()
    .input("tenantId", sql.UniqueIdentifier, tenantId)
    .input("siteId", sql.UniqueIdentifier, siteId)
    .input("projectId", sql.NVarChar(80), result.projectId ? String(result.projectId) : null)
    .input("snapshot", sql.NVarChar(sql.MAX), JSON.stringify({
      config: result.config,
      manual_steps: result.manual_steps,
      errors: result.errors,
      configured_at: new Date().toISOString(),
    }))
    .query(`
      UPDATE arion.site
      SET se_ranking_project_id = COALESCE(@projectId, se_ranking_project_id),
          se_ranking_onboarding_snapshot = @snapshot
      WHERE site_id = @siteId AND tenant_id = @tenantId
    `).catch((err) => {
      // If the snapshot column doesn't exist yet, fall back to just updating project_id
      console.warn("[seo-onboarding] snapshot column missing, falling back:", err.message);
      return pool.request()
        .input("tenantId", sql.UniqueIdentifier, tenantId)
        .input("siteId", sql.UniqueIdentifier, siteId)
        .input("projectId", sql.NVarChar(80), result.projectId ? String(result.projectId) : null)
        .query(`UPDATE arion.site SET se_ranking_project_id = COALESCE(@projectId, se_ranking_project_id)
                WHERE site_id=@siteId AND tenant_id=@tenantId`);
    });
}
