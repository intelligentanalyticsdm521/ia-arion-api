/**
 * Section schema — the ONE description of what is editable inside a section
 * we authored, and where each value lives inside the Elementor tree.
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 *
 * `elementorAdapter.js` is a one-way transform: block payload -> Elementor
 * section. The Portal editor needs the other direction as well ("what does the
 * hero on this page currently say?"), and it needs to put an edit back without
 * rebuilding the section from scratch -- rebuilding would throw away every
 * style, id and setting a section picked up after we wrote it.
 *
 * So each editable widget is STAMPED at emit time with `settings._ia_field`,
 * a stable binding id (`hero.headline`, `services.items`, ...). This file holds
 *
 *   1. FIELDS   -- what the client sees and edits, per section kind. Plain
 *                  labels, plain help text; no Elementor vocabulary.
 *   2. BINDINGS -- how each binding id maps onto real Elementor settings.
 *
 * Both are pure DATA, which is what makes the plugin's PHP read side a mirror
 * rather than a second implementation (ia-plugin `IA_Section_Reader`). The
 * write side lives here only: arion-api patches the tree and posts whole
 * section nodes to the plugin, so the plugin never hand-edits Elementor JSON.
 *
 * ROUND-TRIP CONTRACT
 *   - A section we did not author (no `ia:` handle) is opaque: it is carried
 *     back byte-for-byte and never re-rendered. (SCOPE §3.3)
 *   - A section we did author is patched IN PLACE -- we only touch the exact
 *     settings a binding names. Everything else survives untouched.
 */

import { isIaSectionTitle, inferFormFieldType, formFieldId } from './elementorAdapter.js';
// A leaf of the tree emitter, outside this file's own import cycle: it only
// reads a stamp off a node — plus, since B-168, the ONE layout translation, so
// a box dropped into a free section arranges itself the same way a box in a
// tree section does. Copying those tables here would be a second dialect.
import {
  layoutFromStyle, layoutToSettings, styleToSettings,
} from './elementorTree.js';
/* THE ONE WIDGET VOCABULARY (B-168, "one vocabulary for what a page may hold").
 * `ELEMENTOR_WIDGETS` is every widget this server can publish — the eight
 * families plus what is left of the legacy table — and `resolveWidget` is the
 * one thing that turns a kind and some props into a page-engine node. The free
 * section used to keep its own nine-row list and refuse everything else by
 * name; the list is still here (those nine have real two-way codecs) but it is
 * no longer THE GATE. A block kind is allowed if and only if something can
 * emit it. */
import {
  ELEMENTOR_WIDGETS, canonicalKind, resolveWidget, UnsupportedWidgetError,
} from './elementorWidgets.js';
// What a form is FOR — one home, no imports of its own (see formPurpose.js).
import {
  FORM_PURPOSES, purposeFromCssClass, cssClassFromPurpose, formPurposeSettings, formPurposeOf,
} from './formPurpose.js';
/* THE REVERSE OF THE EMITTER (B-168, 2026-09-22). Everything about reading a
 * page somebody built in Elementor ON THEIR OWN WEBSITE lives in one file; this
 * one hands it the two halves it needs from here — how we read a node we
 * stamped, and how we build one — so neither file imports the other. */
import {
  OPAQUE_KIND, BLOCK_ID_KEY as READ_ID_KEY, BLOCK_EL_KEY as READ_EL_KEY,
  readSectionBlocks, writeSection,
} from './elementorReader.js';

/* ==========================================================================
 * 1. Codecs — the small translations between "what a person types" and
 *    "what Elementor stores". Every one is reversible.
 * ======================================================================== */

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unescapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Strip tags then unescape — the inverse of wrapping plain text in markup. */
function htmlToText(html) {
  return unescapeHtml(String(html == null ? '' : html).replace(/<[^>]*>/g, '')).trim();
}

const RATING_MIN = 1;
const RATING_MAX = 5;

export const CODECS = {
  /** Stored exactly as typed. */
  text: {
    decode: (v) => (v == null ? '' : String(v)),
    encode: (v) => (v == null ? '' : String(v)),
  },

  /** One paragraph of copy stored as `<p>…</p>`. */
  html_text: {
    decode: (v) => htmlToText(v),
    encode: (v) => `<p>${escapeHtml(v)}</p>`,
  },

  /** One paragraph of copy stored italicised — the About sub-headline. */
  html_em: {
    decode: (v) => htmlToText(v),
    encode: (v) => `<p><em>${escapeHtml(v)}</em></p>`,
  },

  /** Several paragraphs stored as consecutive `<p>` blocks. */
  html_paragraphs: {
    decode: (v) => String(v == null ? '' : v)
      .split(/<\/p>/i)
      .map((chunk) => htmlToText(chunk))
      .filter((s) => s.length > 0),
    encode: (v) => (Array.isArray(v) ? v : [v])
      .filter((p) => String(p == null ? '' : p).trim().length > 0)
      .map((p) => `<p>${escapeHtml(p)}</p>`)
      .join('\n'),
  },

  /** Elementor stores `fas fa-truck`; the client picks `truck`. */
  fa_icon: {
    decode: (v) => String(v == null ? '' : v).replace(/^fa[a-z]?\s+fa-/, '').trim(),
    encode: (v) => {
      const name = String(v == null ? '' : v).replace(/^fa[a-z]?\s+fa-/, '').trim();
      return name ? `fas fa-${name}` : 'fas fa-circle';
    },
  },

  /**
   * A WordPress attachment id, stored beside a picture's URL.
   * ---------------------------------------------------------------------
   * This is the whole of "srcset where the adapter can". Elementor renders
   * an image widget through `wp_get_attachment_image_src`/`_srcset`, which
   * need the ATTACHMENT ID; given only a URL it emits one `<img src>` and
   * every phone downloads the desktop file. The picker now returns the id
   * with the URL, so the binding stores both and WordPress does the rest.
   *
   * Elementor stores it as a number (its own controls run `absint`), and an
   * empty string is the "no attachment" value it ships by default — so those
   * are the only two shapes this codec ever produces.
   */
  attachment_id: {
    decode: (v) => {
      if (v === '' || v == null) return '';
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? n : '';
    },
    encode: (v) => CODECS.attachment_id.decode(v),
  },

  /**
   * Several lines inside ONE paragraph — `<p>a<br>b<br>c</p>`.
   * ---------------------------------------------------------------------
   * This is how every hand-drawn "what's included" list in the curated
   * library is written, and `html_paragraphs` cannot read it: it splits on
   * `</p>` and a one-paragraph list has none. A `<ul><li>` list decodes the
   * same way, so a layout drawn either way reads back as a list of lines —
   * but it ENCODES back as `<p>…<br>…</p>`, so the adapter proves the round
   * trip before it will stamp one (libraryAdapter `partRoundTrips`).
   */
  html_lines: {
    decode: (v) => String(v == null ? '' : v)
      .replace(/<\/li>\s*<li[^>]*>/gi, '<br>')
      .split(/<br\s*\/?>/i)
      .map((line) => htmlToText(line))
      .filter((s) => s.length > 0),
    encode: (v) => {
      const lines = (Array.isArray(v) ? v : [v])
        .map((l) => String(l == null ? '' : l).trim())
        .filter(Boolean)
        .map((l) => escapeHtml(l));
      return `<p>${lines.join('<br>')}</p>`;
    },
  },

  /**
   * A bullet list, stored as `<ul><li>…</li></ul>` — the shape a person reading
   * the page in Elementor expects, and the shape it round-trips as.
   *
   * `html_lines` above decodes `<li>` too, but ENCODES back to one paragraph
   * with `<br>`s in it, so a list written as a list would come back as a
   * paragraph the first time anybody saved. A content block's bullets are OURS
   * to draw, so they get the honest codec.
   */
  html_bullets: {
    decode: (v) => String(v == null ? '' : v)
      .replace(/<\/li>\s*<li[^>]*>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .split('\n')
      .map((line) => htmlToText(line))
      .filter((s) => s.length > 0),
    encode: (v) => {
      const lines = (Array.isArray(v) ? v : [v])
        .map((l) => String(l == null ? '' : l).trim())
        .filter(Boolean)
        .map((l) => `<li>${escapeHtml(l)}</li>`);
      return `<ul>${lines.join('')}</ul>`;
    },
  },

  /** Whole number 1–5. */
  rating: {
    decode: (v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return RATING_MAX;
      return Math.max(RATING_MIN, Math.min(RATING_MAX, Math.round(n)));
    },
    encode: (v) => CODECS.rating.decode(v),
  },
};

/* --- Composed-markup codecs (whole widget <-> a structured item) ---------- */

/** The testimonial card the adapter composes into one text-editor widget. */
export function decodeTestimonialCard(html) {
  const src = String(html == null ? '' : html);
  const rating = /aria-label="\s*(\d)\s*out of 5"/i.exec(src);
  const quote = /<blockquote>\s*<p>([\s\S]*?)<\/p>\s*<\/blockquote>/i.exec(src);
  const attrib = /class="ia-attribution"[^>]*>\s*<strong>([\s\S]*?)<\/strong>\s*(?:<br\s*\/?>)?([\s\S]*?)<\/p>/i.exec(src);
  return {
    quote:       quote ? htmlToText(quote[1]) : htmlToText(src),
    attribution: attrib ? htmlToText(attrib[1]) : '',
    role:        attrib ? htmlToText(attrib[2]) : '',
    rating:      rating ? CODECS.rating.decode(rating[1]) : RATING_MAX,
  };
}

export function encodeTestimonialCard(item) {
  const rating = CODECS.rating.decode(item?.rating);
  const stars = '★'.repeat(rating);
  return [
    `<p class="ia-rating" aria-label="${rating} out of 5">${stars}</p>`,
    `<blockquote><p>${escapeHtml(item?.quote)}</p></blockquote>`,
    `<p class="ia-attribution"><strong>${escapeHtml(item?.attribution)}</strong><br>${escapeHtml(item?.role)}</p>`,
  ].join('\n');
}

/**
 * The pricing card the adapter composes into one text-editor widget.
 *
 * Same shape as the testimonial card above and for the same reason: a price
 * card carries several values (name, price, period, what is included, a
 * button) and Elementor's FREE widget set has nothing purpose-built for one -
 * `price-table` and `price-list` are both Elementor Pro, and this pack must
 * work without a Pro licence (D-ARION-A's constraint, applied here too).
 *
 * The markup is classed so a theme can style it, and every value is read back
 * out of it, so a client's edit patches the card rather than rebuilding the
 * section.
 */
export function decodePricingCard(html) {
  const src = String(html == null ? '' : html);
  const name = /class="ia-plan-name"[^>]*>([\s\S]*?)<\/h3>/i.exec(src);
  const amount = /class="ia-plan-amount"[^>]*>([\s\S]*?)(?:<span class="ia-plan-period">([\s\S]*?)<\/span>)?<\/p>/i.exec(src);
  const summary = /class="ia-plan-summary"[^>]*>([\s\S]*?)<\/p>/i.exec(src);
  const featureBlock = /class="ia-plan-features"[^>]*>([\s\S]*?)<\/ul>/i.exec(src);
  const cta = /class="ia-plan-cta"[^>]*>\s*<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(src);
  const features = [];
  if (featureBlock) {
    const re = /<li>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = re.exec(featureBlock[1])) !== null) {
      const text = htmlToText(m[1]);
      if (text) features.push(text);
    }
  }
  return {
    name:     name ? htmlToText(name[1]) : '',
    price:    amount ? htmlToText(amount[1]) : '',
    period:   amount && amount[2] ? htmlToText(amount[2]) : '',
    summary:  summary ? htmlToText(summary[1]) : '',
    features,
    cta_text: cta ? htmlToText(cta[2]) : '',
    cta_href: cta ? unescapeHtml(cta[1]) : '',
    // Which service in the price list this card came from. Not shown to
    // anybody; it is what stops a price being typed twice.
    offering_id: (/data-ia-offering="([^"]*)"/i.exec(src) || [, ''])[1],
  };
}

export function encodePricingCard(item) {
  const features = (Array.isArray(item?.features) ? item.features : [])
    .map((f) => String(f == null ? '' : f).trim())
    .filter(Boolean)
    .map((f) => `<li>${escapeHtml(f)}</li>`)
    .join('');
  const offering = String(item?.offering_id || '').trim();
  const period = String(item?.period || '').trim();
  const ctaText = String(item?.cta_text || '').trim();
  return [
    `<div class="ia-plan"${offering ? ` data-ia-offering="${escapeHtml(offering)}"` : ''}>`,
    `<h3 class="ia-plan-name">${escapeHtml(item?.name)}</h3>`,
    `<p class="ia-plan-amount">${escapeHtml(item?.price)}`
      + (period ? `<span class="ia-plan-period">${escapeHtml(period)}</span>` : '')
      + '</p>',
    `<p class="ia-plan-summary">${escapeHtml(item?.summary)}</p>`,
    features ? `<ul class="ia-plan-features">${features}</ul>` : '<ul class="ia-plan-features"></ul>',
    ctaText
      ? `<p class="ia-plan-cta"><a href="${escapeHtml(item?.cta_href || '#contact')}">${escapeHtml(ctaText)}</a></p>`
      : '',
    '</div>',
  ].filter(Boolean).join('\n');
}

/**
 * ONE registry of the composed cards, so a binding names a card and every
 * read, write and clone path looks it up here. Before this the testimonial
 * card was special-cased in four places, and a second card would have meant
 * four more branches that can disagree.
 */
export const COMPOSED_CARDS = Object.freeze({
  testimonial_card: { decode: decodeTestimonialCard, encode: encodeTestimonialCard },
  pricing_card:     { decode: decodePricingCard,     encode: encodePricingCard },
});

/* --- Composed PARTS (one setting <-> several fields of one list item) ----- */

/**
 * A hand-drawn statistic is ONE heading that says "15+", "$2.5M", "98%".
 * Our own stats band draws the same thing with Elementor's counter widget,
 * whose number, prefix and suffix are three separate settings — and the edit
 * sheet has three boxes because of it ("Just the number. Anything in front of
 * it or after it goes in the two boxes below.").
 *
 * Without this split, a client editing a hand-drawn stat would type 12 in the
 * number box and "+" in the after box, press Save, and the "+" would go
 * nowhere: the heading holds one string and only one field would reach it.
 * That is the swallow this codec exists to stop. The whitespace either side of
 * the number rides in the prefix and the suffix, so "Under 24 hrs" comes back
 * out as "Under 24 hrs" and not "Under24hrs".
 */
const STAT_NUMBER_RE = /^(\D*?)(\d[\d.,]*\d|\d)([\s\S]*)$/;

export function decodeStatNumber(raw) {
  const text = String(raw == null ? '' : raw);
  const m = STAT_NUMBER_RE.exec(text);
  if (!m) return { value: text, prefix: '', suffix: '' };
  return { prefix: m[1] || '', value: m[2] || '', suffix: m[3] || '' };
}

