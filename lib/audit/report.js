// lib/audit/report.js
//
// The one-page report the visitor receives, in the AGENCY's branding
// (contract §E.5).
//
// BRANDING COMES FROM THE SIGNED REQUEST. The `business` block (name, phone,
// website, logo, colours) is what the calling side filled from the business
// profile and brand kit of the business whose action this is. This file looks
// nothing up and knows no business — which is what lets any agency's caller use
// the same tool. Colours that are not plain hex are replaced by neutral ones.
//
// NO PRICE, NO PERSON'S NAME (the agency's name only), NO VENDOR OR TOOL NAMES.
//
// THE PDF IS PAINTED OFFLINE. JavaScript is off and every network request from
// the page is refused, so nothing in the HTML can make the browser fetch an
// address (the logo arrives already embedded as a data: URI, fetched through
// the SSRF guard by the runner). The browser is always closed in `finally`.

import { chromium } from 'playwright';

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
export const NEUTRAL = { primary: '#1f2937', secondary: '#4b5563', accent: '#2563eb', text: '#111827', background: '#ffffff' };
export const PDF_TIMEOUT_MS = 30_000;

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function brandColours(colours) {
  const out = { ...NEUTRAL };
  for (const k of Object.keys(NEUTRAL)) {
    const v = colours?.[k];
    if (typeof v === 'string' && HEX_RE.test(v.trim())) out[k] = v.trim();
  }
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function utcDayWords(d = new Date()) {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function barColour(score, c) {
  if (score == null) return '#d1d5db';
  if (score >= 80) return '#15803d';
  if (score >= 50) return '#b45309';
  return '#b91c1c';
}

/** The findings heading, true to how many there are. */
export function fixFirstHeading(n) {
  if (n === 1) return 'The thing to fix first';
  if (n === 2) return 'The two things to fix first';
  return 'The three things to fix first';
}

const displayWebsite = (w) => String(w || '').replace(/^https?:\/\//i, '').replace(/\/$/, '');

/**
 * @param {object} p
 * @param {object} p.business   { name, phone?, website?, colours? }
 * @param {string|null} p.logoDataUri  already-embedded logo, or null
 * @param {object} p.visitor    { business? }
 * @param {string} p.url        the website that was checked
 * @param {object} p.result     scoreAudit() output
 * @param {Date}   [p.now]
 */
export function renderReportHtml({ business = {}, logoDataUri = null, visitor = {}, url, result, now = new Date() }) {
  const c = brandColours(business.colours);
  const host = (() => { try { return new URL(url).host; } catch { return String(url || ''); } })();
  const subject = visitor?.business ? String(visitor.business) : host;
  const name = String(business.name || '').trim();
  const score = result?.score;
  const rows = (result?.sections || []).map((s) => `
      <tr>
        <td class="label">${escapeHtml(s.label)}</td>
        <td class="bar"><div class="track"><div class="fill" style="width:${s.score ?? 0}%;background:${barColour(s.score, c)}"></div></div></td>
        <td class="num">${s.score == null ? '—' : escapeHtml(s.score)}</td>
        <td class="verdict">${escapeHtml(s.verdict)}</td>
      </tr>`).join('');
  const findings = (result?.topFindings || []).map((f) => `<li>${escapeHtml(f)}</li>`).join('');
  const notes = (result?.notes || []).map((n) => `<p class="note">${escapeHtml(n)}</p>`).join('');
  const contact = [business.phone, displayWebsite(business.website)].filter(Boolean).map(escapeHtml).join(' · ');
  const logo = typeof logoDataUri === 'string' && /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(logoDataUri)
    ? `<img class="logo" src="${logoDataUri}" alt="">` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Website check for ${escapeHtml(subject)}</title>
<style>
  @page { size: Letter; margin: 0.6in; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: ${c.text}; background: ${c.background}; font-size: 11pt; line-height: 1.4; }
  header { display: flex; align-items: center; gap: 14px; border-bottom: 3px solid ${c.primary}; padding-bottom: 12px; }
  .logo { max-height: 48px; max-width: 160px; }
  .agency { font-size: 16pt; font-weight: 700; color: ${c.primary}; }
  h1 { font-size: 20pt; margin: 18px 0 2px; color: ${c.text}; }
  .date { color: ${c.secondary}; margin: 0 0 16px; }
  .big { display: flex; align-items: center; gap: 18px; margin: 8px 0 18px; }
  .score { width: 96px; height: 96px; border-radius: 50%; border: 6px solid ${barColour(score, c)}; display: flex; align-items: center; justify-content: center; font-size: 30pt; font-weight: 700; }
  .sentence { font-size: 14pt; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  td { padding: 7px 6px; border-bottom: 1px solid #e5e7eb; vertical-align: middle; }
  td.label { width: 28%; font-weight: 600; }
  td.bar { width: 26%; }
  .track { height: 10px; background: #f3f4f6; border-radius: 5px; overflow: hidden; }
  .fill { height: 10px; border-radius: 5px; }
  td.num { width: 7%; text-align: right; font-weight: 700; }
  td.verdict { color: ${c.secondary}; font-size: 10pt; }
  h2 { font-size: 13pt; color: ${c.primary}; margin: 6px 0 6px; }
  ul { margin: 0 0 14px 18px; padding: 0; }
  li { margin-bottom: 6px; }
  .note { color: ${c.secondary}; font-style: italic; }
  footer { margin-top: 20px; border-top: 1px solid #e5e7eb; padding-top: 10px; color: ${c.secondary}; }
  footer strong { color: ${c.primary}; }
</style></head>
<body>
  <header>${logo}<div class="agency">${escapeHtml(name)}</div></header>
  <h1>Website check for ${escapeHtml(subject)}</h1>
  <p class="date">${escapeHtml(host)} · ${escapeHtml(utcDayWords(now))}</p>
  <div class="big">
    <div class="score">${score == null ? '—' : escapeHtml(score)}</div>
    <div class="sentence">${escapeHtml(result?.sentence || "We couldn't score this website this time.")}</div>
  </div>
  <table>${rows}</table>
  ${findings ? `<h2>${escapeHtml(fixFirstHeading((result?.topFindings || []).length))}</h2><ul>${findings}</ul>` : ''}
  ${notes}
  <footer>Prepared by <strong>${escapeHtml(name)}</strong>${contact ? ` · ${contact}` : ''}</footer>
</body></html>`;
}

/**
 * HTML -> PDF bytes with Playwright's Chromium. `launch` is the seam the tests
 * use to count launches and closes; real use leaves it alone.
 */
export async function renderPdf(html, { launch = () => chromium.launch({ headless: true }), timeoutMs = PDF_TIMEOUT_MS } = {}) {
  let browser = null;
  let timer = null;
  const work = (async () => {
    browser = await launch();
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.route('**/*', (route) => route.abort());
    await page.setContent(html, { waitUntil: 'networkidle', timeout: 15_000 });
    return page.pdf({ format: 'Letter', printBackground: true });
  })();
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the report took too long to make')), timeoutMs); });
    const pdf = await Promise.race([work, timeout]);
    return Buffer.from(pdf);
  } finally {
    clearTimeout(timer);
    if (browser) {
      await browser.close().catch(() => {});
    } else {
      // Timed out while still launching: close the browser as soon as it exists.
      work.catch(() => {}).finally(() => { if (browser) browser.close().catch(() => {}); });
    }
  }
}

export default { renderReportHtml, renderPdf, brandColours, escapeHtml, utcDayWords, NEUTRAL };
