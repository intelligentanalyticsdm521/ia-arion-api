// test/ai-prompt-per-engine-cap.test.js
//
// Pins the AI engine model agreed 2026-08-21 (PRICING_REWORK_DECISIONS
// § "AI engine model"): SE Ranking counts prompt × engine slots, so the cap
// is 5 PER ENGINE — Growth = 5 × (AI Overviews + AI Mode) = 10 slots,
// Authority = 5 × (+ ChatGPT + Gemini) = 20 slots. The previous rule
// ("5 TOTAL across engines", 2026-06-17) rejected an Authority site after
// five slots while the Portal's per-engine counters still offered Add.
//
// POST /seo/ai-prompts (routes/arion.js) delegates to aiPromptAddDecision
// with the count of prompts already on the SELECTED engine only.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AI_PROMPTS_PER_ENGINE,
  AI_PROMPT_TIER_LIMITS,
  AI_PROMPT_ENGINES_BY_TIER,
  AIRT_ENGINE_BASE_NAMES,
  AIRT_BASE_NAME_TO_KEY,
  promptsOnEngine,
  aiPromptAddDecision,
} from '../lib/aiPromptPolicy.js';
import { TIER_CONFIG } from '../lib/seoOnboarding.js';

// getAllAIPrompts() shape: [{ llm_id, engine_base_name, prompts: [...] }]
const prompts = (n) => Array.from({ length: n }, (_, i) => ({ k2site_llm_id: i + 1, keyword: `prompt ${i + 1}` }));
const engine = (baseName, n, llmId) => ({ llm_id: llmId, engine_base_name: baseName, prompts: prompts(n) });

test('cap is 5 PER ENGINE: Growth/Authority 5, Starter/Essentials 0; engine lists come from TIER_CONFIG', () => {
  assert.equal(AI_PROMPTS_PER_ENGINE, 5);
  assert.deepEqual(AI_PROMPT_TIER_LIMITS, { starter: 0, essentials: 0, growth: 5, authority: 5 });
  assert.deepEqual(AI_PROMPT_ENGINES_BY_TIER.growth, ['ai_overview', 'ai_mode']);
  assert.deepEqual(AI_PROMPT_ENGINES_BY_TIER.authority, ['ai_overview', 'ai_mode', 'chatgpt', 'gemini']);
  for (const [tier, cfg] of Object.entries(TIER_CONFIG)) {
    assert.deepEqual(AI_PROMPT_ENGINES_BY_TIER[tier], cfg.ai_engines, `${tier} engines drifted from TIER_CONFIG`);
  }
  for (const list of Object.values(AI_PROMPT_ENGINES_BY_TIER)) assert.ok(!list.includes('perplexity'), 'Perplexity is consulting-only');
});

test('ai_overview maps to SE Ranking base_name google_ai_overview (both directions)', () => {
  assert.equal(AIRT_ENGINE_BASE_NAMES.ai_overview, 'google_ai_overview');
  assert.equal(AIRT_ENGINE_BASE_NAMES.ai_mode, 'google_ai_mode');
  assert.equal(AIRT_BASE_NAME_TO_KEY.google_ai_overview, 'ai_overview');
  assert.equal(AIRT_BASE_NAME_TO_KEY.google_ai_mode, 'ai_mode');
  for (const [key, baseName] of Object.entries(AIRT_ENGINE_BASE_NAMES)) assert.equal(AIRT_BASE_NAME_TO_KEY[baseName], key);
});

test('Authority site with 5 prompts on ChatGPT can still add 5 on Gemini', () => {
  const byEngine = [
    engine('chatgpt', 5, 11821),
    engine('gemini', 0, 13150),
    engine('google_ai_mode', 5, 13165),
    engine('google_ai_overview', 5, 21652),
  ];
  // 15 slots in use — the old TOTAL rule would already have rejected everything.
  assert.equal(byEngine.reduce((n, e) => n + e.prompts.length, 0), 15);

  for (let i = 1; i <= 5; i++) {
    const d = aiPromptAddDecision({ tier: 'authority', engine: 'gemini', existing: promptsOnEngine(byEngine, 'gemini') });
    assert.equal(d.ok, true, `Gemini prompt #${i} must be allowed (ChatGPT's 5 do not count)`);
    assert.equal(d.cap, 5);
    byEngine[1].prompts.push({ k2site_llm_id: 100 + i });
  }
  assert.equal(promptsOnEngine(byEngine, 'gemini'), 5);
  assert.equal(byEngine.reduce((n, e) => n + e.prompts.length, 0), 20);
});

