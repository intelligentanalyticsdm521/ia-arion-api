/**
 * Shared Anthropic client for the ARION IL website builder pipeline.
 * --------------------------------------------------------------------------
 * Mirrors the no-SDK pattern in `lib/aiCopy.js` (raw fetch + KV-backed key)
 * but exposes a single primitive that callEmitter.js wraps:
 *
 *   callAnthropic({ model, system, user, maxTokens, responseFormat })
 *     → { ok, data, text, inputTokens, outputTokens, model, latencyMs, error }
 *
 * `responseFormat: 'json'` strips markdown fences and JSON.parses the body;
 * on parse failure it returns { ok:false, error:{ code:'invalid_json', ... }}.
 *
 * Keep this module thin — emitter-specific prompts + validation live in the
 * emitters folder, NOT here.
 *
 * Per memory `reference_intelligence_layer_terminology.md`:
 *   - Internal proprietary architecture is "ARION IL"
 *   - Underlying provider (Claude) is implementation detail, NEVER user-facing
 *   - Endpoint names, UI labels, customer docs use "ARION IL" or "Website
 *     Builder" — NOT "Claude" / "Anthropic"
 */

import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';
import { PROVIDER_COSTS, computeCostBasis } from '../argus/callWrapper.js';

const KV_URI = process.env.KEY_VAULT_URI || 'https://kv-iadm-prod.vault.azure.net/';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Default model for the website builder. Per ARGUS cost coefficients in
// lib/argus/callWrapper.js, claude-haiku-4-5 is the cheap/fast tier
// ($0.25/M in, $1.25/M out). The website builder emits short JSON blocks
// (200-500 output tokens) so haiku is the right default; emitters can
// override per-kind.
export const DEFAULT_MODEL = 'claude-haiku-4-5';
export const DEFAULT_MAX_TOKENS = 1500;
export const DEFAULT_TIMEOUT_MS = 60_000;

let _kvClient = null;
function kv() {
  if (!_kvClient) _kvClient = new SecretClient(KV_URI, new DefaultAzureCredential());
  return _kvClient;
}

let _apiKeyCache = null;
async function getApiKey() {
  if (_apiKeyCache) return _apiKeyCache;
  const env = process.env.ANTHROPIC_API_KEY;
  if (env) { _apiKeyCache = env; return env; }
  const secret = await kv().getSecret('ANTHROPIC-API-KEY');
  _apiKeyCache = secret.value;
  return _apiKeyCache;
}

/**
 * Strip markdown code fences ```json ... ``` that Claude sometimes wraps JSON in
 * despite explicit "no markdown" instructions. Safe to run on already-clean text.
 */
function stripJsonFences(text) {
  if (!text) return '';
  return String(text)
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

/**
 * Call Anthropic Messages API.
 *
 * @param {object} opts
 * @param {string} [opts.model]           — Anthropic model id (default DEFAULT_MODEL)
 * @param {string} opts.system            — System prompt (required)
 * @param {string} opts.user              — User-turn prompt (required)
 * @param {number} [opts.maxTokens]       — Max output tokens (default 1500)
 * @param {number} [opts.timeoutMs]       — Request timeout (default 60s)
 * @param {'json'|'text'} [opts.responseFormat='text']
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   data?: any,                // parsed JSON when responseFormat='json'
 *   text?: string,             // raw text
 *   inputTokens: number,
 *   outputTokens: number,
 *   model: string,
 *   latencyMs: number,
 *   error?: { code: string, message: string, status?: number }
 * }>}
 */
export async function callAnthropic({
  model = DEFAULT_MODEL,
  system,
  user,
  maxTokens = DEFAULT_MAX_TOKENS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  responseFormat = 'text',
}) {
  if (!system || !user) {
    return {
      ok: false,
      inputTokens: 0,
      outputTokens: 0,
      model,
      latencyMs: 0,
      error: { code: 'bad_args', message: 'callAnthropic requires both system and user prompts' },
    };
  }

  let apiKey;
  try {
    apiKey = await getApiKey();
  } catch (e) {
    return {
      ok: false,
      inputTokens: 0,
      outputTokens: 0,
      model,
      latencyMs: 0,
      error: { code: 'no_api_key', message: e?.message?.slice(0, 200) || 'Could not load ANTHROPIC-API-KEY' },
    };
  }

  const startMs = Date.now();
  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return {
      ok: false,
      inputTokens: 0,
      outputTokens: 0,
      model,
      latencyMs: Date.now() - startMs,
      error: { code: 'network_error', message: err?.message?.slice(0, 200) || 'fetch failed' },
    };
  }

  const latencyMs = Date.now() - startMs;

  if (!res.ok) {
    const bodyTxt = await res.text().catch(() => '');
    return {
      ok: false,
      inputTokens: 0,
      outputTokens: 0,
      model,
      latencyMs,
      error: {
        code: `http_${res.status}`,
        message: bodyTxt.slice(0, 400) || `HTTP ${res.status}`,
        status: res.status,
      },
    };
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    return {
      ok: false,
      inputTokens: 0,
      outputTokens: 0,
      model,
      latencyMs,
      error: { code: 'bad_response', message: 'Anthropic response not JSON' },
    };
  }

  const text = body?.content?.[0]?.text || '';
  const inputTokens = body?.usage?.input_tokens || 0;
  const outputTokens = body?.usage?.output_tokens || 0;
  const usedModel = body?.model || model;

  if (responseFormat === 'json') {
    const clean = stripJsonFences(text);
    try {
      const data = JSON.parse(clean);
      return { ok: true, data, text: clean, inputTokens, outputTokens, model: usedModel, latencyMs };
    } catch (e) {
      return {
        ok: false,
        text: clean,
        inputTokens,
        outputTokens,
        model: usedModel,
        latencyMs,
        error: {
          code: 'invalid_json',
          message: `JSON parse failed: ${e.message}. Head: ${clean.slice(0, 200)}`,
        },
      };
    }
  }

  return { ok: true, text, inputTokens, outputTokens, model: usedModel, latencyMs };
}

/**
 * Cost-basis math — DRY against lib/argus/callWrapper.js PROVIDER_COSTS.
 *
 * Anthropic's Messages API returns versioned model ids like
 *   "claude-haiku-4-5-20251001"
 * but the PROVIDER_COSTS table keys on the short ids ("claude-haiku-4-5").
 * normalizeModelId() strips the trailing -YYYYMMDD date suffix so versioned
 * ids resolve to the same coefficient row, and we always return a real
 * cost_usd number (the ARGUS cost guard depends on it being non-null).
 */
function normalizeModelId(model) {
  if (!model) return null;
  // Strip trailing -YYYYMMDD date suffix that Anthropic appends server-side.
  return String(model).replace(/-\d{8}$/, '');
}

export function estimateCostUsd({ model, inputTokens, outputTokens }) {
  const normalized = normalizeModelId(model);
  if (normalized && PROVIDER_COSTS[normalized]) {
    const basis = computeCostBasis({
      model: normalized,
      inputTokens,
      outputTokens,
      imageCount: 0,
    });
    if (basis == null) return null;
    // Round to 6 decimal places (sub-cent precision for accumulating small calls).
    return Math.round(basis * 1_000_000) / 1_000_000;
  }
  return null;
}
