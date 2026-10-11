# SE Ranking, feature by feature, against what we build instead

Written 10 October 2026. SE Ranking and DataForSEO pages read today, Sat 10 Oct 2026, between 14:02 and 14:30 UTC (clock from `date -u`). Research and reading only: no file in any repository was changed, nothing was run against production or a client site, and no secret was printed.

Built from SE Ranking's own pages (the features menu on https://seranking.com, every feature page linked from it, https://seranking.com/subscription.html, the API, MCP, agency, local, content and AI search pages, SE Visible), DataForSEO price pages read today, our code on the release lines (arion-api `1d592a6`, arion-func, Portal, ia-plugin), and yesterday's three documents: `RESEARCH_SEO_FIELD_MAP_2026-10-09.md`, `RESEARCH_SEO_PRICES_2026-10-09.md`, `SCOPE_SEO_TOOLS_WITHOUT_SERANKING_2026-10-09.md`.

**How to read the tables.** "As read" is what SE Ranking's page says, in short, with the page it came from. "Plan limit" is from the same page or the subscription page. "Kind" says where our version comes from:
- **EXISTING-API**: already connected or already built in our code (Search Console, Bing, Business Profile, PageSpeed, GA4, the plugin, our own jobs).
- **BUILD**: our own code to write, no data bought.
- **FEED**: data bought by the request from a provider (DataForSEO, the recommended one).
- **FEED+BUILD**: both.
- **SKIP**: not built, with the reason.

Verdicts: **MATCH** (does what theirs does), **IMPROVE** (does it better, and how), **PARTIAL** (some of it, and what is left out), **SKIP**.

---

## The answer in one page

1. **SE Ranking's pages read today come to 20 modules and 96 features (the rows below).** We match 47 and improve 22, cover 18 in part, and skip 9 (paid-ads research and the two AI ads trackers, competitor subdomains, extra markets and languages, Looker Studio and the other connectors, the agency catalogue, a public API, the free marketing tools). Nothing a local service business needs is in the skip pile.
2. **Where we are better, it is because we hold what SE Ranking cannot see:** the business's calls, forms and bookings (GA4 conversion events and our bookings), the full answer text from each AI engine with a plain-words fix, the Rank Math settings on every page through our plugin (so the audit fixes titles and descriptions instead of only listing them), and Business Profile reviews answered in the business's own voice.
3. **Cost to run, per client per month, at today's DataForSEO prices** (section A): Starter **$0.10**, Essentials **$1.04**, Growth **$12.24**, Authority **$21.18** (daily top 10 plus weekly top 30) or **$34.10** (daily top 30). SE Ranking today costs **$219.40 a month** for Core with the AI Search and API add-ons billed annually (up to 10 projects, so $21.94 a client at 10 clients), **$288.40** with the Agency Pack, and the next client forces Growth at **$339.40**. Every local location past three is **$18.40 a month** more.
4. **The extra at the higher tiers** (section B): a mention finder. It finds pages that name the business but do not link to it, link to a dead or wrong page, or print the wrong phone or address, and pages that name two competitors but not the client. It uses the backlink data we already buy plus a web-mention search at $0.06 a search. No SE Ranking page read today offers this for the open web; their AI tracker separates linked from unlinked mentions inside AI answers only.
5. **Audit checks nobody runs today** (section C): 24 checks, from whether AI crawlers are blocked in robots.txt to whether the Business Profile's website link carries tracking, whether the phone on the site matches the profile, and whether the site's form emails actually arrive.
6. **What Search Console and our other connected APIs already cover for free** is in section D, with the code that calls each one.

---

## A. Cost per client per month, by our tier (prices read today)

