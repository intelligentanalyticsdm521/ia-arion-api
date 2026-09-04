/**
 * Adoption — turning a section somebody built on the website itself into one
 * the Portal editor can look after.
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * Five client sites exist today and not one section on them carries an `ia:`
 * handle, so the editor shows every one of them as "Custom section — built on
 * the site", greyed, read-only, round-tripped byte for byte. That is honest,
 * and it is also the reason a client on one of those sites cannot change a
 * word of their own home page from the Portal.
 *
 * Adoption is the offer to fix that, one section at a time:
 *
 *   1. READ the section and work out what kind of section it is and what it
 *      says. Best effort — this file guesses, and it says how sure it is.
 *   2. RE-EMIT it through the ordinary adapter, so the result is a section the
 *      editor already knows how to read, patch and preview.
 *   3. SHOW the client both, side by side, before anything is written.
 *   4. Only on an explicit tap does it reach the website, through the SAME
 *      save path as every other edit — snapshot, Undo, cache purge.
 *
 * THE RULES THIS FILE OBEYS (SCOPE_ARION_SITE_BUILDER_2026-09-05 §3.9, W-5)
 *
 *   - Nothing is adopted automatically. Ever.
 *   - Analysis NEVER modifies the tree it is given. Every function here is
 *     pure; the only thing that writes is the route, through `writePageSections`.
 *   - Re-emitting REPLACES the section's own layout with the standard one for
 *     its kind. That is a real change and the client is told so in plain words
 *     and shown it before/after — never discovered afterwards.
 *   - A section we are not sure about, or one carrying something we cannot
 *     carry over, is NOT offered. It stays greyed with the reason spelled out.
 *     "Rebuild this page from the library" is the honest fallback (§3.9.4).
 *   - The original bytes are kept, so "Undo adoption" restores them exactly.
 *
 * WHAT "BEST EFFORT" MEANS HERE, PRECISELY
 *
 * The confidence a section gets is two numbers multiplied out: how well its
 * widget signature matches an archetype we can emit, and how much of that
 * archetype's content we actually found. Below `ADOPT_MIN_CONFIDENCE` the
 * answer is "we are not sure", which is a better answer than a wrong guess
 * that rewrites somebody's live page.
 */

import {
  CODECS, purposeFromCssClass, sectionKindMeta,
  extractFields, applyFields, reduceToSectionList, validateFields,
} from './sectionSchema.js';
import { blockToElementorSection, FormRecipientError } from './elementorAdapter.js';
import { starterBlock } from './starterSections.js';

/* ==========================================================================
 * Thresholds
 * ======================================================================== */

/**
 * Below this, a section is not offered for adoption at all.
 *
 * 0.62 is chosen so that a section matching an archetype's signature cleanly
 * (0.85+ structural) but missing half its optional copy still clears, while a
 * section that merely *contains a heading* does not. The fixtures in
 * `test/site-builder-adoption.test.mjs` pin both sides of that line.
 */
export const ADOPT_MIN_CONFIDENCE = 0.62;

/** Adoptions can be undone from the Portal for this long (SCOPE §3.9, W-5). */
export const ADOPT_UNDO_DAYS = 30;

/** The blueprint segment an adopted section's handle carries: ia:<kind>:adopted:<id>. */
export const ADOPTED_BLUEPRINT = 'adopted';

/* ==========================================================================
 * 1. Reading an Elementor node
 * ======================================================================== */

/**
 * What to call a widget in front of a client. Never "text-editor", never
 * "icon-box" — those are Elementor's words, and a client should not have to
 * learn them to understand why a section cannot be adopted.
 */
const WIDGET_LABELS = Object.freeze({
  heading: 'a heading',
  'theme-page-title': 'the page title',
  'theme-post-title': 'the page title',
  'text-editor': 'a paragraph',
  'theme-post-content': 'the page content',
  button: 'a button',
  image: 'a picture',
  'image-box': 'a picture with a caption',
  'icon-box': 'an icon card',
  'icon-list': 'a list',
  'image-gallery': 'a picture gallery',
  gallery: 'a picture gallery',
  accordion: 'a drop-down list',
  toggle: 'a drop-down list',
  tabs: 'a set of tabs',
  form: 'a form',
  testimonial: 'a customer quote',
  'testimonial-carousel': 'a scrolling set of quotes',
  video: 'a video',
  google_maps: 'a map',
  html: 'custom code',
  shortcode: 'a shortcode',
  counter: 'a counter',
  'progress-tracker': 'a progress bar',
  progress: 'a progress bar',
  'star-rating': 'a star rating',
  'social-icons': 'social links',
  icon: 'an icon',
  'price-table': 'a price table',
  'price-list': 'a price list',
  countdown: 'a countdown',
  'nav-menu': 'a menu',
  'call-to-action': 'a call-to-action block',
  'flip-box': 'a flip card',
  divider: 'a divider',
  spacer: 'a space',
});

export function widgetLabel(type) {
  const t = String(type || '').trim();
  if (WIDGET_LABELS[t]) return WIDGET_LABELS[t];
  if (t.startsWith('theme-')) return 'a theme element';
  if (t.startsWith('wp-widget-')) return 'a WordPress widget';
  if (!t) return 'something';
  return `a ${t.replace(/[-_]+/g, ' ')} block`;
}

function txt(v) {
  return String(v == null ? '' : v).trim();
}

function plain(html) {
  return CODECS.html_text.decode(html);
}

function paragraphs(html) {
  return CODECS.html_paragraphs.decode(html);
}