export function encodeStatNumber(item) {
  return `${item?.prefix ?? ''}${item?.value ?? ''}${item?.suffix ?? ''}`;
}

/**
 * ONE registry of the part codecs, the same way COMPOSED_CARDS is the one
 * registry of the card codecs. A part maps ONE Elementor setting onto SEVERAL
 * fields of a list item; a card maps one setting onto the whole item.
 */
export const COMPOSED_PARTS = Object.freeze({
  stat_number: { decode: decodeStatNumber, encode: encodeStatNumber },
});

/** Contact methods ride an icon-list; the visible text is "Label: value". */
const METHOD_ICONS = Object.freeze({
  phone:   'fas fa-phone',
  email:   'fas fa-envelope',
  address: 'fas fa-map-marker-alt',
  social:  'fas fa-share-alt',
});
const ICON_METHODS = Object.freeze(
  Object.fromEntries(Object.entries(METHOD_ICONS).map(([k, v]) => [v, k])),
);

export function decodeContactMethod(row) {
  const text = String(row?.text == null ? '' : row.text);
  const split = text.indexOf(': ');
  const icon = String(row?.selected_icon?.value || '');
  return {
    kind:  ICON_METHODS[icon] || 'other',
    label: split >= 0 ? text.slice(0, split).trim() : text.trim(),
    value: split >= 0 ? text.slice(split + 2).trim() : '',
    href:  String(row?.link?.url || ''),
  };
}

export function encodeContactMethod(item, previous) {
  const kind = String(item?.kind || 'other').toLowerCase();
  return {
    ...(previous || {}),
    text: `${item?.label ?? ''}: ${item?.value ?? ''}`,
    selected_icon: { value: METHOD_ICONS[kind] || 'fas fa-circle', library: 'fa-solid' },
    link: {
      url: item?.href ?? '',
      is_external: kind === 'social' || kind === 'address' ? 'on' : '',
      nofollow: '',
    },
  };
}

/* ==========================================================================
 * CONTENT BLOCKS — the free section.
 * --------------------------------------------------------------------------
 * The eleven archetypes above each answer one whole job ("a hero", "your
 * prices"). None of them answers "two paragraphs, a picture and a button",
 * which is most of an About page and all of a landing page — and the widget
 * pane Brandon asked for lists exactly those parts (text, image, video,
 * columns, spacer, divider).
 *
 * So there is a TWELFTH archetype, `content`, and it is the one section whose
 * contents are a LIST OF MIXED WIDGETS rather than a fixed set of slots. Each
 * widget carries two stamps:
 *
 *     _ia_field: 'content.blocks'   which binding it belongs to (as ever)
 *     _ia_w:     'paragraph'        WHICH KIND of block it is
 *
 * and each column container carries `_ia_col: 0|1|2`, so a two-column content
 * section reads back as a two-column content section.
 *
 * ── ONE MECHANISM, NOT A SECOND ONE ──────────────────────────────────────
 * This is the same stamp-and-read discipline as every binding above: pure
 * data, mirrored in a table, reversible. What it adds is a third `repeat`
 * form — `mixed` — beside `widget`, `setting` and `container`. A content block
 * is OURS end to end (nobody hand-draws one), so unlike a hand-drawn card it
 * may be rebuilt from its values rather than patched in place.
 * ======================================================================== */

/** Which column of a content section a container holds. */
export const COLUMN_MARKER = '_ia_col';
/** Which kind of content block one widget is. */
export const BLOCK_MARKER = '_ia_w';

/* ── B-168: THE OTHER EIGHTY WIDGETS ──────────────────────────────────────
 * The nine kinds below have hand-written two-way codecs, because they were
 * written before the families existed and because their values are the ones
 * the AI writer and the curated library read. Everything ELSE the author can
 * drag — Icon Box, Accordion, Counter, Testimonial, Call to Action, the lot —
 * is built by its own family emitter through `resolveWidget`, and that emitter
 * is one-way: props in, page-engine settings out. There is no reader that can
 * turn `icon-box` settings back into the props the panel edits, and writing
 * eighty of them would be the second vocabulary this change exists to end.
 *
 * So a family widget carries its builder props BESIDE its settings, in
 * `_ia_props`. The Elementor settings stay the truth — they are what the
 * website draws and what Elementor's own editor shows — and `_ia_props` is
 * what the builder reads back, which is the only honest way to hand the author
 * the same widget with the same controls after a publish. The cost is stated
 * rather than hidden: a family widget edited in Elementor itself keeps the
 * hand edit on the page (an unnamed setting survives the next save, exactly as
 * it does for the nine) but the builder's own panel still shows what the
 * builder last wrote.
 */
/** A family widget's builder props, carried beside its Elementor settings. */
export const PROPS_MARKER = '_ia_props';
/** The one block kind that is a BOX and not a widget. */
export const CONTAINER_BLOCK_KIND = 'container';
/** What is inside a box. Reserved, so it can never be a widget's own prop. */
export const BLOCK_CHILDREN_KEY = '__children';
/** A block's §11.8 look. Reserved for the same reason (`divider` has a `style` prop). */
export const BLOCK_STYLE_KEY = '__style';
/** How deep boxes may nest inside one free section. */
export const MAX_BLOCK_DEPTH = 12;

const HEADING_LEVELS = Object.freeze(['h2', 'h3', 'h4']);

/* ── THE PANEL'S OWN SPELLING (B-168) ──────────────────────────────────────
 * These nine were written before the widget panel existed, and their field
 * names are ours: `label`, `href`, `url`, `height`. The panel that now feeds
 * them writes the PAGE ENGINE'S names, because that is what its controls are
 * (`text`, `link`, `image`, `space`), and the family emitters already read both
 * — `pick(p, 'title_text', 'title')`, all through `families/`.
 *
 * So each field may name the other spellings it answers to, HERE, beside the
 * field it is an alias for. Not a second table: one row, every name it has. A
 * Button dropped from the panel publishes its words, and one written by the AI
 * writer or the curated library still does too.
 *
 * `read` is for a spelling whose SHAPE differs, not just its name — the panel's
 * `link` may be a string or `{ url }`, its `icon_list` is rows rather than
 * strings. Anything without one is a straight rename.
 */
const urlOf = (v) => (v && typeof v === 'object' ? String(v.url ?? '') : String(v ?? ''));
const idOf = (v) => (v && typeof v === 'object' ? (v.id ?? '') : '');
const rowText = (rows) => (Array.isArray(rows)
  ? rows.map((r) => (typeof r === 'string' ? r : String(r?.text ?? ''))) : []);

/**
 * The content-block vocabulary: block kind → Elementor widget + its settings.
 *
 * `defaults` is what a brand-new block of that kind is born with, so the
 * builder never has to know an Elementor setting name.
 */
export const CONTENT_BLOCK_KINDS = Object.freeze({
  heading: {
    label: 'Heading',
    widget: 'heading',
    fields: {
      // Elementor's own key too (B-168): a heading read back off a client's
      // own page carries `title`, and without this alias its words were
      // dropped on the next save and the heading published empty.
      text:  { setting: 'title', also: ['title'] },
      level: { setting: 'header_size', also: ['header_size'] },
      align: { setting: 'align' },
    },
    defaults: { title: '', header_size: 'h2', align: 'left' },
  },
  paragraph: {
    label: 'Paragraph',
    widget: 'text-editor',
    fields: {
      // Elementor's own key too (B-168), for the same reason the heading
      // names `title`: a paragraph read back off a client's own page
      // carries `editor`, and the words were dropped on the next save.
      text: {
        setting: 'editor',
        codec: 'html_paragraphs',
        also: [{ key: 'editor', read: (v) => CODECS.html_paragraphs.decode(v) }],
      },
    },
    defaults: { editor: '', align: 'left' },
  },
  list: {
    label: 'Bullet list',
    widget: 'text-editor',
    fields: {
      items: {
        setting: 'editor',
        codec: 'html_bullets',
        also: [
          { key: 'icon_list', read: rowText },
          { key: 'editor', read: (v) => CODECS.html_bullets.decode(v) },
        ],
      },
    },
    defaults: { editor: '<ul></ul>', align: 'left' },
  },
  image: {
    label: 'Picture',
    widget: 'image',
    fields: {
      url:     { setting: 'image.url', also: [{ key: 'image', read: urlOf }] },
      alt:     { setting: 'image.alt' },
      id:      { setting: 'image.id', codec: 'attachment_id', also: [{ key: 'image', read: idOf }] },
      caption: { setting: 'caption' },
    },
    defaults: { image: { url: '', id: '', alt: '' }, image_size: 'large', caption: '' },
  },
  button: {
    label: 'Button',
    widget: 'button',
    fields: {
      label: { setting: 'text', also: ['text'] },
      href:  { setting: 'link.url', also: [{ key: 'link', read: urlOf }] },
      align: { setting: 'align' },
    },
    defaults: { text: '', link: { url: '', is_external: '', nofollow: '' }, align: 'left', size: 'md' },
  },
  video: {
    label: 'Video',
    widget: 'video',
    fields: { url: { setting: 'youtube_url', also: ['youtube_url'] } },
    defaults: { youtube_url: '', video_type: 'youtube' },
  },
  map: {
    label: 'Map',
    widget: 'google_maps',
    fields: { address: { setting: 'address' } },
    defaults: { address: '', zoom: { unit: 'px', size: 10, sizes: [] } },
  },
  divider: {
    label: 'Divider',
    widget: 'divider',
    fields: {},
    defaults: { style: 'solid', weight: { unit: 'px', size: 1, sizes: [] } },
  },
  spacer: {
    label: 'Blank space',
    widget: 'spacer',
    fields: {
      height: { setting: 'space.size', also: [{ key: 'space', read: (v) => (v && typeof v === 'object' ? v.size : v) }] },
    },
    defaults: { space: { unit: 'px', size: 32, sizes: [] } },
  },
});

/** The nine with hand-written codecs. Not the gate — see `blockKindAllowed`. */
export function listContentBlockKinds() {
  return Object.keys(CONTENT_BLOCK_KINDS);
}

/**
 * THE GATE. A block kind is allowed if and only if something can emit it.
 *
 * Three answers, one question: the legacy nine, the box, and every row of the
 * one merged widget vocabulary. Nothing else — a kind nothing can emit is
 * still refused by name, because publishing it would put a widget on a
 * client's live page that this server cannot draw.
 */
export function blockKindAllowed(kind) {
  const raw = String(kind == null ? '' : kind);
  if (!raw) return false;
  if (CONTENT_BLOCK_KINDS[raw]) return true;
  if (raw === CONTAINER_BLOCK_KIND) return true;
  /* A WIDGET SOMEBODY BUILT ON THEIR OWN WEBSITE THAT WE CANNOT NAME.
     It is allowed on the page because it IS on the page: refusing it would
     refuse every save of every page that has one, which is most real pages.
     It is never built from props — `elementorReader.writeSection` hands the
     original node straight back — so allowing it here cannot publish anything
     this server made up. */
  if (raw === OPAQUE_KIND) return true;
  return !!ELEMENTOR_WIDGETS[canonicalKind(raw)];
}

/** Every kind a free section may hold, sorted — the merged vocabulary itself. */
export function listAllowedBlockKinds() {
  return [...new Set([
    ...Object.keys(CONTENT_BLOCK_KINDS),
    CONTAINER_BLOCK_KIND,
    OPAQUE_KIND,
    ...Object.keys(ELEMENTOR_WIDGETS),
  ])].sort();
}

/** A block's own props: everything that is not structure.
 *
 * `__id` and `__el` are the READER's (B-168, `elementorReader.js`): which
 * Elementor node this block came off a client's own page from, and which
 * element it was. They are how a save finds the node it has to write back and
 * are never props of the widget, so they are stripped here — beside `kind`,
 * `col` and `__children`, in the one place that answers this question. */
function blockProps(block) {
  const out = {};
  for (const [k, v] of Object.entries(block || {})) {
    if (k === 'kind' || k === 'col' || k === BLOCK_CHILDREN_KEY) continue;
    if (k === READ_ID_KEY || k === READ_EL_KEY) continue;
    out[k] = v;
  }
  return out;
}

/** The props a block was published with, off its own node. */
function storedProps(node) {
  const held = node?.settings?.[PROPS_MARKER];
  if (!held || typeof held !== 'object' || Array.isArray(held)) return {};
  return JSON.parse(JSON.stringify(held));
}

/** The value for one legacy field, under whichever name it arrived. */
function fieldValue(block, fieldKey, fieldSpec) {
  if (block && fieldKey in block) return { has: true, value: block[fieldKey] };
  for (const alias of fieldSpec.also || []) {
    const key = typeof alias === 'string' ? alias : alias.key;
    if (!block || !(key in block)) continue;
    const raw = block[key];
    return { has: true, value: typeof alias === 'string' ? raw : alias.read(raw) };
  }
  return { has: false, value: undefined };
}

/**
 * One stamped widget → the block object the builder edits.
 * An unknown `_ia_w` comes back as `{ kind: 'paragraph' }` rather than as
 * nothing: a block we cannot name is still a block on somebody's page.
 */
export function readContentWidget(node) {
  const kind = String(node?.settings?.[BLOCK_MARKER] || '');
  const spec = CONTENT_BLOCK_KINDS[kind];
  if (spec) {
    /* WHAT THE AUTHOR LAST SENT COMES BACK; WHAT WE CAN DECODE IS THE FALLBACK.
     * ONE rule, and it is the same one the other seventy-nine follow. The nine
     * are the only kinds with a reader of their own, so they are the only place
     * there could be two answers — and there must not be two answers, because
     * the panel edits `text` and the codec answers `label`. A page published
     * before this change, one the curated library emitted and one the AI writer
     * wrote all carry no props and are still read by the codec, which is what
     * that codec is for. */
    const held = storedProps(node);
    if (Object.keys(held).length) return { kind, ...held };
    const out = { kind };
    for (const [fieldKey, fieldSpec] of Object.entries(spec.fields)) {
      out[fieldKey] = decodeValue(getPath(node?.settings, fieldSpec.setting), fieldSpec);
    }
    return out;
  }
  /* A BOX comes back as a box, with what is inside it. Only its own stamped
     children are read: a box that holds a composition (a card drawn out of
     free widgets) must come back as the card, not as five loose things. */
  if (kind === CONTAINER_BLOCK_KIND) {
    return {
      kind: CONTAINER_BLOCK_KIND,
      ...storedProps(node),
      [BLOCK_CHILDREN_KEY]: (Array.isArray(node?.elements) ? node.elements : [])
        .filter((child) => child?.settings?.[BLOCK_MARKER])
        .map(readContentWidget),
    };
  }
  if (ELEMENTOR_WIDGETS[canonicalKind(kind)]) {
    return { kind: canonicalKind(kind), ...storedProps(node) };
  }
  return { kind: 'paragraph', text: [] };
}

/**
 * One block object → the Elementor widget node.
 *
 * `previous` is the node that held this block before, when there was one, so a
 * block keeps every setting it had that this table does not name (an author's
 * colour, a margin) instead of being reset by an edit to its words.
 */
