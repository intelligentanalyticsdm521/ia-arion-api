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

import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';

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
 * @returns {Promise<object>}
 */
export async function generateSiteCopy(answers) {
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
      return { ...fallback, source: `fallback-http-${res.status}` };
    }
    const body = await res.json();
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
