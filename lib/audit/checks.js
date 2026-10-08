// lib/audit/checks.js
//
// What we look at on each page and across the site (contract §E.3). Facts
// only: every value here is read off the page or the response headers. No
// model, nothing guessed.
//
// THE HTML IS HOSTILE INPUT. Whoever owns the website chose every byte, and
// these checks run on the one thread that serves every business. So the page
// is read with a linear indexOf scanner, not with lazy "opener ... closer"
// regular expressions: a regex like /<!--[\s\S]*?-->/ rescans to the end of
// the page for every opener that never closes, and 2 MB of "<!--" took
// minutes (reviewer finding, 7 Oct 2026). Every closer search is cached, so a
// page costs one pass per scan whatever it holds. Only the first 512 KB of a
// page is read.

export const MAX_HTML = 512 * 1024;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** A code point we can put in a string, else the replacement character (a page's own bad entity must not throw). */
const fromCode = (n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd');

export function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d{1,8});/g, (_, n) => fromCode(Number(n)))
    .replace(/&#x([0-9a-f]{1,8});/gi, (_, n) => fromCode(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, n) => (ENTITIES[n.toLowerCase()] ?? m));
}

/** ASCII-only lower case: same length as the input, so indexes line up. */
const asciiLower = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/**
 * indexOf with a memory: the first `needle` at or after `pos`. Asking again
 * from a later position reuses the last answer while it is still ahead, so a
 * scan that keeps asking for a closer that never comes costs one search, not
 * one per opener.
 */
function finder(hay, needle) {
  let askedFrom = -1;
  let found = -1;
  return (pos) => {
    if (askedFrom >= 0 && pos >= askedFrom && (found === -1 || found >= pos)) return found;
    askedFrom = pos;
    found = hay.indexOf(needle, pos);
    return found;
  };
}

const NAME_CHAR = /[a-z0-9_]/;

/** Every `<name …>` start tag (whole word, any case): [{ start, end, tag }] with end just after '>'. */
function startTags(html, lower, name) {
  const out = [];
  const nextOpen = finder(lower, `<${name}`);
  const nextGt = finder(lower, '>');
  let pos = 0;
  for (;;) {
    const i = nextOpen(pos);
    if (i < 0) break;
    pos = i + 1;
    if (NAME_CHAR.test(lower[i + name.length + 1] || '')) continue; // <ab is not <a
    const gt = nextGt(i);
    if (gt < 0) break; // an unfinished tag at the end is not a tag
    out.push({ start: i, end: gt + 1, tag: html.slice(i, gt + 1) });
  }
  return out;
}

/** Every `<name …>inner</name>`: [{ tag, inner, end }]. An opener with no closer is skipped. */
function blocks(html, lower, name) {
  const out = [];
  const nextClose = finder(lower, `</${name}`);
  let from = 0;
  for (const t of startTags(html, lower, name)) {
    if (t.start < from) continue; // inside the previous block
    const close = nextClose(t.end);
    if (close < 0) continue;
    out.push({ tag: t.tag, inner: html.slice(t.end, close), end: close });
    from = close;
  }
  return out;
}

/** Text with every tag replaced by a space (one pass). */
function stripTags(s) {
  const nextGt = finder(s, '>');
  let out = '';
  let pos = 0;
  for (;;) {
    const lt = s.indexOf('<', pos);
    if (lt < 0) { out += s.slice(pos); break; }
    const gt = nextGt(lt);
    if (gt < 0) { out += s.slice(pos); break; } // no tag closes: the rest is text
    out += `${s.slice(pos, lt)} `;
    pos = gt + 1;
  }
  return out;
}

const collapse = (s) => decodeEntities(stripTags(String(s || ''))).replace(/\s+/g, ' ').trim();

