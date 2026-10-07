// lib/audit/score.js
//
// Turn the facts (PageSpeed + crawl) into five section scores, an overall
// score and plain sentences a business owner reads (contract §E.4).
//
// WORDS RULE: every sentence here is about what a VISITOR experiences or what
// Google does, in everyday words. No measurement acronyms, no tool names, no
// test names — test/site-audit.test.mjs refuses them in any sentence this
// produces. Nothing is invented: a section we could not measure has no score
// and says so.

export const SECTIONS = [
  { key: 'speed', label: 'Speed', weight: 30 },
  { key: 'google', label: 'Found on Google', weight: 25 },
  { key: 'trust', label: 'Trust & security', weight: 20 },
  { key: 'phones', label: 'Works on phones', weight: 15 },
  { key: 'leads', label: 'Turns visitors into leads', weight: 10 },
];

export const BAND_WORDS = {
  good: 'This is in good shape.',
  middle: 'This is holding you back a little.',
  poor: 'This is likely costing you visitors.',
};

export const NOT_MEASURED = {
  speed: "We couldn't measure speed this time.",
  google: "We couldn't check this part this time.",
  trust: "We couldn't check this part this time.",
  phones: "We couldn't check this part this time.",
  leads: "We couldn't check this part this time.",
};

export const ROBOTS_BLOCKED_SENTENCE = 'This site asks automated tools not to read its pages, so we only checked speed and security.';

export function bandSentence(score) {
  if (score == null) return null;
  if (score >= 80) return BAND_WORDS.good;
  if (score >= 50) return BAND_WORDS.middle;
  return BAND_WORDS.poor;
}

// Speed improvements, keyed by the measurement's id, said the way a visitor
// would feel them. An id we have no words for is left out rather than shown
// under its technical title.
const SPEED_WORDS = {
  'render-blocking-resources': 'Some files hold your page up before anything shows.',
  'unused-javascript': 'Your pages load code they never use, which slows them down.',
  'unused-css-rules': 'Your pages load styling they never use, which slows them down.',
  'modern-image-formats': 'Your pictures are bigger than they need to be.',
  'uses-optimized-images': 'Your pictures are bigger than they need to be.',
  'uses-responsive-images': 'Phones are sent pictures sized for big screens.',
  'offscreen-images': 'Pictures further down the page load before visitors need them.',
  'efficient-animated-content': 'Moving pictures on your pages are heavy to download.',
  'total-byte-weight': 'Your pages are heavy to download.',
  'uses-long-cache-ttl': 'Returning visitors download the same files all over again.',
  'uses-text-compression': "Your pages aren't squeezed down before they're sent.",
  'server-response-time': 'Your website takes a while to start answering.',
  redirects: 'Visitors are bounced through extra addresses before your page loads.',
  'font-display': 'Text stays hidden while your fonts load.',
  'dom-size': 'Your pages are very large and complicated for a phone to draw.',
};

const pages = (n) => (n === 1 ? 'page' : 'pages');
const hasHave = (n) => (n === 1 ? 'has' : 'have');
const doesDo = (n) => (n === 1 ? "doesn't" : "don't");

function speedSection(psiMobile, psiDesktop) {
  const psi = psiMobile?.scores?.performance != null ? psiMobile
    : psiDesktop?.scores?.performance != null ? psiDesktop : null;
  if (!psi) return { score: null, findings: [] };
  const findings = [];
  const lcpMs = psiMobile?.metrics?.lcp?.value;
  if (typeof lcpMs === 'number' && lcpMs > 2500) {
    const secs = Math.max(3, Math.round(lcpMs / 1000));
    findings.push(`Your phone visitors wait about ${secs} seconds before they see your page. Most people leave after 3.`);
  }
  for (const o of psi.opportunities || []) {
    const words = SPEED_WORDS[o.id];
    if (words && !findings.includes(words)) findings.push(words);
  }
  return { score: psi.scores.performance, findings: findings.slice(0, 3) };
}

