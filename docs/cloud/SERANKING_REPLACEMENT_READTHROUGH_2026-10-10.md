# SE Ranking replaced: the full read-through

Written Saturday 10 October 2026, 14:30 UTC (09:30 CDT), for Brandon. Every SE Ranking feature as their own pages describe it (read today), what we build or already have instead, the cost per client per month per tier at the cadence you set this morning, the extras at the higher tiers, the audit checks nobody runs today, and what Search Console and the other connected APIs already cover. Built from two research passes run today (`RESEARCH_SERANKING_FEATURES_SIDE_BY_SIDE_2026-10-10.md`, `RESEARCH_SEO_EXTRAS_AND_COVERAGE_2026-10-10.md`, both in Session Sync with every URL and quote) and the code on the release lines. Nothing was built; nothing on production changed for this document.

---

## 0. The answer in one page

1. **SE Ranking's own pages come to 20 modules and 96 features.** We match 47, improve 22, cover 18 in part, and skip 9 (paid-ads research, the two AI ads trackers, competitor subdomains, extra markets and languages, Looker Studio and the other connectors, the agency catalogue, a public API, the free marketing tools). Nothing a local service business needs is in the skip pile. The only true gap is listing management across 100+ directories, which needs a paid listings partner and is your call.
2. **Where we are better, it is because we hold what SE Ranking cannot see:** the business's calls, forms and bookings; the full answer text from each AI engine with a plain-words fix; the Rank Math settings on every page through our plugin, so the audit fixes titles and descriptions instead of only listing them; reviews answered in the business's own voice; the business brief behind every "what to do next".
3. **Cost per client per month at your cadence** (keywords monthly on Starter and Essentials, weekly on Growth and Authority; backlinks quarterly on Growth and monthly on Authority; AI checks weekly), extras included: **Starter $0.07, Essentials $0.10, Growth $2.05, Authority $7.12.** Section 1 has every line of the arithmetic and the daily alternative. SE Ranking today is $219.40 a month (Core with AI Search and API, annual) or $339.40 (Growth), which is $22 to $34 a client at ten clients, the same for a Starter client as for an Authority one.
4. **The extras at Growth and Authority** (section 3): eighteen, led by the mention finder (pages that name the business but do not link, link to a dead page or print the wrong phone, and pages that list two competitors but not the client, each with a drafted ask), keyword-to-leads-and-bookings, fix buttons that write into the site, "what to do next" from the business brief, and outcome alerts through the outbox. None of these is on any SE Ranking page read today.
5. **Outside the box** (section 4): 38 audit checks from the 7 October playbook and beyond, plus 24 more from the feature pass, that neither our audit nor SE Ranking's 115 metrics run today. The ones that protect revenue most: form delivery tested end to end and watched (nine days of lost leads ended this morning), the booking button present and working, phone, hours and address the same everywhere, what the page promises against what the business sells.
6. **What Search Console and the other connected APIs already cover** (section 5): 31 numbers and checks, with the code that calls each one and the page a client sees it on. Several are collected and never shown.
7. **Build:** about 840 hours for the replacement (the scope of 9 October, revised after review), about 420 for the extras, about 260 for the outside-the-box checks, most of which share the same crawler. Renewal is February or March; side by side by January means the feed and the rankings pages on our tables by December.

---

## 1. Cost per client per month, by tier

