/**
 * Contact block emitter — ARION IL website builder.
 * --------------------------------------------------------------------------
 * Produces a contact section payload that elementorAdapter.js converts into
 * a two-column section: contact methods on the left, a form on the right.
 *
 * Output schema:
 *   {
 *     headline:    string  (3-8 words),
 *     subheadline: string  (0-2 sentences, may be empty),
 *     contact_methods: [
 *       {
 *         kind:   'phone' | 'email' | 'address' | 'social',
 *         label:  string  (1-4 words — e.g. "Call us", "LinkedIn"),
 *         value:  string  (display value — e.g. "(319) 555-0142", "@cedarridgeplant"),
 *         href:   string  (clickable URL — tel:, mailto:, geo:, https:)
 *       }
 *     ]  (1-6 methods),
 *     form_config: {
 *       fields:       string[]  (1-8 field labels, e.g. "Name", "Email", "Service Needed"),
 *       submit_text:  string    (2-5 words — e.g. "Send message", "Request a quote")
 *     }
 *   }
 *
 * Heuristic the prompt applies:
 *   - Form fields tuned to service type:
 *       • plumber / trades   → Name, Phone, Service Needed, Best Time to Call
 *       • restaurant         → Name, Email, Date, Party Size, Notes
 *       • accountant / B2B   → Name, Email, Company, Annual Revenue, Message
 *       • e-commerce         → Name, Email, Order Number, Message
 *   - Social methods inferred from industry:
 *       • B2B / consulting   → LinkedIn (primary), Twitter/X
 *       • restaurant / retail → Instagram, Facebook
 *       • trades             → Facebook, Google Business
 *
 * Example 1 (industrial cleaning business):
 *   {
 *     "headline": "Get a quote within one business day",
 *     "subheadline": "Tell us a little about the facility and we'll be in touch.",
 *     "contact_methods": [
 *       { "kind": "phone",   "label": "Call us",      "value": "(319) 555-0142",                       "href": "tel:+13195550142" },
 *       { "kind": "email",   "label": "Email",        "value": "quotes@cedarridgeplant.com",           "href": "mailto:quotes@cedarridgeplant.com" },
 *       { "kind": "address", "label": "Office",       "value": "115 16th Ave SW, Cedar Rapids, IA",    "href": "https://maps.google.com/?q=115+16th+Ave+SW+Cedar+Rapids+IA" },
 *       { "kind": "social",  "label": "LinkedIn",     "value": "@cedarridgeplant",                     "href": "https://www.linkedin.com/company/cedarridgeplant" }
 *     ],
 *     "form_config": {
 *       "fields": ["Name", "Company", "Phone", "Facility Type", "Square Footage", "Notes"],
 *       "submit_text": "Request a quote"
 *     }
 *   }
 *
 * Example 2 (neighborhood restaurant):
 *   {
 *     "headline": "Book a table or say hello",
 *     "subheadline": "",
 *     "contact_methods": [
 *       { "kind": "phone",   "label": "Reservations", "value": "(503) 555-0188",                       "href": "tel:+15035550188" },
 *       { "kind": "address", "label": "Find us",      "value": "417 SE Belmont, Portland, OR",         "href": "https://maps.google.com/?q=417+SE+Belmont+Portland+OR" },
 *       { "kind": "social",  "label": "Instagram",    "value": "@belmonttable",                        "href": "https://instagram.com/belmonttable" },
 *       { "kind": "social",  "label": "Facebook",     "value": "Belmont Table",                        "href": "https://facebook.com/belmonttable" }
 *     ],
 *     "form_config": {
 *       "fields": ["Name", "Email", "Date", "Time", "Party Size", "Notes"],
 *       "submit_text": "Send request"
 *     }
 *   }
 */

const METHOD_KINDS = new Set(['phone', 'email', 'address', 'social']);

