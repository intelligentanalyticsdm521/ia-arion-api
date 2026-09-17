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
import {
  formPurposeSettings, normalizeFormPurpose, FORM_PURPOSE_KEY, CSS_CLASSES_KEY,
} from './formPurpose.js';

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
      // WHAT THIS FORM IS FOR, in the same three keys the archetype path
      // writes (`formPurpose.js`). Without them a form built as a widget and a
      // form built as a section typed their submissions differently, which is
      // audit point 11: the client's enquiries are filed by whichever door
      // they happened to build the form through.
      ...formPurposeSettings(p[FORM_PURPOSE_KEY] ?? p.purpose, p[CSS_CLASSES_KEY]),
      form_fields: (Array.isArray(p.fields) ? p.fields : []).map((f, i) => ({
        _id: text(f?.id || `f${i}`), field_label: text(f?.label), field_type: text(f?.type || 'text'),
        required: f?.required ? 'true' : '', width: '100',
      })),
    }),
    /**
     * WILL THE FALLBACK ACTUALLY FIRE? One predicate, two readers.
     *
     * The sentence a client reads and the node we publish must agree. Before
     * this, the pane promised "this is added as a box with a heading, your
     * words and a button" for every paid widget that HAD a fallback function
     * — including the form, whose fallback answers null on a site that has
     * not got our shortcode. So a Lite client was promised a form and the
     * publish refused one (`reference_catch_swallow_report_success`, in
     * sentence form).
     */
    fallbackFires: (ctx) => Array.isArray(ctx?.iaShortcodes) && ctx.iaShortcodes.includes('ia_form'),
    /** ...and when it does fire, a form is still a FORM, not a box of words. */
    swapSentence: 'Available on ARION Standard and above. On your plan this is added as our own form, '
      + 'which still sends every enquiry to your inbox.',
    fallback: (p, ctx) => {
      if (!ELEMENTOR_WIDGETS.form.fallbackFires(ctx)) return null;
      const purpose = normalizeFormPurpose(p[FORM_PURPOSE_KEY] ?? p.purpose);
      return widgetNode(ctx?.nodeId || mintId(ctx?.seed || 'f', 'form'), 'shortcode', {
        shortcode: `[ia_form purpose="${purpose}" to="${text(p.emailTo || ctx?.emailTo)}"]`,
        // The shortcode carries the purpose in its own attribute AND the
        // widget carries the three keys, so a Lite form is typed by the same
        // word as a Standard one — the plugin reads the attribute, we read the
        // keys, and neither has to guess what the other did.
        ...formPurposeSettings(purpose, p[CSS_CLASSES_KEY]),
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
    settings: (p) => {
      const c = cardProps(p);
      return {
        heading: c.heading,
        ...(c.heading_tag ? { heading_tag: c.heading_tag } : {}),
        // The paid card has no paragraph of its own: its "Description" control
        // IS `sub_heading` (catalogue C.1). So our `description` goes there
        // rather than nowhere, which is what it did before.
        sub_heading: c.description,
        price: c.price,
        ...c.currency,
        ...(c.sale ? { sale: 'yes', original_price: c.original_price } : {}),
        period: c.period,
        features_list: c.features_list,
        button_text: c.button_text,
        link: link(c.link),
        footer_additional_info: c.footer_additional_info,
        ...(c.show_ribbon
          ? {
            show_ribbon: 'yes',
            ribbon_title: c.ribbon_title,
            ...(c.ribbon_color ? { ribbon_bg_color: c.ribbon_color } : {}),
            ...(c.ribbon_text_color ? { ribbon_text_color: c.ribbon_text_color } : {}),
          }
          : {}),
      };
    },
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
     *
     * ITS PROPS ARE THE SHARED BINDING SECTION (catalogue F.2, and the
     * vocabulary the three repos agreed on): `_ia_source`, `_ia_selection`,
     * `refresh`, `on_empty`, `overrides`, `_ia_snapshot`. One section, learnt
     * once, on every catalogue-bound widget — which is the whole reason F.2
     * exists.
     */
    widgetType: 'ia_product_cards', tier: 'ia:oliver', label: 'Product card',
    settings: (p) => {
      const b = bindingProps(p);
      const o = b.overrides;
      return {
        ia_source: b.source,
        ia_item_ids: b.ids,
        ...(b.priceId ? { ia_price_id: b.priceId } : {}),
        ia_tier: b.tier,
        ia_refresh: b.refresh,
        ia_on_empty: b.on_empty,
        ia_show_price: p.show_price === false ? '' : 'yes',
        ia_show_inclusions: p.show_inclusions === false ? '' : 'yes',
        ia_title_override: text(o.heading),
        ia_description_override: text(o.description),
        ia_cta_text: text(o.button_text || 'Choose this'),
        ia_cta_link: link(typeof o.link === 'string' ? o.link : o.link?.url),
        ia_tag: text(o.ribbon_title),
        // The values frozen when the document was sent or published. The
        // widget draws LIVE data; this is what it falls back to, and it is the
        // same object `on_empty: "last_snapshot"` reads.
        ...(b.snapshot ? { ia_snapshot: JSON.stringify(b.snapshot) } : {}),
      };
    },
    fallback: (p, ctx) => cardFallback(boundCardValues(p), ctx, { requireWords: true }),
  },
};

/* ══════════════════════════════════════════════════════════════════════════
   THE BINDING SECTION — one reader, for every catalogue-bound widget
   ══════════════════════════════════════════════════════════════════════════ */

/** How often a bound widget re-reads its source. A closed list (F.2). */
export const REFRESH_MODES = ['live', 'snapshot_publish', 'snapshot_send'];
/** What a bound widget does when its source answers nothing (F.2). */
export const ON_EMPTY_MODES = ['hide', 'placeholder', 'last_snapshot'];

/**
 * WHAT A BOUND WIDGET IS BOUND TO — the marker, not a table name.
 *
 * D156_CONFORMANCE_HANDOFF_2026-09-17 §3 (agent O): `_ia_source` is a marker
 * and deliberately NOT a schema object, because
 * `reference_data_ownership_architecture` moves schema objects and a stored
 * document naming one is a stored document that goes stale. Same three
 * strings in all three repos.
 */
export const IA_SOURCES = Object.freeze({
  catalogue: 'oliver:catalogue',
  location: 'lumen:locations',
  document: 'document',
});

/**
 * The five controls every IA data widget shares, read once.
 *
 * `_ia_selection` is snake case, matching the columns the APIs already speak
 * (handoff §3): `{ offering_id, price_id }` for the catalogue,
 * `{ location_id }` for a site, absent for the document. A list of offering
 * ids is also accepted, because one product-card widget on a website can be
 * bound to several rows.
 *
 * Nothing is invented: a widget bound to nothing answers an empty list, and
 * the widget on the page then does what `on_empty` says.
 */
export function bindingProps(p = {}) {
  const sel = p._ia_selection;
  const obj = sel && typeof sel === 'object' && !Array.isArray(sel) ? sel : null;
  const ids = Array.isArray(sel)
    ? sel.filter(Boolean).map((v) => text(v && typeof v === 'object' ? v.offering_id : v))
    : (obj
      ? [text(obj.offering_id)].filter(Boolean)
      : (sel ? [text(sel)] : []));
  const refresh = REFRESH_MODES.includes(text(p.refresh)) ? text(p.refresh) : 'live';
  const onEmpty = ON_EMPTY_MODES.includes(text(p.on_empty)) ? text(p.on_empty) : 'hide';
  return {
    source: text(p._ia_source) || IA_SOURCES.catalogue,
    ids: ids.filter(Boolean),
    priceId: obj ? text(obj.price_id) : '',
    locationId: obj ? text(obj.location_id) : '',
    tier: obj ? text(obj.tier) : '',
    refresh,
    on_empty: onEmpty,
    overrides: (p.overrides && typeof p.overrides === 'object') ? p.overrides : {},
    snapshot: (p._ia_snapshot && typeof p._ia_snapshot === 'object') ? p._ia_snapshot : null,
  };
}

/**
 * What a bound card should SAY when the live widget is not on the site.
 *
 * Override beats snapshot beats nothing — the same order the builder's own
 * resolver uses, so the words on a fallback page are the words the author saw.
 */
export function boundCardValues(p = {}) {
  const b = bindingProps(p);
  return { ...(b.snapshot || {}), ...b.overrides };
}

/* ══════════════════════════════════════════════════════════════════════════
   A CARD'S PROPS — one reader, in the paid widget's own spelling
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * The card stores what the page engine's price table calls things.
 *
 * D-156 conformance (audit point 3, and the shared vocabulary the three repos
 * agreed on): a card's props ARE `price-table`'s control keys wherever price
 * table has a name for the thing — `heading`, `price`, `currency_symbol`,
 * `period`, `original_price` + `sale`, `features_list[{item_text}]`,
 * `footer_additional_info`, `button_text`, `link`, `show_ribbon` +
 * `ribbon_title` — so the same word is used by the author's inspector, the
 * stored document, this emitter and the live site. `description` stays ours:
 * the price table has no paragraph, and its "Description" control is
 * `sub_heading`, where the description goes.
 *
 * The OLD spelling (`title` / `per` / `was` / `bullets` / `note` /
 * `recommended`) is converted by the builder's own upgrade-on-open, in the
 * Portal, which is the one place that converts a stored document. So a card
 * that arrives here still wearing it has come through a door that did not run
 * the upgrade — and a blank card on a published page is the silent failure
 * this refusal exists to stop.
 */
const CARD_OLD_KEYS = ['title', 'per', 'was', 'bullets', 'note', 'recommended', 'ctaText', 'ctaHref', 'tag'];
const CARD_NEW_KEYS = [
  'heading', 'price', 'period', 'original_price', 'features_list',
  'footer_additional_info', 'button_text', 'link', 'show_ribbon', 'ribbon_title', 'description',
];
/** The currency symbols the paid widget offers by name (catalogue C.1). */
const CURRENCY_NAMES = [
  'dollar', 'euro', 'baht', 'franc', 'guilder', 'krona', 'lira', 'peseta', 'peso',
  'pound', 'real', 'ruble', 'rupee', 'indian_rupee', 'shekel', 'yen', 'won',
];
const HEADING_TAGS = ['h2', 'h3', 'h4', 'h5', 'h6'];
/** The ribbon's words, one per preset. `custom` uses the author's own title. */
const RIBBON_PRESETS = {
  recommended: 'Recommended',
  best_price: 'Best price',
  most_popular: 'Most popular',
  best_value: 'Best value',
  new: 'New',
  limited: 'Limited',
};

export function cardProps(p = {}) {
  const has = (keys) => keys.some((k) => p[k] !== undefined && p[k] !== null && p[k] !== '');
  if (!has(CARD_NEW_KEYS) && has(CARD_OLD_KEYS)) {
    throw new UnsupportedWidgetError(
      'This card was saved in an older shape. Open the page in the builder once and save it, '
      + 'then it can be published.', 'card',
    );
  }
  const sym = text(p.currency_symbol).trim();
  const currency = !sym
    ? {}
    : (CURRENCY_NAMES.includes(sym.toLowerCase())
      ? { currency_symbol: sym.toLowerCase() }
      : { currency_symbol: 'custom', currency_symbol_custom: sym });

  const preset = text(p.ribbon_preset).trim().toLowerCase();
  const showRibbon = p.show_ribbon === true || p.show_ribbon === 'yes'
    || (!!preset && preset !== 'custom') || !!text(p.ribbon_title);

  return {
    heading: text(p.heading),
    heading_tag: HEADING_TAGS.includes(text(p.heading_tag)) ? text(p.heading_tag) : '',
    description: text(p.description),
    price: text(p.price),
    currency,
    period: text(p.period),
    /**
     * `sale` is the switcher the price table pairs with the old price.
     *
     * An explicit `false` WINS (handoff §6): an author who cleared the sale
     * must not get a struck-through price back because the old number is still
     * in the props. Only a card that says nothing about it falls back to "there
     * is an original price, so it is on sale".
     */
    sale: p.sale === undefined || p.sale === null
      ? !!text(p.original_price)
      : (p.sale === true || p.sale === 'yes'),
    original_price: text(p.original_price),
    features_list: (Array.isArray(p.features_list) ? p.features_list : []).map((b, i) => ({
      _id: `b${i}`, item_text: text(typeof b === 'string' ? b : b?.item_text),
    })),
    footer_additional_info: text(p.footer_additional_info),
    button_text: text(p.button_text || 'Choose this'),
    link: typeof p.link === 'string' ? p.link : text(p.link?.url),
    show_ribbon: showRibbon,
    ribbon_title: text(p.ribbon_title) || RIBBON_PRESETS[preset] || '',
    ribbon_color: text(p.ribbon_color),
    ribbon_text_color: text(p.ribbon_text_color),
  };
}

/**
 * The card, drawn out of free widgets, in its own box.
 *
 * A container and not three loose widgets: the box IS the card — it is what
 * gives the card its width in a row, its padding and its edge — and dropping
 * the box would leave three cards' worth of text in one grey column.
 */
function cardFallback(p, ctx, { requireWords = false } = {}) {
  const seed = ctx?.seed || 'card';
  const id = (salt) => mintId(seed, `${ctx?.nodeId || 'c'}-${salt}`);
  // ONE reader of a card's props, for the paid widget and for this — so the
  // words a Lite visitor reads and the words a Standard visitor reads come out
  // of the same place and cannot drift apart.
  const c = cardProps(p);
  // A BOUND card with nothing frozen and nothing typed has no words to draw,
  // and an empty bordered box on a live page is the "green toast over a blank
  // page" this module refuses everywhere else. Answering null makes
  // `resolveWidget` refuse BY NAME with the sentence the client reads.
  if (requireWords && !c.heading && !c.price && !c.description && !c.features_list.length) return null;
  const symbol = c.currency.currency_symbol === 'custom'
    ? c.currency.currency_symbol_custom
    : (c.currency.currency_symbol || '');
  const price = [
    [symbol, c.price].filter(Boolean).join(''),
    c.period && `/ ${c.period}`,
  ].filter(Boolean).join(' ');
  const lines = [];
  if (c.heading) {
    lines.push(widgetNode(id('t'), 'heading', {
      title: c.heading, header_size: c.heading_tag || 'h3', align: 'left',
    }));
  }
  if (c.show_ribbon && c.ribbon_title) {
    // The paid widget draws the ribbon; free widgets have no ribbon, so the
    // words go on the page as words. A card that says "Recommended" in the
    // builder must say it to the visitor too.
    lines.push(widgetNode(id('r'), 'text-editor', { editor: html(c.ribbon_title), align: 'left' }));
  }
  if (price) lines.push(widgetNode(id('p'), 'heading', { title: price, header_size: 'h2', align: 'left' }));
  if (c.sale && c.original_price) {
    lines.push(widgetNode(id('o'), 'text-editor', {
      editor: html(`Was ${[symbol, c.original_price].filter(Boolean).join('')}`), align: 'left',
    }));
  }
  if (c.description) lines.push(widgetNode(id('d'), 'text-editor', { editor: html(c.description), align: 'left' }));
  const bullets = c.features_list.map((b) => b.item_text).filter(Boolean);
  if (bullets.length) {
    // The same list codec the List widget uses, so a card's bullets and a
    // list's bullets are one shape on the page and not two.
    lines.push(widgetNode(id('l'), 'icon-list', ELEMENTOR_WIDGETS.list.settings({ items: bullets })));
  }
  if (c.footer_additional_info) {
    lines.push(widgetNode(id('n'), 'text-editor', { editor: html(c.footer_additional_info), align: 'left' }));
  }
  lines.push(widgetNode(id('b'), 'button', {
    text: c.button_text, link: link(c.link), align: 'left', size: 'md',
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

/**
 * THE THIRD STATE — "needs a product this business does not have".
 *
 * `reference_nav_visibility_semantics`: the reasons a thing is not offered must
 * never collapse into one word. A widget is in exactly one of three states and
 * each has its OWN sentence:
 *
 *   offered                                  no sentence
 *   not on the website plan (`pro`, Lite)    PRO_LOCK_SENTENCE
 *   needs a product (`ia:<product>`)         the two below
 *
 * The ownership state has two sentences because it has two causes, and telling
 * a client "we will switch it on" when they have not bought the product is a
 * promise nobody can keep:
 *   · the business does not OWN the product  → they choose whether to buy it;
 *   · they own it and the website has not had the widget switched on yet → ours
 *     to fix, and it says so.
 * Both answer `reason: 'ownership'`, so a pane that renders the sentence draws
 * the same third state either way.
 */
export const NEEDS_SWITCHING_ON_SENTENCE =
  'Your website cannot show this one yet. We will switch it on for you — everything else works meanwhile.';

/** The product's name as a client reads it. Ours, so it IS named. */
export function productName(product) {
  return String(product || '').trim().toUpperCase();
}

export function notOwnedSentence(product) {
  return `Needs ${productName(product)}, which this business does not have.`;
}

/**
 * The sentence for one kind, or null when the plan carries it.
 *
 * `ownedProducts` is the list of products the business owns, or NULL for "we
 * could not ask". Null never locks: silence is not a refusal (the rule
 * `siteCapability.js` and `sitePlan.ts` both follow), and locking a client out
 * of a widget they pay for because a query failed is the D-ARION-E defect with
 * a new address.
 */
export function lockSentence(kind, ctx = {}) {
  const { allowPro = true, iaWidgets = null, ownedProducts = null } = ctx;
  const row = ELEMENTOR_WIDGETS[kind];
  if (!row) return null;
  if (row.tier === PRO && !allowPro) {
    return swapWillFire(row, ctx)
      ? (row.swapSentence || PRO_LOCK_SENTENCE)
      : PRO_LOCK_SENTENCE_NO_FALLBACK;
  }
  const product = iaProductOf(row.tier);
  if (product && Array.isArray(ownedProducts)
      && !ownedProducts.map((p) => String(p).toLowerCase()).includes(product.toLowerCase())) {
    return notOwnedSentence(product);
  }
  if (product && Array.isArray(iaWidgets) && !iaWidgets.includes(row.widgetType)) {
    return NEEDS_SWITCHING_ON_SENTENCE;
  }
  return null;
}

/**
 * Does this widget publish a fallback on THIS site, or refuse?
 *
 * A row with no fallback never swaps. A row whose fallback needs something the
 * site has to have asks its own predicate — the same one the fallback itself
 * asks, so the sentence and the published node cannot disagree.
 */
export function swapWillFire(row, ctx = {}) {
  if (!row || !row.fallback) return false;
  return row.fallbackFires ? !!row.fallbackFires(ctx) : true;
}

/**
 * WHY a widget is not offered, as one word the Portal can branch on.
 *
 * 'tier' = the website plan; 'ownership' = a product of ours. Null when the
 * widget is offered. The SENTENCE is still the server's, so a pane that only
 * prints it draws the right thing without knowing these words at all.
 */
export function lockReason(kind, opts = {}) {
  const row = ELEMENTOR_WIDGETS[kind];
  if (!row || !lockSentence(kind, opts)) return null;
  return row.tier === PRO ? 'tier' : 'ownership';
}

/**
 * "WE COULD NOT ASK" IS NOT "THEY DO NOT HAVE IT".
 *
 * `coreTenants.tenantServiceOwnership` answers `{ known, owned }`, and this is
 * the ONE place that turns it into what the catalogue reads: the list when the
 * question was answered, and `null` — which locks nothing — when it was not.
 * A failed query must never tell a client they do not own a product they pay
 * for; the publish path still refuses, with a reason, if the site really
 * cannot draw the widget.
 */
export function ownedProductsFrom(answer) {
  return answer && answer.known ? (answer.owned || []) : null;
}

/** Every product any widget in the catalogue needs, for one ownership query. */
export function productsNeeded() {
  return [...new Set(iaWidgetKinds().map((w) => w.product))];
}

/**
 * THE WIDGET CATALOGUE THE PANE RENDERS — one row per widget, three states.
 *
 * The same shape `sectionCatalog` answers for a section, so the Portal reads
 * one reply and learns both. The gate is NOT here: `allowPro` comes from
 * `siteCapability.allowProFor`, `ownedProducts` from `coreTenants
 * .tenantServiceOwnership`, and `iaWidgets` from what the site itself
 * registered. This function only says what each widget NEEDS.
 */
export function widgetCatalog({
  allowPro = true, iaWidgets = null, ownedProducts = null, iaShortcodes = null,
} = {}) {
  const opts = { allowPro, iaWidgets, ownedProducts, iaShortcodes };
  return listWidgetKinds().map((kind) => {
    const row = ELEMENTOR_WIDGETS[kind];
    const sentence = lockSentence(kind, opts);
    return {
      kind,
      label: row.label,
      tier: row.tier,
      available: !sentence,
      reason: lockReason(kind, opts),
      unavailableReason: sentence,
      // What a locked widget publishes INSTEAD — on THIS site, not in
      // principle. A pane that knows this can say "you still get the words"
      // rather than only "no", and it is never told that about a widget this
      // site would refuse.
      hasFallback: swapWillFire(row, opts),
    };
  });
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
  lockSentence, lockReason, widgetCatalog, swapWillFire, resolveWidget, UnsupportedWidgetError,
  PRO_LOCK_SENTENCE, NEEDS_SWITCHING_ON_SENTENCE, notOwnedSentence,
  cardProps, bindingProps, boundCardValues, REFRESH_MODES, ON_EMPTY_MODES,
  IA_SOURCES,
  ownedProductsFrom, productsNeeded,
};
