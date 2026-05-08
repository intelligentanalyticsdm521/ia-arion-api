/**
 * Prompt Builder — Onboarding Answers → Hostinger AI Builder Prompt
 * --------------------------------------------------------------------------
 * The Hostinger AI Builder accepts a free-text "describe your idea" prompt up
 * to 2000 characters. This module assembles the strongest possible prompt
 * from the structured questionnaire we collected during signup so that:
 *
 *   1. Kodee (the post-prompt chat) needs as few follow-ups as possible
 *      because pages, voice, and audience are already declared.
 *   2. The generated site is consistent across all tenants in our portfolio
 *      (we control the prompt template, not the client).
 *   3. We minimize regen risk — a strong prompt = better first-pass output.
 *
 * The prompt format is intentionally structured (labelled sections) rather
 * than prose. Internal Hostinger tests have shown structured prompts produce
 * more predictable page layouts than long narrative descriptions.
 */

const MAX_CHARS = 2000;

/**
 * @typedef {Object} OnboardingAnswers
 * @property {string} businessName
 * @property {string} industry              - e.g. "Dental practice", "HVAC services"
 * @property {string} description           - 1-2 sentence elevator pitch
 * @property {string[]} services            - 3-5 bullets
 * @property {string} targetAudience        - one-sentence description of customer
 * @property {string} location              - city / region served
 * @property {string} brandVoice            - "Professional" | "Friendly" | "Bold" | "Premium" | "Casual"
 * @property {string} stylePreference       - "Modern" | "Classic" | "Minimal" | "Bold"
 * @property {string[]} pages               - subset of: Home, About, Services, Contact, Blog, Shop, Portfolio, FAQ
 * @property {string} [primaryColor]        - hex like "#1a73e8" — optional, applied post-build
 * @property {string} [tagline]             - optional brand tagline
 */

const VOICE_GUIDANCE = {
  Professional: 'Use authoritative, polished language with industry expertise on display.',
  Friendly: 'Use warm, conversational language that feels like a local recommendation.',
  Bold: 'Use confident, energetic language with strong calls to action.',
  Premium: 'Use refined, aspirational language emphasizing quality and exclusivity.',
  Casual: 'Use plain, approachable language with everyday vocabulary.',
};

const STYLE_GUIDANCE = {
  Modern: 'Clean layouts, generous whitespace, sans-serif typography, contemporary imagery.',
  Classic: 'Balanced compositions, serif accents, timeless visuals.',
  Minimal: 'Stripped-down design, monochrome accents, focus on typography and content.',
  Bold: 'High-contrast color blocks, oversized headlines, dynamic visual hierarchy.',
};

/**
 * Build a Hostinger AI Builder prompt from onboarding answers.
 *
 * @param {OnboardingAnswers} answers
 * @returns {{prompt: string, length: number, truncated: boolean}}
 */
export function buildAiPrompt(answers) {
  const a = sanitize(answers);

  // Keep these short — the builder seems to weight early sentences most heavily.
  const lines = [];

  // 1. Identity — front-load brand name, industry, and elevator pitch
  lines.push(`Build a professional WordPress website for ${a.businessName}, a ${a.industry}.`);
  if (a.tagline) lines.push(`Tagline: ${a.tagline}`);
  if (a.description) lines.push(a.description);

  // 2. Services — explicit list, the AI uses this to draft the Services page
  if (a.services.length) {
    lines.push('');
    lines.push('Services to feature:');
    a.services.slice(0, 6).forEach((s) => lines.push(`- ${s}`));
  }

  // 3. Audience + location for SEO context and copy tone
  if (a.targetAudience) lines.push('', `Target audience: ${a.targetAudience}.`);
  if (a.location) lines.push(`Service area: ${a.location}.`);

  // 4. Page structure — the most important line for skipping Kodee follow-ups
  if (a.pages.length) {
    lines.push('', `Required pages (in this order): ${a.pages.join(', ')}.`);
  }

  // 5. Voice + style direction
  if (a.brandVoice && VOICE_GUIDANCE[a.brandVoice]) {
    lines.push('', `Tone: ${a.brandVoice}. ${VOICE_GUIDANCE[a.brandVoice]}`);
  }
  if (a.stylePreference && STYLE_GUIDANCE[a.stylePreference]) {
    lines.push(`Visual style: ${a.stylePreference}. ${STYLE_GUIDANCE[a.stylePreference]}`);
  }

  // 6. Universal directives — always include
  lines.push(
    '',
    'Each page should include strong calls to action. Include realistic placeholder content tailored to the industry and location above. Do not include dummy lorem-ipsum text.',
  );

  let prompt = lines.join('\n').trim();
  let truncated = false;

  if (prompt.length > MAX_CHARS) {
    prompt = prompt.slice(0, MAX_CHARS - 1).trimEnd() + '…';
    truncated = true;
  }

  return { prompt, length: prompt.length, truncated };
}

/**
 * Validate and normalize onboarding answers before prompt assembly.
 * Throws on missing required fields so the caller can surface a clean error.
 * @param {OnboardingAnswers} a
 */
function sanitize(a) {
  const required = ['businessName', 'industry'];
  for (const k of required) {
    if (!a || !a[k] || String(a[k]).trim() === '') {
      throw new Error(`promptBuilder: missing required field "${k}"`);
    }
  }
  return {
    businessName: cleanLine(a.businessName),
    industry: cleanLine(a.industry),
    description: cleanLine(a.description || ''),
    tagline: cleanLine(a.tagline || ''),
    services: Array.isArray(a.services) ? a.services.map(cleanLine).filter(Boolean) : [],
    targetAudience: cleanLine(a.targetAudience || ''),
    location: cleanLine(a.location || ''),
    brandVoice: cleanLine(a.brandVoice || 'Professional'),
    stylePreference: cleanLine(a.stylePreference || 'Modern'),
    pages: Array.isArray(a.pages) && a.pages.length > 0
      ? a.pages.map(cleanLine).filter(Boolean)
      : ['Home', 'About', 'Services', 'Contact'],
  };
}

/**
 * Strip newlines and trim — single-line cleanup so the prompt structure stays
 * clean even if a client pasted multi-line text into a single field.
 */
function cleanLine(s) {
  return String(s || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export default { buildAiPrompt };
