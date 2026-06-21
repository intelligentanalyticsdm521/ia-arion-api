/**
 * Gallery block emitter — ARION IL website builder.
 * --------------------------------------------------------------------------
 * Produces a gallery section payload that elementorAdapter.js converts into
 * a responsive image grid (Elementor "image-gallery" widget for V1).
 *
 * Output schema:
 *   {
 *     headline:    string  (3-8 words),
 *     subheadline: string  (0-2 sentences, may be empty),
 *     images: [
 *       {
 *         url:      string  (https URL — placeholder.com or unsplash.com query),
 *         alt:      string  (5-15 words, semantic, business-specific),
 *         caption?: string  (optional — 0-12 words),
 *         category?: string (optional — short tag like "Before/After", "Projects")
 *       }
 *     ]  (6-12 images)
 *   }
 *
 * Image URL policy:
 *   - The emitter does NOT generate real images. It returns deterministic
 *     placeholder/stock URLs:
 *       • unsplash.com query URLs: https://source.unsplash.com/800x600/?<keywords>
 *       • placeholder.com URLs:    https://via.placeholder.com/800x600?text=<label>
 *   - The page assembler / founder UI is expected to swap these for real
 *     uploaded images before publish. The alt + caption + category fields
 *     ride along so the swap preserves the editorial intent.
 *
 * Example 1 (industrial cleaning business):
 *   {
 *     "headline": "Recent facility work",
 *     "subheadline": "A sample of overnight crews across Iowa.",
 *     "images": [
 *       { "url": "https://source.unsplash.com/800x600/?warehouse,clean", "alt": "Polished warehouse floor under daylight after overnight strip and seal", "caption": "Cedar Rapids distribution center", "category": "Floor Care" },
 *       { "url": "https://source.unsplash.com/800x600/?factory,floor",   "alt": "Spotless food-grade production line ready for first shift",         "caption": "Quad Cities dairy plant",         "category": "Plant Cleaning" },
 *       { "url": "https://source.unsplash.com/800x600/?janitor,office",  "alt": "Office breakroom freshly cleaned and reset for morning",          "caption": "Mixed-use facility office wing", "category": "Janitorial" },
 *       { "url": "https://source.unsplash.com/800x600/?cleaning,crew",   "alt": "Uniformed overnight crew staging equipment before a deep clean", "caption": "Crew prep, 11pm shift",          "category": "Behind the Scenes" },
 *       { "url": "https://source.unsplash.com/800x600/?warehouse,empty", "alt": "Empty warehouse aisle after overnight stripping and burnishing",  "caption": "Before/after, west aisle",       "category": "Before/After" },
 *       { "url": "https://source.unsplash.com/800x600/?cip,system",      "alt": "CIP rinse station cleaned and certified for next production run", "caption": "CIP rinse, food-grade line",     "category": "CIP" }
 *     ]
 *   }
 *
 * Example 2 (boutique e-commerce candle shop):
 *   {
 *     "headline": "From the workshop",
 *     "subheadline": "",
 *     "images": [
 *       { "url": "https://source.unsplash.com/800x600/?candle,workshop", "alt": "Hand pouring soy wax into amber jar at workshop bench",     "caption": "Pour day, Wednesday",   "category": "Workshop" },
 *       { "url": "https://source.unsplash.com/800x600/?candle,burning",  "alt": "Lit candle glowing on rustic wooden table at dusk",        "caption": "Fireside scent test",   "category": "Lifestyle" },
 *       { "url": "https://source.unsplash.com/800x600/?soy,wax",         "alt": "Soy wax flakes being weighed for the next small batch",    "caption": "Batch 142 in prep",     "category": "Workshop" },
 *       { "url": "https://source.unsplash.com/800x600/?candle,packaging","alt": "Finished candles boxed for shipping with handwritten note", "caption": "Shipping day",          "category": "Shipping" },
 *       { "url": "https://source.unsplash.com/800x600/?candle,gift",     "alt": "Gift set of three small candles tied with twine",          "caption": "Trio gift set",         "category": "Lifestyle" },
 *       { "url": "https://source.unsplash.com/800x600/?candle,shop",     "alt": "Storefront shelf lined with seasonal scents in amber jars","caption": "Portland shop window",  "category": "Shop" }
 *     ]
 *   }
 */

