/**
 * Elementor adapter — block JSON → Elementor _elementor_data section tree.
 * --------------------------------------------------------------------------
 * The block emitters produce a *semantic* shape (headline / subheadline /
 * services list / etc.). The page assembler eventually concatenates many
 * accepted blocks into a full `_elementor_data` array on each WP page.
 *
 * This adapter is the *block-level* converter — it takes ONE block payload
 * (validated by the emitter) and returns ONE Elementor "section" object
 * (or null on unknown kind). The page assembler (separate batch, F-204)
 * will array-wrap accepted blocks in display order.
 *
 * Format reference (Elementor 3.x export schema, reverse-engineered from
 * Hello Elementor pro exports):
 *   - Every node has: id (alphanumeric string), elType, settings, elements
 *   - Sections have elType='section', columns elType='column', widgets
 *     elType='widget' with widgetType set.
 *   - IDs are 7-char hex; we mint deterministic-ish IDs so re-applying the
 *     same draft doesn't churn Elementor's revisions.
 *
 * V2 will expand the per-widget settings — for V1 we ship the minimal valid
 * tree that Elementor's import accepts and renders correctly with Hello
 * Elementor + default global colors.
 */

import crypto from 'node:crypto';
// ONE implementation of the pricing-card markup. sectionSchema imports
// `inferFormFieldType` and `formFieldId` from this file, and this file imports
// the card codec from there - the two modules already depend on each other in
// that direction only for pure functions, and Node resolves the cycle because
// neither is used at module top level.
import { encodePricingCard } from './sectionSchema.js';

/**
 * Mint a short Elementor-style id. Stable when given a seed (so the same
 * block_id produces the same element ids on re-apply).
 */
function mintId(seed, salt) {
  const h = crypto.createHash('sha1').update(`${seed || ''}::${salt}`).digest('hex');
  return h.slice(0, 7);
}

/* ==========================================================================
 * Who does a generated form notify?
 * --------------------------------------------------------------------------
 * `email_to` used to be read from `brand.email` -- a key brandContext never
 * returned -- so EVERY AI-built contact form shipped with an empty
 * notification recipient. Capture into ARION still worked (the plugin's form
 * interceptor fires regardless), so the defect was silent: the owner simply
 * never heard about the lead. Evidence:
 * SCOPE_ARION_SITE_BUILDER_2026-09-05 section 2.5.
 *
 * brandContext now supplies `email`. A form we cannot address is a broken
 * deliverable, so the adapter REFUSES to build one instead of publishing a
 * dead form; the assembler turns that refusal into a skipped[] entry the
 * caller sees. There is deliberately no hardcoded fallback address -- mail to
 * the wrong inbox is worse than a refused build.
 * ======================================================================== */

/** Thrown when a form section cannot be given a notification recipient. */
export class FormRecipientError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FormRecipientError';
    this.code = 'form_recipient_missing';
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function firstEmail(candidates) {
  for (const raw of candidates) {
    const v = String(raw == null ? '' : raw).trim();
    if (EMAIL_RE.test(v)) return v;
  }
  return null;
}

/**
 * The tenant's own notification address first (brandContext.email --
 * questionnaire, signup session, or arion.tenant.primary_email), then the
 * email contact method this section's own copy already shows the visitor.
 *
 * @returns {string|null} a valid address, or null when none can be resolved
 */
export function resolveFormRecipient(brand, block) {
  const fromBrand = firstEmail([
    brand?.email,
    brand?.notification_email,
    brand?.contact_email,
  ]);
  if (fromBrand) return fromBrand;

  const methods = Array.isArray(block?.contact_methods) ? block.contact_methods : [];
  const fromBlock = [];
  for (const m of methods) {
    if (!m || m.kind !== 'email') continue;
    const href = String(m.href || '').trim();
    if (/^mailto:/i.test(href)) fromBlock.push(href.slice(7).split('?')[0]);
    fromBlock.push(m.value);
  }
  return firstEmail(fromBlock);
}

/* ==========================================================================
 * What KIND of form is this?
 * --------------------------------------------------------------------------
 * The plugin's form interceptor types every submission from the widget's
 * `form_css_class` (ia-plugin/includes/class-ia-form-interceptor.php:127):
 *
 *   ia-booking -> booking | ia-quote -> quote | ia-newsletter -> newsletter
 *   ia-lead    -> lead    | ia-contact -> contact
 *
 * ...falling back to a substring of the form NAME when no class matches. We
 * never set the class, so no form we generated could be typed booking, quote
 * or lead -- every one of them landed as "contact" on the name fallback. This
 * is the wire the site builder must not cut
 * (SCOPE_ARION_SITE_BUILDER_2026-09-05 section 2.5).
 * ======================================================================== */