// Loose hint sets used to pick sensible default form fields when the prompt
// pre-bakes context. The LLM still picks the final list — this is just signal.
const SERVICE_TRADES_HINTS = [
  'plumb', 'electric', 'hvac', 'roof', 'landscap', 'lawn', 'pest',
  'carpet', 'cleaning', 'janitor', 'painter', 'mechanic', 'auto',
  'contractor', 'handyman', 'mover', 'locksmith', 'tow', 'tree',
];
const RESTAURANT_HINTS = [
  'restaurant', 'cafe', 'bistro', 'bar', 'pub', 'eatery', 'bakery',
  'kitchen', 'diner', 'food truck', 'catering', 'taproom', 'brewery',
];
const B2B_HINTS = [
  'accounting', 'tax', 'legal', 'law firm', 'consulting', 'advisory',
  'agency', 'b2b', 'saas', 'software', 'finance', 'bookkeeping',
  'audit', 'compliance', 'msp', 'it services',
];
const ECOMMERCE_HINTS = [
  'ecommerce', 'e-commerce', 'shop', 'store', 'boutique', 'apparel',
  'candle', 'jewelry', 'cosmetics', 'goods', 'marketplace', 'merch',
];

function inferContactProfile(brand) {
  const hay = [
    brand.industry || '',
    brand.description || '',
    brand.tagline || '',
    (brand.services || []).join(' '),
  ].join(' ').toLowerCase();

  const hit = (arr) => arr.some((h) => hay.includes(h));
  if (hit(RESTAURANT_HINTS))     return 'restaurant';
  if (hit(B2B_HINTS))            return 'b2b';
  if (hit(ECOMMERCE_HINTS))      return 'ecommerce';
  if (hit(SERVICE_TRADES_HINTS)) return 'trades';
  return 'general';
}

function defaultFieldsFor(profile) {
  switch (profile) {
    case 'trades':     return ['Name', 'Phone', 'Service Needed', 'Best Time to Call', 'Notes'];
    case 'restaurant': return ['Name', 'Email', 'Date', 'Time', 'Party Size', 'Notes'];
    case 'b2b':        return ['Name', 'Email', 'Company', 'Role', 'Message'];
    case 'ecommerce':  return ['Name', 'Email', 'Order Number', 'Message'];
    default:           return ['Name', 'Email', 'Message'];
  }
}

function defaultSocialFor(profile) {
  switch (profile) {
    case 'trades':     return ['Facebook', 'Google Business'];
    case 'restaurant': return ['Instagram', 'Facebook'];
    case 'b2b':        return ['LinkedIn', 'Twitter/X'];
    case 'ecommerce':  return ['Instagram', 'TikTok'];
    default:           return ['LinkedIn', 'Facebook'];
  }
}

const SYSTEM_PROMPT = `You are the ARION IL contact-section copywriter for small-business websites.
You write a contact section that helps a real customer take the next step in under five seconds.
You return ONLY a single valid JSON object — no markdown, no commentary, no code fences.
You ground every detail in this business's actual phone, email, address, and industry — never a generic template.
You pick form fields that match the business type (trades wants Phone + Service Needed; restaurants want Date + Party Size; B2B wants Company; etc.).`;