export function buildContentWidget(block, id, previous = null, ctx = {}, depth = 1) {
  const raw = String(block?.kind || '');

  /* A BOX. Its arranging is the ONE dialect `elementorTree` already speaks, so
     a box here and a box in a tree section publish the same keys. */
  if (raw === CONTAINER_BLOCK_KIND) return buildContentBox(block, id, previous, ctx, depth);

  /* A FAMILY WIDGET. Built by its own emitter, which is the only thing that
     knows what `icon-box` or `nested-accordion` needs, and stamped so the
     reopen above can hand the author back the same widget. */
  if (!CONTENT_BLOCK_KINDS[raw] && ELEMENTOR_WIDGETS[canonicalKind(raw)]) {
    return buildEmittedWidget(raw, block, id, previous, ctx);
  }

  const kind = CONTENT_BLOCK_KINDS[raw] ? raw : 'paragraph';
  const spec = CONTENT_BLOCK_KINDS[kind];
  /* THE NODE IN THIS PLACE IS THE SAME WIDGET, so everything it carries
     that this table does not name is KEPT. Until B-168's reader the only
     way a node could be "the same" was our own `_ia_w` stamp, which meant
     that editing one word of a heading somebody built in Elementor threw
     away every colour, margin and font on it. The page engine's own widget
     type answers the same question for a node we did not write. */
  const sameKind = !!previous
    && (previous.settings?.[BLOCK_MARKER] === kind || previous.widgetType === spec.widget);
  let settings = {
    ...(sameKind ? previous.settings : JSON.parse(JSON.stringify(spec.defaults))),
    _ia_field: 'content.blocks',
    [BLOCK_MARKER]: kind,
    // The nine carry their props too, for the same reason the other seventy-nine
    // do: the panel's controls are the page engine's names and the codec's are
    // ours, and a reopen has to give the author back the control they typed in.
    [PROPS_MARKER]: blockProps(block),
  };
  for (const [fieldKey, fieldSpec] of Object.entries(spec.fields)) {
    const found = fieldValue(block, fieldKey, fieldSpec);
    if (!found.has) continue;
    let value = found.value;
    if (fieldKey === 'level' && !HEADING_LEVELS.includes(String(value))) value = 'h2';
    settings = setPath(settings, fieldSpec.setting, encodeValue(value, fieldSpec));
  }
  return {
    id: id || freshId(),
    elType: 'widget',
    widgetType: spec.widget,
    settings,
  };
}

/**
 * One family (or legacy-table) widget → its page-engine node.
 *
 * `resolveWidget` answers the tier and ownership question too, and it REFUSES
 * by name rather than publishing a widget the site cannot draw. The refusal is
 * an `UnsupportedWidgetError`, which the save, draft and preview routes turn
 * into a field error the author can read — never a swallowed 200.
 *
 * A setting the emitter does not name is kept from the node that was there
 * before, exactly as the nine do, so an author's hand-set colour survives an
 * edit to their words.
 */
function buildEmittedWidget(rawKind, block, id, previous, ctx) {
  const canon = canonicalKind(rawKind);
  const props = blockProps(block);
  const nodeId = id || freshId();
  let node;
  try {
    ({ node } = resolveWidget(canon, props, { ...(ctx || {}), nodeId }));
  } catch (err) {
    /* WHICH widget, in the author's own words. `resolveWidget`'s plan sentence
       is about a widget in the abstract ("Available on ARION Standard and
       above"), and a page with eleven things on it needs to say which one —
       otherwise the author is told to change something and not what. Re-thrown,
       never swallowed: the sentence itself is still the catalogue's. */
    if (err?.code === 'WIDGET_NOT_ON_PLAN') {
      const label = ELEMENTOR_WIDGETS[canon]?.label || canon;
      throw new UnsupportedWidgetError(`${label}: ${err.message}`, canon);
    }
    throw err;
  }
  /* Same rule as the nine above: a node of the same page-engine widget type
     keeps every setting our vocabulary does not name. */
  const sameKind = !!previous
    && (previous.settings?.[BLOCK_MARKER] === canon
      || (previous.elType === 'widget' && previous.widgetType === node.widgetType));
  return {
    ...node,
    id: nodeId,
    settings: {
      ...(sameKind ? previous.settings : {}),
      ...node.settings,
      ...styleToSettings(props[BLOCK_STYLE_KEY]),
      _ia_field: 'content.blocks',
      [BLOCK_MARKER]: canon,
      [PROPS_MARKER]: props,
    },
  };
}

/**
 * A box inside a free section, and everything inside it, at any depth.
 *
 * `builtKids` is for the reader's write path (`elementorReader.writeSection`),
 * which has already decided each child — matching it to the node it was read
 * from by Elementor id rather than by position, which is the only way a box on
 * somebody else's page can have a child removed without the rest shuffling
 * onto the wrong nodes. When it is absent this builds the children itself,
 * exactly as it always has.
 */
function buildContentBox(block, id, previous, ctx, depth, builtKids = null) {
  if (depth > MAX_BLOCK_DEPTH) {
    throw new UnsupportedWidgetError(
      `Boxes can be nested up to ${MAX_BLOCK_DEPTH} deep, so nothing was saved.`, CONTAINER_BLOCK_KIND);
  }
  const props = blockProps(block);
  const style = props[BLOCK_STYLE_KEY] || null;
  const own = layoutFromStyle(style, props);
  const kids = Array.isArray(block?.[BLOCK_CHILDREN_KEY]) ? block[BLOCK_CHILDREN_KEY] : [];
  /* The same rule the widgets follow: a node in this place that is already a
     box keeps every setting our layout dialect does not name, whether we wrote
     it or the client built it in Elementor. */
  const sameKind = previous?.settings?.[BLOCK_MARKER] === CONTAINER_BLOCK_KIND
    || previous?.elType === 'container';
  const priorKids = sameKind && Array.isArray(previous.elements) ? previous.elements : [];
  return {
    id: id || freshId(),
    elType: 'container',
    settings: {
      ...(sameKind ? previous.settings : {}),
      ...layoutToSettings({ ...own, layout: own.layout || 'column' }, depth),
      ...styleToSettings(style, { container: true }),
      _ia_field: 'content.blocks',
      [BLOCK_MARKER]: CONTAINER_BLOCK_KIND,
      [PROPS_MARKER]: props,
    },
    elements: builtKids || kids.map((kid, j) => buildContentWidget(
      kid, priorKids[j]?.id || null, priorKids[j] || null, ctx, depth + 1,
    )),
    isInner: true,
  };
}

/* ==========================================================================
 * SECTION STYLE — the three things the builder's own toolbar changes.
 * --------------------------------------------------------------------------
 * The canvas gives every section a background, room around it and a heading
 * font. Without this, those three would change what the AUTHOR sees and
 * nothing on the website — a control that lies, which is the exact failure
 * this rebuild exists to end.
 *
 * All three are real Elementor settings on the section's own container, so
 * they publish, they round-trip, and Elementor's own editor shows the same
 * values. They ride as ONE field, `style`, so every section kind gains them
 * without eleven copies of three bindings.
 *
 * The font is written on the section's HEADING widgets, because that is where
 * Elementor keeps a font: a container has no typography of its own. Read back
 * from the first heading, which is the one the author was looking at.
 * ======================================================================== */

const HEADING_WIDGETS = Object.freeze(new Set(['heading']));

/** Every heading widget inside one section, in page order. */
function headingWidgetsOf(section) {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.elType === 'widget' && HEADING_WIDGETS.has(String(n.widgetType))) out.push(n);
    if (Array.isArray(n.elements)) n.elements.forEach(walk);
  };
  (Array.isArray(section?.elements) ? section.elements : []).forEach(walk);
  return out;
}

/** What the builder's toolbar and inspector changed, read off the section. */
export function extractSectionStyle(section) {
  const st = section?.settings || {};
  const pad = st.padding && typeof st.padding === 'object' ? Number(st.padding.top) : NaN;
  const font = headingWidgetsOf(section)[0]?.settings?.typography_font_family;
  const style = {};
  if (st.background_background === 'classic' && typeof st.background_color === 'string') {
    style.background = st.background_color;
  } else {
    style.background = '';
  }
  style.padding = Number.isFinite(pad) ? pad : null;
  style.headingFont = typeof font === 'string' ? font : '';
  return style;
}

/**
 * Write the three back. A key the author did not touch is left alone, and an
 * EMPTY background clears the colour rather than painting white over an image
 * — "empty values never overwrite by accident" cuts both ways, and a section
 * whose colour was removed has to come back with no colour.
 */
export function applySectionStyle(section, style) {
  if (!style || typeof style !== 'object') return section;
  let next = { ...(section.settings || {}) };
  let touched = false;

  if ('background' in style) {
    const colour = String(style.background || '').trim();
    if (colour) {
      next = { ...next, background_background: 'classic', background_color: colour };
    } else if (next.background_background === 'classic' && !next.background_image?.url) {
      const { background_background: _b, background_color: _c, ...rest } = next;
      next = rest;
    }
    touched = true;
  }
  // `null` is what a section with no padding of its own reads back as, and
  // Number(null) is 0 — writing that would silently flatten somebody's
  // hand-drawn layout on a save that changed nothing.
  if (style.padding != null && style.padding !== '' && Number.isFinite(Number(style.padding))) {
    const n = String(Math.max(0, Math.round(Number(style.padding))));
    const current = next.padding && typeof next.padding === 'object' ? next.padding : {};
    next = {
      ...next,
      padding: {
        unit: 'px',
        top: n,
        right: current.right != null ? String(current.right) : '20',
        bottom: n,
        left: current.left != null ? String(current.left) : '20',
        isLinked: false,
      },
    };
    touched = true;
  }

  let out = touched ? { ...section, settings: next } : section;

  if ('headingFont' in style) {
    const font = String(style.headingFont || '').trim();
    const heads = headingWidgetsOf(out);
    if (heads.length) {
      const wanted = new Set(heads);
      const rewrite = (n) => {
        if (!n || typeof n !== 'object') return n;
        let node = n;
        if (wanted.has(n)) {
          const st = { ...(n.settings || {}) };
          if (font) {
            st.typography_typography = 'custom';
            st.typography_font_family = font;
          } else {
            delete st.typography_typography;
            delete st.typography_font_family;
          }
          node = { ...n, settings: st };
        }
        if (Array.isArray(node.elements)) node = { ...node, elements: node.elements.map(rewrite) };
        return node;
      };
      out = { ...out, elements: (out.elements || []).map(rewrite) };
    }
  }
  return out;
}

/** The columns of a content section, in page order. */
function contentColumns(section) {
  const cols = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const marker = node.settings?.[COLUMN_MARKER];
    if (marker != null && Number.isInteger(Number(marker))) cols[Number(marker)] = node;
    if (Array.isArray(node.elements)) node.elements.forEach(walk);
  };
  walk(section);
  return cols.filter(Boolean);
}

/** How many columns this content section has. Always 1, 2 or 3. */
export function countColumns(section) {
  const n = contentColumns(section).length;
  return n >= 1 && n <= 3 ? n : 1;
}

/**
 * Every content block on the section, in page order, each carrying the column
 * it sits in. Blocks the author put in column 2 come back in column 2.
 */
export function readContentBlocks(section) {
  const out = [];
  contentColumns(section).forEach((col, i) => {
    const index = Number(col.settings?.[COLUMN_MARKER]);
    const colIndex = Number.isInteger(index) ? index : i;
    /* A STAMPED NODE IS ONE BLOCK, AND THE WALK STOPS THERE. A box's children
       come back INSIDE it (`readContentWidget`), so descending past it would
       list every nested widget a second time at the top level — which is a
       page that gains a copy of itself on every save. */
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.settings?.[BLOCK_MARKER]) { out.push({ ...readContentWidget(node), col: colIndex }); return; }
      if (Array.isArray(node.elements)) node.elements.forEach(walk);
    };
    (Array.isArray(col.elements) ? col.elements : []).forEach(walk);
  });
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   A SECTION SOMEBODY BUILT ON THEIR OWN WEBSITE (B-168, 2026-09-22)
   ──────────────────────────────────────────────────────────────────────────
   Brandon: "then I can't actually edit anything." Every page on a client's
   real site is Elementor work done ON THE SITE, and until now the only thing
   the builder could read was our own stamp. Those pages came back locked.

   They are now read by `elementorReader.js` — the reverse of the emitter — and
   what comes back is EXACTLY the shape a free section already has: a list of
   blocks, boxes nested inside boxes, each block carrying the Elementor id it
   was read from. So the Portal needs no new section kind and no new screen:
   somebody else's page opens as "Words and pictures", with their words and
   their pictures in it.

   The three functions below are the seam. Nothing else in this file knows the
   reader exists, and the reader knows nothing about section kinds.
   ════════════════════════════════════════════════════════════════════════ */

/**
 * Is this a section we did not author?
 *
 * ONE question, asked in ONE place. `reduceToSectionList` used to ask it
 * inline and answer it twice — once for "custom" and once for an ia tree
 * section — and the two answers led to two different dead ends.
 */
export function isForeignSection(node) {
  const parsed = parseSectionHandle(node?.settings?._title);
  return !(parsed && sectionKindMeta(parsed.kind));
}

/**
 * THE ONE QUESTION BOTH SIDES ASK: does this section read as somebody else's?
 *
 * Two cases, one answer. A section with no `ia:<kind>:…` handle was built on
 * the website. A section that HAS one but carries none of the field markers
 * that handle promises is one of ours that lost them — the old
 * `reason: 'no_field_markers'` dead end — and it is in exactly the same
 * position: we cannot patch it through its archetype's bindings, and we can
 * read its Elementor tree.
 *
 * `reduceToSectionList` asks this to decide how to READ, and `buildNodes` asks
 * the same function to decide how to WRITE. One predicate, so the two can
 * never disagree — a section read as blocks and written through an archetype
 * would put a page back as something it is not.
 */
export function readsAsForeign(node) {
  if (isForeignSection(node)) return true;
  const parsed = parseSectionHandle(node?.settings?._title);
  return !(collectMarked(node).length > 0
    || node?.settings?._ia_field_section != null
    || (parsed?.kind === 'content' && contentColumns(node).length > 0));
}

/** What a client's own Elementor section looks like to the builder. */
export function readForeignFields(section) {
  return {
    layout: 1,
    blocks: readSectionBlocks(section, { stamped: readContentWidget }),
    style: extractSectionStyle(section),
  };
}

/**
 * And back — the write that changes NOTHING when nothing changed.
 *
 * The guarantee lives in `elementorReader.writeSection`: a block still saying
 * what its node said is written back as that very node. This function only
 * hands the reader the two halves of the builder it does not own — how we read
 * a node we stamped, and how we build one.
 */
