/**
 * AI review-reply drafting for Google Business Profile.
 * --------------------------------------------------------------------------
 * Drafts a short, on-brand reply to a customer review with Claude Haiku,
 * metered on the tenant's ARGUS credit wallet (my_brand.review_reply,
 * 1 credit — migration 129). Powers two surfaces:
 *   • Reviews page "Draft with AI" button (per-review, on demand)
 *   • the Pro+ auto-reply worker (arion-func) for hands-off responses
 *
 * Anthropic key from KV (ANTHROPIC-API-KEY), same pattern as aiCopy.js.
 * Brand voice pulled from lumen.brand_voice_profile when present so replies
 * sound like the business, with a warm professional default otherwise.
 */

import sql from 'mssql';
import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';
import { meterAndAudit } from './argus/callWrapper.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-haiku-4-5';

const KV_URI = process.env.KEY_VAULT_URI || 'https://kv-iadm-prod.vault.azure.net/';
let _kv = null;
function kv() { if (!_kv) _kv = new SecretClient(KV_URI, new DefaultAzureCredential()); return _kv; }
let _keyCache = null;
async function getApiKey() {
  if (_keyCache) return _keyCache;
  const env = process.env.ANTHROPIC_API_KEY;
  if (env) { _keyCache = env; return env; }
  const secret = await kv().getSecret('ANTHROPIC-API-KEY');
  _keyCache = secret.value;
  return _keyCache;
}

// Best-effort brand-voice read — a short tone descriptor from
// lumen.brand_voice_profile (tone_attributes / voice_traits_csv), plus the
// business name from core.tenants. Never throws; neutral fallback.
async function getBrandContext(pool, tenantId) {
  const ctx = { businessName: null, tone: null };
  try {
    const r = await pool.request()
      .input('tid', sql.UniqueIdentifier, tenantId)
      .query(`SELECT TOP 1 tone_attributes, voice_traits_csv FROM lumen.brand_voice_profile WHERE tenant_id = @tid`);
    if (r.recordset.length) {
      const raw = r.recordset[0].voice_traits_csv || r.recordset[0].tone_attributes || null;
      // Keep it short — a handful of trait words is plenty for tone steering.
      ctx.tone = raw ? String(raw).split(',').map(s => s.trim()).filter(Boolean).slice(0, 4).join(', ') : null;
    }
  } catch { /* neutral fallback */ }
  try {
    const r = await pool.request()
      .input('tid', sql.UniqueIdentifier, tenantId)
      .query(`SELECT TOP 1 business_name FROM core.tenants WHERE tenant_id = @tid`);
    ctx.businessName = r.recordset[0]?.business_name || null;
  } catch { /* neutral */ }
  return ctx;
}

function buildPrompt(review, brand) {
  const who = brand.businessName ? `You are the owner of "${brand.businessName}".` : 'You are the owner of this local business.';
  const tone = brand.tone ? ` Write in a ${brand.tone} tone.` : ' Write warmly and professionally.';
  const stars = review.starRating ? `${review.starRating}-star` : 'a';
  const body = review.comment ? `They wrote: "${String(review.comment).slice(0, 800)}"` : 'They left no written comment.';
  return {
    system:
      who + tone +
      ' Reply to this customer review in 1-3 short sentences. Thank them by name if given, ' +
      'be specific and human, never robotic, never use hashtags or emoji spam, and never ' +
      'invent facts. For a negative review, acknowledge sincerely and invite them to make it ' +
      'right offline. Output ONLY the reply text — no quotes, no preamble.',
    user: `A customer (${review.reviewerName || 'a customer'}) left ${stars} review. ${body}`,
  };
}

async function callHaiku(apiKey, prompt) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const e = new Error(`Anthropic ${res.status}: ${t.slice(0, 200)}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  return {
    text: (data.content?.[0]?.text || '').trim(),
    inputTokens: data.usage?.input_tokens || 0,
    outputTokens: data.usage?.output_tokens || 0,
  };
}

/**
 * Draft a review reply, metered on the tenant wallet.
 * @returns {Promise<{ ok:true, draft:string, creditsCharged:number|null }
 *                  | { ok:false, code:string, ...detail }>}
 */
export async function draftReviewReply({ pool, tenantId, userId, review }) {
  const apiKey = await getApiKey().catch(() => null);
  if (!apiKey) return { ok: false, code: 'not_configured' };
  const brand = await getBrandContext(pool, tenantId);
  const prompt = buildPrompt(review, brand);

  const metered = await meterAndAudit({
    pool, tenantId, userId,
    actionType: 'my_brand.review_reply',
    provider: 'anthropic', model: MODEL,
    meta: { surface: 'arion.gbp_reviews', reviewId: review.reviewId, stars: review.starRating },
    runCall: async () => {
      const out = await callHaiku(apiKey, prompt);
      return { inputTokens: out.inputTokens, outputTokens: out.outputTokens, data: out.text };
    },
  });

  if (metered.ok) return { ok: true, draft: metered.result, creditsCharged: metered.audit?.credits_charged ?? null };
  // Graceful pre-flip: if the pricing row is absent/disabled, still draft
  // (unmetered) so the feature is live before the credit economy flips on.
  if (metered.error?.code === 'unknown_action' || metered.error?.code === 'argus_spend_disabled') {
    const out = await callHaiku(apiKey, prompt);
    return { ok: true, draft: out.text, creditsCharged: null };
  }
  return { ok: false, code: metered.error?.code || 'draft_failed', ...metered.error };
}
