/**
 * The widget catalogue — one row per widget, and the PLAN it needs.
 * ---------------------------------------------------------------------------
 * D-156 / D-157 (DECISIONS_QUEUE, 2026-09-17). Brandon, walking "Choose your
 * plan": "Header, drag that into this box and it's now its own section inside
 * the box, then a text field under it with Pick One, then cards … custom cards
 * where they just type the card headers, add a price, and description inside
 * the cards, or product cards where they can directly load products/services
 * from their actual OLIVER Product Catalog." And D-157: "ARION Lite plan does
 * not get elementor pro so we need to lock down some of those widgets based on
 * their specific plan."
 *
 * So a widget is three facts, in ONE row, in ONE place:
 *
 *   kind        what the builder calls it — the vocabulary the Portal's
 *               registry already uses, so nothing has to translate.
 *   widgetType  what the WEBSITE calls it. The page engine's own widget name.
 *   tier        what a business must have for it:
 *                 'free'         every plan, always
 *                 'pro'          needs the page engine's paid add-on, which
 *                                ARION Lite does not carry (D-157)
 *                 'ia:<product>' one of OUR widgets, which needs the IA plugin
 *                                to have registered it AND the business to own
 *                                that product ('ia:oliver' = the catalogue)
 *
 * ── WHY THE TIER LIVES HERE AND NOWHERE ELSE ──────────────────────────────
 * "Is this widget paid?" is a fact about the OUTPUT widget, not about the
 * abstract thing the author dragged: a heading is free on every website on
 * earth and a price table is not. Putting the answer beside the widget name it
 * is an answer about is what stops it being copied into a route, a catalogue
 * row and a Portal constant — which is exactly how `arion_tier !== 'lite'`
 * came to live in three files before D-ARION-E (see siteCapability.js).
 *
 * ── THE GATE IS THE ONE WE ALREADY HAVE ───────────────────────────────────
 * Nothing here asks the database or the site. `allowPro` is decided ONCE, by
 * `siteCapability.allowProFor(site, capability)` — which asks the site first
 * and falls back to `arion_tier !== 'lite'` — and is handed in. This module
 * only says what a widget NEEDS; that module says what a business HAS.
 *
 * ── A LOCKED WIDGET IS NEVER SILENTLY DROPPED ─────────────────────────────
 * Two outcomes, never a third:
 *   · the row declares a `fallback` → we publish the fallback, which is real
 *     content the visitor can read (a card becomes a heading, a paragraph and
 *     a button in a box), and the caller is told what was swapped;
 *   · the row declares none → `resolve` refuses BY NAME and the caller
 *     refuses the save. Publishing a widget the website cannot draw is the
 *     blank page that `reference_catch_swallow_report_success` warns about:
 *     a green toast over an empty page.
 *
 * Pure: settings in, node out. No fetch, no clock.
 */

import { escapeHtml, mintId } from './elementorIds.js';

/** The three words a tier can be. `ia:` is a prefix, not a literal. */
export const FREE = 'free';
export const PRO = 'pro';

/** Does this tier name an IA widget, and of which product? */
export function iaProductOf(tier) {
  const t = String(tier || '');
  return t.startsWith('ia:') ? t.slice(3) : null;
}

/* ══════════════════════════════════════════════════════════════════════════
   Small builders, shared by the rows
   ══════════════════════════════════════════════════════════════════════════ */

function widgetNode(id, widgetType, settings) {
  return { id, elType: 'widget', widgetType, settings };
}

const text = (v) => String(v == null ? '' : v);
const html = (v) => `<p>${escapeHtml(text(v))}</p>`;

/** Elementor's link shape. An empty url is a button that goes nowhere, which
 *  is what the author gets until they say where it goes — never a made-up
 *  destination. */
const link = (url) => ({ url: text(url), is_external: '', nofollow: '' });

/* ══════════════════════════════════════════════════════════════════════════
   THE CATALOGUE
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * One row per widget kind.
 *
 * `settings(props, ctx)` → the widget's own settings object.
 * `fallback(props, ctx)` → OPTIONAL. A node (usually a container) to publish
 *                          instead when the plan does not carry the widget.
 */
