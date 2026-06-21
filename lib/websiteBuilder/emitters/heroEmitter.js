/**
 * Hero block emitter — ARION IL website builder.
 * --------------------------------------------------------------------------
 * Produces a hero section payload that elementorAdapter.js converts into a
 * full-width section + heading + subheading + button (and an optional
 * background style hint).
 *
 * Output schema:
 *   {
 *     headline:        string  (4-12 words, attention-grabbing, business-specific)
 *     subheadline:     string  (1-2 sentences, max ~30 words)
 *     cta_text:        string  (2-5 words, action verb)
 *     cta_href:        string  ('#contact' | '/contact' | etc. — relative ok)
 *     image_alt:       string  (5-12 words describing hero image semantics)
 *     background_style: 'solid' | 'gradient' | 'image' | 'video'
 *   }
 *
 * Example 1 (industrial cleaning business):
 *   {
 *     "headline": "Spotless Industrial Cleaning, Trusted Across Iowa",
 *     "subheadline": "Round-the-clock service for warehouses, plants, and distribution centers — without the downtime.",
 *     "cta_text": "Get a free quote",
 *     "cta_href": "#contact",
 *     "image_alt": "Wide warehouse interior gleaming after deep clean",
 *     "background_style": "image"
 *   }
 *
 * Example 2 (boutique accounting firm):
 *   {
 *     "headline": "Accounting Built Around Your Quarter-End",
 *     "subheadline": "Boutique tax and bookkeeping for service businesses — fewer surprises, sharper numbers.",
 *     "cta_text": "Book a discovery call",
 *     "cta_href": "#contact",
 *     "image_alt": "Calm accountant reviewing a clean ledger by daylight",
 *     "background_style": "solid"
 *   }
 */

const BACKGROUND_STYLES = new Set(['solid', 'gradient', 'image', 'video']);

const SYSTEM_PROMPT = `You are the ARION IL hero-section copywriter for small-business websites.
You write attention-grabbing, business-specific hero copy that NEVER reads as a generic template.
You return ONLY a single valid JSON object, no markdown, no commentary, no code fences.
You write in the requested brand voice. You never use the phrase "your business", "lorem ipsum", or filler text.
Every line must reference THIS specific business by name, services, location, or audience.`;

function buildUserPrompt({ brand, sectionContext }) {
  const ctx = sectionContext || {};
  return `Write a hero section for THIS business.

BUSINESS CONTEXT:
- Business name: ${brand.business_name || '(unspecified — invent a clear placeholder)'}
- Industry: ${brand.industry || 'unspecified'}
- One-line tagline (if any): ${brand.tagline || ''}
- Description: ${brand.description || ''}
- Target audience: ${brand.target_audience || 'small business owners'}
- Services offered: ${(brand.services || []).join(' | ') || 'unspecified'}
- Brand voice: ${brand.brand_voice || 'professional'}
- Style preference: ${brand.style_preference || 'modern'}
- Location: ${brand.location || ''}

SECTION OVERRIDES (optional):
- Desired tone shift: ${ctx.tone_shift || 'none'}
- Preferred CTA destination: ${ctx.cta_href || '#contact'}
- Background style hint: ${ctx.background_style || 'auto — pick the best fit'}
- Variant note: ${ctx.variant_note || 'none'}

OUTPUT — return ONLY this JSON object, no markdown:
{
  "headline":         "4-12 words, attention-grabbing, specific to this business",
  "subheadline":      "1-2 sentences, max ~30 words, explains the value to the target audience",
  "cta_text":         "2-5 words, action verb (e.g. 'Book your free call')",
  "cta_href":         "${ctx.cta_href || '#contact'}",
  "image_alt":        "5-12 words describing what the hero image should depict — semantic, not literal",
  "background_style": "one of: solid | gradient | image | video"
}

REQUIREMENTS:
- Headline must reference the business name, industry, audience, or location — never a generic platitude.
- Write in the "${brand.brand_voice || 'professional'}" brand voice.
- No emojis. No quotes around the headline. No trailing punctuation in CTA.
- Output MUST parse as JSON — no markdown wrapping.`;
}

/**
 * Hand-rolled validator (avoiding Zod to keep the runtime small — see
 * package.json deps; Zod is not installed).
 */
function validateOutput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: { code: 'shape_error', message: 'hero output must be a non-array object' } };
  }
  const fields = ['headline', 'subheadline', 'cta_text', 'cta_href', 'image_alt', 'background_style'];
  for (const f of fields) {
    if (typeof data[f] !== 'string' || !data[f].trim()) {
      return { ok: false, error: { code: 'missing_field', message: `hero output missing or empty: ${f}` } };
    }
  }
  if (!BACKGROUND_STYLES.has(data.background_style)) {
    return {
      ok: false,
      error: {
        code: 'invalid_background_style',
        message: `background_style must be one of ${[...BACKGROUND_STYLES].join('|')}, got "${data.background_style}"`,
      },
    };
  }
  // Soft length bounds — clip rather than reject so we never hard-fail a build
  // on a hero that's 13 words instead of 12.
  const headlineWords = data.headline.trim().split(/\s+/);
  if (headlineWords.length < 2 || headlineWords.length > 24) {
    return {
      ok: false,
      error: { code: 'headline_length', message: `headline must be 2-24 words, got ${headlineWords.length}` },
    };
  }
  if (data.subheadline.length > 400) {
    return {
      ok: false,
      error: { code: 'subheadline_length', message: `subheadline must be <=400 chars, got ${data.subheadline.length}` },
    };
  }

  // Normalize whitespace before returning.
  const clean = {
    headline:         data.headline.trim(),
    subheadline:      data.subheadline.trim(),
    cta_text:         data.cta_text.trim().replace(/[.!?]+$/, ''),
    cta_href:         data.cta_href.trim() || '#contact',
    image_alt:        data.image_alt.trim(),
    background_style: data.background_style,
  };
  return { ok: true, data: clean };
}

/**
 * Constructor. Stays callable as `createHeroEmitter()` even without args so
 * the registry can default-register; the optional `{ anthropicClient }` arg
 * is reserved for future override (e.g. testing).
 */
export function createHeroEmitter(/* { anthropicClient } = {} */) {
  return {
    kind: 'hero',
    // Section library archetype mapping (db/migrations/029_arion_section_library.sql).
    // When the curated library has variants for this archetype, callEmitter
    // picks one + injects it instead of calling Anthropic — see
    // lib/websiteBuilder/sectionLibrary.js.
    archetype: 'hero',
    maxTokens: 600,
    buildPrompts({ brand, sectionContext }) {
      return {
        system: SYSTEM_PROMPT,
        user:   buildUserPrompt({ brand, sectionContext }),
      };
    },
    validate: validateOutput,
    example: {
      headline: 'Spotless Industrial Cleaning, Trusted Across Iowa',
      subheadline: 'Round-the-clock service for warehouses, plants, and distribution centers — without the downtime.',
      cta_text: 'Get a free quote',
      cta_href: '#contact',
      image_alt: 'Wide warehouse interior gleaming after deep clean',
      background_style: 'image',
    },
  };
}

export const __test__ = { SYSTEM_PROMPT, buildUserPrompt, validateOutput };
