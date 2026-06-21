/**
 * CTA (call-to-action) block emitter — ARION IL website builder.
 * --------------------------------------------------------------------------
 * Produces a CTA banner section payload that elementorAdapter.js converts
 * into a full-width centered banner with one or two buttons.
 *
 * Output schema:
 *   {
 *     headline:            string  (4-10 words, punchy),
 *     subheadline:         string  (1-2 sentences, may be empty),
 *     primary_cta_text:    string  (2-5 words, action verb),
 *     primary_cta_href:    string  (tel:, mailto:, /booking, #contact, etc.),
 *     secondary_cta_text:  string|''  (optional — empty string when omitted),
 *     secondary_cta_href:  string|''  (optional — empty string when omitted),
 *     background_style:    'solid' | 'gradient' | 'image'
 *   }
 *
 * Heuristic the prompt applies:
 *   - Service-based business (cleaning, accounting, legal, trades, consulting) →
 *     primary CTA is a phone "tel:..." or "Book a call" with calendar link.
 *   - Commerce / e-commerce / retail → primary CTA is "Shop now" or "Browse"
 *     pointing at /shop or the homepage products section.
 *
 * Example 1 (industrial cleaning business):
 *   {
 *     "headline": "Ready for a spotless first shift?",
 *     "subheadline": "Tell us your facility size and we'll send a quote within one business day.",
 *     "primary_cta_text": "Get a free quote",
 *     "primary_cta_href": "#contact",
 *     "secondary_cta_text": "Call (319) 555-0142",
 *     "secondary_cta_href": "tel:+13195550142",
 *     "background_style": "gradient"
 *   }
 *
 * Example 2 (boutique e-commerce candle shop):
 *   {
 *     "headline": "Find your next favorite scent.",
 *     "subheadline": "Hand-poured in small batches in Portland — free shipping over $50.",
 *     "primary_cta_text": "Shop candles",
 *     "primary_cta_href": "/shop",
 *     "secondary_cta_text": "",
 *     "secondary_cta_href": "",
 *     "background_style": "image"
 *   }
 */

const BACKGROUND_STYLES = new Set(['solid', 'gradient', 'image']);

// Loose hint set — the prompt also gets the description, so the LLM has more
// signal than this list alone.
const COMMERCE_HINTS = [
  'ecommerce', 'e-commerce', 'retail', 'shop', 'store', 'boutique',
  'apparel', 'candle', 'jewelry', 'cosmetics', 'beauty', 'goods',
  'products', 'merchandise', 'marketplace',
];

function inferBusinessKind(brand) {
  const hay = [
    brand.industry || '',
    brand.description || '',
    brand.tagline || '',
    (brand.services || []).join(' '),
  ].join(' ').toLowerCase();
  for (const h of COMMERCE_HINTS) {
    if (hay.includes(h)) return 'commerce';
  }
  return 'service';
}

const SYSTEM_PROMPT = `You are the ARION IL CTA-section copywriter for small-business websites.
You write a punchy, conversion-oriented banner that closes the page with one clear next step.
You return ONLY a single valid JSON object — no markdown, no commentary, no code fences.
You pick the right CTA shape for the business kind:
 - service businesses → phone-call or booking-link primary, with an optional phone secondary
 - commerce businesses → "Shop / Browse" primary, secondary often empty
You NEVER write generic filler like "Get started today!" without grounding it in the business specifics.`;

function buildUserPrompt({ brand, sectionContext }) {
  const ctx = sectionContext || {};
  const kind = ctx.business_kind || inferBusinessKind(brand);
  const phone = brand.phone || ctx.phone || '';
  const bookingHref = ctx.booking_href || '#contact';
  const shopHref = ctx.shop_href || '/shop';

  return `Write a CTA section for THIS business.

BUSINESS CONTEXT:
- Business name: ${brand.business_name || '(unspecified)'}
- Industry: ${brand.industry || 'unspecified'}
- Description: ${brand.description || ''}
- Tagline: ${brand.tagline || ''}
- Target audience: ${brand.target_audience || ''}
- Services offered: ${(brand.services || []).join(' | ') || 'unspecified'}
- Brand voice: ${brand.brand_voice || 'professional'}
- Location: ${brand.location || ''}
- Phone (if available): ${phone || '(not provided)'}

INFERRED BUSINESS KIND: ${kind}
  - "service"   → primary CTA should drive a contact/booking action.
                  If a phone number is provided, secondary CTA is "Call <number>" with href "tel:+digits".
                  If no phone, leave secondary CTA empty strings.
  - "commerce"  → primary CTA should drive a shop/browse action pointing at "${shopHref}".
                  Secondary CTA usually empty unless there's an obvious "Learn more" angle.

SECTION OVERRIDES (optional):
- Preferred primary destination: ${ctx.primary_cta_href || (kind === 'commerce' ? shopHref : bookingHref)}
- Background style hint: ${ctx.background_style || 'auto — pick the best fit'}
- Variant note: ${ctx.variant_note || 'none'}

OUTPUT — return ONLY this JSON object, no markdown:
{
  "headline":           "4-10 words, punchy, references this business's value prop",
  "subheadline":        "1-2 sentences pitching the action — empty string if redundant with headline",
  "primary_cta_text":   "2-5 words, action verb (e.g. 'Get a free quote', 'Shop candles')",
  "primary_cta_href":   "destination URL — tel:/mailto:/#contact/relative path",
  "secondary_cta_text": "OPTIONAL — empty string '' if not needed",
  "secondary_cta_href": "OPTIONAL — empty string '' if not needed; tel: link if phone was provided",
  "background_style":   "one of: solid | gradient | image"
}

REQUIREMENTS:
- Headline must reference THIS business by name, audience, location, or specific value — never a generic CTA platitude.
- Write in the "${brand.brand_voice || 'professional'}" brand voice.
- No emojis. No trailing punctuation in CTA text.
- If you include a phone number, format href as "tel:+<digits-only>" (E.164 if possible).
- If no phone is available and the kind is "service", set both secondary fields to empty string "".
- Output MUST parse as JSON — no markdown wrapping.`;
}