// The interceptor's own token table, mirrored. Keep these strings in step
// with class-ia-form-interceptor.php:127 -- they are the routing wire.
const FORM_PURPOSE_CLASS = Object.freeze({
  lead:       'ia-lead',
  contact:    'ia-lead',   // a contact-form submission IS a lead
  quote:      'ia-quote',
  booking:    'ia-booking',
  newsletter: 'ia-newsletter',
});

/**
 * The CSS class that types a generated form for the plugin's interceptor.
 * An unknown purpose falls back to `ia-lead`: an UNTYPED form is the defect,
 * while a form typed as a lead is at worst imprecise and still routes.
 */
export function formCssClassFor(purpose) {
  const key = String(purpose == null ? '' : purpose).trim().toLowerCase();
  return FORM_PURPOSE_CLASS[key] || 'ia-lead';
}

/**
 * An explicit purpose on the block wins (the section editor's "what is this
 * form for?" picker writes it); otherwise the section kind decides.
 */
function resolveFormPurpose(kind, block) {
  return block?.form_config?.purpose
      || block?.form_purpose
      || kind;
}

/* ==========================================================================
 * Section identity
 * --------------------------------------------------------------------------
 * Migration 029:14 establishes the convention -- the blueprint id "is set on
 * each section's settings._title at authoring time". The curated library
 * honours it; this adapter never did (grep _title found one hit, the FAQ tab
 * titles), so a section we generated was indistinguishable from one a human
 * built in Elementor and the Portal had nothing to key on.
 *
 * Format: ia:<archetype>:<blueprintId|scratch>:<blockId>
 *
 * The archetype segment is the ADAPTER KIND -- the key that can re-render the
 * section -- so the handle stays identical whichever path built it.
 * ======================================================================== */

/**
 * Build the stable handle for one generated section.
 * `blockId` is the arion.site_block_draft row id when we have one ('-' at
 * emit time, where the draft row does not exist yet; the assembler re-stamps
 * it once the id is known).
 */
export function buildSectionTitle({ kind, block, blockId } = {}) {
  const archetype = String(block?.archetype || kind || 'section').trim().toLowerCase();
  const blueprint = String(block?.blueprint_id || 'scratch').trim() || 'scratch';
  const id = String(blockId == null ? '' : blockId).trim() || '-';
  return `ia:${archetype}:${blueprint}:${id}`;
}

/** True only for a handle this codebase minted -- never a hand-authored _title. */
export function isIaSectionTitle(title) {
  return typeof title === 'string' && title.startsWith('ia:');
}

/* ==========================================================================
 * Form fields
 * --------------------------------------------------------------------------
 * What KIND of input a labelled field gets. This lived in TWO places -- here
 * and in sectionSchema's `buildFormField` -- and they disagreed: this one
 * knows "Square Footage" is a number, that one did not. The result was a
 * silent round-trip defect. Editing a headline re-encoded the form's fields
 * and turned the number box into a text box, on a form the client had not
 * touched. Found by asserting whole-section byte identity, which is the only
 * assertion that could have found it.
 *
 * One function, imported by both. `sectionSchema` already imports from this
 * file, so there is no new dependency and no cycle.
 * ======================================================================== */
export function inferFormFieldType(label) {
  const lower = String(label == null ? '' : label).toLowerCase();
  if (lower.includes('email')) return 'email';
  if (lower.includes('phone')) return 'tel';
  if (lower.includes('date')) return 'date';
  if (lower.includes('time')) return 'time';
  if (lower.includes('message') || lower.includes('notes')) return 'textarea';
  if (lower.includes('party size') || lower.includes('square footage')) return 'number';
  return 'text';
}

/** The stable id a labelled field is stored under. */
export function formFieldId(label, idx = 0) {
  const sanitized = String(label == null ? '' : label)
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized || `field_${idx}`;
}

