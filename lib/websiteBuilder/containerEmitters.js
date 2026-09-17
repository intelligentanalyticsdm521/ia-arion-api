/**
 * Container emitters — ONE layout dialect for every section we author.
 * ---------------------------------------------------------------------------
 * BUILDER_PLATFORM_SCOPE_2026-09-15 §2: "The two ARION layout dialects (legacy
 * section/column from the adapter, flex containers from the library) must
 * become one before a canvas can show both kinds of section side by side.
 * Recommendation: containers (what Elementor itself uses now), with the adapter
 * taught to emit containers."
 *
 * That is this file. Every emitter below produces the SAME semantic tree the
 * legacy `section` → `column` → `widget` emitters produced — the same widget
 * types, the same settings, and above all the SAME `_ia_field` stamps — drawn
 * with Elementor's flexbox `container` instead.
 *
 * ── WHY IT IS SAFE TO SWAP THE DIALECT UNDER THE EDITOR ───────────────────
 * `sectionSchema.extractFields` and `applyFields` key on the `_ia_field` stamp
 * and walk `elements` generically; neither has ever cared what kind of node it
 * walked. What the two of them DO care about is the wrapper a repeating item
 * sits in, because adding a fourth service clones that wrapper — and
 * `applyFields` already handles both spellings:
 *
 *     const cloneColumn = last.parent
 *       && (last.parent.elType === 'column' || last.parent.elType === 'container')
 *
 * So every repeating item below is wrapped in its OWN one-widget container
 * inside a row container, exactly as the curated library draws one. A fourth
 * card then arrives with the card's own width, padding and background rather
 * than stacking inside the third one's column — which is what the legacy
 * emitters actually did.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────
 * No brand colour is invented. `brand.primary_color` reaches us from the ONE
 * brand kit (step 0) and the platform neutral is the only fallback, never IA's
 * navy or gold — a business with no recorded colour must not publish OUR brand
 * on THEIR website (§2, step 0).
 *
 * Pure: settings in, node out. No fetch, no clock beyond the caller's seed.
 */

// A LEAF module, on purpose: `sectionSchema` below is part of a cycle with
// `elementorAdapter`, and the two shared helpers must be reachable from
// outside that cycle. See elementorIds.js.
import { mintId, escapeHtml } from './elementorIds.js';
import { encodePricingCard, buildContentRow } from './sectionSchema.js';
import { NEUTRAL_BRAND_COLOURS } from '../brandKitClient.js';

/* The two form helpers live in elementorAdapter (sectionSchema imports them
 * from there). Re-declaring them would be a second implementation of the
 * silent round-trip defect that cost a whole debugging session, so they are
 * injected by the caller instead.
 *
 * DECLARED HERE, at the top, and not beside the function that sets them: a
 * module that imports this one through the cycle reaches `useFormFieldHelpers`
 * while this module is still initialising, and a `let` declared further down
 * the file is in its temporal dead zone at that moment — the whole import
 * throws `Cannot access 'inferFieldType' before initialization`. Found on
 * 2026-09-17 by importing the builder from a NEW entry point (elementorTree),
 * which is the first time anything had. */
let inferFieldType = (label) => String(label || '');
let fieldId = (label, idx) => String(label || idx);

/* ══════════════════════════════════════════════════════════════════════════
   Ids and small helpers
   ══════════════════════════════════════════════════════════════════════════ */

// One implementation of each, in a module with no imports of its own, so an
// emitter outside this file's cycle can reach them too.
export { mintId, escapeHtml };

const px = (n) => ({ unit: 'px', size: n, sizes: [] });

/**
 * Padding, in the four-sided shape Elementor stores.
 * Strings, not numbers: Elementor's dimensions control round-trips its values
 * as strings and a number here shows up as an empty box in its own editor.
 */
const pad = (top, right, bottom, left) => ({
  unit: 'px', top: String(top), right: String(right), bottom: String(bottom), left: String(left), isLinked: false,
});