function validateOutput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: { code: 'shape_error', message: 'cta output must be a non-array object' } };
  }
  const requiredStrings = ['headline', 'subheadline', 'primary_cta_text', 'primary_cta_href', 'background_style'];
  for (const f of requiredStrings) {
    if (typeof data[f] !== 'string') {
      return { ok: false, error: { code: 'missing_field', message: `cta output missing or wrong type: ${f}` } };
    }
  }
  if (!data.headline.trim()) {
    return { ok: false, error: { code: 'empty_headline', message: 'cta.headline must be non-empty' } };
  }
  if (!data.primary_cta_text.trim()) {
    return { ok: false, error: { code: 'empty_primary_cta_text', message: 'cta.primary_cta_text must be non-empty' } };
  }
  if (!data.primary_cta_href.trim()) {
    return { ok: false, error: { code: 'empty_primary_cta_href', message: 'cta.primary_cta_href must be non-empty' } };
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

  // Optional fields — accept missing/null/undefined and coerce to ''
  const secondaryText = typeof data.secondary_cta_text === 'string' ? data.secondary_cta_text.trim() : '';
  const secondaryHref = typeof data.secondary_cta_href === 'string' ? data.secondary_cta_href.trim() : '';

  // If one secondary field is set, the other should be too — coerce to consistent empty pair otherwise.
  let secText = secondaryText;
  let secHref = secondaryHref;
  if (!secText || !secHref) {
    secText = '';
    secHref = '';
  }

  // Soft length bounds.
  const headlineWords = data.headline.trim().split(/\s+/);
  if (headlineWords.length < 2 || headlineWords.length > 20) {
    return {
      ok: false,
      error: { code: 'headline_length', message: `headline must be 2-20 words, got ${headlineWords.length}` },
    };
  }
  if (data.subheadline.length > 400) {
    return {
      ok: false,
      error: { code: 'subheadline_length', message: `subheadline must be <=400 chars, got ${data.subheadline.length}` },
    };
  }

  return {
    ok: true,
    data: {
      headline:           data.headline.trim(),
      subheadline:        data.subheadline.trim(),
      primary_cta_text:   data.primary_cta_text.trim().replace(/[.!?]+$/, ''),
      primary_cta_href:   data.primary_cta_href.trim(),
      secondary_cta_text: secText.replace(/[.!?]+$/, ''),
      secondary_cta_href: secHref,
      background_style:   data.background_style,
    },
  };
}

export function createCtaEmitter(/* { anthropicClient } = {} */) {
  return {
    kind: 'cta',
    // Section library archetype mapping — see lib/websiteBuilder/sectionLibrary.js.
    archetype: 'cta',
    maxTokens: 600,
    buildPrompts({ brand, sectionContext }) {
      return {
        system: SYSTEM_PROMPT,
        user:   buildUserPrompt({ brand, sectionContext }),
      };
    },
    validate: validateOutput,
    example: {
      headline: 'Ready for a spotless first shift?',
      subheadline: "Tell us your facility size and we'll send a quote within one business day.",
      primary_cta_text: 'Get a free quote',
      primary_cta_href: '#contact',
      secondary_cta_text: 'Call (319) 555-0142',
      secondary_cta_href: 'tel:+13195550142',
      background_style: 'gradient',
    },
  };
}

export const __test__ = { SYSTEM_PROMPT, buildUserPrompt, validateOutput, inferBusinessKind, COMMERCE_HINTS, BACKGROUND_STYLES };