export function applyForeignFields(section, fields, ctx = {}) {
  /* A KIND NOTHING CAN EMIT IS REFUSED BY NAME, HERE, BEFORE ANYTHING IS
     WRITTEN. `buildContentWidget` falls back to an empty paragraph for a kind
     it does not know, which on this path would silently replace a widget on a
     client's live page with a blank — the green-toast-over-a-blank-page
     failure `reference_catch_swallow_report_success` is about. */
  const checkKinds = (list, path) => {
    for (const [i, block] of (Array.isArray(list) ? list : []).entries()) {
      const kind = String(block?.kind || '');
      if (!blockKindAllowed(kind)) {
        throw new UnsupportedWidgetError(`We do not have a part called “${kind}”.`, kind || 'unknown');
      }
      if (kind === CONTAINER_BLOCK_KIND) checkKinds(block[BLOCK_CHILDREN_KEY], `${path}[${i}]`);
    }
  };
  if (Array.isArray(fields?.blocks)) checkKinds(fields.blocks, 'blocks');

  const written = Array.isArray(fields?.blocks)
    ? writeSection(section, fields.blocks, {
      stamped: readContentWidget,
      build: (props, id, prior, depth) => buildContentWidget(props, id, prior, ctx, depth),
      buildBox: (block, prior, depth, kids) => buildContentBox(block, prior?.id || null, prior, ctx, depth, kids),
    })
    : section;
  return applySectionStyle(written, fields?.style);
}

/** How wide one of `n` columns is. Kept here so emit and patch agree. */
function columnWidth(n) {
  return n === 1 ? 100 : n === 2 ? 48 : 31;
}

function contentColumnContainer(index, total, id, previous = null) {
  return {
    id: id || freshId(),
    elType: 'container',
    settings: {
      ...(previous?.settings || {
        container_type: 'flex',
        content_width: 'full',
        flex_direction: 'column',
        flex_gap: { unit: 'px', size: 16, sizes: [] },
      }),
      [COLUMN_MARKER]: index,
      width: { unit: '%', size: columnWidth(total), sizes: [] },
    },
    elements: [],
    isInner: true,
  };
}

/**
 * Build the INSIDE of a content section from its two fields.
 *
 * ONE implementation, called by the emitter (a brand-new section) and by
 * `applyFields` (an edit to one that already exists), so an edited section and
 * a freshly built one are the same shape — which is the only reason the round
 * trip below can be an equality assertion rather than a "close enough".
 *
 * @param {object} fields   { layout, blocks }
 * @param {object} previous the existing row container, when there is one
 */
export function buildContentRow(fields, previous = null, seed = null, ctx = {}) {
  const layout = [1, 2, 3].includes(Number(fields?.layout)) ? Number(fields.layout) : 1;
  const blocks = Array.isArray(fields?.blocks) ? fields.blocks : [];
  const priorCols = previous ? contentColumns(previous) : [];
  const priorWidgets = priorCols.map((c) => (Array.isArray(c.elements) ? c.elements.slice() : []));

  const columns = [];
  for (let i = 0; i < layout; i++) {
    const col = contentColumnContainer(i, layout, priorCols[i]?.id || (seed ? `${seed}-col-${i}` : null), priorCols[i]);
    const mine = blocks.filter((b) => (Number(b?.col) || 0) === i || (i === layout - 1 && (Number(b?.col) || 0) > layout - 1));
    col.elements = mine.map((block, j) => {
      const prior = priorWidgets[i]?.[j] || null;
      return buildContentWidget(block, prior?.id || (seed ? `${seed}-w-${i}-${j}` : null), prior, ctx, 1);
    });
    columns.push(col);
  }

  return {
    id: previous?.id || (seed ? `${seed}-row` : freshId()),
    elType: 'container',
    settings: {
      ...(previous?.settings || {}),
      container_type: 'flex',
      content_width: 'full',
      flex_direction: 'row',
      flex_wrap: 'wrap',
      flex_gap: { unit: 'px', size: 32, sizes: [] },
      flex_align_items: 'flex-start',
      _ia_row: 1,
    },
    elements: columns,
    isInner: true,
  };
}

/**
 * What a form is FOR.
 *
 * ONE HOME, and it is `formPurpose.js` (D-156 conformance, audit point 11).
 * This file used to keep its own purpose ↔ class tables and `elementorAdapter`
 * kept a second pair that did not hold the same keys; both are gone. The list
 * and the two codecs are re-exported here because the editor's field spec
 * below renders from `FORM_PURPOSES` and several tests read the codecs off
 * this module — one implementation, two doors, never a copy.
 */
export { normalizeFormPurpose, FORM_PURPOSE_KEY } from './formPurpose.js';
export { FORM_PURPOSES };
export { purposeFromCssClass, cssClassFromPurpose, formPurposeSettings, formPurposeOf };

/* ==========================================================================
 * 2. Bindings — binding id -> where the value lives in Elementor.
 *
 * Shapes:
 *   { on:'widget', widget:'heading', fields:{ <fieldKey>: { setting, codec } } }
 *   { on:'section',                  fields:{ ... } }              (section settings)
 *   { on:'widget', repeat:'widget',  list:'services', item:{...} } (one widget per item)
 *   { on:'widget', repeat:'setting', list:'faqs', setting:'tabs', item:{...} }
 *   { on:'widget', codec:'gallery' | 'testimonial_card' | 'contact_methods' | 'form' }
 *
 * `setting` accepts a dotted path (`link.url`) — one level of nesting is all
 * Elementor needs here.
 * ======================================================================== */

export const BINDINGS = Object.freeze({
  'hero.headline':      { on: 'widget', widget: 'heading',     fields: { headline: { setting: 'title' } } },
  'hero.subheadline':   { on: 'widget', widget: 'text-editor', fields: { subheadline: { setting: 'editor', codec: 'html_text' } } },
  'hero.cta':           { on: 'widget', widget: 'button',      fields: { cta_text: { setting: 'text' }, cta_href: { setting: 'link.url' } } },
  'hero.background':    {
    on: 'section',
    fields: {
      image_url: { setting: 'background_image.url' },
      image_id:  { setting: 'background_image.id', codec: 'attachment_id' },
    },
  },

  'services.headline':    { on: 'widget', widget: 'heading',     fields: { headline: { setting: 'title' } } },
  'services.subheadline': { on: 'widget', widget: 'text-editor', fields: { subheadline: { setting: 'editor', codec: 'html_text' } } },
  'services.items':       {
    on: 'widget', widget: 'icon-box', repeat: 'widget', list: 'services',
    item: {
      title:       { setting: 'title_text' },
      description: { setting: 'description_text' },
      icon_name:   { setting: 'selected_icon.value', codec: 'fa_icon' },
    },
  },

  'testimonials.headline':    { on: 'widget', widget: 'heading',     fields: { headline: { setting: 'title' } } },
  'testimonials.subheadline': { on: 'widget', widget: 'text-editor', fields: { subheadline: { setting: 'editor', codec: 'html_text' } } },
  'testimonials.items':       {
    on: 'widget', widget: 'text-editor', repeat: 'widget', list: 'testimonials',
    composed: 'testimonial_card', setting: 'editor',
  },

  'cta.headline':    { on: 'widget', widget: 'heading',     fields: { headline: { setting: 'title' } } },
  'cta.subheadline': { on: 'widget', widget: 'text-editor', fields: { subheadline: { setting: 'editor', codec: 'html_text' } } },
  'cta.primary':     { on: 'widget', widget: 'button',      fields: { primary_cta_text: { setting: 'text' }, primary_cta_href: { setting: 'link.url' } } },
  'cta.secondary':   { on: 'widget', widget: 'button',      fields: { secondary_cta_text: { setting: 'text' }, secondary_cta_href: { setting: 'link.url' } } },

  'about.headline':    { on: 'widget', widget: 'heading',     fields: { headline: { setting: 'title' } } },
  'about.subheadline': { on: 'widget', widget: 'text-editor', fields: { subheadline: { setting: 'editor', codec: 'html_em' } } },
  'about.story':       { on: 'widget', widget: 'text-editor', fields: { story_paragraphs: { setting: 'editor', codec: 'html_paragraphs' } } },
  'about.image':       {
    on: 'widget', widget: 'image',
    fields: {
      image_url: { setting: 'image.url' },
      image_alt: { setting: 'image.alt' },
      image_id:  { setting: 'image.id', codec: 'attachment_id' },
    },
  },
  'about.values':      {
    on: 'widget', widget: 'icon-box', repeat: 'widget', list: 'values',
    item: { title: { setting: 'title_text' }, description: { setting: 'description_text' } },
  },

  'faq.headline':    { on: 'widget', widget: 'heading',     fields: { headline: { setting: 'title' } } },
  'faq.subheadline': { on: 'widget', widget: 'text-editor', fields: { subheadline: { setting: 'editor', codec: 'html_text' } } },
  'faq.items':       {
    on: 'widget', widget: 'accordion', repeat: 'setting', list: 'faqs', setting: 'tabs',
    item: { question: { setting: 'tab_title' }, answer: { setting: 'tab_content', codec: 'html_text' } },
  },

  'gallery.headline':    { on: 'widget', widget: 'heading',     fields: { headline: { setting: 'title' } } },
  'gallery.subheadline': { on: 'widget', widget: 'text-editor', fields: { subheadline: { setting: 'editor', codec: 'html_text' } } },
  'gallery.items':       { on: 'widget', widget: 'image-gallery', composed: 'gallery', list: 'images' },

  // ARION pack 2 - the three archetypes that stranded the curated library's
  // pricing, team and stats variants. Each follows an existing pattern
  // exactly: pricing is the testimonials shape (one composed card per widget),
  // team and stats are the services shape (one purpose-built widget per item).
  'pricing.headline':    { on: 'widget', widget: 'heading',     fields: { headline: { setting: 'title' } } },
  'pricing.subheadline': { on: 'widget', widget: 'text-editor', fields: { subheadline: { setting: 'editor', codec: 'html_text' } } },
  'pricing.plans':       {
    on: 'widget', widget: 'text-editor', repeat: 'widget', list: 'plans',
    composed: 'pricing_card', setting: 'editor',
  },

  'team.headline':    { on: 'widget', widget: 'heading',     fields: { headline: { setting: 'title' } } },
  'team.subheadline': { on: 'widget', widget: 'text-editor', fields: { subheadline: { setting: 'editor', codec: 'html_text' } } },
  // `image-box` is Elementor's own FREE person card: a picture, a name and a
  // line under it, in ONE widget. One widget per person is what lets the list
  // grow and shrink the way services already does.
  'team.members':     {
    on: 'widget', widget: 'image-box', repeat: 'widget', list: 'members',
    item: {
      name:      { setting: 'title_text' },
      role:      { setting: 'description_text' },
      photo_url: { setting: 'image.url' },
      photo_alt: { setting: 'image.alt' },
      photo_id:  { setting: 'image.id', codec: 'attachment_id' },
    },
  },

  'stats.headline':    { on: 'widget', widget: 'heading',     fields: { headline: { setting: 'title' } } },
  'stats.subheadline': { on: 'widget', widget: 'text-editor', fields: { subheadline: { setting: 'editor', codec: 'html_text' } } },
  // `counter` is Elementor's own FREE number widget, and it is what a stats
  // band is drawn with. Its prefix and suffix are separate settings, which is
  // why the currency sign and the % are their own fields rather than part of
  // the number - putting them in the number stops the count-up animating.
  'stats.items':       {
    on: 'widget', widget: 'counter', repeat: 'widget', list: 'stats',
    item: {
      value:  { setting: 'ending_number' },
      prefix: { setting: 'prefix' },
      suffix: { setting: 'suffix' },
      label:  { setting: 'title' },
    },
  },

  /* ------------------------------------------------------------------------
   * ARION pack 2b — THE LIST-ITEM BINDING FORM.
   *
   * Everything above holds a list as ONE widget per item: one icon-box per
   * service, one composed text-editor per price card, one counter per number.
   * That is how WE draw a list, and it is the only shape pack 2 taught the
   * adapter, so every hand-drawn pricing, team, stats and testimonials layout
   * in the curated library was refused — 0 of 40 (MASTER_DEFECT_REGISTER §4d,
   * D-83). A person drawing a price card in Elementor does not reach for one
   * widget; they draw a CARD: a container with a name, a price, a period, a
   * list and a button inside it.
   *
   * So this is the second shape: `repeat:'container'`. The ITEM is a
   * container, stamped `_ia_field` like any other bound node, and each widget
   * inside it carries `_ia_role` naming which part of the item it holds. One
   * item = one container, roles named, nothing about the layout touched.
   *
   * A role names the WIDGET TYPE it may be filled by, so a role can never be
   * put on the wrong kind of widget, and then either:
   *   `fields` — setting -> field, exactly as a plain binding does; or
   *   `part`   — ONE setting <-> several fields, through COMPOSED_PARTS.
   * `on:'container'` puts a role on the item container itself, for the one
   * value a hand-drawn card has nowhere to keep (which service a price is).
   *
   * WHICH widget gets which role is decided in libraryAdapter.js, because
   * that is a question about a layout and this file is a question about a
   * section. What lives here is the vocabulary, and it is DATA, like the rest.
   * ---------------------------------------------------------------------- */
  'pricing.plan_cards': {
    on: 'widget', repeat: 'container', list: 'plans',
    roles: {
      name:     { widget: 'heading',     fields: { name:  { setting: 'title' } } },
      price:    { widget: 'heading',     fields: { price: { setting: 'title' } } },
      period:   { widget: 'text-editor', fields: { period: { setting: 'editor', codec: 'html_text' } } },
      features: { widget: 'text-editor', fields: { features: { setting: 'editor', codec: 'html_lines' } } },
      cta:      { widget: 'button',      fields: { cta_text: { setting: 'text' }, cta_href: { setting: 'link.url' } } },
      // Elementor's icon-box draws a whole small card in one widget: an icon,
      // a title and a line under it. Two of the library's price layouts use
      // one for the top of the card.
      plan_box: {
        widget: 'icon-box',
        fields: { name: { setting: 'title_text' }, price: { setting: 'description_text' } },
      },
      // Which service in the price list this card is. There is nowhere on a
      // hand-drawn card to keep it, so it rides on the card's own container —
      // which is ours to stamp. Without it "Use my current prices" would have
      // to match on a name the client can change.
      identity: { on: 'container', fields: { offering_id: { setting: '_ia_offering' } } },
    },
  },

  'team.member_cards': {
    on: 'widget', repeat: 'container', list: 'members',
    roles: {
      photo: {
        widget: 'image',
        fields: {
          photo_url: { setting: 'image.url' },
          photo_alt: { setting: 'image.alt' },
          photo_id:  { setting: 'image.id', codec: 'attachment_id' },
        },
      },
      name: { widget: 'heading',     fields: { name: { setting: 'title' } } },
      role: { widget: 'text-editor', fields: { role: { setting: 'editor', codec: 'html_text' } } },
    },
  },

  'stats.stat_cards': {
    on: 'widget', repeat: 'container', list: 'stats',
    roles: {
      number: { widget: 'heading',     part: { setting: 'title', codec: 'stat_number' } },
      label:  { widget: 'text-editor', fields: { label: { setting: 'editor', codec: 'html_text' } } },
      stat_box: {
        widget: 'icon-box',
        part: { setting: 'title_text', codec: 'stat_number' },
        fields: { label: { setting: 'description_text' } },
      },
    },
  },

  'testimonials.quote_cards': {
    on: 'widget', repeat: 'container', list: 'testimonials',
    roles: {
      quote:       { widget: 'text-editor', fields: { quote: { setting: 'editor', codec: 'html_text' } } },
      attribution: { widget: 'heading',     fields: { attribution: { setting: 'title' } } },
      role:        { widget: 'text-editor', fields: { role: { setting: 'editor', codec: 'html_text' } } },
    },
  },

  'contact.headline':    { on: 'widget', widget: 'heading',     fields: { headline: { setting: 'title' } } },
  'contact.subheadline': { on: 'widget', widget: 'text-editor', fields: { subheadline: { setting: 'editor', codec: 'html_text' } } },
  'contact.methods':     {
    on: 'widget', widget: 'icon-list', repeat: 'setting', list: 'contact_methods',
    setting: 'icon_list', composedItem: 'contact_method',
  },
  'contact.form':        { on: 'widget', widget: 'form', composed: 'form' },

  /* ------------------------------------------------------------------------
   * The THIRD repeat form: `mixed`.
   *
   * One item per stamped widget, and the widget's own `_ia_w` says which kind
   * of block it is. Unlike `container` (a hand-drawn card, patched in place)
   * a content block is ours end to end, so it is REBUILT from its values —
   * which is what lets an author change a paragraph into a heading, or drop a
   * picture between two paragraphs, without a second editor.
   * ---------------------------------------------------------------------- */
  'content.blocks': { on: 'widget', repeat: 'mixed', list: 'blocks' },
});

