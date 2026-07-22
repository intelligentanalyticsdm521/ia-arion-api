/**
 * AI copy generation for customer onboarding.
 * --------------------------------------------------------------------------
 * Takes the questionnaire and produces branded copy that the wp-cli swap step
 * splices into the imported Astra starter template. The customer never sees
 * generic placeholder text — every site gets text written for *their* business.
 *
 * Uses the Anthropic API directly (no SDK) so we control retry + timeout.
 * Key is read from KV as `ANTHROPIC-API-KEY` (set on App Service as a KV ref).
 *
 * Soft-failure model: if Claude is down or the JSON is malformed, return a
 * non-AI fallback bundle so the customer still gets a launched site.
 */

import sql from 'mssql';
import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';

// Verified per-MTok rates for cost telemetry (2026-07-22): Opus 4.7 $5/$25.
const OPUS_IN_PER_MTOK = 5;
const OPUS_OUT_PER_MTOK = 25;

// Best-effort usage telemetry (IL credits pass, 2026-07-22): this was the
// ONLY LLM call in the stack writing zero cost telemetry — the priciest
// model, cost-invisible. Mirrors imageGen.js's lumen.ai_usage contract.
// Never throws; a missing pool/tenantId is a silent no-op (some callers may
// not have DB context).
async function logUsage(pool, tenantId, { ok, latencyMs, inputTokens, outputTokens, errorCode, meta }) {
  if (!pool || !tenantId) return;
  try {
    const costUsd = ok
      ? ((inputTokens || 0) * OPUS_IN_PER_MTOK + (outputTokens || 0) * OPUS_OUT_PER_MTOK) / 1_000_000
      : null;
    await pool.request()
      .input('tenant_id',     sql.UniqueIdentifier, tenantId)
      .input('surface',       sql.NVarChar(50),     'arion.website_builder')
      .input('sub_kind',      sql.NVarChar(50),     'site_copy')
      .input('provider',      sql.NVarChar(32),     'anthropic')
      .input('model_id',      sql.NVarChar(64),     'claude-opus-4-7')
      .input('input_tokens',  sql.Int,              inputTokens || null)
      .input('output_tokens', sql.Int,              outputTokens || null)
      .input('latency_ms',    sql.Int,              latencyMs || null)
      .input('cost_usd',      sql.Decimal(10, 4),   costUsd == null ? null : Number(costUsd.toFixed(4)))
      .input('ok',            sql.Bit,              ok ? 1 : 0)
      .input('error_code',    sql.NVarChar(64),     errorCode || null)
      .input('meta_json',     sql.NVarChar(sql.MAX), JSON.stringify(meta || {}))
      .query(`
        INSERT INTO lumen.ai_usage
          (tenant_id, surface, sub_kind, provider, model_id,
           input_tokens, output_tokens, latency_ms, cost_usd,
           ok, error_code, meta_json)
        VALUES
          (@tenant_id, @surface, @sub_kind, @provider, @model_id,
           @input_tokens, @output_tokens, @latency_ms, @cost_usd,
           @ok, @error_code, @meta_json)
      `);
  } catch (e) {
    console.warn(`[aiCopy:logUsage] insert failed (non-fatal): ${e?.message?.slice(0, 200)}`);
  }
}

const KV_URI = process.env.KEY_VAULT_URI || 'https://kv-iadm-prod.vault.azure.net/';
let _kv = null;
function kv() {
  if (!_kv) _kv = new SecretClient(KV_URI, new DefaultAzureCredential());
  return _kv;
}

let _keyCache = null;
async function getApiKey() {
  if (_keyCache) return _keyCache;
  const env = process.env.ANTHROPIC_API_KEY;
  if (env) { _keyCache = env; return env; }
  const secret = await kv().getSecret('ANTHROPIC-API-KEY');
  _keyCache = secret.value;
  return _keyCache;
}

/**
 * Generate branded site copy from the questionnaire.
 *
 * Returns a structured bundle that the wp-cli swap step inserts into the
 * imported Astra template:
 *
 *   {
 *     heroHeadline:  string  (8-12 words, customer-facing)
 *     heroSubtext:   string  (1-2 sentences)
 *     heroCta:       string  (3-5 words, action verb)
 *     aboutHeadline: string  (~6 words)
 *     aboutBody:     string  (3-5 sentences)
 *     services:      [{ name, blurb }] (one per service from questionnaire)
 *     contactIntro:  string  (2-3 sentences)
 *     blogIntroPost: { title, body } (one starter post)
 *   }
 *
 * @param {object} answers  The questionnaire payload
 * @param {object} [opts]   Optional telemetry context: { pool, tenantId } —
 *                          when present, the call logs to lumen.ai_usage.
 * @returns {Promise<object>}
 */