/** Attributes of one start tag as a lower-cased map. */
export function attrsOf(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const inner = tag.replace(/^<\s*[a-zA-Z0-9]+/, '').replace(/\/?>$/, '');
  let m;
  while ((m = re.exec(inner))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

const capped = (html) => String(html || '').slice(0, MAX_HTML);

const tagsNamed = (html, name) => startTags(html, asciiLower(html), name).map((t) => t.tag);

/**
 * Cut every open…close span out, in one pass. An opener that never closes
 * runs to the end of the page, as a browser reads it.
 */
function cutSpans(html, open, close, wholeWord) {
  const lower = asciiLower(html);
  const nextClose = finder(lower, close);
  let out = '';
  let pos = 0;
  let scan = 0;
  for (;;) {
    const i = lower.indexOf(open, scan);
    if (i < 0) { out += html.slice(pos); break; }
    if (wholeWord && NAME_CHAR.test(lower[i + open.length] || '')) { scan = i + 1; continue; }
    out += `${html.slice(pos, i)} `;
    const c = nextClose(i + open.length);
    if (c < 0) { pos = html.length; break; }
    pos = c + close.length;
    scan = pos;
  }
  return out;
}

/** The HTML without comments, scripts and styles (so their text is not counted). */
function visibleHtml(html) {
  let s = capped(html);
  s = cutSpans(s, '<!--', '-->', false);
  s = cutSpans(s, '<script', '</script>', true);
  s = cutSpans(s, '<style', '</style>', true);
  return s;
}

/** JSON-LD @type values on a page (flattening @graph and arrays). */
export function jsonLdTypes(html) {
  const raw = capped(html);
  const types = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const t = node['@type'];
    (Array.isArray(t) ? t : [t]).filter(Boolean).forEach((x) => types.add(String(x).slice(0, 100)));
    if (node['@graph']) walk(node['@graph']);
  };
  for (const b of blocks(raw, asciiLower(raw), 'script')) {
    if (!/^application\/ld\+json$/i.test(String(attrsOf(b.tag).type || '').trim())) continue;
    try { walk(JSON.parse(b.inner.trim())); } catch { /* a broken block simply has no types */ }
  }
  return [...types];
}

const BUSINESS_TYPES = /^(LocalBusiness|Organization|Corporation|ProfessionalService|HomeAndConstructionBusiness|Store|Restaurant|.*Business|.*Service|.*Contractor|Plumber|Electrician|Dentist|Attorney|LegalService|AutoRepair|HVACBusiness|RoofingContractor|GeneralContractor)$/;

/** One page's facts. */
export function pageChecks(html) {
  const raw = capped(html);
  const vis = visibleHtml(raw);
  const titleBlock = blocks(raw, asciiLower(raw), 'title')[0];
  const title = titleBlock ? collapse(titleBlock.inner) : '';
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
  const vis = visibleHtml(html);
  for (const b of blocks(vis, asciiLower(vis), 'a')) {
    const a = attrsOf(b.tag);
    if (a.href != null) out.push({ href: a.href.trim(), text: collapse(b.inner) });
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

// A page whose ADDRESS says it is for getting in touch: a whole path segment,
// so /contact-us and /book-online count but facebook.com and /notebooks do not.
const CONTACT_SEGMENT = /^(?:contact|contact-?us|get-in-touch|(?:request-a-|get-a-|free-)?quotes?|book|booking|book-now|book-online|appointments?|schedule)(?:\.(?:html?|php|aspx?))?$/i;
// Link WORDS that say the same, as whole words.
const CONTACT_WORDS = /\bcontact\b|\bget in touch\b|\bbook (?:a|an|now|online|today)\b|\b(?:get|request) a (?:free )?quote\b|\bfree quote\b/i;

function isContactHref(href) {
  if (/^mailto:/i.test(href)) return true;
  let u;
  try { u = new URL(href, 'https://page.invalid/'); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return u.pathname.split('/').some((seg) => CONTACT_SEGMENT.test(seg));
}

/** A form a visitor can reach the business with: an email or phone box, or a message box. Not a search box. */
function contactForms(html) {
  const lower = asciiLower(html);
  const nextClose = finder(lower, '</form');
  return startTags(html, lower, 'form').some((t) => {
    if (String(attrsOf(t.tag).role || '').toLowerCase() === 'search') return false;
    const close = nextClose(t.end);
    const inner = html.slice(t.end, close < 0 ? html.length : close);
    if (tagsNamed(inner, 'textarea').length) return true;
    return tagsNamed(inner, 'input').map(attrsOf).some((a) => /^(?:email|tel)$/i.test(String(a.type || '').trim()));
  });
}

/** Can a visitor see how to get in touch from the home page? */
export function contactChecks(html) {
  const anchors = anchorsOf(html);
  const telLink = anchors.some((a) => /^tel:/i.test(a.href));
  const text = collapse(visibleHtml(html));
  const phoneShown = telLink || PHONE_RE.test(text);
  const contactLink = anchors.some((a) => isContactHref(a.href) || CONTACT_WORDS.test(a.text));
  const form = contactForms(visibleHtml(html));
  return { telLink, phoneShown, contactLink: contactLink || form };
}

export default { pageChecks, anchorsOf, securityHeaderChecks, contactChecks, jsonLdTypes, decodeEntities, attrsOf, SECURITY_HEADERS };