test('6th prompt on the SAME engine → 400 CAP_EXCEEDED naming that engine (Authority and Growth alike)', () => {
  const byEngine = [engine('chatgpt', 5, 1), engine('gemini', 2, 2)];
  const d = aiPromptAddDecision({ tier: 'authority', engine: 'chatgpt', existing: promptsOnEngine(byEngine, 'chatgpt') });
  assert.equal(d.ok, false);
  assert.equal(d.status, 400);
  assert.equal(d.code, 'CAP_EXCEEDED');
  assert.equal(d.cap, 5);
  assert.equal(d.existing, 5);
  assert.match(d.message, /chatgpt/);
  assert.match(d.message, /per engine/);

  const g = aiPromptAddDecision({ tier: 'growth', engine: 'ai_mode', existing: 5 });
  assert.equal(g.code, 'CAP_EXCEEDED');
  assert.equal(aiPromptAddDecision({ tier: 'growth', engine: 'ai_mode', existing: 4 }).ok, true);
  assert.equal(aiPromptAddDecision({ tier: 'growth', engine: 'ai_overview', existing: 0 }).ok, true);
});

test('Growth cannot add to ChatGPT or Gemini (400 INVALID_ENGINE); Perplexity is never allowed', () => {
  for (const e of ['chatgpt', 'gemini', 'perplexity']) {
    const d = aiPromptAddDecision({ tier: 'growth', engine: e, existing: 0 });
    assert.equal(d.ok, false, `growth must reject ${e}`);
    assert.equal(d.status, 400);
    assert.equal(d.code, 'INVALID_ENGINE');
    assert.match(d.message, /ai_overview, ai_mode/);
  }
  const p = aiPromptAddDecision({ tier: 'authority', engine: 'perplexity', existing: 0 });
  assert.equal(p.code, 'INVALID_ENGINE');
  assert.equal(aiPromptAddDecision({ tier: 'authority', engine: 'chatgpt', existing: 0 }).ok, true);
});

test('Starter / Essentials / no add-on → 403 TIER_NOT_AVAILABLE before any engine or count is consulted', () => {
  for (const tier of ['starter', 'essentials', '', null, undefined, 'gold']) {
    const d = aiPromptAddDecision({ tier, engine: 'ai_overview', existing: 0 });
    assert.equal(d.ok, false, `${tier} must not get AI prompts`);
    assert.equal(d.status, 403);
    assert.equal(d.code, 'TIER_NOT_AVAILABLE');
  }
  // tier value is normalised the way the route reads seo_addon_tier
  assert.equal(aiPromptAddDecision({ tier: ' Authority ', engine: 'gemini', existing: 0 }).ok, true);
});

test('pre-check without a count (existing omitted) validates tier + engine and never reports CAP_EXCEEDED', () => {
  const d = aiPromptAddDecision({ tier: 'authority', engine: 'chatgpt' });
  assert.equal(d.ok, true);
  assert.equal(d.existing, null);
  assert.equal(aiPromptAddDecision({ tier: 'growth', engine: 'chatgpt' }).code, 'INVALID_ENGINE');
  assert.equal(aiPromptAddDecision({ tier: 'starter', engine: 'ai_mode' }).code, 'TIER_NOT_AVAILABLE');
});

test('promptsOnEngine counts only the selected engine, by SE Ranking base_name', () => {
  const byEngine = [engine('google_ai_overview', 3, 1), engine('google_ai_mode', 1, 2), engine('chatgpt', 5, 3), { llm_id: 4, engine_base_name: 'gemini' /* no prompts key */ }];
  assert.equal(promptsOnEngine(byEngine, 'ai_overview'), 3);
  assert.equal(promptsOnEngine(byEngine, 'ai_mode'), 1);
  assert.equal(promptsOnEngine(byEngine, 'chatgpt'), 5);
  assert.equal(promptsOnEngine(byEngine, 'gemini'), 0);
  assert.equal(promptsOnEngine(byEngine, 'perplexity'), 0);
  assert.equal(promptsOnEngine(byEngine, 'bogus'), 0);
  assert.equal(promptsOnEngine(null, 'chatgpt'), 0);
});
