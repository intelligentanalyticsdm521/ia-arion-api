/**
 * families/f6-money/emitters.js - what the f6-money family PUBLISHES.
 *
 * BUILDER_FULL_WIDGET_PLAN_2026-09-19 section C.1, and D-168 behind it. Four
 * widgets, all four Elementor's own, all four PRO:
 *
 *   price_table    -> `price-table`
 *   price_list     -> `price-list`
 *   paypal_button  -> `paypal-button`
 *   stripe_button  -> `stripe-button`
 *
 * Every settings key below is one the page engine really has - checked against
 * the Portal's test/fixtures/WIDGET_SETTINGS_KEYS.json by this family's test.
 * A key the engine does not have is DROPPED SILENTLY on publish, so the
 * author's change does nothing on the live page and nothing anywhere says so.
 *
 * -- WHY EVERY ROW HAS A FALLBACK -----------------------------------------
 * All four are Pro. A site on a plan with no Pro widgets would otherwise get
 * the refusal sentence and no band at all. `fallback` publishes the same words
 * out of FREE widgets - a heading, the price, the list, a button - so the
 * visitor reads the real offer either way. The two PAYMENT buttons are the
 * exception that proves the rule: a payment button rebuilt out of a plain
 * button cannot take money, so their fallback publishes a button to the
 * business's OWN payment page when the author gave one and answers `null` when
 * they did not. `resolveWidget` then refuses BY NAME, which is the honest
 * answer - a button that looks like it takes a payment and silently does
 * nothing is worse than a widget the client is told they cannot have.
 */
import { mintId, escapeHtml } from '../../elementorIds.js';

const PRO = 'pro';

const text = (v) => String(v == null ? '' : v);
const html = (v) => `<p>${escapeHtml(text(v))}</p>`;
const widgetNode = (id, widgetType, settings) => ({ id, elType: 'widget', widgetType, settings });

/** Elementor's link shape. An empty url is a button that goes nowhere. */
const link = (v) => {
  const url = v && typeof v === 'object' ? text(v.url) : text(v);
  return { url, is_external: '', nofollow: '' };
};

/** A switcher is the string 'yes' on the wire, and nothing at all when off. */
const on = (v) => (v === true || v === 'yes' ? 'yes' : '');

/** One of a list, or the first - never a value the control would ignore. */
const choice = (v, allowed, dflt) => (allowed.includes(text(v)) ? text(v) : dflt);

const num = (v, dflt = '') => {
  const s = text(v).trim();
  if (!s) return dflt;
  const n = Number(s);
  return Number.isFinite(n) ? n : dflt;
};

/* -- the option lists, copied from BUILDER_WIDGET_CATALOG_2026-09-17.pro.json */
const CURRENCY_SYMBOLS = [
  '', 'dollar', 'euro', 'baht', 'franc', 'guilder', 'krona', 'lira', 'peseta', 'peso',
  'pound', 'real', 'ruble', 'rupee', 'indian_rupee', 'shekel', 'yen', 'won', 'custom',
];
const HEADING_TAGS = ['h2', 'h3', 'h4', 'h5', 'h6'];
const HTML_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'div', 'span', 'p'];
const IMAGE_SIZES = ['thumbnail', 'medium', 'medium_large', 'large', '1536x1536', '2048x2048', 'full', 'custom'];
const RIBBON_SIDES = ['left', 'right'];
const FEATURE_ALIGN = ['start', 'center', 'end'];
const SEPARATORS = ['none', 'solid', 'dotted', 'dashed', 'double'];
const V_ALIGN = ['top', 'center', 'bottom'];
const BUTTON_ALIGN = ['left', 'center', 'right', 'justify'];
const PAYPAL_TYPES = ['checkout', 'donation', 'subscription'];
const DONATION_TYPES = ['any', 'fixed'];
const BILLING_CYCLES = ['days', 'weeks', 'months', 'years'];
const TAX_TYPES = ['', 'percentage'];

/** `features_list` rows, in the repeater shape the page engine reads. */
function featureRows(p) {
  const raw = Array.isArray(p.features_list) ? p.features_list : [];
  return raw
    .map((r) => text(r && typeof r === 'object' ? r.item_text : r).trim())
    .filter(Boolean)
    .map((item_text, i) => ({ _id: `f${i}`, item_text }));
}

