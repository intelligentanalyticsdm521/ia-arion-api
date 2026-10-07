// lib/audit/checks.js
//
// What we look at on each page and across the site (contract §E.3). Facts
// only: every value here is read off the page or the response headers. No
// model, nothing guessed. Plain regex over the HTML — the checks are simple
// enough that a parser dependency would buy nothing.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, n) => (ENTITIES[n.toLowerCase()] ?? m));
}

const collapse = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Attributes of one start tag as a lower-cased map. */
export function attrsOf(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const inner = tag.replace(/^<\s*[a-zA-Z0-9]+/, '').replace(/\/?>$/, '');
  let m;
  while ((m = re.exec(inner))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

const tagsNamed = (html, name) => String(html).match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) || [];

/** The HTML without comments, scripts and styles (so their text is not counted). */
function visibleHtml(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
}

/** JSON-LD @type values on a page (flattening @graph and arrays). */
export function jsonLdTypes(html) {
  const types = new Set();
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const t = node['@type'];
    (Array.isArray(t) ? t : [t]).filter(Boolean).forEach((x) => types.add(String(x)));
    if (node['@graph']) walk(node['@graph']);
  };
  while ((m = re.exec(String(html || '')))) {
    try { walk(JSON.parse(m[1].trim())); } catch { /* a broken block simply has no types */ }
  }
  return [...types];
}

const BUSINESS_TYPES = /^(LocalBusiness|Organization|Corporation|ProfessionalService|HomeAndConstructionBusiness|Store|Restaurant|.*Business|.*Service|.*Contractor|Plumber|Electrician|Dentist|Attorney|LegalService|AutoRepair|HVACBusiness|RoofingContractor|GeneralContractor)$/;

/** One page's facts. */
export function pageChecks(html) {
  const raw = String(html || '');
  const vis = visibleHtml(raw);
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
  const title = titleMatch ? collapse(titleMatch[1]) : '';
  const metas = tagsNamed(raw, 'meta').map(attrsOf);
  const description = (metas.find((a) => (a.name || '').toLowerCase() === 'description')?.content || '').trim();
  const viewport = metas.some((a) => (a.name || '').toLowerCase() === 'viewport' && a.content);
  const canonical = tagsNamed(raw, 'link').map(attrsOf)
    .some((a) => String(a.rel || '').toLowerCase().split(/\s+/).includes('canonical') && a.href);
  const h1Count = tagsNamed(vis, 'h1').length;
  const imgs = tagsNamed(vis, 'img').map(attrsOf);
  // alt="" is a deliberate "decorative" mark and is fine; a MISSING alt is not.
  const imagesWithoutAlt = imgs.filter((a) => !Object.prototype.hasOwnProperty.call(a, 'alt')).length;
  const types = jsonLdTypes(raw);
  return {
    title,
    titleLength: title.length,
    titleOk: title.length >= 10 && title.length <= 60,
    description,
    descriptionLength: description.length,
    descriptionOk: description.length >= 50 && description.length <= 160,
    h1Count,
    h1Ok: h1Count === 1,
    imageCount: imgs.length,
    imagesWithoutAlt,
    canonical,
    viewport,
    jsonLdTypes: types,
    hasBusinessSchema: types.some((t) => BUSINESS_TYPES.test(t)),
  };
}

/** Anchors on a page: [{ href, text }]. */
export function anchorsOf(html) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  const vis = visibleHtml(html);
  while ((m = re.exec(vis))) {
    const a = attrsOf(`<a ${m[1]}>`);
    if (a.href != null) out.push({ href: a.href.trim(), text: collapse(m[2]) });
  }
  return out;
}

export const SECURITY_HEADERS = [
  { key: 'hsts', header: 'strict-transport-security', plain: 'tells browsers to always use the secure version' },
  { key: 'csp', header: 'content-security-policy', plain: 'limits what other sites can run on your pages' },
  { key: 'nosniff', header: 'x-content-type-options', plain: 'stops browsers guessing what a file is' },
  { key: 'frame', header: 'x-frame-options', plain: 'stops other sites showing your pages inside theirs' },
  { key: 'referrer', header: 'referrer-policy', plain: 'controls what your pages tell other sites about your visitors' },
];

/** Which of the five protections the home page sends. */
export function securityHeaderChecks(headers = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
  const out = {};
  for (const s of SECURITY_HEADERS) out[s.key] = Boolean(h[s.header]);
  // CSP frame-ancestors does the same job as X-Frame-Options.
  if (!out.frame && /frame-ancestors/i.test(h['content-security-policy'] || '')) out.frame = true;
  return out;
}

const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}/;

/** Can a visitor see how to get in touch from the home page? */
export function contactChecks(html) {
  const anchors = anchorsOf(html);
  const telLink = anchors.some((a) => /^tel:/i.test(a.href));
  const text = collapse(visibleHtml(html));
  const phoneShown = telLink || PHONE_RE.test(text);
  const contactLink = anchors.some((a) => /^mailto:/i.test(a.href) || /contact|get-in-touch|quote|book/i.test(a.href) || /\bcontact\b|get in touch|book|quote/i.test(a.text));
  const form = /<form\b/i.test(String(html || ''));
  return { telLink, phoneShown, contactLink: contactLink || form };
}

export default { pageChecks, anchorsOf, securityHeaderChecks, contactChecks, jsonLdTypes, decodeEntities, attrsOf, SECURITY_HEADERS };
