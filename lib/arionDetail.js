// lib/arionDetail.js — ARION dimensioned DETAIL reports (dev demo generator).
//
// This is the layer Brandon kept asking for: not "impressions = X this month"
// but the LINE ITEMS underneath — which query, which page, which device, which
// referral (online.seranking.com up or down), each trended month over month.
//
// Each detail report belongs to one dashboard section (per the confirmed
// mapping) and is a table of items; each item has a 12-month `series` for its
// primary metric plus optional current-value columns. Feed reports (reviews,
// audit issues, vulnerabilities) are lists without a trend.
//
// PROD: these come from arion.metric_monthly rows WHERE dimension IS NOT NULL,
// written by the monthly snapshot job (documented deploy requirement). DEV:
// generated here, deterministic per site.

function rng(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => { h = Math.imul(h ^ (h >>> 15), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
}

/** 12-month series around base with drift + noise + optional recent move. */
function ser(rand, base, { drift = 0.02, noise = 0.06, dir = 0, integer = false, min = 0, max, dp = 2 } = {}) {
  const out = [];
  for (let m = 11; m >= 0; m--) {
    const growth = 1 + drift * (11 - m);
    const n = 1 + (rand() - 0.5) * 2 * noise;
    let recent = 1;
    if (dir !== 0 && m <= 1) recent = 1 + dir * (0.1 + rand() * 0.18);
    let v = base * growth * n * recent;
    if (v < min) v = min;
    if (max != null && v > max) v = max;
    out.push(integer ? Math.round(v) : Number(v.toFixed(dp)));
  }
  return out;
}

const QUERY_SETS = {
  Landscaping: ["lawn care des moines", "landscaping near me", "mulch delivery des moines", "irrigation repair", "snow removal des moines", "lawn mowing service", "yard cleanup", "sod installation", "leaf removal", "landscape design"],
  "Dental Practice": ["dentist ankeny", "teeth whitening ankeny", "emergency dentist near me", "family dentist iowa", "dental cleaning cost", "new patient dentist", "invisalign ankeny", "kids dentist", "dental implants", "root canal dentist"],
  Cafe: ["coffee shop des moines", "coffee catering des moines", "best espresso near me", "wholesale coffee beans iowa", "cafe near me", "cold brew des moines", "breakfast cafe", "coffee subscription", "latte art class", "local roaster"],
};
const PAGES = ["/", "/services", "/about", "/contact", "/pricing", "/gallery", "/blog/spring-checklist", "/reviews"];
const REFERRERS = ["google.com", "online.seranking.com", "facebook.com", "bing.com", "nextdoor.com", "yelp.com", "instagram.com", "bbb.org"];
const CHANNELS = ["Organic Search", "Direct", "Referral", "Organic Social", "Paid Search", "Email"];
const CITIES = ["Des Moines", "Ankeny", "West Des Moines", "Urbandale", "Johnston", "Clive", "Waukee", "Altoona"];

function pctChange(series) {
  const cur = series[series.length - 1], prev = series[series.length - 2];
  if (prev == null || prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

/**
 * Full ARION detail-report set for a site.
 * Returns { [reportId]: DetailReport } — see the client detail catalog for how
 * each maps to a section.
 */
export function demoArionDetail(site) {
  const industry = site.business_type || site.industry || "Landscaping";
  const R = (salt) => rng(`${site.domain || site.site_id}:d:${salt}`);
  const queries = QUERY_SETS[industry] || QUERY_SETS.Landscaping;
  const reports = {};

  const add = (id, meta, items) => { reports[id] = { id, ...meta, items }; };

  // ── SEARCH VISIBILITY ──
  // Keyword movement — the exemplar deep report. 26 tracked keywords, each
  // carrying the metadata a real keyword report needs: search volume,
  // difficulty, intent, branded flag, ranking URL, SERP features. Series is
  // POSITION (lower is better). Two keywords intentionally share a URL so the
  // cannibalization flag has something real to catch.
  const KW_VARIANTS = ["best {q}", "{q} cost", "{q} near me", "affordable {q}", "how much does {q} cost", "{q} reviews", "{q} free estimate", "top rated {q}", "{q} pricing", "{q} company", "cheap {q}", "diy {q}", "{q} quote", "emergency {q}", "{q} contractors", "local {q}"];
  const baseKws = queries.slice(0, 10);
  const brandIdx = baseKws.length - 1; // the brand-name query in each set
  const kwList = [
    ...baseKws.map((q, i) => ({ q, branded: i === brandIdx })),
    ...KW_VARIANTS.map((v, i) => ({ q: v.replace("{q}", baseKws[i % (baseKws.length - 1)]), branded: false })),
  ];
  const intentOf = (q) =>
    /cost|pricing|quote|estimate|cheap|affordable/.test(q) ? "Commercial"
    : /near me|local |des moines|ankeny/.test(q) ? "Local"
    : /how |diy |reviews|best |top rated/.test(q) ? "Informational"
    : "Transactional";
  const SERP_BY_INTENT = {
    Local: "Local Pack, Map",
    Commercial: "Ads, Sitelinks",
    Informational: "Featured Snippet, PAA",
    Transactional: "Sitelinks",
  };
  add("keyword_movement", {
    section: "search_visibility.keyword_rankings", label: "Keyword Movement",
    itemLabel: "Keyword", primaryLabel: "Position", format: "position", higherIsBetter: false,
    columns: [
      { key: "volume", label: "Volume", format: "number" },
      { key: "difficulty", label: "Diff", format: "number" },
      { key: "intent", label: "Intent", format: "text" },
      { key: "serp", label: "SERP Features", format: "text" },
    ],
  }, kwList.map(({ q, branded }, i) => {
    const r = R(`kw${i}`);
    const intent = branded ? "Branded" : intentOf(q);
    const basePos = branded ? 1.6 : 4 + r() * 34;
    const series = ser(r, basePos, { drift: -0.012, noise: 0.06, dir: i % 3 === 0 ? 1 : -1, min: 1, dp: 1 });
    const volume = Math.round(branded ? 200 + r() * 400
      : intent === "Informational" ? 800 + r() * 4200
      : intent === "Local" ? 500 + r() * 2000
      : 300 + r() * 1500);
    // URLs: mostly unique blog/service pages; every 9th shares /services so
    // the cannibalization flag has genuine collisions.
    const url = i % 9 === 0 ? "/services" : i < 8 ? PAGES[i] : `/blog/${q.replace(/[^a-z0-9]+/g, "-").slice(0, 28)}`;
    return {
      name: q, series,
      extra: {
        volume, difficulty: Math.round(10 + r() * 58), intent,
        branded: branded ? "Branded" : "Non-branded",
        url, serp: branded ? "Sitelinks, Knowledge Panel" : SERP_BY_INTENT[intent],
      },
    };
  }));

  // Competitive share of voice — your visibility vs named local competitors,
  // trended. Fictional competitor names per industry (never real businesses).
  const COMPETITOR_SETS = {
    Landscaping: ["GreenScape Pros", "Metro Lawn Co", "TurfWorks Outdoor"],
    "Dental Practice": ["Prairie Smiles Dental", "Clear Creek Dental", "BrightPath Dental"],
    Cafe: ["Riverbend Roasters", "Daily Grind Co", "Copper Cup Coffee"],
  };
  const comps = COMPETITOR_SETS[industry] || COMPETITOR_SETS.Landscaping;
  add("share_of_voice", {
    section: "search_visibility.keyword_rankings", label: "Competitive Share of Voice",
    itemLabel: "Business", primaryLabel: "Share of Voice", format: "percent", higherIsBetter: true,
  }, [
    { name: "Your business", series: ser(R("sov0"), 21, { drift: 0.02, noise: 0.05, dir: 1, dp: 1, max: 100 }) },
    { name: comps[0], series: ser(R("sov1"), 31, { drift: -0.006, noise: 0.05, dp: 1, max: 100 }) },
    { name: comps[1], series: ser(R("sov2"), 24, { drift: 0.004, noise: 0.05, dp: 1, max: 100 }) },
    { name: comps[2], series: ser(R("sov3"), 12, { drift: -0.004, noise: 0.06, dir: -1, dp: 1, max: 100 }) },
  ]);

  // Query performance — series = clicks.
  add("query_performance", {
    section: "search_visibility.search_traffic", label: "Query Performance",
    itemLabel: "Query", primaryLabel: "Clicks", format: "number", higherIsBetter: true,
    columns: [
      { key: "impressions", label: "Impr", format: "number" },
      { key: "ctr", label: "CTR", format: "percent" },
      { key: "position", label: "Pos", format: "position", lowerBetter: true },
    ],
  }, queries.map((q, i) => {
    const r = R(`q${i}`);
    const impr = Math.round(400 + r() * 5000);
    const pos = Number((3 + r() * 15).toFixed(1));
    const ctr = pos < 5 ? 6 + r() * 14 : 1 + r() * 4;
    const clicks = Math.round(impr * (ctr / 100));
    return { name: q, series: ser(r, clicks, { drift: 0.02, dir: i % 4 === 0 ? -1 : 1, integer: true }), extra: { impressions: impr, ctr: Number(ctr.toFixed(2)), position: pos } };
  }));

  // Page search performance — series = clicks per page.
  add("page_search_performance", {
    section: "search_visibility.search_traffic", label: "Landing Page Search Performance",
    itemLabel: "Page", primaryLabel: "Clicks", format: "number", higherIsBetter: true,
    columns: [{ key: "impressions", label: "Impr", format: "number" }, { key: "position", label: "Pos", format: "position", lowerBetter: true }],
  }, PAGES.slice(0, 6).map((p, i) => {
    const r = R(`pg${i}`);
    return { name: p, series: ser(r, Math.round(30 + r() * 300), { dir: i % 3 === 0 ? -1 : 1, integer: true }), extra: { impressions: Math.round(800 + r() * 6000), position: Number((5 + r() * 12).toFixed(1)) } };
  }));

  // Search device split.
  add("search_device_split", {
    section: "search_visibility.search_traffic", label: "Search by Device",
    itemLabel: "Device", primaryLabel: "Clicks", format: "number", higherIsBetter: true,
  }, ["Mobile", "Desktop", "Tablet"].map((d, i) => {
    const r = R(`sdev${i}`);
    return { name: d, series: ser(r, [900, 380, 40][i], { dir: i === 0 ? 1 : 0, integer: true }) };
  }));

  // CTR by query (click-through section).
  add("ctr_by_query", {
    section: "search_visibility.click_through", label: "Click-Through by Query",
    itemLabel: "Query", primaryLabel: "CTR", format: "percent", higherIsBetter: true,
    columns: [{ key: "position", label: "Pos", format: "position", lowerBetter: true }, { key: "expected", label: "Expected", format: "percent" }],
  }, queries.slice(0, 8).map((q, i) => {
    const r = R(`ctrq${i}`);
    const pos = Number((3 + r() * 14).toFixed(1));
    const expected = pos < 4 ? 8 : pos < 11 ? 3 : 1.2;
    return { name: q, series: ser(r, expected * (0.7 + r() * 0.8), { noise: 0.08, dp: 2 }), extra: { position: pos, expected } };
  }));

  // Referring domains (domain authority).
  add("referring_domains", {
    section: "search_visibility.domain_authority", label: "Referring Domains",
    itemLabel: "Domain", primaryLabel: "Backlinks", format: "number", higherIsBetter: true, kind: "trend",
  }, ["localbiz-directory.com", "chamberofcommerce.com", "yelp.com", "angi.com", "houzz.com", "bbb.org"].map((d, i) => {
    const r = R(`rd${i}`);
    return { name: d, series: ser(r, Math.round(3 + r() * 40), { integer: true, dir: i % 2 ? 1 : 0 }) };
  }));

  // ── LOCAL PRESENCE ──
  add("gbp_discovery_split", {
    section: "local_presence.discovery", label: "How Customers Found You",
    itemLabel: "Surface", primaryLabel: "Views", format: "number", higherIsBetter: true,
  }, ["Google Search — Mobile", "Google Maps — Mobile", "Google Search — Desktop", "Google Maps — Desktop"].map((s, i) => {
    const r = R(`disc${i}`);
    return { name: s, series: ser(r, [2100, 1800, 700, 500][i], { dir: 1, integer: true }) };
  }));

  add("gbp_action_breakdown", {
    section: "local_presence.customer_actions", label: "Customer Actions",
    itemLabel: "Action", primaryLabel: "Count", format: "number", higherIsBetter: true,
  }, ["Calls", "Direction Requests", "Website Clicks", "Bookings"].map((a, i) => {
    const r = R(`act${i}`);
    return { name: a, series: ser(r, [62, 88, 140, 12][i], { dir: i === 3 ? -1 : 1, integer: true }) };
  }));

  // Review feed (list, not trend).
  const revNames = ["Jordan M.", "Casey P.", "Alex R.", "Sam T.", "Riley K.", "Morgan D.", "Dana W.", "Quinn L."];
  add("review_feed", {
    section: "local_presence.reputation", label: "Recent Reviews", kind: "feed",
    itemLabel: "Reviewer", columns: [{ key: "rating", label: "Rating", format: "rating" }, { key: "replied", label: "Replied", format: "text" }, { key: "when", label: "When", format: "text" }],
  }, revNames.map((n, i) => {
    const r = R(`rev${i}`);
    const rating = r() > 0.8 ? Math.round(2 + r() * 2) : r() > 0.4 ? 5 : 4;
    return { name: n, series: [], extra: { rating, replied: r() > 0.35 ? "Yes" : "No", when: `${i * 4 + 2}d ago` } };
  }));

  add("post_feed", {
    section: "local_presence.profile_activity", label: "Recent Posts", kind: "feed",
    itemLabel: "Post", columns: [{ key: "type", label: "Type", format: "text" }, { key: "views", label: "Views", format: "number" }, { key: "when", label: "When", format: "text" }],
  }, ["Spring cleanup special", "New crew hiring", "Customer photo — patio", "5-star thank you"].map((p, i) => {
    const r = R(`post${i}`);
    return { name: p, series: [], extra: { type: ["Offer", "Update", "Photo", "Update"][i], views: Math.round(80 + r() * 400), when: `${i * 7 + 3}d ago` } };
  }));

  // ── AUDIENCE & CONVERSION ──
  add("channel_breakdown", {
    section: "audience_conversion.traffic_volume", label: "Traffic by Channel",
    itemLabel: "Channel", primaryLabel: "Sessions", format: "number", higherIsBetter: true,
  }, CHANNELS.map((c, i) => {
    const r = R(`ch${i}`);
    return { name: c, series: ser(r, [820, 480, 260, 180, 110, 90][i], { dir: i === 4 ? -1 : 1, integer: true }) };
  }));

  // Referral sources — THE online.seranking.com table.
  add("referral_sources", {
    section: "audience_conversion.traffic_volume", label: "Referral Sources",
    itemLabel: "Source", primaryLabel: "Sessions", format: "number", higherIsBetter: true,
  }, REFERRERS.map((rf, i) => {
    const r = R(`ref${i}`);
    return { name: rf, series: ser(r, Math.round(20 + r() * 240), { dir: i % 3 === 0 ? -1 : 1, integer: true }) };
  }));

  add("device_breakdown", {
    section: "audience_conversion.audience_mix", label: "Sessions by Device",
    itemLabel: "Device", primaryLabel: "Sessions", format: "number", higherIsBetter: true,
  }, ["Mobile", "Desktop", "Tablet"].map((d, i) => {
    const r = R(`dev${i}`);
    return { name: d, series: ser(r, [1300, 720, 80][i], { dir: i === 0 ? 1 : 0, integer: true }) };
  }));

  add("geography", {
    section: "audience_conversion.audience_mix", label: "Sessions by City",
    itemLabel: "City", primaryLabel: "Sessions", format: "number", higherIsBetter: true,
  }, CITIES.map((c, i) => {
    const r = R(`geo${i}`);
    return { name: c, series: ser(r, Math.round(60 + r() * 500 * (i === 0 ? 2 : 1)), { dir: i % 4 === 0 ? -1 : 1, integer: true }) };
  }));

  add("conversion_by_source", {
    section: "audience_conversion.conversions", label: "Conversions by Source",
    itemLabel: "Source", primaryLabel: "Conversions", format: "number", higherIsBetter: true,
    columns: [{ key: "rate", label: "Conv Rate", format: "percent" }],
  }, ["Organic Search", "Direct", "Referral", "Paid Search", "Organic Social"].map((c, i) => {
    const r = R(`cvs${i}`);
    return { name: c, series: ser(r, Math.round(4 + r() * 16), { dir: i === 3 ? 1 : 0, integer: true }), extra: { rate: Number((1 + r() * 4).toFixed(2)) } };
  }));

  add("engagement_by_channel", {
    section: "audience_conversion.engagement_quality", label: "Engagement by Channel",
    itemLabel: "Channel", primaryLabel: "Engagement Rate", format: "percent", higherIsBetter: true,
    columns: [{ key: "bounce", label: "Bounce %", format: "percent" }, { key: "duration", label: "Avg Duration", format: "ms" }],
  }, CHANNELS.slice(0, 5).map((c, i) => {
    const r = R(`engch${i}`);
    return {
      name: c,
      series: ser(r, [61, 48, 55, 38, 44][i], { drift: 0.005, noise: 0.04, dir: i === 3 ? -1 : i === 0 ? 1 : 0, max: 100, dp: 1 }),
      extra: { bounce: Number((100 - [61, 48, 55, 38, 44][i]).toFixed(0)), duration: Math.round([128, 84, 96, 41, 66][i] * 1000) },
    };
  }));

  add("engagement_by_page", {
    section: "audience_conversion.engagement_quality", label: "Engagement by Landing Page",
    itemLabel: "Page", primaryLabel: "Engagement Rate", format: "percent", higherIsBetter: true,
  }, PAGES.slice(0, 6).map((p, i) => {
    const r = R(`engpg${i}`);
    return { name: p, series: ser(r, 35 + r() * 40, { drift: 0.004, noise: 0.05, dir: i % 3 === 0 ? -1 : 0, max: 100, dp: 1 }) };
  }));

  // ── CONTENT ──
  add("top_pages", {
    section: "content.page_performance", label: "Top Pages",
    itemLabel: "Page", primaryLabel: "Views", format: "number", higherIsBetter: true,
    columns: [{ key: "engagement", label: "Engaged", format: "percent" }],
  }, PAGES.map((p, i) => {
    const r = R(`tp${i}`);
    return { name: p, series: ser(r, Math.round(120 + r() * 1800), { dir: i % 3 === 0 ? -1 : 1, integer: true }), extra: { engagement: Number((40 + r() * 40).toFixed(0)) } };
  }));

  add("content_age", {
    section: "content.content_freshness", label: "Content Age Distribution",
    itemLabel: "Age", primaryLabel: "Pages", format: "number", higherIsBetter: true, kind: "trend",
  }, ["0–90 days", "90–180 days", "180–365 days", "1 year+"].map((a, i) => {
    const r = R(`age${i}`);
    return { name: a, series: ser(r, [8, 6, 9, 14][i], { integer: true, dir: i === 0 ? 1 : i === 3 ? 1 : 0 }) };
  }));

  add("word_count_dist", {
    section: "content.content_quality", label: "Content Depth",
    itemLabel: "Length", primaryLabel: "Pages", format: "number", higherIsBetter: true, kind: "feed",
  }, ["Under 300 words", "300–600", "600–1000", "1000+"].map((w, i) => {
    const r = R(`wc${i}`);
    return { name: w, series: [], extra: { pages: [7, 12, 9, 5][i] } };
  }));

  // Content gaps — searches drawing impressions with no page that answers
  // them. Series = monthly impressions for the gap query, so a growing gap is
  // visibly growing demand we're leaving on the table.
  const GAP_QUERIES = {
    Landscaping: [["retaining wall installation", "/services"], ["lawn fertilization schedule", null], ["drainage solutions yard", null], ["fall cleanup checklist", null], ["landscape lighting install", "/services"], ["tree trimming cost", null]],
    "Dental Practice": [["veneers cost", null], ["sedation dentistry", "/services"], ["tooth extraction aftercare", null], ["dental bridge vs implant", null], ["gum disease treatment", null], ["night guard for grinding", null]],
    Cafe: [["private event space rental", null], ["coffee tasting flight", null], ["gluten free pastries near me", null], ["mobile coffee cart wedding", "/services"], ["nitro cold brew kegs", null], ["barista training class", null]],
  };
  const gaps = GAP_QUERIES[industry] || GAP_QUERIES.Landscaping;
  add("content_gap_keywords", {
    section: "content.content_gaps", label: "Content Gap Keywords",
    itemLabel: "Search", primaryLabel: "Impressions", format: "number", higherIsBetter: true,
    columns: [
      { key: "volume", label: "Volume", format: "number" },
      { key: "closest", label: "Closest page", format: "text" },
    ],
  }, gaps.map(([q, closest], i) => {
    const r = R(`gapkw${i}`);
    return {
      name: q,
      series: ser(r, 120 + r() * 700, { drift: 0.03, noise: 0.12, dir: i % 2 === 0 ? 1 : 0, integer: true }),
      extra: { volume: Math.round(300 + r() * 2200), closest: closest || "None — needs a new page" },
    };
  }));

  // ── TECHNICAL ──
  add("pagespeed_history", {
    section: "technical.speed_cwv", label: "PageSpeed by Strategy",
    itemLabel: "Strategy", primaryLabel: "Score", format: "score", higherIsBetter: true,
    columns: [{ key: "lcp", label: "LCP", format: "ms", lowerBetter: true }],
  }, ["Mobile", "Desktop"].map((s, i) => {
    const r = R(`psi${i}`);
    return { name: s, series: ser(r, i === 0 ? 58 : 82, { drift: 0.01, dir: 1, max: 100, integer: true }), extra: { lcp: Math.round(i === 0 ? 3200 : 900) } };
  }));

  add("audit_issues", {
    section: "technical.health_seo", label: "Audit Issues", kind: "feed",
    itemLabel: "Issue", columns: [{ key: "severity", label: "Severity", format: "text" }, { key: "count", label: "Pages", format: "number" }],
  }, ["Missing meta descriptions", "Images without alt text", "Slow server response", "Duplicate title tags", "Missing H1"].map((it, i) => {
    const r = R(`ai${i}`);
    return { name: it, series: [], extra: { severity: ["Warning", "Warning", "Error", "Warning", "Error"][i], count: Math.round(1 + r() * 12) } };
  }));

  add("vulnerabilities", {
    section: "technical.security", label: "Security Findings", kind: "feed",
    itemLabel: "Finding", columns: [{ key: "severity", label: "Severity", format: "text" }, { key: "status", label: "Status", format: "text" }],
  }, ["Outdated plugin: contact-form", "WordPress core 1 minor behind"].map((v, i) => ({ name: v, series: [], extra: { severity: i === 0 ? "Medium" : "Low", status: "Open" } })));

  add("broken_links", {
    section: "technical.crawl", label: "Broken Links", kind: "feed",
    itemLabel: "URL", columns: [{ key: "code", label: "Code", format: "text" }, { key: "onpage", label: "On page", format: "text" }],
  }, ["/old-services", "/team/former-staff", "/promo-2024"].map((u, i) => ({ name: u, series: [], extra: { code: "404", onpage: ["/services", "/about", "/"][i] } })));

  // Attach a computed MoM to each trend item so the client doesn't recompute.
  for (const rep of Object.values(reports)) {
    for (const it of rep.items) {
      if (it.series && it.series.length >= 2) it.momPct = pctChange(it.series);
    }
  }
  return reports;
}