/**
 * `price_list` rows, likewise - and in BOTH spellings.
 *
 * Elementor's own repeater is `price_list[{title, price, item_description}]`
 * and that is what the rebuilt panel writes. The row this family REPLACED (the
 * old `price_list` in elementorWidgets.js, deleted in the same commit) read
 * `items[{name, description, price}]`. A page published before that swap still
 * holds the old spelling, so it is read second rather than lost - the same
 * rule `price_line` / `priced_line` already follow on the document side.
 */
function priceRows(p) {
  const own = Array.isArray(p.price_list) ? p.price_list : null;
  const raw = own || (Array.isArray(p.items) ? p.items.map((r) => ({
    title: r && r.name, price: r && r.price, item_description: r && r.description,
  })) : []);
  return raw
    .map((r, i) => {
      const row = r && typeof r === 'object' ? r : {};
      const image = row.image && typeof row.image === 'object' ? row.image : { url: text(row.image), id: '', size: '' };
      return {
        _id: `p${i}`,
        title: text(row.title),
        price: text(row.price),
        item_description: text(row.item_description),
        image,
        link: link(row.link),
      };
    })
    .filter((r) => r.title || r.price || r.item_description);
}

/* ═══════════════════════════════════════════════════════════════════════════
   The fallbacks - the same words out of FREE widgets
   ═════════════════════════════════════════════════════════════════════════ */

function priceTableFallback(p, ctx) {
  const seed = (ctx && ctx.seed) || 'price_table';
  const id = (salt) => mintId(seed, `${(ctx && ctx.nodeId) || 'pt'}-${salt}`);
  const out = [];
  const heading = text(p.heading).trim();
  const price = text(p.price).trim();
  const features = featureRows(p);
  // Nothing typed is nothing to publish: an empty bordered box on a live page
  // is the "green toast over a blank band" this module refuses everywhere.
  if (!heading && !price && !features.length && !text(p.sub_heading).trim()) return null;
  if (on(p.show_ribbon) && text(p.ribbon_title).trim()) {
    out.push(widgetNode(id('r'), 'text-editor', { editor: html(p.ribbon_title), align: 'left' }));
  }
  if (heading) {
    out.push(widgetNode(id('h'), 'heading', {
      title: heading, header_size: choice(p.heading_tag, HEADING_TAGS, 'h3'), align: 'left',
    }));
  }
  if (text(p.sub_heading).trim()) out.push(widgetNode(id('s'), 'text-editor', { editor: html(p.sub_heading), align: 'left' }));
  if (price) {
    const period = text(p.period).trim();
    out.push(widgetNode(id('p'), 'heading', {
      title: period ? `${price} ${period}` : price, header_size: 'h2', align: 'left',
    }));
  }
  if (on(p.sale) && text(p.original_price).trim()) {
    out.push(widgetNode(id('o'), 'text-editor', { editor: html(`Was ${text(p.original_price)}`), align: 'left' }));
  }
  if (features.length) {
    out.push(widgetNode(id('f'), 'icon-list', {
      icon_list: features.map((f, i) => ({ _id: `l${i}`, text: f.item_text })),
    }));
  }
  if (text(p.footer_additional_info).trim()) {
    out.push(widgetNode(id('n'), 'text-editor', { editor: html(p.footer_additional_info), align: 'left' }));
  }
  if (text(p.button_text).trim()) {
    out.push(widgetNode(id('b'), 'button', { text: text(p.button_text), link: link(p.link), align: 'left' }));
  }
  return { id: id('c'), elType: 'container', settings: {}, elements: out };
}

function priceListFallback(p, ctx) {
  const rows = priceRows(p);
  if (!rows.length) return null;
  const seed = (ctx && ctx.seed) || 'price_list';
  const id = (salt) => mintId(seed, `${(ctx && ctx.nodeId) || 'pl'}-${salt}`);
  // ONE free widget draws a row-per-thing with a value on the right, and it is
  // Icon List. A hand-built table of containers would be a second layout for a
  // shape the free panel already has.
  return widgetNode(id('l'), 'icon-list', {
    icon_list: rows.map((r, i) => ({
      _id: `l${i}`,
      text: [r.title, r.price].filter(Boolean).join(' — '),
      link: r.link,
    })),
  });
}

