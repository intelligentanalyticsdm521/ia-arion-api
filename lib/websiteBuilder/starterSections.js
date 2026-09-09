/**
 * Starter sections — what a freshly added section says before the client has
 * typed anything.
 * ---------------------------------------------------------------------------
 * The emitters ship `example` payloads, but those are written for a fictional
 * Iowa cleaning firm. Dropping one of those onto a real customer's page would
 * publish somebody else's story, so "add a section" uses THESE instead:
 * neutral prompts, filled from the business's own brand context wherever the
 * business has actually told us something.
 *
 * No IL call, no credits — adding a section costs nothing (W-4). Writing the
 * copy FOR you is the AI action, and that is Phase 1B.
 */

import crypto from 'node:crypto';
import { blockToElementorSection } from './elementorAdapter.js';
import { sectionKindMeta } from './sectionSchema.js';

function firstService(brand, i) {
  const list = Array.isArray(brand?.services) ? brand.services : [];
  const raw = list[i];
  if (!raw) return null;
  if (typeof raw === 'string') return { title: raw, description: '' };
  return { title: raw.name || raw.title || '', description: raw.description || '' };
}

function businessName(brand) {
  return String(brand?.business_name || '').trim() || 'our business';
}

/**
 * Where a new section's main button points, and what it says.
 *
 * A business with an online booking page gets "Book online" pointing at it —
 * that is the whole reason B5 put `booking_href` on brand context. Everyone
 * else gets the contact anchor, exactly as before. The client can change both
 * in the edit sheet; this is only what it starts as.
 */
function starterCta(brand) {
  const href = String(brand?.booking_href || '').trim();
  return href
    ? { text: 'Book online', href }
    : { text: 'Get in touch', href: '#contact' };
}

