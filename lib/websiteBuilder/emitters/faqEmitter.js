/**
 * FAQ block emitter — ARION IL website builder.
 * --------------------------------------------------------------------------
 * Produces an FAQ section payload that elementorAdapter.js converts into
 * a single-column accordion (using Elementor's accordion widget).
 *
 * Output schema:
 *   {
 *     headline:    string  (2-6 words — e.g. "FAQ" / "Common questions"),
 *     subheadline: string  (0-2 sentences, may be empty),
 *     faqs: [
 *       { question: string (5-20 words, real customer phrasing),
 *         answer:   string (1-4 sentences, direct + specific) }
 *     ]  (6-8 entries)
 *   }
 *
 * Question topic coverage the prompt asks for:
 *   - Pricing / cost / quote process
 *   - Scheduling / lead time / availability
 *   - Service area / locations served
 *   - What's included / scope / deliverables
 *   - Onboarding / first steps / what to expect
 *   - Guarantees / refunds / cancellation
 *   - Industry-specific concern (cleaning: chemicals + safety; accounting: tax filing scope; etc.)
 *   - Anything special the business does differently
 *
 * Example 1 (industrial cleaning business):
 *   {
 *     "headline": "Common questions",
 *     "subheadline": "Quick answers from facility managers we work with most.",
 *     "faqs": [
 *       { "question": "How quickly can you start on a new facility?", "answer": "Most contracts begin within two weeks. Larger plants requiring chemical and safety walkthroughs can take three to four." },
 *       { "question": "Do you handle food-grade or pharma compliance?", "answer": "Yes. Every supervisor is FSMA- and GMP-trained, and we provide quarterly compliance documentation as part of every contract." },
 *       { "question": "What does a typical quote look like?", "answer": "Free, on-site, within one business day of your request. We don't quote sight-unseen — too easy to miss something that matters." },
 *       { "question": "What's your service area?", "answer": "We work across Eastern Iowa: Cedar Rapids, Iowa City, the Quad Cities, and anything in between. Larger contracts further out are case-by-case." },
 *       { "question": "Do you bring your own equipment and chemicals?", "answer": "Yes. Our crews bring everything — and the chemicals are food-safe by default unless your facility specifies otherwise." },
 *       { "question": "Are your crews insured and bonded?", "answer": "Yes. $2M general liability and full workers' comp on every crew member. Certificates are sent before the first shift." },
 *       { "question": "What happens if a shift is missed?", "answer": "It doesn't happen. We carry a backup crew. If it ever did, the next shift would be on us." }
 *     ]
 *   }
 *
 * Example 2 (boutique accounting firm):
 *   {
 *     "headline": "FAQ",
 *     "subheadline": "",
 *     "faqs": [
 *       { "question": "What does an engagement cost?", "answer": "Flat monthly fees starting around $500 for solo founders, scaling with revenue and complexity. We quote firm numbers after a 30-minute call." },
 *       { "question": "Do you file my taxes too?", "answer": "Yes. Federal and state, business and personal. It's included in every Standard and above tier." },
 *       { "question": "What software do you use?", "answer": "QuickBooks Online for most clients. Xero if you're already on it. We migrate at no charge during onboarding." },
 *       { "question": "How fast is onboarding?", "answer": "Two weeks from signed engagement to first clean monthly close. Faster if your books are already in decent shape." },
 *       { "question": "Can I cancel anytime?", "answer": "Month-to-month after a 90-day onboarding commitment. No long-term lock-in." },
 *       { "question": "Do you serve businesses outside our state?", "answer": "Yes — we serve clients in 18 states. Multi-state payroll and sales tax are part of our standard scope." }
 *     ]
 *   }
 */

const SYSTEM_PROMPT = `You are the ARION IL FAQ-section copywriter for small-business websites.
You write the questions REAL customers actually ask — in their words, not corporate phrasing.
You return ONLY a single valid JSON object — no markdown, no commentary, no code fences.
You ground every answer in this business's specific industry, audience, services, and location.
You write tight, direct answers: 1-4 sentences. No padding, no "thank you for asking", no "we're delighted to share".`;

