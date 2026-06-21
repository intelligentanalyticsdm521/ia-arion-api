/**
 * About block emitter — ARION IL website builder.
 * --------------------------------------------------------------------------
 * Produces an about-section payload that elementorAdapter.js converts into
 * a two-column layout (image + story) plus a values grid below.
 *
 * Output schema:
 *   {
 *     headline:    string  (3-8 words — e.g. "Our story" / "Why we started"),
 *     subheadline: string  (0-2 sentences, may be empty),
 *     story_paragraphs: string[3-4]  (each 2-4 sentences, warm + first-person voice),
 *     values: [
 *       { title: string (1-3 words), description: string (1-2 sentences) }
 *     ]  (3-5 values),
 *     image_alt: string  (5-15 words describing the about image semantics)
 *   }
 *
 * Voice notes (echoed in the prompt):
 *   - First-person plural ("we") preferred unless brand voice says otherwise.
 *   - Avoid corporate-speak: "synergies," "best-in-class," "world-class."
 *   - Lean on founding moment, customer outcome, mission — concrete, not abstract.
 *
 * Example 1 (industrial cleaning business):
 *   {
 *     "headline": "Why we started Cedar Ridge",
 *     "subheadline": "Industrial cleaning shouldn't mean missed shifts and surprise invoices.",
 *     "story_paragraphs": [
 *       "We launched Cedar Ridge in 2018 after a decade running overnight crews at the largest food plant in Iowa. We'd seen too many vendors over-promise on paper and under-deliver at 2 a.m. We knew we could do better.",
 *       "Today, we clean for food-grade and pharma manufacturers across Eastern Iowa — most of them on multi-year contracts. We win the work the same way every time: we show up, we do what we said, and first shift starts on a clean line.",
 *       "We're family-owned, locally crewed, and proud of both. Every supervisor on our roster came up through our own ranks."
 *     ],
 *     "values": [
 *       { "title": "Show up", "description": "Every shift, every contract. Reliability is the table stakes — we treat it like the whole game." },
 *       { "title": "Sanitize, don't theatre", "description": "We measure outcomes, not effort. If a step doesn't make the plant cleaner, we drop it." },
 *       { "title": "Train our own", "description": "Our supervisors are promoted from the line, never imported. It's how we keep standards stable." }
 *     ],
 *     "image_alt": "Cedar Ridge night-shift supervisor inspecting a sanitized production floor"
 *   }
 *
 * Example 2 (boutique accounting firm):
 *   {
 *     "headline": "Built for service businesses",
 *     "subheadline": "We left big-firm accounting to do this our way — and we haven't looked back.",
 *     "story_paragraphs": [
 *       "Our founder spent twelve years in mid-market public accounting before opening this firm. The takeaway: service businesses get talked down to and over-billed by the big shops. We knew there was room for a boutique that did the opposite.",
 *       "We work with around forty clients at a time — agencies, contractors, MSPs, healthcare practices. Small enough to know your business, big enough to be there when your CFO leaves.",
 *       "Every engagement starts with a conversation, never a sales pitch. If we're not the right fit, we'll tell you."
 *     ],
 *     "values": [
 *       { "title": "Plain English", "description": "We translate accounting into language a founder can act on. No jargon tax." },
 *       { "title": "No surprises", "description": "Flat-fee engagements, monthly check-ins, and quarter-end without panic." },
 *       { "title": "Long horizons", "description": "Half our clients have been with us five years or more. We build for that." }
 *     ],
 *     "image_alt": "Boutique accounting team meeting with a small-business owner over coffee"
 *   }
 */

const SYSTEM_PROMPT = `You are the ARION IL about-section copywriter for small-business websites.
You write a warm, first-person brand story that emphasizes founding moment, mission, and values.
You return ONLY a single valid JSON object — no markdown, no commentary, no code fences.
You write in the requested brand voice.
You NEVER use corporate-speak: no "synergies", no "best-in-class", no "world-class", no "leverage", no "your business" filler.
Every paragraph must reference THIS specific business: name, services, audience, location, or founding story.`;