/**
 * The top-level section container.
 *
 * `content_width: 'boxed'` is Elementor's own default and is what keeps a
 * section's contents inside the theme's page width; a hero or a call-to-action
 * band asks for 'full' so its background runs edge to edge.
 */
export function sectionContainer({ id, settings = {}, elements = [] }) {
  return {
    id,
    elType: 'container',
    settings: {
      container_type: 'flex',
      content_width: 'boxed',
      flex_direction: 'column',
      flex_gap: px(24),
      padding: pad(64, 20, 64, 20),
      ...settings,
    },
    elements,
    isInner: false,
  };
}

/** A row of cards. Wraps on a phone — which is the whole point of containers. */
export function rowContainer({ id, count, settings = {}, elements = [] }) {
  return {
    id,
    elType: 'container',
    settings: {
      container_type: 'flex',
      content_width: 'full',
      flex_direction: 'row',
      flex_wrap: 'wrap',
      flex_gap: px(24),
      flex_align_items: 'stretch',
      ...settings,
    },
    elements,
    isInner: true,
    // Not an Elementor setting — a note for a person reading the JSON.
    ...(count ? {} : {}),
  };
}

/**
 * ONE card: a container holding exactly one widget.
 *
 * One widget, always. `applyFields` clones the PARENT when the parent holds a
 * single widget, so this shape is what makes "add a fourth service" arrive
 * looking like the first three.
 */
export function cardContainer({ id, widthPercent, settings = {}, element }) {
  return {
    id,
    elType: 'container',
    settings: {
      container_type: 'flex',
      content_width: 'full',
      flex_direction: 'column',
      width: { unit: '%', size: widthPercent, sizes: [] },
      ...settings,
    },
    elements: [element],
    isInner: true,
  };
}

/** How wide one of `count` cards is, floored so four still fit on one row. */
export function cardWidth(count) {
  const n = Math.max(1, Number(count) || 1);
  if (n === 1) return 100;
  if (n === 2) return 48;
  if (n === 3) return 31;
  return 23;
}

function widget(id, widgetType, settings) {
  return { id, elType: 'widget', widgetType, settings };
}

/**
 * The heading (and optional supporting line) every section starts with.
 * Returned as an ARRAY of widgets so a caller can splice it into a container
 * without a wrapper nobody needs.
 */
function headingWidgets(block, seedId, prefix, kind, align = 'center') {
  const out = [
    widget(mintId(seedId, `${prefix}-head-h`), 'heading', {
      _ia_field: `${kind}.headline`, title: block.headline, header_size: 'h2', align,
    }),
  ];
  if (block.subheadline) {
    out.push(widget(mintId(seedId, `${prefix}-head-sub`), 'text-editor', {
      _ia_field: `${kind}.subheadline`, editor: `<p>${escapeHtml(block.subheadline)}</p>`, align,
    }));
  }
  return out;
}

/** A background, from the business's own colour and never from ours. */
function backgroundFor(style, brand, { gradientTo = null } = {}) {
  const primary = brand?.primary_color || NEUTRAL_BRAND_COLOURS.primary;
  if (style === 'gradient') {
    return {
      background_background: 'gradient',
      background_color: primary,
      background_color_b: gradientTo || brand?.accent_color || NEUTRAL_BRAND_COLOURS.accent,
    };
  }
  if (style === 'image') {
    return {
      background_background: 'classic',
      background_color: primary,
      background_image: { url: '', id: '' },
    };
  }
  return { background_background: 'classic', background_color: primary };
}

/* ══════════════════════════════════════════════════════════════════════════
   The eleven archetypes
   ══════════════════════════════════════════════════════════════════════════ */