/* ==========================================================================
 * 3. Fields — what the client sees. Plain words, no Elementor vocabulary,
 *    no "tenant" (memory: feedback_no_tenant_in_ui).
 * ======================================================================== */

const F = (key, label, type, extra = {}) => ({ key, label, type, ...extra });

/**
 * The attachment id that travels with a picture.
 * ---------------------------------------------------------------------------
 * `hidden` because there is nothing for a person to type here — the picture
 * picker sets it when they choose or upload an image, and the Portal renders
 * nothing for a hidden spec. It is still a first-class field so it survives
 * `validateFields`, `applyFields` and the round trip like any other.
 *
 * `notForAi` because a model must never invent one: an id that points at
 * somebody else's attachment (or at nothing) would silently swap or break the
 * picture, and the client would be approving a diff that did not say so.
 */
const IMAGE_ID = (key, label) => F(key, label, 'hidden', { notForAi: true });

/**
 * The section's own look, on every kind.
 *
 * `hidden` because there is nothing to type: the canvas toolbar and the
 * inspector set it. `notForAi` because a model rewriting the WORDS of a
 * section must never be able to repaint it.
 */
const STYLE_FIELD = F('style', 'Look', 'hidden', { notForAi: true });

const DESCRIBE_HELP =
  'Say what is in the picture, so somebody using a screen reader — and Google — knows what it shows.';

export const SECTION_KINDS = Object.freeze({
  hero: {
    kind: 'hero',
    label: 'Hero banner',
    blurb: 'The big banner at the top of a page — one headline, one line of support, one button.',
    fields: [
      STYLE_FIELD,
      F('headline', 'Headline', 'text', { required: true, max: 140 }),
      F('subheadline', 'Supporting line', 'textarea', { max: 400 }),
      F('cta_text', 'Button text', 'text', { max: 60 }),
      F('cta_href', 'Button link', 'link', { offersBooking: true }),
      F('image_url', 'Background picture', 'image', {
        // No altKey: a CSS background is decorative and screen readers skip
        // it, so asking for a description would be asking for noise.
        idKey: 'image_id',
        help: 'This one sits behind the words, so there is nothing to describe — screen readers skip it.',
      }),
      IMAGE_ID('image_id', 'Background picture reference'),
    ],
  },
  services: {
    kind: 'services',
    label: 'What you do',
    blurb: 'A row of cards, one per service, each with a short description.',
    fields: [
      STYLE_FIELD,
      F('headline', 'Headline', 'text', { required: true, max: 140 }),
      F('subheadline', 'Supporting line', 'textarea', { max: 400 }),
      F('services', 'Services', 'list', {
        itemLabel: 'Service', min: 1, max: 8,
        item: [
          F('title', 'Name', 'text', { required: true, max: 80 }),
          F('description', 'Description', 'textarea', { max: 400 }),
          F('icon_name', 'Icon', 'icon'),
        ],
      }),
    ],
  },
  testimonials: {
    kind: 'testimonials',
    label: 'What customers say',
    blurb: 'Quotes from real customers, with who said them.',
    fields: [
      STYLE_FIELD,
      F('headline', 'Headline', 'text', { required: true, max: 140 }),
      F('subheadline', 'Supporting line', 'textarea', { max: 400 }),
      F('testimonials', 'Quotes', 'list', {
        itemLabel: 'Quote', min: 1, max: 8,
        item: [
          F('quote', 'What they said', 'textarea', { required: true, max: 600 }),
          F('attribution', 'Who said it', 'text', { max: 80 }),
          F('role', 'Their job or company', 'text', { max: 120 }),
          F('rating', 'Stars', 'rating'),
        ],
      }),
    ],
  },
  cta: {
    kind: 'cta',
    label: 'Call to action',
    blurb: 'A wide band with a headline and one or two buttons.',
    fields: [
      STYLE_FIELD,
      F('headline', 'Headline', 'text', { required: true, max: 140 }),
      F('subheadline', 'Supporting line', 'textarea', { max: 400 }),
      F('primary_cta_text', 'Main button text', 'text', { max: 60 }),
      F('primary_cta_href', 'Main button link', 'link', { offersBooking: true }),
      F('secondary_cta_text', 'Second button text', 'text', { max: 60 }),
      F('secondary_cta_href', 'Second button link', 'link', { offersBooking: true }),
    ],
  },
  about: {
    kind: 'about',
    label: 'About the business',
    blurb: 'Your story beside a picture, then the things you stand for.',
    fields: [
      STYLE_FIELD,
      F('headline', 'Headline', 'text', { required: true, max: 140 }),
      F('subheadline', 'Supporting line', 'textarea', { max: 400 }),
      F('story_paragraphs', 'Your story', 'paragraphs', { max: 6 }),
      F('image_url', 'Picture', 'image', { idKey: 'image_id', altKey: 'image_alt' }),
      IMAGE_ID('image_id', 'Picture reference'),
      F('image_alt', 'Describe the picture', 'text', {
        max: 200, requiredWith: 'image_url', help: DESCRIBE_HELP,
      }),
      F('values', 'What you stand for', 'list', {
        itemLabel: 'Value', min: 0, max: 6,
        item: [
          F('title', 'Name', 'text', { required: true, max: 80 }),
          F('description', 'Description', 'textarea', { max: 400 }),
        ],
      }),
    ],
  },
  faq: {
    kind: 'faq',
    label: 'Questions and answers',
    blurb: 'The questions customers keep asking, with your answers.',
    fields: [
      STYLE_FIELD,
      F('headline', 'Headline', 'text', { required: true, max: 140 }),
      F('subheadline', 'Supporting line', 'textarea', { max: 400 }),
      F('faqs', 'Questions', 'list', {
        itemLabel: 'Question', min: 1, max: 20,
        item: [
          F('question', 'Question', 'text', { required: true, max: 200 }),
          F('answer', 'Answer', 'textarea', { max: 1200 }),
        ],
      }),
    ],
  },
  gallery: {
    kind: 'gallery',
    label: 'Picture gallery',
    blurb: 'A grid of photographs of your work.',
    fields: [
      STYLE_FIELD,
      F('headline', 'Headline', 'text', { required: true, max: 140 }),
      F('subheadline', 'Supporting line', 'textarea', { max: 400 }),
      F('images', 'Pictures', 'list', {
        itemLabel: 'Picture', min: 1, max: 24,
        item: [
          F('url', 'Picture', 'image', { required: true, idKey: 'id', altKey: 'alt' }),
          IMAGE_ID('id', 'Picture reference'),
          F('alt', 'Describe the picture', 'text', {
            max: 200, requiredWith: 'url', help: DESCRIBE_HELP,
          }),
          F('caption', 'Caption', 'text', { max: 200 }),
          F('category', 'Group', 'text', { max: 80 }),
        ],
      }),
    ],
  },
  pricing: {
    kind: 'pricing',
    label: 'What it costs',
    blurb: 'Your prices, one card per package, with what each one includes.',
    fields: [
      STYLE_FIELD,
      F('headline', 'Headline', 'text', { required: true, max: 140 }),
      F('subheadline', 'Supporting line', 'textarea', { max: 400 }),
      F('plans', 'Packages', 'list', {
        itemLabel: 'Package', min: 1, max: 6,
        item: [
          F('name', 'Name', 'text', { required: true, max: 80 }),
          // THE ONE PRICE SOURCE. A price is never typed twice: the section is
          // built from your services and prices, and "Use my current prices"
          // refills it from the same place. It stays typeable because a
          // business with no price list still needs to be able to say "from
          // $99", and a read-only box nobody can fill is worse than one they
          // can.
          F('price', 'Price', 'text', {
            max: 40, notForAi: true, source: 'catalog',
            help: 'This comes from your services and prices. Change it there and press "Use my current prices".',
          }),
          F('period', 'How often', 'text', { max: 40, help: 'e.g. per month, per visit, one-off.' }),
          F('summary', 'One line about it', 'textarea', { max: 400 }),
          F('features', 'What is included', 'paragraphs', { max: 8, itemLabel: 'Line' }),
          F('cta_text', 'Button text', 'text', { max: 60 }),
          F('cta_href', 'Button link', 'link', { offersBooking: true }),
          // Which service in your price list this card came from. Hidden
          // because there is nothing to type, notForAi because a model
          // inventing one would point a price at somebody else's service.
          F('offering_id', 'Price list reference', 'hidden', { notForAi: true }),
        ],
      }),
    ],
  },
  team: {
    kind: 'team',
    label: 'The people',
    blurb: 'Who works here, with a photograph and what they do.',
    fields: [
      STYLE_FIELD,
      F('headline', 'Headline', 'text', { required: true, max: 140 }),
      F('subheadline', 'Supporting line', 'textarea', { max: 400 }),
      F('members', 'People', 'list', {
        itemLabel: 'Person', min: 1, max: 12,
        item: [
          F('name', 'Name', 'text', { required: true, max: 80 }),
          F('role', 'What they do', 'text', { max: 200 }),
          F('photo_url', 'Photograph', 'image', { idKey: 'photo_id', altKey: 'photo_alt' }),
          IMAGE_ID('photo_id', 'Photograph reference'),
          F('photo_alt', 'Describe the photograph', 'text', {
            max: 200, requiredWith: 'photo_url', help: DESCRIBE_HELP,
          }),
        ],
      }),
    ],
  },
  stats: {
    kind: 'stats',
    label: 'Numbers that matter',
    blurb: 'A band of figures — years in business, jobs done, how fast you answer.',
    fields: [
      STYLE_FIELD,
      F('headline', 'Headline', 'text', { required: true, max: 140 }),
      F('subheadline', 'Supporting line', 'textarea', { max: 400 }),
      F('stats', 'Numbers', 'list', {
        itemLabel: 'Number', min: 1, max: 6,
        item: [
          F('value', 'The number', 'text', {
            required: true, max: 20,
            help: 'Just the number. Anything in front of it or after it goes in the two boxes below.',
          }),
          F('prefix', 'In front of it', 'text', { max: 10, help: 'e.g. $ or +' }),
          F('suffix', 'After it', 'text', { max: 10, help: 'e.g. % or hrs' }),
          F('label', 'What it counts', 'text', { required: true, max: 80 }),
        ],
      }),
    ],
  },
  contact: {
    kind: 'contact',
    label: 'Contact and form',
    blurb: 'How to reach you, next to a form that sends straight to your inbox.',
    requiresElementorPro: true,
    // D-157: the lock says the PLAN first, because that is the thing the
    // business can act on. No vendor name — the client never chose the page
    // engine (`feedback_no_third_party_product_surface`).
    proReason: 'Available on ARION Standard and above. This section includes a form, and a form needs a plan above Lite — or choose a layout without a form.',
    fields: [
      STYLE_FIELD,
      F('headline', 'Headline', 'text', { required: true, max: 140 }),
      F('subheadline', 'Supporting line', 'textarea', { max: 400 }),
      F('contact_methods', 'Ways to reach you', 'list', {
        itemLabel: 'Contact method', min: 0, max: 8,
        item: [
          F('kind', 'Type', 'choice', { options: ['phone', 'email', 'address', 'social', 'other'] }),
          F('label', 'Label', 'text', { required: true, max: 60 }),
          F('value', 'What it says', 'text', { max: 200 }),
          F('href', 'Where it goes', 'link'),
        ],
      }),
      // The two fields below are the WIRE, not copy. `form_purpose` decides
      // how a submission is filed (the plugin's interceptor reads the CSS
      // class this writes) and `email_to` decides whose inbox it lands in.
      // Both are `notForAi`: a model rewriting a section's words must never
      // be able to re-route the enquiries that section collects.
      F('form_purpose', 'What is this form for?', 'choice', {
        required: true,
        notForAi: true,
        options: FORM_PURPOSES.map((p) => p.value),
        optionLabels: FORM_PURPOSES,
        help: 'This decides how the enquiry is filed when it reaches you.',
      }),
      F('email_to', 'Enquiries go to', 'email', {
        required: true,
        notForAi: true,
        // Read-only on purpose: there is ONE business email and it lives on
        // your business details, so a form can never quietly point somewhere
        // nobody reads. The server fills it in from there when it is blank
        // and refuses to publish a form it cannot address.
        readOnly: true,
        source: 'business',
        help: 'This is the email on your business details. Change it under Settings → Your business.',
      }),
      F('submit_text', 'Button text', 'text', { max: 60 }),
      F('form_fields', 'What the form asks for', 'paragraphs', { max: 12, itemLabel: 'Field' }),
    ],
  },

  /**
   * The free section. Words, pictures, buttons and video in one, two or three
   * columns — the parts of a page the eleven whole-job archetypes above do not
   * cover, and the reason a client could not build an About page from scratch.
   *
   * Its two fields are STRUCTURE, not copy, which is why neither is offered to
   * a model: `layout` is how many columns, `blocks` is the ordered list the
   * builder's canvas edits in place. The edit sheet never renders either —
   * the builder does, on the page.
   */
  content: {
    kind: 'content',
    label: 'Words and pictures',
    blurb: 'A free section: headings, paragraphs, pictures, buttons and video, in one to three columns.',
    fields: [
      STYLE_FIELD,
      F('layout', 'Columns', 'hidden', { notForAi: true }),
      F('blocks', 'Content', 'hidden', { notForAi: true }),
    ],
  },
});