function heroToElementor(block, brand, seedId) {
  const bg = block.background_style || 'solid';
  // V1 background config — solid uses primary brand color, image leaves a
  // placeholder for the page assembler to fill in from the media library.
  const backgroundSettings = bg === 'solid'
    ? {
        background_background: 'classic',
        background_color: brand?.primary_color || '#1A3A4A',
      }
    : bg === 'gradient'
    ? {
        background_background: 'gradient',
        background_color: brand?.primary_color || '#1A3A4A',
        background_color_b: '#FFFFFF',
      }
    : {
        background_background: 'classic',
        background_color: brand?.primary_color || '#1A3A4A',
        // image url filled in by page assembler — leaves a sentinel for now
        background_image: { url: '', id: '' },
      };

  return {
    id: mintId(seedId, 'hero-sec'),
    elType: 'section',
    settings: {
      // The hero's picture is the section background, not a widget, so the
      // binding hangs off the section itself (sectionSchema 'hero.background').
      _ia_field_section: 'hero.background',
      structure: '10',
      layout: 'full_width',
      height: 'min-height',
      custom_height: { unit: 'vh', size: 60 },
      content_position: 'middle',
      ...backgroundSettings,
    },
    elements: [
      {
        id: mintId(seedId, 'hero-col'),
        elType: 'column',
        settings: { _column_size: 100 },
        elements: [
          {
            id: mintId(seedId, 'hero-h'),
            elType: 'widget',
            widgetType: 'heading',
            settings: {
              _ia_field: 'hero.headline',
              title: block.headline,
              size: 'xl',
              header_size: 'h1',
              align: 'center',
            },
          },
          {
            id: mintId(seedId, 'hero-sub'),
            elType: 'widget',
            widgetType: 'text-editor',
            settings: {
              _ia_field: 'hero.subheadline',
              editor: `<p>${escapeHtml(block.subheadline)}</p>`,
              align: 'center',
            },
          },
          {
            id: mintId(seedId, 'hero-cta'),
            elType: 'widget',
            widgetType: 'button',
            settings: {
              _ia_field: 'hero.cta',
              text: block.cta_text,
              link: { url: block.cta_href || '#contact', is_external: '', nofollow: '' },
              align: 'center',
              size: 'lg',
            },
          },
        ],
      },
    ],
    isInner: false,
  };
}

function servicesToElementor(block, brand, seedId) {
  const items = (block.services || []).map((svc, idx) => ({
    id: mintId(seedId, `svc-col-${idx}`),
    elType: 'column',
    settings: { _column_size: Math.max(25, Math.floor(100 / Math.max(1, block.services.length))) },
    elements: [
      {
        id: mintId(seedId, `svc-icon-${idx}`),
        elType: 'widget',
        widgetType: 'icon-box',
        settings: {
          _ia_field: 'services.items',
          selected_icon: { value: `fas fa-${svc.icon_name}`, library: 'fa-solid' },
          title_text: svc.title,
          description_text: svc.description,
          position: 'top',
          title_size: 'h3',
        },
      },
    ],
  }));

  const headingSection = {
    id: mintId(seedId, 'svc-head-col'),
    elType: 'column',
    settings: { _column_size: 100 },
    elements: [
      {
        id: mintId(seedId, 'svc-head-h'),
        elType: 'widget',
        widgetType: 'heading',
        settings: { _ia_field: 'services.headline', title: block.headline, header_size: 'h2', align: 'center' },
      },
      ...(block.subheadline
        ? [{
            id: mintId(seedId, 'svc-head-sub'),
            elType: 'widget',
            widgetType: 'text-editor',
            settings: { _ia_field: 'services.subheadline', editor: `<p>${escapeHtml(block.subheadline)}</p>`, align: 'center' },
          }]
        : []),
    ],
  };

  return {
    id: mintId(seedId, 'svc-sec'),
    elType: 'section',
    settings: {
      structure: items.length <= 2 ? '20' : items.length === 3 ? '30' : '40',
      gap: 'extended',
    },
    elements: [headingSection, ...items],
    isInner: false,
  };
}