function buildUserPrompt({ brand, sectionContext }) {
  const ctx = sectionContext || {};
  const minPara = Number.isInteger(ctx.min_paragraphs) ? ctx.min_paragraphs : 3;
  const maxPara = Number.isInteger(ctx.max_paragraphs) ? ctx.max_paragraphs : 4;
  const minValues = Number.isInteger(ctx.min_values) ? ctx.min_values : 3;
  const maxValues = Number.isInteger(ctx.max_values) ? ctx.max_values : 5;

  return `Write an about section for THIS business.

BUSINESS CONTEXT:
- Business name: ${brand.business_name || '(unspecified)'}
- Industry: ${brand.industry || 'unspecified'}
- Description: ${brand.description || ''}
- Tagline: ${brand.tagline || ''}
- Target audience: ${brand.target_audience || ''}
- Services offered: ${(brand.services || []).join(' | ') || 'unspecified'}
- Brand voice: ${brand.brand_voice || 'professional'}
- Location: ${brand.location || ''}
- Founder / origin notes (if any): ${ctx.origin_notes || brand.origin || '(none)'}
- Founded year (if known): ${ctx.founded_year || brand.founded_year || '(unknown)'}

SECTION OVERRIDES:
- Voice intensification: ${ctx.voice_intensify || 'none'}
- Story paragraphs: ${minPara}-${maxPara}
- Values count: ${minValues}-${maxValues}

OUTPUT — return ONLY this JSON object, no markdown:
{
  "headline":    "3-8 words (e.g. 'Our story', 'Why we started', 'Built for ___')",
  "subheadline": "0-2 sentences — empty string if no good fit",
  "story_paragraphs": [
    "Paragraph 1 — founding moment / origin",
    "Paragraph 2 — what we do now / who we serve",
    "Paragraph 3 — what makes us different OR mission"
  ],
  "values": [
    { "title": "1-3 word value name", "description": "1-2 sentences explaining what it means in practice" }
  ],
  "image_alt": "5-15 words describing what the about image should depict — semantic, not literal"
}

REQUIREMENTS:
- ${minPara} to ${maxPara} story paragraphs, each 2-4 sentences. Warm, first-person ('we'), specific.
- ${minValues} to ${maxValues} values. Titles must be punchy and memorable, not corporate-speak.
- Reference THIS business by name at least once in the story.
- Match the "${brand.brand_voice || 'professional'}" brand voice — confident but not boastful, warm but not saccharine.
- No emojis. No "your business" filler. No fake stats ("12,000 happy customers!") unless the brand context provided them.
- Output MUST parse as JSON — no markdown wrapping.`;
}