export const ELEMENTOR_WIDGETS = {
  /* ── words ───────────────────────────────────────────────────────────── */
  heading: {
    widgetType: 'heading', tier: FREE, label: 'Heading',
    settings: (p) => ({
      title: text(p.text ?? p.title),
      header_size: text(p.level || 'h2'),
      align: text(p.align || 'left'),
    }),
  },
  paragraph: {
    widgetType: 'text-editor', tier: FREE, label: 'Text',
    settings: (p) => ({
      editor: text(p.html) || html(p.text),
      align: text(p.align || 'left'),
    }),
  },
  list: {
    // icon-list, not a text-editor full of <br>s: a list has to come back AS a
    // list when the page is read again (§12.2's `html_bullets` lesson).
    widgetType: 'icon-list', tier: FREE, label: 'List',
    settings: (p) => ({
      icon_list: (Array.isArray(p.items) ? p.items : []).map((item, i) => ({
        _id: `li${i}`,
        text: text(typeof item === 'string' ? item : item?.text),
        selected_icon: { value: 'fas fa-check', library: 'fa-solid' },
      })),
    }),
  },
  divider: { widgetType: 'divider', tier: FREE, label: 'Divider', settings: () => ({ style: 'solid' }) },
  spacer: {
    widgetType: 'spacer', tier: FREE, label: 'Space',
    settings: (p) => ({ space: { unit: 'px', size: Number(p.height) || 40, sizes: [] } }),
  },

  /* ── pictures and links ──────────────────────────────────────────────── */
  image: {
    widgetType: 'image', tier: FREE, label: 'Picture',
    settings: (p) => ({
      image: { url: text(p.url), id: text(p.mediaId) },
      image_size: 'large',
      align: text(p.align || 'center'),
      caption: text(p.caption),
    }),
  },
  gallery: {
    widgetType: 'image-gallery', tier: FREE, label: 'Gallery',
    settings: (p) => ({
      wp_gallery: (Array.isArray(p.images) ? p.images : []).map((im, i) => ({
        id: text(im?.mediaId || ''), url: text(typeof im === 'string' ? im : im?.url), _id: `g${i}`,
      })),
      gallery_columns: Number(p.columns) || 3,
    }),
  },
  video: {
    widgetType: 'video', tier: FREE, label: 'Video',
    settings: (p) => ({ youtube_url: text(p.url), video_type: 'youtube' }),
  },
  button: {
    widgetType: 'button', tier: FREE, label: 'Button',
    settings: (p) => ({
      text: text(p.text || 'Get in touch'),
      link: link(p.href),
      align: text(p.align || 'left'),
      size: text(p.size || 'md'),
    }),
  },
  html: {
    /**
     * THE ESCAPE HATCH CLIENTS ACTUALLY USE.
     *
     * BUILDER_WIDGET_CATALOG_2026-09-17 D.2: `html` is the most-used content
     * widget on the whole estate — 58 of the 64 IA page bodies are ONE html
     * widget and nothing else — and our builder had no write-side equivalent
     * at all. Free on every plan, because it is a free page-engine widget.
     *
     * WHO may add it is a question for the pane, not for the emitter: it puts
     * whatever is typed straight onto the page, so the Portal offers it behind
     * a "this is code" confirmation (stream A — see the handoff).
     */
    widgetType: 'html', tier: FREE, label: 'Code',
    settings: (p) => ({ html: text(p.html ?? p.code) }),
  },
  shortcode: {
    // A page-engine shortcode, which is how one of OUR features reaches a page
    // without a widget of its own — `[ia_book_now]` does it today.
    widgetType: 'shortcode', tier: FREE, label: 'One of your features',
    settings: (p) => ({ shortcode: text(p.shortcode) }),
  },
  map: {
    widgetType: 'google_maps', tier: FREE, label: 'Map',
    settings: (p) => ({ address: text(p.address), zoom: { unit: 'px', size: Number(p.zoom) || 12, sizes: [] } }),
  },

  /* ── the shapes a card makes ─────────────────────────────────────────── */
  image_box: {
    widgetType: 'image-box', tier: FREE, label: 'Picture with words',
    settings: (p) => ({
      image: { url: text(p.url), id: text(p.mediaId) },
      title_text: text(p.title),
      description_text: text(p.description),
      position: 'top',
      title_size: 'h3',
    }),
  },
  icon_box: {
    widgetType: 'icon-box', tier: FREE, label: 'Icon with words',
    settings: (p) => ({
      selected_icon: { value: `fas fa-${text(p.icon || 'circle')}`, library: 'fa-solid' },
      title_text: text(p.title),
      description_text: text(p.description),
      position: 'top',
      title_size: 'h3',
    }),
  },
  counter: {
    widgetType: 'counter', tier: FREE, label: 'Number that counts up',
    settings: (p) => ({
      starting_number: 0,
      ending_number: Number(p.value) || 0,
      prefix: text(p.prefix),
      suffix: text(p.suffix),
      title: text(p.label),
    }),
  },
  accordion: {
    widgetType: 'accordion', tier: FREE, label: 'Questions and answers',
    settings: (p) => ({
      tabs: (Array.isArray(p.items) ? p.items : []).map((q, i) => ({
        _id: `q${i}`, tab_title: text(q?.question ?? q?.title), tab_content: html(q?.answer ?? q?.body),
      })),
    }),
  },

  /* ── the paid ones ───────────────────────────────────────────────────── */
  form: {
    /**
     * A FORM THAT CANNOT SEND IS NEVER DRAWN.
     *
     * A picture of a form is worse than no form: the visitor types their name
     * in and nobody ever hears. So the paid widget is refused on a plan that
     * does not carry it, with the sentence the client has always read.
     *
     * BUILDER_WIDGET_CATALOG G.3 asks for better — a Lite site should still
     * get a contact form, through OUR form on the page engine's free
     * `shortcode` widget. The shortcode does not exist yet (the plugin
     * registers `ia_book_now` and `ia_pdf` and nothing else), so the fallback
     * is gated on the site TELLING US it has one — the presence of a marker,
     * never the absence of one (`reference_absence_based_guards_fail_open`).
     * The day the plugin adds `[ia_form]`, `ctx.iaShortcodes` carries it and
     * every Lite site gets a working form with no change here.
     */
    widgetType: 'form', tier: PRO, label: 'Form',
    settings: (p, ctx) => ({
      form_name: text(p.title || 'Contact'),
      email_to: text(p.emailTo || ctx?.emailTo),
      form_fields: (Array.isArray(p.fields) ? p.fields : []).map((f, i) => ({
        _id: text(f?.id || `f${i}`), field_label: text(f?.label), field_type: text(f?.type || 'text'),
        required: f?.required ? 'true' : '', width: '100',
      })),
    }),
    fallback: (p, ctx) => {
      const has = Array.isArray(ctx?.iaShortcodes) && ctx.iaShortcodes.includes('ia_form');
      if (!has) return null;
      return widgetNode(ctx?.nodeId || mintId(ctx?.seed || 'f', 'form'), 'shortcode', {
        shortcode: `[ia_form purpose="${text(p.purpose || 'contact')}" to="${text(p.emailTo || ctx?.emailTo)}"]`,
      });
    },
  },
  card: {
    /**
     * Brandon's "custom cards where they just type the card headers, add a
     * price, and description inside the cards".
     *
     * The page engine's price table is the paid widget that draws exactly
     * that, so a business that has it gets it. A Lite business gets THE SAME
     * CARD, drawn out of three free widgets in a box — a heading, the price
     * and description as text, and the button. Same words on the page, same
     * box round them, and the author is told once which one they are getting.
     */
    widgetType: 'price-table', tier: PRO, label: 'Card',
    settings: (p) => ({
      heading: text(p.title),
      sub_heading: text(p.per),
      price: text(p.price),
      original_price: text(p.was),
      period: text(p.per),
      features_list: (Array.isArray(p.bullets) ? p.bullets : []).map((b, i) => ({
        _id: `b${i}`, item_text: text(typeof b === 'string' ? b : b?.text),
      })),
      button_text: text(p.ctaText || 'Choose this'),
      link: link(p.ctaHref),
      footer_additional_info: text(p.note),
      show_ribbon: p.recommended ? 'yes' : '',
      ribbon_title: text(p.tag || (p.recommended ? 'Recommended' : '')),
    }),
    fallback: (p, ctx) => cardFallback(p, ctx),
  },

  /* ── ours ────────────────────────────────────────────────────────────── */
  catalog_card: {
    /**
     * "or product cards where they can directly load products/services from
     * their actual OLIVER Product Catalog" — the price and what is included
     * come off the catalogue at render time, so the page cannot go stale the
     * day a price changes. The overrides the author typed travel with it.
     *
     * The widget is OURS: the IA plugin registers it (ia_register_elementor_
     * widgets). A site whose plugin does not register it yet gets the same
     * fallback a Lite card gets, with the catalogue values baked in — the
     * visitor reads real prices either way.
     */
    widgetType: 'ia_product_cards', tier: 'ia:oliver', label: 'Product card',
    settings: (p) => ({
      ia_source: 'catalogue',
      ia_item_ids: (Array.isArray(p.itemIds) ? p.itemIds : [p.itemId]).filter(Boolean).map(text),
      ia_tier: text(p.tier),
      ia_show_price: p.showPrice === false ? '' : 'yes',
      ia_show_inclusions: p.showInclusions === false ? '' : 'yes',
      ia_title_override: text(p.title),
      ia_description_override: text(p.description),
      ia_cta_text: text(p.ctaText || 'Choose this'),
      ia_cta_link: link(p.ctaHref),
      ia_tag: text(p.tag),
    }),
    fallback: (p, ctx) => cardFallback(p, ctx),
  },
};