function googleSection(crawl, psiMobile, psiDesktop) {
  const parts = []; // [weight, value 0..1]
  const findings = [];
  const seo = psiMobile?.scores?.seo ?? psiDesktop?.scores?.seo;
  if (typeof seo === 'number') parts.push([2, seo / 100]);
  const ps = (crawl?.pages || []).map((p) => p.checks).filter(Boolean);
  const n = ps.length;
  if (n > 0) {
    const frac = (f) => ps.filter(f).length / n;
    const noDesc = ps.filter((c) => !c.description).length;
    const badDesc = ps.filter((c) => c.description && !c.descriptionOk).length;
    const badTitle = ps.filter((c) => !c.titleOk).length;
    const badH1 = ps.filter((c) => !c.h1Ok).length;
    const noCanon = ps.filter((c) => !c.canonical).length;
    const noAlt = ps.reduce((s, c) => s + (c.imagesWithoutAlt || 0), 0);
    const schema = ps.some((c) => c.hasBusinessSchema);
    parts.push([1, frac((c) => c.titleOk)], [1, frac((c) => c.descriptionOk)], [1, frac((c) => c.h1Ok)],
      [0.5, frac((c) => c.canonical)], [1, schema ? 1 : 0], [0.5, noAlt === 0 ? 1 : 0]);
    if (noDesc) findings.push(`${noDesc} of your ${n} ${pages(n)} ${hasHave(noDesc)} no description, so Google writes its own.`);
    if (badDesc) findings.push(`${badDesc} of your ${n} ${pages(n)} ${hasHave(badDesc)} a description that is too short or too long for Google to show well.`);
    if (badTitle) findings.push(`${badTitle} of your ${n} ${pages(n)} ${hasHave(badTitle)} a title that is missing, too short or too long, so Google may cut it off or rewrite it.`);
    if (badH1) findings.push(`${badH1} of your ${n} ${pages(n)} ${doesDo(badH1)} have one clear main heading, which makes it harder for Google to tell what ${badH1 === 1 ? 'it is' : 'they are'} about.`);
    if (!schema) findings.push("Your site doesn't tell Google your business details (name, address, hours) in the way it reads best.");
    if (noAlt) findings.push(`${noAlt} ${noAlt === 1 ? 'picture has' : 'pictures have'} no description, so Google — and people who can't see them — can't tell what ${noAlt === 1 ? 'it shows' : 'they show'}.`);
    if (noCanon) findings.push(`${noCanon} of your ${n} ${pages(n)} ${doesDo(noCanon)} say which address is the main one, so Google may split the credit.`);
  }
  if (crawl) {
    parts.push([1, crawl.sitemapPresent ? 1 : 0]);
    if (!crawl.sitemapPresent) findings.push('Your site has no sitemap, so Google has to find your pages on its own.');
  }
  if (!parts.length) return { score: null, findings: [] };
  const total = parts.reduce((s, [w]) => s + w, 0);
  const score = Math.round((parts.reduce((s, [w, v]) => s + w * v, 0) / total) * 100);
  return { score, findings: findings.slice(0, 3) };
}

function trustSection(crawl) {
  const home = crawl?.homepage;
  if (!home) return { score: null, findings: [] };
  const findings = [];
  let points = 0;
  let max = 0;
  max += 30;
  if (home.https) points += 30;
  else findings.push("Your site isn't served securely, so browsers can warn visitors away.");
  if (crawl.httpsRedirect != null) {
    max += 10;
    if (crawl.httpsRedirect) points += 10;
    else if (home.https) findings.push("People who type your address without the secure https:// aren't moved to the secure version.");
  }
  const sec = home.security || {};
  const keys = ['hsts', 'csp', 'nosniff', 'frame', 'referrer'];
  const missing = keys.filter((k) => !sec[k]).length;
  max += 60;
  points += (keys.length - missing) * 12;
  if (missing) findings.push(`Your site is missing ${missing} of 5 standard protections that stop other sites misusing your pages.`);
  return { score: Math.round((points / max) * 100), findings: findings.slice(0, 3) };
}

