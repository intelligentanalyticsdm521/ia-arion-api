# Our own SEO tools: everything needed to drop SE Ranking and stay fully competitive (revised after review)

> **DECISIONS, FINAL (Brandon, 10 and 11 Oct 2026; this block overrides sections 4, 7 and 9 where they differ). SEO is the number one coding priority from Thursday 15 Oct.**
> 1. **Provider:** DataForSEO, one account, pay per check (fifty dollars prepaid). Brandon opens the account; login and password go in the vault (DATAFORSEO-LOGIN / DATAFORSEO-PASSWORD), never in chat.
> 2. **Cadence:** weekly ceiling for keyword and prompt rankings; monthly on Starter and Essentials; backlinks quarterly on Growth, monthly on Authority; client copy changed from daily to weekly.
> 3. **AI engines:** Google AI Overviews, Google AI Mode, ChatGPT, Gemini, and **Claude on Authority**. Perplexity stays consulting-only, never an SEO engine.
> 4. **One ship, everything in it:** no extras split. The core, the eighteen extras and the sixty-two outside-the-box checks all ship in the first production ship. Build runs back to back (run 1 tables + defects + free sources + crawler + on-page; run 2 feed adapter + scheduler + the eight pages + competitors + local rank + AI runner + cost line; run 3 backlinks + keyword data + Intelligence/onboarding/LUMEN/OLIVER re-keyed + copy + Reports/PDF + extras + checks + switch-off).
> 5. **Side by side:** production, Intelligent Analytics' own site, one month; then switch-off. Cancel SE Ranking by 1 Jan 2027 (renews 15 Feb 2027); reminder task fires 15 Dec.
> 6. **Words:** never "feed spend" or "directory listing management" on a screen or in a message. Say "the data bill" (what we pay DataForSEO per check; it is our cost of providing the tier and is never charged to a client; recorded per client only so the agency usage page shows margin) and "directory listings".
> 7. **History:** the twelve months of SE Ranking history stay as the before line, keyword and engine ids mapped.
> 8. **Keyword research** (from the code): the route /seo/keywords/research (routes/arion.js:2156) keeps its per-tier daily cap and swaps its source from SE Ranking to DataForSEO keyword data (volumes, ideas, difficulty, cached thirty days) plus Bing Webmaster GetKeywordStats (free; today called with an empty query, a section-6 defect) plus Search Console queries (what the site already ranks for; feeds Opportunities, not research).
> 9. **Directory listings** (from the code): Google connected (profile read/patch, posts, reviews); Bing Webmaster connected, **Bing Places not** (routes/arion.js:831 bingPlaces: false; the My Business Bing tab is a link); Facebook Page connection exists for My Brand social and will carry the Page's business info with the pages_manage_metadata permission; Apple is a link only; Yelp nothing. Plan: Google and Facebook kept in sync by us; Bing Places through Microsoft's agency API if granted (checked in run 1); every other site report-only through the listing finder; fixes by hand as agency work; no paid listings partner.
> 10. **Gating:** every new SEO route names a feature key from the catalog (SCOPE_FEATURE_CATALOG_2026-10-11.md); the SEO add-on rung comes from arion.site.seo_addon_tier.
> Run briefs ready: scratchpad seo-phase1-workflow.js (run 1); runs 2 and 3 are written from sections 3, 5 and 7 when run 1 lands.

Written 9 October 2026, 21:40 UTC; **revised 22:05 UTC (17:05 CDT) after an adversarial review against the code** (`REVIEW_SCOPE_SEO_TOOLS_2026-10-09.md`, in Session Sync). From your words this afternoon: "dropping SE Ranking and building our own version … a fully competitive SEO tool without needing the $3-4k SE Ranking price tag. If we need to add a paid backlink checker that's fine, that's only for higher tiers anyway … you're missing a few other things we've integrated such as LLM mentions." Docs only. No code, server or database was changed.

