// lib/aiPromptPolicy.js
//
// AI Search prompt policy for the SEO add-on ladder (Brandon 2026-08-21,
// PRICING_REWORK_DECISIONS_2026-08-21.md § "AI engine model").
//
// SE Ranking counts prompts per prompt × engine, so the cap is PER ENGINE,
// not per project:
//   Growth    = 5 prompts × (Google AI Overviews + Google AI Mode)          = 10 slots
//   Authority = the same 5 × (AI Overviews + AI Mode + ChatGPT + Gemini)   = 20 slots
//   Starter / Essentials = no AI tracking. Perplexity = consulting-only.
//
// The engine list per tier is TIER_CONFIG.ai_engines in lib/seoOnboarding.js
// (what provisioning actually enables) — DERIVED here, not mirrored, so the
// route and the provisioner cannot drift again. Portal
// src/arion/pages/seo/SeoAIPrompts.tsx renders the same per-engine counters
// and reads `cap` as "prompts per engine".

import { TIER_CONFIG } from './seoOnboarding.js';

export const AI_PROMPTS_PER_ENGINE = 5;

/** Prompt cap PER ENGINE by SEO add-on tier (0 = tier has no AI tracking). */
export const AI_PROMPT_TIER_LIMITS = Object.fromEntries(
  Object.entries(TIER_CONFIG).map(([tier, cfg]) => [tier, cfg.ai_engines.length ? AI_PROMPTS_PER_ENGINE : 0])
);

/** Internal engine keys a tier may track (ai_overview | ai_mode | chatgpt | gemini). */
export const AI_PROMPT_ENGINES_BY_TIER = Object.fromEntries(
  Object.entries(TIER_CONFIG).map(([tier, cfg]) => [tier, [...cfg.ai_engines]])
);

// Internal engine key ↔ SE Ranking AIRT `base_name` (the API enum).
export const AIRT_ENGINE_BASE_NAMES = {
  ai_mode: 'google_ai_mode',
  chatgpt: 'chatgpt',
  gemini: 'gemini',
  perplexity: 'perplexity',
  ai_overview: 'google_ai_overview',
};

export const AIRT_BASE_NAME_TO_KEY = Object.fromEntries(
  Object.entries(AIRT_ENGINE_BASE_NAMES).map(([key, baseName]) => [baseName, key])
);

/**
 * Prompts already tracked on ONE engine, given the getAllAIPrompts() shape
 * ([{ llm_id, engine_base_name, prompts: [...] }, ...]).
 */
export function promptsOnEngine(byEngine, engineKey) {
  const baseName = AIRT_ENGINE_BASE_NAMES[engineKey];
  if (!baseName) return 0;
  return (Array.isArray(byEngine) ? byEngine : [])
    .filter((e) => e?.engine_base_name === baseName)
    .reduce((n, e) => n + (Array.isArray(e.prompts) ? e.prompts.length : 0), 0);
}

/**
 * May one more prompt be added on `engine` for a site at `tier`?
 *
 * `existing` = prompts already on THAT engine. Pass null/undefined to run
 * only the tier + engine checks (the route does that before it spends an SE
 * Ranking call looking the engine up).
 *
 * @returns {{ ok: true, cap: number, existing: number|null }
 *        | { ok: false, status: number, code: string, message: string, cap?: number, existing?: number }}
 */
export function aiPromptAddDecision({ tier, engine, existing = null }) {
  const t = String(tier || '').trim().toLowerCase();
  const cap = AI_PROMPT_TIER_LIMITS[t] || 0;
  if (cap === 0) {
    return { ok: false, status: 403, code: 'TIER_NOT_AVAILABLE', message: `AI prompts require Growth or Authority tier. Current: ${t || 'none'}.` };
  }
  const allowed = AI_PROMPT_ENGINES_BY_TIER[t] || [];
  if (!allowed.includes(engine)) {
    return { ok: false, status: 400, code: 'INVALID_ENGINE', message: `Engine ${engine} not available at tier ${t}. Allowed: ${allowed.join(', ')}.` };
  }
  if (existing != null && Number(existing) >= cap) {
    return { ok: false, status: 400, code: 'CAP_EXCEEDED', message: `${engine} already tracks ${cap} prompts (the cap is ${cap} per engine). Remove a prompt on that engine first.`, cap, existing: Number(existing) };
  }
  return { ok: true, cap, existing: existing == null ? null : Number(existing) };
}