function hero(block, brand, seedId) {
  return sectionContainer({
    id: mintId(seedId, 'hero-sec'),
    settings: {
      // The hero's picture is the container's own background, not a widget, so
      // the binding hangs off the container itself (BINDINGS 'hero.background').
      _ia_field_section: 'hero.background',
      content_width: 'full',
      min_height: { unit: 'vh', size: 60, sizes: [] },
      flex_justify_content: 'center',
      flex_align_items: 'center',
      padding: pad(96, 20, 96, 20),
      ...backgroundFor(block.background_style || 'solid', brand),
    },
    elements: [
      widget(mintId(seedId, 'hero-h'), 'heading', {
        _ia_field: 'hero.headline', title: block.headline, size: 'xl', header_size: 'h1', align: 'center',
      }),
      widget(mintId(seedId, 'hero-sub'), 'text-editor', {
        _ia_field: 'hero.subheadline', editor: `<p>${escapeHtml(block.subheadline)}</p>`, align: 'center',
      }),
      widget(mintId(seedId, 'hero-cta'), 'button', {
        _ia_field: 'hero.cta',
        text: block.cta_text,
        link: { url: block.cta_href || '#contact', is_external: '', nofollow: '' },
        align: 'center',
        size: 'lg',
      }),
    ],
  });
}

function services(block, brand, seedId) {
  const items = Array.isArray(block.services) ? block.services : [];
  const w = cardWidth(items.length);
  return sectionContainer({
    id: mintId(seedId, 'svc-sec'),
    elements: [
      ...headingWidgets(block, seedId, 'svc', 'services'),
      rowContainer({
        id: mintId(seedId, 'svc-row'),
        elements: items.map((svc, idx) => cardContainer({
          id: mintId(seedId, `svc-card-${idx}`),
          widthPercent: w,
          element: widget(mintId(seedId, `svc-icon-${idx}`), 'icon-box', {
            _ia_field: 'services.items',
            selected_icon: { value: `fas fa-${svc?.icon_name || 'circle'}`, library: 'fa-solid' },
            title_text: svc?.title || '',
            description_text: svc?.description || '',
            position: 'top',
            title_size: 'h3',
          }),
        })),
      }),
    ],
  });
}

function testimonials(block, brand, seedId) {
  const items = Array.isArray(block.testimonials) ? block.testimonials : [];
  const w = cardWidth(items.length);
  return sectionContainer({
    id: mintId(seedId, 'tst-sec'),
    elements: [
      ...headingWidgets(block, seedId, 'tst', 'testimonials'),
      rowContainer({
        id: mintId(seedId, 'tst-row'),
        elements: items.map((t, idx) => {
          const rating = Math.max(1, Math.min(5, Number(t?.rating) || 5));
          const html = [
            `<p class="ia-rating" aria-label="${rating} out of 5">${'★'.repeat(rating)}</p>`,
            `<blockquote><p>${escapeHtml(t?.quote)}</p></blockquote>`,
            `<p class="ia-attribution"><strong>${escapeHtml(t?.attribution)}</strong><br>${escapeHtml(t?.role)}</p>`,
          ].join('\n');
          return cardContainer({
            id: mintId(seedId, `tst-card-${idx}`),
            widthPercent: w,
            element: widget(mintId(seedId, `tst-quote-${idx}`), 'text-editor', {
              _ia_field: 'testimonials.items', editor: html, align: 'left',
            }),
          });
        }),
      }),
    ],
  });
}

