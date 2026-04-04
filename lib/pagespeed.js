/**
 * Google PageSpeed Insights API client
 * Free API — no OAuth needed, just an API key (optional, higher quotas with key)
 * Docs: https://developers.google.com/speed/docs/insights/v5/get-started
 */

const PSI_BASE = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

/**
 * Run a PageSpeed Insights test for a URL.
 * @param {string} url - Full URL to test (e.g. "https://example.com")
 * @param {'desktop'|'mobile'} [strategy='desktop']
 * @returns {Promise<{strategy: string, url: string, scores: {performance: number, accessibility: number, seo: number, bestPractices: number}, metrics: {lcp: {value: number, display: string}, cls: {value: number, display: string}, inp: {value: number, display: string}, fcp: {value: number, display: string}, si: {value: number, display: string}, tbt: {value: number, display: string}}, fetchedAt: string}|null>}
 */
export async function runPageSpeedTest(url, strategy = 'desktop') {
  const apiKey = process.env.GOOGLE_API_KEY;
  const params = new URLSearchParams({
    url,
    strategy,
    category: 'performance',
  });
  // URLSearchParams only keeps last value for duplicate keys, so append extras
  params.append('category', 'accessibility');
  params.append('category', 'seo');
  params.append('category', 'best-practices');
  if (apiKey) params.set('key', apiKey);

  const fetchUrl = `${PSI_BASE}?${params.toString()}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(fetchUrl, {
        signal: AbortSignal.timeout(30000),
      });

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
