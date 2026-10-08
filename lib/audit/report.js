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
// ONE REPORT, TWO PAINTERS. `reportModel` decides every word, number and
// colour once; `renderReportHtml` paints it as a page and `renderPdf` paints
// the same model onto Letter paper with pdfkit (Helvetica, the fonts pdfkit
// ships). No browser: the production App Service has none, and the PDF must be
// paintable wherever node runs. pdfkit fetches nothing — the logo arrives
// already embedded as a data: URI, fetched through the SSRF guard by the
// runner, and only PNG and JPEG are drawn (what pdfkit can embed); any other
// logo is left off and the agency's name still heads the page.

import PDFDocument from 'pdfkit';

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
export const NEUTRAL = { primary: '#1f2937', secondary: '#4b5563', accent: '#2563eb', text: '#111827', background: '#ffffff' };

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

const LOGO_RE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

/**
 * THE REPORT, DECIDED ONCE. Both painters read this and nothing else, so the
 * page and the paper cannot say different things.
 *
 * @param {object} p
 * @param {object} p.business   { name, phone?, website?, colours? }
 * @param {string|null} p.logoDataUri  already-embedded logo, or null
 * @param {object} p.visitor    { business? }
 * @param {string} p.url        the website that was checked
 * @param {object} p.result     scoreAudit() output
 * @param {Date}   [p.now]
 */
export function reportModel({ business = {}, logoDataUri = null, visitor = {}, url, result, now = new Date() } = {}) {
  const colours = brandColours(business?.colours);
  const host = (() => { try { return new URL(url).host; } catch { return String(url || ''); } })();
  const subject = visitor?.business ? String(visitor.business) : host;
  const score = result?.score ?? null;
  const findings = (result?.topFindings || []).map(String);
  return {
    colours,
    agency: String(business?.name || '').trim(),
    host,
    subject,
    title: `Website check for ${subject}`,
    date: utcDayWords(now),
    score,
    scoreColour: barColour(score, colours),
    sentence: result?.sentence || "We couldn't score this website this time.",
    sections: (result?.sections || []).map((s) => ({
      label: String(s.label ?? ''), score: s.score ?? null, verdict: String(s.verdict ?? ''), colour: barColour(s.score, colours),
    })),
    findingsHeading: findings.length ? fixFirstHeading(findings.length) : null,
    findings,
    notes: (result?.notes || []).map(String),
    contact: [business?.phone, displayWebsite(business?.website)].filter(Boolean).map(String),
    logo: typeof logoDataUri === 'string' && LOGO_RE.test(logoDataUri) ? logoDataUri : null,
  };
}

/** The report as a page (same arguments as reportModel). */
export function renderReportHtml(p) {
  const m = reportModel(p);
  const c = m.colours;
  const rows = m.sections.map((s) => `
      <tr>
        <td class="label">${escapeHtml(s.label)}</td>
        <td class="bar"><div class="track"><div class="fill" style="width:${s.score ?? 0}%;background:${s.colour}"></div></div></td>
        <td class="num">${s.score == null ? '—' : escapeHtml(s.score)}</td>
        <td class="verdict">${escapeHtml(s.verdict)}</td>
      </tr>`).join('');
  const findings = m.findings.map((f) => `<li>${escapeHtml(f)}</li>`).join('');
  const notes = m.notes.map((n) => `<p class="note">${escapeHtml(n)}</p>`).join('');
  const contact = m.contact.map(escapeHtml).join(' · ');
  const logo = m.logo ? `<img class="logo" src="${m.logo}" alt="">` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(m.title)}</title>
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
  .score { width: 96px; height: 96px; border-radius: 50%; border: 6px solid ${m.scoreColour}; display: flex; align-items: center; justify-content: center; font-size: 30pt; font-weight: 700; }
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
  <header>${logo}<div class="agency">${escapeHtml(m.agency)}</div></header>
  <h1>${escapeHtml(m.title)}</h1>
  <p class="date">${escapeHtml(m.host)} · ${escapeHtml(m.date)}</p>
  <div class="big">
    <div class="score">${m.score == null ? '—' : escapeHtml(m.score)}</div>
    <div class="sentence">${escapeHtml(m.sentence)}</div>
  </div>
  <table>${rows}</table>
  ${findings ? `<h2>${escapeHtml(m.findingsHeading)}</h2><ul>${findings}</ul>` : ''}
  ${notes}
  <footer>Prepared by <strong>${escapeHtml(m.agency)}</strong>${contact ? ` · ${contact}` : ''}</footer>