const SYSTEM_PROMPT = `You are the ARION IL gallery-section curator for small-business websites.
You curate 6 to 12 brand-relevant placeholder images for a gallery grid.
You return ONLY a single valid JSON object — no markdown, no commentary, no code fences.
You NEVER attempt to generate real images. Every URL is a deterministic placeholder query.
Every alt text references THIS specific business's industry, services, audience, or location.`;

// Allowed image-host hosts (used in validation). Keeping a tight allowlist
// prevents the LLM from inventing arbitrary URLs that the page assembler
// can't safely render or swap.
const ALLOWED_HOSTS = new Set([
  'source.unsplash.com',
  'images.unsplash.com',
  'via.placeholder.com',
  'placehold.co',
  'placeholder.com',
]);

function buildUserPrompt({ brand, sectionContext }) {
  const ctx = sectionContext || {};
  const minImages = Number.isInteger(ctx.min_images) ? ctx.min_images : 6;
  const maxImages = Number.isInteger(ctx.max_images) ? ctx.max_images : 12;
  const wantCategory = ctx.include_categories !== false; // default on
  const wantCaption  = ctx.include_captions  !== false; // default on

  return `Curate a gallery section for THIS business.

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
- Min images: ${minImages}
- Max images: ${maxImages}
- Include captions: ${wantCaption ? 'yes (1-12 words each)' : 'no — omit caption field'}
- Include category tags: ${wantCategory ? 'yes (short tag like "Before/After", "Workshop")' : 'no — omit category field'}
- Theme hint (optional): ${ctx.theme_hint || 'none'}

URL POLICY — DO NOT generate real images. Use ONE of these patterns ONLY:
  1. https://source.unsplash.com/800x600/?<comma-separated-keywords>
     - keywords are lowercase, hyphens or commas, no spaces
     - e.g. https://source.unsplash.com/800x600/?warehouse,clean
  2. https://via.placeholder.com/800x600?text=<URL-encoded-label>
     - use only if Unsplash keywords would be too generic (rare)

OUTPUT — return ONLY this JSON object, no markdown:
{
  "headline":    "3-8 words for the gallery section heading (e.g. 'Recent projects', 'From the workshop')",
  "subheadline": "0-2 sentences — empty string if no good fit",
  "images": [
    {
      "url":      "one of the allowed URL patterns above",
      "alt":      "5-15 words, semantic, references THIS business",
      "caption":  "${wantCaption ? '1-12 words — short editorial caption' : 'OMIT this field'}",
      "category": "${wantCategory ? 'short tag like \\"Before/After\\", \\"Workshop\\", \\"Projects\\"' : 'OMIT this field'}"
    }
  ]
}

REQUIREMENTS:
- ${minImages} to ${maxImages} images.
- Vary the Unsplash keywords across images — don't repeat the same keyword combo.
- alt text must reference THIS business's industry, services, audience, or location.
- No emojis. No "your business" filler.
- Output MUST parse as JSON — no markdown wrapping.`;
}

function isAllowedUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return false;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:') return false;
    return ALLOWED_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function validateOutput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: { code: 'shape_error', message: 'gallery output must be a non-array object' } };
  }
  if (typeof data.headline !== 'string' || !data.headline.trim()) {
    return { ok: false, error: { code: 'missing_headline', message: 'gallery.headline required' } };
  }
  if (typeof data.subheadline !== 'string') {
    return { ok: false, error: { code: 'bad_subheadline', message: 'gallery.subheadline must be string (may be empty)' } };
  }
  if (!Array.isArray(data.images) || data.images.length < 6) {
    return {
      ok: false,
      error: { code: 'too_few_images', message: `gallery.images must be array of at least 6, got ${Array.isArray(data.images) ? data.images.length : 'non-array'}` },
    };
  }
  if (data.images.length > 12) {
    return { ok: false, error: { code: 'too_many_images', message: `gallery.images max 12, got ${data.images.length}` } };
  }

  const clean = [];
  for (let i = 0; i < data.images.length; i += 1) {
    const img = data.images[i];
    if (!img || typeof img !== 'object') {
      return { ok: false, error: { code: 'bad_image_shape', message: `gallery.images[${i}] must be an object` } };
    }
    if (!isAllowedUrl(img.url)) {
      return { ok: false, error: { code: 'bad_image_url', message: `gallery.images[${i}].url must be a placeholder/unsplash https URL (got "${String(img.url).slice(0, 80)}")` } };
    }
    if (typeof img.alt !== 'string' || !img.alt.trim()) {
      return { ok: false, error: { code: 'missing_alt', message: `gallery.images[${i}].alt required` } };
    }
    if (img.alt.length > 300) {
      return { ok: false, error: { code: 'alt_too_long', message: `gallery.images[${i}].alt must be <=300 chars, got ${img.alt.length}` } };
    }
    const out = {
      url: img.url.trim(),
      alt: img.alt.trim(),
    };
    if (img.caption != null) {
      if (typeof img.caption !== 'string') {
        return { ok: false, error: { code: 'bad_caption', message: `gallery.images[${i}].caption must be string when present` } };
      }
      const cap = img.caption.trim();
      if (cap.length > 200) {
        return { ok: false, error: { code: 'caption_too_long', message: `gallery.images[${i}].caption must be <=200 chars, got ${cap.length}` } };
      }
      if (cap) out.caption = cap;
    }
    if (img.category != null) {
      if (typeof img.category !== 'string') {
        return { ok: false, error: { code: 'bad_category', message: `gallery.images[${i}].category must be string when present` } };
      }
      const cat = img.category.trim();
      if (cat.length > 60) {
        return { ok: false, error: { code: 'category_too_long', message: `gallery.images[${i}].category must be <=60 chars, got ${cat.length}` } };
      }
      if (cat) out.category = cat;
    }
    clean.push(out);
  }

  return {
    ok: true,
    data: {
      headline:    data.headline.trim(),
      subheadline: data.subheadline.trim(),
      images:      clean,
    },
  };
}

export function createGalleryEmitter(/* { anthropicClient } = {} */) {
  return {
    kind: 'gallery',
    maxTokens: 2500,
    buildPrompts({ brand, sectionContext }) {
      return {
        system: SYSTEM_PROMPT,
        user:   buildUserPrompt({ brand, sectionContext }),
      };
    },
    validate: validateOutput,
    example: {
      headline: 'Recent facility work',
      subheadline: 'A sample of overnight crews across Iowa.',
      images: [
        { url: 'https://source.unsplash.com/800x600/?warehouse,clean', alt: 'Polished warehouse floor under daylight after overnight strip and seal', caption: 'Cedar Rapids distribution center', category: 'Floor Care' },
        { url: 'https://source.unsplash.com/800x600/?factory,floor',   alt: 'Spotless food-grade production line ready for first shift',           caption: 'Quad Cities dairy plant',         category: 'Plant Cleaning' },
        { url: 'https://source.unsplash.com/800x600/?janitor,office',  alt: 'Office breakroom freshly cleaned and reset for morning',              caption: 'Mixed-use facility office wing', category: 'Janitorial' },
        { url: 'https://source.unsplash.com/800x600/?cleaning,crew',   alt: 'Uniformed overnight crew staging equipment before a deep clean',     caption: 'Crew prep, 11pm shift',          category: 'Behind the Scenes' },
        { url: 'https://source.unsplash.com/800x600/?warehouse,empty', alt: 'Empty warehouse aisle after overnight stripping and burnishing',     caption: 'Before/after, west aisle',       category: 'Before/After' },
        { url: 'https://source.unsplash.com/800x600/?cip,system',      alt: 'CIP rinse station cleaned and certified for next production run',    caption: 'CIP rinse, food-grade line',     category: 'CIP' },
      ],
    },
  };
}

export const __test__ = { SYSTEM_PROMPT, buildUserPrompt, validateOutput, isAllowedUrl, ALLOWED_HOSTS };