export function listSectionKinds() {
  return Object.keys(SECTION_KINDS);
}

export function sectionKindMeta(kind) {
  return SECTION_KINDS[String(kind || '').toLowerCase()] || null;
}

/**
 * The catalogue the Portal's "add a section" picker renders.
 * Lite has no Elementor Pro, so a Pro-dependent archetype is returned with
 * `available:false` and the reason stated — never silently dropped, because a
 * missing option is indistinguishable from a bug (SCOPE §3.6, T14).
 */
export function sectionCatalog({ allowPro = true, ownedProducts = null } = {}) {
  return listSectionKinds().map((kind) => {
    const meta = SECTION_KINDS[kind];
    const needsPro = !!meta.requiresElementorPro;
    /**
     * A SECTION MAY ALSO NEED A PRODUCT OF OURS — the third state.
     *
     * `requiresProduct: 'oliver'` on a section kind means the same as a
     * widget's `ia:oliver` tier, and it is answered the same way: the list of
     * products the business owns, or NULL for "we could not ask", which locks
     * nothing. The two reasons stay two reasons — `reference_nav_visibility_
     * semantics` — so the Portal can say "not on your website plan" and
     * "needs OLIVER, which this business does not have" as different things.
     */
    const product = meta.requiresProduct ? String(meta.requiresProduct).toLowerCase() : null;
    const notOwned = !!product && Array.isArray(ownedProducts)
      && !ownedProducts.map((p) => String(p).toLowerCase()).includes(product);
    const lockedByTier = !allowPro && needsPro;
    return {
      kind,
      label: meta.label,
      blurb: meta.blurb,
      /**
       * WHAT PLAN THIS NEEDS, in the same three words a WIDGET uses
       * (`elementorWidgets.js`: 'free' | 'pro' | 'ia:<product>').
       *
       * DERIVED, never stored twice: a section is a tree of widgets, so its
       * tier is the highest tier among them, and today `requiresElementorPro`
       * is the one fact that says so. When D-156 finishes decomposing the
       * composites into atomic widgets this reads the widgets directly and
       * the boolean goes — it is the same fact either way, which is why the
       * Portal is given the WORD and not the boolean.
       */
      tier: product ? `ia:${product}` : (needsPro ? 'pro' : 'free'),
      available: !lockedByTier && !notOwned,
      // WHY, as one word, beside the sentence. A pane that only prints the
      // sentence still draws the right thing; a pane that wants its own words
      // per state has them without a tier table of its own.
      reason: lockedByTier ? 'tier' : (notOwned ? 'ownership' : null),
      unavailableReason: lockedByTier
        ? meta.proReason
        : (notOwned ? `Needs ${product.toUpperCase()}, which this business does not have.` : null),
    };
  });
}

/* ==========================================================================
 * 4. The handle — `ia:<kind>:<blueprintId>:<blockId>` on settings._title.
 * ======================================================================== */

/**
 * Parse a section's `_title` handle. Returns null for anything we did not
 * mint, which is exactly the "custom section, leave it alone" case.
 */
export function parseSectionHandle(title) {
  if (!isIaSectionTitle(title)) return null;
  const parts = String(title).split(':');
  // ia : kind : blueprint : blockId   (blockId may itself be empty/"-")
  if (parts.length < 4) return null;
  const kind = parts[1] || '';
  const blueprintId = parts[2] || 'scratch';
  const blockId = parts.slice(3).join(':') || '-';
  if (!kind) return null;
  return { handle: title, kind, blueprintId, blockId: blockId === '-' ? null : blockId };
}

/* ==========================================================================
 * 5. Tree walking — read and patch, without disturbing anything else.
 * ======================================================================== */

function getPath(obj, path) {
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Returns a NEW object with `path` set — never mutates the input. */
function setPath(obj, path, value) {
  const parts = String(path).split('.');
  const head = parts[0];
  const base = (obj && typeof obj === 'object') ? obj : {};
  if (parts.length === 1) return { ...base, [head]: value };
  return { ...base, [head]: setPath(base[head], parts.slice(1).join('.'), value) };
}

function decodeValue(raw, spec) {
  const codec = CODECS[spec?.codec || 'text'] || CODECS.text;
  return codec.decode(raw);
}
function encodeValue(value, spec) {
  const codec = CODECS[spec?.codec || 'text'] || CODECS.text;
  return codec.encode(value);
}

/**
 * Every node in the section that carries `settings._ia_field`, in document
 * order, with the parent chain we need in order to clone or drop one.
 */
function collectMarked(section) {
  const found = [];
  const walk = (node, parent, indexInParent) => {
    if (!node || typeof node !== 'object') return;
    const marker = node.settings?._ia_field;
    if (typeof marker === 'string' && marker) {
      found.push({ node, marker, parent, indexInParent });
    }
    if (Array.isArray(node.elements)) {
      node.elements.forEach((child, i) => walk(child, node, i));
    }
  };
  if (Array.isArray(section?.elements)) {
    section.elements.forEach((child, i) => walk(child, section, i));
  }
  return found;
}

/** Group the marked nodes by binding id, preserving document order. */
function groupMarked(section) {
  const groups = new Map();
  for (const entry of collectMarked(section)) {
    if (!groups.has(entry.marker)) groups.set(entry.marker, []);
    groups.get(entry.marker).push(entry);
  }
  return groups;
}

function decodeGalleryItems(settings) {
  const gallery = Array.isArray(settings?.gallery) ? settings.gallery : [];
  const meta = Array.isArray(settings?.ia_gallery_meta) ? settings.ia_gallery_meta : [];
  return gallery.map((img, i) => ({
    url:      String(img?.url || ''),
    // The attachment id is what lets Elementor's gallery emit srcset and open
    // the lightbox at full size. It was always written as '' and therefore
    // always lost; the picker now supplies a real one.
    id:       CODECS.attachment_id.decode(img?.id),
    alt:      String(meta[i]?.alt || ''),
    caption:  String(meta[i]?.caption || ''),
    category: String(meta[i]?.category || ''),
  }));
}

/* --- The list-item binding form (repeat:'container') --------------------- */

/** Where a role marker lives, and where the review note lives. Both ours. */
export const ROLE_MARKER = '_ia_role';
export const ROLE_REVIEW_MARKER = '_ia_role_review';

/**
 * Every widget inside one item container that carries a role, by role name.
 * The FIRST of a role wins, so a layout that somehow carried two of the same
 * role reads the one the adapter stamped first rather than throwing.
 */
export function collectRoles(container) {
  const found = new Map();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const role = node.settings?.[ROLE_MARKER];
    if (typeof role === 'string' && role && !found.has(role)) found.set(role, node);
    if (Array.isArray(node.elements)) node.elements.forEach(walk);
  };
  if (Array.isArray(container?.elements)) container.elements.forEach(walk);
  return found;
}

/** Read one role's settings into the item object it contributes to. */
function readRoleInto(item, roleSpec, settings) {
  if (roleSpec?.part) {
    const part = COMPOSED_PARTS[roleSpec.part.codec];
    if (part) Object.assign(item, part.decode(getPath(settings, roleSpec.part.setting)));
  }
  for (const [fieldKey, spec] of Object.entries(roleSpec?.fields || {})) {
    item[fieldKey] = decodeValue(getPath(settings, spec.setting), spec);
  }
  return item;
}

/**
 * Write the item's values back onto one role's settings.
 *
 * A value the client did NOT change is not written back. That is not an
 * optimisation, it is the round-trip promise: a hand-drawn card is somebody
 * else's markup, and re-encoding it would quietly tidy `<p> /mo</p>` into
 * `<p>/mo</p>` and a bare `&` into `&amp;` on a page nobody edited. Saving a
 * page you only looked at must change nothing at all.
 */
function unchanged(currentRaw, value, decode) {
  try {
    return JSON.stringify(decode(currentRaw)) === JSON.stringify(value);
  } catch {
    return false;
  }
}

function writeRoleSettings(settings, roleSpec, item) {
  let next = settings;
  if (roleSpec?.part) {
    const part = COMPOSED_PARTS[roleSpec.part.codec];
    // A part is written only when at least one of the fields it owns arrived,
    // so an untouched list item never has its number rebuilt from blanks.
    const owned = ['value', 'prefix', 'suffix'].filter((k) => k in item);
    if (part && owned.length > 0) {
      const currentRaw = getPath(next, roleSpec.part.setting);
      const current = part.decode(currentRaw);
      const merged = { ...current, ...Object.fromEntries(owned.map((k) => [k, item[k]])) };
      if (!unchanged(currentRaw, merged, part.decode)) {
        next = setPath(next, roleSpec.part.setting, part.encode(merged));
      }
    }
  }
  for (const [fieldKey, spec] of Object.entries(roleSpec?.fields || {})) {
    if (!(fieldKey in item)) continue;
    const currentRaw = getPath(next, spec.setting);
    if (unchanged(currentRaw, item[fieldKey], (raw) => decodeValue(raw, spec))) continue;
    next = setPath(next, spec.setting, encodeValue(item[fieldKey], spec));
  }
  return next;
}

/** One item container -> the item object the edit sheet shows. */
export function decodeItemContainer(container, binding) {
  const roles = collectRoles(container);
  const item = {};
  for (const [roleKey, roleSpec] of Object.entries(binding.roles || {})) {
    if (roleSpec.on === 'container') {
      readRoleInto(item, roleSpec, container?.settings || {});
      continue;
    }
    const node = roles.get(roleKey);
    if (!node) continue;
    readRoleInto(item, roleSpec, node.settings || {});
  }
  return item;
}

/**
 * Which fields of a list item this layout actually has somewhere to keep.
 *
 * A hand-drawn card has no place for everything our own card carries — a
 * testimonial drawn as a quote and a name has nowhere to put a star rating.
 * Offering that box anyway would be a box you can type into that saves
 * nothing, which is the failure this codebase keeps finding
 * (memory: reference_catch_swallow_report_success). So the section says which
 * fields have a home and the edit sheet renders only those.
 */
