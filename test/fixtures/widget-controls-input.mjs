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
  /* B-168 F8 — Form, Login and WordPress Menu moved into
     `families/f8-contact-furniture` and took their whole panel with them. Every
     control those three now offer is set here, because a row that reads a prop
     nobody set emits its default instead and the pin never sees the key.
     Elementor's own key names, so nothing else in this object is disturbed:
     the three that ARE shared with older rows (`button_text`, `menu`,
     `heading`) were already above. */
  form_fields: [{ custom_id: 'name', field_type: 'text', field_label: 'Name', placeholder: 'Name', width: '100' }],
  form_name: 'Contact', input_size: 'lg', show_labels: 'yes', mark_required: 'yes',
  button_size: 'md', button_width: '50', column_gap: 12, row_gap: 14,
  label_color: '#5A7A8A', field_text_color: '#0B1C24', field_background_color: '#ffffff',
  field_border_color: '#CBD5E1', button_background_color: '#1D7A8C',
  button_text_color: '#ffffff', button_border_color: '#1D7A8C', links_color: '#1D7A8C',
  show_lost_password: 'yes', show_remember_me: 'yes', show_logged_in_message: 'yes',
  redirect_after_login: 'yes', redirect_url: 'https://example.test/account',
  redirect_after_logout: 'yes', redirect_logout_url: 'https://example.test/',
  menu_name: 'Primary', align_items: 'center', pointer: 'framed',
  dropdown: 'mobile', full_width: 'yes', text_align: 'center', toggle: 'burger',
  toggle_align: 'right', color_menu_item: '#0B1C24', pointer_color_menu_item_hover: '#1D7A8C',
  menu_space_between: 28, padding_horizontal_menu_item: 14, padding_vertical_menu_item: 10,
  border_radius_menu_item: 6, color_dropdown_item: '#0B1C24',
  background_color_dropdown_item: '#F8FAFC', toggle_color: '#0B1C24',
  toggle_background_color: '#ffffff', toggle_size: 22,
  /* a card, in the paid widget's own spelling */
  heading: 'Essentials', price: '185', currency_symbol: 'dollar', period: 'per push',
  original_price: '220', sale: true,
  features_list: [{ item_text: 'Plowing' }], footer_additional_info: 'Billed monthly',
  link: 'https://example.test/book', show_ribbon: true, ribbon_title: 'Recommended',
  /* the catalogue binding */
  _ia_source: 'oliver:catalogue',
  _ia_selection: { offering_id: 'svc-1', price_id: 'p-1', tier: 'standard' },
  refresh: 'live', on_empty: 'hide', overrides: { heading: 'Essentials' },
  /* B-168 F8 WAVE 2 - Google Maps, Book Now and the three IA plugin widgets.
     Every control those five now offer is set here, because a row that reads a
     prop nobody set emits its default instead and the pin never sees the key.
     Elementor's own key names (and, for the three plugin widgets, the PLUGIN'S
     own, read off the same 2026-09-17 registry scrape). The ones already above
     are not repeated: `address`, `zoom`, `height`, `align`, `columns`, `size`,
     `shape`, `link`, `text`, `menu`. */
  /* Google Maps */
  height_tablet: 300, height_mobile: 240,
  css_filters_css_filter: 'custom', css_filters_blur: 2, css_filters_brightness: 110,
  css_filters_contrast: 95, css_filters_saturate: 80, css_filters_hue: 20,
  css_filters_hover_css_filter: 'custom', css_filters_hover_blur: 0,
  css_filters_hover_brightness: 120, css_filters_hover_contrast: 100,
  css_filters_hover_saturate: 120, css_filters_hover_hue: 0, hover_transition: 0.3,
  /* Book Now, as Elementor's Button */
  button_type: 'success', button_css_id: 'book', icon_align: 'row-reverse', icon_indent: 8,
  align_tablet: 'center', align_mobile: 'left',
  typography_font_size: 15, typography_font_size_tablet: 14, typography_font_size_mobile: 13,
  background_color: '#1D7A8C', hover_color: '#ffffff',
  button_background_hover_color: '#0C4A60', button_hover_border_color: '#0C4A60',
  border_border: 'solid', border_color: '#0C4A60', border_width: 1, border_radius: 8,
  /* IA Social Links */
  platforms: ['facebook', 'linkedin'], columns_tablet: '2', columns_mobile: '1',
  icon_color: 'custom', icon_primary_color: '#0C4A60', icon_secondary_color: '#ffffff',
  icon_size: 24, icon_size_tablet: 22, icon_size_mobile: 20, icon_padding: 0.5, icon_spacing: 6,
  /* IA Mega Menu */
  menu_source: 'wordpress', menu_style: 'column-dropdown',
  menu_items: [{ _id: 'i0', item_label: 'Services', item_type: 'mega_trigger' }],
  menu_groups: [], featured_heading: 'Featured', featured_text: 'What is new',
  featured_link: 'https://example.test/new', featured_link_text: 'Learn More',
  bg_color: '#ffffff', text_color: '#0B1C24', accent_color: '#0C4A60',
  hover_color_menu: '#2D9CDB', border_color_menu: '#0C4A60',
  font_size: 14, item_spacing: 24, dropdown_animation: 'slide', dropdown_width: 'custom',
  dropdown_custom_width: 720,
  /* IA Mobile Menu */
  style: 'fullscreen_overlay',
  custom_items: [{ _id: 'i0', label: 'Home', url: '/' }],
  show_social: 'yes', social_links: [], show_cta: 'yes', cta_text: 'Contact Us',
  cta_link: 'https://example.test/contact', show_search: 'yes',
  bg_type: 'overlay', bg_image: 'https://cdn.example.test/bg.jpg',
  overlay_color: 'rgba(12,74,96,0.92)', close_icon_color: 'rgba(255,255,255,0.6)',
  animation_direction: 'left', panel_width: 320,
  /* IA OLIVER Invoice */
  business_logo_url: 'https://cdn.example.test/logo.png', business_name: 'A business',
  business_phone: '555-0100', business_email: 'hello@example.test',
  show_book_again_cta: 'yes', book_again_url: 'https://example.test/book',
  book_again_text: 'Schedule your next service',
  show_price: true, show_inclusions: true,
};