function buildUserPrompt({ brand, sectionContext }) {
  const ctx = sectionContext || {};
  const profile = ctx.profile_override || inferContactProfile(brand);
  const phone   = brand.phone   || ctx.phone   || '';
  const email   = brand.email   || ctx.email   || '';
  const address = brand.address || ctx.address || brand.location || '';
  const defaults = defaultFieldsFor(profile);
  const socialDefaults = defaultSocialFor(profile);

  return `Write a contact section for THIS business.

BUSINESS CONTEXT:
- Business name: ${brand.business_name || '(unspecified)'}
- Industry: ${brand.industry || 'unspecified'}
- Description: ${brand.description || ''}
- Tagline: ${brand.tagline || ''}
- Target audience: ${brand.target_audience || ''}
- Services offered: ${(brand.services || []).join(' | ') || 'unspecified'}
- Brand voice: ${brand.brand_voice || 'professional'}
- Location: ${brand.location || ''}
- Phone (if provided):   ${phone   || '(not provided — omit the phone method)'}
- Email (if provided):   ${email   || '(not provided — synthesize a hello@<domain> address if domain is known, else omit)'}
- Address (if provided): ${address || '(not provided — omit the address method)'}
- Domain (for synth email): ${brand.domain || '(not provided)'}

INFERRED CONTACT PROFILE: ${profile}
  Default form fields for this profile: ${defaults.join(', ')}
  Default social platforms for this profile: ${socialDefaults.join(', ')}

SECTION OVERRIDES:
- Max contact methods: ${Number.isInteger(ctx.max_methods) ? ctx.max_methods : 6}
- Max form fields:     ${Number.isInteger(ctx.max_fields)  ? ctx.max_fields  : 8}
- Preferred submit text (optional): ${ctx.submit_text || 'auto — pick the best fit'}

OUTPUT — return ONLY this JSON object, no markdown:
{
  "headline":    "3-8 words for the contact section heading",
  "subheadline": "0-2 sentences — empty string if no good fit",
  "contact_methods": [
    {
      "kind":  "phone | email | address | social",
      "label": "1-4 words (e.g. 'Call us', 'Reservations', 'LinkedIn')",
      "value": "display value (formatted phone, email, short address, or @handle)",
      "href":  "clickable href — tel:+<digits> | mailto:<email> | https://maps.google.com/?q=... | https://<social-url>"
    }
  ],
  "form_config": {
    "fields":      ["Name", "Email", ...],
    "submit_text": "2-5 words (e.g. 'Send message', 'Request a quote', 'Book a table')"
  }
}

HREF FORMAT RULES:
- phone   → "tel:+<digits-only>" (E.164 if possible)
- email   → "mailto:<address>"
- address → "https://maps.google.com/?q=<url-encoded-address>"
- social  → full https URL to the actual profile (or a plausible https URL if the real one is unknown)

REQUIREMENTS:
- 1 to 6 contact methods. Include phone/email/address ONLY when the data is provided above; otherwise omit.
- Include 1 to 3 social methods matched to the profile.
- 1 to 8 form fields. Tune the field list to the business profile above.
- Write headline + subheadline in the "${brand.brand_voice || 'professional'}" brand voice.
- No emojis. No "your business" filler. No trailing punctuation in submit_text.
- Output MUST parse as JSON — no markdown wrapping.`;
}

function isHttpsUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidHref(kind, href) {
  if (typeof href !== 'string' || !href.trim()) return false;
  const h = href.trim();
  switch (kind) {
    case 'phone':   return /^tel:\+?[0-9 ()\-.]+$/i.test(h);
    case 'email':   return /^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/i.test(h);
    case 'address': return isHttpsUrl(h);
    case 'social':  return isHttpsUrl(h);
    default:        return false;
  }
}