function cta(block, brand, seedId) {
  const buttons = [
    widget(mintId(seedId, 'cta-btn-primary'), 'button', {
      _ia_field: 'cta.primary',
      text: block.primary_cta_text,
      link: { url: block.primary_cta_href || '#contact', is_external: '', nofollow: '' },
      align: 'center', size: 'lg', button_type: 'primary',
    }),
  ];
  if (block.secondary_cta_text && block.secondary_cta_href) {
    buttons.push(widget(mintId(seedId, 'cta-btn-secondary'), 'button', {
      _ia_field: 'cta.secondary',
      text: block.secondary_cta_text,
      link: { url: block.secondary_cta_href, is_external: '', nofollow: '' },
      align: 'center', size: 'lg', button_type: 'default',
    }));
  }
  return sectionContainer({
    id: mintId(seedId, 'cta-sec'),
    settings: {
      content_width: 'full',
      min_height: { unit: 'vh', size: 40, sizes: [] },
      flex_justify_content: 'center',
      flex_align_items: 'center',
      padding: pad(72, 20, 72, 20),
      ...backgroundFor(block.background_style || 'gradient', brand),
    },
    elements: [
      widget(mintId(seedId, 'cta-h'), 'heading', {
        _ia_field: 'cta.headline', title: block.headline, header_size: 'h2', align: 'center',
      }),
      ...(block.subheadline
        ? [widget(mintId(seedId, 'cta-sub'), 'text-editor', {
          _ia_field: 'cta.subheadline', editor: `<p>${escapeHtml(block.subheadline)}</p>`, align: 'center',
        })]
        : []),
      rowContainer({
        id: mintId(seedId, 'cta-btn-row'),
        settings: { flex_justify_content: 'center', flex_gap: px(12) },
        elements: buttons,
      }),
    ],
  });
}

function about(block, brand, seedId) {
  const storyHtml = (Array.isArray(block.story_paragraphs) ? block.story_paragraphs : [])
    .map((p) => `<p>${escapeHtml(p)}</p>`).join('\n');
  const values = Array.isArray(block.values) ? block.values : [];
  const w = cardWidth(values.length);

  const storyRow = rowContainer({
    id: mintId(seedId, 'abt-story-row'),
    settings: { flex_align_items: 'center', flex_gap: px(40) },
    elements: [
      cardContainer({
        id: mintId(seedId, 'abt-img-col'),
        widthPercent: 48,
        element: widget(mintId(seedId, 'abt-img'), 'image', {
          _ia_field: 'about.image',
          image: { url: '', id: '', alt: block.image_alt || '' },
          image_size: 'large',
        }),
      }),
      {
        id: mintId(seedId, 'abt-copy-col'),
        elType: 'container',
        settings: {
          container_type: 'flex', content_width: 'full', flex_direction: 'column',
          width: { unit: '%', size: 48, sizes: [] }, flex_gap: px(12),
        },
        elements: [
          widget(mintId(seedId, 'abt-h'), 'heading', {
            _ia_field: 'about.headline', title: block.headline, header_size: 'h2', align: 'left',
          }),
          ...(block.subheadline
            ? [widget(mintId(seedId, 'abt-sub'), 'text-editor', {
              _ia_field: 'about.subheadline', editor: `<p><em>${escapeHtml(block.subheadline)}</em></p>`, align: 'left',
            })]
            : []),
          widget(mintId(seedId, 'abt-story'), 'text-editor', {
            _ia_field: 'about.story', editor: storyHtml, align: 'left',
          }),
        ],
        isInner: true,
      },
    ],
  });

  const elements = [storyRow];
  if (values.length) {
    elements.push(rowContainer({
      id: mintId(seedId, 'abt-values-row'),
      elements: values.map((v, idx) => cardContainer({
        id: mintId(seedId, `abt-val-card-${idx}`),
        widthPercent: w,
        element: widget(mintId(seedId, `abt-val-${idx}`), 'icon-box', {
          _ia_field: 'about.values',
          selected_icon: { value: 'fas fa-star', library: 'fa-solid' },
          title_text: v?.title || '',
          description_text: v?.description || '',
          position: 'top',
          title_size: 'h4',
        }),
      })),
    }));
  }

  return sectionContainer({ id: mintId(seedId, 'abt-sec'), elements });
}

function faq(block, brand, seedId) {
  const items = (Array.isArray(block.faqs) ? block.faqs : []).map((f, idx) => ({
    _id: mintId(seedId, `faq-item-${idx}`),
    tab_title: f?.question || '',
    tab_content: `<p>${escapeHtml(f?.answer)}</p>`,
  }));
  return sectionContainer({
    id: mintId(seedId, 'faq-sec'),
    elements: [
      ...headingWidgets(block, seedId, 'faq', 'faq'),
      widget(mintId(seedId, 'faq-acc'), 'accordion', {
        _ia_field: 'faq.items', tabs: items, title_html_tag: 'h3',
      }),
    ],
  });
}