Prices are DataForSEO list prices read today: Google and Bing results $0.0006 per page of ten (standard queue); AI pages $0.0012; Google Maps $0.0006 per pull; backlinks $0.024 per request plus rows (about $0.084 for a domain's summary and referring domains); keyword volume $0.06 per task of up to 1,000 keywords; web mentions $0.024 per request plus rows. A $50 prepayment opens the account; there is no monthly fee.

### 1.1 At your cadence (this morning's direction), extras included

| Tier | Keywords | Results pulls | AI mentions | Backlinks | Mention finder | Map grid | Other extras | Per month |
|---|---|---|---|---|---|---|---|---|
| Starter | 10 keywords, 2 engines, monthly, top 10 | $0.01 | none | none | none | none | $0.06 | **$0.07** |
| Essentials | 25 keywords, 3 engines, monthly, top 10 | $0.04 | none | none | none | none | $0.06 | **$0.10** |
| Growth | 60 keywords, 3 engines, weekly, top 30 | $1.40 | weekly, 2 Google AI engines, 5 prompts: $0.05 | quarterly, 6 domains: $0.17 | monthly: $0.18 | 5 keywords, 25 points, monthly: $0.08 | $0.17 | **$2.05** |
| Authority | 150 keywords, 3 engines, weekly, top 30 | $3.51 | weekly, 4 engines, 5 prompts: $0.10 | monthly, 11 domains: $0.92 | weekly: $0.78 | 10 keywords, 49 points, weekly: $1.27 | $0.53 | **$7.12** |

Ten clients, all Authority: about $71 a month, $855 a year. A mixed book of ten (3 Starter, 3 Essentials, 3 Growth, 1 Authority): about $14 a month.

### 1.2 The daily alternative (today's tier settings: Growth and Authority daily, Authority backlinks weekly)

From the feature research, same prices: Starter $0.10, Essentials $1.04, Growth $12.24, Authority $21.18 (daily top 10 plus weekly top 30) or $34.10 (daily top 30). Daily tracking is what SE Ranking sells; for a local business it is noise, and a "check now" button covers the day a client wants to see a fix land.

### 1.3 Not in these figures

Model tokens for prompts we ask Claude directly (under a dollar a month per paid client at list prices), JavaScript rendering for a site built on a framework ($0.75 per 500-page audit, none of ours need it), a directory-listings feed (not priced), our own compute, and email sending (the Azure price page showed dashes today).

### 1.4 SE Ranking, list prices read today

Core $103.20 + AI Search $71.20 + API $45 = **$219.40 a month** (10 projects, 2,000 keywords daily, 100 prompts); with the Agency Pack $288.40; Growth with the same add-ons **$339.40** (30 projects), forced at client eleven; each local location past three $18.40 more. Their own pages disagree with each other on the API price, Core credits, audit limits, client seats and the AI Writer add-on (section 6).

---

## 2. The side-by-side, every SE Ranking feature

"As read" is what SE Ranking's page says today, with the page. "Kind": EXISTING-API (already connected or built), BUILD (ours to write, no data bought), FEED (bought by the request), FEED+BUILD, SKIP. Verdicts: MATCH, IMPROVE (and how), PARTIAL (what is left out), SKIP.

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

## 3. The extras at Growth and Authority

### 3.1 The mention finder, in full

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

### 3.2 The eighteen extras, with cost, tier and hours

"Feed" = the pay-per-use data provider recommended in the scope (DataForSEO). Prices were read today (section 5 lists the pages and quotes). Tier names are ours (`lib/seoOnboarding.js:131-175`).

| # | Extra | What it does for the client | How (data source and mechanism) | Does SE Ranking do it? (pages read today) | Data cost per client per month | Tier | Hours |
|---|---|---|---|---|---|---|---|
| 1 | **Unlinked brand mentions, "ask for a link"** | Finds web pages that name the business but do not link to it (local news, chamber of commerce, supplier "where to buy" pages, event sponsors, directories), and drafts a short, polite email asking for the link | Two finders, merged: (a) the feed's Google organic SERP for `"Business Name" City`, `"Business Name"` and `"Owner Name" Business`, depth 30 (three pages each). Our own domain and social profiles are dropped in code, not with `-site:`, because the feed says search operators multiply the price by 5. (b) the feed's Content Analysis "search" for the brand, which returns citing pages with domain, snippet, page type and date, with a `not_in` domain filter (it has no field saying whether the page links to us, so we check). Then **our crawler** fetches each page logged out (`lib/audit/safeFetch.js`, SSRF-safe), finds the brand text and checks every `<a href>` for our domain (any subdomain, http or https, redirects resolved). No link = a mention to reclaim. A `nofollow` link, or a link to an old domain or a dead page, is a lesser "fix the link" category. The page's contact email or contact page comes from the same fetch. Claude drafts the email in the brand voice; the owner sends it from their own mailbox or approves sending through the outbox | Not found: Backlink Monitor page "does not mention finding unlinked brand mentions"; no outreach | Growth monthly: SERP 9 pages × $0.0006 = $0.005; Content Analysis 1 request + 100 rows = $0.024 + $0.0036 = $0.028; 10 drafts by Sonnet 5.5 (about 2,000 tokens in, 400 out each, at $2 / $10 per MTok) = $0.08. **About $0.11.** Authority weekly: **about $0.30** | Growth (monthly), Authority (weekly) | 36 |
| 2 | **Backlinks that point to the wrong place** | From the backlink feed already planned for Growth and Authority: links that land on a dead page or a redirect chain, links to an old domain, anchors with the business misspelt | Backlink rows (feed, scope §3) joined to our crawler's status for the target URL; anchors compared with the business name from the identity service (`lib/businessIdentityClient.js`) | Partly: "New & lost backlinks", "Anchor text tracking". Broken-target reclaim not stated | $0 extra on top of the backlink pulls | Growth, Authority | 10 |
| 3 | **AI answers that skip us, or name us without a link → sources to approach** | When ChatGPT, Gemini or Google's AI block answers "best roofer in Springfield" and cites five pages, show which of those pages list competitors but not the client, and draft the ask | The AI runner in the scope (§3, 90 h) already stores answer text and cited URLs. Extra: fetch each cited URL with our crawler; check for the client's name and link and competitors' names; rank sources by how often engines cite them; draft outreach. Optional: Claude as an engine with web search, whose responses "include citations for sources" | Partly: tracks "Mentions in AI answer texts with and without site links"; the page does **not** mention outreach | Fetches free; drafts about $0.04 to $0.08. Claude as an extra engine: web search "$10 per 1,000 searches" plus tokens; 5 prompts weekly is about 22 searches, **about $0.60 to $0.70** with tokens (estimate) | Growth, Authority | 24 |
| 4 | **Keyword to leads and bookings** | "Searches for 'emergency plumber' brought 14 visits, 3 form fills and 1 booking last month." The number every owner actually wants | The lead side is already captured: form fills with UTM and the `__ia_vid` visitor id stitched to the contact (`routes/submit.js:60-195`; plugin php:617-625, 672; LUMEN `visitorStitch.js`); every page view with page URL, referrer and channel (`lumen.attribution_touchpoint`, `tracking.js:221`). Google does not pass the search words, so the keyword is **estimated**: take the landing page of the organic visit, then split its leads across the queries that page earns, by Search Console page+query clicks (`gsc_pagequery_clicks`, `insightsSnapshot.js:161`) and the rank tracker's landing URL per keyword. Labelled "estimated from Search Console". Bookings: add the visitor id to the booking submit (`routes/submit.js:311` stores UTM only) and to OLIVER's public booking page | Not on the report page (no conversions, leads, calls, form fills or bookings named) | $0 | Essentials and up (it sells the product) | 40 |
| 5 | **Audit-to-fix buttons** | Each finding has a button: "Fix it" (class A: applied, read back, logged, reversible), "Approve" (class B) or "How to" (class C), per playbook §5 | Writes already exist: Rank Math title, description, focus keyword with read-back (plugin POST `/pages/{id}/seo`, php:1211, 6472-6510; arion-api `routes/arion/pages.js:2057`); alt text (php:1167; `pages.js:1153`). Add: heading level change and `aria-label` through the builder section API (`/pages/{id}/sections`, php:1127-1133); trailing-slash link rewrite (playbook §4.5). Claude drafts titles and descriptions, validated in code (rendered title within 60 including the site-name suffix, description 100-160, playbook §3.3, §4.2). Store before and after, purge cache, re-fetch the live page logged out (playbook §1.4, §8.4) | No: SE Ranking reports issues; it cannot write to the client's site | About $0.02 per 100 rewrites by Haiku 5.5 ($0.10 / $0.50 per MTok) | All tiers with an ARION website (Starter: owner approves each) | 60 |
| 6 | **Local rank grid with competitors' ratings in the same pull** | The heat map of where the business shows in the map pack across its service area, who beats it at each point, with their star rating and review count | Feed's Google Maps SERP with `location_coordinate` ("latitude,longitude,zoom", docs.dataforseo.com), one pull per grid point per keyword. Each result carries `rating` (value, votes_count), `phone`, `address`, `work_hours`, `is_claimed`, `category`, `total_photos`, coordinates. Grid centred on the GBP address, radius from the service area | **Yes, parity:** "Track rankings for multiple keywords on specific grid points, down to the street level"; plan page: "Local & Map Rank Tracker, keywords: 1,500", 3 locations. Our improvement is extras 7 and 16 joined to it | Growth 5 keywords × 25 points monthly = 125 pulls × $0.0006 = **$0.08**. Authority 10 × 49 points weekly = about 2,120 pulls = **$1.27** (Maps is priced per 100 results) | Growth, Authority | 24 (on top of the scope's 16 for local rank) |
| 7 | **Review pace and replies joined to local rank** | "You add 2 reviews a month; the three businesses above you add 6. Your reply rate is 40%." | Ours: `gbp_review_velocity`, `gbp_response_rate`, `gbp_rating` monthly (`insightsSnapshot.js:471-474`). Theirs: `rating.votes_count` and value from each grid pull (extra 6); month-on-month difference = their pace. Shown next to the grid | Partly: "Reviews Management", "Review Responses". The join to rank is not on the page | $0 extra | Growth, Authority | 16 |
| 8 | **Competitor content gap, filtered by what the client sells** | "Two competitors have a page for 'gutter guards'; you sell them and have no page" | Competitor URLs ranking for our keywords come free in the SERP pulls (scope §3). Fetch their sitemaps (free) and titles; group into topics; compare with the client's pages (plugin `/content/seo-detail`) **and the client's services** (extra 9). A gap counts only if the client sells it | Partly: competitor keyword research exists ("Unlimited competitor research"); comparing to what the business sells is not on the pages read | $0 extra | Growth, Authority | 24 |
| 9 | **"What to do next", written from the business brief** | Three to five actions a month in the owner's words, tied to what they sell and where, each with the evidence and a fix button where one exists | Inputs: the one business identity (`lib/businessIdentityClient.js`), brand intake differentiators and tagline (`lib/brandIntakeClient.js:57-85`), services (Business Profile services, `routes/arion.js:6303`), the month's findings from sections 1 and 3, the score movement already ranked by `analytics/insightGen.ts`. Claude Sonnet writes; facts come only from stored rows. Goes into the monthly Insights review email (lumen `services/insightsReview/`) | Partly: Insights gives "data-driven recommendations" from SEO data "rather than business information" | About $0.04 (about 10,000 tokens in, 1,500 out) | All tiers (Starter: top 3) | 24 |
| 10 | **Free audit widget on our own site (and agencies' sites)** | A visitor types a web address and email and gets a branded PDF in minutes; we get a lead with the audit attached | **The engine exists:** `lib/audit/runner.js`, signed entry `routes/audit.js:122`, branded PDF, owner list `routes/arion/siteAudits.js`, already offered through a LUMEN chat workflow step. Extra: a plain embeddable form or button (no chat needed), the lead into SPARK with the score, a daily cap, and a Portal page listing runs (none today) | **Yes, parity:** Lead Generator, "Up to 10 free leads per day", in the Agency Pack (+$69.00/mo) | $0 (PageSpeed with our existing key; our crawler) | Our own site now; agencies as an agency feature | 16 |
| 11 | **Free backlinks for every tier from Bing** | Starter and Essentials see their own inbound links without a paid feed | Bing GetLinkCounts and GetUrlLinks (free, not called today), with the key we already hold (`routes/arion.js:5387-5388`; `lib/iaMasterBing.js`) | SE Ranking includes backlink monitoring in its plans | $0 | Starter, Essentials (Growth and up also get the feed) | 10 |
| 12 | **Bing crawl issues list** | A free list of URLs Bing could not fetch, with the reason | Bing GetCrawlIssues (free, not called) | SE Ranking's own crawl covers status codes | $0 | All | 6 |
| 13 | **Alerts through the outbox, on business outcomes** | Tell the owner (or the agency) when it matters: a form stopped delivering, the booking button is broken, the site is down, SSL or domain expiring, a rank drop on a money keyword, a lost link from a good site, a new unlinked mention, a 1-star review unanswered for 48 hours | One alerts table; each rule reads rows we already store; messages go through the one preference gate (`lib/notificationGate.js` → platform-api `/internal/notify/can-send`) and the platform outbox, so quiet hours and opt-outs hold | Partly: email alerts for backlink changes and page changes. Not on the pages read: form, booking or site-health alerts | Email price: the Azure page showed "$-/Email sent" today (blank) | All tiers (Starter: site and form alerts only) | 20 |
| 14 | **Pages that stopped sounding like the business** | A page edited outside our builder drifts from the brand voice; flag it on the SEO and Content pages | Already computed daily: `arion.page_voice_score` (arion-func `functions/arionPageVoiceScore.js`). Needs only a route and a panel | No | $0 (already running) | Growth, Authority | 8 |
| 15 | **Keywords people already use to find the listing** | "People found your listing by searching 'stump grinding near me' 220 times; you are not tracking it and have no page for it" | `gbp_search_keyword_impressions` (`insightsSnapshot.js:612`) compared with the tracked keyword list and the site's pages | Not on the pages read | $0 | All | 6 |
| 16 | **Competitor listing watch** | "A competitor added 40 photos and changed hours; their listing is now claimed" | The same Maps pulls (extra 6): `total_photos`, `work_hours`, `is_claimed`, `category`, rating, month on month | Partly: "Local Competitor Analysis" monitors ranking dynamics; listing changes not stated | $0 extra | Growth, Authority | 8 |
| 17 | **Site, domain and email health wired up** | SSL, domain expiry and SPF/DKIM/DMARC on every client domain, not only Hostinger ones | Call `captureHostingSnapshot` from a daily timer; for non-Hostinger domains use Node DNS lookups as LUMEN already does (`emailDeliverability.js:98-116`) and the certificate from our own fetch | Partly: the audit lists "domain expiration" and HTTPS; not email records | $0 | All | 8 |
| 18 | **Old pages that used to earn clicks** | A page with 300 clicks a year ago now returns 404 or redirects to the home page; win the value back with a proper redirect | 16 months of `gsc_page_clicks` per URL (`insightsSnapshot.js:127-147`) re-fetched by our crawler; flag 404, soft 404 and redirect-to-home | No (SE Ranking crawls the current site, not past winners) | $0 | Essentials and up | 8 |

Left out on purpose: **listing management across 100+ directories** (SE Ranking's "Listing Management" and "100+ worldwide" directories) needs a paid listings partner. It is a gap in the replacement for Brandon to decide on, not an extra.

### 2.2 Cost of the extras per client per month (data only, prices read today)

| Tier | What is included | Per client per month |
|---|---|---|
| Starter | What to do next (top 3), fix-text drafts, site and form alerts, Bing backlinks, crawl issues, listing keywords, health | about **$0.06** |
| Essentials | Starter + keyword-to-leads, old pages that earned clicks | about **$0.06** |
| Growth | Essentials + unlinked mentions monthly ($0.11), AI-source outreach drafts ($0.08), grid 5 keywords × 25 points monthly ($0.08), review pace, content gap, voice drift, competitor listing watch | about **$0.35**; about **$1.00** with Claude added as an AI engine |
| Authority | Growth with mentions weekly ($0.30), grid 10 × 49 weekly ($1.27), AI drafts ($0.16) | about **$1.80**; about **$2.50** with Claude as an engine |

These sit on top of the feed cost per tier in the scope (§4: Starter $1, Essentials $8, Growth $129, Authority $353 a year at its settings). Email sending is not included because the Azure price page showed dashes today.

### 2.3 Hours for the extras

1: 36, 2: 10, 3: 24, 4: 40, 5: 60, 6: 24, 7: 16, 8: 24, 9: 24, 10: 16, 11: 10, 12: 6, 13: 20, 14: 8, 15: 6, 16: 8, 17: 8, 18: 8. **About 348 hours**, plus about 70 hours of walk-bar testing (every extra clicked on dev and on one real client): **about 420 hours.** Extras 1, 4, 5 and 13 carry most of the value for a small local business.

---

## 4. Outside the box: audit checks nobody runs today

### 4.1 From the 7 October playbook and beyond (38 checks)

SE Ranking's audit, as read today (seranking.com/website-audit.html): 13 categories, "115+ metrics" (security incl. mixed content; crawling and indexing; redirects; sitemap; meta tags; content incl. H1; hreflang; speed and Core Web Vitals; JavaScript; CSS; links; mobile viewport; other incl. favicon, domain expiry). On that page, accessibility, contrast, forms, phone/NAP, third-party scripts and security headers are not mentioned. Our audit is `lib/audit/checks.js` and `score.js` (section 1.7). Checks SE Ranking covers that our crawler still lacks (mixed content, redirect chains, hreflang, noindex in sitemap, CSS/JS errors) are parity work inside the scope's 140-hour crawler and are not listed here.

Each item: what, why it matters to a small local business, how we check it, source, rough hours.

### 3.1 From the 7 October pass (playbook sections 1, 3, 4, 6, 7)

| # | Check | Why it matters (plain) | How we check it | Source | Hours |
|---|---|---|---|---|---|
| 1 | **Measure the page as a visitor sees it, logged out, cache-busted, and compare** | A logged-in crawl gave wrong numbers on 7 October; a stale cache can show visitors last month's prices | Fetch each URL twice without cookies: plain and with a unique query string. Record `x-litespeed-cache`, `x-hcdn-cache-status`, `age`. Flag when the two differ in title, H1 or body hash (stale cache), and when the page cache never shows HIT | Playbook §1.1, §1.5, §2, §7 | 8 |
| 2 | **Two-method cross-check on every finding** | Every first-pass claim on 7 October that came from one source was wrong; a wrong "fix" costs more than no fix | Each finding carries two sources: what Rank Math intends (plugin `/content/seo-detail`, `/seo-meta`) and what the page serves (crawler). Report only when they agree, or say which source it came from. **A disagreement is itself a finding:** "Rank Math title set, but the theme prints a different title" (a template overriding the SEO plugin) | Playbook §1.2, §7 | 16 |
| 3 | **PageSpeed as a median of three, with cache state** | The same home page scored 57 and 81 within hours; one bad run scares the owner for nothing | Three runs per URL per strategy, median stored, cache header recorded per run. Today: one run a month (`pagespeedRunner.js:143-160`) | Playbook §1.3, §3.6, §8.3 | 6 |
| 4 | **Which plugin lazy-loads the hero image** | The biggest picture loading last makes the page feel slow on a phone; the fix is in a specific plugin's setting | PageSpeed's largest-contentful-paint element, then that element in the raw HTML: `class="lazyload"` + `data-src` + `data-eio-*` = EWWW; `data-lazyloaded` = LiteSpeed. Name the plugin and the exact setting | Playbook §3.6, §4.1 | 10 |
| 5 | **Hero image priority and size attributes** | Without `fetchpriority="high"` and width/height the browser finds the hero late and the page jumps | Same element: flag missing `fetchpriority`, `width`, `height`, `decoding` | Playbook §4.1b | 4 |
| 6 | **Duplicate H1 that comes from a shared template** | One fix in a template corrects every page | We count H1 per page (`checks.js:267`). Extra: the same extra-H1 text on many pages = a template (header, footer, shared CTA banner); report it once, against the template | Playbook §4.4 | 6 |
| 7 | **Internal links that redirect, fixed in place** | Each redirect slows visitors and wastes Google's visits; 21 such links in 11 posts on our own site | Distinct internal hrefs from the post body HEAD-checked; a 301 to the trailing-slash version becomes a class A rewrite after confirming the target returns 200 | Playbook §3.5, §4.5 | 6 |
| 8 | **Contextual links counted separately from template links** | Menu and footer links do not tell Google a post matters; body links do | Count only body links (the plugin graph already reads post content); show "fewer than 3 contextual links" and "no inbound link from another post" | Playbook §3.5 | 6 |
| 9 | **Header and footer accessibility first** | A missing label in the header fails on every page; one fix helps them all | Group PageSpeed accessibility failures by selector across sampled pages; the same selector failing on most pages = template; rank first | Playbook §3.8, §4.3 | 10 |
| 10 | **Text contrast measured, fixed inside the brand palette** | Hard-to-read text loses older visitors and fails accessibility; a fix with a new colour breaks the brand | WCAG ratio for each failing element (text colour blended over the nearest solid background); propose the closest brand colour that passes 4.5 (brand kit, `lib/brandKitClient.js`) | Playbook §4.7 | 16 |
| 11 | **Third-party scripts the owner never confirmed** | A second GA4 ID doubles traffic numbers; an ad script slows every page and may not be wanted | Every `<script src>` host in the logged-out HTML, deferred or not; flag duplicate GA4/GTM IDs, ad networks, unknown API hosts; the owner confirms once and the list is kept | Playbook §3.7, §6 | 8 |
| 12 | **Security headers, the full set** | HSTS keeps visitors on the secure site; `referrer-policy: unsafe-url` leaks visitors' paths to other sites | We check five (`checks.js:305-329`). Add Permissions-Policy and the *value* of Referrer-Policy (flag `unsafe-url`). Class C: owner or host applies | Playbook §3.9, §6 | 2 |
| 13 | **Sitemap truth against the CMS** | Pages missing from the sitemap are found late; dead pages in it waste Google's visits | Sitemap URL count vs published posts and pages from the plugin; listed URLs that are non-200 or noindex; published pages absent | Playbook §3.10 | 6 |
| 14 | **No `<main>` landmark** | Screen readers cannot jump to the content | Raw HTML has no `<main>` or `role="main"`; theme-level, report once | Playbook §6 | 2 |
| 15 | **Render-blocking CSS and what it would take to fix** | About 2.6 s of mobile delay on our own site came from one stylesheet | PageSpeed render-blocking audit + plugin LiteSpeed settings (`/performance/litespeed`): if async CSS is on without critical CSS, say that critical CSS needs an online service sign-up (owner decision) | Playbook §6 | 4 |
| 16 | **og:image and Article/Person schema on every post, from raw HTML** | Shared links without a picture get fewer clicks; missing author schema weakens trust | Parse every JSON-LD `@graph` and `og:*` tag from the logged-out HTML for **all** posts, not a sample | Playbook §3.4, §7 | 4 |

### 3.2 New checks (not in the playbook, not in SE Ranking's audit)

| # | Check | Why it matters (plain) | How we check it | Source | Hours |
|---|---|---|---|---|---|
| 17 | **What the page promises vs what the business sells** | A page for a service the business dropped brings calls it cannot take; a service with no page is invisible | Services from the brief and Business Profile services (`routes/arion.js:6303`) vs each page's title, H1 and first paragraph; Haiku classifies. Flag pages for services not sold and services with no page; also the area named on pages vs the GBP service area | new | 16 |
| 18 | **Phone, hours and address the same everywhere** | A wrong number in the footer or on Google loses the call; mismatches also weaken local ranking | Read phone, address and hours from every page (footer, contact page, `tel:` links, LocalBusiness schema), Business Profile (`lib/googleBusiness.js:132`; add `regularHours` to the readMask), the map listing in the feed's Maps result (`phone`, `address`, `work_hours`), Bing Places if connected. Normalise and compare | new | 12 |
| 19 | **Booking button present and working** | The button is the business; a broken one is silent lost revenue | On the home page and every service page: a booking or quote link in the first screen (element order or PageSpeed screenshot); follow it logged out; the booking page returns 200 and its public slots call answers (read-only, never a hold or submit) | new | 10 |
| 20 | **Form delivery tested end to end, and watched** | Nine days of inquiries from up to three businesses never reached SPARK (register, 2026-10-10: 117 submissions `processed=0`); nobody noticed because the failure list was full of expected failures | (a) **Watchdog, cheap, now:** alert when any `arion.form.submitted` event is `failed`, or when a site that normally gets submissions has `processed=0` rows older than one hour. (b) **Synthetic test:** a weekly marked test submission through the real form path, confirmed in `arion.site_form_submission` (processed=1) and in SPARK, then removed. Needs a test marker the CRM ignores and Brandon's yes before it touches live rows (live-data rule) | new (register 2026-10-10) | 16 |
| 21 | **"Inquiries go to" a real, monitored inbox** | A form posting to an old staff address or another business's fixture loses every lead (walk rows D3 and S3-7 found exactly this) | The form's recipient from the builder settings and the business identity; flag a mailbox domain that is not the business's, an address that bounced in the outbox, or a placeholder | new | 4 |
| 22 | **Chat bubble present on every page** | The chat is a lead source; a theme change can drop the script silently | Logged-out HTML of each page contains the LUMEN widget script (`lumen-api-septa/src/public/ia-chat-widget.js`), and the widget config call answers | new | 3 |
| 23 | **Tracking actually firing** | If the pixel stops, attribution and keyword-to-leads go blank | Pixel script (`/tracking/pixel.js`) and one GA4 ID present in the HTML; `lumen.attribution_touchpoint` has rows for the site in the last 7 days; GA4 sessions not zero | new | 6 |
| 24 | **Consent wording on forms** | A form with a phone box and no texting consent puts the business at risk under texting rules; no privacy link hurts trust | Forms with `tel` inputs carry the consent line and a privacy link; a cookie notice is present when ads or a second analytics script load | new | 6 |
| 25 | **Image weight per page** | A 6 MB home page is slow on a phone signal | Sum of image bytes per page (HTML sources + HEAD content-length), worst pages first; joined with the plugin's oversized list (`/media/audit`) | new (SE Ranking checks speed, not weight per page) | 6 |
| 26 | **Fonts loaded from Google, and how many** | Each font family and weight is another download; Google Fonts calls also send visitor data to Google | Count requests to `fonts.googleapis.com` / `fonts.gstatic.com` and font files per page; suggest self-hosting and fewer weights | new | 3 |
| 27 | **Brand name spelling drift** | "Summit Lawn & Landscape" on Google and "Summit Landscaping" in the footer confuses people and Google | Business name from the identity service vs page titles, footer, schema `name`, GBP title, map listing title; flag variants | new | 6 |
| 28 | **Schema matching the business type** | A plumber marked up as a generic Organization misses local signals | JSON-LD types (`checks.js:228`) vs the GBP primary category; flag no LocalBusiness subtype or a mismatched one; flag self-serving review markup (the business's own reviews on its own LocalBusiness) | new | 6 |
| 29 | **404s, without a Search Console API** | Search Console has no API for its not-found list | Combine our crawler's broken internal links, Bing GetCrawlIssues, the plugin's links to missing pages, and URL Inspection (2,000 a day per site) only on pages that earned clicks in the last 16 months | new | 6 |
| 30 | **Author and trust signals (E-E-A-T)** | People hire people; a named owner, licence and insurance build trust | Posts have a real author with a bio page and Person schema; an About page names people; licence or insurance numbers shown for trades that need them | new | 8 |
| 31 | **Speed on real phones** | Lab tests on a fast connection flatter the site | CrUX field data already stored per URL and origin (`pagespeedRunner.js:204-205`), shown as "real visitors on phones"; when CrUX has no data (low traffic), say so and show the throttled lab number | new (collected, not shown) | 6 |
| 32 | **Thin, copy-paste location pages** | Twenty city pages with the same text except the city name look like spam to Google and help nobody | Word count + similarity across pages (shingles); flag pages more than 80% the same | new | 10 |
| 33 | **Duplicate title patterns from templates** | "Services - Business" on twelve pages | Titles identical after removing the city or a page number; site-name suffix pushing the rendered title over 60 | new | 4 |
| 34 | **Leftover staging and template text** | "Lorem ipsum", "Sample Page", "Hello world!", links to a staging address or wp-admin look unprofessional and can expose the staging site | Text and link scan for known placeholders, staging or dev hosts and `/wp-admin` links on public pages; WordPress "discourage search engines" setting from plugin health | new | 4 |
| 35 | **Dead or placeholder social links** | Footer icons to a bare `facebook.com/` or a deleted profile make the business look closed | Fetch each social link; flag 404, the network's home page, or a profile that is not the business | new | 4 |
| 36 | **Business Profile website link tagged** | Without a tag, listing visits look like generic traffic and keyword-to-leads undercounts local | GBP `websiteUri` carries our UTM (`lib/gbpUtm.js`) | new | 3 |
| 37 | **Email records and certificate on the client's own domain** | Missing DMARC is why "our quote emails go to spam"; a lapsed certificate takes the site offline | Wire the snapshot that exists but is never called (`lib/hostingSnapshot.js:28`) and add DNS lookups for non-Hostinger domains | new (code exists, unused) | (in extra 17) |
| 38 | **Tap targets, zoom and form labels on phones** | Tiny buttons and disabled zoom lose older visitors | Viewport `user-scalable=no` or `maximum-scale=1`; PageSpeed tap-target and label audits grouped by template (item 9) | new | 4 |

**Hours, section 3:** playbook items about 114, new items about 143: **about 260 hours.** Most share the crawler the scope already builds (140 hours), so the true extra is the rules, the evidence and the wording, not new plumbing.

### 4.2 From the feature pass (24 checks; overlaps with 4.1 are the same check seen twice)

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

### 4.3 Order of work this suggests

1. **This week, cheap and protective:** the form-delivery watchdog (3.2 item 20a, about 4 of its 16 hours), wiring the hosting and email snapshot (extra 17), the Core Web Vitals page onto stored CrUX (3.2 item 31). None needs a feed.
2. **With the crawler (scope phase 1):** the 16 playbook checks, the cross-check rule, three-run PageSpeed, fix buttons for class A.
3. **With the feed (scope phase 2):** grid, review pace, competitor listing watch, content gap, unlinked mentions, AI-source outreach.
4. **The selling points to lead with:** keyword-to-leads, fix buttons, unlinked mentions with the drafted ask, "what to do next" from the brief, outcome alerts. SE Ranking's own pages offer none of these.

---

## 5. What we already cover through Search Console and the other connected APIs

### 5.1 By source, with the code and the page (31 items)

"Where seen" names the Portal page file (ARION service). "Collected, not shown" means the data is fetched and stored but no client page reads it.

### 1.1 Google Search Console

| Check or number | Code (file:line) | Where a client sees it |
|---|---|---|
| Clicks, impressions, CTR, average position; top 25 queries (live, 28 days) | arion-api `lib/googleServices.js:84-126` (rowLimit 25 at :90); route `routes/arion.js:4712` | Search → Performance (`search/SearchPerformance.tsx:34`). Defect: guesses the property as `https://`+domain at `routes/arion.js:4744` (field map defect 8) |
| Same by page, device, country (live) | `lib/googleServices.js:128-168`; page+query `:169-190` | Search → Performance (groupBy 'all') |
| Monthly totals: impressions, clicks, CTR, average position, 16-month backfill | `lib/insightsSnapshot.js:104-108`; timer arion-func `functions/insightsMonthlySnapshot.js` | IA Insights dashboards and Reports (`analytics/IAInsightsReports.tsx`) |
| Query (1,000), page (500), device, country, search appearance (rich-result types) per month | `lib/insightsSnapshot.js:127-147` | IA Insights → Reports: Query Performance, Landing Page Search Performance, Search by Device, Search Traffic by Country, Rich Result Types You Earn (`lib/arionMetrics.js:257-259, 277, 283`) |
| Which search brings them to which page (page+query) | `lib/insightsSnapshot.js:161-163` | Report "Which Search Brings Them to Which Page" (`lib/arionMetrics.js:281`) |
| Click-through by query; title and meta rewrite candidates (CTR opportunity) | `lib/arionMetrics.js:371, 429` | IA Insights → Reports |
| Trend breaks (when things changed) | `lib/arionMetrics.js:488` | IA Insights → Reports |
| Striking distance (positions 11 to 20) | `lib/arionMetrics.js:541` | IA Insights → Reports (the SEO Opportunities page still uses SE Ranking) |
| Visibility trajectory (60 to 90 day projection) | `lib/intelligence/visibilityTrajectory.js` | IA Insights → Intelligence |
| Index status of one URL (URL Inspection) | `routes/arion.js:4845-4900` | Search → Indexing, "inspect a URL" box (`search/SearchIndexing.tsx:197-216`). On demand only; Google's quota is "2000 QPD" per site (developers.google.com/webmaster-tools/limits, read today) |
| Sitemaps listed and submitted; sitemap generated | `routes/arion.js:5319, 6465`; `lib/sitemapGenerator.js` | Search → Indexing (`SearchIndexing.tsx:114`). The separate Sitemaps page reads a route that never returns sitemaps (field map defect 3) |
| Not available by API at all | Search Console's page-indexing report ("why pages aren't indexed", the not-found list) has no API; only URL Inspection, one URL at a time | n/a. Section 3 item 29 says how we get 404s instead |

### 1.2 Bing Webmaster Tools

| Check or number | Code | Where seen |
|---|---|---|
| Query and page stats, rank and traffic (daily) | `lib/bingWebmaster.js:71, 86, 215`; routes `routes/arion.js:5601, 5624` | Search → Performance (provider Bing) |
| Crawl health: pages crawled, 2xx, 301, 404, 5xx, robots.txt denials, malware, 30-day series | `lib/bingWebmaster.js:147`; summary `routes/arion.js:5668-5676` | Search → Indexing (`SearchIndexing.tsx:122`) |
| URL submission quota, submit URL, IndexNow key and submissions | `lib/bingWebmaster.js:117, 132`; `routes/arion.js:5061-5282` | Search → Bing IndexNow (`SearchBingIndexNow.tsx:69-118`) and Indexing |
| Index details for one URL (GetUrlInfo) | `lib/bingWebmaster.js:163`, imported at `routes/arion.js:37` | Not traced to a page in this read |
| Keyword research (GetKeywordStats) | `lib/bingWebmaster.js:257` sends an empty query | Broken (field map defect 5) |
| **Free and not called:** GetCrawlIssues ("Get list of crawl issues for specific site"), GetLinkCounts ("Get list of site pages which has inbound links"), GetUrlLinks ("Get inbound links for specific site url"), GetRelatedKeywords, GetPageQueryStats | Method list at learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi (read today); grep finds none of them in arion-api | n/a. Extras 11 and 12 use them |

### 1.3 Google Business Profile

| Check or number | Code | Where seen |
|---|---|---|
| Name, address, website, phone, categories of the listing | `lib/googleBusiness.js:129-136` (the readMask has no opening hours) | Business pages (`arion/pages/business/BusinessOverview.tsx`) |
| Calls, directions, website clicks, impressions split search vs maps and desktop vs mobile, mobile share, conversations, bookings, actions, action rate (monthly) | `lib/insightsSnapshot.js:548-578` | IA Insights → Reports `gbp_visibility_split`, `gbp_actions` (`lib/arionMetrics.js:949, 976`) |
| The search terms that showed the listing, with impressions (6 months) | `lib/insightsSnapshot.js:588-612` | Report "Listing Search Terms" (`lib/arionMetrics.js:261`) |
| Review count, rating, **review velocity** (new this month), **reply rate** | `lib/insightsSnapshot.js:471-474` | IA Insights dashboard tiles "Review Velocity", "Response Rate" (`portal-septa/src/analytics/arionDashboards.ts:96-97`) |
| Reviews list, AI draft reply, reply; auto-reply | `routes/arion.js:5883, 6039, 6013`; `lib/gbpAiReply.js`; timer arion-func `functions/gbpAutoReply.js` | Business → Reviews (`business/BusinessReviews.tsx`) |
| Q&A, posts, media, services | `routes/arion.js:5955-6340` | Business pages |
| UTM on the listing's website link | `lib/gbpUtm.js` | Used when the listing is written; not audited (section 3 item 36) |

### 1.4 PageSpeed Insights and CrUX (real visitors)

| Check or number | Code | Where seen |
|---|---|---|
| Mobile and desktop scores (performance, accessibility, SEO, best practices); LCP, INP, CLS, FCP, TBT, Speed Index, TTFB; opportunities; CrUX field data for the URL and the origin | arion-func `shared/pagespeedRunner.js:143-205`, stored `:257-268` in `arion.site_pagespeed_snapshot`; monthly 05:13 UTC on the 1st (`functions/monthlyPageSpeed.js:15`); on demand `routes/arion.js:6644, 6759`; history `:7037` | Website → Performance & Cache (`website/PerformanceCache.tsx:42, 240-336`: mobile/desktop score, CWV passing, trend, latest CWV, top opportunities) |
| Speed, accessibility, technical SEO and best-practice audits as lists of failing items | `lib/arionMetrics.js:1090-1096` | IA Insights → Reports (four reports) |
| Field data, scores, opportunities, Core Web Vitals | `lib/arionMetrics.js:1064, 1174, 1222, 1261` | IA Insights → Reports |
| CrUX origin lookup (separate API) | `routes/arion.js:5705` | **Collected, not shown:** Search → Core Web Vitals shows hard-coded "--" (`search/SearchCoreWebVitals.tsx`, field map defect 2) |
| One run per strategy per month | `shared/pagespeedRunner.js:143-160` (one call, a retry only on error) | Playbook §1.3 says three runs and the median; section 3 item 3 |

### 1.5 GA4 (SEO-relevant parts)

| Number | Code | Where seen |
|---|---|---|
| Sessions by channel (organic search among them), engagement by channel | `lib/insightsSnapshot.js:319-320` | Reports "Traffic by Channel", "Engagement by Channel" (`lib/arionMetrics.js:262, 266`) |
| Landing page sessions and engagement | `lib/insightsSnapshot.js:326-327` | Reports "Engagement by Landing Page", "Top Pages" (`:267-268`) |
| Conversions and conversion rate; conversions by source | `lib/insightsSnapshot.js:256-257, 409` | Report "Conversions by Source" (`:269`) |
| Sessions by city, device, browser, OS, hour, new vs returning | `lib/insightsSnapshot.js:278-330, 364-369` | Reports (`:264-304`) |

### 1.6 IA plugin (nightly snapshot plus on-demand pages)

Nightly at 05:17 UTC (arion-func `functions/pluginSnapshot.js:21`); endpoints listed at `shared/pluginSnapshot.js:120-146`.

| Check or number | Plugin route (php:line) | Stored / read | Where seen |
|---|---|---|---|
| Per page and post: Rank Math score, focus keyword, has meta description and its length, schema type, readability, word count, noindex, last modified (up to 500) | `/content/seo-detail` (php:989, 3285-3345) | `arion.site_content_item` (`pluginSnapshot.js:404`); `content_library` report and cannibalisation (`lib/arionMetrics.js:682`) | Website → Content SEO (`website/ContentSeoOverview.tsx:34-46, 185-208`: average score, coverage, missing meta, missing focus keyword, noindex, readability, schema) |
| Site totals: average Rank Math score, pages under 50, missing meta, missing focus keyword, noindex | `/content/seo-aggregate` (php:946) | snapshot row | Content SEO; Website Overview |
| Internal link graph: links in and out per page, in menu, links to missing or unpublished pages, orphans | `/content/links` (php:1005, 3490-3625) | `arion.site_page_link` (`pluginSnapshot.js:467`) | Report "Page Reachability - Can Anyone Find This?" (`lib/arionMetrics.js:769-785`). Limit: reads the post body only, so menus, footers and builder output are not in the graph |
| Media: bytes, oversized, missing alt, unused | `/media/audit` (php:1011, 3637-3760) | `arion.site_media_item` (`pluginSnapshot.js:517`) | Report `media_library` (`lib/arionMetrics.js:874`); Website → Images (`website/PerformanceImages.tsx`: total images, WebP, lazy load) |
| Cache, minify, lazy load, WebP settings | `/performance/litespeed` (php:914), `/performance/ewww`, `/performance/server`, `/performance/cron` | snapshot row | Performance & Cache (`PerformanceCache.tsx:359-391`) |
| Security events, firewall, core file health, users, scan issues | `/security/*` (php:840-908) | snapshot row | Website → Security, Vulnerabilities (`website/SecurityOverview.tsx`, `SecurityVulnerabilities.tsx`) |
| Plugin, theme and core updates | `/updates/available` | snapshot; report `component_upkeep` (`lib/arionMetrics.js:1698`) | Website → Updates (`website/WebsiteUpdates.tsx`) |
| Which form plugins exist | `/forms/summary` (php:1023, 3858) | snapshot | Not traced to a page |
| **Writes we can use for fixes:** Rank Math title, description, focus keyword, with read-back | POST `/pages/{id}/seo` (php:1211, 6472-6510) | arion-api `routes/arion/pages.js:2057` | Page editor |
| **Writes:** image alt text | POST `/media/{id}/alt` (php:1167) | `routes/arion/pages.js:1153` | Page editor |

### 1.7 Our own jobs

| Job | Code | Where seen |
|---|---|---|
| Website audit tool (lead magnet): robots.txt, home + 9 pages, 30 link checks, http→https, sitemap; per page title 10-60, description 50-160, one H1, images missing alt, canonical present, viewport, JSON-LD types, business schema; five security headers (HSTS, CSP, nosniff, frame, referrer); phone shown, tap-to-call link, contact link or form; PageSpeed; score in five sections (speed 30, found on Google 25, trust 20, phones 15, leads 10); branded PDF | `lib/audit/crawl.js:19-21`, `checks.js:253-289, 305-329, 365-374`, `score.js:13-17`, `runner.js`; signed entry `routes/audit.js:122`; owner list `routes/arion/siteAudits.js:47-74` | The lead gets the PDF. Offered to website visitors as a LUMEN chat workflow step ("Free website audit", `lumen-api-septa/src/routes/leadChat.js:80`; capped per conversation, `services/chatWorkflows/stepper.js:376`). **No Portal page lists the runs** (grep found none): collected, PDF only |
| Page-change watcher (watched URLs, daily) | arion-func `shared/marketMonitor.js:514-600` (05:41 UTC) | SEO → Market Monitor. Magnitude always 100% (field map defect 6) |
| Brand voice score of every published page against the brand profile (daily 05:55) | arion-func `functions/arionPageVoiceScore.js:1-31` → `arion.page_voice_score` | **Collected, not shown** (no arion-api route or Portal page reads it) |
| Domain, SSL, DNS, SPF/DKIM/DMARC snapshot | `lib/hostingSnapshot.js:28-123` | **Built, never called** (section 0 item 6); the `hosting_health` report (`lib/arionMetrics.js:1542`) is empty |
| Sender-domain SPF/DKIM/DMARC live check | lumen-api `src/routes/emailDeliverability.js:98-116` | SPARK email sender set-up only, not the client's domain health |
| Attribution: pixel page views with page URL, referrer, channel, UTM, visitor id; form fills stitched to the visitor | lumen-api `src/routes/tracking.js:53-221` (`lumen.attribution_touchpoint` columns at :221); `services/attribution/visitorStitch.js`; arion-api `routes/submit.js:60-195` (forms), `:311-379` (bookings, UTM only) | SPARK attribution per lead (`routes/attribution.js:63`). Not joined to search data anywhere |
| Recommendations from score movement | Portal `src/analytics/insightGen.ts` | IA Insights dashboards; monthly Insights review email (lumen `services/insightsReview/`) |
| Intelligence calculators | `lib/intelligence/visibilityTrajectory.js` (GSC), `pageSpeedDistribution.js` (PSI); `crawlDepth.js`, `schemaCoverage.js`, `competitivePresence.js`, `seoAuthority.js` read SE Ranking | IA Insights → Intelligence; the SE Ranking-fed four move with the scope |

### 5.2 Which SE Ranking feature each source covers or beats

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

## 6. Where SE Ranking's own pages disagree, and what could not be read

- **API price:** the subscription page sells the API add-on at $45 a month (annual only, 3M credits); https://seranking.com/api.html says an "API Add-On: $149/month" and also "API access is included in every SE Ranking plan".
- **Credits on Core:** the subscription page says 25K API credits on Core; the rank tracker page says "Core plan: 100,000 credits/month".
- **Audit page limits:** https://seranking.com/website-audit.html still lists older plans (Essential 15,000, Pro 40,000, Business unlimited pages per project); the subscription page says 250k (Core) and 1M (Growth) per project.
- **Client seats:** the subscription page says the Agency Pack carries 30 client seats; the agency pack page says 10 included.
- **AI Writer:** the AI Writer page quotes a "$29/mo for 15 articles" add-on on a "$65/mo" base; the subscription page says 25 articles on Core and 50 on Growth.
- **Local frequency:** the local rank tracker page says "Weekly or monthly"; the subscription page says "Local Keywords Daily 1,500".

- help.seranking.com: every article returned HTTP 403 to the fetcher (backlink monitor, local rankings and grid, AI Search add-on). Where a cell uses one of them, the text came from the search engine's snippet of that page and says so; grid sizes and the backlink monitor's limits are left blank.
- https://dataforseo.com/pricing/content-analysis/content-analysis-api returned 404; the price was read on https://dataforseo.com/apis/content-analysis-api instead.
- The DataForSEO Google Maps pricing page does not say whether coordinates can be set (needed for the map grid); the LLM Responses page does not list its models; neither was confirmed from the API docs today.
- Not read today: DataForSEO's backlink index size, Business Listings and other review-site prices, Perplexity, OpenAI, Gemini and Anthropic token prices, YouTube and Yahoo SERP prices, Apple Business Connect and Bing Places API terms, and https://seranking.com/se-ranking-for-enterprises.html.

---

## 7. Corrections found while reading (to the 9 October documents)

- The plugin's `/content/links` and `/media/audit` **are** called nightly by arion-func (`shared/pluginSnapshot.js:142-143`) and feed the page-reachability and media reports; the 9 October field map said arion-api does not call them, which is true of arion-api only.
- SSL, domain expiry and SPF/DKIM/DMARC are **not** snapshotted: `lib/hostingSnapshot.js` has no caller, so the hosting-health report is empty. Wiring it is extra 17.
- Bookings carry UTM but no visitor id (`routes/submit.js:311-379`); the forms do. Keyword-to-bookings needs the id added.
- The Bing Search API retired on 11 August 2025, so Bing cannot be the web-mention source; the feed's content search or Brave Search can.
- The Website check (our free audit, branded PDF, keyed links, daily cap) already exists and matches SE Ranking's Lead Generator; it only lacks a plain embed and a Portal page listing runs.

---

## 8. Decisions for Brandon

1. The feed provider (DataForSEO recommended; one account, one adapter, a second provider possible behind a setting).
2. Cadence and depth per tier as in 1.1, or the daily alternative in 1.2.
3. Backlinks on Growth quarterly and Authority monthly (as you said), with the Bing free links on every tier.
4. AI engines: the four on Authority (AI Overviews, AI Mode, ChatGPT, Gemini); add Claude and Perplexity or not; weekly (the client copy promising daily changes).
5. Feed spend carried in the tier price (recommended) rather than ARGUS credits.
6. Keep SE Ranking's twelve months as the "before" line with id mapping.
7. The switch-off date, which needs the renewal date (February or March).
8. The name of our authority number ("Link strength" recommended).
9. Listing management across directories: a paid listings partner, an agency task, or not offered.
10. Which extras ship with phase 2 (recommended: mention finder, keyword-to-leads, fix buttons, what-to-do-next, outcome alerts).
11. The 119 waiting website inquiries: your word to replay them (one statement, idempotent, three businesses).