const STARTERS = {
  hero: (brand) => ({
    headline: brand?.tagline || `Welcome to ${businessName(brand)}`,
    subheadline: brand?.description || 'Say in one line what you do and who you do it for.',
    cta_text: starterCta(brand).text,
    cta_href: starterCta(brand).href,
    background_style: 'solid',
  }),

  services: (brand) => {
    const picked = [0, 1, 2].map((i) => firstService(brand, i)).filter(Boolean);
    const services = (picked.length ? picked : [
      { title: 'First service', description: 'What it is and why somebody would want it.' },
      { title: 'Second service', description: 'What it is and why somebody would want it.' },
      { title: 'Third service', description: 'What it is and why somebody would want it.' },
    ]).map((s) => ({
      title: s.title || 'Service',
      description: s.description || 'What it is and why somebody would want it.',
      icon_name: 'check',
    }));
    return { headline: 'What we do', subheadline: '', services };
  },

  testimonials: () => ({
    headline: 'What our customers say',
    subheadline: '',
    testimonials: [
      { quote: 'What they said', attribution: 'Who said it', role: 'Their job or company', rating: 5 },
    ],
  }),

  cta: (brand) => ({
    headline: 'Ready to get started?',
    subheadline: `Tell us what you need and ${businessName(brand)} will come back to you.`,
    primary_cta_text: starterCta(brand).text,
    primary_cta_href: starterCta(brand).href,
    secondary_cta_text: '',
    secondary_cta_href: '',
    background_style: 'gradient',
  }),

  about: (brand) => ({
    headline: `About ${businessName(brand)}`,
    subheadline: brand?.tagline || '',
    story_paragraphs: [
      brand?.description || 'How the business started, and why.',
      'What you do today, and who for.',
    ],
    values: [
      { title: 'What we stand for', description: 'One thing you will not compromise on.' },
    ],
    image_alt: '',
  }),

  faq: () => ({
    headline: 'Questions we get asked',
    subheadline: '',
    faqs: [
      { question: 'A question customers keep asking', answer: 'Your answer.' },
    ],
  }),

  gallery: () => ({
    headline: 'Our work',
    subheadline: '',
    images: [],
  }),

  // ARION pack 2. `brand.service_prices` is the business's OWN services and
  // prices, loaded through lib/websiteBuilder/servicePricing.js - the same
  // catalogue the booking page and the invoices read. A new pricing section
  // therefore arrives with the real prices already on it, and nobody types a
  // price twice. A business with no price list gets prompts, never an
  // invented number (memory: feedback_no_fabricated_catalog).
  pricing: (brand) => {
    const all = Array.isArray(brand?.service_prices) ? brand.service_prices : [];
    // The services that HAVE a price come first. A pricing section whose top
    // card is blank - because the business's first service happens to be
    // quoted rather than priced - is the wrong first impression of a feature
    // whose whole point is showing prices. Order is otherwise untouched, so a
    // business that prices everything sees its own order.
    const priced = [
      ...all.filter((s) => String(s?.price || '').trim() !== ''),
      ...all.filter((s) => String(s?.price || '').trim() === ''),
    ];
    const cta = starterCta(brand);
    const plans = priced.slice(0, 3).map((s) => ({
      name: s.name || 'Package',
      price: s.price || '',
      period: s.period || '',
      summary: s.description || '',
      features: Array.isArray(s.features) ? s.features : [],
      cta_text: cta.text,
      cta_href: cta.href,
      offering_id: s.offering_id || '',
    }));
    return {
      headline: 'What it costs',
      subheadline: '',
      plans: plans.length ? plans : [
        {
          name: 'First package',
          price: '',
          period: '',
          summary: 'What somebody gets for this, in one line.',
          features: ['The first thing it includes'],
          cta_text: cta.text,
          cta_href: cta.href,
          offering_id: '',
        },
      ],
    };
  },

  team: (brand) => ({
    headline: `The people at ${businessName(brand)}`,
    subheadline: '',
    members: [
      { name: 'Name', role: 'Role', photo_url: '', photo_alt: '', photo_id: '' },
    ],
  }),

  stats: () => ({
    headline: 'By the numbers',
    subheadline: '',
    stats: [
      { value: '', prefix: '', suffix: '', label: 'What this counts' },
    ],
  }),

  contact: (brand) => ({
    headline: 'Get in touch',
    subheadline: '',
    contact_methods: brand?.email
      ? [{ kind: 'email', label: 'Email', value: brand.email, href: `mailto:${brand.email}` }]
      : [],
    form_config: {
      fields: ['Name', 'Email', 'Phone', 'Message'],
      submit_text: 'Send',
    },
    form_purpose: 'lead',
  }),
};

/** The block payload a freshly added section starts life with. */
export function starterBlock(kind, brand = {}) {
  const make = STARTERS[String(kind || '').toLowerCase()];
  return make ? make(brand) : null;
}

/**
 * Build the Elementor node for a section the client just added.
 *
 * @returns {{ ok:true, node:object, kind:string } | { ok:false, code:string, message:string }}
 */
export function buildStarterSection(kind, brand = {}) {
  const meta = sectionKindMeta(kind);
  if (!meta) return { ok: false, code: 'unknown_kind', message: `We do not have a section called "${kind}".` };

  const block = starterBlock(kind, brand);
  if (!block) return { ok: false, code: 'unknown_kind', message: `We do not have a section called "${kind}".` };

  const blockId = crypto.randomUUID();
  let node;
  try {
    node = blockToElementorSection({
      kind, block, brand, seedId: `add-${blockId}`, blockId,
    });
  } catch (err) {
    // The contact adapter REFUSES to build a form it cannot address, and that
    // refusal has to reach the client as words, not a 500.
    return {
      ok: false,
      code: err?.code || 'section_build_failed',
      message: err?.message || 'That section could not be built.',
    };
  }
  if (!node) return { ok: false, code: 'unknown_kind', message: `We do not have a section called "${kind}".` };
  return { ok: true, node, kind, blockId };
}

export const __test__ = { STARTERS };
