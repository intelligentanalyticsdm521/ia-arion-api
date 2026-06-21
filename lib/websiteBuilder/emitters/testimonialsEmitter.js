/**
 * Testimonials block emitter — ARION IL website builder.
 * --------------------------------------------------------------------------
 * Produces a testimonials section payload that elementorAdapter.js converts
 * into a stacked testimonial-card grid (1-2-3 column responsive).
 *
 * Output schema:
 *   {
 *     headline:    string  (3-8 words),
 *     subheadline: string  (0-2 sentences — always present as string, may be empty),
 *     testimonials: [
 *       {
 *         quote:       string  (1-3 sentences, ~15-50 words),
 *         attribution: string  (full name or first + last initial),
 *         role:        string  (job title + employer OR customer descriptor),
 *         rating:      integer 1-5
 *       }
 *     ]
 *   }
 *
 * Constraints:
 *   - 3 minimum, 5 maximum testimonials
 *   - Quotes must reference specific value props or services from brand context
 *     when present — never generic "Great service!" platitudes.
 *   - Attribution is realistic (first name + last initial fallback) — the founder
 *     replaces these with real customer quotes before publish, but the placeholder
 *     should READ as a real human, not "John Smith / Customer".
 *
 * Example 1 (industrial cleaning business — Cedar Rapids, IA):
 *   {
 *     "headline": "What plant managers say",
 *     "subheadline": "Real feedback from food and pharma facilities we clean overnight.",
 *     "testimonials": [
 *       {
 *         "quote": "Cedar Ridge has scrubbed our floors clean for two years running without a single missed shift. First-shift starts on a sanitized line every time.",
 *         "attribution": "Marcus T.",
 *         "role": "Plant Manager, Eastern Iowa Foods",
 *         "rating": 5
 *       },
 *       {
 *         "quote": "Their CIP rinse program caught a buildup our internal team missed. Saved us a full quality hold.",
 *         "attribution": "Janelle R.",
 *         "role": "QA Director, mid-market pharma facility",
 *         "rating": 5
 *       },
 *       {
 *         "quote": "Reliable, quiet, and clean — exactly what overnight janitorial should be.",
 *         "attribution": "David K.",
 *         "role": "Operations Lead, Cedar Rapids distribution center",
 *         "rating": 5
 *       }
 *     ]
 *   }
 *
 * Example 2 (boutique accounting firm):
 *   {
 *     "headline": "Clients who finally enjoy quarter-end",
 *     "subheadline": "",
 *     "testimonials": [
 *       {
 *         "quote": "I went from dreading Q1 to barely noticing it. They handle the books, I run the agency.",
 *         "attribution": "Priya S.",
 *         "role": "Founder, boutique creative agency",
 *         "rating": 5
 *       },
 *       {
 *         "quote": "Sharper numbers, fewer surprises. Exactly what they promised.",
 *         "attribution": "Tom L.",
 *         "role": "Owner, regional HVAC contractor",
 *         "rating": 5
 *       },
 *       {
 *         "quote": "Their bookkeeping caught a vendor double-billing us $4,300 a month. Paid for itself in a quarter.",
 *         "attribution": "Renee A.",
 *         "role": "CFO, mid-size MSP",
 *         "rating": 5
 *       }
 *     ]
 *   }
 */

const SYSTEM_PROMPT = `You are the ARION IL testimonials-section copywriter for small-business websites.
You write realistic placeholder testimonials grounded in the business's actual services + audience.
You return ONLY a single valid JSON object — no markdown, no commentary, no code fences.
Every quote MUST reference a specific service, outcome, or audience trait — never vague praise like "Great service!" or "Highly recommend!".
You write in the requested brand voice while still sounding like a real customer voice (slightly less polished than marketing copy).`;

function buildUserPrompt({ brand, sectionContext }) {
  const ctx = sectionContext || {};
  const services = Array.isArray(brand.services) ? brand.services : [];
  const minCount = Number.isInteger(ctx.min_testimonials) ? ctx.min_testimonials : 3;
  const maxCount = Number.isInteger(ctx.max_testimonials) ? ctx.max_testimonials : 5;

  return `Write a testimonials section for THIS business.

BUSINESS CONTEXT:
- Business name: ${brand.business_name || '(unspecified)'}
- Industry: ${brand.industry || 'unspecified'}
- Description: ${brand.description || ''}
- Tagline: ${brand.tagline || ''}
- Target audience: ${brand.target_audience || ''}
- Services offered: ${services.join(' | ') || 'unspecified'}
- Brand voice: ${brand.brand_voice || 'professional'}
- Location: ${brand.location || ''}

SECTION OVERRIDES:
- Headline variant note: ${ctx.headline_variant || 'none'}
- Min testimonials: ${minCount}
- Max testimonials: ${maxCount}

OUTPUT — return ONLY this JSON object, no markdown:
{
  "headline":    "3-8 words for the testimonials section (e.g. 'What clients say')",
  "subheadline": "0-2 sentences — empty string if no good fit",
  "testimonials": [
    {
      "quote":       "1-3 sentences, ~15-50 words, references a specific service/outcome",
      "attribution": "First name + last initial (e.g. 'Marcus T.') — sounds like a real person",
      "role":        "Job title + employer descriptor (e.g. 'Plant Manager, Eastern Iowa Foods')",
      "rating":      5
    }
  ]
}

REQUIREMENTS:
- Generate ${minCount} to ${maxCount} testimonials.
- Every quote must reference one of the services listed, the target audience, or the location — NEVER generic praise.
- Vary the angle: speed, reliability, outcome, surprise/delight, problem-solved — don't repeat the same beat.
- Vary the length: short punchy quote + 1-2 longer story-style quotes.
- Attribution: realistic first name + last initial. Role: realistic title + business descriptor matching the target audience.
- Rating: integer 1-5. Default to 5 unless the section context asks for variance.
- No emojis. No quotes-within-quotes. No fake company URLs.
- Output MUST parse as JSON — no markdown wrapping.`;
}