function dotted(obj, path) {
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * The wrapper children a section repeats — the columns or containers that hold
 * one card each. Descends through single-child wrappers, because a container
 * layout wraps its row in another container and a classic layout does not.
 */
function repeatGroups(node) {
  let cur = node;
  for (let guard = 0; guard < 6; guard += 1) {
    const kids = (Array.isArray(cur?.elements) ? cur.elements : [])
      .filter((k) => k && typeof k === 'object' && k.elType !== 'widget');
    if (kids.length >= 2) return kids;
    if (kids.length === 1) { cur = kids[0]; continue; }
    return [];
  }
  return [];
}

/**
 * Every widget under a node, in document order, tagged with which repeat group
 * it sits in.
 *
 * ONE walk, deliberately. Walking twice — once for the flat list and once per
 * group — produces two sets of descriptor objects for the same widgets, and
 * the `used` set that stops a widget being reported as unmapped is keyed by
 * object identity. Every widget consumed through a group then looked unused to
 * the flat list and vice versa, so a services row mapped its cards AND
 * reported the very same cards as content it could not carry. Caught by
 * running the mapper over a fixture tree, which is the only thing that could
 * have caught it.
 */
function widgetsUnder(node, groupOf = null) {
  const out = [];
  const walk = (n, depth, groupIndex) => {
    if (!n || typeof n !== 'object') return;
    const g = (groupOf && groupOf.has(n)) ? groupOf.get(n) : groupIndex;
    if (n.elType === 'widget') {
      out.push({
        widgetType: String(n.widgetType || ''),
        settings: (n.settings && typeof n.settings === 'object') ? n.settings : {},
        depth,
        groupIndex: g,
        order: out.length,
      });
    }
    if (Array.isArray(n.elements)) n.elements.forEach((c) => walk(c, depth + 1, g));
  };
  if (Array.isArray(node?.elements)) node.elements.forEach((c) => walk(c, 1, null));
  return out;
}

/**
 * Everything the mapper needs to know about one section, read once.
 * Pure: the node is never touched.
 */
export function readCensus(node) {
  const settings = (node?.settings && typeof node.settings === 'object') ? node.settings : {};
  const groupNodes = repeatGroups(node);
  const groupOf = new Map(groupNodes.map((g, i) => [g, i]));
  const widgets = widgetsUnder(node, groupOf);
  const groups = groupNodes.map((_, i) => ({
    index: i,
    widgets: widgets.filter((w) => w.groupIndex === i),
  }));

  const byType = new Map();
  for (const w of widgets) {
    if (!byType.has(w.widgetType)) byType.set(w.widgetType, []);
    byType.get(w.widgetType).push(w);
  }

  const bgUrl = txt(dotted(settings, 'background_image.url'));
  const bgId = CODECS.attachment_id.decode(dotted(settings, 'background_image.id'));

  return {
    settings,
    widgets,
    groups,
    byType,
    /** All widget types present, sorted — this is what the plugin mirrors. */
    widgetTypes: [...new Set(widgets.map((w) => w.widgetType))].filter(Boolean).sort(),
    background: { url: bgUrl, id: bgId },
    has(type) { return (byType.get(type) || []).length; },
    all(type) { return byType.get(type) || []; },
    first(type) { return (byType.get(type) || [])[0] || null; },
  };
}

/* ==========================================================================
 * 2. What one widget is carrying
 * ======================================================================== */

/**
 * The visible content of a widget, whatever kind it is. Used for two things:
 * mapping it into a field, and deciding whether losing it would lose something
 * a visitor can see.
 */
export function widgetContent(w) {
  const s = w?.settings || {};
  switch (w?.widgetType) {
    case 'heading':
    case 'theme-page-title':
    case 'theme-post-title':
      return { text: plain(s.title) };
    case 'text-editor':
    case 'theme-post-content':
      return { text: plain(s.editor), paragraphs: paragraphs(s.editor) };
    case 'button':
      return { text: txt(s.text), url: txt(dotted(s, 'link.url')) };
    case 'image':
      return {
        url: txt(dotted(s, 'image.url')),
        id: CODECS.attachment_id.decode(dotted(s, 'image.id')),
        text: txt(dotted(s, 'image.alt')),
      };
    case 'image-box':
      return {
        text: plain(s.title_text),
        body: plain(s.description_text),
        url: txt(dotted(s, 'image.url')),
        id: CODECS.attachment_id.decode(dotted(s, 'image.id')),
      };
    case 'icon-box':
      return {
        text: plain(s.title_text),
        body: plain(s.description_text),
        icon: CODECS.fa_icon.decode(dotted(s, 'selected_icon.value')),
      };
    case 'icon-list': {
      const rows = Array.isArray(s.icon_list) ? s.icon_list : [];
      return { rows, text: rows.map((r) => txt(r?.text)).filter(Boolean).join(' · ') };
    }
    case 'accordion':
    case 'toggle': {
      const rows = Array.isArray(s.tabs) ? s.tabs : [];
      return { rows, text: rows.map((r) => txt(r?.tab_title)).filter(Boolean).join(' · ') };
    }
    case 'image-gallery':
    case 'gallery': {
      const rows = Array.isArray(s.gallery) ? s.gallery : [];
      return { rows, text: rows.length ? `${rows.length} pictures` : '' };
    }
    case 'form':
      return {
        rows: Array.isArray(s.form_fields) ? s.form_fields : [],
        text: txt(s.form_name) || 'form',
        form: s,
      };
    case 'testimonial':
      return {
        text: plain(s.testimonial_content),
        name: txt(s.testimonial_name),
        role: txt(s.testimonial_job),
        url: txt(dotted(s, 'testimonial_image.url')),
      };
    case 'video':
      return { url: txt(s.youtube_url) || txt(dotted(s, 'hosted_url.url')), text: txt(s.video_title) };
    case 'google_maps':
      return { text: txt(s.address) };
    case 'html':
      return { text: txt(s.html).slice(0, 400) };
    case 'shortcode':
      return { text: txt(s.shortcode) };
    case 'counter':
      return { text: [txt(s.title), txt(s.ending_number)].filter(Boolean).join(' ') };
    case 'star-rating':
      return { text: txt(s.rating) ? `${s.rating} stars` : '' };
    case 'divider':
      // Elementor's divider draws words through the line when `look` is
      // `line_text`. A plain rule carries nothing and must not block an
      // adoption; one with words through it carries content and must.
      return { text: /text/i.test(String(s.look || '')) ? txt(s.text) : '' };
    case 'spacer':
    case 'menu-anchor':
    case 'sidebar':
      return { text: '' };
    default: {
      const guess = plain(s.title) || plain(s.editor) || txt(s.text) || txt(s.title_text) || txt(dotted(s, 'image.url'));
      return { text: txt(guess) };
    }
  }
}

/**
 * Would dropping this widget lose something a visitor can see?
 *
 * ONE rule, deliberately: does it carry any text, any address, or any rows.
 * There used to be a hand-kept list of "decorative" widget types in front of
 * this, and mutation-testing showed it was dead — every type on it already
 * extracted to nothing — while quietly hiding the one case where it was
 * WRONG, a divider with words drawn through it.
 */
export function carriesContent(w) {
  const c = widgetContent(w);
  if (txt(c.text)) return true;
  if (txt(c.url)) return true;
  if (Array.isArray(c.rows) && c.rows.length > 0) return true;
  return false;
}

/** A one-line description of an unmapped widget, for the Portal to show. */
function unmappedEntry(w) {
  const c = widgetContent(w);
  const preview = txt(c.text).slice(0, 90);
  return {
    widgetType: w.widgetType,
    label: widgetLabel(w.widgetType),
    carriesContent: carriesContent(w),
    preview,
  };
}

/* ==========================================================================
 * 3. Which archetype is this?
 *
 * Each signature scores 0..1 on structure alone. The winner is the highest
 * score; ties break toward the earlier (more specific) entry.
 * ======================================================================== */

const HEADING_TYPES = Object.freeze(['heading', 'theme-page-title', 'theme-post-title']);
const COPY_TYPES = Object.freeze(['text-editor', 'theme-post-content']);

function headings(c) {
  return HEADING_TYPES.flatMap((t) => c.all(t)).sort((a, b) => a.order - b.order);
}
function copies(c) {
  return COPY_TYPES.flatMap((t) => c.all(t)).sort((a, b) => a.order - b.order);
}

const SIZE_RANK = Object.freeze({ h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 });

function headingRank(w) {
  const tag = String(w?.settings?.header_size || '').toLowerCase();
  const byTag = SIZE_RANK[tag];
  if (byTag) return byTag;
  // No tag set: fall back to Elementor's visual size control.
  const size = String(w?.settings?.size || '').toLowerCase();
  if (size === 'xxl') return 1;
  if (size === 'xl') return 1.5;
  if (size === 'large') return 2.5;
  if (size === 'medium') return 3.5;
  if (size === 'small') return 4.5;
  return 3; // an untagged heading sits with the h3s
}

/** The biggest heading in the section, earliest wins a tie. */
function primaryHeading(c, used = null) {
  const hs = headings(c).filter((w) => !used || !used.has(w));
  if (hs.length === 0) return null;
  return hs.slice().sort((a, b) => (headingRank(a) - headingRank(b)) || (a.order - b.order))[0];
}

function looksLikeQuote(w) {
  const raw = String(w?.settings?.editor || '');
  if (/<blockquote/i.test(raw)) return true;
  if (/class="ia-rating"/i.test(raw)) return true;
  const t = plain(raw);
  return /^[“"']/.test(t) && t.length > 20;
}

const QUOTE_WORDS = /(testimonial|review|what (?:our )?(?:customers?|clients?|people) say|kind words)/i;
const FAQ_WORDS = /(faq|frequently asked|questions?( we get)?|q\s*&\s*a)/i;
const ABOUT_WORDS = /(about (us|our|the)|our story|who we are|meet the)/i;
const GALLERY_WORDS = /(gallery|our work|portfolio|recent (jobs|projects)|photos)/i;
const CONTACT_WORDS = /(contact|get in touch|reach us|enquir|inquir|message us)/i;

function headlineText(c) {
  const h = primaryHeading(c);
  return h ? widgetContent(h).text : '';
}

/**
 * The signature table. Order matters only for ties: the more specific tests
 * are first, so "it has a form widget" beats "it has a heading and a button".
 */
const SIGNATURES = Object.freeze([
  {
    kind: 'contact',
    score(c) {
      if (c.has('form')) return { score: 0.95, why: 'it has a form on it' };
      const list = c.first('icon-list');
      if (list && CONTACT_WORDS.test(headlineText(c))) {
        return { score: 0.7, why: 'it is headed like a contact section and lists ways to reach you' };
      }
      return null;
    },
  },
  {
    kind: 'faq',
    score(c) {
      if (c.has('accordion') || c.has('toggle')) return { score: 0.92, why: 'it is a drop-down list of questions' };
      if (FAQ_WORDS.test(headlineText(c)) && copies(c).length >= 2 && headings(c).length >= 3) {
        return { score: 0.66, why: 'it is headed like a questions section and repeats question-and-answer pairs' };
      }
      return null;
    },
  },
  {
    kind: 'gallery',
    score(c) {
      if (c.has('image-gallery') || c.has('gallery')) return { score: 0.9, why: 'it is a picture gallery' };
      const imgs = c.all('image');
      if (imgs.length >= 4) return { score: 0.78, why: `it is a grid of ${imgs.length} pictures` };
      if (imgs.length >= 3 && GALLERY_WORDS.test(headlineText(c))) {
        return { score: 0.7, why: 'it is headed like a gallery and shows several pictures' };
      }
      return null;
    },
  },
  {
    kind: 'testimonials',
    score(c) {
      const t = c.all('testimonial').length + c.all('testimonial-carousel').length;
      if (t >= 1) return { score: 0.9, why: 'it holds customer quotes' };
      const quotes = copies(c).filter(looksLikeQuote);
      if (quotes.length >= 2) return { score: 0.8, why: `it holds ${quotes.length} quotes` };
      if (quotes.length === 1 && QUOTE_WORDS.test(headlineText(c))) {
        return { score: 0.72, why: 'it is headed like a reviews section and holds a quote' };
      }
      if (QUOTE_WORDS.test(headlineText(c)) && c.groups.length >= 2) {
        return { score: 0.64, why: 'it is headed like a reviews section' };
      }
      return null;
    },
  },
  {
    kind: 'services',
    score(c) {
      const boxes = c.all('icon-box').length + c.all('image-box').length;
      if (boxes >= 2) return { score: 0.88, why: `it is a row of ${boxes} cards` };
      // The Astra/Elementor hand-built shape: N sibling columns, each with its
      // own small heading and a paragraph under it.
      const cards = c.groups.filter((g) => {
        const h = g.widgets.filter((w) => HEADING_TYPES.includes(w.widgetType)).length;
        const p = g.widgets.filter((w) => COPY_TYPES.includes(w.widgetType)).length;
        return h === 1 && p >= 1 && g.widgets.length <= 4;
      });
      if (cards.length >= 3) return { score: 0.76, why: `it is ${cards.length} matching columns of heading and text` };
      if (cards.length === 2) return { score: 0.64, why: 'it is two matching columns of heading and text' };
      return null;
    },
  },
  {
    kind: 'about',
    score(c) {
      const img = c.all('image').length;
      const copy = copies(c);
      const paras = copy.reduce((n, w) => n + widgetContent(w).paragraphs.length, 0);
      if (img === 1 && paras >= 2) return { score: 0.8, why: 'it is a picture beside several paragraphs of story' };
      if (ABOUT_WORDS.test(headlineText(c)) && paras >= 2) {
        return { score: 0.72, why: 'it is headed like an about section and holds several paragraphs' };
      }
      if (img === 1 && paras === 1 && ABOUT_WORDS.test(headlineText(c))) {
        return { score: 0.66, why: 'it is headed like an about section, with a picture and a paragraph' };
      }
      return null;
    },
  },
  {
    kind: 'hero',
    score(c) {
      const h = primaryHeading(c);
      if (!h) return null;
      const big = headingRank(h) <= 1.5;
      const buttons = c.all('button').length;
      const copy = copies(c).length;
      const imgs = c.all('image').length;
      const bg = !!c.background.url;
      if (big && buttons <= 2 && copy <= 1 && imgs === 0) {
        return { score: bg ? 0.86 : 0.8, why: bg ? 'it is one big headline over a background picture' : 'it is one big headline with a button' };
      }
      if (bg && buttons >= 1 && copy <= 1 && imgs === 0 && headings(c).length === 1) {
        return { score: 0.74, why: 'it is a headline and a button over a background picture' };
      }
      return null;
    },
  },
  {
    kind: 'cta',
    score(c) {
      const buttons = c.all('button').length;
      const hs = headings(c);
      if (buttons >= 1 && hs.length === 1 && copies(c).length <= 1 && c.all('image').length === 0) {
        return { score: buttons >= 2 ? 0.78 : 0.7, why: buttons >= 2 ? 'it is a headline with two buttons' : 'it is a headline with a button' };
      }
      return null;
    },
  },
]);

/** Every archetype this section could be, best first. */
export function candidateKinds(census) {
  const out = [];
  SIGNATURES.forEach((sig, i) => {
    const hit = sig.score(census);
    if (hit && hit.score > 0) out.push({ kind: sig.kind, score: hit.score, why: hit.why, tie: i });
  });
  return out.sort((a, b) => (b.score - a.score) || (a.tie - b.tie));
}

/* ==========================================================================
 * 4. Pulling the fields out
 *
 * Each mapper returns { fields, confidence: {key: 0..1}, used: Set(widget) }.
 * `used` is what stops a widget being reported as unmapped.
 * ======================================================================== */

const SURE = 1;      // read straight out of the widget the binding would use
const LIKELY = 0.75; // read out of a near-enough widget (a heading where a
                     // sub-heading was expected, a paragraph used as a story)
const GUESS = 0.5;   // inferred from position or wording alone

function pickHeadline(c, used, conf, fields) {
  const h = primaryHeading(c, used);
  if (h) {
    fields.headline = widgetContent(h).text;
    conf.headline = SURE;
    used.add(h);
    return h;
  }
  conf.headline = 0;
  return null;
}

/**
 * The supporting line. The schema's `subheadline` is always a short paragraph,
 * so a paragraph that runs long is story, not a sub-heading — taking it would
 * truncate somebody's copy into a field with a 400-character cap.
 */
function pickSubheadline(c, used, conf, fields, { maxChars = 400 } = {}) {
  const cands = copies(c).filter((w) => !used.has(w));
  for (const w of cands) {
    const content = widgetContent(w);
    if (!content.text) continue;
    if (content.paragraphs.length > 1) continue;
    if (content.text.length > maxChars) continue;
    fields.subheadline = content.text;
    conf.subheadline = SURE;
    used.add(w);
    return w;
  }
  // A second, smaller heading reads as a supporting line often enough to try.
  const hs = headings(c).filter((w) => !used.has(w));
  if (hs.length > 0) {
    const t = widgetContent(hs[0]).text;
    if (t && t.length <= maxChars) {
      fields.subheadline = t;
      conf.subheadline = LIKELY;
      used.add(hs[0]);
      return hs[0];
    }
  }
  return null;
}

function pickButton(c, used, conf, fields, textKey, hrefKey) {
  const b = c.all('button').filter((w) => !used.has(w))[0];
  if (!b) return null;
  const content = widgetContent(b);
  fields[textKey] = content.text;
  fields[hrefKey] = content.url || '#contact';
  conf[textKey] = SURE;
  conf[hrefKey] = content.url ? SURE : GUESS;
  used.add(b);
  return b;
}

const MAPPERS = Object.freeze({
  hero(c, used, conf) {
    const fields = {};
    pickHeadline(c, used, conf, fields);
    pickSubheadline(c, used, conf, fields);
    pickButton(c, used, conf, fields, 'cta_text', 'cta_href');
    if (c.background.url) {
      fields.image_url = c.background.url;
      fields.image_id = c.background.id;
      conf.image_url = SURE;
    }
    return fields;
  },

  services(c, used, conf) {
    const fields = {};

    // The CARDS come out first, and only then the section's own headline.
    // Doing it the other way round takes the first card's heading as the
    // section headline on a row that has no heading of its own, which then
    // reports that card's paragraph as content we cannot carry.
    const boxes = [...c.all('icon-box'), ...c.all('image-box')].sort((a, b) => a.order - b.order);
    if (boxes.length >= 2) {
      fields.services = boxes.map((w) => {
        used.add(w);
        const content = widgetContent(w);
        return {
          title: content.text,
          description: content.body || '',
          icon_name: content.icon || 'check',
        };
      });
      conf.services = SURE;
    } else {
      // The matching-columns shape: N sibling wrappers, one heading and at
      // least one paragraph in each.
      const cards = c.groups
        .map((g) => {
          const hs = g.widgets.filter((w) => HEADING_TYPES.includes(w.widgetType));
          const ps = g.widgets.filter((w) => COPY_TYPES.includes(w.widgetType));
          if (hs.length !== 1 || ps.length < 1 || g.widgets.length > 4) return null;
          return { h: hs[0], p: ps[0] };
        })
        .filter(Boolean);
      if (cards.length >= 2) {
        fields.services = cards.map(({ h, p }) => {
          used.add(h);
          if (p) used.add(p);
          return {
            title: widgetContent(h).text,
            description: p ? widgetContent(p).text : '',
            icon_name: 'check',
          };
        });
        conf.services = LIKELY;
      } else {
        conf.services = 0;
      }
    }

    pickHeadline(c, used, conf, fields);
    pickSubheadline(c, used, conf, fields);
    return fields;
  },

  testimonials(c, used, conf) {
    const fields = {};
    pickHeadline(c, used, conf, fields);

    const native = [...c.all('testimonial'), ...c.all('testimonial-carousel')].sort((a, b) => a.order - b.order);
    if (native.length > 0) {
      fields.testimonials = native.map((w) => {
        used.add(w);
        const content = widgetContent(w);
        return {
          quote: content.text,
          attribution: content.name || '',
          role: content.role || '',
          rating: 5,
        };
      });
      conf.testimonials = SURE;
      return fields;
    }

    const quotes = copies(c).filter((w) => !used.has(w) && looksLikeQuote(w));
    if (quotes.length > 0) {
      fields.testimonials = quotes.map((w) => {
        used.add(w);
        const raw = String(w.settings?.editor || '');
        const decoded = decodeQuoteish(raw);
        // A card that came from OUR own writer decodes exactly; a hand-built
        // blockquote gives us the words and nothing else, which is honest.
        return decoded;
      });
      conf.testimonials = quotes.every((w) => /class="ia-attribution"/i.test(String(w.settings?.editor || '')))
        ? SURE : LIKELY;
      return fields;
    }

    conf.testimonials = 0;
    pickSubheadline(c, used, conf, fields);
    return fields;
  },

  cta(c, used, conf) {
    const fields = {};
    pickHeadline(c, used, conf, fields);
    pickSubheadline(c, used, conf, fields);
    pickButton(c, used, conf, fields, 'primary_cta_text', 'primary_cta_href');
    const second = c.all('button').filter((w) => !used.has(w))[0];
    if (second) {
      const content = widgetContent(second);
      fields.secondary_cta_text = content.text;
      fields.secondary_cta_href = content.url || '#contact';
      conf.secondary_cta_text = SURE;
      used.add(second);
    }
    return fields;
  },

  about(c, used, conf) {
    const fields = {};
    pickHeadline(c, used, conf, fields);

    const img = c.all('image').filter((w) => !used.has(w))[0];
    if (img) {
      const content = widgetContent(img);
      fields.image_url = content.url;
      fields.image_id = content.id;
      fields.image_alt = content.text;
      conf.image_url = SURE;
      // A picture that is content needs a description, and adoption cannot
      // invent one. The route turns a missing description into a warning
      // rather than a silent blank, because `requiredWith` refuses the save.
      conf.image_alt = content.text ? SURE : 0;
      used.add(img);
    }

    // A short opener before the story reads as the supporting line.
    pickSubheadline(c, used, conf, fields, { maxChars: 200 });

    const story = [];
    for (const w of copies(c)) {
      if (used.has(w)) continue;
      story.push(...widgetContent(w).paragraphs);
      used.add(w);
    }
    if (story.length > 0) {
      fields.story_paragraphs = story.slice(0, 6);
      conf.story_paragraphs = SURE;
    } else {
      conf.story_paragraphs = 0;
    }

    const boxes = [...c.all('icon-box'), ...c.all('image-box')].filter((w) => !used.has(w));
    if (boxes.length > 0) {
      fields.values = boxes.map((w) => {
        used.add(w);
        const content = widgetContent(w);
        return { title: content.text, description: content.body || '' };
      });
      conf.values = SURE;
    }
    return fields;
  },

  faq(c, used, conf) {
    const fields = {};
    // Questions before the headline, for the same reason as services: on a
    // section with no heading of its own, taking the headline first eats the
    // first question.
    const acc = [...c.all('accordion'), ...c.all('toggle')].sort((a, b) => a.order - b.order);
    if (acc.length > 0) {
      const items = [];
      for (const w of acc) {
        used.add(w);
        for (const row of widgetContent(w).rows) {
          items.push({ question: plain(row?.tab_title), answer: plain(row?.tab_content) });
        }
      }
      fields.faqs = items.filter((i) => i.question);
      conf.faqs = fields.faqs.length > 0 ? SURE : 0;
    } else {
      // Heading/paragraph pairs, in order, is the hand-built FAQ shape.
      const pairs = [];
      const seq = c.widgets.filter((w) => !used.has(w)
        && (HEADING_TYPES.includes(w.widgetType) || COPY_TYPES.includes(w.widgetType)));
      for (let i = 0; i < seq.length - 1; i += 1) {
        if (!HEADING_TYPES.includes(seq[i].widgetType)) continue;
        if (!COPY_TYPES.includes(seq[i + 1].widgetType)) continue;
        pairs.push({ q: seq[i], a: seq[i + 1] });
        i += 1;
      }
      if (pairs.length >= 2) {
        fields.faqs = pairs.map(({ q, a }) => {
          used.add(q); used.add(a);
          return { question: widgetContent(q).text, answer: widgetContent(a).text };
        });
        conf.faqs = LIKELY;
      } else {
        conf.faqs = 0;
      }
    }

    pickHeadline(c, used, conf, fields);
    pickSubheadline(c, used, conf, fields);
    return fields;
  },

  gallery(c, used, conf) {
    const fields = {};
    pickHeadline(c, used, conf, fields);
    pickSubheadline(c, used, conf, fields);

    const grid = [...c.all('image-gallery'), ...c.all('gallery')][0];
    if (grid) {
      used.add(grid);
      const meta = Array.isArray(grid.settings?.ia_gallery_meta) ? grid.settings.ia_gallery_meta : [];
      fields.images = widgetContent(grid).rows.map((img, i) => ({
        url: txt(img?.url),
        id: CODECS.attachment_id.decode(img?.id),
        alt: txt(meta[i]?.alt),
        caption: txt(meta[i]?.caption),
        category: txt(meta[i]?.category),
      })).filter((i) => i.url);
      conf.images = fields.images.length > 0 ? SURE : 0;
      // A gallery whose pictures have no description cannot be saved as it
      // stands; say so rather than write a blank the validator refuses.
      conf.alt = fields.images.every((i) => i.alt) ? SURE : 0;
      return fields;
    }

    const imgs = c.all('image').filter((w) => !used.has(w));
    if (imgs.length > 0) {
      fields.images = imgs.map((w) => {
        used.add(w);
        const content = widgetContent(w);
        return { url: content.url, id: content.id, alt: content.text, caption: '', category: '' };
      }).filter((i) => i.url);
      conf.images = fields.images.length > 0 ? LIKELY : 0;
      conf.alt = fields.images.every((i) => i.alt) ? SURE : 0;
      return fields;
    }

    conf.images = 0;
    return fields;
  },

  contact(c, used, conf) {
    const fields = {};
    pickHeadline(c, used, conf, fields);
    pickSubheadline(c, used, conf, fields);

    const list = c.all('icon-list').filter((w) => !used.has(w))[0];
    if (list) {
      used.add(list);
      fields.contact_methods = widgetContent(list).rows.map((row) => {
        const text = txt(row?.text);
        const split = text.indexOf(': ');
        const icon = txt(dotted(row, 'selected_icon.value'));
        const kind = /phone/i.test(icon) ? 'phone'
          : /envelope|mail/i.test(icon) ? 'email'
          : /map|marker|location/i.test(icon) ? 'address'
          : /share|facebook|twitter|instagram|linkedin/i.test(icon) ? 'social'
          : 'other';
        return {
          kind,
          label: split >= 0 ? text.slice(0, split).trim() : (text || 'Contact'),
          value: split >= 0 ? text.slice(split + 2).trim() : '',
          href: txt(dotted(row, 'link.url')),
        };
      }).filter((m) => m.label);
      conf.contact_methods = SURE;
    }

    const form = c.first('form');
    if (form) {
      used.add(form);
      const s = form.settings || {};
      fields.form_purpose = purposeFromCssClass(s.form_css_class);
      // A purpose we had to fall back on is a GUESS, and the client is asked
      // to confirm it — it decides how every enquiry from here is filed.
      conf.form_purpose = s.form_css_class ? SURE : GUESS;
      // Only set the recipient when the form HAS one. Setting it to '' would
      // be written over the address the adapter resolves from the business
      // details — which is the one thing standing between a client and a form
      // that collects enquiries nobody ever reads (SCOPE §2.5).
      if (txt(s.email_to)) {
        fields.email_to = txt(s.email_to);
        conf.email_to = SURE;
      } else {
        conf.email_to = 0;
      }
      fields.submit_text = txt(s.button_text) || 'Send';
      conf.submit_text = s.button_text ? SURE : GUESS;
      fields.form_fields = (Array.isArray(s.form_fields) ? s.form_fields : [])
        .map((r) => txt(r?.field_label || r?.custom_id)).filter(Boolean);
      conf.form_fields = fields.form_fields.length > 0 ? SURE : 0;
    } else {
      conf.form_fields = 0;
    }
    return fields;
  },
});

/** Decode a quote-ish text-editor into a testimonial row, best effort. */
function decodeQuoteish(raw) {
  const rating = /aria-label="\s*(\d)\s*out of 5"/i.exec(raw);
  const quote = /<blockquote>[\s\S]*?<p>([\s\S]*?)<\/p>[\s\S]*?<\/blockquote>/i.exec(raw)
    || /<blockquote>([\s\S]*?)<\/blockquote>/i.exec(raw);
  const attrib = /class="ia-attribution"[^>]*>\s*<strong>([\s\S]*?)<\/strong>\s*(?:<br\s*\/?>)?([\s\S]*?)<\/p>/i.exec(raw);
  const cite = /<cite[^>]*>([\s\S]*?)<\/cite>/i.exec(raw);
  const body = quote ? plain(quote[1]) : plain(raw);
  return {
    quote: body.replace(/^[“"']|[”"']$/g, '').trim() || body,
    attribution: attrib ? plain(attrib[1]) : (cite ? plain(cite[1]) : ''),
    role: attrib ? plain(attrib[2]) : '',
    rating: rating ? CODECS.rating.decode(rating[1]) : 5,
  };
}

/* ==========================================================================
 * 5. The analysis
 * ======================================================================== */

/** Which of a kind's fields have to be found for adoption to be worth offering. */
const REQUIRED_FIELDS = Object.freeze({
  hero: ['headline'],
  services: ['headline', 'services'],
  testimonials: ['headline', 'testimonials'],
  cta: ['headline'],
  about: ['headline', 'story_paragraphs'],
  faq: ['headline', 'faqs'],
  gallery: ['headline', 'images'],
  contact: ['headline'],
});

/** Fields that lift confidence when found but do not sink it when absent. */
const BONUS_FIELDS = Object.freeze({
  hero: ['subheadline', 'cta_text', 'image_url'],
  services: ['subheadline'],
  testimonials: ['subheadline'],
  cta: ['subheadline', 'primary_cta_text'],
  about: ['subheadline', 'image_url', 'values'],
  faq: ['subheadline'],
  gallery: ['subheadline'],
  contact: ['contact_methods', 'form_fields'],
});

const REASON_TEXT = Object.freeze({
  no_match: 'We could not work out what kind of section this is, so we are leaving it exactly as it is. '
    + 'You can still ask us to change it, or build a new page from the ready-made layouts.',
  low_confidence: 'We are not confident enough about what this section is to take charge of it safely, '
    + 'so we are leaving it exactly as it is. You can ask us to change it instead.',
  would_lose_content: 'This section has something on it we cannot carry over, so taking charge of it '
    + 'would lose that. We are leaving it exactly as it is.',
  needs_pro: 'This section has a form on it. Forms need Elementor Pro, which this plan does not include, '
    + 'so we cannot take charge of it here.',
  empty: 'There is nothing on this section for the editor to take charge of.',
  already_ours: 'This section is already one you can edit here.',
});

function confidenceLabel(v) {
  if (v >= 0.85) return 'high';
  if (v >= ADOPT_MIN_CONFIDENCE) return 'fair';
  return 'low';
}

/**
 * Work out what one unstamped section is, and whether we should offer to take
 * charge of it. NEVER modifies `node`.
 *
 * @param {object} node   one top-level Elementor node (section or container)
 * @param {{ allowPro?: boolean }} [opts]
 * @returns {{
 *   kind: string|null, label: string|null, fields: object|null,
 *   unmapped: Array<object>, confidence: number, confidenceLabel: string,
 *   warnings: string[], adoptable: boolean, reason: string|null,
 *   reasonText: string|null, why: string|null, widgetTypes: string[],
 *   candidates: Array<{kind:string, score:number}>
 * }}
 */
export function analyseSection(node, opts = {}) {
  const allowPro = opts.allowPro !== false;
  const empty = {
    kind: null, label: null, fields: null, fieldConfidence: {}, needsInput: [],
    unmapped: [], confidence: 0,
    confidenceLabel: 'low', warnings: [], adoptable: false,
    reason: 'empty', reasonText: REASON_TEXT.empty, why: null,
    widgetTypes: [], candidates: [],
  };
  if (!node || typeof node !== 'object') return empty;

  const c = readCensus(node);
  if (c.widgets.length === 0 && !c.background.url) return { ...empty, widgetTypes: c.widgetTypes };

  const candidates = candidateKinds(c);
  if (candidates.length === 0) {
    return {
      ...empty,
      widgetTypes: c.widgetTypes,
      reason: 'no_match',
      reasonText: REASON_TEXT.no_match,
      unmapped: c.widgets.filter(carriesContent).map(unmappedEntry),
    };
  }

  const best = candidates[0];
  const meta = sectionKindMeta(best.kind);
  const used = new Set();
  const conf = {};
  const fields = MAPPERS[best.kind](c, used, conf);

  /* --- how much of the archetype did we actually find? ------------------ */
  const required = REQUIRED_FIELDS[best.kind] || [];
  const bonus = BONUS_FIELDS[best.kind] || [];
  const requiredScore = required.length === 0
    ? 1
    : required.reduce((sum, k) => sum + (conf[k] ?? 0), 0) / required.length;
  const bonusFound = bonus.filter((k) => (conf[k] ?? 0) > 0).length;
  const bonusScore = bonus.length === 0 ? 1 : bonusFound / bonus.length;

  // Structure carries the most weight: getting the KIND wrong is the failure
  // that rewrites somebody's page into the wrong shape. Coverage of the
  // required fields is next. Bonus fields only nudge.
  const confidence = Math.round(
    ((best.score * 0.5) + (requiredScore * 0.4) + (bonusScore * 0.1)) * 100,
  ) / 100;

  /* --- what would be left behind? --------------------------------------- */
  const unmapped = c.widgets.filter((w) => !used.has(w)).map(unmappedEntry);
  const losing = unmapped.filter((u) => u.carriesContent);

  /* --- plain-word warnings ---------------------------------------------- */
  const warnings = [];
  warnings.push('Its layout is replaced by the standard layout for this kind of section, '
    + 'so the wording and the pictures stay and the spacing and styling change.');
  if (best.kind === 'about' && fields.image_url && !fields.image_alt) {
    warnings.push('The picture has no description yet. Add one in the edit sheet before you publish — '
      + 'a picture that is part of the content needs one.');
  }
  if (best.kind === 'gallery' && (conf.alt ?? 1) === 0) {
    warnings.push('Some pictures have no description yet. Add them in the edit sheet before you publish.');
  }
  if (best.kind === 'contact' && (conf.form_purpose ?? 1) < SURE) {
    warnings.push('We had to guess what this form is for. Check "What is this form for?" before you publish — '
      + 'it decides how every enquiry from here is filed.');
  }
  if (Object.values(conf).some((v) => v > 0 && v < SURE)) {
    warnings.push('Some of the wording was matched by where it sits on the page rather than by what it is, '
      + 'so read the "after" side before you accept it.');
  }

  /* --- what the client has to fill in before this can be published ------- */
  //
  // A picture that is content needs a description, and adoption cannot invent
  // one — a made-up description is worse than none. The ordinary validator
  // already knows every such rule and already words them for a client, so ask
  // IT rather than writing a second list that can drift out of step. These do
  // NOT block adoption; the preview collects them and the adopt call carries
  // them back as `fixes`.
  const check = validateFields(best.kind, fields);
  const needsInput = check.ok ? [] : check.errors.map((e) => ({ field: e.field, message: e.message }));

  /* --- the decision ------------------------------------------------------ */
  let reason = null;
  if (meta?.requiresElementorPro && !allowPro) reason = 'needs_pro';
  else if (losing.length > 0) reason = 'would_lose_content';
  else if (confidence < ADOPT_MIN_CONFIDENCE) reason = 'low_confidence';

  return {
    kind: best.kind,
    label: meta?.label || best.kind,
    fields,
    fieldConfidence: conf,
    needsInput,
    unmapped,
    confidence,
    confidenceLabel: confidenceLabel(confidence),
    warnings,
    adoptable: reason === null,
    reason,
    reasonText: reason ? REASON_TEXT[reason] : null,
    why: best.why,
    widgetTypes: c.widgetTypes,
    candidates: candidates.map((x) => ({ kind: x.kind, score: x.score })),
  };
}

/* ==========================================================================
 * 6. Building the adopted section
 * ======================================================================== */

/**
 * The block payload that makes the adapter emit every widget this content
 * needs. The adapter skips a sub-heading widget when the block has no
 * sub-heading, so patching the fields in afterwards would silently drop it —
 * the block has to carry the content on the way IN.
 */
function blockFromFields(kind, fields, brand) {
  const base = starterBlock(kind, brand) || {};
  const f = fields || {};
  const merged = { ...base, blueprint_id: ADOPTED_BLUEPRINT, archetype: kind };

  const copyIfPresent = (keys) => {
    for (const k of keys) if (f[k] !== undefined && f[k] !== '') merged[k] = f[k];
  };

  copyIfPresent(['headline', 'subheadline']);

  switch (kind) {
    case 'hero':
      copyIfPresent(['cta_text', 'cta_href']);
      merged.background_style = f.image_url ? 'image' : (base.background_style || 'solid');
      break;
    case 'services':
      if (Array.isArray(f.services) && f.services.length > 0) merged.services = f.services;
      break;
    case 'testimonials':
      if (Array.isArray(f.testimonials) && f.testimonials.length > 0) merged.testimonials = f.testimonials;
      break;
    case 'cta':
      copyIfPresent(['primary_cta_text', 'primary_cta_href', 'secondary_cta_text', 'secondary_cta_href']);
      break;
    case 'about':
      if (Array.isArray(f.story_paragraphs) && f.story_paragraphs.length > 0) {
        merged.story_paragraphs = f.story_paragraphs;
      }
      if (Array.isArray(f.values) && f.values.length > 0) merged.values = f.values;
      merged.image_alt = f.image_alt || '';
      break;
    case 'faq':
      if (Array.isArray(f.faqs) && f.faqs.length > 0) merged.faqs = f.faqs;
      break;
    case 'gallery':
      merged.images = Array.isArray(f.images) ? f.images : [];
      break;
    case 'contact':
      if (Array.isArray(f.contact_methods)) merged.contact_methods = f.contact_methods;
      merged.form_purpose = f.form_purpose || 'lead';
      merged.form_config = {
        fields: (Array.isArray(f.form_fields) && f.form_fields.length > 0)
          ? f.form_fields
          : ['Name', 'Email', 'Phone', 'Message'],
        submit_text: f.submit_text || 'Send',
      };
      if (f.email_to) merged.email_to = f.email_to;
      break;
    default:
      break;
  }
  return merged;
}

/**
 * Merge the values the client typed in the preview ("this picture needs a
 * description") onto the mapped fields. Keys are either `image_alt` or
 * `images[2].alt` — exactly the paths `validateFields` reports, so the Portal
 * can hand back what it was asked for without translating anything.
 */
export function applyFixes(fields, fixes) {
  if (!fixes || typeof fixes !== 'object') return fields;
  const out = JSON.parse(JSON.stringify(fields || {}));
  for (const [path, value] of Object.entries(fixes)) {
    const m = /^([A-Za-z0-9_]+)\[(\d+)\]\.([A-Za-z0-9_]+)$/.exec(String(path));
    if (m) {
      const [, key, idx, sub] = m;
      if (!Array.isArray(out[key])) continue;
      const i = Number(idx);
      if (i < 0 || i >= out[key].length) continue;
      out[key][i] = { ...(out[key][i] || {}), [sub]: value };
      continue;
    }
    if (/^[A-Za-z0-9_]+$/.test(String(path))) out[path] = value;
  }
  return out;
}

/**
 * Re-emit an analysed section as one the editor owns.
 *
 * The result goes through `reduceToSectionList` before it is returned, which
 * is the same read the Portal will do — if that read cannot edit it, the
 * client is not getting it (assert the wanted output APPEARS,
 * `feedback_assert_presence_not_just_absence`).
 *
 * @returns {{ ok:true, node:object, kind:string, handle:string, fields:object,
 *             blockId:string, dropped:string[] }
 *         | { ok:false, code:string, message:string, errors?:Array }}
 */
export function buildAdoptedSection({ analysis, brand = {}, blockId, fixes = null, validate = false }) {
  if (!analysis || !analysis.kind) {
    return { ok: false, code: 'NOT_ADOPTABLE', message: 'There is nothing here we can take charge of.' };
  }
  const kind = analysis.kind;
  const meta = sectionKindMeta(kind);
  if (!meta) {
    return { ok: false, code: 'NOT_ADOPTABLE', message: `We do not have a section called "${kind}".` };
  }

  const fields = applyFixes(analysis.fields || {}, fixes);

  // On the WRITE path only. The preview deliberately renders a section that is
  // not yet publishable, so the client can see what it needs.
  if (validate) {
    const check = validateFields(kind, fields);
    if (!check.ok) {
      return {
        ok: false,
        code: 'CONTENT_NOT_VALID',
        message: 'This section needs a little more before we can take charge of it. Nothing was changed.',
        errors: check.errors,
      };
    }
  }

  const id = String(blockId || '').trim() || `adopt-${Date.now().toString(36)}`;
  const block = blockFromFields(kind, fields, brand);

  let node;
  try {
    node = blockToElementorSection({ kind, block, brand, seedId: `adopt-${id}`, blockId: id });
  } catch (err) {
    if (err instanceof FormRecipientError || err?.code === 'form_recipient_missing') {
      return {
        ok: false,
        code: 'NO_FORM_RECIPIENT',
        message: 'This section has a form on it and we do not have an email address for your business yet, '
          + 'so the form would have nowhere to send enquiries. Add one under Settings → Your business, then try again.',
      };
    }
    return { ok: false, code: 'ADOPT_FAILED', message: 'We could not rebuild that section, so nothing was changed.' };
  }
  if (!node) {
    return { ok: false, code: 'ADOPT_FAILED', message: 'We could not rebuild that section, so nothing was changed.' };
  }

  // Anything the block could not carry (a picture's address and its attachment
  // id, which are settings rather than copy) is patched in through the same
  // code path an ordinary edit uses.
  const patched = applyFields(node, kind, fields);

  const [entry] = reduceToSectionList([patched]);
  if (!entry?.editable) {
    return {
      ok: false,
      code: 'ADOPT_NOT_EDITABLE',
      message: 'The editor could not take charge of that section after all, so nothing was changed.',
    };
  }

  // What went in and did not come out. This is the honest self-check: a field
  // the mapper found but the round trip lost is reported, not hidden.
  const after = extractFields(patched, kind);
  const dropped = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === '' || value == null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const got = after[key];
    const lost = Array.isArray(value)
      ? (!Array.isArray(got) || got.length !== value.length)
      : (txt(got) === '' && txt(value) !== '');
    if (lost) dropped.push(key);
  }

  return {
    ok: true,
    node: patched,
    kind,
    handle: patched?.settings?._title || null,
    fields: entry.fields,
    blockId: id,
    dropped,
  };
}

/* ==========================================================================
 * 7. Identity — proving we are adopting the section we previewed
 * ======================================================================== */

/**
 * A stable fingerprint of one section's stored bytes.
 *
 * Between the preview and the tap on "Adopt this section" the page can change
 * — somebody in Elementor, another Portal tab, the AI queue. Adopting index 3
 * of a page that no longer has the section we analysed at index 3 would
 * replace the wrong thing, so the route carries this and refuses on a
 * mismatch. FNV-1a: short, stable across processes, and no crypto import for
 * something that is not a security boundary.
 */
export function sectionFingerprint(node) {
  const json = JSON.stringify(node ?? null);
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i += 1) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `f${h.toString(36)}-${json.length.toString(36)}`;
}

/* ==========================================================================
 * 8. The page-level view the Portal asks for
 * ======================================================================== */

/** The first words a visitor reads on this section — how a person names it. */
export function firstWords(node, max = 80) {
  for (const w of widgetsUnder(node)) {
    const t = txt(widgetContent(w).text);
    if (t) return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }
  return 'Built on the website itself';
}

/**
 * Run the analysis over a whole reduced section list and answer the question
 * the "Review sections built on the site (N)" entry needs: how many of these
 * could become editable, and for the rest, why not.
 *
 * @param {Array<object>} sections  from `reduceToSectionList`
 * @param {{ allowPro?: boolean }} [opts]
 */
export function analysePage(sections, opts = {}) {
  const list = Array.isArray(sections) ? sections : [];
  const rows = list.map((entry) => {
    if (entry.editable) {
      return {
        index: entry.index,
        already: true,
        adoptable: false,
        reason: 'already_ours',
        reasonText: REASON_TEXT.already_ours,
        kind: entry.kind,
        confidence: 1,
        confidenceLabel: 'high',
        unmappedCount: 0,
        widgetTypes: [],
        fingerprint: sectionFingerprint(entry.node),
      };
    }
    const a = analyseSection(entry.node, opts);
    return {
      index: entry.index,
      already: false,
      // A line the client can recognise the section by. The row otherwise
      // reads "Custom section — built on the site" and so does every other
      // row, which is no help at all when a page has four of them.
      preview: firstWords(entry.node),
      adoptable: a.adoptable,
      reason: a.reason,
      reasonText: a.reasonText,
      kind: a.kind,
      kindLabel: a.label,
      why: a.why,
      confidence: a.confidence,
      confidenceLabel: a.confidenceLabel,
      unmappedCount: a.unmapped.filter((u) => u.carriesContent).length,
      widgetTypes: a.widgetTypes,
      fingerprint: sectionFingerprint(entry.node),
    };
  });

  return {
    rows,
    customCount: rows.filter((r) => !r.already).length,
    adoptableCount: rows.filter((r) => r.adoptable).length,
  };
}

/**
 * What `sectionPreview.renderAdoptionPreviewHtml` needs to draw the "now" side
 * of the before/after. Handed over rather than duplicated so the preview and
 * the mapper can never disagree about what a widget is or what it is carrying.
 */
export const previewTools = Object.freeze({
  widgets: (node) => widgetsUnder(node),
  label: widgetLabel,
  content: widgetContent,
});

export const __test__ = {
  repeatGroups, widgetsUnder, headingRank, primaryHeading, looksLikeQuote,
  decodeQuoteish, blockFromFields, REASON_TEXT, SIGNATURES, REQUIRED_FIELDS,
};
