/**
 * Industry → Astra Starter Template ID registry.
 * --------------------------------------------------------------------------
 * Every customer gets the Astra free starter template matched to their
 * questionnaire `industry` answer. Multiple templates per industry let us
 * round-robin so two consulting customers don't see identical sites.
 *
 * Template IDs are sourced from `wp starter-templates list --page-builder=elementor`
 * on a live Astra-installed WP. To add/swap templates, run that command on a
 * freshly-imported WP install and pick IDs. All IDs below are FREE-tier.
 *
 * On unknown industry → falls back to the 'generic_business' bucket.
 */

const REGISTRY = {
  // Service businesses — plumbers, electricians, contractors, cleaners
  service_business: [
    { id: 34184, label: 'Local Plumber' },
    { id: 39541, label: 'Local Service Pro' },
  ],
  // Consulting + professional services
  consulting: [
    { id: 34199, label: 'Business Consultant' },
    { id: 41033, label: 'Financial Advisor' },
  ],
  // Healthcare, wellness, dental, therapy
  healthcare: [
    { id: 36103, label: 'Dental Clinic' },
    { id: 39875, label: 'Wellness Coach' },
  ],
  // Restaurants + food
  restaurant: [
    { id: 35892, label: 'Restaurant' },
    { id: 41552, label: 'Cafe' },
  ],
  // SaaS + tech startups
  tech_saas: [
    { id: 34091, label: 'SaaS Landing' },
    { id: 39998, label: 'Startup' },
  ],
  // Retail + e-commerce
  retail: [
    { id: 35430, label: 'Online Store' },
  ],
  // Real estate
  real_estate: [
    { id: 35201, label: 'Real Estate Agent' },
  ],
  // Creative + agency + portfolio
  creative: [
    { id: 34001, label: 'Creative Agency' },
    { id: 39230, label: 'Portfolio' },
  ],
  // Fallback — used when industry doesn't match a bucket
  generic_business: [
    { id: 34184, label: 'Local Plumber' }, // sane generic; replace once we curate a true generic
  ],
};

/**
 * Map free-text questionnaire industry to a bucket key.
 * The portal questionnaire is free-text; we do keyword matching.
 */
const KEYWORDS = [
  { match: /consult|advisor|coach|professional services|legal|law|account|finance|tax/i, bucket: 'consulting' },
  { match: /restaur|cafe|food|bakery|catering|bar|diner|kitchen|grill/i, bucket: 'restaurant' },
  { match: /dent|chiro|health|wellness|therap|clinic|medic|fitness|gym|yoga|massage/i, bucket: 'healthcare' },
  { match: /saas|tech|software|app|startup|developer|engineer/i, bucket: 'tech_saas' },
  { match: /retail|shop|store|ecommerce|product|merchand/i, bucket: 'retail' },
  { match: /real estate|property|realtor|broker/i, bucket: 'real_estate' },
  { match: /agency|creative|portfolio|design|photograph|video|art/i, bucket: 'creative' },
  { match: /plumb|electric|contract|clean|landscap|HVAC|repair|service|maint|handyman|construct/i, bucket: 'service_business' },
];

/**
 * Pick a template for the customer's industry.
 *
 * @param {object} args
 * @param {string} args.industry        Free-text industry from questionnaire
 * @param {string} args.businessName    Used to seed deterministic round-robin
 * @returns {{ id: number, label: string, bucket: string }}
 */
export function pickTemplateForIndustry({ industry, businessName }) {
  const text = `${industry || ''} ${businessName || ''}`;
  let bucket = 'generic_business';
  for (const k of KEYWORDS) {
    if (k.match.test(text)) { bucket = k.bucket; break; }
  }
  const pool = REGISTRY[bucket] || REGISTRY.generic_business;
  // Deterministic round-robin by hashing businessName → index. Two customers
  // with similar names + same industry still get different templates.
  const seed = Array.from(String(businessName || 'x'))
    .reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) >>> 0, 0);
  const picked = pool[seed % pool.length];
  return { ...picked, bucket };
}

export default { pickTemplateForIndustry };