function phonesSection(crawl, psiMobile) {
  const homeChecks = crawl?.pages?.[0]?.checks;
  const perf = psiMobile?.scores?.performance;
  const findings = [];
  const parts = [];
  if (homeChecks) {
    parts.push(homeChecks.viewport ? 1 : 0);
    if (!homeChecks.viewport) findings.push("Your pages aren't set up for phones, so visitors have to pinch and zoom.");
  }
  if (typeof perf === 'number') {
    parts.push(perf >= 90 ? 1 : perf >= 50 ? 0.6 : 0.2);
    if (perf < 50) findings.push('Your site is slow on phones, where most of your visitors are.');
  }
  if (!parts.length) return { score: null, findings: [] };
  return { score: Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100), findings };
}

function leadsSection(crawl) {
  const contact = crawl?.homepage?.contact;
  if (!contact) return { score: null, findings: [] };
  const findings = [];
  let points = 0;
  if (contact.phoneShown) points += 25; else findings.push("Visitors can't see a phone number on your home page.");
  if (contact.telLink) points += 10; else if (contact.phoneShown) findings.push("Your phone number can't be tapped to call from a phone.");
  if (contact.contactLink) points += 35; else findings.push("There's no clear way to get in touch from your home page.");
  const broken = crawl.linkChecks?.broken?.length || 0;
  points += Math.max(0, 30 - broken * 10);
  if (broken) findings.push(`${broken} ${broken === 1 ? 'link on your site leads' : 'links on your site lead'} to a page that doesn't exist.`);
  return { score: points, findings: findings.slice(0, 3) };
}

/**
 * @returns {{ score: number|null, sentence: string|null, sections: object[], topFindings: string[], summary_plain: string, notes: string[] }}
 */
export function scoreAudit({ crawl, psiMobile = null, psiDesktop = null }) {
  const raw = {
    speed: speedSection(psiMobile, psiDesktop),
    google: googleSection(crawl, psiMobile, psiDesktop),
    trust: trustSection(crawl),
    phones: phonesSection(crawl, psiMobile),
    leads: crawl?.robots?.blocked ? { score: null, findings: [] } : leadsSection(crawl),
  };
  const sections = SECTIONS.map((s) => {
    const r = raw[s.key];
    return {
      ...s,
      score: r.score,
      verdict: r.score == null ? NOT_MEASURED[s.key] : bandSentence(r.score),
      findings: r.findings,
    };
  });
  const measured = sections.filter((s) => s.score != null);
  const wsum = measured.reduce((a, s) => a + s.weight, 0);
  const score = wsum ? Math.round(measured.reduce((a, s) => a + s.weight * s.score, 0) / wsum) : null;

  // The three most important findings: the first finding of each section,
  // weakest section first (heaviest weight breaks a tie), then the rest.
  const ordered = [...measured].sort((a, b) => a.score - b.score || b.weight - a.weight);
  const topFindings = [];
  for (const s of ordered) if (s.findings[0] && topFindings.length < 3) topFindings.push(s.findings[0]);
  for (const s of ordered) for (const f of s.findings.slice(1)) if (topFindings.length < 3 && !topFindings.includes(f)) topFindings.push(f);

  const notes = crawl?.robots?.blocked ? [ROBOTS_BLOCKED_SENTENCE] : [];
  let summary = topFindings.join(' ');
  if (!summary) summary = score == null ? "We couldn't check this website this time." : 'We found nothing important to fix.';
  if (summary.length > 500) summary = `${summary.slice(0, 497).replace(/\s+\S*$/, '')}…`;
  return { score, sentence: bandSentence(score), sections, topFindings, summary_plain: summary, notes };
}

export default { scoreAudit, bandSentence, SECTIONS, BAND_WORDS, ROBOTS_BLOCKED_SENTENCE, SPEED_WORDS };
export { SPEED_WORDS };
