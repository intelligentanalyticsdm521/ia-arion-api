// lib/contentAgent/carouselRenderer.js
//
// Task 5 — the social carousel body-slide renderer. This is the ARION Roadmap
// v0.5 milestone itself, generalised from "IA's Pillow script" to "any tenant's
// brand tokens".
//
// WHY PLAYWRIGHT AND NOT PILLOW
//
// The manual workflow used a Python/Pillow script. This repo is Node, and
// shipping a Python sidecar into app-arion-api-prod for one job would add a
// runtime to the deployment for no capability gain. Playwright is ALREADY a
// dependency of this repo, and chromium's text layout beats hand-placed Pillow
// text at everything the slides need (wrapping, kerning, emoji, web fonts). So
// slides are laid out as HTML with the tenant's brand tokens and screenshotted
// at exactly 1080x1350 (the 4:5 portrait feed size).
//
// BRAND TOKENS COME FROM THE TENANT — colors/fonts from their style profile's
// brand_tokens_json (12.12), with a deliberately neutral fallback. One tenant's
// tokens can never leak into another's render because the tokens travel with
// the profile, which is tenant-isolated at the schema.
//
// F7 — "bad image-prompt render": up to 3 attempts (Rule 21.4), then the unit
// is flagged for manual rendering rather than failing the run. A missing
// asset is a visible gap in the queue; a failed run is a missing week.

import { chromium } from 'playwright';
import { storeAsset } from './assetStore.js';

export const SLIDE_W = 1080;
export const SLIDE_H = 1350;
export const MAX_RENDER_ATTEMPTS = 3; // Rule 21.4
export const MAX_SLIDES = 10;         // platform carousel cap

export const DEFAULT_TOKENS = {
  bg: '#0B1C24',
  fg: '#FFFFFF',
  accent: '#4FD1C5',
  fontFamily: "Segoe UI, -apple-system, Roboto, Helvetica, Arial, sans-serif",
  logoText: '',
};

/** Escape for embedding tenant copy into slide HTML. */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One slide's HTML. Layout is deliberately simple and typographic — the
 * carousel format that has worked is big statement + supporting line, not
 * clip-art. Tokens drive every color and face.
 */
export function slideHtml({ heading, body, index, total, tokens = {} }) {
  const t = { ...DEFAULT_TOKENS, ...tokens };
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${SLIDE_W}px; height: ${SLIDE_H}px; }
  body {
    background: ${t.bg}; color: ${t.fg};
    font-family: ${t.fontFamily};
    display: flex; flex-direction: column; justify-content: space-between;
    padding: 96px 88px;
  }
  .rule { width: 120px; height: 8px; background: ${t.accent}; border-radius: 4px; }
  h1 { font-size: 72px; line-height: 1.15; font-weight: 700; margin-top: 48px; }
  p  { font-size: 40px; line-height: 1.45; margin-top: 40px; opacity: .92; }
  footer { display: flex; justify-content: space-between; align-items: center;
           font-size: 30px; opacity: .75; }
  .idx { color: ${t.accent}; font-weight: 600; }
  </style></head><body>
    <div>
      <div class="rule"></div>
      <h1>${esc(heading)}</h1>
      ${body ? `<p>${esc(body)}</p>` : ''}
    </div>
    <footer>
      <span>${esc(t.logoText)}</span>
      <span class="idx">${index + 1} / ${total}</span>
    </footer>
  </body></html>`;
}

/**
 * Split carousel copy into slides. Accepts either a pre-structured slides array
 * (from the drafting JSON) or a markdown body whose H2 sections become slides.
 */
export function planSlides(draft) {
  if (Array.isArray(draft.slides) && draft.slides.length) {
    return draft.slides.slice(0, MAX_SLIDES).map((s) => ({
      heading: String(s.heading || s.title || '').slice(0, 120),
      body: String(s.body || '').slice(0, 300),
    }));
  }
  const md = String(draft.body_markdown || '');
  // Only text FROM the first H2 onward becomes slides. Preface copy before it
  // is the post's caption material, not a slide — without this cut, an intro
  // paragraph gets typeset as a 72px headline (found by test, 2026-08-24).
  const firstH2 = md.search(/^##\s+/m);
  const sections = firstH2 === -1 ? [] : md.slice(firstH2).split(/^##\s+/m).filter((x) => x.trim());
  if (sections.length > 0) {
    return sections.slice(0, MAX_SLIDES).map((sec) => {
      const [first, ...rest] = sec.split('\n');
      return { heading: first.trim().slice(0, 120), body: rest.join(' ').trim().slice(0, 300) };
    });
  }
  // single-thought fallback: title slide + body slide
  return [
    { heading: String(draft.title || '').slice(0, 120), body: '' },
    { heading: '', body: md.slice(0, 300) },
  ].filter((s) => s.heading || s.body);
}

/**
 * Render every slide to PNG and store them. Returns asset paths.
 *
 * @throws only after MAX_RENDER_ATTEMPTS full failures — the caller converts
 *         that into an F7 manual-fallback flag, not a run failure.
 */
export async function renderCarousel({
  tenantId, outputId, draft, tokens = {},
  store = storeAsset, launch = () => chromium.launch({ headless: true }),
}) {
  const slides = planSlides(draft);
  if (!slides.length) return { assetPaths: [], slides: 0 };

  let lastErr;
  for (let attempt = 1; attempt <= MAX_RENDER_ATTEMPTS; attempt += 1) {
    let browser;
    try {
      browser = await launch();
      const page = await browser.newPage({ viewport: { width: SLIDE_W, height: SLIDE_H } });
      const assetPaths = [];
      for (let i = 0; i < slides.length; i += 1) {
        await page.setContent(slideHtml({ ...slides[i], index: i, total: slides.length }), { waitUntil: 'networkidle' });
        const buffer = await page.screenshot({ type: 'png' });
        const path = await store({
          tenantId, outputId, name: `slide-${String(i + 1).padStart(2, '0')}.png`, buffer,
        });
        assetPaths.push(path);
      }
      await browser.close();
      return { assetPaths, slides: slides.length, attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (browser) await browser.close().catch(() => {});
    }
  }
  const e = new Error(`[carouselRenderer] render failed after ${MAX_RENDER_ATTEMPTS} attempts: ${lastErr?.message}`);
  e.code = 'render_failed';
  e.failureMode = 'F7';
  throw e;
}

export default { SLIDE_W, SLIDE_H, MAX_RENDER_ATTEMPTS, MAX_SLIDES, DEFAULT_TOKENS, esc, slideHtml, planSlides, renderCarousel };
