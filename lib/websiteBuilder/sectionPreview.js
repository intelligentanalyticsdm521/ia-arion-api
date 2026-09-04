/**
 * Preview renderer — a section list rendered to plain HTML, server side,
 * without touching the customer's website.
 * ---------------------------------------------------------------------------
 * The Preview button has to answer one question honestly: "what will this say
 * once I publish?" It is NOT a pixel-accurate render of the live theme — we do
 * not run Elementor here and we never will — so the output states plainly that
 * the site's own styling is applied on publish. Anything more would be a
 * promise the preview cannot keep.
 *
 * Nothing in this file performs I/O. Preview never writes (SCOPE §3.5, T4).
 */

import { sectionKindMeta, FORM_PURPOSES } from './sectionSchema.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) and site-relative image sources make it into the preview. */
function safeImg(url) {
  const v = String(url == null ? '' : url).trim();
  return /^(https?:\/\/|\/)/i.test(v) ? v : '';
}

function safeHref(url) {
  const v = String(url == null ? '' : url).trim();
  return /^(https?:\/\/|mailto:|tel:|\/|#)/i.test(v) ? v : '#';
}

function list(v) {
  return Array.isArray(v) ? v : [];
}

function heading(f) {
  const bits = [`<h2 class="ia-h">${esc(f.headline)}</h2>`];
  if (f.subheadline) bits.push(`<p class="ia-sub">${esc(f.subheadline)}</p>`);
  return bits.join('\n');
}

const RENDERERS = {
  hero(f) {
    const img = safeImg(f.image_url);
    return `
      <div class="ia-hero"${img ? ` style="background-image:url('${esc(img)}')"` : ''}>
        <h1 class="ia-h1">${esc(f.headline)}</h1>
        ${f.subheadline ? `<p class="ia-sub">${esc(f.subheadline)}</p>` : ''}
        ${f.cta_text ? `<a class="ia-btn" href="${esc(safeHref(f.cta_href))}">${esc(f.cta_text)}</a>` : ''}
      </div>`;
  },

  services(f) {
    const cards = list(f.services).map((s) => `
      <div class="ia-card">
        <div class="ia-card-title">${esc(s?.title)}</div>
        <div class="ia-card-body">${esc(s?.description)}</div>
      </div>`).join('');
    return `${heading(f)}<div class="ia-grid">${cards}</div>`;
  },

  testimonials(f) {
    const cards = list(f.testimonials).map((t) => `
      <div class="ia-card">
        <div class="ia-stars">${'&#9733;'.repeat(Math.max(1, Math.min(5, Number(t?.rating) || 5)))}</div>
        <blockquote class="ia-quote">${esc(t?.quote)}</blockquote>
        <div class="ia-card-body"><strong>${esc(t?.attribution)}</strong><br>${esc(t?.role)}</div>
      </div>`).join('');
    return `${heading(f)}<div class="ia-grid">${cards}</div>`;
  },

  cta(f) {
    const buttons = [];
    if (f.primary_cta_text) buttons.push(`<a class="ia-btn" href="${esc(safeHref(f.primary_cta_href))}">${esc(f.primary_cta_text)}</a>`);
    if (f.secondary_cta_text) buttons.push(`<a class="ia-btn ia-btn-ghost" href="${esc(safeHref(f.secondary_cta_href))}">${esc(f.secondary_cta_text)}</a>`);
    return `
      <div class="ia-band">
        <h2 class="ia-h">${esc(f.headline)}</h2>
        ${f.subheadline ? `<p class="ia-sub">${esc(f.subheadline)}</p>` : ''}
        <div class="ia-btn-row">${buttons.join('')}</div>
      </div>`;
  },

  about(f) {
    const img = safeImg(f.image_url);
    const story = list(f.story_paragraphs).map((p) => `<p>${esc(p)}</p>`).join('');
    const values = list(f.values).map((v) => `
      <div class="ia-card">
        <div class="ia-card-title">${esc(v?.title)}</div>
        <div class="ia-card-body">${esc(v?.description)}</div>
      </div>`).join('');
    return `
      <div class="ia-split">
        <div class="ia-split-media">${img
          ? `<img src="${esc(img)}" alt="${esc(f.image_alt)}">`
          : '<div class="ia-img-empty">No picture chosen yet</div>'}</div>
        <div class="ia-split-copy">${heading(f)}${story}</div>
      </div>
      ${values ? `<div class="ia-grid">${values}</div>` : ''}`;
  },

  faq(f) {
    const rows = list(f.faqs).map((q) => `
      <div class="ia-faq">
        <div class="ia-faq-q">${esc(q?.question)}</div>
        <div class="ia-faq-a">${esc(q?.answer)}</div>
      </div>`).join('');
    return `${heading(f)}${rows}`;
  },

  gallery(f) {
    const tiles = list(f.images).map((im) => {
      const src = safeImg(im?.url);
      return `<figure class="ia-tile">${src
        ? `<img src="${esc(src)}" alt="${esc(im?.alt)}">`
        : '<div class="ia-img-empty">Picture missing</div>'}
        ${im?.caption ? `<figcaption>${esc(im.caption)}</figcaption>` : ''}
      </figure>`;
    }).join('');
    return `${heading(f)}<div class="ia-tiles">${tiles}</div>`;
  },

  contact(f) {
    const methods = list(f.contact_methods).map((m) => `
      <li><span class="ia-method-label">${esc(m?.label)}</span> ${esc(m?.value)}</li>`).join('');
    const fields = list(f.form_fields).map((label) => `
      <label class="ia-field"><span>${esc(label)}</span><span class="ia-input"></span></label>`).join('');
    const purpose = FORM_PURPOSES.find((p) => p.value === f.form_purpose);
    return `
      ${heading(f)}
      <div class="ia-split">
        <div class="ia-split-copy"><ul class="ia-methods">${methods}</ul></div>
        <div class="ia-split-copy">
          <div class="ia-form">${fields}
            <span class="ia-btn">${esc(f.submit_text || 'Send')}</span>
          </div>
          <p class="ia-note">Filed as <strong>${esc(purpose ? purpose.label : 'General enquiry')}</strong>,
          emailed to <strong>${esc(f.email_to || 'nobody yet')}</strong>.</p>
        </div>
      </div>`;
  },
};

function renderCustom(entry) {
  return `
    <div class="ia-custom">
      <div class="ia-custom-title">Custom section — built on the site</div>
      <p class="ia-note">This one was made in the website itself, so it is shown here exactly as it is
      and saved back untouched.</p>
    </div>`;
}

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; font: 15px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         color: var(--ia-ink); background: #fff; }
  .ia-page { max-width: 900px; margin: 0 auto; padding: 0 0 48px; }
  .ia-banner { background:#F1F5F9; border-bottom:1px solid #E2E8F0; color:#475569;
               font-size:12px; padding:10px 16px; text-align:center; }
  .ia-section { padding: 28px 16px; border-bottom: 1px solid #EEF2F6; }
  .ia-section:last-child { border-bottom: 0; }
  .ia-h1 { font-size: 30px; margin: 0 0 10px; line-height: 1.2; }
  .ia-h { font-size: 22px; margin: 0 0 8px; }
  .ia-sub { color:#475569; margin: 0 0 14px; }
  .ia-hero { background: var(--ia-primary); background-size: cover; background-position: center;
             color:#fff; border-radius: 10px; padding: 40px 24px; text-align:center; }
  .ia-hero .ia-sub { color: rgba(255,255,255,.88); }
  .ia-band { background: var(--ia-primary); color:#fff; border-radius:10px; padding:28px 20px; text-align:center; }
  .ia-band .ia-sub { color: rgba(255,255,255,.88); }
  .ia-btn { display:inline-block; background: var(--ia-accent); color:#0F172A; text-decoration:none;
            font-weight:600; padding:10px 18px; border-radius:6px; margin:4px; }
  .ia-btn-ghost { background: transparent; color: inherit; border:1px solid currentColor; }
  .ia-btn-row { margin-top: 8px; }
  .ia-grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap:12px; }
  .ia-card { border:1px solid #E2E8F0; border-radius:8px; padding:14px; }
  .ia-card-title { font-weight:600; margin-bottom:6px; }
  .ia-card-body { color:#475569; font-size:14px; }
  .ia-quote { margin:0 0 8px; font-style:italic; }
  .ia-stars { color:#F59E0B; letter-spacing:2px; }
  .ia-split { display:grid; grid-template-columns: 1fr 1fr; gap:18px; align-items:start; }
  .ia-split img { width:100%; border-radius:8px; display:block; }
  .ia-img-empty { background:#F1F5F9; border:1px dashed #CBD5E1; border-radius:8px; color:#64748B;
                  font-size:13px; padding:32px 12px; text-align:center; }
  .ia-tiles { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px,1fr)); gap:10px; }
  .ia-tile { margin:0; }
  .ia-tile img { width:100%; border-radius:6px; display:block; }
  .ia-tile figcaption { font-size:12px; color:#64748B; padding-top:4px; }
  .ia-faq { border-top:1px solid #EEF2F6; padding:10px 0; }
  .ia-faq-q { font-weight:600; }
  .ia-faq-a { color:#475569; font-size:14px; }
  .ia-methods { list-style:none; margin:0; padding:0; }
  .ia-methods li { padding:6px 0; border-bottom:1px solid #EEF2F6; font-size:14px; }
  .ia-method-label { color:#64748B; }
  .ia-form { border:1px solid #E2E8F0; border-radius:8px; padding:14px; }
  .ia-field { display:block; margin-bottom:10px; font-size:13px; color:#475569; }
  .ia-input { display:block; height:32px; border:1px solid #CBD5E1; border-radius:5px; background:#fff; margin-top:4px; }
  .ia-note { color:#64748B; font-size:12px; }
  .ia-custom { background:#F8FAFC; border:1px dashed #CBD5E1; border-radius:8px; padding:16px; }
  .ia-custom-title { font-weight:600; color:#334155; }
  @media (max-width: 640px) { .ia-split { grid-template-columns: 1fr; } .ia-h1 { font-size: 24px; } }
`;

/**
 * Render a section list to a standalone HTML document.
 *
 * @param {Array<{kind:string|null, fields:object|null}>} sections
 * @param {object} [brand]  brandContext — colours only
 * @param {object} [opts]
 * @param {string} [opts.pageTitle]
 * @returns {string} a complete HTML document
 */
export function renderSectionListHtml(sections, brand = {}, opts = {}) {
  const body = (Array.isArray(sections) ? sections : []).map((entry) => {
    const kind = entry?.kind;
    const renderer = kind && sectionKindMeta(kind) ? RENDERERS[kind] : null;
    const inner = renderer ? renderer(entry.fields || {}) : renderCustom(entry);
    return `<section class="ia-section">${inner}</section>`;
  }).join('\n');

  const primary = /^#[0-9a-f]{3,8}$/i.test(String(brand?.primary_color || '')) ? brand.primary_color : '#1A3A4A';
  const accent = /^#[0-9a-f]{3,8}$/i.test(String(brand?.accent_color || '')) ? brand.accent_color : '#FEC82C';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.pageTitle || 'Preview')}</title>
<style>:root{--ia-primary:${esc(primary)};--ia-accent:${esc(accent)};--ia-ink:#0F172A;}${STYLE}</style>
</head><body>
<div class="ia-banner">Preview — this is your wording and your pictures. Your website's own styling is
applied when you publish. Nothing has been saved yet.</div>
<main class="ia-page">
${body || '<section class="ia-section"><p class="ia-note">This page has no sections yet.</p></section>'}
</main>
</body></html>`;
}

export const __test__ = { esc, safeImg, safeHref, RENDERERS };