</body></html>`;
}

// ---- the paper --------------------------------------------------------------
// The same layout as the page: header (logo + agency) over a rule in the
// agency's primary colour, the title and date, the score ring beside the
// sentence, one row per section (label, bar, number, verdict), the findings,
// the notes, then "Prepared by <agency>". One Letter page when it fits; a row
// or a finding that would cross the bottom starts the next page instead.

const MARGIN = 44; // 0.6in, as the page's @page rule
const RULE = '#e5e7eb';
const TRACK = '#f3f4f6';

function ensureRoom(pdf, needed) {
  if (pdf.y + needed > pdf.page.height - pdf.page.margins.bottom) pdf.addPage();
}

/** The logo as pdfkit can draw it (PNG or JPEG), or null. */
function logoImage(pdf, dataUri) {
  if (!dataUri || !/^data:image\/(?:png|jpeg);base64,/.test(dataUri)) return null;
  try { return pdf.openImage(Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64')); } catch { return null; }
}

/**
 * The report as a Letter PDF, painted with pdfkit.
 *
 * @param {object} p  the same object renderReportHtml takes (reportModel's arguments)
 * @returns {Promise<Buffer>}
 */
export async function renderPdf(p) {
  if (!p || typeof p !== 'object') throw new TypeError('renderPdf paints the report (the object renderReportHtml takes), not HTML');
  const m = reportModel(p);
  const c = m.colours;
  const maker = m.agency || 'Website check';
  const pdf = new PDFDocument({
    size: 'LETTER', margin: MARGIN,
    // pdfkit signs every file "PDFKit" unless told otherwise: the agency's name, never a tool's.
    info: { Title: m.title, Author: maker, Creator: maker, Producer: maker },
  });
  const chunks = [];
  pdf.on('data', (b) => chunks.push(b));
  const done = new Promise((resolve, reject) => { pdf.on('end', () => resolve(Buffer.concat(chunks))); pdf.on('error', reject); });

  const plainWhite = /^#(?:fff|ffffff)$/i.test(c.background);
  const paintBackground = () => {
    if (plainWhite) return;
    pdf.save().rect(0, 0, pdf.page.width, pdf.page.height).fill(c.background).restore();
  };
  paintBackground();
  pdf.on('pageAdded', paintBackground);

  const x = MARGIN;
  const W = pdf.page.width - MARGIN * 2;

  // Header: logo, then the agency's name, over a 3pt rule in the primary colour.
  const img = logoImage(pdf, m.logo);
  const top = MARGIN;
  let nameX = x;
  let headH = 0;
  if (img) {
    const scale = Math.min(1, 160 / img.width, 48 / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    pdf.image(img, x, top, { width: w, height: h });
    nameX = x + w + 14;
    headH = h;
  }
  pdf.font('Helvetica-Bold').fontSize(16);
  const nameH = m.agency ? pdf.heightOfString(m.agency, { width: x + W - nameX }) : 0;
  headH = Math.max(headH, nameH, 16);
  if (m.agency) pdf.fillColor(c.primary).text(m.agency, nameX, top + (headH - nameH) / 2, { width: x + W - nameX });
  const ruleY = top + headH + 12;
  pdf.moveTo(x, ruleY).lineTo(x + W, ruleY).lineWidth(3).strokeColor(c.primary).stroke();

  // Title and date.
  pdf.font('Helvetica-Bold').fontSize(20).fillColor(c.text).text(m.title, x, ruleY + 18, { width: W });
  pdf.moveDown(0.15);
  pdf.font('Helvetica').fontSize(11).fillColor(c.secondary).text(`${m.host} · ${m.date}`, x, pdf.y, { width: W });

  // The score ring beside the sentence.
  const D = 96;
  const ringTop = pdf.y + 16;
  const cx = x + D / 2;
  const cy = ringTop + D / 2;
  pdf.circle(cx, cy, D / 2 - 3).lineWidth(6).strokeColor(m.scoreColour).stroke();
  const big = m.score == null ? '—' : String(m.score);
  pdf.font('Helvetica-Bold').fontSize(30).fillColor(c.text);
  pdf.text(big, x, cy - pdf.heightOfString(big, { width: D }) / 2 + 2, { width: D, align: 'center', lineBreak: false });
  const sx = x + D + 18;
  const sw = W - D - 18;
  pdf.font('Helvetica-Bold').fontSize(14);
  const sh = pdf.heightOfString(m.sentence, { width: sw });
  pdf.fillColor(c.text).text(m.sentence, sx, cy - sh / 2, { width: sw });
  pdf.y = Math.max(ringTop + D, cy + sh / 2) + 18;

  // One row per section: label | bar | number | verdict, a hairline under each.
  const col = { label: W * 0.28, bar: W * 0.26, num: W * 0.07 };
  const pad = 6;
  const verdictW = W - col.label - col.bar - col.num - pad * 2;
  for (const s of m.sections) {
    pdf.font('Helvetica-Bold').fontSize(11);
    const lh = pdf.heightOfString(s.label, { width: col.label - pad * 2 });
    pdf.font('Helvetica').fontSize(10);
    const vh = pdf.heightOfString(s.verdict, { width: verdictW });
    const h = Math.max(lh, vh, 12) + 14;
    ensureRoom(pdf, h);
    const y = pdf.y;
    const mid = y + h / 2;
    pdf.font('Helvetica-Bold').fontSize(11).fillColor(c.text).text(s.label, x + pad, mid - lh / 2, { width: col.label - pad * 2 });
    const bx = x + col.label + pad;
    const bw = col.bar - pad * 2;
    pdf.roundedRect(bx, mid - 5, bw, 10, 5).fill(TRACK);
    const fill = Math.max(0, Math.min(100, Number(s.score) || 0));
    if (fill > 0) pdf.roundedRect(bx, mid - 5, Math.max(10, (bw * fill) / 100), 10, 5).fill(s.colour);
    pdf.font('Helvetica-Bold').fontSize(11).fillColor(c.text)
      .text(s.score == null ? '—' : String(s.score), x + col.label + col.bar, mid - 6, { width: col.num, align: 'right', lineBreak: false });
    pdf.font('Helvetica').fontSize(10).fillColor(c.secondary)
      .text(s.verdict, x + col.label + col.bar + col.num + pad * 2, mid - vh / 2, { width: verdictW });
    pdf.moveTo(x, y + h).lineTo(x + W, y + h).lineWidth(1).strokeColor(RULE).stroke();
    pdf.y = y + h;
  }
  pdf.y += 16;

  // The findings.
  if (m.findings.length) {
    ensureRoom(pdf, 50);
    pdf.font('Helvetica-Bold').fontSize(13).fillColor(c.primary).text(m.findingsHeading, x, pdf.y, { width: W });
    pdf.moveDown(0.3);
    for (const f of m.findings) {
      pdf.font('Helvetica').fontSize(11);
      const fh = pdf.heightOfString(f, { width: W - 18 });
      ensureRoom(pdf, fh + 6);
      const y = pdf.y;
      pdf.fillColor(c.text).text('•', x + 4, y, { width: 12, lineBreak: false });
      pdf.text(f, x + 18, y, { width: W - 18 });
      pdf.y = y + fh + 6;
    }
    pdf.y += 8;
  }

  // The notes.
  for (const n of m.notes) {
    pdf.font('Helvetica-Oblique').fontSize(11);
    ensureRoom(pdf, pdf.heightOfString(n, { width: W }) + 8);
    pdf.fillColor(c.secondary).text(n, x, pdf.y, { width: W });
    pdf.moveDown(0.5);
  }

  // Prepared by <agency> · phone · website
  ensureRoom(pdf, 40);
  pdf.y += 12;
  pdf.moveTo(x, pdf.y).lineTo(x + W, pdf.y).lineWidth(1).strokeColor(RULE).stroke();
  pdf.y += 10;
  const tail = m.contact.length ? ` · ${m.contact.join(' · ')}` : '';
  pdf.font('Helvetica').fontSize(11).fillColor(c.secondary).text('Prepared by ', x, pdf.y, { width: W, continued: true });
  pdf.font('Helvetica-Bold').fillColor(c.primary).text(m.agency, { continued: Boolean(tail) });
  if (tail) pdf.font('Helvetica').fillColor(c.secondary).text(tail);

  pdf.end();
  return done;
}

export default { reportModel, renderReportHtml, renderPdf, brandColours, escapeHtml, utcDayWords, NEUTRAL };