Prices used, all DataForSEO, read 10 Oct 2026:
- Google and Bing organic SERP: $0.0006 per page of 10 results (Standard queue); depth "Multiply for each 10 search engine results"; AI Overview text (`load_async_overview`) adds one base price. https://dataforseo.com/pricing/serp/google-organic-serp-api
- Google AI Mode: $0.0012 per page (Standard). https://dataforseo.com/pricing/serp/google-ai-mode-serp-api
- LLM Scraper (ChatGPT and Gemini, "only ChatGPT and Gemini are supported"): $0.0012 per page (Standard). https://dataforseo.com/pricing/ai-optimization/llm-scraper
- Google Maps SERP: $0.0006 per page of 100 results (Standard). https://dataforseo.com/pricing/serp/google-maps-serp-api
- Backlinks: $0.024 per request + $0.000036 per row; no minimum stated. A summary plus 1,000 referring domains is $0.084. https://dataforseo.com/pricing/backlinks/backlinks
- Keyword volume (Google Ads): $0.06 per task of up to 1,000 keywords (Standard). https://dataforseo.com/pricing/keywords-data/google-ads
- Labs (keyword ideas, ranked keywords, competitors, intent): $0.012 per task + $0.00012 per item; Historical Rank 10x. A 1,000-item competitor pull is $0.132; a 100-idea keyword lookup is $0.024. https://dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api
- Content Analysis (web mentions): $0.024 per request + $0.000036 per row; 1,000 rows is $0.06. https://dataforseo.com/apis/content-analysis-api
- LLM Mentions (prompt discovery): $0.1 per request + $0.001 per row. https://dataforseo.com/pricing/ai-optimization/llm-mentions
- Google Reviews (competitors' reviews): $0.00075 per 10 reviews. https://dataforseo.com/pricing/business-data/google-reviews-api
- On-Page JavaScript rendering, only if a site needs it: $0.0015 per page. https://dataforseo.com/pricing/on-page/onpage-api

Tier settings from `lib/seoOnboarding.js:131-177`; depth top 30 (what today's widgets need) unless stated. A month is 30.42 days or 4.33 weeks.

| Line | Starter (10 keywords, 2 engines, monthly) | Essentials (25, 3, weekly) | Growth (60, 3, daily) | Authority (150, 3, daily) |
|---|---|---|---|---|
| Rank tracking | 20 pulls x 3 pages x $0.0006 = **$0.04** | 325 x 3 x $0.0006 = **$0.59** | 5,475 x 3 x $0.0006 = **$9.86** | daily top 10: 13,688 x $0.0006 = $8.21, plus weekly top 30: 1,950 x 3 x $0.0006 = $3.51; **$11.72** |
| AI search (5 prompts per engine, daily) | none | none | 2 Google engines: 10 checks/day x $0.0012 x 30.42 = **$0.37** | 4 engines (AI Overview, AI Mode, ChatGPT, Gemini): 20/day x $0.0012 x 30.42 = **$0.73** |
| Backlinks (own + competitors) | none | none | monthly, 6 domains x $0.084 = **$0.50** | weekly, 11 domains x $0.084 x 4.33 = **$4.00** |
| Keyword volume refresh | **$0.06** | **$0.06** | **$0.06** | **$0.06** |
| Keyword research lookups | none | none | 20 x $0.024 = **$0.48** | 40 x $0.024 = **$0.96** |
| Competitor research (traffic, keywords, top pages) | none | 3 x $0.132 = **$0.40** | 6 x $0.132 = **$0.79** | 11 x $0.132 = **$1.45** |
| Mention finder (section B) | none | none | monthly, 3 searches x $0.06 = **$0.18** | weekly, 3 x $0.06 x 4.33 = **$0.78** |
| Map grid (7x7 points, 10 keywords, weekly) | none | none | none | 2,123 x $0.0006 = **$1.27** |
| Prompt discovery (LLM Mentions, monthly) | none | none | none | $0.1 + 100 rows x $0.001 = **$0.20** |
| Site audit, page changes, Search Console, Bing, Business Profile, PageSpeed, reviews and posts | $0 (ours or already connected) | $0 | $0 | $0 |
| **Per client per month** | **$0.10** | **$1.04** | **$12.24** | **$21.18** |
| Per client per year | $1.15 | $12.48 | $146.88 | $254.16 |

- **Authority with daily top 30** instead of daily top 10 plus weekly top 30: rank tracking $24.64, total **$34.10 a month** ($409.20 a year).
- **Authority add-on: competitors' mention gap** (10 competitor names searched monthly): +$0.60 a month.
- **Ten clients, mixed** (3 Starter, 3 Essentials, 3 Growth, 1 Authority): $0.30 + $3.12 + $36.72 + $21.18 = **$61.32 a month**, about $736 a year.
- **Not in these figures:** model token costs if Claude or Perplexity become AI engines (their prices were not read today), our own compute and storage for the crawler and runner, JavaScript rendering for a site that needs it (500 pages at $0.0015 = $0.75 an audit), a directory-listings feed (not priced today), and the $50 DataForSEO prepayment (a deposit toward usage, not a fee).

**SE Ranking for the same book, list prices read today** (https://seranking.com/subscription.html):

| Setup | Per month (annual billing) | Per client at 10 clients |
|---|---|---|
| Core $103.20 + AI Search $71.20 + API $45 | $219.40 (10 projects, 2k keywords, 100 prompts) | $21.94 |
| The same + Agency Pack $69 (white label, 30 client seats, lead generator) | $288.40 | $28.84 |
| Growth $223.20 + AI Search $71.20 + API $45 (needed from client 11) | $339.40 (30 projects, 5k keywords, 250 prompts) | $30.85 at 11 clients |
| Each local location past 3 | +$18.40 | |

Our Authority tier at the recommended setting costs about what SE Ranking costs per client at ten clients, and every other tier costs a fraction of it. The cost is per client, so there is no wall at client eleven.

---

## The side-by-side, module by module

All SE Ranking pages below were read on 10 Oct 2026 (UTC).

### 1. Rank tracker

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| Search engines | Tracks Google, Bing, Yahoo and YouTube. ([seranking.com/position-tracking.html](https://seranking.com/position-tracking.html)) | All plans; keywords tracked daily: Core 2k, Growth 5k, Enterprise custom; extra keywords $22.40/mo (Core), $32/mo (Growth) | DataForSEO Google Organic SERP and Bing Organic SERP, $0.0006 per 10 results (Standard queue); new lib/serpFeed.js; table seo_position | FEED+BUILD | Feed adapter, scheduler by seo_addon_tier in arion-func, the eight live routes in routes/arion.js rewritten onto our tables. Yahoo and YouTube not priced today and not built. | PARTIAL: Google and Bing are what a local service business is found on; Yahoo and YouTube are left out unless asked. |
| Locations (country, city, ZIP) | 190+ countries; city-level and ZIP code targeting for local rankings. ([seranking.com/position-tracking.html](https://seranking.com/position-tracking.html)) | All plans | Feed location parameter; city and state already built per site in lib/seoOnboarding.js:82-95 (region_name) | FEED | Pass the site's city (or ZIP) to the feed; per-location keyword sets for multi-location businesses. | MATCH: same city-level pull. |
| Devices | Desktop and mobile tracking. ([seranking.com/position-tracking.html](https://seranking.com/position-tracking.html)) | All plans | Feed device parameter; engine rows Google desktop, Google mobile, Bing (seoOnboarding.js tier engines) | FEED | One pull per device; engine table. | MATCH. |
| Depth (top 100) | "Track the top 100 search results for any keyword". ([seranking.com/position-tracking.html](https://seranking.com/position-tracking.html)) | Google Top 100 Tracking on Core, Growth, Enterprise (subscription page) | Feed depth parameter, billed per 10 results (DataForSEO: depth "Multiply for each 10 search engine results") | FEED | Top 30 by default (what today's widgets use); top 100 on demand or weekly. Top 100 daily costs 10x top 10. | PARTIAL by choice: top 30 covers everything the pages show; top 100 is a setting, not a rebuild. |
| SERP features | "Monitor your presence in 35+ of Google's enriched SERP elements", including AI Overviews and featured snippets. ([seranking.com/position-tracking.html](https://seranking.com/position-tracking.html)) | All plans | The same SERP pull returns each result's type (local pack, snippet, AI block, people also ask); stored per pull | FEED+BUILD | Store item types per keyword per day; show owned / not owned per feature. AI Overview text needs load_async_overview, which adds one base price. | MATCH. |
| Check frequency | Daily ranking updates. ([seranking.com/position-tracking.html](https://seranking.com/position-tracking.html)) | Daily on all plans | arion-func timer by tier: Starter monthly, Essentials weekly, Growth and Authority daily (lib/seoOnboarding.js:131-177) | BUILD | Scheduler selects sites by seo_addon_tier and skips cancelled add-ons. | MATCH: daily where the tier pays for it, cents where it does not. |
| Historical data | Compare ranking dynamics month by month and year over year; project lifetime history on Growth. ([seranking.com/subscription.html](https://seranking.com/subscription.html)) | Core 6 months; Growth and Enterprise all time | Our table seo_position (kept), plus the 12 months in arion.se_ranking_position_history mapped by keyword and engine id | BUILD | One-time import with id mapping so the Insights aggregation does not split the switch month. | IMPROVE: all-time history on every tier, not only the $279 plan. |
| Ranking alerts | Notifications of ranking changes. ([seranking.com/position-tracking.html](https://seranking.com/position-tracking.html)) | All plans | LUMEN alerts (exist) fed by seo_position deltas; page-change watcher (arion-func shared/marketMonitor.js:514-600) | BUILD | Alert rule on position drops/gains; join to the page-change log and Search Console clicks for the same page. | IMPROVE: the alert says why in plain words ("your Services page title changed on the 3rd"), not only that a number moved. |
| Groups, tags, filters | "Group and tag keywords"; filter by URL, search volume, tags. ([seranking.com/position-tracking.html](https://seranking.com/position-tracking.html)) | All plans | New table seo_keyword (group, tags); today these come from SE Ranking keyword objects (SeoKeywords.tsx:500-520) | BUILD | Columns on seo_keyword; filter in the Rankings route. | MATCH. |
| Share of voice | Share of Voice listed in the plan table. ([seranking.com/subscription.html](https://seranking.com/subscription.html)) | Core, Growth, Enterprise | Derived from the SERP rows (every domain is in the same pull) x volume | BUILD | Formula over seo_position plus competitor rows; dashboard metric comp_share_top10 has no writer today. | MATCH. |
| Traffic forecast | Traffic forecast estimation per keyword. ([seranking.com/position-tracking.html](https://seranking.com/position-tracking.html)) | All plans | Volume x CTR curve (lib/serankingParse.js:213-216), volume from the keyword feed | FEED+BUILD | Keep the formula; put real Search Console clicks beside it. | IMPROVE: forecast shown next to real clicks (Search Console) and real calls/forms (GA4 conversions by landing page, lib/insightsSnapshot.js:174-240). |
| Landing page per keyword | Landing page assignment per keyword. ([seranking.com/position-tracking.html](https://seranking.com/position-tracking.html)) | All plans | The ranking URL in each SERP row; Search Console page+query for queries with impressions | FEED | Store ranking URL on seo_position; flag when it differs from the intended page (cannibalisation). | MATCH. |
| Competitor rankings | Competitor tracking via SERP visibility. ([seranking.com/position-tracking.html](https://seranking.com/position-tracking.html)) | All plans | Same SERP pull; table seo_competitor; caps from the ladder (10/5/3/1) | FEED+BUILD | Store competitor rows from each pull at no extra cost; align Portal caps (SeoCompetitors.tsx:73) with seoOnboarding.js. | MATCH. |

### 2. Local and map rank

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| Local organic rankings | "Organic local rankings" across multiple locations; "Select a city or enter your postal code". ([seranking.com/local-rank-tracker.html](https://seranking.com/local-rank-tracker.html)) | Local keywords daily 1,500 on Core and Growth; locations 3, extra $18.40/mo (subscription page). The local page itself says "Weekly or monthly". | Feed with city or postal location | FEED | Same adapter as the rank tracker. | MATCH. |
| Google Maps rankings | "Maps ranking" in Google Maps (top 20 results); local SERP features; desktop and mobile separately. ([seranking.com/local-rank-tracker.html](https://seranking.com/local-rank-tracker.html)) | As above | DataForSEO Google Maps SERP, $0.0006 per SERP page (Standard; the pricing page bills depth per 100 results) | FEED+BUILD | Maps pull per keyword; find the client's place and competitors by place id. | MATCH. |
| Map grid (geo-grid) | "Map Rank Tracker" with grid-based visualization; "Track rankings for multiple keywords on specific grid points, down to the street level". ([seranking.com/local-marketing-tool.html](https://seranking.com/local-marketing-tool.html)) | Grid sizes not stated on a page read today (help centre returned 403) | Google Maps SERP per grid point; coordinates as the location (the pricing page read today does not say coordinates can be set: confirm in the docs first) | FEED+BUILD | Grid generator (5x5 / 7x7), heat map panel, weekly. Draw it over the service area we already store (GET/PUT /arion/ia-insights/service-area, routes/arion.js:8539-8559). | IMPROVE: grid shown over the business's own service area, so a red cell means "you lose here, inside the area you serve". |
| Local competitors | "Identify your competitors in local search, monitor their local rankings along with yours"; notifications. ([seranking.com/local-rank-tracker.html](https://seranking.com/local-rank-tracker.html)) | As above | Same Maps pull (every listing in the pack) | FEED+BUILD | Store pack rows; alert on entry/exit. | MATCH. |

### 3. Website audit

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| Checks and categories | "115+ metrics" in 13 categories: Security, Crawling & Indexing, Redirects, Sitemap, Meta Tags, Content, Localization, Speed & Performance, JavaScript, CSS, Links, Mobile, Other. ([seranking.com/website-audit.html](https://seranking.com/website-audit.html)) | Pages per month: Core 250k, Growth 2M; max per project Core 250k, Growth 1M (subscription page). The audit page still shows older plan names (Essential 15,000, Pro 40,000, Business unlimited). | Our crawler lib/audit/crawl.js + checks.js (title, description, H1, alt, canonical, viewport, JSON-LD, security headers csp/hsts/frame/nosniff/referrer, contact methods), MAX_PAGES = 10 (crawl.js:19); plugin /content/seo-detail, /content/links, /media/audit | BUILD | Port to arion-func, sitemap-driven, lift the 10-page cap, keep non-2xx, add redirect and canonical chains, noindex from headers, duplicates, thin pages, inlinks, sizes, timings; issue tables seo_audit_run / seo_audit_issue; our score (scope: 140 h). | IMPROVE once built: adds what a local business loses leads on (no click-to-call, no form, phone mismatch) and what Rank Math intends per page, which SE Ranking cannot see. |
| Scheduling | Manual or scheduled audits (weekly/monthly). ([seranking.com/website-audit.html](https://seranking.com/website-audit.html)) | All plans | arion-func timer (new); the monthly PageSpeed timer is the pattern (functions/monthlyPageSpeed.js:15) | BUILD | Weekly for Growth/Authority, monthly below; never started by a page view (today's Overview starts a paid audit, routes/arion.js:2976-2990). | MATCH. |
| JavaScript rendering | "JavaScript rendering capability" for dynamic content. ([seranking.com/website-audit.html](https://seranking.com/website-audit.html)) | All plans | None in our crawler; option DataForSEO On-Page "Load JavaScript" $0.0015 per page | FEED | Only for sites built with a JS framework; WordPress sites serve HTML. Turn on per site. | PARTIAL: not needed for our WordPress sites; bought per page if a client needs it. |
| Compare crawls | "Compare website audit results" across scans. ([seranking.com/website-audit.html](https://seranking.com/website-audit.html)) | All plans | seo_audit_run history | BUILD | Diff issues between two runs: new, fixed, still open. | MATCH. |
| How to fix | Explanations with "How to fix" for each issue type. ([seranking.com/website-audit.html](https://seranking.com/website-audit.html)) | All plans | Plain-words issue text (ours); plugin PUT /pages/{id}/seo writes Rank Math title and description (ia-plugin php:1205-1211) | BUILD | Issue library in plain words; a "Fix it" button for title/description/alt issues that writes through the plugin. | IMPROVE: we fix it on the site, SE Ranking only explains it. |
| Custom rules and crawl settings | Custom crawl parameters, parser settings, "Create custom rules". ([seranking.com/website-audit.html](https://seranking.com/website-audit.html)) | All plans | None | BUILD | User agent, include/exclude paths; custom rules later. | PARTIAL: basic settings only at first. |
| Core Web Vitals | "Core Web Vitals" analysis included. ([seranking.com/website-audit.html](https://seranking.com/website-audit.html)) | All plans | PageSpeed Insights with CrUX field data (lib/pagespeed.js; monthly timer) and the CrUX route (routes/arion.js:5705-5745) | EXISTING-API | Wire the Core Web Vitals page (hard-coded "--" today, SearchCoreWebVitals.tsx:29-31) to stored PSI; PSI per key page. | MATCH. |
| Hreflang, robots meta, status codes, redirect chains | "Robots meta tags", "Hreflang", HTTP status codes and redirect chain detection. ([seranking.com/website-audit.html](https://seranking.com/website-audit.html)) | All plans | Crawler (new rules) | BUILD | Status and redirects in the port; hreflang only parsed when present. | MATCH. |
| Page-level report | Page health ratio, top 5 critical issues; per-page drill-down (audit API: "crawled pages with HTTP status codes, internal/external links"). ([seranking.com/website-audit-api.html](https://seranking.com/website-audit-api.html)) | API: "2M Pages per project" | Crawler page record + plugin seo-meta / seo-detail | BUILD | The existing page drawer (SeoSiteAudit.tsx:1562-1890) reads our record. | MATCH. |
| Reports to inbox, white-label PDF | "Audit reports sent to your inbox"; white-label PDF reports. ([seranking.com/website-audit.html](https://seranking.com/website-audit.html)) | White label with Agency Pack | lib/audit/runner.js + report.js already paint a branded PDF in the caller's branding | EXISTING-API | Reuse the painter for the scheduled audit email. | MATCH. |
| Domain metrics in the audit | Audit report carries domain properties (Domain Trust, backlinks, referring domains, pages indexed, domain expiry), per yesterday's field map of the page we render from it. ([seranking.com/website-audit.html](https://seranking.com/website-audit.html)) | All plans | Link strength (ours); Search Console indexed pages via URL Inspection sample; domain expiry from Hostinger domain info for domains we host (lib/hostinger.js) | FEED+BUILD | RDAP lookup for domains we do not host (not in code today). | PARTIAL: no exact "pages in Google" number exists in any free API. |

### 4. Backlinks

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| Backlink index | "2.9T Backlinks indexed", "428M Domains indexed", "6B Pages crawled daily". ([seranking.com/backlink-checker.html](https://seranking.com/backlink-checker.html)) | Backlink Research on Core, Growth, Enterprise | DataForSEO Backlinks API $0.024 per request + $0.000036 per row, no minimum stated; Bing Webmaster GetLinkCounts / GetUrlLinks free for the client's own site (not called today, lib/bingWebmaster.js) | FEED | Bing first (free), feed for competitors and the score; Growth monthly, Authority weekly. | MATCH: a vendor index either way; DataForSEO's index size was not read today. |
| Domain Trust / Page Trust | "Domain and Page Trust scores" to evaluate likelihood to rank. ([seranking.com/backlink-checker.html](https://seranking.com/backlink-checker.html)) | All plans | Our "link strength" 0-100 from referring domains, normalised across our clients and their competitors | FEED+BUILD | Formula published and labelled ours; fills the always-blank "Your Domain Trust" (SeoCompetitors.tsx:74). | MATCH, labelled as ours. |
| Toxicity score | "Backlink toxicity score". Help centre (search snippet only; the page returned 403): 0-100, five toxic markers, four levels. ([seranking.com/backlink-checker.html](https://seranking.com/backlink-checker.html)) | All plans | Feed rows plus our markers (spam-looking domains, mass anchors, link farms) | FEED+BUILD | Simple markers; plain-words list of links worth a look. | PARTIAL: local businesses rarely need disavow work; we flag, we do not copy SE Ranking's formula. |
| Anchors, dofollow/nofollow, referring domains, most-linked pages | Anchor text analysis, dofollow/nofollow, referring domains, page-level analysis. ([seranking.com/backlink-checker.html](https://seranking.com/backlink-checker.html)) | All plans | Feed backlinks / anchors / referring domains endpoints; existing reports anchor_text_profile, referring_domains (arionMetrics.js:1342-1436) | FEED | Same snapshot table shape as arion.se_ranking_backlink_snapshot. | MATCH. |
| New and lost links | "New and lost referring domains" over time; notifications from 7 days to 1 year. ([seranking.com/backlink-checker.html](https://seranking.com/backlink-checker.html)) | All plans | Our weekly/monthly diff of snapshots (marketMonitor.js:366-470 pattern) | FEED+BUILD | Diff ourselves; alert on lost links from strong domains. | MATCH. |
| Broken backlinks | "Broken backlinks" detection between referring domains and the site. ([seranking.com/backlink-checker.html](https://seranking.com/backlink-checker.html)) | All plans | Feed rows (target URL) checked by our crawler | FEED+BUILD | List links pointing at pages that 404; suggest the redirect. | IMPROVE: folded into one "reclaim" list with unlinked mentions (section B). |
| Backlink gap | Backlink Gap Analyzer comparing up to five competitors. ([seranking.com/backlink-checker.html](https://seranking.com/backlink-checker.html)) | All plans | Feed domain intersection / referring domains for each competitor | FEED | Domains linking to 2+ competitors but not to you, ranked. | MATCH. |
| Backlink monitor tabs and disavow | Help centre (search snippet only; 403 to fetch): tabs Backlinks, Domains, Anchors, Pages, IPs/Subnets, Disavow. ([help.seranking.com/hc/en-us/articles/16332614394268](https://help.seranking.com/hc/en-us/articles/16332614394268)) | Not read | Feed rows | BUILD | Disavow file export only; IP/subnet view skipped. | PARTIAL: disavow export kept, subnet analysis skipped. |

### 5. Keyword research

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| Database and countries | "3.2B Europe, 1.2B North America, 548M Asia"; 188 geographic databases. MCP page: "5.5 billion keywords". ([seranking.com/keyword-suggestion-tool.html](https://seranking.com/keyword-suggestion-tool.html)) | Keyword Database: Core 17.5k, Growth 50k | DataForSEO Labs (keyword ideas) $0.012 per task + $0.00012 per item; Google Ads volume $0.06 per task of up to 1,000 keywords; 30-day cache | FEED+BUILD | Adapter + cache; move the Content Agent keyword provider and its CHECK constraint (lib/contentAgent/keywordProviders.js:30). | MATCH. |
| Volume, CPC, competition, trend | "Search volume" with monthly changes and yearly dynamics; "CPC"; competition for organic and paid. ([seranking.com/keyword-suggestion-tool.html](https://seranking.com/keyword-suggestion-tool.html)) | All plans | Google Ads volume via the feed; Bing GetKeywordStats free (called with an empty query today, lib/bingWebmaster.js:257) | FEED | Fix the Bing call; cache volumes 30 days. | MATCH. |
| Keyword difficulty | "Keyword difficulty" scoring. ([seranking.com/keyword-suggestion-tool.html](https://seranking.com/keyword-suggestion-tool.html)) | All plans | Labs keyword difficulty (same Labs price) or our own from the SERP pull (strength of the top 10) | FEED+BUILD | Pick one and label it. | MATCH. |
| Search intent | "Search Intent" (informational, commercial, transactional, local). ([seranking.com/keyword-suggestion-tool.html](https://seranking.com/keyword-suggestion-tool.html)) | All plans | Labs search intent $0.012 per task + $0.00012 per keyword | FEED | Store on seo_keyword. | MATCH. |
| Similar, related, questions, long-tail | Similar, related, question-based, "Low-search-volume suggestions"; bulk analysis. ([seranking.com/keyword-suggestion-tool.html](https://seranking.com/keyword-suggestion-tool.html)) | All plans | Labs ideas; Bing related keywords (free); Search Console queries; GBP monthly search keywords (lib/insightsSnapshot.js:588-620); Claude for question variants | FEED+BUILD | Merge, de-duplicate, volume-check. | IMPROVE: ideas start from words the business's customers already typed (Search Console, Business Profile searches), not only a database. |
| SERP overview and ads history | Organic SERP with metrics, SERP features, organic history, "Ads history", top-page Domain/Page Trust, backlinks, traffic. ([seranking.com/keyword-suggestion-tool.html](https://seranking.com/keyword-suggestion-tool.html)) | All plans | One SERP pull + backlinks summary per top domain | FEED+BUILD | Panel on the Keywords page; ads history skipped. | PARTIAL: organic yes, paid history skipped (paid search out of scope). |
| Keyword Grouper | Clusters by SERP similarity; accuracy set by "the minimum number of matching URLs"; volume check adds "$0.005 per query". ([seranking.com/keyword-grouper.html](https://seranking.com/keyword-grouper.html)) | Included from Core | Our SERP pulls (URL overlap); cannibalisation detection already in lib/arionMetrics.js:640-690 | BUILD | Cluster by shared top-10 URLs; name by highest-volume keyword. | MATCH: clusters come from pulls we already make. |

### 6. Competitive research

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| Organic traffic estimate | "Monthly clicks estimated with AI"; history back to February 2020. ([seranking.com/competitor-traffic-research.html](https://seranking.com/competitor-traffic-research.html)) | Competitive Research unlimited on all plans | Labs domain rank overview / ranked keywords, $0.012 per task + $0.00012 per item | FEED | Monthly per competitor; history from our own snapshots. | MATCH. |
| Paid traffic, ad copies, advertisers | Google Ads campaign tracking, "Monthly ad history", ad copy data, CPC and number of advertisers. ([seranking.com/competitor-traffic-research.html](https://seranking.com/competitor-traffic-research.html)) | All plans | None | SKIP | Paid-search research is out of scope (scope section 10). | SKIP: not part of what we sell. |
| Competitor keywords, new/lost | "Keyword rankings, new and lost keyword statistics". ([seranking.com/competitor-traffic-research.html](https://seranking.com/competitor-traffic-research.html)) | All plans | Labs ranked keywords | FEED | Monthly snapshot; diff. | MATCH. |
| Top pages, new pages | Top-performing competitor pages; "Discover new pages and keywords competitors started ranking for". ([seranking.com/competitor-traffic-research.html](https://seranking.com/competitor-traffic-research.html)) | All plans | Labs relevant pages + their sitemap.xml (replaces SE Ranking /domain/overview, routes/arion.js:3997-4000) | FEED+BUILD | Sitemap diff gives new pages for free; Labs adds traffic. | MATCH. |
| Keyword and content gap | Keyword overlap; "Flag content quality gaps using Content Score benchmarks". ([seranking.com/competitor-traffic-research.html](https://seranking.com/competitor-traffic-research.html)) | All plans | Our SERP pulls (gap on tracked keywords) + Labs domain intersection (whole-site gap) | FEED+BUILD | Content Gap table today (SeoCompetitors.tsx:225-238) reads our tables. | MATCH. |
| CTR vs SERP rivals | CTR performance comparisons versus SERP rivals. ([seranking.com/competitor-traffic-research.html](https://seranking.com/competitor-traffic-research.html)) | All plans | Search Console CTR vs expected CTR at that position: ctr_opportunity report (lib/arionMetrics.js:378-430) | EXISTING-API | Show on the SEO pages. | IMPROVE: real clicks from Search Console, not an estimate. |
| Subdomains | Subdomain tracking. ([seranking.com/competitor-traffic-research.html](https://seranking.com/competitor-traffic-research.html)) | All plans | None | SKIP | Rare for local businesses. | SKIP. |

### 7. On-page checker

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| Page vs keyword check | Seven categories (content, key elements, links, general, page experience, indexing, images); "1 primary and up to 30 secondary keywords"; benchmarks against "top-ranking competitor landing pages"; tasks to do/done/ignore. ([seranking.com/on-page-checker.html](https://seranking.com/on-page-checker.html)) | Checks: Core 50/mo, Growth 1,000/mo | Plugin /seo-meta and /content/seo-detail per URL + crawler as-served view + PSI per URL + the page's Search Console queries + top-10 pages fetched from the SERP pull | FEED+BUILD | One report route and panel (scope: 24 h); tasks stored with status. | IMPROVE: uses the queries the page really gets and fixes title/description in place through the plugin. |

### 8. Content marketing

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| Content Editor | Real-time "Content Score", NLP terms, TF*IDF, headings, Google Docs add-on, sharing and comments. ([seranking.com/content-editor.html](https://seranking.com/content-editor.html)) | Articles: Core 25, Growth 50, extra $39.20/mo | Content Agent (lib/contentAgent: drafting, guardrails, styleProfile, publisher) | BUILD | Add a content score to the draft review (terms from the top 10 of the SERP pull); no live editor. | PARTIAL: we write and publish; a live scoring editor is not built. |
| AI Writer | "Generate an article in 1 click"; tones; facts input; images and ALT; meta titles and descriptions; English only. ([seranking.com/ai-writer.html](https://seranking.com/ai-writer.html)) | Same article counts; the AI Writer page still quotes an old "$29/mo for 15 articles" add-on | Content Agent drafting with Claude (lib/contentAgent/drafting.js), brand voice (styleProfile, lumen.brand_voice_profile), publisher to WordPress, Rank Math fields | EXISTING-API | Move its keyword provider off SE Ranking. | IMPROVE: writes in the business's own voice and publishes to their site on a schedule. |
| Grammar, plagiarism, readability | Grammar and plagiarism checks; readability and typo checks. ([seranking.com/content-marketing-platform.html](https://seranking.com/content-marketing-platform.html)) | As above | Content Agent guardrails; plugin readability per page | BUILD | Plagiarism check not built (a paid source would be needed; not priced today). | PARTIAL. |
| Article analytics | "impressions, clicks, CTR, and average position" via Search Console "daily updates". ([seranking.com/content-marketing-platform.html](https://seranking.com/content-marketing-platform.html)) | As above | Search Console live + monthly snapshot (lib/googleServices.js:84-190; insightsSnapshot.js:60-170); GA4 conversions | EXISTING-API | Per-article panel. | IMPROVE: adds calls and forms per article from GA4, not only clicks. |
| WordPress publishing | WordPress integration; "Hit 'publish'". ([seranking.com/content-marketing-platform.html](https://seranking.com/content-marketing-platform.html)) | As above | IA plugin + Content Agent publisher | EXISTING-API | None. | MATCH. |

### 9. Local marketing

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| Business Profile management | Manage business information; NAP updates across GBP, Facebook, Apple and Bing; create profiles. ([seranking.com/local-marketing-tool.html](https://seranking.com/local-marketing-tool.html)) | Locations 3 on Core and Growth, extra $18.40/mo | GBP create-listing and verification (routes/arion.js:1599-1922); profile read/patch (routes/arion/gbp.js:9-32) | EXISTING-API | Facebook, Apple Business Connect and Bing Places not connected. | PARTIAL: Google done; Apple and Bing Places are worth adding (they feed Apple Maps and Bing). |
| Business Profile posts | "Plan, create, and publish posts directly from the platform"; location, type, media, dates. ([seranking.com/local-marketing-tool.html](https://seranking.com/local-marketing-tool.html)) | GBP Posts on all plans | /arion/business/posts (routes/arion.js:6163-6296) via gbpApi localPosts; SPARK social posting | EXISTING-API | None. | MATCH. |
| Reviews | Reviews from Google, Facebook, Apple, Bing, Yelp, TripAdvisor; filter; AI semantic insights; reply; export. ([seranking.com/local-marketing-tool.html](https://seranking.com/local-marketing-tool.html)) | All plans | GBP reviews + reply (routes/arion/gbp.js:92-121); AI reply drafts in brand voice (lib/gbpAiReply.js, Claude Haiku) and auto-reply worker (lib/gbpReplyRunner.js) | EXISTING-API | Other platforms not read; competitor Google reviews via DataForSEO Google Reviews $0.00075 per 10 reviews. | PARTIAL: Google is better than theirs (auto-reply in the business's voice); other review sites are not covered. |
| Listings and citations | "Automatically scanning top local directories"; finds missing or inconsistent NAP; Directories "100+ worldwide". ([seranking.com/subscription.html](https://seranking.com/subscription.html)) | Directories 100+ on Core and Growth | None today | FEED+BUILD | Find listings by searching the business name and phone (SERP feed) and reading each listing page with our crawler; compare to GBP. Business Listings feed not priced today. | PARTIAL: we find and report wrong listings; we do not push updates to 100 directories. |
| Business Profile insights | Track impressions, clicks, direction requests, calls, photo views (integrations page). ([seranking.com/integrations.html](https://seranking.com/integrations.html)) | All plans | GBP Performance daily metrics and monthly search keywords (lib/insightsSnapshot.js:496-620) | EXISTING-API | None. | IMPROVE: joined to bookings and forms in Insights, so calls from the profile sit next to booked jobs. |

### 10. AI search

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| Engines | AI Overviews, AI Mode, ChatGPT, Gemini, Perplexity. SE Visible: Claude "will be added soon". ([seranking.com/ai-visibility-tracker.html](https://seranking.com/ai-visibility-tracker.html)) | LLMs to track: 5 on Core and Growth; prompts daily Core 100, Growth 250 | AI Overview via the SERP pull (load_async_overview, +1 base price); AI Mode $0.0012 per page; ChatGPT and Gemini via LLM Scraper $0.0012 ("only ChatGPT and Gemini are supported"); Claude by our Anthropic key; Perplexity by its API (price not read today) | FEED+BUILD | Runner, engine adapters, answer store seo_ai_answer (scope: 90 h). | IMPROVE: Claude added as an engine, which SE Ranking does not track yet. |
| Prompts | Add custom prompts; scheduled daily tracking in groups. ([help.seranking.com/hc/en-us/articles/22120452776476-AI-Search-Add-on](https://help.seranking.com/hc/en-us/articles/22120452776476-AI-Search-Add-on)) | Add-on (search snippet; page not fetched): 200 prompts $71, 450 $143, 1,000 $276 per month billed annually; subscription page: AI Search add-on $89/mo or $71.20 annual | Table seo_prompt; tier caps (Growth 5 prompts x 2 engines, Authority 5 x 4) | BUILD | Prompt list per site; daily or weekly by tier. | MATCH: fewer prompts by design, at cents a month. |
| Mentions, links, position in answer | "Monitor brand mentions and links"; linked and unlinked references; how mentions "rank in AI answers". ([seranking.com/ai-visibility-tracker.html](https://seranking.com/ai-visibility-tracker.html)) | As above | Our parser over the stored answer text | BUILD | Brand and domain match, order of first mention, linked yes/no. | MATCH. |
| Sources and citations | "Map domains and URLs that appear in AI answers"; "Categorize sources by type: media, blogs, forums". ([seranking.com/ai-visibility-tracker.html](https://seranking.com/ai-visibility-tracker.html)) | AI Sources Tracking unlimited | Citations from web-search answers and the AI Overview block | FEED+BUILD | Store cited URLs; type by simple rules. | MATCH. |
| Competitors in AI answers | "Add up to five competitors and track presence over time". ([seranking.com/ai-visibility-tracker.html](https://seranking.com/ai-visibility-tracker.html)) | AI Competitive Domains: Core 5, Growth 15 | Competitor list + named businesses in the answer (Claude extraction) | BUILD | Extraction prompt; counts per engine. | MATCH. |
| Answer text and how the brand is described | View "real responses from ChatGPT"; "how ChatGPT describes your brand". ([seranking.com/chatgpt-visibility-tracker.html](https://seranking.com/chatgpt-visibility-tracker.html)) | As above | Stored full answer per engine per prompt | BUILD | Show the answer; Claude writes one sentence on what is wrong or missing and which page or fact would fix it. | IMPROVE: plain-words action from the answer text ("ChatGPT says you do not serve Plano; your Service Area page does not name it"). |
| Sentiment | SE Visible: "Sentiment analysis of AI-generated answers". ([visible.seranking.com](https://visible.seranking.com)) | SE Visible Basic $99/mo 200 prompts, Core $189/mo 450, Plus $355/mo 1,000 | Claude over the stored answer | BUILD | Positive / neutral / negative per mention. | MATCH. |
| Prompt discovery and AI traffic | AI Visibility API: "Every prompt where a brand or domain appears, with its search volume, the full LLM answer text, and its links"; AI traffic estimates. ([seranking.com/ai-visibility-api.html](https://seranking.com/ai-visibility-api.html)) | API credits | DataForSEO LLM Mentions API $0.1 per request + $0.001 per row | FEED | Monthly on Authority: suggests prompts to track. | MATCH on the top tier. |
| AI Overview snapshots and history | "Review cached copies of search results with AI-generated answers"; "day-by-day position changes". ([seranking.com/ai-overviews-tracker.html](https://seranking.com/ai-overviews-tracker.html)) | As above | Raw SERP JSON stored per pull | BUILD | Keep the AI block text and links per day. | MATCH. |
| Markets and languages | "across 7 supported markets"; "five languages". ([seranking.com/ai-visibility-tracker.html](https://seranking.com/ai-visibility-tracker.html)) | As above | US English by default | SKIP | Add a market only when a client needs it. | SKIP for now: our clients are US local businesses. |
| ChatGPT Ads and AI Mode Ads trackers | Detects sponsored placements, "the advertiser and the link it carries", month-over-month share of voice; inside Competitive Research. ([seranking.com/chatgpt-ads-tracker.html](https://seranking.com/chatgpt-ads-tracker.html)) | No separate subscription (page) | None | SKIP | Paid placements are out of scope; revisit if clients buy AI ads. | SKIP. |

### 11. Page changes

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| Webpage monitor | Alerts on content, meta tags, links, robots.txt and index status in Google, Bing and Yahoo; change history. ([seranking.com/page-changes-monitoring.html](https://seranking.com/page-changes-monitoring.html)) | Page Changes Monitoring: Core no, Growth yes (subscription page) | arion-func page-change watcher, daily (shared/marketMonitor.js:514-600); index status from Search Console URL Inspection (routes/arion.js:4845-4900) and Bing | BUILD | Fix the 100 % magnitude defect (marketMonitor.js:528/550); diff by element (title, description, H1, canonical, robots.txt, status). | IMPROVE: on every tier (SE Ranking: Growth only) and joined to the ranking move it caused. |

### 12. Indexing

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| Index status and submission | Index status in Google, Bing, Yahoo (page monitor). ([seranking.com/page-changes-monitoring.html](https://seranking.com/page-changes-monitoring.html)) | Growth | Search Console URL Inspection and sitemaps; Bing URL submission; IndexNow (routes/arion.js:5022, 5339, 5647) | EXISTING-API | Fix the Sitemaps page reading the wrong route (SearchSitemaps.tsx:13-21). | IMPROVE: we submit pages to Google, Bing and IndexNow, not only read their status. |

### 13. Reports and dashboards

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| Report builder | "Create unlimited SEO report templates"; PDF, XLS, HTML. ([seranking.com/seo-reporting-tools.html](https://seranking.com/seo-reporting-tools.html)) | Project Insights/Reports: Core 10, Growth 30; export rows 50k / 100k | Reports page is five static cards with a dead button today (SeoReports.tsx:5-48); PDF painter exists (lib/audit/report.js) | BUILD | Report page, per-client templates, PDF (scope: 40 h). | PARTIAL now, MATCH after the build. |
| Scheduled reports | "schedule automatic report delivery to clients' inboxes"; sent from the agency's domain. ([seranking.com/seo-reporting-tools.html](https://seranking.com/seo-reporting-tools.html)) | Unlimited scheduled reports with Agency Pack | Monthly Insights review email and the outbox (iadm-webhooks sender) | BUILD | Per-client SEO report on a schedule through the same outbox. | MATCH. |
| AI summaries | Agency Pack: "unlimited scheduled reports with AI summaries". ([seranking.com/subscription.html](https://seranking.com/subscription.html)) | Agency Pack | Insights review email: scores, one-sentence why, reports | EXISTING-API | Reuse for the SEO report. | IMPROVE: the summary is tied to leads and bookings, not only rankings. |
| Guest links | "Guest links for easy access to project data"; view-only. ([seranking.com/seo-reporting-tools.html](https://seranking.com/seo-reporting-tools.html)) | Guest Links: Core no, Growth yes | Keyed-link pattern already in lib/audit/links.js | BUILD | Read-only keyed link to a report. | MATCH. |
| Looker Studio | "Pull rankings, audit data, and keyword metrics into your dashboards". ([seranking.com/integrations.html](https://seranking.com/integrations.html)) | All plans | None; the Portal is the dashboard | SKIP | None. | SKIP: our clients use our Portal. |
| SEO dashboard | Widgets for key metrics, rankings, audit, backlinks, analytics, competitive research; drag-and-drop; guest links. ([seranking.com/seo-dashboard.html](https://seranking.com/seo-dashboard.html)) | All plans | Portal SEO Overview (SeoOverview.tsx) and dashboards (arionDashboards.ts) | EXISTING-API | Fill the five dashboard metrics with no production writer (kw_visibility, bing_clicks, bing_impressions, comp_share_top10, comp_avg_gap). | PARTIAL: fixed layout, no drag-and-drop. |
| Insights (automatic findings) | Easy-to-improve keywords, competitor movement, cannibalisation, content quality gaps, traffic fluctuations over 28 days, new competitor content. ([seranking.com/insights.html](https://seranking.com/insights.html)) | Not stated per plan | striking_distance, ctr_opportunity, cannibalisation (lib/arionMetrics.js:378-690), competitor moves (Market Monitor), Insights review | EXISTING-API | Move striking_distance to Search Console positions; add new competitor pages from sitemap diffs. | IMPROVE: findings ranked by leads and bookings at stake. |

### 14. Agency pack

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| White label | Custom domain, logo, colours, sender name and reply-to, hide "any references to SE Ranking". ([seranking.com/white-label.html](https://seranking.com/white-label.html)) | Agency Pack $69/mo, annual only | Our own Portal and customer portal; agency branding in lib/emailTemplates.js and lib/brandKitClient.js | EXISTING-API | Remove SE Ranking's name from 38 Portal files (scope). | MATCH: it is our product, not a resold one. |
| Client seats | Subscription page: 30 client seats; agency page: 10 included. ([seranking.com/subscription.html](https://seranking.com/subscription.html)) | Agency Pack | Client portal logins per business (CIAM) | EXISTING-API | None. | IMPROVE: no seat cap. |
| Lead Generator widget | "4 widget styles", customizable form, on-page audit report for the visitor, notifications, blacklist, Zapier; up to "10 free leads per day". ([seranking.com/lead-generation.html](https://seranking.com/lead-generation.html)) | Agency Pack (agency page: up to 100 user emails monthly) | "Website check" custom action: routes/audit.js (POST /audit/runs, signed), lib/audit/runner.js (branded PDF, keyed links, daily limit, signed callback), owner view /arion/audit/runs | EXISTING-API | None for parity. | MATCH: already built and branded per agency. |
| Agency Catalog | Listed in SE Ranking's Agency Catalog. ([seranking.com/agency-pack.html](https://seranking.com/agency-pack.html)) | Agency Pack | None | SKIP | Out of scope (scope section 10). | SKIP. |
| Manager seats and permissions | Manager seats Core 1, Growth 3, extra $16/mo; customizable permissions. ([seranking.com/subscription.html](https://seranking.com/subscription.html)) | As stated | Our role model (roles system) | EXISTING-API | None. | MATCH. |

### 15. API and MCP

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| Data and Project APIs | Keyword, Backlinks, Domain Analysis, Website Traffic, Website Audit, AI Visibility APIs; "10 requests per second". ([seranking.com/api.html](https://seranking.com/api.html)) | Credits: Core 25K, Growth 100K (subscription); API add-on $45/mo annual for 3M; standalone from $179/mo; pay-as-you-go $50 per 250K. api.html also says an add-on "$149/month" (the pages disagree). | We consume feeds; our routes serve our Portal | SKIP | No public API product. | SKIP: we are not selling data access. |
| MCP and Claude skills | "180+ SEO and GEO tools" for Claude, Cursor and others; skills for briefs, AI visibility, backlink gap. ([seranking.com/mcp.html](https://seranking.com/mcp.html)) | Included; uses API credits | ARGUS chat tools and playbooks (lib/argus) could read our SEO tables | BUILD | Later: register SEO tools (rankings, audit, AI answers) for the agency chat. | PARTIAL: later, through our own chat, not an external MCP. |

### 16. Integrations

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| Google Analytics 4 and Search Console | "Correlate visibility with traffic, sessions, and conversions"; "Compare GSC impressions and clicks against keyword positions". ([seranking.com/integrations.html](https://seranking.com/integrations.html)) | All plans | lib/googleServices.js (GA4 Data API, Search Analytics), lib/insightsSnapshot.js | EXISTING-API | Fix /search/performance property guess and token reader (routes/arion.js:4740-4744). | MATCH. |
| Matomo, Whatagraph, AgencyAnalytics, Reportz, Zapier, Make, n8n, Appy Pie, Wix | Listed integrations for analytics, reporting and automation. ([seranking.com/integrations.html](https://seranking.com/integrations.html)) | All plans | Our own workflows and playbooks | SKIP | None. | SKIP: these connect SE Ranking to tools we replace. |
| Facebook, Apple Business Connect, Bing Places | Listing accuracy and review replies on Facebook, Apple Maps and Bing. ([seranking.com/integrations.html](https://seranking.com/integrations.html)) | All plans | None today | BUILD | Apple Business Connect and Bing Places first (access terms not read today). | PARTIAL. |
| WordPress | "Export articles from SE Ranking's Content Editor directly to WordPress". ([seranking.com/integrations.html](https://seranking.com/integrations.html)) | All plans | IA plugin (reads and writes Rank Math, links, media) | EXISTING-API | Call /content/links and /media/audit (not called today). | IMPROVE: two-way; we read the site's SEO settings and write fixes. |

### 17. SERP analyzer

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| SERP Tracker / analyzer | "Check up to the top 50 organic results"; "110+ on-page and off-page metrics"; side-by-side with competitors. ([seranking.com/serp-tracking.html](https://seranking.com/serp-tracking.html)) | Free: top 3-5; paid: top 50 | SERP pull + our crawler on the top pages + backlinks summary | FEED+BUILD | Inside the on-page checker: compare to the top 10. | PARTIAL: top 10 compared, not 50. |

### 18. Marketing plan

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| SEO task manager | Step-by-step tasks; custom tasks with priority, deadline, status; progress; export. ([seranking.com/marketing-plan.html](https://seranking.com/marketing-plan.html)) | All paid plans | Audit issues + on-page tasks + Insights recommendations | BUILD | One fix list per site with status; generated, not a generic checklist. | IMPROVE: the list is built from the site's own findings. |

### 19. Free tools

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| 34 free tools | Rank checker, traffic checker, CMS, subdomain, domain age/expiry, WHOIS, authority, word counter, title checker, rewriters, robots tools, redirect checker, speed, mobile test, ChatGPT fan-out extractor and more. ([seranking.com/free-tools.html](https://seranking.com/free-tools.html)) | Free | Website check covers speed, titles, robots, redirects, mobile viewport, security headers | SKIP | Marketing tools, not client features. | SKIP beyond the Website check. |

### 20. Social media

| Feature | SE Ranking, as read (page, 10 Oct 2026) | Plan limit as read | Our replacement (source) | Kind | What we build | Verdict |
|---|---|---|---|---|---|---|
| Planable | Basic $33/mo (60 posts, 4 pages), Pro $49/mo; 9 platforms including Google Business Profile; 20% off bundled with SE Ranking. ([planable.io/pricing/](https://planable.io/pricing/)) | Separate product | SPARK posting; GBP posts | EXISTING-API | None. | MATCH (out of this scope). |

**Totals:** 96 features in 20 modules: MATCH 47, IMPROVE 22, PARTIAL 18, SKIP 9.

---

## B. The extra at Growth and Authority: the mention finder

You said it this afternoon: nobody searches for the places a business is named but not linked properly, and our backlink checker can do it. Here is how, from what we already buy plus one cheap search.

**What it finds, one list per client, in plain words:**
1. **Named, not linked.** A page names the business (name, phone, owner, or an old name or old domain) and has no link to the site. Ask for the link.
2. **Linked to the wrong place.** The link goes to a page that now returns 404, to an old domain, to the http version, or to the home page when the page is about one service or one location. Ask for the right URL, or add a redirect ourselves.
3. **Linked, wrong details.** The page links to us but prints an old phone number, an old address or the wrong hours. This also hurts the Map Pack, because Google compares these details across the web.
4. **Mention gap.** A page names two or more competitors but not the client: "best plumbers in Ames" lists, chamber and sponsor pages, local news. These are the easiest pages to get onto.
5. **AI sources missing you.** Pages that ChatGPT, Gemini or Google's AI cite for the client's prompts (we store the citations, module 10) where the client is not named. These go to the top of the list, because they shape what the AI says.

**How it works:**

| Step | Source | Cost |
|---|---|---|
| Find pages naming the business (name variants, phone, owner, old names) | DataForSEO Content Analysis search: "list of web sources citing the target keyword", with page details and sentiment | $0.024 per request + $0.000036 per row; $0.06 for 1,000 rows |
| Find pages linking to the business | The backlink rows we already pull for Growth and Authority (module 4); Bing Webmaster inbound links, free | already paid |
| Join them: named but not linking, linking to a bad target | our code | $0 |
| Read each page for the phone, address and link target | our crawler (the same one as the site audit) | $0 |
| Compare to the Business Profile | Business Profile data we already hold (routes/arion/gbp.js) | $0 |
| Draft the ask | Claude writes a short, polite email per page; the owner sends it | tokens only |
| Mention gap and AI sources | Content Analysis on competitor names; stored AI citations | $0.06 per competitor name |

**Tiers:** Growth monthly on the client's own names ($0.18 a month). Authority weekly ($0.78 a month), plus the competitors' mention gap monthly (+$0.60). Not offered below Growth, because those tiers carry no backlink data to join against.

**Does SE Ranking do this?** Not on any page read today. Their backlink checker lists "Broken backlinks" and new or lost links, and their AI tracker "Tracks both linked and unlinked brand references" inside AI answers. Neither page offers a search of the open web for unlinked mentions, wrong details or a mention gap.

**Build:** about 24 hours on top of the backlink work (one adapter call, the join, the page read, the list page, the email draft). The rule stays that the owner clicks send; nothing goes out by itself.

---

## C. Thinking outside the box: audit checks nobody runs today

Your note mentioned the last audit plan we ran through; it was not attached to this task and no file by that name is in `overnight-report/`, so this list stands on its own and should be merged with that plan when you point me to it. "SE Ranking" means a page read today names the check; "Us today" means our code runs it today.

| # | Check | Why it matters, plainly | Source | SE Ranking | Us today |
|---|---|---|---|---|---|
| 1 | AI crawlers allowed: robots.txt rules for GPTBot, OAI-SearchBot, Google-Extended, PerplexityBot, ClaudeBot; firewall or CDN bot blocking | A site that blocks them cannot be read or cited by AI answers | our crawler reads robots.txt (lib/audit/robots.js); test fetch with each user agent | No | robots.txt read, AI agents not checked |
| 2 | Phone on the site matches the Business Profile, the schema and the top listings | Mismatched details lower Map Pack trust and send calls to old numbers | crawler + GBP profile + mention finder | Listings only (directory scan) | No |
| 3 | Business Profile website link carries UTM tags | Without them, GA4 lumps Profile visits into "organic" and we cannot show what the Profile brings | GBP profile (websiteUri) | No | No |
| 4 | Business Profile link goes to the right page (location page, not the home page, for multi-location) | Google ranks the listing partly on the page it links to | GBP profile + crawler | No | No |
| 5 | Every Profile service and category has a page on the site | Gaps lose "near me" searches for that service | GBP profile + plugin page list | No | No |
| 6 | Hours on the site match the Profile and the schema `openingHours` | Wrong hours cost visits and trust | crawler + GBP profile | No | No |
| 7 | LocalBusiness schema is the right subtype, with `areaServed`, `sameAs` to profiles, and no self-serving review stars | Google ignores or penalises wrong review markup; AI engines read `sameAs` to tie the business together | crawler (JSON-LD already parsed, lib/audit/checks.js:228) | Structured data in general | Types only |
| 8 | Service x city coverage against the service area we store | Shows which towns in the area have no page and no ranking | /ia-insights/service-area + plugin pages + map grid | No | No |
| 9 | Click-to-call link, a working form and a booking link on every money page, visible on mobile without scrolling | Rankings that do not turn into calls are wasted | crawler (contactChecks already in lib/audit/checks.js:365) | No | Home page in the Website check only |
| 10 | Form notification emails actually arrive (SMTP set, SPF/DKIM/DMARC on the domain) | A form that "works" but whose emails land in spam loses every lead | DNS lookup (new) + plugin /plugins list (is an SMTP plugin active; php:781) | No | No |
| 11 | Search-to-lead join: which queries and pages bring calls, forms and bookings | Turns SEO into money; the report leads with it | GA4 conversion events by landing page (lib/insightsSnapshot.js:174-240) + bookings + Search Console | No | In Insights, not on the SEO pages |
| 12 | Pages losing clicks that used to bring leads (decay weighted by leads) | Fix the pages that cost money first | Search Console 16 months + GA4 conversions | Traffic fluctuations only | Decay without leads |
| 13 | Review velocity and reply time against the top three Map Pack competitors | Recent reviews are a ranking and trust signal | GBP reviews (ours) + DataForSEO Google Reviews ($0.00075 per 10) for competitors | Own reviews only | Own reviews only |
| 14 | Spam competitor listings in the Map Pack (keyword-stuffed names, fake addresses) | Reporting them can move the client up without any work on the site | Maps pull + Claude check against simple rules; the owner files the report | No | No |
| 15 | Duplicate or unverified Profiles for the same business | Duplicates split reviews and rankings | Maps pull by phone and name | No | No |
| 16 | Apple Business Connect and Bing Places present and matching | They feed Apple Maps and Siri, and Bing (and so Copilot) | manual check first; APIs later (access terms not read today) | Listings sync | No |
| 17 | Domain expiry, SSL expiry, DNS health | An expired domain or certificate takes the site and email down | Hostinger domain info for domains we host (lib/hostinger.js); RDAP and a TLS check otherwise | Domain expiry in the audit | Hostinger-hosted only |
| 18 | WordPress core, plugins and PHP out of date | Security and speed; ties to the upkeep notices you want to send | plugin /health, /plugins and /plugins/risk-analysis (php:775-997) | No | Plugin endpoints exist; no audit check or client notice yet (upkeep notices scope) |
| 19 | Analytics integrity: one GA4 tag, conversions defined, Search Console on the domain property, Bing verified | Bad tracking makes every report wrong | GA4 Admin API (not called today) + Search Console and Bing calls we already make | No | Partly (Search Console property resolution exists) |
| 20 | Images too heavy or unused; missing alt on money pages | Speed and accessibility; AI readers use alt text | plugin /media/audit (built, not called by arion today) | Image checks | No |
| 21 | Orphan service pages and weak internal links from blog posts to money pages | Pages with no internal links rank poorly | plugin /content/links (built, not called today) | Links in the crawl | No |
| 22 | Facts the AI engines need, written on the site: services, prices or ranges, service area, years in business, licences | AI answers quote what the site states; missing facts get guessed or left out | stored AI answers + the site's pages (Claude compares) | No | No |
| 23 | Call-tracking numbers printed in the site's text or schema | They break name-address-phone consistency | crawler compares numbers to the Profile | No | No |
| 24 | Accessibility basics (labels on form fields, contrast, headings in order) | Lawsuit risk for US businesses, and the same structure helps AI readers | crawler rules; Lighthouse accessibility score (PageSpeed is already called with category accessibility, lib/pagespeed.js:96) | No | PageSpeed score stored, not shown |

---

## D. What we already cover through Search Console and our other connected APIs (free)

| Source (connected today) | What it gives | Code | Which SE Ranking feature it covers or beats |
|---|---|---|---|
| Google Search Console, Search Analytics | Clicks, impressions, CTR, average position by query, page, device, country, date; 16-month monthly snapshot | lib/googleServices.js:84-190; lib/insightsSnapshot.js:60-170; routes/arion.js:4712-4800 | Traffic fluctuations (Insights), article analytics, CTR vs rivals, striking-distance keywords, the GA4/GSC integration |
| Search Console URL Inspection and sitemaps | Google's index verdict per URL; sitemap list and submit | routes/arion.js:4845-4900, 5319-5339 | Index status in the page monitor; sitemap checks in the audit |
| Bing Webmaster Tools | Query, page, rank and traffic stats, crawl stats, URL submission, sitemaps; keyword stats (called with an empty query, a defect); inbound links (available, not called) | lib/bingWebmaster.js:71-330; routes/arion.js:5392-5700 | Bing index status; own-site backlinks for free once called; Bing keyword volume once fixed |
| IndexNow | Instant URL submission to Bing and others | routes/arion.js:5022 | Nothing in SE Ranking submits pages |
| Google Business Profile | Profile read and edit, create and verify a listing, posts, reviews and replies, AI reply drafts and auto-reply, Performance metrics (calls, directions, website clicks, impressions), monthly search keywords | routes/arion/gbp.js; routes/arion.js:1318-1922, 6163-6296; lib/gbpAiReply.js; lib/gbpReplyRunner.js; lib/insightsSnapshot.js:496-620 | GBP management, posts scheduler, reviews (Google), GBP insights |
| PageSpeed Insights with CrUX | Lab scores and real-visitor Core Web Vitals, monthly and on demand | lib/pagespeed.js; arion-func functions/monthlyPageSpeed.js; routes/arion.js:5705-5745 | Core Web Vitals in the audit and on-page checker |
| GA4 | Sessions and conversion events (calls, forms, emails) by source and landing page | lib/googleServices.js:191; lib/insightsSnapshot.js:174-240 | "Correlate visibility with traffic, sessions, and conversions", done in our own Insights |
| IA plugin | Rank Math title, description, focus keyword, robots, score per page; word count, schema type, noindex; links graph and orphans; media audit; write page SEO fields | ia-plugin intelligent-analytics.php:806, 946-1011, 1205-1211, 3285-3760 | On-page checker inputs, audit fixes in place, content library |
| Our page-change watcher | Daily fetch, hash and diff of watched pages | arion-func shared/marketMonitor.js:514-600 | Page Changes Monitoring (a Growth-only feature at SE Ranking) |
| Our Website check | Branded audit PDF for a visitor, keyed links, daily limit, owner view | routes/audit.js; lib/audit/*; routes/arion/siteAudits.js | Lead Generator widget |
| Content Agent | Topic choice, drafts in the brand voice, guardrails, publishing to WordPress | lib/contentAgent/* | AI Writer, content publishing |
| SPARK | Social posting | (SPARK app) | Planable |

---

## E. Where SE Ranking's own pages disagree (read today)

- **API price:** the subscription page sells the API add-on at $45 a month (annual only, 3M credits); https://seranking.com/api.html says an "API Add-On: $149/month" and also "API access is included in every SE Ranking plan".
- **Credits on Core:** the subscription page says 25K API credits on Core; the rank tracker page says "Core plan: 100,000 credits/month".
- **Audit page limits:** https://seranking.com/website-audit.html still lists older plans (Essential 15,000, Pro 40,000, Business unlimited pages per project); the subscription page says 250k (Core) and 1M (Growth) per project.
- **Client seats:** the subscription page says the Agency Pack carries 30 client seats; the agency pack page says 10 included.
- **AI Writer:** the AI Writer page quotes a "$29/mo for 15 articles" add-on on a "$65/mo" base; the subscription page says 25 articles on Core and 50 on Growth.
- **Local frequency:** the local rank tracker page says "Weekly or monthly"; the subscription page says "Local Keywords Daily 1,500".

---

## Pages that could not be read today

- help.seranking.com: every article returned HTTP 403 to the fetcher (backlink monitor, local rankings and grid, AI Search add-on). Where a cell uses one of them, the text came from the search engine's snippet of that page and says so; grid sizes and the backlink monitor's limits are left blank.
- https://dataforseo.com/pricing/content-analysis/content-analysis-api returned 404; the price was read on https://dataforseo.com/apis/content-analysis-api instead.
- The DataForSEO Google Maps pricing page does not say whether coordinates can be set (needed for the map grid); the LLM Responses page does not list its models; neither was confirmed from the API docs today.
- Not read today: DataForSEO's backlink index size, Business Listings and other review-site prices, Perplexity, OpenAI, Gemini and Anthropic token prices, YouTube and Yahoo SERP prices, Apple Business Connect and Bing Places API terms, and https://seranking.com/se-ranking-for-enterprises.html.