function gallery(block, brand, seedId) {
  const images = Array.isArray(block.images) ? block.images : [];
  return sectionContainer({
    id: mintId(seedId, 'gal-sec'),
    elements: [
      ...headingWidgets(block, seedId, 'gal', 'gallery'),
      widget(mintId(seedId, 'gal-grid'), 'image-gallery', {
        _ia_field: 'gallery.items',
        gallery: images.map((img, idx) => ({
          id: img?.id === '' || img?.id == null ? '' : img.id,
          url: img?.url || '',
          _meta_idx: idx,
        })),
        gallery_columns: images.length <= 6 ? 3 : 4,
        gallery_link: 'file',
        image_size: 'medium_large',
        ia_gallery_meta: images.map((img) => ({
          alt: img?.alt || '', caption: img?.caption || '', category: img?.category || '',
        })),
      }),
    ],
  });
}

function pricing(block, brand, seedId) {
  const plans = Array.isArray(block.plans) ? block.plans : [];
  const w = cardWidth(plans.length);
  return sectionContainer({
    id: mintId(seedId, 'price-sec'),
    elements: [
      ...headingWidgets(block, seedId, 'price', 'pricing'),
      rowContainer({
        id: mintId(seedId, 'price-row'),
        elements: plans.map((plan, idx) => cardContainer({
          id: mintId(seedId, `price-card-${idx}`),
          widthPercent: w,
          element: widget(mintId(seedId, `price-plan-${idx}`), 'text-editor', {
            _ia_field: 'pricing.plans', editor: encodePricingCard(plan), align: 'center',
          }),
        })),
      }),
    ],
  });
}

function team(block, brand, seedId) {
  const members = Array.isArray(block.members) ? block.members : [];
  const w = cardWidth(members.length);
  return sectionContainer({
    id: mintId(seedId, 'team-sec'),
    elements: [
      ...headingWidgets(block, seedId, 'team', 'team'),
      rowContainer({
        id: mintId(seedId, 'team-row'),
        elements: members.map((person, idx) => cardContainer({
          id: mintId(seedId, `team-card-${idx}`),
          widthPercent: w,
          element: widget(mintId(seedId, `team-member-${idx}`), 'image-box', {
            _ia_field: 'team.members',
            image: {
              url: person?.photo_url || '',
              id: person?.photo_id === '' || person?.photo_id == null ? '' : person.photo_id,
              alt: person?.photo_alt || '',
            },
            title_text: person?.name || '',
            description_text: person?.role || '',
            position: 'top',
            title_size: 'h3',
          }),
        })),
      }),
    ],
  });
}

function stats(block, brand, seedId) {
  const items = Array.isArray(block.stats) ? block.stats : [];
  const w = cardWidth(items.length);
  return sectionContainer({
    id: mintId(seedId, 'stat-sec'),
    elements: [
      ...headingWidgets(block, seedId, 'stat', 'stats'),
      rowContainer({
        id: mintId(seedId, 'stat-row'),
        elements: items.map((stat, idx) => cardContainer({
          id: mintId(seedId, `stat-card-${idx}`),
          widthPercent: w,
          element: widget(mintId(seedId, `stat-num-${idx}`), 'counter', {
            _ia_field: 'stats.items',
            starting_number: 0,
            ending_number: stat?.value ?? '',
            prefix: stat?.prefix || '',
            suffix: stat?.suffix || '',
            title: stat?.label || '',
          }),
        })),
      }),
    ],
  });
}

/**
 * Contact — the one archetype that can REFUSE to be built.
 *
 * A form with no recipient collects enquiries nobody ever reads, so the caller
 * hands us the resolved address and we throw when there is none. That throw is
 * `elementorAdapter.FormRecipientError`, raised there rather than here so the
 * error type keeps one home.
 */