/**
 * The card, drawn out of free widgets, in its own box.
 *
 * A container and not three loose widgets: the box IS the card — it is what
 * gives the card its width in a row, its padding and its edge — and dropping
 * the box would leave three cards' worth of text in one grey column.
 */
function cardFallback(p, ctx) {
  const seed = ctx?.seed || 'card';
  const id = (salt) => mintId(seed, `${ctx?.nodeId || 'c'}-${salt}`);
  const price = [text(p.price), text(p.per) && `/ ${text(p.per)}`].filter(Boolean).join(' ');
  const lines = [];
  if (p.title) lines.push(widgetNode(id('t'), 'heading', { title: text(p.title), header_size: 'h3', align: 'left' }));
  if (price) lines.push(widgetNode(id('p'), 'heading', { title: price, header_size: 'h2', align: 'left' }));
  if (p.description) lines.push(widgetNode(id('d'), 'text-editor', { editor: html(p.description), align: 'left' }));
  const bullets = (Array.isArray(p.bullets) ? p.bullets : []).filter(Boolean);
  if (bullets.length) {
    // The same list codec the List widget uses, so a card's bullets and a
    // list's bullets are one shape on the page and not two.
    lines.push(widgetNode(id('l'), 'icon-list', ELEMENTOR_WIDGETS.list.settings({ items: bullets })));
  }
  if (p.note) lines.push(widgetNode(id('n'), 'text-editor', { editor: html(p.note), align: 'left' }));
  lines.push(widgetNode(id('b'), 'button', {
    text: text(p.ctaText || 'Choose this'), link: link(p.ctaHref), align: 'left', size: 'md',
  }));
  return {
    id: id('box'),
    elType: 'container',
    settings: {
      container_type: 'flex',
      content_width: 'full',
      flex_direction: 'column',
      flex_gap: { unit: 'px', size: 12, sizes: [] },
      padding: { unit: 'px', top: '24', right: '24', bottom: '24', left: '24', isLinked: true },
      border_border: 'solid',
      border_width: { unit: 'px', top: '1', right: '1', bottom: '1', left: '1', isLinked: true },
      border_radius: { unit: 'px', top: '10', right: '10', bottom: '10', left: '10', isLinked: true },
    },
    elements: lines,
    isInner: true,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   Reading the catalogue
   ══════════════════════════════════════════════════════════════════════════ */

export function listWidgetKinds() {
  return Object.keys(ELEMENTOR_WIDGETS).sort();
}

/** What plan a widget needs. Unknown kinds answer null, never 'free'. */
export function widgetTier(kind) {
  return ELEMENTOR_WIDGETS[kind]?.tier ?? null;
}

/** Every kind a plan without the paid add-on cannot have as its real widget. */
export function proWidgetKinds() {
  return listWidgetKinds().filter((k) => ELEMENTOR_WIDGETS[k].tier === PRO);
}

/** Every kind that is one of ours, with the product it belongs to. */
export function iaWidgetKinds() {
  return listWidgetKinds()
    .filter((k) => iaProductOf(ELEMENTOR_WIDGETS[k].tier))
    .map((k) => ({ kind: k, product: iaProductOf(ELEMENTOR_WIDGETS[k].tier), widgetType: ELEMENTOR_WIDGETS[k].widgetType }));
}

/**
 * THE PLAIN-WORDS SENTENCE, in one place.
 *
 * No vendor name, because the client never chose the page engine and naming it
 * tells them nothing they can act on (`feedback_no_third_party_product_surface`,
 * and the same rule siteCapability.js follows). It says what they would get and
 * what they have instead — never "upgrade" as a bare instruction.
 */
export const PRO_LOCK_SENTENCE = 'Available on ARION Standard and above. On your plan this is added as a box with a heading, your words and a button.';
export const PRO_LOCK_SENTENCE_NO_FALLBACK = 'Available on ARION Standard and above.';

/** The sentence for one kind, or null when the plan carries it. */
export function lockSentence(kind, { allowPro = true, iaWidgets = null } = {}) {
  const row = ELEMENTOR_WIDGETS[kind];
  if (!row) return null;
  if (row.tier === PRO && !allowPro) {
    return row.fallback ? PRO_LOCK_SENTENCE : PRO_LOCK_SENTENCE_NO_FALLBACK;
  }
  const product = iaProductOf(row.tier);
  if (product && Array.isArray(iaWidgets) && !iaWidgets.includes(row.widgetType)) {
    return 'Your website cannot show this one yet. We will switch it on for you — everything else works meanwhile.';
  }
  return null;
}

/**
 * Turn one of our widgets into one page-engine node.
 *
 * @param {string} kind
 * @param {object} props
 * @param {{ allowPro?: boolean, iaWidgets?: string[]|null, seed?: string, nodeId?: string, emailTo?: string }} ctx
 * @returns {{ node: object, swapped: null | { kind: string, reason: string, sentence: string } }}
 * @throws  {UnsupportedWidgetError} when the kind is unknown, or locked with no fallback.
 */
export function resolveWidget(kind, props = {}, ctx = {}) {
  const row = ELEMENTOR_WIDGETS[kind];
  if (!row) throw new UnsupportedWidgetError(`We do not know a widget called "${kind}", so nothing was published.`, kind);

  const id = ctx.nodeId || mintId(ctx.seed || 'w', kind);
  const sentence = lockSentence(kind, ctx);
  if (!sentence) {
    return { node: widgetNode(id, row.widgetType, { _ia_widget: kind, ...row.settings(props, ctx) }), swapped: null };
  }
  if (!row.fallback) {
    throw new UnsupportedWidgetError(sentence, kind);
  }
  const node = row.fallback(props, { ...ctx, nodeId: id });
  // A fallback may answer null — it needs something the SITE has to have, and
  // this site said it has not. Refusing is then the only honest answer.
  if (!node) throw new UnsupportedWidgetError(sentence, kind);
  return {
    node: { ...node, settings: { ...node.settings, _ia_widget: kind, _ia_swapped: row.tier } },
    swapped: { kind, reason: row.tier, sentence },
  };
}

export class UnsupportedWidgetError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'UnsupportedWidgetError';
    this.code = 'WIDGET_NOT_ON_PLAN';
    this.kind = kind;
  }
}

export default {
  ELEMENTOR_WIDGETS, listWidgetKinds, widgetTier, proWidgetKinds, iaWidgetKinds,
  lockSentence, resolveWidget, UnsupportedWidgetError, PRO_LOCK_SENTENCE,
};