export async function generateSiteCopy(answers, opts = {}) {
  const services = Array.isArray(answers.services) ? answers.services : [];
  const fallback = {
    heroHeadline: `${answers.businessName} — ${answers.tagline || 'Built for businesses like yours'}`,
    heroSubtext: answers.description || `Helping ${answers.targetAudience || 'our clients'} succeed.`,
    heroCta: 'Get in touch',
    aboutHeadline: `About ${answers.businessName}`,
    aboutBody: answers.description || `${answers.businessName} provides quality services for ${answers.targetAudience || 'our clients'}.`,
    services: services.map((s) => ({ name: s, blurb: `Learn more about our ${String(s).toLowerCase()}.` })),
    contactIntro: `We'd love to hear from you. Reach out using the form below and we'll be in touch.`,
    blogIntroPost: {
      title: `Welcome to ${answers.businessName}`,
      body: answers.description || `Welcome to our new site. We're here to help.`,
    },
  };

  let apiKey;
  try { apiKey = await getApiKey(); }
  catch (e) {
    console.warn(`[aiCopy] no Anthropic API key — using fallback copy: ${e.message.slice(0, 200)}`);
    return { ...fallback, source: 'fallback-no-key' };
  }

  const prompt = `You are writing the visible copy for a new small-business website.

INPUT (questionnaire from the customer):
- Business name: ${answers.businessName}
- Industry: ${answers.industry || 'unspecified'}
- One-line tagline: ${answers.tagline || ''}
- Description: ${answers.description || ''}
- Target audience: ${answers.targetAudience || ''}
- Services offered: ${services.join(' | ')}
- Brand voice: ${answers.brandVoice || 'professional'}
- Style preference: ${answers.stylePreference || 'modern'}
- Location: ${answers.location || ''}

OUTPUT: return ONLY a valid JSON object with these exact keys (no markdown, no commentary, no code fences):
{
  "heroHeadline": "string — 8 to 12 words, attention-grabbing, NOT generic",
  "heroSubtext": "string — 1 to 2 sentences explaining the value to the target audience",
  "heroCta": "string — 3 to 5 words, action verb (e.g. 'Book your free call')",
  "aboutHeadline": "string — about 6 words for the About section heading",
  "aboutBody": "string — 3 to 5 sentences, written in the brand voice, telling the story of this specific business",
  "services": [{"name": "exact service name from input", "blurb": "1-2 sentence description specific to this business"}],
  "contactIntro": "string — 2 to 3 sentences inviting the visitor to reach out",
  "blogIntroPost": {"title": "string", "body": "string of 3-5 sentences as a welcome blog post for this specific business"}
}

REQUIREMENTS:
- Every line must reference THIS business by name, services, or audience — never generic templated text
- Write in the requested brand voice ("${answers.brandVoice || 'professional'}")
- Do NOT include lorem ipsum, placeholders, or "your business" generics
- Output MUST be parseable as JSON — no markdown wrapping`;

  const t0 = Date.now();
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-7',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.warn(`[aiCopy] Anthropic HTTP ${res.status}: ${txt.slice(0, 300)}`);
      await logUsage(opts.pool, opts.tenantId, { ok: false, latencyMs: Date.now() - t0, errorCode: `http_${res.status}` });
      return { ...fallback, source: `fallback-http-${res.status}` };
    }
    const body = await res.json();
    await logUsage(opts.pool, opts.tenantId, {
      ok: true,
      latencyMs: Date.now() - t0,
      inputTokens: body?.usage?.input_tokens || 0,
      outputTokens: body?.usage?.output_tokens || 0,
      meta: { business: answers.businessName || null },
    });
    const text = body?.content?.[0]?.text || '';
    // Strip any markdown fences just in case
    const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try {
      const parsed = JSON.parse(clean);
      // Backfill any missing keys from fallback so downstream code never sees undefined
      return { ...fallback, ...parsed, source: 'anthropic' };
    } catch (e) {
      console.warn(`[aiCopy] JSON parse failed: ${e.message}. Body head: ${clean.slice(0, 300)}`);
      return { ...fallback, source: 'fallback-parse-error' };
    }
  } catch (err) {
    console.warn(`[aiCopy] call failed: ${err.message.slice(0, 200)}`);
    return { ...fallback, source: 'fallback-exception' };
  }
}

export default { generateSiteCopy };
