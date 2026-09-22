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
  /* THE POPOVER TOGGLES (B-168, 2026-09-22).
     Elementor's group controls have a switch that says "this group is set" -
     `typography_typography`, `text_shadow_text_shadow_type`,
     `text_stroke_text_stroke_type`, `box_shadow_box_shadow_type`. The group's
     CSS is only written behind `{{WRAPPER}}` when it is on, so it HAS to be
     published; it is simply not in `elementor-widget-controls.json`, which was
     scraped from the editor's panel where a popover toggle is chrome rather
     than a control. `WIDGET_SETTINGS_KEYS.json`, which comes from
     `get_stack()` including `style_controls`, DOES list them - and the check
     that reads that file still holds every one of these to it. */
  'typography_typography',
  'text_shadow_text_shadow_type',
  'text_stroke_text_stroke_type',
  'box_shadow_box_shadow_type',
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
  /* Tabs and Accordion, in the spelling the PANEL stores (f4-moving wave 2).
     `items` above is the older reading and both are honoured; this one is
     what the builder writes today, so the pin runs over what a real page has. */
  tabs: [{ tab_title: 'What we do', tab_content: 'We clear it before six.' }],
  tabs_direction: 'inline-end', tabs_justify_horizontal: 'center',
  tabs_justify_vertical: 'center', tabs_width: 30, title_alignment: 'center',
  tabs_title_space_between: 8, tabs_title_spacing: 12,
  tabs_title_background_color_color: '#F1F5F9', tabs_title_border_color: '#CBD5E1',
  tabs_title_background_color_active_color: '#0C4A60',
  title_text_color: '#334155', title_text_color_active: '#0C4A60',
  title_typography_font_size: 16, title_typography_font_weight: '600',
  box_background_color_color: '#FFFFFF', box_border_color: '#E2E8F0', box_padding: 16,
  accordion_item_title_position_horizontal: 'start',
  accordion_item_title_icon_position: 'end', faq_schema: true, default_state: 'all_collapsed',
  accordion_item_title_space_between: 6, accordion_item_title_distance_from_content: 4,
  accordion_background_normal_color: '#FFFFFF', accordion_border_normal_color: '#E2E8F0',
  normal_title_color: '#334155', active_title_color: '#0C4A60',
  normal_icon_color: '#64748B', icon_spacing: 10,
  content_background_color: '#F8FAFC', content_border_color: '#E2E8F0', content_padding: 12,
  /* Counter and Progress Bar's Style tabs (f4-moving wave 2). */
  starting_number: 0, ending_number: 1250, prefix: '$', suffix: '+', duration: 1500,
  thousand_separator: true, thousand_separator_char: '.',
  title_tag: 'h3', title_position: 'before', title_horizontal_alignment: 'center',
  number_alignment: 'center', title_gap: 6,
  number_color: '#0C4A60', typography_number_font_size: 40, typography_number_font_weight: '700',
  title_color: '#334155', typography_title_font_size: 14, typography_title_font_weight: '500',
  title_display: true, progress_type: 'success', display_percentage: true,
  typography_font_size: 15, typography_font_weight: '600',
  bar_color: '#0C4A60', bar_bg_color: '#E2E8F0', bar_height: 18, bar_border_radius: 9,
  bar_inline_color: '#FFFFFF', bar_inner_typography_font_size: 11,
  /* Rating's own, in Elementor's modern spelling (f4-moving wave 2). */
  rating_scale: 5, rating_value: 4.5, rating_icon: 'eicon-star', icon_alignment: 'center',
  icon_size: 22, icon_gap: 4, icon_color: '#F59E0B', icon_unmarked_color: '#E2E8F0',
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
  /* B-168 f6-money — the four money widgets, in Elementor's own spellings.
     A prop nobody sets here still emits its default, which is a real key and
     still pinned; setting them means the fixture pins the REAL values too. */
  sub_heading: 'Eight visits a season', heading_tag: 'h3', currency_format: ',',
  currency_symbol_custom: '', ribbon_horizontal_position: 'left',
  header_bg_color: '#F8FAFC', heading_color: '#0B1C24',
  pricing_element_bg_color: '#FFFFFF', price_color: '#0B1C24',
  features_list_bg_color: '#FFFFFF', features_list_color: '#334155',
  features_list_alignment: 'center', footer_bg_color: '#F8FAFC',
  button_background_color: '#0C4A60', button_text_color: '#FFFFFF',
  ribbon_bg_color: '#0C4A60', ribbon_text_color: '#FFFFFF',
  price_list: [{ title: 'Mowing', price: '$65', item_description: 'Weekly, April to October' }],
  title_tag: 'h4', description_tag: 'p', image_size_size: 'medium',
  description_color: '#475569', separator_style: 'dotted', separator_color: '#E2E8F0',
  vertical_align: 'center',
  email: 'pay@example.test', product_name: 'Deposit', product_sku: 'DEP-1',
  product_price: '250', donation_type: 'fixed', donation_amount: '25',
  currency: 'USD', billing_cycle: 'months', auto_renewal: true, quantity: 2,
  shipping_price: 0, tax_type: 'percentage', tax_rate: '8.25',
  stripe_product_price: '250', stripe_currency: 'USD', stripe_quantity: 2,
  button_css_id: 'pay1', redirect_after_success: 'https://example.test/thanks',
  sandbox_mode: false, open_in_new_window: true,
  error_message_global: 'Something went wrong.',
  background_color: '#0C4A60',
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
