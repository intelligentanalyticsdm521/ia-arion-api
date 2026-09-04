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

/**
 * What a form is FOR. The plugin's interceptor types every submission from
 * `form_css_class` (class-ia-form-interceptor.php:127) — this is the wire the
 * editor must not cut, so the purpose is a first-class editable field.
 */
export const FORM_PURPOSES = Object.freeze([
  { value: 'lead',       label: 'Contact' },
  { value: 'quote',      label: 'Quote request' },
  { value: 'booking',    label: 'Booking request' },
  { value: 'newsletter', label: 'Newsletter' },
]);
const PURPOSE_FROM_CLASS = Object.freeze({
  'ia-lead': 'lead', 'ia-contact': 'lead', 'ia-quote': 'quote',
  'ia-booking': 'booking', 'ia-newsletter': 'newsletter',
});
const CLASS_FROM_PURPOSE = Object.freeze({
  lead: 'ia-lead', quote: 'ia-quote', booking: 'ia-booking', newsletter: 'ia-newsletter',
});

export function purposeFromCssClass(cls) {
  return PURPOSE_FROM_CLASS[String(cls || '').trim().toLowerCase()] || 'lead';
}
export function cssClassFromPurpose(purpose) {
  return CLASS_FROM_PURPOSE[String(purpose || '').trim().toLowerCase()] || 'ia-lead';
}

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

  'contact.headline':    { on: 'widget', widget: 'heading',     fields: { headline: { setting: 'title' } } },
  'contact.subheadline': { on: 'widget', widget: 'text-editor', fields: { subheadline: { setting: 'editor', codec: 'html_text' } } },
  'contact.methods':     {
    on: 'widget', widget: 'icon-list', repeat: 'setting', list: 'contact_methods',
    setting: 'icon_list', composedItem: 'contact_method',
  },
  'contact.form':        { on: 'widget', widget: 'form', composed: 'form' },
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

const DESCRIBE_HELP =
  'Say what is in the picture, so somebody using a screen reader — and Google — knows what it shows.';

export const SECTION_KINDS = Object.freeze({
  hero: {
    kind: 'hero',
    label: 'Hero banner',
    blurb: 'The big banner at the top of a page — one headline, one line of support, one button.',
    fields: [
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
  contact: {
    kind: 'contact',
    label: 'Contact and form',
    blurb: 'How to reach you, next to a form that sends straight to your inbox.',
    requiresElementorPro: true,
    proReason: 'The form on this section uses the Elementor Pro form widget, which ARION Lite sites do not have installed.',
    fields: [
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
export function sectionCatalog({ allowPro = true } = {}) {
  return listSectionKinds().map((kind) => {
    const meta = SECTION_KINDS[kind];
    const needsPro = !!meta.requiresElementorPro;
    return {
      kind,
      label: meta.label,
      blurb: meta.blurb,
      available: allowPro || !needsPro,
      unavailableReason: (!allowPro && needsPro) ? meta.proReason : null,
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
  const groups = groupMarked(section);
  const out = {};

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
      out.form_purpose = purposeFromCssClass(s.form_css_class);
      out.email_to     = String(s.email_to || '');
      out.submit_text  = String(s.button_text || '');
      out.form_fields  = decodeFormFields(s);
      continue;
    }
    if (binding.repeat === 'widget') {
      out[binding.list] = entries.map((e) => {
        if (binding.composed === 'testimonial_card') {
          return decodeTestimonialCard(getPath(e.node.settings, binding.setting));
        }
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
export function applyFields(section, kind, fields) {
  const meta = sectionKindMeta(kind);
  if (!meta || !fields || typeof fields !== 'object') return section;

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
      if (fields.form_purpose !== undefined) next.form_css_class = cssClassFromPurpose(fields.form_purpose);
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
        const settings = binding.composed === 'testimonial_card'
          ? setPath(entry.node.settings, binding.setting, encodeTestimonialCard(item))
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
          target.settings = binding.composed === 'testimonial_card'
            ? setPath(target.settings, binding.setting, encodeTestimonialCard(item))
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
    if (!parsed || !sectionKindMeta(parsed.kind)) {
      return {
        index,
        handle: node?.settings?._title || null,
        kind: null,
        blueprintId: parsed?.blueprintId || null,
        blockId: parsed?.blockId || null,
        editable: false,
        reason: 'custom',
        label: 'Custom section — built on the site',
        fields: null,
        node,
      };
    }
    const meta = sectionKindMeta(parsed.kind);
    const marked = collectMarked(node).length > 0
      || node?.settings?._ia_field_section != null;
    return {
      index,
      handle: parsed.handle,
      kind: parsed.kind,
      blueprintId: parsed.blueprintId,
      blockId: parsed.blockId,
      editable: marked,
      reason: marked ? null : 'no_field_markers',
      label: meta.label,
      fields: marked ? extractFields(node, parsed.kind) : null,
      node,
    };
  });
}

export const __test__ = {
  escapeHtml, unescapeHtml, htmlToText, getPath, setPath,
  collectMarked, groupMarked, cloneWithNewIds, buildFormField,
  METHOD_ICONS,
};
