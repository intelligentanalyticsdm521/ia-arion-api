/**
 * Services block emitter — ARION IL website builder.
 * --------------------------------------------------------------------------
 * Produces a services-grid section payload that elementorAdapter.js converts
 * into a 2/3-column icon-box grid.
 *
 * Output schema:
 *   {
 *     headline:    string  (3-8 words),
 *     subheadline: string  (0-2 sentences, optional but always present as string),
 *     services: [
 *       {
 *         title:       string  (2-6 words),
 *         description: string  (1-2 sentences, ~12-30 words),
 *         icon_name:   string  (one of the curated allowlist below)
 *       }
 *     ]
 *   }
 *
 * Constraints:
 *   - 1 service minimum, 8 services maximum
 *   - When brand.services has entries, those drive the list (one row per).
 *     The emitter still rewrites titles for parallel grammar and writes a
 *     fresh description per item.
 *   - When brand.services is empty, the emitter invents 3-4 plausible services
 *     for the industry — flagged in meta so the founder can audit.
 *
 * Icon allowlist — kept short to stay paint-able from Elementor's default
 * Font Awesome 5 set. elementorAdapter maps icon_name → fa-* class.
 */

const ICON_ALLOWLIST = new Set([
  'briefcase', 'rocket', 'cog', 'chart-line', 'handshake', 'lightbulb',
  'shield', 'star', 'thumbs-up', 'clock', 'check-circle', 'phone',
  'envelope', 'map-marker', 'globe', 'wrench', 'tools', 'home',
  'building', 'truck', 'tag', 'gift', 'heart', 'leaf',
]);

const ICON_FALLBACK = 'check-circle';

const SYSTEM_PROMPT = `You are the ARION IL services-section copywriter for small-business websites.
You write a services grid with parallel grammar across items.
You return ONLY a single valid JSON object — no markdown, no commentary, no code fences.
Every service title and description must be SPECIFIC to this business — never generic templated text.
You write in the requested brand voice.`;

function buildUserPrompt({ brand, sectionContext }) {
  const ctx = sectionContext || {};
  const seedServices = Array.isArray(brand.services) ? brand.services : [];
  const seedClause = seedServices.length
    ? `The customer provided these EXACT service names — keep each one, but rewrite for parallel grammar:\n${seedServices.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`
    : `The customer did NOT provide a services list. Invent 3-4 plausible services for the ${brand.industry || 'general business'} industry. Flag them as plausible by keeping titles grounded in real industry offerings.`;

  return `Write a services-grid section for THIS business.

BUSINESS CONTEXT:
- Business name: ${brand.business_name || '(unspecified)'}
- Industry: ${brand.industry || 'unspecified'}
- Description: ${brand.description || ''}
- Target audience: ${brand.target_audience || ''}
- Brand voice: ${brand.brand_voice || 'professional'}
- Style preference: ${brand.style_preference || 'modern'}
- Location: ${brand.location || ''}

SERVICES INPUT:
${seedClause}

SECTION OVERRIDES:
- Headline variant note: ${ctx.headline_variant || 'none'}
- Maximum number of services: ${Number.isInteger(ctx.max_services) ? ctx.max_services : 8}

ICON ALLOWLIST — pick the single best fit per service from this list ONLY:
${[...ICON_ALLOWLIST].join(', ')}

OUTPUT — return ONLY this JSON object, no markdown:
{
  "headline":    "3-8 words for the services section heading (e.g. 'What we do best')",
  "subheadline": "0-2 sentences — empty string if no good fit",
  "services": [
    {
      "title":       "2-6 words, parallel-grammar with other titles",
      "description": "1-2 sentences, ~12-30 words, specific to this business",
      "icon_name":   "one of the allowlist above"
    }
  ]
}

REQUIREMENTS:
- 1 to 8 services. If the customer provided fewer, use those; do not pad with invented services.
- Each description must reference THIS business's audience, value, or specialty.
- No emojis. No "your business" filler.
- icon_name MUST be from the allowlist; pick the best semantic match.
- Output MUST parse as JSON — no markdown wrapping.`;
}

function validateOutput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: { code: 'shape_error', message: 'services output must be a non-array object' } };
  }
  if (typeof data.headline !== 'string' || !data.headline.trim()) {
    return { ok: false, error: { code: 'missing_headline', message: 'services.headline required' } };
  }
  if (typeof data.subheadline !== 'string') {
    return { ok: false, error: { code: 'bad_subheadline', message: 'services.subheadline must be string (may be empty)' } };
  }
  if (!Array.isArray(data.services) || data.services.length === 0) {
    return { ok: false, error: { code: 'no_services', message: 'services.services must be a non-empty array' } };
  }
  if (data.services.length > 8) {
    return { ok: false, error: { code: 'too_many_services', message: `max 8 services, got ${data.services.length}` } };
  }

  const cleanServices = [];
  for (let i = 0; i < data.services.length; i += 1) {
    const svc = data.services[i];
    if (!svc || typeof svc !== 'object') {
      return { ok: false, error: { code: 'bad_service_shape', message: `services[${i}] must be an object` } };
    }
    if (typeof svc.title !== 'string' || !svc.title.trim()) {
      return { ok: false, error: { code: 'missing_service_title', message: `services[${i}].title required` } };
    }
    if (typeof svc.description !== 'string' || !svc.description.trim()) {
      return { ok: false, error: { code: 'missing_service_description', message: `services[${i}].description required` } };
    }
    let icon = typeof svc.icon_name === 'string' ? svc.icon_name.trim().toLowerCase() : '';
    if (!ICON_ALLOWLIST.has(icon)) {
      // Soft-coerce to fallback instead of rejecting — Claude occasionally
      // returns a near-match like "checkmark" instead of "check-circle".
      icon = ICON_FALLBACK;
    }
    cleanServices.push({
      title:       svc.title.trim(),
      description: svc.description.trim(),
      icon_name:   icon,
    });
  }

  return {
    ok: true,
    data: {
      headline:    data.headline.trim(),
      subheadline: data.subheadline.trim(),
      services:    cleanServices,
    },
  };
}

export function createServicesEmitter(/* { anthropicClient } = {} */) {
  return {
    kind: 'services',
    maxTokens: 1500,
    buildPrompts({ brand, sectionContext }) {
      return {
        system: SYSTEM_PROMPT,
        user:   buildUserPrompt({ brand, sectionContext }),
      };
    },
    validate: validateOutput,
    example: {
      headline: 'What we do best',
      subheadline: 'Specialized services for service businesses across the Midwest.',
      services: [
        {
          title: 'Deep Plant Cleaning',
          description: 'Scheduled overnight crews scrub and sanitize production floors so first-shift starts clean.',
          icon_name: 'tools',
        },
        {
          title: 'Warehouse Floor Care',
          description: 'Stripping, sealing, and burnishing for high-traffic distribution centers.',
          icon_name: 'truck',
        },
        {
          title: 'Office Janitorial',
          description: 'Tier-appropriate cleaning schedules for the office side of mixed-use facilities.',
          icon_name: 'briefcase',
        },
      ],
    },
  };
}

export const __test__ = { SYSTEM_PROMPT, buildUserPrompt, validateOutput, ICON_ALLOWLIST, ICON_FALLBACK };