function testimonialsToElementor(block, brand, seedId) {
  // Heading column (full width, on top).
  const headingCol = {
    id: mintId(seedId, 'tst-head-col'),
    elType: 'column',
    settings: { _column_size: 100 },
    elements: [
      {
        id: mintId(seedId, 'tst-head-h'),
        elType: 'widget',
        widgetType: 'heading',
        settings: { _ia_field: 'testimonials.headline', title: block.headline, header_size: 'h2', align: 'center' },
      },
      ...(block.subheadline
        ? [{
            id: mintId(seedId, 'tst-head-sub'),
            elType: 'widget',
            widgetType: 'text-editor',
            settings: { _ia_field: 'testimonials.subheadline', editor: `<p>${escapeHtml(block.subheadline)}</p>`, align: 'center' },
          }]
        : []),
    ],
  };

  // One column per testimonial, each containing a text-editor widget with the
  // quote, attribution, and a rating row. V1 uses text-editor for portability;
  // V2 will swap to Elementor Pro's "Testimonial Carousel" when available.
  const itemCols = (block.testimonials || []).map((t, idx) => {
    const stars = '★'.repeat(Math.max(1, Math.min(5, Number(t.rating) || 5)));
    const html = [
      `<p class="ia-rating" aria-label="${t.rating || 5} out of 5">${stars}</p>`,
      `<blockquote><p>${escapeHtml(t.quote)}</p></blockquote>`,
      `<p class="ia-attribution"><strong>${escapeHtml(t.attribution)}</strong><br>${escapeHtml(t.role)}</p>`,
    ].join('\n');

    return {
      id: mintId(seedId, `tst-col-${idx}`),
      elType: 'column',
      settings: { _column_size: Math.max(20, Math.floor(100 / Math.max(1, block.testimonials.length))) },
      elements: [
        {
          id: mintId(seedId, `tst-card-${idx}`),
          elType: 'widget',
          widgetType: 'text-editor',
          settings: { _ia_field: 'testimonials.items', editor: html, align: 'left' },
        },
      ],
    };
  });

  return {
    id: mintId(seedId, 'tst-sec'),
    elType: 'section',
    settings: {
      structure: itemCols.length <= 2 ? '20' : itemCols.length === 3 ? '30' : '40',
      gap: 'extended',
    },
    elements: [headingCol, ...itemCols],
    isInner: false,
  };
}

function ctaToElementor(block, brand, seedId) {
  const bg = block.background_style || 'gradient';
  const backgroundSettings = bg === 'solid'
    ? {
        background_background: 'classic',
        background_color: brand?.primary_color || '#1A3A4A',
      }
    : bg === 'gradient'
    ? {
        background_background: 'gradient',
        background_color: brand?.primary_color || '#1A3A4A',
        background_color_b: brand?.accent_color || '#FEC82C',
      }
    : {
        background_background: 'classic',
        background_color: brand?.primary_color || '#1A3A4A',
        background_image: { url: '', id: '' },
      };

  const buttonElements = [];
  buttonElements.push({
    id: mintId(seedId, 'cta-btn-primary'),
    elType: 'widget',
    widgetType: 'button',
    settings: {
      _ia_field: 'cta.primary',
      text: block.primary_cta_text,
      link: { url: block.primary_cta_href || '#contact', is_external: '', nofollow: '' },
      align: 'center',
      size: 'lg',
      button_type: 'primary',
    },
  });
  if (block.secondary_cta_text && block.secondary_cta_href) {
    buttonElements.push({
      id: mintId(seedId, 'cta-btn-secondary'),
      elType: 'widget',
      widgetType: 'button',
      settings: {
        _ia_field: 'cta.secondary',
        text: block.secondary_cta_text,
        link: {
          url: block.secondary_cta_href,
          is_external: '',
          nofollow: '',
        },
        align: 'center',
        size: 'lg',
        button_type: 'default',
      },
    });
  }

  return {
    id: mintId(seedId, 'cta-sec'),
    elType: 'section',
    settings: {
      structure: '10',
      layout: 'full_width',
      height: 'min-height',
      custom_height: { unit: 'vh', size: 40 },
      content_position: 'middle',
      ...backgroundSettings,
    },
    elements: [
      {
        id: mintId(seedId, 'cta-col'),
        elType: 'column',
        settings: { _column_size: 100 },
        elements: [
          {
            id: mintId(seedId, 'cta-h'),
            elType: 'widget',
            widgetType: 'heading',
            settings: {
              _ia_field: 'cta.headline',
              title: block.headline,
              header_size: 'h2',
              align: 'center',
            },
          },
          ...(block.subheadline
            ? [{
                id: mintId(seedId, 'cta-sub'),
                elType: 'widget',
                widgetType: 'text-editor',
                settings: { _ia_field: 'cta.subheadline', editor: `<p>${escapeHtml(block.subheadline)}</p>`, align: 'center' },
              }]
            : []),
          ...buttonElements,
        ],
      },
    ],
    isInner: false,
  };
}