export function itemFieldsFor(section, kind) {
  const out = {};
  for (const entry of collectMarked(section)) {
    const binding = BINDINGS[entry.marker];
    if (!binding || binding.repeat !== 'container') continue;
    if (!entry.marker.startsWith(`${kind}.`)) continue;
    if (out[binding.list]) continue;
    const roles = collectRoles(entry.node);
    const keys = new Set();
    for (const [roleKey, roleSpec] of Object.entries(binding.roles || {})) {
      const present = roleSpec.on === 'container' ? true : roles.has(roleKey);
      if (!present) continue;
      if (roleSpec.part) ['value', 'prefix', 'suffix'].forEach((k) => keys.add(k));
      Object.keys(roleSpec.fields || {}).forEach((k) => keys.add(k));
    }
    out[binding.list] = [...keys];
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The role assignments the adapter was not certain of, as recorded on the
 * section. `null` when there is nothing to check.
 */
export function roleReviewFor(section) {
  const raw = section?.settings?.[ROLE_REVIEW_MARKER];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw
    .filter((r) => r && Array.isArray(r.roles) && r.roles.length === 2)
    .map((r) => ({
      list: String(r.list || ''),
      roles: [String(r.roles[0]), String(r.roles[1])],
      fields: Array.isArray(r.fields) ? r.fields.map(String) : [],
      why: String(r.why || ''),
    }));
}

/**
 * Swap two roles over, in every item of the list, and drop the review note
 * that asked about them. Returns a NEW section; nothing is mutated, and
 * nothing but the two markers moves — the layout is untouched.
 */
export function swapItemRoles(section, kind, list, roleA, roleB) {
  const wanted = [String(roleA), String(roleB)].sort().join('|');
  let bindingId = null;
  for (const [id, binding] of Object.entries(BINDINGS)) {
    if (binding.repeat !== 'container' || !id.startsWith(`${kind}.`)) continue;
    if (binding.list !== list) continue;
    if (!binding.roles?.[roleA] || !binding.roles?.[roleB]) continue;
    // A swap only makes sense between two roles the SAME widget type can hold.
    if (binding.roles[roleA].widget !== binding.roles[roleB].widget) continue;
    bindingId = id;
    break;
  }
  if (!bindingId) return { ok: false, reason: 'unknown_roles' };

  const plan = { replacements: new Map(), removals: new Set(), inserts: new Map() };
  let swapped = 0;
  for (const entry of collectMarked(section)) {
    if (entry.marker !== bindingId) continue;
    const roles = collectRoles(entry.node);
    const a = roles.get(roleA);
    const b = roles.get(roleB);
    if (!a || !b) continue;
    plan.replacements.set(a, withSettings(a, { ...a.settings, [ROLE_MARKER]: roleB }));
    plan.replacements.set(b, withSettings(b, { ...b.settings, [ROLE_MARKER]: roleA }));
    swapped += 1;
  }
  if (swapped === 0) return { ok: false, reason: 'nothing_to_swap' };

  let next = rebuild(section, plan);
  const review = (Array.isArray(next.settings?.[ROLE_REVIEW_MARKER]) ? next.settings[ROLE_REVIEW_MARKER] : [])
    .filter((r) => [String(r?.roles?.[0]), String(r?.roles?.[1])].sort().join('|') !== wanted);
  next = {
    ...next,
    settings: review.length
      ? { ...next.settings, [ROLE_REVIEW_MARKER]: review }
      : Object.fromEntries(Object.entries(next.settings || {}).filter(([k]) => k !== ROLE_REVIEW_MARKER)),
  };
  return { ok: true, node: next, swapped };
}

function decodeFormFields(settings) {
  const rows = Array.isArray(settings?.form_fields) ? settings.form_fields : [];
  return rows.map((r) => String(r?.field_label || r?.custom_id || '')).filter(Boolean);
}

/**
 * Read the editable values out of one section we authored.
 *
 * @param {object} section  one top-level Elementor section node
 * @param {string} kind     the archetype from the handle
 * @returns {object} field values keyed exactly as SECTION_KINDS[kind].fields
 */
export function extractFields(section, kind) {
  const meta = sectionKindMeta(kind);
  if (!meta) return {};

  /* The free section reads by COLUMN, not by binding: its list is mixed, and
   * which column a block sits in is part of what the author built. An empty
   * content section is still a content section, so this branch answers before
   * the binding loop — which would find nothing to group. */
  if (kind === 'content') {
    return {
      layout: countColumns(section),
      blocks: readContentBlocks(section),
      style: extractSectionStyle(section),
    };
  }

  const groups = groupMarked(section);
  const out = { style: extractSectionStyle(section) };

  // Section-level bindings live on the section's own settings.
  for (const [id, binding] of Object.entries(BINDINGS)) {
    if (binding.on !== 'section') continue;
    if (!id.startsWith(`${kind}.`)) continue;
    if (section?.settings?._ia_field_section !== id) continue;
    for (const [fieldKey, spec] of Object.entries(binding.fields || {})) {
      out[fieldKey] = decodeValue(getPath(section.settings, spec.setting), spec);
    }
  }

  for (const [id, entries] of groups.entries()) {
    const binding = BINDINGS[id];
    if (!binding || !id.startsWith(`${kind}.`)) continue;
    const first = entries[0];

    if (binding.composed === 'gallery') {
      out[binding.list] = decodeGalleryItems(first.node.settings);
      continue;
    }
    if (binding.composed === 'form') {
      const s = first.node.settings || {};
      out.form_purpose = formPurposeOf(s);
      out.email_to     = String(s.email_to || '');
      out.submit_text  = String(s.button_text || '');
      out.form_fields  = decodeFormFields(s);
      continue;
    }
    // One CONTAINER per item, with named roles inside it — the shape a person
    // draws a card in. See the BINDINGS comment above `pricing.plan_cards`.
    if (binding.repeat === 'container') {
      out[binding.list] = entries.map((e) => decodeItemContainer(e.node, binding));
      continue;
    }
    if (binding.repeat === 'widget') {
      out[binding.list] = entries.map((e) => {
        const card = COMPOSED_CARDS[binding.composed];
        if (card) return card.decode(getPath(e.node.settings, binding.setting));
        const item = {};
        for (const [fieldKey, spec] of Object.entries(binding.item || {})) {
          item[fieldKey] = decodeValue(getPath(e.node.settings, spec.setting), spec);
        }
        return item;
      });
      continue;
    }
    if (binding.repeat === 'setting') {
      const rows = getPath(first.node.settings, binding.setting);
      const list = Array.isArray(rows) ? rows : [];
      out[binding.list] = list.map((row) => {
        if (binding.composedItem === 'contact_method') return decodeContactMethod(row);
        const item = {};
        for (const [fieldKey, spec] of Object.entries(binding.item || {})) {
          item[fieldKey] = decodeValue(row?.[spec.setting], spec);
        }
        return item;
      });
      continue;
    }
    for (const [fieldKey, spec] of Object.entries(binding.fields || {})) {
      out[fieldKey] = decodeValue(getPath(first.node.settings, spec.setting), spec);
    }
  }

  return out;
}

/* --- Patching -------------------------------------------------------------
 * Everything below returns NEW nodes. The section we were given is never
 * mutated, so a failed save cannot leave a half-edited tree behind.
 * ------------------------------------------------------------------------ */

let cloneCounter = 0;
function freshId() {
  cloneCounter = (cloneCounter + 1) % 0xffff;
  return (Date.now().toString(36) + cloneCounter.toString(36)).slice(-7);
}

/** Deep clone with every Elementor `id` regenerated (ids must be unique). */
function cloneWithNewIds(node) {
  const copy = JSON.parse(JSON.stringify(node));
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if ('id' in n) n.id = freshId();
    if (Array.isArray(n.elements)) n.elements.forEach(walk);
  };
  walk(copy);
  return copy;
}

/**
 * Rebuild a tree, replacing the nodes named by `replacements` (a Map keyed by
 * the ORIGINAL node object) and honouring `removals` (a Set of original nodes).
 * `inserts` maps an original node to extra nodes placed straight after it.
 */
function rebuild(node, plan) {
  if (!node || typeof node !== 'object') return node;
  let next = plan.replacements.get(node) || node;
  if (Array.isArray(next.elements)) {
    const children = [];
    for (const child of next.elements) {
      if (plan.removals.has(child)) continue;
      children.push(rebuild(child, plan));
      const extra = plan.inserts.get(child);
      if (extra) children.push(...extra);
    }
    next = { ...next, elements: children };
  }
  return next;
}

function withSettings(node, settings) {
  return { ...node, settings };
}

function applyItemToSettings(settings, binding, item) {
  let next = settings;
  for (const [fieldKey, spec] of Object.entries(binding.item || {})) {
    if (!(fieldKey in item)) continue;
    next = setPath(next, spec.setting, encodeValue(item[fieldKey], spec));
  }
  return next;
}

/**
 * Write the client's edits back into one section, touching only the settings
 * a binding names. Unknown fields are ignored; a missing field leaves the
 * current value alone (empty values never overwrite by accident —
 * memory: feedback_2026_06_17_lessons).
 *
 * @param {object} section  the section as it exists on the site now
 * @param {string} kind     archetype from the handle
 * @param {object} fields   the client's values
 * @returns {object} a NEW section node
 */
export function applyFields(section, kind, fields, ctx = {}) {
  const meta = sectionKindMeta(kind);
  if (!meta || !fields || typeof fields !== 'object') return section;

  /* A SECTION WE DID NOT AUTHOR IS NEVER PATCHED THROUGH AN ARCHETYPE.
   *
   * `reduceToSectionList` hands a client's own Elementor section back as
   * `kind: 'content'` — that is what it EDITS as — and the `content` branch
   * below rebuilds a section out of our own `_ia_row` / `_ia_col` columns. Run
   * on somebody else's page that would replace their layout with ours on the
   * first save. The same predicate the reader used decides here, so the read
   * and the write cannot disagree, and every caller of `applyFields` is
   * covered rather than just the save route (found by the round-trip test,
   * 2026-09-22). */
  if (Array.isArray(fields.blocks) && readsAsForeign(section)) {
    return applyForeignFields(section, fields, ctx);
  }

  /* ---- the free section ------------------------------------------------
   * Its contents are an ordered list of blocks that are ours end to end, so
   * the row is REBUILT from the list rather than patched node by node — which
   * is what lets a paragraph become a heading, and a picture be dropped
   * between two paragraphs, without a second editor. Each block keeps the id
   * and the settings of the block that was in its place, so an edit to the
   * words does not churn Elementor's ids or throw away an author's colour.
   * -------------------------------------------------------------------- */
  if (kind === 'content') {
    if (!Array.isArray(fields.blocks)) return applySectionStyle(section, fields.style);
    const children = Array.isArray(section.elements) ? section.elements : [];
    const priorRow = children.find((c) => c?.settings?._ia_row) || children[0] || null;
    const row = buildContentRow(fields, priorRow, null, ctx);
    return applySectionStyle({
      ...section,
      elements: children.length ? children.map((c) => (c === priorRow ? row : c)) : [row],
    }, fields.style);
  }

  // The background, the room around it and the heading font — what the canvas
  // toolbar and the inspector change. Written FIRST so the binding pass below
  // still sees the widgets it is about to patch.
  const styled = applySectionStyle(section, fields.style);
  if (styled !== section) section = styled;

  const plan = { replacements: new Map(), removals: new Set(), inserts: new Map() };
  const groups = groupMarked(section);

  for (const [id, entries] of groups.entries()) {
    const binding = BINDINGS[id];
    if (!binding || !id.startsWith(`${kind}.`)) continue;
    const first = entries[0];

    /* ---- whole-widget composites --------------------------------------- */
    if (binding.composed === 'gallery') {
      const items = fields[binding.list];
      if (!Array.isArray(items)) continue;
      const s = first.node.settings || {};
      plan.replacements.set(first.node, withSettings(first.node, {
        ...s,
        gallery: items.map((it, i) => ({
          id: CODECS.attachment_id.encode(it?.id),
          url: String(it?.url || ''),
          _meta_idx: i,
        })),
        ia_gallery_meta: items.map((it) => ({
          alt: String(it?.alt || ''), caption: String(it?.caption || ''), category: String(it?.category || ''),
        })),
        gallery_columns: items.length <= 6 ? 3 : 4,
      }));
      continue;
    }

    if (binding.composed === 'form') {
      const s = first.node.settings || {};
      let next = { ...s };
      // THE THREE KEYS, TOGETHER OR NOT AT ALL (`formPurpose.js`). A form
      // already on the page that says what it is for only through the legacy
      // class is healed on the next save — same purpose, all three keys — so
      // the alias can be dropped in one release rather than chased across
      // every published page.
      const purpose = fields.form_purpose !== undefined ? fields.form_purpose : formPurposeOf(s);
      next = { ...next, ...formPurposeSettings(purpose, s._css_classes) };
      if (fields.email_to !== undefined)     next.email_to = String(fields.email_to || '');
      if (fields.submit_text !== undefined)  next.button_text = String(fields.submit_text || '');
      if (Array.isArray(fields.form_fields)) {
        const previous = Array.isArray(s.form_fields) ? s.form_fields : [];
        next.form_fields = fields.form_fields
          .map((label) => String(label == null ? '' : label).trim())
          .filter(Boolean)
          .map((label, i) => buildFormField(label, previous[i]));
      }
      plan.replacements.set(first.node, withSettings(first.node, next));
      continue;
    }

    /* ---- one CONTAINER per list item, roles inside it -------------------
     * Same arithmetic as the widget form next door — patch the ones that are
     * there, drop the surplus, clone the last for the extras — but the unit
     * is the card, so a new card arrives with the whole card's design and not
     * just one widget's.
     * -------------------------------------------------------------------- */
    if (binding.repeat === 'container') {
      const items = fields[binding.list];
      if (!Array.isArray(items)) continue;

      entries.forEach((entry, i) => {
        if (i >= items.length) { plan.removals.add(entry.node); return; }
        const item = items[i] || {};
        const roles = collectRoles(entry.node);
        for (const [roleKey, roleSpec] of Object.entries(binding.roles || {})) {
          if (roleSpec.on === 'container') {
            const before = plan.replacements.get(entry.node)?.settings || entry.node.settings || {};
            const settings = writeRoleSettings(before, roleSpec, item);
            if (settings !== before) plan.replacements.set(entry.node, withSettings(entry.node, settings));
            continue;
          }
          const node = roles.get(roleKey);
          if (!node) continue;
          const settings = writeRoleSettings(node.settings, roleSpec, item);
          if (settings !== node.settings) plan.replacements.set(node, withSettings(node, settings));
        }
      });

      if (items.length > entries.length && entries.length > 0) {
        const last = entries[entries.length - 1];
        const extras = [];
        for (let i = entries.length; i < items.length; i++) {
          const copy = cloneWithNewIds(last.node);
          const item = items[i] || {};
          const roles = collectRoles(copy);
          for (const [roleKey, roleSpec] of Object.entries(binding.roles || {})) {
            if (roleSpec.on === 'container') {
              copy.settings = writeRoleSettings(copy.settings || {}, roleSpec, item);
              continue;
            }
            const node = roles.get(roleKey);
            if (!node) continue;
            node.settings = writeRoleSettings(node.settings, roleSpec, item);
          }
          extras.push(copy);
        }
        plan.inserts.set(last.node, extras);
      }
      continue;
    }

    /* ---- one widget per list item -------------------------------------- */
    if (binding.repeat === 'widget') {
      const items = fields[binding.list];
      if (!Array.isArray(items)) continue;

      entries.forEach((entry, i) => {
        if (i >= items.length) {
          // Dropped item: remove the widget, and its column if that empties it.
          const parent = entry.parent;
          if (parent && parent.elType === 'column' && (parent.elements || []).length === 1) {
            plan.removals.add(parent);
          } else {
            plan.removals.add(entry.node);
          }
          return;
        }
        const item = items[i] || {};
        const card = COMPOSED_CARDS[binding.composed];
        const settings = card
          ? setPath(entry.node.settings, binding.setting, card.encode(item))
          : applyItemToSettings(entry.node.settings, binding, item);
        plan.replacements.set(entry.node, withSettings(entry.node, settings));
      });

      // Added items: clone the last existing widget (or its wrapper) so the
      // new one inherits the styling of the ones already there.
      //
      // `column` is the classic Elementor wrapper; `container` is the flexbox
      // one every curated-library section uses (each card is a one-widget
      // container inside a row container). Cloning only the widget there
      // would drop the card's own padding, border and background, so a fourth
      // service would arrive looking nothing like the first three.
      if (items.length > entries.length) {
        const last = entries[entries.length - 1];
        const cloneColumn = last.parent
          && (last.parent.elType === 'column' || last.parent.elType === 'container')
          && (last.parent.elements || []).length === 1;
        const template = cloneColumn ? last.parent : last.node;
        const anchor = cloneColumn ? last.parent : last.node;
        const extras = [];
        for (let i = entries.length; i < items.length; i++) {
          const copy = cloneWithNewIds(template);
          const target = cloneColumn ? copy.elements[0] : copy;
          const item = items[i] || {};
          const card = COMPOSED_CARDS[binding.composed];
          target.settings = card
            ? setPath(target.settings, binding.setting, card.encode(item))
            : applyItemToSettings(target.settings, binding, item);
          extras.push(copy);
        }
        plan.inserts.set(anchor, extras);
      }
      continue;
    }

    /* ---- repeater rows inside one widget setting ------------------------ */
    if (binding.repeat === 'setting') {
      const items = fields[binding.list];
      if (!Array.isArray(items)) continue;
      const previous = getPath(first.node.settings, binding.setting);
      const prevRows = Array.isArray(previous) ? previous : [];
      const rows = items.map((item, i) => {
        if (binding.composedItem === 'contact_method') return encodeContactMethod(item, prevRows[i]);
        const row = { ...(prevRows[i] || { _id: freshId() }) };
        for (const [fieldKey, spec] of Object.entries(binding.item || {})) {
          if (!(fieldKey in item)) continue;
          row[spec.setting] = encodeValue(item[fieldKey], spec);
        }
        if (!row._id) row._id = freshId();
        return row;
      });
      plan.replacements.set(first.node, withSettings(
        first.node,
        setPath(first.node.settings, binding.setting, rows),
      ));
      continue;
    }

    /* ---- plain scalar fields -------------------------------------------- */
    let settings = first.node.settings;
    let touched = false;
    for (const [fieldKey, spec] of Object.entries(binding.fields || {})) {
      if (fields[fieldKey] === undefined) continue;
      settings = setPath(settings, spec.setting, encodeValue(fields[fieldKey], spec));
      touched = true;
    }
    if (touched) plan.replacements.set(first.node, withSettings(first.node, settings));
  }

  let next = rebuild(section, plan);

  // Section-level bindings (the hero's background picture).
  const sectionBinding = BINDINGS[section?.settings?._ia_field_section];
  if (sectionBinding && sectionBinding.on === 'section') {
    let settings = next.settings;
    let touched = false;
    for (const [fieldKey, spec] of Object.entries(sectionBinding.fields || {})) {
      if (fields[fieldKey] === undefined) continue;
      settings = setPath(settings, spec.setting, encodeValue(fields[fieldKey], spec));
      touched = true;
    }
    if (touched) next = { ...next, settings };
  }

  return next;
}

/**
 * One row of an Elementor Pro form's `form_fields`.
 *
 * A field whose LABEL has not changed keeps the type and the required flag it
 * already has. Two reasons, and both are round-trip defects that this rule
 * prevents:
 *
 *   1. The site may have changed them in Elementor on purpose, and a Portal
 *      save of an unrelated headline must not undo that.
 *   2. Re-deriving from the label means both derivations have to agree
 *      forever. They did not — `inferFormFieldType` is now the ONE of them,
 *      shared with the adapter, but preserving is still the safer default.
 */
function buildFormField(label, previous) {
  const sameLabel = previous && String(previous.field_label || '') === String(label);
  const fieldType = (sameLabel && previous.field_type)
    ? String(previous.field_type)
    : inferFormFieldType(label);
  const required = (sameLabel && previous.required !== undefined)
    ? previous.required
    : (fieldType === 'textarea' ? '' : 'true');
  return {
    ...(previous || {}),
    _id: previous?._id || freshId(),
    custom_id: (sameLabel && previous?.custom_id) ? previous.custom_id : formFieldId(label),
    field_type: fieldType,
    field_label: label,
    placeholder: previous?.placeholder || '',
    required,
    width: previous?.width || '100',
  };
}

/* ==========================================================================
 * 6. Validation — plain messages, because the client reads them.
 * ======================================================================== */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LINK_RE = /^(https?:\/\/|mailto:|tel:|\/|#)/i;

function isBlank(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/**
 * @param {object} spec     the field spec
 * @param {*}      value    what the client sent for it
 * @param {string} path     where to point the message
 * @param {Array}  errors   collected
 * @param {object} siblings the object this field lives in — the section's
 *                          fields, or one row of a list. `requiredWith` needs
 *                          it: "describe the picture" is only required when
 *                          there IS a picture.
 */
function validateOne(spec, value, path, errors, siblings) {
  if (isBlank(value)) {
    if (spec.required) errors.push({ field: path, message: `${spec.label} cannot be empty.` });
    else if (spec.requiredWith && !isBlank(siblings?.[spec.requiredWith])) {
      errors.push({
        field: path,
        message: spec.help ? `${spec.label}: ${spec.help}` : `${spec.label} cannot be empty here.`,
      });
    }
    return;
  }
  switch (spec.type) {
    case 'text':
    case 'textarea': {
      const s = String(value);
      if (spec.max && s.length > spec.max) {
        errors.push({ field: path, message: `${spec.label} is too long — keep it under ${spec.max} characters.` });
      }
      break;
    }
    case 'email':
      if (!EMAIL_RE.test(String(value).trim())) {
        errors.push({ field: path, message: `${spec.label} needs to be a real email address.` });
      }
      break;
    case 'link':
      if (!LINK_RE.test(String(value).trim())) {
        errors.push({ field: path, message: `${spec.label} should start with https://, tel:, mailto:, / or #.` });
      }
      break;
    case 'image':
      if (!/^(https?:\/\/|\/)/i.test(String(value).trim())) {
        errors.push({ field: path, message: `${spec.label} needs to be a web address for a picture.` });
      }
      break;
    case 'choice':
      if (Array.isArray(spec.options) && !spec.options.includes(String(value))) {
        errors.push({ field: path, message: `${spec.label} is not one of the choices offered.` });
      }
      break;
    case 'rating': {
      const n = Number(value);
      if (!Number.isFinite(n) || n < RATING_MIN || n > RATING_MAX) {
        errors.push({ field: path, message: `${spec.label} has to be between 1 and 5.` });
      }
      break;
    }
    case 'paragraphs':
      if (!Array.isArray(value)) {
        errors.push({ field: path, message: `${spec.label} should be a list of paragraphs.` });
      } else if (spec.max && value.length > spec.max) {
        errors.push({ field: path, message: `${spec.label} can have at most ${spec.max} entries.` });
      }
      break;
    default:
      break;
  }
}

/**
 * The free section's blocks, at any depth — ONE question, asked of the ONE
 * merged vocabulary (`blockKindAllowed`): can anything emit this?
 *
 * A kind nothing can emit is still refused BY NAME and in the same plain
 * sentence, because publishing it would put a widget on a client's live page
 * that this server cannot draw. What has changed is that the answer is no
 * longer a hand-written list of nine.
 */
function validateBlockList(list, path, depth, errors) {
  list.forEach((b, i) => {
    const raw = String(b?.kind ?? '');
    if (!blockKindAllowed(raw)) {
      errors.push({ field: `${path}[${i}].kind`, message: `We do not have a part called "${b?.kind}".` });
      return;
    }
    const kids = b?.[BLOCK_CHILDREN_KEY];
    if (kids === undefined) return;
    if (!Array.isArray(kids)) {
      errors.push({ field: `${path}[${i}]`, message: 'What is inside that box did not arrive.' });
      return;
    }
    if (kids.length > 0 && raw !== CONTAINER_BLOCK_KIND) {
      errors.push({ field: `${path}[${i}]`, message: `Only a box can hold other parts, and "${raw}" is not a box.` });
      return;
    }
    if (depth >= MAX_BLOCK_DEPTH && kids.length > 0) {
      errors.push({ field: `${path}[${i}]`, message: `Boxes can be nested up to ${MAX_BLOCK_DEPTH} deep.` });
      return;
    }
    validateBlockList(kids, `${path}[${i}].${BLOCK_CHILDREN_KEY}`, depth + 1, errors);
  });
}

/**
 * @param {string} kind
 * @param {object} fields
 * @param {{ partial?: boolean }} [opts]  `partial` skips the "cannot be
 *        empty" complaint for a field that is ABSENT — used when the object
 *        being checked is a fragment that will be merged onto defaults later
 *        (a brand-new section ARGUS proposed). A field that is PRESENT and
 *        blank is still refused, because that is somebody clearing it.
 * @returns {{ ok: boolean, errors: Array<{field:string, message:string}> }}
 */
export function validateFields(kind, fields, opts = {}) {
  const partial = !!opts.partial;
  const meta = sectionKindMeta(kind);
  const errors = [];
  if (!meta) return { ok: false, errors: [{ field: 'kind', message: `We do not know a section called "${kind}".` }] };
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { ok: false, errors: [{ field: '', message: 'The section content is missing.' }] };
  }

  /* The free section's two fields are structure, so they get structural checks
   * rather than the label-and-length ones above. A block whose kind NOTHING
   * CAN EMIT is refused BY NAME — publishing it would put a widget on a
   * client's live page that this server cannot draw. */
  if (fields.style !== undefined) {
    const st = fields.style;
    if (!st || typeof st !== 'object' || Array.isArray(st)) {
      errors.push({ field: 'style', message: 'That section\'s look did not arrive properly.' });
    } else {
      if (st.background && !/^#[0-9a-f]{3,8}$|^rgba?\(|^[a-z]+$/i.test(String(st.background))) {
        errors.push({ field: 'style.background', message: 'That is not a colour we can put on your website.' });
      }
      if (st.padding != null && !(Number.isFinite(Number(st.padding)) && Number(st.padding) >= 0 && Number(st.padding) <= 400)) {
        errors.push({ field: 'style.padding', message: 'Room around a section is between 0 and 400.' });
      }
    }
  }

  if (kind === 'content') {
    if (fields.layout !== undefined && ![1, 2, 3].includes(Number(fields.layout))) {
      errors.push({ field: 'layout', message: 'A section can have one, two or three columns.' });
    }
    if (fields.blocks !== undefined) {
      if (!Array.isArray(fields.blocks)) {
        errors.push({ field: 'blocks', message: 'The section content did not arrive.' });
      } else {
        validateBlockList(fields.blocks, 'blocks', 1, errors);
      }
    }
    return { ok: errors.length === 0, errors };
  }

  for (const spec of meta.fields) {
    const value = fields[spec.key];
    if (spec.type === 'list') {
      if (value === undefined) continue;
      if (!Array.isArray(value)) {
        errors.push({ field: spec.key, message: `${spec.label} should be a list.` });
        continue;
      }
      if (spec.min != null && value.length < spec.min) {
        errors.push({ field: spec.key, message: `${spec.label} needs at least ${spec.min}.` });
      }
      if (spec.max != null && value.length > spec.max) {
        errors.push({ field: spec.key, message: `${spec.label} can have at most ${spec.max}.` });
      }
      value.forEach((item, i) => {
        for (const itemSpec of spec.item || []) {
          validateOne(itemSpec, item?.[itemSpec.key], `${spec.key}[${i}].${itemSpec.key}`, errors, item);
        }
      });
      continue;
    }
    if (value === undefined) {
      if (partial) continue;
      if (spec.required) errors.push({ field: spec.key, message: `${spec.label} cannot be empty.` });
      else if (spec.requiredWith && !isBlank(fields[spec.requiredWith])) {
        errors.push({
          field: spec.key,
          message: spec.help ? `${spec.label}: ${spec.help}` : `${spec.label} cannot be empty here.`,
        });
      }
      continue;
    }
    validateOne(spec, value, spec.key, errors, fields);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * The STRICT validator, for field values that came from a model rather than
 * from a form (Phase 1B, "tell the AI what you want").
 * ---------------------------------------------------------------------------
 * `validateFields` above checks the values of the fields it recognises and
 * ignores anything else — which is right for the editor, where the Portal can
 * only ever send keys it rendered from this same schema. A model can send
 * anything: a field we retired, a field from another section kind, a field it
 * invented. Silently dropping those would mean the client approves a diff
 * that does not describe what gets written.
 *
 * So this one refuses an unknown key outright, at the top level and inside
 * every list row, and then defers to `validateFields` for the values.
 *
 * `fields` is ONLY what the model sent. The key check has to run over exactly
 * that — merging the section's current values in first would blame the model
 * for `email_to` and `image_id`, which the section legitimately carries and
 * the model was never shown. Pass the current values as `opts.existing` and
 * the VALUE check runs over the merge, which is what would actually be saved.
 *
 * @param {string} kind
 * @param {object} fields   what the model proposed, and nothing else
 * @param {{ existing?: object|null, partial?: boolean }} [opts]
 * @returns {{ ok: boolean, errors: Array<{field:string, message:string}> }}
 */
export function validateProposedFields(kind, fields, opts = {}) {
  const meta = sectionKindMeta(kind);
  if (!meta) return { ok: false, errors: [{ field: 'kind', message: `We do not know a section called "${kind}".` }] };
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { ok: false, errors: [{ field: '', message: 'The proposed content did not arrive in a shape we understand.' }] };
  }

  const errors = [];
  const known = new Map(meta.fields.map((spec) => [spec.key, spec]));

  for (const key of Object.keys(fields)) {
    const spec = known.get(key);
    if (!spec) {
      errors.push({ field: key, message: `“${key}” is not something this section has, so we did not use it.` });
      continue;
    }
    // Some fields are WIRES, not words: where a form's enquiries go, what
    // kind of enquiry it is, which attachment a picture points at. A model
    // may rewrite the copy around them and never these — a re-routed inbox or
    // a swapped picture is not something a client would read in a diff about
    // "making this friendlier".
    if (spec.notForAi) {
      errors.push({
        field: key,
        message: `“${spec.label}” is not something ARGUS AI can change, so we did not use it.`,
      });
      continue;
    }
    if (spec.type !== 'list') continue;
    const rows = fields[key];
    if (!Array.isArray(rows)) continue; // validateFields reports the shape error
    const itemSpecs = new Map((spec.item || []).map((s) => [s.key, s]));
    rows.forEach((row, i) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return;
      for (const itemKey of Object.keys(row)) {
        const itemSpec = itemSpecs.get(itemKey);
        if (!itemSpec) {
          errors.push({
            field: `${key}[${i}].${itemKey}`,
            message: `“${itemKey}” is not something a ${String(spec.itemLabel || 'row').toLowerCase()} has, so we did not use it.`,
          });
          continue;
        }
        if (itemSpec.notForAi) {
          errors.push({
            field: `${key}[${i}].${itemKey}`,
            message: `“${itemSpec.label}” is not something ARGUS AI can change, so we did not use it.`,
          });
        }
      }
    });
  }

  // An unknown key is a hard stop: do not go on to report value errors about
  // a payload we have already refused.
  if (errors.length > 0) return { ok: false, errors };

  const existing = (opts.existing && typeof opts.existing === 'object' && !Array.isArray(opts.existing))
    ? opts.existing
    : null;
  return validateFields(kind, existing ? { ...existing, ...fields } : fields, { partial: !!opts.partial });
}

/* ==========================================================================
 * 7. Reducing a whole page's `_elementor_data` to a section list.
 * ======================================================================== */

/**
 * @param {Array<object>} elementorData  the page's `_elementor_data`
 * @returns {Array<object>} one entry per top-level section, in page order
 */
export function reduceToSectionList(elementorData) {
  const list = Array.isArray(elementorData) ? elementorData : [];
  return list.map((node, index) => {
    const parsed = parseSectionHandle(node?.settings?._title);
    /* A SECTION WE DID NOT AUTHOR IS STILL EDITABLE (B-168, 2026-09-22).
     *
     * There used to be two dead ends here — "Custom section — built on the
     * site" and, for one of our own tree sections, `reason: 'tree'` — and both
     * came back `editable: false`, which is what put a greyed-out Edit button
     * and a paragraph of apology on Brandon's screen. There is now one answer
     * for both, and it is the same one a free section gets: the Elementor tree
     * read into blocks. A widget we have no row for is not lost and is not a
     * reason to lock the page — it comes back as an OPAQUE block that draws a
     * placeholder and is written back byte for byte.
     *
     * `kind: 'content'` is not a claim about what the section IS. It is what
     * the section now EDITS AS, and it is how the Portal draws it with no new
     * concept: "Words and pictures", holding theirs. The write path does not
     * read this kind — `buildNodes` asks the NODE whether it is one of ours,
     * so somebody else's page is never patched through an archetype's
     * bindings.
     */
    if (readsAsForeign(node)) {
      const title = String(node?.settings?._title || '').trim();
      return {
        index,
        handle: node?.settings?._title || null,
        kind: 'content',
        blueprintId: parsed?.blueprintId || null,
        blockId: parsed?.blockId || null,
        editable: true,
        reason: null,
        // An author who named the section in Elementor sees their own name for
        // it; everybody else sees what it is.
        label: title && !title.startsWith('ia:') ? title : 'Words and pictures',
        foreign: true,
        fields: readForeignFields(node),
        itemFields: null,
        roleReview: null,
        node,
      };
    }
    /* One of ours, with the markers its handle promises. `readsAsForeign`
       above has already answered for every other case, so there is no
       `editable: false` left on this path at all. */
    const meta = sectionKindMeta(parsed.kind);
    return {
      index,
      handle: parsed.handle,
      kind: parsed.kind,
      blueprintId: parsed.blueprintId,
      blockId: parsed.blockId,
      editable: true,
      reason: null,
      label: meta.label,
      fields: extractFields(node, parsed.kind),
      // Only a list-item-binding section answers these two. Everything else
      // gets null, and the edit sheet behaves exactly as it did before.
      itemFields: itemFieldsFor(node, parsed.kind),
      roleReview: roleReviewFor(node),
      node,
    };
  });
}

export const __test__ = {
  escapeHtml, unescapeHtml, htmlToText, getPath, setPath,
  collectMarked, groupMarked, cloneWithNewIds, buildFormField,
  METHOD_ICONS, readRoleInto, writeRoleSettings, STAT_NUMBER_RE,
};
