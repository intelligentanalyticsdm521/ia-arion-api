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
// page costs one pass per scan whatever it holds. Start tags are read by one
// forward walk (scanTags) that never goes back, and attributes by a loop, not a
// regex (reviewer finding, 8 Oct 2026: unfinished tags made that quadratic).
// Only the first 512 KB of a page, 20,000 tags and 4 KB of any one tag are read.

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

/** The longest start tag we read. A real one is a few hundred characters; a longer one is cut here. */
export const MAX_TAG = 4 * 1024;

/** The most start tags we read on one page. A busy real page has a few thousand; past this the rest is not read. */
export const MAX_TAGS = 20_000;

/** a-z 0-9 _ as char codes (the page is already lower-cased). */
const [LT, GT, DQ, SQ, EQ] = ['<', '>', '"', "'", '='].map((x) => x.charCodeAt(0));
const isSpaceCode = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
const isNameCode = (c) => (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95;

/**
 * Every start tag on the page, in ONE pass: [{ start, end, name, tag }] with
 * `end` just after the tag. The scan never goes back: a tag runs to its '>'
 * (a '>' inside a quoted value does not end it), to the next '<' when it is
 * never finished (as `<meta <meta …` is), or to MAX_TAG characters, and the
 * next tag is looked for only after it. So an opener inside a tag is not a
 * tag, and a page of `<meta ` with one far '>' costs one walk, not one walk
 * per opener (reviewer finding, 7 Oct 2026: 174 s for 256 KB). A tag the page
 * ends in the middle of is not a tag.
 */
function scanTags(html, lower) {
  const out = [];
  const n = lower.length;
  let pos = 0;
  while (out.length < MAX_TAGS) {
    const lt = lower.indexOf('<', pos);
    if (lt < 0) break;
    const limit = Math.min(n, lt + MAX_TAG);
    let j = lt + 1;
    while (j < limit && isNameCode(lower.charCodeAt(j))) j += 1;
    if (j === lt + 1) { pos = lt + 1; continue; } // '</', '<!', '< ' or a lone '<': not a start tag
    let end = -1;
    let quote = 0; // the char code of the quote we are inside, or 0
    let afterEquals = false;
    let k = j;
    for (; k < limit; k += 1) {
      const c = lower.charCodeAt(k);
      if (quote) { if (c === quote) quote = 0; continue; }
      if (c === GT) { end = k + 1; break; }
      if (c === LT) { end = k; break; } // never finished: it ends where the next tag starts
      if ((c === DQ || c === SQ) && afterEquals) { quote = c; afterEquals = false; continue; }
      if (c === EQ) afterEquals = true;
      else if (!isSpaceCode(c)) afterEquals = false;
    }
    if (end < 0) {
      if (k >= n) break; // the page ends inside this tag
      end = limit; // MAX_TAG reached: the tag is cut here
    }
    out.push({ start: lt, end, name: lower.slice(lt + 1, j), tag: html.slice(lt, end) });
    pos = end;
  }
  return out;
}

const named = (tags, name) => tags.filter((t) => t.name === name);

/** Every `<name …>inner</name>`: [{ tag, inner, end }]. An opener with no closer is skipped. */
function blocks(html, lower, name, tags = scanTags(html, lower)) {
  const out = [];
  const nextClose = finder(lower, `</${name}`);
  let from = 0;
  for (const t of named(tags, name)) {
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

const isAlnumCode = (c) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57);
const SLASH = 47;

/**
 * Attributes of one start tag as a lower-cased map, read in one pass over at
 * most MAX_TAG characters (no regular expression: a value whose quote never
 * closes runs to the end of the tag once, not once per attribute).
 */
export function attrsOf(tag) {
  const out = {};
  let s = String(tag || '').slice(0, MAX_TAG);
  if (s.endsWith('>')) s = s.slice(0, -1);
  if (s.endsWith('/')) s = s.slice(0, -1);
  const n = s.length;
  let i = 0;
  if (s.charCodeAt(i) === LT) i += 1;
  while (i < n && isSpaceCode(s.charCodeAt(i))) i += 1;
  while (i < n && isAlnumCode(s.charCodeAt(i))) i += 1; // the tag's own name
  while (i < n) {
    while (i < n && (isSpaceCode(s.charCodeAt(i)) || s.charCodeAt(i) === SLASH)) i += 1;
    if (i >= n) break;
    const nameStart = i;
    i += 1; // a name is at least one character, even '='
    for (let c = s.charCodeAt(i); i < n && !isSpaceCode(c) && c !== SLASH && c !== EQ; c = s.charCodeAt(i)) i += 1;
    const name = s.slice(nameStart, i).toLowerCase();
    let j = i;
    while (j < n && isSpaceCode(s.charCodeAt(j))) j += 1;
    let value = '';
    if (s.charCodeAt(j) === EQ) {
      j += 1;
      while (j < n && isSpaceCode(s.charCodeAt(j))) j += 1;
      const q = s.charCodeAt(j);
      if (q === DQ || q === SQ) {
        const close = s.indexOf(s[j], j + 1);
        value = s.slice(j + 1, close < 0 ? n : close);
        j = close < 0 ? n : close + 1;
      } else {
        const vs = j;
        while (j < n && !isSpaceCode(s.charCodeAt(j))) j += 1;
        value = s.slice(vs, j);
      }
      i = j;
    }
    out[name] = value.includes('&') ? decodeEntities(value) : value;
  }
  return out;
}

const capped = (html) => String(html || '').slice(0, MAX_HTML);


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
  const lower = asciiLower(raw);
  return typesIn(raw, lower, scanTags(raw, lower));
}

function typesIn(raw, lower, tags) {
  const types = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const t = node['@type'];
    (Array.isArray(t) ? t : [t]).filter(Boolean).forEach((x) => types.add(String(x).slice(0, 100)));
    if (node['@graph']) walk(node['@graph']);
  };
  for (const b of blocks(raw, lower, 'script', tags)) {
    if (!/^application\/ld\+json$/i.test(String(attrsOf(b.tag).type || '').trim())) continue;
    try { walk(JSON.parse(b.inner.trim())); } catch { /* a broken block simply has no types */ }
  }
  return [...types];
}