function aboutToElementor(block, brand, seedId) {
  // Top section: 2-column story (image left, copy right).
  const storyHtml = (block.story_paragraphs || [])
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join('\n');

  const storySection = {
    id: mintId(seedId, 'abt-story-sec'),
    elType: 'section',
    settings: { structure: '20', gap: 'extended' },
    elements: [
      {
        id: mintId(seedId, 'abt-img-col'),
        elType: 'column',
        settings: { _column_size: 50 },
        elements: [
          {
            id: mintId(seedId, 'abt-img'),
            elType: 'widget',
            widgetType: 'image',
            settings: {
              _ia_field: 'about.image',
              // Image url filled in by page assembler — leaves a sentinel for now.
              image: { url: '', id: '', alt: block.image_alt || '' },
              image_size: 'large',
            },
          },
        ],
      },
      {
        id: mintId(seedId, 'abt-copy-col'),
        elType: 'column',
        settings: { _column_size: 50 },
        elements: [
          {
            id: mintId(seedId, 'abt-h'),
            elType: 'widget',
            widgetType: 'heading',
            settings: { _ia_field: 'about.headline', title: block.headline, header_size: 'h2', align: 'left' },
          },
          ...(block.subheadline
            ? [{
                id: mintId(seedId, 'abt-sub'),
                elType: 'widget',
                widgetType: 'text-editor',
                settings: { _ia_field: 'about.subheadline', editor: `<p><em>${escapeHtml(block.subheadline)}</em></p>`, align: 'left' },
              }]
            : []),
          {
            id: mintId(seedId, 'abt-story'),
            elType: 'widget',
            widgetType: 'text-editor',
            settings: { _ia_field: 'about.story', editor: storyHtml, align: 'left' },
          },
        ],
      },
    ],
    isInner: false,
  };

  // Values row: inner section under the story with one column per value.
  const valueCols = (block.values || []).map((v, idx) => ({
    id: mintId(seedId, `abt-val-col-${idx}`),
    elType: 'column',
    settings: { _column_size: Math.max(25, Math.floor(100 / Math.max(1, block.values.length))) },
    elements: [
      {
        id: mintId(seedId, `abt-val-${idx}`),
        elType: 'widget',
        widgetType: 'icon-box',
        settings: {
          _ia_field: 'about.values',
          selected_icon: { value: 'fas fa-star', library: 'fa-solid' },
          title_text: v.title,
          description_text: v.description,
          position: 'top',
          title_size: 'h4',
        },
      },
    ],
  }));

  return {
    id: mintId(seedId, 'abt-outer-sec'),
    elType: 'section',
    settings: { structure: '10', gap: 'extended' },
    elements: [
      {
        id: mintId(seedId, 'abt-outer-col'),
        elType: 'column',
        settings: { _column_size: 100 },
        elements: [
          storySection,
          {
            id: mintId(seedId, 'abt-values-sec'),
            elType: 'section',
            settings: {
              structure: valueCols.length <= 2 ? '20' : valueCols.length === 3 ? '30' : '40',
              gap: 'extended',
            },
            elements: valueCols,
            isInner: true,
          },
        ],
      },
    ],
    isInner: false,
  };
}

function faqToElementor(block, brand, seedId) {
  // Elementor's "accordion" widget takes a `tabs` array.
  const items = (block.faqs || []).map((f, idx) => ({
    _id: mintId(seedId, `faq-item-${idx}`),
    tab_title: f.question,
    tab_content: `<p>${escapeHtml(f.answer)}</p>`,
  }));

  return {
    id: mintId(seedId, 'faq-sec'),
    elType: 'section',
    settings: { structure: '10', gap: 'extended' },
    elements: [
      {
        id: mintId(seedId, 'faq-col'),
        elType: 'column',
        settings: { _column_size: 100 },
        elements: [
          {
            id: mintId(seedId, 'faq-h'),
            elType: 'widget',
            widgetType: 'heading',
            settings: { _ia_field: 'faq.headline', title: block.headline, header_size: 'h2', align: 'center' },
          },
          ...(block.subheadline
            ? [{
                id: mintId(seedId, 'faq-sub'),
                elType: 'widget',
                widgetType: 'text-editor',
                settings: { _ia_field: 'faq.subheadline', editor: `<p>${escapeHtml(block.subheadline)}</p>`, align: 'center' },
              }]
            : []),
          {
            id: mintId(seedId, 'faq-acc'),
            elType: 'widget',
            widgetType: 'accordion',
            settings: {
              _ia_field: 'faq.items',
              tabs: items,
              title_html_tag: 'h3',
            },
          },
        ],
      },
    ],
    isInner: false,
  };
}