Built from `RESEARCH_SEO_FIELD_MAP_2026-10-09.md` (every field on every SEO page, its source today with file and line, its replacement) and `RESEARCH_SEO_PRICES_2026-10-09.md` (public price lists read today with URLs and arithmetic), both in Session Sync. Code read on the release lines at arion-api `1d592a6`, arion-func `0ce9c60`, Portal `0a8f4d9`, ia-plugin `166d077`, lumen-api `6ac08cc`, oliver-api `711998d`. The review corrected ten claims in the first draft and added eleven missing pieces; all are folded in, and the three that change the plan are in section 0.

---

## 0. The answer in one page

**SE Ranking does seven jobs for us. Three are already free and connected, three become data we buy by the check, and the site audit we build. The shape holds; the first draft understated the work and mis-stated the cost, and the review set both straight:**

1. **The SEO pages call SE Ranking live, not our history table.** Rankings, Overview, keyword detail, Opportunities, the competitor content gap, decay and suggestions parse SE Ranking's nested responses in eight routes; only Market Monitor moves, the competitor report and the Insights monthly aggregation read `arion.se_ranking_position_history`, and that table has no landing URL, volume, CPC, competition or depth columns. So the rank tracker is a rewrite of those routes onto our own tables, not "one adapter".
2. **The cost depends on depth and cadence, and the saving is real only below Authority.** At our tier ladder (`lib/seoOnboarding.js:131-177`: Growth and Authority check daily on three engines) and the depth today's widgets need (top 30), ten Authority clients cost about $3,500 a year on the feed, about what SE Ranking Growth costs; ten Growth clients cost about $1,300; a mixed book of ten costs about $750; Starter and Essentials cost cents. Section 4 has the table. The lever is the Authority setting (decision 2).
3. **ARGUS credits cannot meter a feed call today** (`lib/argus/callWrapper.js` prices tokens and images, logs "NO PRICE" for anything else, refuses when the balance is empty, and lives only in arion-api). Feed spend is better carried in the tier price than charged as credits that stop tracking when they run out (decision 6).

| Job | After | Per client per year (feed) |
|---|---|---|
| Rank tracking by engine and place, competitors in the same pull | a SERP data feed, our tables, eight routes rewritten | Starter $0.14, Essentials $2.34, Growth $118, Authority $296 at top 30 daily (section 4 for the settings that halve it) |
| Site audit | our crawler in arion-func, widened to the page's fields, plus what the plugin answers per URL | nothing |
| Competitors (positions, moves, top pages, authority) | the same pulls; their sitemaps; our "link strength" score | nothing extra |
| Backlinks | Bing's free inbound links for the client; a backlink feed for competitors and the score, Growth and Authority only | Growth $6, Authority $11 monthly or $48 weekly |
| Keyword research | Bing's free keyword tool, a keyword-data feed cached 30 days, our own difficulty from the pull; the Content Agent's provider moved with it | under $1 |
| LLM mentions (AI Search, AI Prompts) | our own answer runner with web-search modes for citations: Google AI blocks through the feed, ChatGPT and Gemini through the feed or their APIs, Claude and Perplexity if you add them | Growth $4, Authority $9 daily; weekly a tenth of that |
| Page changes, Search Console, Bing, Core Web Vitals, Business Profile, reports | ours or already connected, with their defects fixed and the Reports page made real | nothing |

