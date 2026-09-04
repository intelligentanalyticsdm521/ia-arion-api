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
              editor: `<p>${escapeHtml(block.subheadline)}</p>`,
              align: 'center',
            },
          },
          {
            id: mintId(seedId, 'hero-cta'),
            elType: 'widget',
            widgetType: 'button',
            settings: {
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
        settings: { title: block.headline, header_size: 'h2', align: 'center' },
      },
      ...(block.subheadline
        ? [{
            id: mintId(seedId, 'svc-head-sub'),
            elType: 'widget',
            widgetType: 'text-editor',
            settings: { editor: `<p>${escapeHtml(block.subheadline)}</p>`, align: 'center' },
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
        settings: { title: block.headline, header_size: 'h2', align: 'center' },
      },
      ...(block.subheadline
        ? [{
            id: mintId(seedId, 'tst-head-sub'),
            elType: 'widget',
            widgetType: 'text-editor',
            settings: { editor: `<p>${escapeHtml(block.subheadline)}</p>`, align: 'center' },
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
          settings: { editor: html, align: 'left' },
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
                settings: { editor: `<p>${escapeHtml(block.subheadline)}</p>`, align: 'center' },
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
            settings: { title: block.headline, header_size: 'h2', align: 'left' },
          },
          ...(block.subheadline
            ? [{
                id: mintId(seedId, 'abt-sub'),
                elType: 'widget',
                widgetType: 'text-editor',
                settings: { editor: `<p><em>${escapeHtml(block.subheadline)}</em></p>`, align: 'left' },
              }]
            : []),
          {
            id: mintId(seedId, 'abt-story'),
            elType: 'widget',
            widgetType: 'text-editor',
            settings: { editor: storyHtml, align: 'left' },
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
            settings: { title: block.headline, header_size: 'h2', align: 'center' },
          },
          ...(block.subheadline
            ? [{
                id: mintId(seedId, 'faq-sub'),
                elType: 'widget',
                widgetType: 'text-editor',
                settings: { editor: `<p>${escapeHtml(block.subheadline)}</p>`, align: 'center' },
              }]
            : []),
          {
            id: mintId(seedId, 'faq-acc'),
            elType: 'widget',
            widgetType: 'accordion',
            settings: {
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
        settings: { title: block.headline, header_size: 'h2', align: 'center' },
      },
      ...(block.subheadline
        ? [{
            id: mintId(seedId, 'gal-head-sub'),
            elType: 'widget',
            widgetType: 'text-editor',
            settings: { editor: `<p>${escapeHtml(block.subheadline)}</p>`, align: 'center' },
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
        settings: { title: block.headline, header_size: 'h2', align: 'center' },
      },
      ...(block.subheadline
        ? [{
            id: mintId(seedId, 'ctc-head-sub'),
            elType: 'widget',
            widgetType: 'text-editor',
            settings: { editor: `<p>${escapeHtml(block.subheadline)}</p>`, align: 'center' },
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
    const sanitized = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `field_${idx}`;
    const lower = label.toLowerCase();
    let field_type = 'text';
    if (lower.includes('email'))                       field_type = 'email';
    else if (lower.includes('phone'))                  field_type = 'tel';
    else if (lower.includes('date'))                   field_type = 'date';
    else if (lower.includes('time'))                   field_type = 'time';
    else if (lower.includes('message') || lower.includes('notes')) field_type = 'textarea';
    else if (lower.includes('party size') || lower.includes('square footage')) field_type = 'number';
    return {
      _id: mintId(seedId, `ctc-f-${idx}`),
      custom_id: sanitized,
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
          form_name: 'Contact',
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
export function blockToElementorSection({ kind, block, brand, seedId }) {
  const adapter = ADAPTERS[kind];
  if (!adapter) return null;
  return adapter(block, brand || {}, seedId || `${kind}-${Date.now()}`);
}

export function listSupportedKinds() {
  return Object.keys(ADAPTERS).sort();
}

export const __test__ = { escapeHtml, mintId };