function galleryToElementor(block, brand, seedId) {
  // Heading column on top.
  const headingCol = {
    id: mintId(seedId, 'gal-head-col'),
    elType: 'column',
    settings: { _column_size: 100 },
    elements: [
      {
        id: mintId(seedId, 'gal-head-h'),
        elType: 'widget',
        widgetType: 'heading',
        settings: { _ia_field: 'gallery.headline', title: block.headline, header_size: 'h2', align: 'center' },
      },
      ...(block.subheadline
        ? [{
            id: mintId(seedId, 'gal-head-sub'),
            elType: 'widget',
            widgetType: 'text-editor',
            settings: { _ia_field: 'gallery.subheadline', editor: `<p>${escapeHtml(block.subheadline)}</p>`, align: 'center' },
          }]
        : []),
    ],
  };

  // Elementor's "image-gallery" widget takes a `gallery` array of { id, url }.
  // For V1 we leave id empty (no media-library binding yet) and let the page
  // assembler/founder swap the URLs at publish time. The alt + caption +
  // category ride along on a parallel `ia_gallery_meta` setting so the swap
  // step can preserve editorial intent.
  const gallery = (block.images || []).map((img, idx) => ({
    id: '',
    url: img.url,
    _meta_idx: idx,
  }));
  const ia_gallery_meta = (block.images || []).map((img) => ({
    alt: img.alt || '',
    caption: img.caption || '',
    category: img.category || '',
  }));

  const galleryCol = {
    id: mintId(seedId, 'gal-grid-col'),
    elType: 'column',
    settings: { _column_size: 100 },
    elements: [
      {
        id: mintId(seedId, 'gal-grid'),
        elType: 'widget',
        widgetType: 'image-gallery',
        settings: {
          _ia_field: 'gallery.items',
          gallery,
          gallery_columns: gallery.length <= 6 ? 3 : 4,
          gallery_link: 'file',
          image_size: 'medium_large',
          ia_gallery_meta,
        },
      },
    ],
  };

  return {
    id: mintId(seedId, 'gal-sec'),
    elType: 'section',
    settings: { structure: '10', gap: 'extended' },
    elements: [headingCol, galleryCol],
    isInner: false,
  };
}