function validateOutput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: { code: 'shape_error', message: 'contact output must be a non-array object' } };
  }
  if (typeof data.headline !== 'string' || !data.headline.trim()) {
    return { ok: false, error: { code: 'missing_headline', message: 'contact.headline required' } };
  }
  if (typeof data.subheadline !== 'string') {
    return { ok: false, error: { code: 'bad_subheadline', message: 'contact.subheadline must be string (may be empty)' } };
  }
  if (!Array.isArray(data.contact_methods) || data.contact_methods.length === 0) {
    return { ok: false, error: { code: 'no_methods', message: 'contact.contact_methods must be a non-empty array' } };
  }
  if (data.contact_methods.length > 6) {
    return { ok: false, error: { code: 'too_many_methods', message: `contact.contact_methods max 6, got ${data.contact_methods.length}` } };
  }

  const cleanMethods = [];
  for (let i = 0; i < data.contact_methods.length; i += 1) {
    const m = data.contact_methods[i];
    if (!m || typeof m !== 'object') {
      return { ok: false, error: { code: 'bad_method_shape', message: `contact.contact_methods[${i}] must be an object` } };
    }
    const kind = typeof m.kind === 'string' ? m.kind.trim().toLowerCase() : '';
    if (!METHOD_KINDS.has(kind)) {
      return {
        ok: false,
        error: { code: 'bad_method_kind', message: `contact.contact_methods[${i}].kind must be one of ${[...METHOD_KINDS].join('|')}, got "${m.kind}"` },
      };
    }
    if (typeof m.label !== 'string' || !m.label.trim()) {
      return { ok: false, error: { code: 'missing_method_label', message: `contact.contact_methods[${i}].label required` } };
    }
    if (typeof m.value !== 'string' || !m.value.trim()) {
      return { ok: false, error: { code: 'missing_method_value', message: `contact.contact_methods[${i}].value required` } };
    }
    if (!isValidHref(kind, m.href)) {
      return {
        ok: false,
        error: { code: 'bad_method_href', message: `contact.contact_methods[${i}].href invalid for kind "${kind}" (got "${String(m.href).slice(0, 80)}")` },
      };
    }
    cleanMethods.push({
      kind,
      label: m.label.trim(),
      value: m.value.trim(),
      href:  m.href.trim(),
    });
  }

  if (!data.form_config || typeof data.form_config !== 'object' || Array.isArray(data.form_config)) {
    return { ok: false, error: { code: 'missing_form_config', message: 'contact.form_config must be an object' } };
  }
  if (!Array.isArray(data.form_config.fields) || data.form_config.fields.length === 0) {
    return { ok: false, error: { code: 'no_form_fields', message: 'contact.form_config.fields must be a non-empty array' } };
  }
  if (data.form_config.fields.length > 8) {
    return { ok: false, error: { code: 'too_many_form_fields', message: `contact.form_config.fields max 8, got ${data.form_config.fields.length}` } };
  }
  const cleanFields = [];
  for (let i = 0; i < data.form_config.fields.length; i += 1) {
    const f = data.form_config.fields[i];
    if (typeof f !== 'string' || !f.trim()) {
      return { ok: false, error: { code: 'bad_form_field', message: `contact.form_config.fields[${i}] must be a non-empty string` } };
    }
    if (f.length > 60) {
      return { ok: false, error: { code: 'form_field_too_long', message: `contact.form_config.fields[${i}] must be <=60 chars, got ${f.length}` } };
    }
    cleanFields.push(f.trim());
  }
  if (typeof data.form_config.submit_text !== 'string' || !data.form_config.submit_text.trim()) {
    return { ok: false, error: { code: 'missing_submit_text', message: 'contact.form_config.submit_text required' } };
  }

  return {
    ok: true,
    data: {
      headline:    data.headline.trim(),
      subheadline: data.subheadline.trim(),
      contact_methods: cleanMethods,
      form_config: {
        fields:      cleanFields,
        submit_text: data.form_config.submit_text.trim().replace(/[.!?]+$/, ''),
      },
    },
  };
}

export function createContactEmitter(/* { anthropicClient } = {} */) {
  return {
    kind: 'contact',
    // Section library archetype mapping — see lib/websiteBuilder/sectionLibrary.js.
    archetype: 'contact',
    maxTokens: 1500,
    buildPrompts({ brand, sectionContext }) {
      return {
        system: SYSTEM_PROMPT,
        user:   buildUserPrompt({ brand, sectionContext }),
      };
    },
    validate: validateOutput,
    example: {
      headline: 'Get a quote within one business day',
      subheadline: "Tell us a little about the facility and we'll be in touch.",
      contact_methods: [
        { kind: 'phone',   label: 'Call us',   value: '(319) 555-0142',                    href: 'tel:+13195550142' },
        { kind: 'email',   label: 'Email',     value: 'quotes@cedarridgeplant.com',         href: 'mailto:quotes@cedarridgeplant.com' },
        { kind: 'address', label: 'Office',    value: '115 16th Ave SW, Cedar Rapids, IA',  href: 'https://maps.google.com/?q=115+16th+Ave+SW+Cedar+Rapids+IA' },
        { kind: 'social',  label: 'LinkedIn',  value: '@cedarridgeplant',                   href: 'https://www.linkedin.com/company/cedarridgeplant' },
      ],
      form_config: {
        fields: ['Name', 'Company', 'Phone', 'Facility Type', 'Square Footage', 'Notes'],
        submit_text: 'Request a quote',
      },
    },
  };
}

export const __test__ = {
  SYSTEM_PROMPT,
  buildUserPrompt,
  validateOutput,
  inferContactProfile,
  defaultFieldsFor,
  defaultSocialFor,
  isValidHref,
  isHttpsUrl,
  METHOD_KINDS,
};