/**
 * A PAYMENT button rebuilt out of a plain button cannot take a payment.
 *
 * So the only honest fallback is the business's OWN payment page: when the
 * author filled in Redirect After Success there is somewhere real to send the
 * person, and when they did not, this answers null and `resolveWidget` refuses
 * by name with the sentence the client reads.
 */
function payFallback(p, ctx) {
  const url = text(link(p.redirect_after_success).url).trim();
  if (!url) return null;
  const seed = (ctx && ctx.seed) || 'pay';
  const id = (salt) => mintId(seed, `${(ctx && ctx.nodeId) || 'pb'}-${salt}`);
  return widgetNode(id('b'), 'button', {
    text: text(p.text) || 'Pay now',
    link: { url, is_external: 'on', nofollow: '' },
    align: choice(p.align, BUTTON_ALIGN, 'left'),
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   The rows
   ═════════════════════════════════════════════════════════════════════════ */

export const EMITTERS = {
  price_table: {
    widgetType: 'price-table', tier: PRO, label: 'Price Table',
    settings: (p) => ({
      heading: text(p.heading),
      sub_heading: text(p.sub_heading),
      heading_tag: choice(p.heading_tag, HEADING_TAGS, 'h3'),
      currency_symbol: choice(p.currency_symbol, CURRENCY_SYMBOLS, ''),
      ...(text(p.currency_symbol) === 'custom' ? { currency_symbol_custom: text(p.currency_symbol_custom) } : {}),
      price: text(p.price),
      currency_format: choice(p.currency_format, ['', ','], ''),
      ...(on(p.sale) ? { sale: 'yes', original_price: num(p.original_price, '') } : {}),
      period: text(p.period),
      features_list: featureRows(p),
      button_text: text(p.button_text),
      link: link(p.link),
      footer_additional_info: text(p.footer_additional_info),
      ...(on(p.show_ribbon)
        ? {
          show_ribbon: 'yes',
          ribbon_title: text(p.ribbon_title),
          ribbon_horizontal_position: choice(p.ribbon_horizontal_position, RIBBON_SIDES, 'right'),
          ...(text(p.ribbon_bg_color) ? { ribbon_bg_color: text(p.ribbon_bg_color) } : {}),
          ...(text(p.ribbon_text_color) ? { ribbon_text_color: text(p.ribbon_text_color) } : {}),
        }
        : {}),
      /* The Style tab, only where the author actually set something: an empty
         colour published as "" overrides the site's own theme with nothing. */
      ...(text(p.header_bg_color) ? { header_bg_color: text(p.header_bg_color) } : {}),
      ...(text(p.heading_color) ? { heading_color: text(p.heading_color) } : {}),
      ...(text(p.pricing_element_bg_color) ? { pricing_element_bg_color: text(p.pricing_element_bg_color) } : {}),
      ...(text(p.price_color) ? { price_color: text(p.price_color) } : {}),
      ...(text(p.features_list_bg_color) ? { features_list_bg_color: text(p.features_list_bg_color) } : {}),
      ...(text(p.features_list_color) ? { features_list_color: text(p.features_list_color) } : {}),
      ...(text(p.features_list_alignment)
        ? { features_list_alignment: choice(p.features_list_alignment, FEATURE_ALIGN, 'center') } : {}),
      ...(text(p.footer_bg_color) ? { footer_bg_color: text(p.footer_bg_color) } : {}),
      ...(text(p.button_background_color) ? { button_background_color: text(p.button_background_color) } : {}),
      ...(text(p.button_text_color) ? { button_text_color: text(p.button_text_color) } : {}),
    }),
    fallback: (p, ctx) => priceTableFallback(p, ctx),
  },

  price_list: {
    widgetType: 'price-list', tier: PRO, label: 'Price List',
    settings: (p) => ({
      price_list: priceRows(p),
      title_tag: choice(p.title_tag, HTML_TAGS, 'span'),
      description_tag: choice(p.description_tag, HTML_TAGS, 'p'),
      image_size_size: choice(p.image_size_size, IMAGE_SIZES, 'thumbnail'),
      ...(text(p.heading_color) ? { heading_color: text(p.heading_color) } : {}),
      ...(text(p.price_color) ? { price_color: text(p.price_color) } : {}),
      ...(text(p.description_color) ? { description_color: text(p.description_color) } : {}),
      ...(text(p.separator_style) ? { separator_style: choice(p.separator_style, SEPARATORS, 'none') } : {}),
      ...(text(p.separator_color) ? { separator_color: text(p.separator_color) } : {}),
      ...(text(p.vertical_align) ? { vertical_align: choice(p.vertical_align, V_ALIGN, 'top') } : {}),
    }),
    fallback: (p, ctx) => priceListFallback(p, ctx),
  },

  paypal_button: {
    widgetType: 'paypal-button', tier: PRO, label: 'PayPal Button',
    settings: (p) => ({
      email: text(p.email),
      type: choice(p.type, PAYPAL_TYPES, 'checkout'),
      product_name: text(p.product_name),
      product_sku: text(p.product_sku),
      product_price: num(p.product_price, '0.00'),
      donation_type: choice(p.donation_type, DONATION_TYPES, 'fixed'),
      ...(text(p.donation_amount) ? { donation_amount: num(p.donation_amount, '') } : {}),
      currency: text(p.currency) || 'USD',
      billing_cycle: choice(p.billing_cycle, BILLING_CYCLES, 'months'),
      auto_renewal: on(p.auto_renewal),
      quantity: num(p.quantity, 1),
      shipping_price: num(p.shipping_price, 0),
      tax_type: choice(p.tax_type, TAX_TYPES, ''),
      tax_rate: num(p.tax_rate, '0'),
      text: text(p.text) || 'Buy Now',
      /* NO VENDOR MARK. Elementor defaults `selected_icon` to the PayPal
         glyph; a processor's logo belongs on the business's page only if the
         business puts it there. Published empty, on purpose. */
      selected_icon: { value: '', library: '' },
      ...(text(p.button_css_id) ? { button_css_id: text(p.button_css_id) } : {}),
      redirect_after_success: link(p.redirect_after_success),
      sandbox_mode: on(p.sandbox_mode),
      open_in_new_window: on(p.open_in_new_window),
      ...(text(p.error_message_global) ? { custom_messages: 'yes', error_message_global: text(p.error_message_global) } : {}),
      ...(text(p.align) ? { align: choice(p.align, BUTTON_ALIGN, 'left') } : {}),
      ...(text(p.background_color) ? { background_color: text(p.background_color) } : {}),
      ...(text(p.button_text_color) ? { button_text_color: text(p.button_text_color) } : {}),
    }),
    fallback: (p, ctx) => payFallback(p, ctx),
  },

  stripe_button: {
    widgetType: 'stripe-button', tier: PRO, label: 'Stripe Button',
    settings: (p) => ({
      product_name: text(p.product_name),
      stripe_product_price: num(p.stripe_product_price, '0.00'),
      stripe_currency: text(p.stripe_currency) || 'USD',
      stripe_quantity: num(p.stripe_quantity, 1),
      donation_type: choice(p.donation_type, DONATION_TYPES, 'fixed'),
      ...(text(p.donation_amount) ? { donation_amount: num(p.donation_amount, '') } : {}),
      shipping_price: num(p.shipping_price, 0),
      tax_rate: num(p.tax_rate, '0'),
      text: text(p.text) || 'Buy Now',
      /* As PayPal: no processor glyph. */
      selected_icon: { value: '', library: '' },
      ...(text(p.button_css_id) ? { button_css_id: text(p.button_css_id) } : {}),
      redirect_after_success: link(p.redirect_after_success),
      sandbox_mode: on(p.sandbox_mode),
      open_in_new_window: on(p.open_in_new_window),
      ...(text(p.error_message_global) ? { custom_messages: 'yes', error_message_global: text(p.error_message_global) } : {}),
      ...(text(p.align) ? { align: choice(p.align, BUTTON_ALIGN, 'left') } : {}),
      ...(text(p.background_color) ? { background_color: text(p.background_color) } : {}),
      ...(text(p.button_text_color) ? { button_text_color: text(p.button_text_color) } : {}),
    }),
    fallback: (p, ctx) => payFallback(p, ctx),
  },
};

export default EMITTERS;