function contactToElementor(block, brand, seedId) {
  // Resolve the notification recipient BEFORE building anything. A contact
  // form with no recipient is not a deliverable -- the owner never hears about
  // the lead -- so refuse the section rather than publish a dead form.
  const emailTo = resolveFormRecipient(brand, block);
  if (!emailTo) {
    throw new FormRecipientError(
      'Cannot build the contact form: no notification email could be resolved for this '
      + 'business. Set the business contact email (onboarding questionnaire, or the '
      + 'tenant primary email) and rebuild the section.',
    );
  }
  const formCssClass = formCssClassFor(resolveFormPurpose('contact', block));

  // Heading column (full width on top).
  const headingCol = {
    id: mintId(seedId, 'ctc-head-col'),
    elType: 'column',
    settings: { _column_size: 100 },
    elements: [
      {
        id: mintId(seedId, 'ctc-head-h'),
        elType: 'widget',
        widgetType: 'heading',
        settings: { _ia_field: 'contact.headline', title: block.headline, header_size: 'h2', align: 'center' },
      },
      ...(block.subheadline
        ? [{
            id: mintId(seedId, 'ctc-head-sub'),
            elType: 'widget',
            widgetType: 'text-editor',
            settings: { _ia_field: 'contact.subheadline', editor: `<p>${escapeHtml(block.subheadline)}</p>`, align: 'center' },
          }]
        : []),
    ],
  };

  // Left column: contact methods rendered as an icon-list widget.
  const iconForKind = (k) => {
    switch (k) {
      case 'phone':   return 'fas fa-phone';
      case 'email':   return 'fas fa-envelope';
      case 'address': return 'fas fa-map-marker-alt';
      case 'social':  return 'fas fa-share-alt';
      default:        return 'fas fa-circle';
    }
  };

  const methodItems = (block.contact_methods || []).map((m, idx) => ({
    _id: mintId(seedId, `ctc-m-${idx}`),
    text: `${m.label}: ${m.value}`,
    selected_icon: { value: iconForKind(m.kind), library: 'fa-solid' },
    link: { url: m.href, is_external: m.kind === 'social' || m.kind === 'address' ? 'on' : '', nofollow: '' },
  }));

  const methodsCol = {
    id: mintId(seedId, 'ctc-methods-col'),
    elType: 'column',
    settings: { _column_size: 50 },
    elements: [
      {
        id: mintId(seedId, 'ctc-methods'),
        elType: 'widget',
        widgetType: 'icon-list',
        settings: {
          _ia_field: 'contact.methods',
          icon_list: methodItems,
          view: 'traditional',
          space_between: { unit: 'px', size: 16 },
        },
      },
    ],
  };

  // Right column: Elementor Pro "form" widget config. V1 uses the field
  // labels as field IDs (sanitized) — the page assembler can wire submissions
  // to Lumen's ingest later.
  const fields = (block.form_config?.fields || []).map((label, idx) => {
    const field_type = inferFormFieldType(label);
    return {
      _id: mintId(seedId, `ctc-f-${idx}`),
      custom_id: formFieldId(label, idx),
      field_type,
      field_label: label,
      placeholder: '',
      required: field_type === 'textarea' ? '' : 'true',
      width: '100',
    };
  });

  const formCol = {
    id: mintId(seedId, 'ctc-form-col'),
    elType: 'column',
    settings: { _column_size: 50 },
    elements: [
      {
        id: mintId(seedId, 'ctc-form'),
        elType: 'widget',
        widgetType: 'form',
        settings: {
          _ia_field: 'contact.form',
          form_name: 'Contact',
          // The wire the plugin's form interceptor routes on -- see
          // formCssClassFor. Stable, so a form keeps its type across edits.
          form_css_class: formCssClass,
          form_fields: fields,
          button_text: block.form_config?.submit_text || 'Send message',
          button_size: 'md',
          button_align: 'left',
          email_to: emailTo,
          email_subject: `New message from ${brand?.business_name || 'your website'}`,
        },
      },
    ],
  };

  // Outer wrapper section: heading row, then 2-column methods/form row.
  return {
    id: mintId(seedId, 'ctc-outer-sec'),
    elType: 'section',
    settings: { structure: '10', gap: 'extended' },
    elements: [
      {
        id: mintId(seedId, 'ctc-outer-col'),
        elType: 'column',
        settings: { _column_size: 100 },
        elements: [
          {
            id: mintId(seedId, 'ctc-head-sec'),
            elType: 'section',
            settings: { structure: '10', gap: 'default' },
            elements: [headingCol],
            isInner: true,
          },
          {
            id: mintId(seedId, 'ctc-body-sec'),
            elType: 'section',
            settings: { structure: '20', gap: 'extended' },
            elements: [methodsCol, formCol],
            isInner: true,
          },
        ],
      },
    ],
    isInner: false,
  };
}

/* ==========================================================================
 * ARION pack 2 - pricing, team and stats.
 *
 * These three archetypes exist in the curated library and had no editor kind
 * at all, so more than thirty hand-drawn layouts could never be offered
 * (libraryAdapter's ARCHETYPES_WITHOUT_A_KIND said so in its own words).
 *
 * All three are drawn with FREE Elementor widgets only. Elementor Pro's
 * `price-table` and `price-list` would be the obvious choice for pricing and
 * are deliberately not used: the Pro licence seat for ARION Lite is a money
 * question parked to 2027, and a section a Lite site cannot render is worse
 * than one drawn from primitives.
 * ======================================================================== */

/** The heading column every one of these sections starts with. */
function headingColumn(block, seedId, prefix, kind) {
  return {
    id: mintId(seedId, `${prefix}-head-col`),
    elType: 'column',
    settings: { _column_size: 100 },
    elements: [
      {
        id: mintId(seedId, `${prefix}-head-h`),
        elType: 'widget',
        widgetType: 'heading',
        settings: { _ia_field: `${kind}.headline`, title: block.headline, header_size: 'h2', align: 'center' },
      },
      ...(block.subheadline
        ? [{
            id: mintId(seedId, `${prefix}-head-sub`),
            elType: 'widget',
            widgetType: 'text-editor',
            settings: { _ia_field: `${kind}.subheadline`, editor: `<p>${escapeHtml(block.subheadline)}</p>`, align: 'center' },
          }]
        : []),
    ],
  };
}

function structureFor(count) {
  return count <= 2 ? '20' : count === 3 ? '30' : '40';
}

/**
 * One card per package, each card ONE text-editor holding composed markup.
 * `sectionSchema.encodePricingCard` owns that markup - there is one
 * implementation of it, and the editor reads the values straight back out.
 */