function validateOutput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: { code: 'shape_error', message: 'testimonials output must be a non-array object' } };
  }
  if (typeof data.headline !== 'string' || !data.headline.trim()) {
    return { ok: false, error: { code: 'missing_headline', message: 'testimonials.headline required' } };
  }
  if (typeof data.subheadline !== 'string') {
    return { ok: false, error: { code: 'bad_subheadline', message: 'testimonials.subheadline must be string (may be empty)' } };
  }
  if (!Array.isArray(data.testimonials) || data.testimonials.length < 3) {
    return { ok: false, error: { code: 'too_few_testimonials', message: `testimonials must be array of at least 3, got ${Array.isArray(data.testimonials) ? data.testimonials.length : 'non-array'}` } };
  }
  if (data.testimonials.length > 5) {
    return { ok: false, error: { code: 'too_many_testimonials', message: `max 5 testimonials, got ${data.testimonials.length}` } };
  }

  const clean = [];
  for (let i = 0; i < data.testimonials.length; i += 1) {
    const t = data.testimonials[i];
    if (!t || typeof t !== 'object') {
      return { ok: false, error: { code: 'bad_testimonial_shape', message: `testimonials[${i}] must be an object` } };
    }
    if (typeof t.quote !== 'string' || !t.quote.trim()) {
      return { ok: false, error: { code: 'missing_quote', message: `testimonials[${i}].quote required` } };
    }
    if (typeof t.attribution !== 'string' || !t.attribution.trim()) {
      return { ok: false, error: { code: 'missing_attribution', message: `testimonials[${i}].attribution required` } };
    }
    if (typeof t.role !== 'string' || !t.role.trim()) {
      return { ok: false, error: { code: 'missing_role', message: `testimonials[${i}].role required` } };
    }
    // Rating: coerce to integer, clamp 1-5, default 5.
    let rating = Number(t.rating);
    if (!Number.isFinite(rating)) rating = 5;
    rating = Math.round(rating);
    if (rating < 1) rating = 1;
    if (rating > 5) rating = 5;

    // Soft length bounds for the quote.
    if (t.quote.length > 600) {
      return { ok: false, error: { code: 'quote_too_long', message: `testimonials[${i}].quote must be <=600 chars, got ${t.quote.length}` } };
    }

    clean.push({
      quote:       t.quote.trim(),
      attribution: t.attribution.trim(),
      role:        t.role.trim(),
      rating,
    });
  }

  return {
    ok: true,
    data: {
      headline:     data.headline.trim(),
      subheadline:  data.subheadline.trim(),
      testimonials: clean,
    },
  };
}

export function createTestimonialsEmitter(/* { anthropicClient } = {} */) {
  return {
    kind: 'testimonials',
    // Section library archetype mapping — see lib/websiteBuilder/sectionLibrary.js.
    archetype: 'testimonials',
    maxTokens: 1800,
    buildPrompts({ brand, sectionContext }) {
      return {
        system: SYSTEM_PROMPT,
        user:   buildUserPrompt({ brand, sectionContext }),
      };
    },
    validate: validateOutput,
    example: {
      headline: 'What plant managers say',
      subheadline: 'Real feedback from food and pharma facilities we clean overnight.',
      testimonials: [
        {
          quote: 'Cedar Ridge has scrubbed our floors clean for two years running without a single missed shift. First-shift starts on a sanitized line every time.',
          attribution: 'Marcus T.',
          role: 'Plant Manager, Eastern Iowa Foods',
          rating: 5,
        },
        {
          quote: 'Their CIP rinse program caught a buildup our internal team missed. Saved us a full quality hold.',
          attribution: 'Janelle R.',
          role: 'QA Director, mid-market pharma facility',
          rating: 5,
        },
        {
          quote: 'Reliable, quiet, and clean — exactly what overnight janitorial should be.',
          attribution: 'David K.',
          role: 'Operations Lead, Cedar Rapids distribution center',
          rating: 5,
        },
      ],
    },
  };
}

export const __test__ = { SYSTEM_PROMPT, buildUserPrompt, validateOutput };