function contact(block, brand, seedId, { emailTo, formCssClass }) {
  const methodIcon = (k) => ({
    phone: 'fas fa-phone',
    email: 'fas fa-envelope',
    address: 'fas fa-map-marker-alt',
    social: 'fas fa-share-alt',
  }[k] || 'fas fa-circle');

  const methods = (Array.isArray(block.contact_methods) ? block.contact_methods : []).map((m, idx) => ({
    _id: mintId(seedId, `ctc-m-${idx}`),
    text: `${m?.label || ''}: ${m?.value || ''}`,
    selected_icon: { value: methodIcon(m?.kind), library: 'fa-solid' },
    link: { url: m?.href || '', is_external: m?.kind === 'social' || m?.kind === 'address' ? 'on' : '', nofollow: '' },
  }));

  const fields = (block.form_config?.fields || []).map((label, idx) => {
    const fieldType = inferFieldType(label);
    return {
      _id: mintId(seedId, `ctc-f-${idx}`),
      custom_id: fieldId(label, idx),
      field_type: fieldType,
      field_label: label,
      placeholder: '',
      required: fieldType === 'textarea' ? '' : 'true',
      width: '100',
    };
  });

  return sectionContainer({
    id: mintId(seedId, 'ctc-sec'),
    elements: [
      ...headingWidgets(block, seedId, 'ctc', 'contact'),
      rowContainer({
        id: mintId(seedId, 'ctc-row'),
        settings: { flex_gap: px(40), flex_align_items: 'flex-start' },
        elements: [
          cardContainer({
            id: mintId(seedId, 'ctc-methods-col'),
            widthPercent: 48,
            element: widget(mintId(seedId, 'ctc-methods'), 'icon-list', {
              _ia_field: 'contact.methods',
              icon_list: methods,
              view: 'traditional',
              space_between: px(16),
            }),
          }),
          cardContainer({
            id: mintId(seedId, 'ctc-form-col'),
            widthPercent: 48,
            element: widget(mintId(seedId, 'ctc-form'), 'form', {
              _ia_field: 'contact.form',
              form_name: 'Contact',
              form_css_class: formCssClass,
              form_fields: fields,
              button_text: block.form_config?.submit_text || 'Send message',
              button_size: 'md',
              button_align: 'left',
              email_to: emailTo,
              email_subject: `New message from ${brand?.business_name || 'your website'}`,
            }),
          }),
        ],
      }),
    ],
  });
}

/**
 * The free section — words, pictures, buttons and video in 1–3 columns.
 *
 * Its inside is built by `sectionSchema.buildContentRow`, which is also what
 * `applyFields` calls when the author edits one. ONE implementation, so a
 * section that has been edited and one that has just been added are the same
 * shape — and the round-trip test can assert equality rather than similarity.
 */
function content(block, brand, seedId) {
  return sectionContainer({
    id: mintId(seedId, 'content-sec'),
    settings: {
      // Marks the section as ours even before a single block is added, so an
      // empty one reads back as a free section and not as somebody's custom
      // Elementor work (reduceToSectionList).
      _ia_field_section: 'content.blocks',
      padding: pad(48, 20, 48, 20),
    },
    elements: [buildContentRow(
      { layout: block?.layout ?? 1, blocks: Array.isArray(block?.blocks) ? block.blocks : [] },
      null,
      mintId(seedId, 'content'),
    )],
  });
}

/** Wired once by elementorAdapter at import time. One implementation, shared. */
export function useFormFieldHelpers({ inferFormFieldType, formFieldId }) {
  inferFieldType = inferFormFieldType;
  fieldId = formFieldId;
}

/* ══════════════════════════════════════════════════════════════════════════
   The registry
   ══════════════════════════════════════════════════════════════════════════ */

export const CONTAINER_EMITTERS = Object.freeze({
  hero, services, testimonials, cta, about, faq, gallery, pricing, team, stats, contact, content,
});

export function listContainerKinds() {
  return Object.keys(CONTAINER_EMITTERS).sort();
}

export const __test__ = { pad, px, headingWidgets, backgroundFor };
