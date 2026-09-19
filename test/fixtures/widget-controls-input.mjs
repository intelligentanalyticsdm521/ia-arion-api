/**
 * The ONE maximal props object every widget row is run over.
 *
 * Shared by `scripts/dev/extract-widget-controls.mjs`, which writes the pin
 * fixture, and by `test/website-widget-map.test.mjs`, which reads it — so the
 * fixture and the test can never be asking different questions.
 *
 * It sets EVERY prop any row reads. A row that reads a prop nobody set here
 * would emit its default, which is still a real key and still pinned; a row
 * that gains a NEW prop should gain a line here, and the extractor's own
 * refusal is what catches a key the page engine does not have.
 */
export { ELEMENTOR_WIDGETS } from '../../lib/websiteBuilder/elementorWidgets.js';

/** Keys we write that are OURS, not the engine's. Never pinned as controls. */
export const SETTINGS_NOT_CONTROLS = [
  '_ia_widget', '_ia_swapped', '_ia_source', '_ia_selection', '_ia_refresh', '_ia_on_empty',
  '_ia_form_purpose', '_css_classes',
  /* The plugin's LEGACY alias for a form's purpose. Not an engine control and
     deliberately still written (`formPurpose.js` says why): the routing in
     `intelligent-analytics.php` reads it today. */
  'form_css_class',
];

export const WIDGET_CTX = {
  seed: 'pin', nodeId: 'pin-1', allowPro: true,
  emailTo: 'hello@example.test',
  iaShortcodes: ['ia_form', 'ia_book_now'],
  ownedProducts: ['oliver', 'lumen', 'arion'],
};

export const MAXIMAL_WIDGET_PROPS = {
  /* words and links */
  text: 'A line of words', title: 'A heading', level: 'h2', align: 'center',
  html: '<p>Typed markup</p>', shortcode: '[ia_book_now]',
  items: [{ title: 'One', body: 'The first', question: 'Q', answer: 'A', name: 'Row', price: '10', description: 'D', quote: 'Good', attribution: 'Somebody', role: 'Owner' }],
  href: 'https://example.test/go', url: 'https://example.test/go', size: 'md',
  /* pictures */
  src: 'https://cdn.example.test/p.jpg', mediaId: '12', caption: 'A caption',
  images: [{ url: 'https://cdn.example.test/1.jpg', mediaId: '13' }],
  columns: 3, height: 40,
  /* the standard set */
  icon: 'check', view: 'stacked', shape: 'rounded',
  quote: 'They were out before we opened.', attribution: 'A customer', position: 'top',
  rating: 4, scale: 5, type: 'warning', dismissible: true,
  links: [{ network: 'facebook', url: 'https://facebook.test/x' }],
  direction: 'horizontal', navigation: 'both', autoplay: true,
  percent: 70, show_percent: true, inner_text: 'most of the way',
  anchor: 'prices', address: '1200 Prairie Ave, Marshalltown, IA', zoom: 12,
  /* the paid panel */
  count: 6, menu: 'main', ends_at: '2026-11-01 06:00',
  front_title: 'Front', front_text: 'The front', back_title: 'Back', back_text: 'The back',
  button_text: 'Get in touch',
  fields: [{ id: 'f1', label: 'Your name', type: 'text', required: true }],
  emailTo: 'hello@example.test', purpose: 'contact',
  /* a card, in the paid widget's own spelling */
  heading: 'Essentials', price: '185', currency_symbol: 'dollar', period: 'per push',
  original_price: '220', sale: true,
  features_list: [{ item_text: 'Plowing' }], footer_additional_info: 'Billed monthly',
  link: 'https://example.test/book', show_ribbon: true, ribbon_title: 'Recommended',
  /* the catalogue binding */
  _ia_source: 'oliver:catalogue',
  _ia_selection: { offering_id: 'svc-1', price_id: 'p-1', tier: 'standard' },
  refresh: 'live', on_empty: 'hide', overrides: { heading: 'Essentials' },
  show_price: true, show_inclusions: true,
};
