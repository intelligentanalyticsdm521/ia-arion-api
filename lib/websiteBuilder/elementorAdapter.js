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