const BUSINESS_TYPES = /^(LocalBusiness|Organization|Corporation|ProfessionalService|HomeAndConstructionBusiness|Store|Restaurant|.*Business|.*Service|.*Contractor|Plumber|Electrician|Dentist|Attorney|LegalService|AutoRepair|HVACBusiness|RoofingContractor|GeneralContractor)$/;

/** One page's facts. */
export function pageChecks(html) {
  const raw = capped(html);
  const lower = asciiLower(raw);
  const rawTags = scanTags(raw, lower); // one walk of the page answers every question below
  const vis = visibleHtml(raw);
  const visTags = vis === raw ? rawTags : scanTags(vis, asciiLower(vis)); // nothing was cut: the same walk
  const tagsOf = (tags, name) => named(tags, name).map((t) => t.tag);
  const titleBlock = blocks(raw, lower, 'title', rawTags)[0];
  const title = titleBlock ? collapse(titleBlock.inner) : '';
  const metas = tagsOf(rawTags, 'meta').map(attrsOf);
  const description = (metas.find((a) => (a.name || '').toLowerCase() === 'description')?.content || '').trim();
  const viewport = metas.some((a) => (a.name || '').toLowerCase() === 'viewport' && a.content);
  const canonical = tagsOf(rawTags, 'link').map(attrsOf)
    .some((a) => String(a.rel || '').toLowerCase().split(/\s+/).includes('canonical') && a.href);
  const h1Count = tagsOf(visTags, 'h1').length;
  const imgs = tagsOf(visTags, 'img').map(attrsOf);
  // alt="" is a deliberate "decorative" mark and is fine; a MISSING alt is not.
  const imagesWithoutAlt = imgs.filter((a) => !Object.prototype.hasOwnProperty.call(a, 'alt')).length;
  const types = typesIn(raw, lower, rawTags);
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
  return anchorsIn(visibleHtml(html));
}

function anchorsIn(vis) {
  const out = [];
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

/**
 * A form a visitor can reach the business with: an email or phone box, or a
 * message box. Not a search box. One pass over the page's tags: a form runs
 * to its </form>, or to the next <form> when it is never closed, so a page of
 * unclosed forms is not re-read once per form (reviewer finding, 7 Oct 2026:
 * 30 s for 512 KB of "<form>").
 */
function contactForms(html) {
  const lower = asciiLower(html);
  const nextClose = finder(lower, '</form');
  let formEnd = -1; // where the open contact-capable form stops; -1 = none open
  for (const t of scanTags(html, lower)) {
    if (t.name === 'form') {
      const search = String(attrsOf(t.tag).role || '').toLowerCase() === 'search';
      const close = nextClose(t.end);
      formEnd = search ? -1 : (close < 0 ? lower.length : close);
      continue;
    }
    if (formEnd < 0 || t.start >= formEnd) { formEnd = -1; continue; }
    if (t.name === 'textarea') return true;
    if (t.name === 'input' && /^(?:email|tel)$/i.test(String(attrsOf(t.tag).type || '').trim())) return true;
  }
  return false;
}

/** Can a visitor see how to get in touch from the home page? */
export function contactChecks(html) {
  const vis = visibleHtml(html); // read once, asked three questions
  const anchors = anchorsIn(vis);
  const telLink = anchors.some((a) => /^tel:/i.test(a.href));
  const text = collapse(vis);
  const phoneShown = telLink || PHONE_RE.test(text);
  const contactLink = anchors.some((a) => isContactHref(a.href) || CONTACT_WORDS.test(a.text));
  const form = contactForms(vis);
  return { telLink, phoneShown, contactLink: contactLink || form };
}

export default { pageChecks, anchorsOf, securityHeaderChecks, contactChecks, jsonLdTypes, decodeEntities, attrsOf, SECURITY_HEADERS };