**Build: about 650 hours for the core** (the review's range 520-650, taken at the top), **plus about 150 for the competitive extras and the walk-bar testing: about 800 hours** in three phases (section 7). SE Ranking is also wired into onboarding, four Intelligence calculators, the Content Agent's database constraint, a LUMEN alert and OLIVER's onboarding status; all are in the plan now. The twelve months of SE Ranking history stay as the "before" line, with keyword and engine ids mapped so the trend joins.

---

## 1. What we use SE Ranking for today (from the code)

- **Project API** (`api4.seranking.com`, `lib/seranking.js`): sites, keywords, groups, engines, positions with landing pages, audits (create, list, issues, recheck), competitors, backlinks with Search Console auto-import, and the AI tracking set ("AIRT": brand, LLM engines, prompts, answers, rankings, groups).
- **Data API** (`api.seranking.com/v1`, `lib/serankingData.js`): keyword overview (volume, difficulty, CPC), similar, related, long-tail, questions; backlinks summary and referring domains (arion-func `shared/marketMonitor.js:384,454`); the Content Agent keyword provider (`lib/contentAgent/keywordProviders.js:30,93-112`, with a database CHECK constraint allowing only `se_ranking`, `rankmath`, `none`); the Insights `kw_volume`/`kw_cpc` pull; Market Monitor's `/domain/overview` suggestions; the `se_ranking_summary` reconciliation.
- **Routes that call it live** (`routes/arion.js:2002-4647`): rankings 2561, overview 2673 (and starts a paid audit on a page view, 2976-2990), audit 2921, market monitor 3537, competitors 4105, AI search 4258, diagnostic 4507, plus `/seo` 1153 and `/seo/decay`. Four Intelligence calculators read SE Ranking (`routes/arion/intelligence.js`). Onboarding and provisioning create SE Ranking projects; `se_ranking_project_id` is read by a LUMEN "not tracking any search terms" alert and by OLIVER onboarding status.
- **Timers**: competitor moves daily, backlinks weekly (Authority only, own domain only), page changes daily (ours), Insights monthly.
- **Portal**: eleven SEO pages, six Search pages, the SEO parts of Website Overview, IA Insights Reports and the dashboards; SE Ranking is named 128 times across 38 files, plus LUMEN dashboards and the usage page.
- **Gating**: `routes/arion/intelligence.js:39-47` blocks calls without `seo_addon_tier`; the ladder: Starter 10 keywords, 2 engines, monthly; Essentials 25, 3, weekly; Growth 60, 3, daily, backlinks, 2 Google AI engines; Authority 150, 3, daily, backlinks, 4 AI engines; the Portal's competitor caps (10/5/5/2) disagree with it (10/5/3/1).

---

## 2. What is already connected and working (code, not docs)

- **Google Search Console**: live Search Analytics, URL Inspection, sitemaps; a monthly 16-month snapshot into `arion.metric_monthly` (`lib/insightsSnapshot.js:60-170`).
- **Bing Webmaster Tools**: query, page, rank and traffic, crawl stats, sitemaps, URL submission, IndexNow (`lib/bingWebmaster.js:71-330`); its free inbound-link endpoints are not called; the keyword call passes an empty query.
- **Google Business Profile Performance**, **PageSpeed Insights with CrUX field data** (monthly and on demand; a CrUX route no page calls), **Anthropic** (text), **OpenAI** (images only today).
- **Our own 10-page audit crawler** (`lib/audit/crawl.js`, `checks.js`: robots, sitemap, links, title, description, H1, alt, canonical present/absent, JSON-LD; keeps 2xx pages only) and the daily page-change watcher.
- **The IA plugin per URL**: Rank Math title, description, focus keyword, robots and score; per-page SEO detail (stops at 500 posts) and aggregate; `/content/links` (reads `post_content` only: menus, footers and builder output are not in its graph; no nofollow, no HTTP status) and `/media/audit`; neither called by arion today.

---

## 3. Module by module: what "fully competitive" needs

"Feed" means a pay-per-use data provider; the research read DataForSEO, Serper, SerpApi, Traject Data, Moz and Semrush; DataForSEO is the cheapest full set and bills by the request with a $50 prepayment.

| Module | Source after | Build | Hours |
|---|---|---|---|
| **Rank tracker** (keywords, groups, engines, place, cadence by tier, history, landing URL, distribution, jumped/dropped, visibility, traffic forecast, mobile vs desktop) | SERP feed; our tables `seo_keyword`, `seo_competitor`, `seo_position` (landing URL, volume, CPC, competition, depth, engine, place); the eight live routes rewritten onto them; keyword and engine id mapping so the 12-month "before" line joins; scheduler selects by `seo_addon_tier` and skips cancelled add-ons | the feed adapter, the tables, the routes, the mapping, the scheduler | 125 |
| **Local rank** (a keyword in a city; the local pack) | the feed with location coordinates; per-location keyword sets for multi-location businesses | | 16 |
| **Keyword research** (volume, CPC, competition, difficulty, ideas, questions, long-tail) | Bing keyword tool (fix the empty query), a keyword-data feed cached 30 days, difficulty from the pull; the Content Agent provider and its CHECK constraint moved; `serankingHealth` and `topicSelection` rewritten; the Insights volume pull moved | adapter, cache, formula, the Content Agent | 36 |
| **On-page checker** (one page against one keyword) | the plugin's per-URL answers + the crawler's as-served view + PSI per URL + the page's Search Console queries | one report route and panel | 24 |
| **Website audit** (every URL: status, redirects, canonical chains, noindex incl. headers, titles, descriptions, H1s, duplicates, thin pages, broken links in and out, images, sitemap validity, structured data, speed; issue categories and severities as the page shows them; pages table; our score; recheck; history) | our crawler ported to arion-func, cap lifted, non-2xx kept, the page's current fields matched; plugin links and media audit called; PSI per key page | the crawler, issue tables, the score, the page rewired | 140 |
| **Competitor analysis** (their positions on your keywords, share of top 10, moves, content gap, their top pages from sitemaps, authority) | the same pulls; the competitor rankings report and Market Monitor moves on our tables; caps aligned with the ladder; "Domain Trust" becomes link strength | | 20 |
| **Backlinks** (own: total, referring domains, new and lost; competitors; authority) | Bing inbound links (free) for the client; the feed for competitors and the score, Growth monthly, Authority weekly | Bing first, feed adapter second, diffs ours | 28 |
| **LLM mentions / AI search** (prompts, engines, mentioned, position, citations, competitor mentions, top source pages, engine breakdown, visibility score, current vs prior, linked count) | our runner: Google AI Overviews and AI Mode through the feed (whether AI Overview text comes without an extra parameter is unconfirmed and is checked first); ChatGPT and Gemini through the feed's LLM pages or their APIs in web-search mode (plain API answers carry no citations); Claude and Perplexity only if you add them as engines (neither is an engine today; Perplexity is consulting-only in `routes/arion.js:4276`); our visibility formula; the Overview AI cards made real | runner, engine adapters, mention and citation parser, formula, the pages | 90 |
| **Page changes** | ours; fix the 100 % magnitude defect | | 2 |
| **Reports** (per-client scheduled SEO report, white-label PDF, the Reports page) | new: today the Reports page is five static cards with a dead button; the Insights review email and agency branding exist and are reused | the page, a scheduled report, a PDF | 40 |
| **Search pages, Core Web Vitals, Indexing, Sitemaps, IndexNow, Bing Copilot** | already connected; the page defects fixed (section 6) | | 14 (inside the defects) |
| **Metering and tiers** | feed spend carried in the tier price (recommended) with a per-client cost line on the agency's usage page; or ARGUS credits, which needs a per-request mode, a never-refuse rule for included checks and an arion-func path | | 20 |
| **Copy** | SE Ranking's name removed from 38 Portal files, the LUMEN dashboards and the usage page; the Intelligence calculators, onboarding, provisioning, the LUMEN alert and OLIVER status re-keyed off our tables | | 56 |
| | | **Core total** | **about 650** |
| **Competitive extras**: SERP features tracked (local pack, snippets, AI block present), share of voice, cannibalisation on the SEO pages, rank alerts, keyword tags, multi-location sets, international engines, data retention | | | **about 100** |
| **Testing to the walk bar** (every page clicked on dev and on a real client after each phase) | | | **about 50** |

---

## 4. The data feed, priced at our tier ladder (prices read today, `RESEARCH_SEO_PRICES` sections 1 and 4)

Feed prices: Google or Bing SERP $0.0006 per pull per page of 10 results (standard queue); AI pages $0.0012; backlinks $0.024 per request plus rows (about $0.084 for a summary and a referring-domains pair); keyword volume $0.06 per task of up to 1,000 keywords; $50 prepayment, no plan.

| Tier (today's settings) | SERP pulls a year | Top 10 | Top 30 | AI daily / weekly | Backlinks | Per client, top 30, daily AI |
|---|---|---|---|---|---|---|
| Starter: 10 keywords, 2 engines, monthly | 240 | $0.14 | $0.43 | none | none | **$1** |
| Essentials: 25, 3 engines, weekly | 3,900 | $2.34 | $7.02 | none | none | **$8** |
| Growth: 60, 3 engines, daily, 2 Google AI engines, 5 prompts | 65,700 | $39.42 | $118.26 | $4.38 / $0.62 | $6.05 monthly, 6 domains | **$129** |
| Authority: 150, 3 engines, daily, 4 AI engines, 5 prompts | 164,250 | $98.55 | $295.65 | $8.76 / $1.25 | $48.05 weekly or $11.09 monthly, 11 domains | **$353** |

Ten clients a year: all Authority **$3,530**; all Growth **$1,290**; three Starter, three Essentials, three Growth, one Authority **$750**; all Essentials **$31**. SE Ranking at today's list prices: Core + AI Search + API **$2,633** (ten projects; client eleven forces Growth), Growth + AI Search + API **$4,073**.

**Authority, two settings that keep it well under SE Ranking without losing what the page shows:** daily top 10 plus weekly top 30 ($141), AI weekly ($1.25), backlinks monthly ($11): **$153 a client, $1,530 for ten.** The client copy on the AI Prompts page promises daily checks today (`SeoAIPrompts.tsx:300`); weekly needs the copy changed (decision 4). Model-API token costs for direct prompts are not read today and go on the register when the runner is priced.

Every SERP vendor gets Google results by automated searching; buying from a vendor puts that on the vendor (Google's case against SerpApi was dismissed on 20 July 2026, per the vendor's blog and press). We never scrape Google ourselves.

---

## 5. Design, in plain words

1. **Our tables first**: `seo_keyword`, `seo_competitor`, `seo_prompt`, `seo_position` (with landing URL, volume, CPC, competition, depth), `seo_ai_answer`, `seo_audit_run` and `seo_audit_issue`. The old history table is read into the new one once, with keyword and engine ids mapped, so the Insights aggregation (which counts by keyword id and picks the engine with most rows) does not split the switch month.
2. **One feed adapter** (`lib/serpFeed.js`), one provider behind an environment setting; every call records its cost per site; the scheduler runs in arion-func by `seo_addon_tier` and skips cancelled add-ons (today's capture includes them).
3. **The eight routes** read our tables and keep their response shapes, so the Portal pages change only where SE Ranking's name was printed.
4. **The crawler is ours**, in arion-func, sitemap-driven, polite, keeping every status, recording redirect chains, canonical chains, noindex from meta and headers, inlinks, broken links, sizes, timings, duplicates and thin pages; the plugin adds Rank Math intent and media; PSI per key page. The score is our formula, labelled ours.
5. **LLM mentions**: a weekly or daily runner (by tier) asks each engine the client's prompts, with web search on so answers carry sources; stores the answer, finds the brand and competitors, records cited URLs, scores visibility per engine with a formula we publish; Google's AI blocks come from the SERP pull.
6. **Link strength**: referring domains and their link counts from the feed, normalised 0-100 across our clients and their competitors, labelled ours. No vendor score quoted.
7. **Switch-off per site**: a site moves when its pages render from our tables; both run for a month; the SE Ranking project is deleted after that and `se_ranking_project_id` is retired only after onboarding, the Intelligence calculators, the LUMEN alert and OLIVER status read our tables instead (deleting it earlier blanks the pages and fires the alert for every SEO client).
8. **Tiers stay**, priced from the feed and carried in the tier price; Starter and Essentials cost cents and can be included with any website.

---

## 6. The fourteen defects on these pages (fixed in Phase 1; on the register 21:37Z)

Competitors "Your Domain Trust" always a dash; Core Web Vitals hard-coded "--" while the CrUX route exists; Sitemaps and Bing Copilot read a route that never returns their data; Bing keyword research called with an empty query; page-change magnitude always 100 %; Overview AI cards permanent placeholders; `/search/performance` guesses the Search Console property and uses the wrong token reader; `arion.gsc_data` written only by a one-tenant script; the Insights search score from constants; five dashboard metrics with no production writer; opening the SEO Overview starts a paid SE Ranking audit; Portal competitor caps disagree with the ladder; hard-coded "Healthy" rows on the ARGUS detail; the Reports page's dead button.

---

## 7. Build steps and hours

| Phase | Steps | Hours |
|---|---|---|
| **1. Free sources, our tables, our crawler** (8 weeks) | tables and the history mapping 30; the fourteen defects 50; Core Web Vitals on stored PSI, Opportunities and striking distance on Search Console positions, Bing monthly snapshot, Bing keyword call, plugin links and media audit called 24; crawler ported and widened, issue tables, score, Site Audit rewired 140; on-page checker 24 | **268** |
| **2. The feed, the routes, LLM mentions** (6 weeks) | feed adapter + scheduler by tier + cost recording 40; the eight routes on our tables 70; competitor analysis 20; local rank 16; the AI runner, engines, citations, formula, pages 90; metering and the usage line 20 | **256** |
| **3. Backlinks, keyword data, the rest of the wiring, switch-off** (4 weeks) | Bing links + feed + link strength 28; keyword data + cache + difficulty + Content Agent 36; Intelligence calculators, onboarding, provisioning, LUMEN alert, OLIVER status 40; Portal and LUMEN copy 16; Reports page, scheduled report, PDF 40; per-site switch-off with a month of both 8 | **168** |
| **Extras and testing** | SERP features, share of voice, cannibalisation, alerts, tags, multi-location, retention 100; walk-bar testing 50 | **150** |
| | **Total** | **about 840 hours** (core about 690; the review's core range 520-650 did not count the Reports page or the extras) |

---

## 8. How you verify

- Phase 1: the dev Site Audit page shows our crawl of the dev site with the same categories and severities as today, clickable to the page; Core Web Vitals shows numbers; Opportunities lists Search Console queries at positions 11-20 with real impressions; opening the Overview starts nothing paid.
- Phase 2: Rankings for one real client shows the feed's positions beside the last SE Ranking positions for a month; the AI Search page shows an answer text, the mention, the position and the cited pages for one prompt on each engine, dated; the usage page shows that client's data cost.
- Phase 3: Competitors shows link strength labelled ours; the SE Ranking project for that site is deleted and nothing on the Portal, in LUMEN's alerts or in OLIVER's onboarding changes.

---

## 9. Decisions for Brandon

1. **The feed provider.** DataForSEO (recommended) or Serper for SERPs only.
2. **Depth and cadence per tier.** Recommended: Starter and Essentials top 10 as today; Growth daily top 30; Authority daily top 10 plus weekly top 30 ($153 a client) rather than daily top 30 ($353).
3. **Backlinks** on Growth (monthly) and Authority (weekly), or Authority only.
4. **AI checks daily** (as the client copy promises) or weekly with the copy changed; and whether Claude and Perplexity become engines, on which tiers.
5. **Citations**: web-search mode on every engine (costs more per prompt) or Google's AI blocks only for sources.
6. **Feed spend in the tier price** (recommended) or as ARGUS credits (needs a per-request mode and a never-refuse rule for included checks).
7. **History**: keep the twelve months as the "before" line with id mapping (recommended) or restart.
8. **Switch-off date**, which needs the SE Ranking renewal date.
9. **The authority name**: "Link strength" (recommended).
10. **The Reports page**: scheduled per-client reports and a white-label PDF in Phase 3 (recommended) or later.
11. **The extras** (SERP features, share of voice, alerts, tags, multi-location) in this scope or a later one.

---

## 10. Out of scope

- Social listening and social tools (SPARK covers posting).
- Paid-search research.
- An agency marketplace listing.