function buildUserPrompt({ brand, sectionContext }) {
  const ctx = sectionContext || {};
  const minFaqs = Number.isInteger(ctx.min_faqs) ? ctx.min_faqs : 6;
  const maxFaqs = Number.isInteger(ctx.max_faqs) ? ctx.max_faqs : 8;

  return `Write an FAQ section for THIS business.

BUSINESS CONTEXT:
- Business name: ${brand.business_name || '(unspecified)'}
- Industry: ${brand.industry || 'unspecified'}
- Description: ${brand.description || ''}
- Tagline: ${brand.tagline || ''}
- Target audience: ${brand.target_audience || ''}
- Services offered: ${(brand.services || []).join(' | ') || 'unspecified'}
- Brand voice: ${brand.brand_voice || 'professional'}
- Location: ${brand.location || ''}

SECTION OVERRIDES:
- Min FAQs: ${minFaqs}
- Max FAQs: ${maxFaqs}
- Special focus topic (optional): ${ctx.focus_topic || 'none'}

OUTPUT — return ONLY this JSON object, no markdown:
{
  "headline":    "2-6 words (e.g. 'FAQ', 'Common questions', 'Before you book')",
  "subheadline": "0-2 sentences — empty string if no good fit",
  "faqs": [
    { "question": "5-20 words in real customer phrasing", "answer": "1-4 sentences, direct + specific to this business" }
  ]
}

REQUIRED TOPIC COVERAGE — include AT LEAST one question for each that applies to this business:
  1. Pricing / cost / quote process
  2. Scheduling / lead time / availability / onboarding speed
  3. Service area or locations served
  4. What's included in the service / scope
  5. An industry-specific concern (compliance, materials, software, certifications, etc.)
  6. A guarantee, cancellation policy, or "what if it goes wrong" question
  7. (Optional) Anything specifically positioned in the description or tagline

REQUIREMENTS:
- ${minFaqs} to ${maxFaqs} FAQs.
- Questions in CUSTOMER voice — "How much does it cost?" not "What are your pricing tiers?".
- Answers grounded in THIS business's services, location, target audience.
- Write in the "${brand.brand_voice || 'professional'}" brand voice for the answers.
- No emojis. No "Great question!" preamble. No marketing fluff in the answers.
- Output MUST parse as JSON — no markdown wrapping.`;
}

function validateOutput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: { code: 'shape_error', message: 'faq output must be a non-array object' } };
  }
  if (typeof data.headline !== 'string' || !data.headline.trim()) {
    return { ok: false, error: { code: 'missing_headline', message: 'faq.headline required' } };
  }
  if (typeof data.subheadline !== 'string') {
    return { ok: false, error: { code: 'bad_subheadline', message: 'faq.subheadline must be string (may be empty)' } };
  }
  if (!Array.isArray(data.faqs) || data.faqs.length < 6) {
    return {
      ok: false,
      error: { code: 'too_few_faqs', message: `faq.faqs must be array of at least 6, got ${Array.isArray(data.faqs) ? data.faqs.length : 'non-array'}` },
    };
  }
  if (data.faqs.length > 8) {
    return { ok: false, error: { code: 'too_many_faqs', message: `faq.faqs max 8, got ${data.faqs.length}` } };
  }

  const clean = [];
  for (let i = 0; i < data.faqs.length; i += 1) {
    const f = data.faqs[i];
    if (!f || typeof f !== 'object') {
      return { ok: false, error: { code: 'bad_faq_shape', message: `faq.faqs[${i}] must be an object` } };
    }
    if (typeof f.question !== 'string' || !f.question.trim()) {
      return { ok: false, error: { code: 'missing_question', message: `faq.faqs[${i}].question required` } };
    }
    if (typeof f.answer !== 'string' || !f.answer.trim()) {
      return { ok: false, error: { code: 'missing_answer', message: `faq.faqs[${i}].answer required` } };
    }
    if (f.question.length > 300) {
      return { ok: false, error: { code: 'question_too_long', message: `faq.faqs[${i}].question must be <=300 chars, got ${f.question.length}` } };
    }
    if (f.answer.length > 1000) {
      return { ok: false, error: { code: 'answer_too_long', message: `faq.faqs[${i}].answer must be <=1000 chars, got ${f.answer.length}` } };
    }
    clean.push({ question: f.question.trim(), answer: f.answer.trim() });
  }

  return {
    ok: true,
    data: {
      headline:    data.headline.trim(),
      subheadline: data.subheadline.trim(),
      faqs:        clean,
    },
  };
}

export function createFaqEmitter(/* { anthropicClient } = {} */) {
  return {
    kind: 'faq',
    maxTokens: 2500,
    buildPrompts({ brand, sectionContext }) {
      return {
        system: SYSTEM_PROMPT,
        user:   buildUserPrompt({ brand, sectionContext }),
      };
    },
    validate: validateOutput,
    example: {
      headline: 'Common questions',
      subheadline: 'Quick answers from facility managers we work with most.',
      faqs: [
        { question: 'How quickly can you start on a new facility?', answer: 'Most contracts begin within two weeks. Larger plants requiring chemical and safety walkthroughs can take three to four.' },
        { question: 'Do you handle food-grade or pharma compliance?', answer: 'Yes. Every supervisor is FSMA- and GMP-trained, and we provide quarterly compliance documentation as part of every contract.' },
        { question: 'What does a typical quote look like?', answer: "Free, on-site, within one business day of your request. We don't quote sight-unseen — too easy to miss something that matters." },
        { question: "What's your service area?", answer: 'We work across Eastern Iowa: Cedar Rapids, Iowa City, the Quad Cities, and anything in between. Larger contracts further out are case-by-case.' },
        { question: 'Do you bring your own equipment and chemicals?', answer: 'Yes. Our crews bring everything — and the chemicals are food-safe by default unless your facility specifies otherwise.' },
        { question: 'Are your crews insured and bonded?', answer: "Yes. $2M general liability and full workers' comp on every crew member. Certificates are sent before the first shift." },
        { question: 'What happens if a shift is missed?', answer: "It doesn't happen. We carry a backup crew. If it ever did, the next shift would be on us." },
      ],
    },
  };
}

export const __test__ = { SYSTEM_PROMPT, buildUserPrompt, validateOutput };