function pricingToElementor(block, brand, seedId) {
  const plans = Array.isArray(block.plans) ? block.plans : [];
  const columns = plans.map((plan, idx) => ({
    id: mintId(seedId, `price-col-${idx}`),
    elType: 'column',
    settings: { _column_size: Math.max(25, Math.floor(100 / Math.max(1, plans.length))) },
    elements: [
      {
        id: mintId(seedId, `price-card-${idx}`),
        elType: 'widget',
        widgetType: 'text-editor',
        settings: { _ia_field: 'pricing.plans', editor: encodePricingCard(plan), align: 'center' },
      },
    ],
  }));

  return {
    id: mintId(seedId, 'price-sec'),
    elType: 'section',
    settings: { structure: structureFor(plans.length), gap: 'extended' },
    elements: [headingColumn(block, seedId, 'price', 'pricing'), ...columns],
    isInner: false,
  };
}

/** One `image-box` per person: Elementor's own free person card. */
function teamToElementor(block, brand, seedId) {
  const members = Array.isArray(block.members) ? block.members : [];
  const columns = members.map((person, idx) => ({
    id: mintId(seedId, `team-col-${idx}`),
    elType: 'column',
    settings: { _column_size: Math.max(25, Math.floor(100 / Math.max(1, members.length))) },
    elements: [
      {
        id: mintId(seedId, `team-card-${idx}`),
        elType: 'widget',
        widgetType: 'image-box',
        settings: {
          _ia_field: 'team.members',
          image: {
            url: person?.photo_url || '',
            // The ATTACHMENT ID travels with the URL so Elementor can emit a
            // srcset; without it every phone downloads the desktop file.
            id: person?.photo_id === '' || person?.photo_id == null ? '' : person.photo_id,
            alt: person?.photo_alt || '',
          },
          title_text: person?.name || '',
          description_text: person?.role || '',
          position: 'top',
          title_size: 'h3',
        },
      },
    ],
  }));

  return {
    id: mintId(seedId, 'team-sec'),
    elType: 'section',
    settings: { structure: structureFor(members.length), gap: 'extended' },
    elements: [headingColumn(block, seedId, 'team', 'team'), ...columns],
    isInner: false,
  };
}

/** One `counter` per figure: Elementor's own free number widget. */
function statsToElementor(block, brand, seedId) {
  const stats = Array.isArray(block.stats) ? block.stats : [];
  const columns = stats.map((stat, idx) => ({
    id: mintId(seedId, `stat-col-${idx}`),
    elType: 'column',
    settings: { _column_size: Math.max(25, Math.floor(100 / Math.max(1, stats.length))) },
    elements: [
      {
        id: mintId(seedId, `stat-num-${idx}`),
        elType: 'widget',
        widgetType: 'counter',
        settings: {
          _ia_field: 'stats.items',
          starting_number: 0,
          ending_number: stat?.value ?? '',
          prefix: stat?.prefix || '',
          suffix: stat?.suffix || '',
          title: stat?.label || '',
        },
      },
    ],
  }));

  return {
    id: mintId(seedId, 'stat-sec'),
    elType: 'section',
    settings: { structure: structureFor(stats.length), gap: 'extended' },
    elements: [headingColumn(block, seedId, 'stat', 'stats'), ...columns],
    isInner: false,
  };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const ADAPTERS = {
  hero: heroToElementor,
  pricing: pricingToElementor,
  team: teamToElementor,
  stats: statsToElementor,
  services: servicesToElementor,
  testimonials: testimonialsToElementor,
  cta: ctaToElementor,
  about: aboutToElementor,
  faq: faqToElementor,
  gallery: galleryToElementor,
  contact: contactToElementor,
};

/**
 * Convert one block payload + brand into one Elementor section node.
 *
 * @param {{ kind: string, block: object, brand: object, seedId?: string }} args
 * @returns {object|null}
 */
export function blockToElementorSection({ kind, block, brand, seedId, blockId }) {
  const adapter = ADAPTERS[kind];
  if (!adapter) return null;
  const section = adapter(block, brand || {}, seedId || `${kind}-${Date.now()}`);
  if (!section) return null;
  // Stamp the migration-029 handle centrally so every emitter gets it and no
  // future emitter can forget it. Returns a NEW object -- adapters stay pure.
  return {
    ...section,
    settings: {
      ...(section.settings || {}),
      _title: buildSectionTitle({ kind, block, blockId }),
    },
  };
}

export function listSupportedKinds() {
  return Object.keys(ADAPTERS).sort();
}

export const __test__ = { escapeHtml, mintId, FORM_PURPOSE_CLASS, resolveFormPurpose };
