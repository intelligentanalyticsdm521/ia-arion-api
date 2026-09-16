/**
 * The INPUT half of the container-dialect goldens.
 *
 * One realistic block payload per section kind, written once and shared by the
 * golden builder (scripts/dev/build-container-goldens.mjs) and the test that
 * diffs its output. An invented Iowa snow-and-ice firm — fixture only, never a
 * real client's words (memory: feedback_no_real_client_data_in_dev).
 *
 * A kind absent from GOLDEN_BLOCKS falls back to its starter block, which is
 * itself worth pinning: a starter that stops building is a section a client
 * cannot add.
 */

export const GOLDEN_BRAND = Object.freeze({
  business_name: 'Northfield Snow & Ice',
  email: 'office@northfield.invalid',
  primary_color: '#1E4E57',
  accent_color: '#C9822A',
  tagline: 'Cleared before you are awake.',
});

export const GOLDEN_BLOCKS = Object.freeze({
  hero: {
    headline: 'Commercial snow and ice, done before opening',
    subheadline: 'Contracted plowing, salting and sidewalk clearing across the metro.',
    cta_text: 'Get a quote',
    cta_href: '#contact',
    background_style: 'image',
  },
  services: {
    headline: 'What we do',
    subheadline: 'Three contracted services, priced per push or per season.',
    services: [
      { title: 'Lot plowing', description: 'Every push at a two-inch trigger.', icon_name: 'truck' },
      { title: 'Ice control', description: 'Granular salt on every visit.', icon_name: 'snowflake' },
      { title: 'Sidewalks', description: 'Hand-cleared entrances and walks.', icon_name: 'person-walking' },
    ],
  },
  testimonials: {
    headline: 'What our customers say',
    subheadline: '',
    testimonials: [
      { quote: 'Lot was clear at 5am every single storm.', attribution: 'Dana Whitfield', role: 'Facilities, Brookline Dental', rating: 5 },
      { quote: 'They text us when they are on site.', attribution: 'Marco Reyes', role: 'Owner, Reyes Auto', rating: 5 },
    ],
  },
  cta: {
    headline: 'Booking for the coming season now',
    subheadline: 'Seasonal contracts close on 1 November.',
    primary_cta_text: 'Request a quote',
    primary_cta_href: '#contact',
    secondary_cta_text: 'Call the office',
    secondary_cta_href: 'tel:+15155550142',
    background_style: 'gradient',
  },
  about: {
    headline: 'About Northfield Snow & Ice',
    subheadline: 'Family run since 2011.',
    story_paragraphs: [
      'We started with one truck and four accounts.',
      'Today we hold contracts on fifty commercial sites across the metro.',
    ],
    image_alt: 'A plow truck clearing a car park at dawn',
    values: [
      { title: 'On site before open', description: 'Every trigger event, every account.' },
      { title: 'One price, written down', description: 'No storm-day surcharges.' },
    ],
  },
  faq: {
    headline: 'Questions we get asked',
    subheadline: '',
    faqs: [
      { question: 'What is a trigger depth?', answer: 'The snowfall at which we come out without being called.' },
      { question: 'Do you salt every visit?', answer: 'On ice-control contracts, yes.' },
    ],
  },
  gallery: {
    headline: 'Our work',
    subheadline: '',
    images: [
      { url: 'https://example.invalid/wp-content/uploads/lot-1.jpg', id: 101, alt: 'A cleared car park', caption: 'Brookline Dental', category: 'Lots' },
      { url: 'https://example.invalid/wp-content/uploads/walk-1.jpg', id: 102, alt: 'A cleared footpath', caption: 'Reyes Auto', category: 'Walks' },
    ],
  },
  pricing: {
    headline: 'What it costs',
    subheadline: '',
    plans: [
      {
        name: 'Per push', price: '$185', period: 'per push', summary: 'Charged each time we clear.',
        features: ['Two-inch trigger', 'Lot and approach'], cta_text: 'Get a quote', cta_href: '#contact', offering_id: 'svc-push',
      },
      {
        name: 'Seasonal', price: '$4,200', period: 'per season', summary: 'One price, whatever the winter does.',
        features: ['Unlimited pushes', 'Ice control included'], cta_text: 'Get a quote', cta_href: '#contact', offering_id: 'svc-seasonal',
      },
    ],
  },
  team: {
    headline: 'The people at Northfield Snow & Ice',
    subheadline: '',
    members: [
      { name: 'Ray Ostlund', role: 'Owner and operations', photo_url: 'https://example.invalid/wp-content/uploads/ray.jpg', photo_alt: 'Ray Ostlund', photo_id: 201 },
      { name: 'Jo Marek', role: 'Dispatch', photo_url: '', photo_alt: '', photo_id: '' },
    ],
  },
  stats: {
    headline: 'By the numbers',
    subheadline: '',
    stats: [
      { value: '14', prefix: '', suffix: '', label: 'Winters running' },
      { value: '50', prefix: '', suffix: '+', label: 'Commercial sites' },
    ],
  },
  contact: {
    headline: 'Get in touch',
    subheadline: 'Tell us the address and we will price it.',
    contact_methods: [
      { kind: 'phone', label: 'Office', value: '(515) 555-0142', href: 'tel:+15155550142' },
      { kind: 'email', label: 'Email', value: 'office@northfield.invalid', href: 'mailto:office@northfield.invalid' },
    ],
    form_config: { fields: ['Name', 'Email', 'Phone', 'Square Footage', 'Message'], submit_text: 'Send' },
    form_purpose: 'quote',
  },
  content: {
    layout: 2,
    blocks: [
      { kind: 'heading', text: 'How a storm runs', level: 'h2', align: 'left', col: 0 },
      { kind: 'paragraph', text: ['We watch the forecast from Thursday.', 'Crews roll at the trigger depth.'], col: 0 },
      { kind: 'list', items: ['Two-inch trigger', 'Salt on every visit', 'Photos on completion'], col: 0 },
      { kind: 'image', url: 'https://example.invalid/wp-content/uploads/storm.jpg', alt: 'A plow at dawn', id: 301, caption: 'Brookline Dental, 5am', col: 1 },
      { kind: 'button', label: 'See our rates', href: '#pricing', align: 'left', col: 1 },
      { kind: 'divider', col: 1 },
      { kind: 'spacer', height: 24, col: 1 },
      { kind: 'video', url: 'https://www.youtube.com/watch?v=ia-fixture', col: 1 },
      { kind: 'map', address: '400 Locust St, Des Moines, IA', col: 1 },
    ],
  },
});