function validateOutput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: { code: 'shape_error', message: 'about output must be a non-array object' } };
  }
  if (typeof data.headline !== 'string' || !data.headline.trim()) {
    return { ok: false, error: { code: 'missing_headline', message: 'about.headline required' } };
  }
  if (typeof data.subheadline !== 'string') {
    return { ok: false, error: { code: 'bad_subheadline', message: 'about.subheadline must be string (may be empty)' } };
  }
  if (!Array.isArray(data.story_paragraphs) || data.story_paragraphs.length < 3) {
    return {
      ok: false,
      error: { code: 'too_few_paragraphs', message: `about.story_paragraphs must be array of at least 3, got ${Array.isArray(data.story_paragraphs) ? data.story_paragraphs.length : 'non-array'}` },
    };
  }
  if (data.story_paragraphs.length > 4) {
    return {
      ok: false,
      error: { code: 'too_many_paragraphs', message: `about.story_paragraphs max 4, got ${data.story_paragraphs.length}` },
    };
  }
  const cleanParagraphs = [];
  for (let i = 0; i < data.story_paragraphs.length; i += 1) {
    const p = data.story_paragraphs[i];
    if (typeof p !== 'string' || !p.trim()) {
      return { ok: false, error: { code: 'empty_paragraph', message: `about.story_paragraphs[${i}] must be a non-empty string` } };
    }
    if (p.length > 1000) {
      return { ok: false, error: { code: 'paragraph_too_long', message: `about.story_paragraphs[${i}] must be <=1000 chars, got ${p.length}` } };
    }
    cleanParagraphs.push(p.trim());
  }

  if (!Array.isArray(data.values) || data.values.length < 3) {
    return {
      ok: false,
      error: { code: 'too_few_values', message: `about.values must be array of at least 3, got ${Array.isArray(data.values) ? data.values.length : 'non-array'}` },
    };
  }
  if (data.values.length > 5) {
    return { ok: false, error: { code: 'too_many_values', message: `about.values max 5, got ${data.values.length}` } };
  }
  const cleanValues = [];
  for (let i = 0; i < data.values.length; i += 1) {
    const v = data.values[i];
    if (!v || typeof v !== 'object') {
      return { ok: false, error: { code: 'bad_value_shape', message: `about.values[${i}] must be an object` } };
    }
    if (typeof v.title !== 'string' || !v.title.trim()) {
      return { ok: false, error: { code: 'missing_value_title', message: `about.values[${i}].title required` } };
    }
    if (typeof v.description !== 'string' || !v.description.trim()) {
      return { ok: false, error: { code: 'missing_value_description', message: `about.values[${i}].description required` } };
    }
    cleanValues.push({ title: v.title.trim(), description: v.description.trim() });
  }

  if (typeof data.image_alt !== 'string' || !data.image_alt.trim()) {
    return { ok: false, error: { code: 'missing_image_alt', message: 'about.image_alt required' } };
  }

  return {
    ok: true,
    data: {
      headline:         data.headline.trim(),
      subheadline:      data.subheadline.trim(),
      story_paragraphs: cleanParagraphs,
      values:           cleanValues,
      image_alt:        data.image_alt.trim(),
    },
  };
}

export function createAboutEmitter(/* { anthropicClient } = {} */) {
  return {
    kind: 'about',
    // Section library archetype mapping — see lib/websiteBuilder/sectionLibrary.js.
    archetype: 'about',
    maxTokens: 2200,
    buildPrompts({ brand, sectionContext }) {
      return {
        system: SYSTEM_PROMPT,
        user:   buildUserPrompt({ brand, sectionContext }),
      };
    },
    validate: validateOutput,
    example: {
      headline: 'Why we started Cedar Ridge',
      subheadline: "Industrial cleaning shouldn't mean missed shifts and surprise invoices.",
      story_paragraphs: [
        "We launched Cedar Ridge in 2018 after a decade running overnight crews at the largest food plant in Iowa. We'd seen too many vendors over-promise on paper and under-deliver at 2 a.m. We knew we could do better.",
        "Today, we clean for food-grade and pharma manufacturers across Eastern Iowa — most of them on multi-year contracts. We win the work the same way every time: we show up, we do what we said, and first shift starts on a clean line.",
        "We're family-owned, locally crewed, and proud of both. Every supervisor on our roster came up through our own ranks.",
      ],
      values: [
        { title: 'Show up', description: 'Every shift, every contract. Reliability is the table stakes — we treat it like the whole game.' },
        { title: "Sanitize, don't theatre", description: "We measure outcomes, not effort. If a step doesn't make the plant cleaner, we drop it." },
        { title: 'Train our own', description: "Our supervisors are promoted from the line, never imported. It's how we keep standards stable." },
      ],
      image_alt: 'Cedar Ridge night-shift supervisor inspecting a sanitized production floor',
    },
  };
}

export const __test__ = { SYSTEM_PROMPT, buildUserPrompt, validateOutput };
