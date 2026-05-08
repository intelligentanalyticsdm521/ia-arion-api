/**
 * Google PageSpeed Insights API client
 * Free API — no OAuth needed, just an API key (optional, higher quotas with key)
 * Docs: https://developers.google.com/speed/docs/insights/v5/get-started
 *
 * v2.0.7 — Now also captures:
 *   - CrUX field data (loadingExperience + originLoadingExperience)
 *   - Top Lighthouse "Opportunities" with estimated savings
 */

import { getSecret } from './secrets.js';

const PSI_BASE = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

/**
 * Extract the top-impact Lighthouse opportunities.
 * Each opportunity is an audit with displayValue (e.g. "Potential savings of 1.2 s")
 * and a numericValue (estimated ms saved).
 */
function extractOpportunities(audits, limit = 8) {
  const keys = [
    'render-blocking-resources',
    'unused-css-rules',
    'unused-javascript',
    'modern-image-formats',
    'uses-responsive-images',
    'efficient-animated-content',
    'offscreen-images',
    'total-byte-weight',
    'uses-long-cache-ttl',
    'uses-optimized-images',
    'uses-text-compression',
    'server-response-time',
    'redirects',
    'font-display',
    'critical-request-chains',
    'dom-size',
  ];
  const out = [];
  for (const k of keys) {
    const a = audits?.[k];
    if (!a) continue;
    // Skip audits that pass (score >= 0.9 means no meaningful issue)
    if (a.score != null && a.score >= 0.9) continue;
    out.push({
      id: k,
      title: a.title || k,
      display_value: a.displayValue || null,
      numeric_value: a.numericValue ?? null,
      numeric_unit: a.numericUnit || null,
      score: a.score ?? null,
      description: a.description ? a.description.replace(/\[.*?\]\(.*?\)/g, '') : null,
    });
  }
  // Sort by numeric_value descending (biggest savings first) — nulls last
  out.sort((a, b) => (b.numeric_value ?? -1) - (a.numeric_value ?? -1));
  return out.slice(0, limit);
}

/**
 * Extract CrUX field data from the PSI response.
 * PSI returns `loadingExperience` (URL-level) and `originLoadingExperience` (origin-wide)
 * when CrUX has enough traffic samples.
 */
function extractCrux(experience) {
  if (!experience?.metrics) return null;
  const m = experience.metrics;
  const pluck = (key) => {
    const v = m[key];
    if (!v) return null;
    return {
      percentile: v.percentile ?? null,
      category: v.category ?? null, // FAST / AVERAGE / SLOW
      distributions: v.distributions ?? null,
    };
  };
  return {
    overall_category: experience.overall_category ?? null,
    origin_fallback: experience.origin_fallback ?? null,
    lcp: pluck('LARGEST_CONTENTFUL_PAINT_MS'),
    inp: pluck('INTERACTION_TO_NEXT_PAINT'),
    cls: pluck('CUMULATIVE_LAYOUT_SHIFT_SCORE'),
    fcp: pluck('FIRST_CONTENTFUL_PAINT_MS'),
    ttfb: pluck('EXPERIMENTAL_TIME_TO_FIRST_BYTE'),
  };
}

export async function runPageSpeedTest(url, strategy = 'desktop') {
  // v2.0.12 — load from Key Vault if env var not set (production path)
  const apiKey = await getSecret('GOOGLE_API_KEY', 'arion-google-psi-key');
  const params = new URLSearchParams({
    url,
    strategy,
    category: 'performance',
  });
  params.append('category', 'accessibility');
  params.append('category', 'seo');
  params.append('category', 'best-practices');
  if (apiKey) params.set('key', apiKey);

  const fetchUrl = `${PSI_BASE}?${params.toString()}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(fetchUrl, { signal: AbortSignal.timeout(30000) });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      const data = await res.json();
      const cats = data.lighthouseResult?.categories || {};
      const audits = data.lighthouseResult?.audits || {};

      const scoreOf = (cat) => cat?.score != null ? Math.round(cat.score * 100) : null;
      const metricOf = (key) => {
        const a = audits[key];
        return a ? { value: a.numericValue ?? null, display: a.displayValue ?? null } : { value: null, display: null };
      };

      return {
        strategy,
        url,
        scores: {
          performance: scoreOf(cats.performance),
          accessibility: scoreOf(cats.accessibility),
          seo: scoreOf(cats.seo),
          bestPractices: scoreOf(cats['best-practices']),
        },
        metrics: {
          lcp: metricOf('largest-contentful-paint'),
          cls: metricOf('cumulative-layout-shift'),
          inp: metricOf('interaction-to-next-paint'),
          fcp: metricOf('first-contentful-paint'),
          si: metricOf('speed-index'),
          tbt: metricOf('total-blocking-time'),
        },
        // NEW v2.0.7 — field data from real Chrome users (CrUX)
        field_url: extractCrux(data.loadingExperience),
        field_origin: extractCrux(data.originLoadingExperience),
        // NEW v2.0.7 — top Lighthouse opportunities with estimated savings
        opportunities: extractOpportunities(audits),
        fetchedAt: new Date().toISOString(),
      };
    } catch (err) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      console.error(`[pagespeed] ${strategy} test for ${url} failed after 2 attempts:`, err.message);
      return null;
    }
  }

  return null;
}
