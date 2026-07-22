# ARION Scoring Model — Canonical Reference

> **Purpose:** Every Platform Score, Trend Score, Intelligence Score, and Business Pulse value that appears in the Portal must trace back to a specific input + calculation documented here. If you find a discrepancy between this doc and code, fix the code — this doc is the contract.
>
> **Last audited:** 2026-07-01 (F-Onb-D8)
>
> **Related:**
> - `overnight-report/64_INTELLIGENCE_TRENDS_REWORK_CANONICAL_SCOPE.md`
> - `overnight-report/SCOPE_WORKING.md` — "Intelligence" locked section
> - Locked architecture note in `arion-api/lib/intelligence/platformPulse.js` L1-25 (Brandon 2026-06-21)

---

## 1. Score hierarchy — what feeds what

```
Business Pulse (ARGUS surface, cross-platform)
        ▲
        │ avg( active Platform Pulses )
        │
Platform Pulse (per product — ARION, OLIVER, SPARK)
        ▲
        │ (Trend + Intelligence) / 2   ← canonical backend rule
        │   Portal "Platform Score" pages currently use a
        │   different weighting — see §2 and §10 for the
        │   discrepancy that must be reconciled.
        │
   ┌────┴───────────────────────────┐
   │                                │
Trend Score                    Intelligence Score
(composite of 8               (average of unlocked
 Trend Engines,                Intelligence Reports,
 per platform)                 varies per platform tier)
```

- **Business Pulse** is an ARGUS-only cross-platform surface. It is NOT part of any single platform's Platform Score.
- **Platform Pulse** is what the backend `platformPulse.js` computes and caches per tenant.
- **Platform Score** is what the Portal `IAInsightsHealthPage` components render at the top of each product's Insights health page.

---

## 2. Weight formulas

There are **two coexisting weightings** in code today and they do not agree. Reconciling them is an open item (see §12).

### 2a. Backend — Platform Pulse (`arion-api/lib/intelligence/platformPulse.js`)

`combineComponents(trend, intel)` at L116-…:

- Both present → `pulse = round1((trend + intel) / 2)` (i.e. **50/50**)
- Trend only → `pulse = trend` (`partial: true`)
- Intel only → `pulse = intel` (`partial: true`)
- Neither → `pulse = null` (`no_data: true`)

Cache: `arion.platform_pulse_cache` (migration 030). Soft TTL 6 h (`CACHE_TTL_MS`), hard max 24 h (`CACHE_HARD_MAX_MS`).

### 2b. Portal — Platform Score (per-product health pages)

`Portal/src/arion/pages/iainsights/ArionIAInsightsHealthPage.tsx` L20-25 `platformScore()`:

```ts
// Weighted Platform Score: 60% Trend + 40% Intelligence when both unlocked;
// falls back to 100% Trend when Intelligence is locked or NULL.
if (intelligenceLocked || intelligenceScore == null) return trendScore;
return Math.round(trendScore * 0.6 + intelligenceScore * 0.4);
```

Same 60/40 formula appears in:
- `Portal/src/pages/oliver/OliverIAInsightsHealthPage.tsx` L15-18
- `Portal/src/pages/spark/SparkIAInsightsHealthPage.tsx` L16-18

### 2c. Portal — `platformScoreWeights()` in shared types

`Portal/src/components/iainsights/types.ts` L98-105 is the "spec §1.4 fallback" helper. Its weights are:

| hasTrend | hasIntelligence | hasCrossChannel | trend | intelligence | crossChannel |
|---|---|---|---|---|---|
| ✓ | ✓ | ✓ | 0.35 | 0.35 | 0.30 |
| ✓ | ✗ | ✓ | 0.55 | 0.00 | 0.45 |
| ✓ | ✓ | ✗ | **0.50** | **0.50** | 0.00 |
| ✓ | ✗ | ✗ | 1.00 | 0.00 | 0.00 |
| ✗ | — | — | 0.00 | 0.00 | 0.00 |

Note the trend/intelligence-only row is **50/50**, matching the backend, not the 60/40 that the per-product health pages actually use.

### 2d. ARGUS Health page

`Portal/src/pages/argus/ArgusHealthPage.tsx` L64: `platformScore = Math.round(trendScore * 0.5 + intelScore * 0.5)` — **50/50** again.

### 2e. Trend Score composite

Sum of 8 engine outputs (each already 0-100), weighted per `businessPresenceEngine()` in `Portal/src/arion/analytics/trendEngines.ts` L744-800:

```
visibility  0.20
conversion  0.20
search      0.15
local       0.15
content     0.12
audience    0.10
technical   0.08
                  = 1.00
```

### 2f. Intelligence Score composite

Arithmetic mean of unlocked reports with non-null numeric scores. Formula lives twice:

- **Backend aggregate** — `arion-api/lib/intelligence/index.js` L256-263 `runAllArionIntelligence()`: filters `ARION_INTEL_REPORTS` (9 keys) by `unlocked` set, keeps numeric finite scores, returns `Math.round(sum / count)` or `null`.
- **Platform Pulse** — `platformPulse.js` `computeIntelligenceComponent()` L89-110: SQL avg over `arion.intelligence_cache` restricted to the **legacy 6-key set** (see §12 known gaps).

---

## 3. ARION Trend Engines (8) — `Portal/src/arion/analytics/trendEngines.ts`

Each engine is a pure function `(EngineInput) → ReportAnalysis` with `score`, `scoreInputs[]`, `observations[]`, `actions[]`, `contextNote?`. `EngineInput` shape defined L18-48.

| # | Engine | Line | Business question | Inputs | Composite weights (internal) | Missing-data fallback |
|---|---|---|---|---|---|---|
| 1 | `visibilityReachEngine` | L149 | "Are people finding me?" | GA4 `d`, GSC `searchData`, GBP `gbpData`, Bing `bingData`, `serviceArea` | impression_to_visit 0.40 · local_traffic_share 0.25 · channel_diversity 0.20 · non_brand_impressions 0.15 | Uses 35–50 defaults per component when input null; `scoreFromBenchmark` returns 50 on zero benchmark. |
| 2 | `audienceIntelligenceEngine` | L247 | "Who is actually visiting and are they the right people?" | GA4 `d` (summary, engagement, devices) | session_quality 0.35 · bounce 0.25 · mobile_share 0.20 · new_returning_balance 0.20 | Components default to 50 when devices/users unavailable. |
| 3 | `conversionIntelligenceEngine` | L323 | "Where does my funnel break?" | GA4 form events, `sparkConnected`, `formToContactRate`, GBP calls | visit_to_submit 0.35 · form_completion 0.25 · cta_placement 0.20 · form_to_contact 0.20 | `closedLoopScore = 40` when SPARK not connected. |
| 4 | `searchIntelligenceEngine` | L411 | "Am I winning the searches that matter?" | GSC `searchData` (summary + queries), `seoData`, `seoDecayData` | avg_position 0.35 · ctr_vs_benchmark 0.25 · quick_win_count 0.20 · non_brand_balance 0.20 | positionScore defaults 30 when no avgPos; ctrScore/brandBalance default 50. |
| 5 | `contentIntelligenceEngine` | L510 | "Is my content earning its place?" | GA4 pages, `pluginData` (wordCount, age), GSC queries | engagement_pct 0.30 · thin_content_ratio 0.25 · content_gap_count 0.20 · avg_post_depth 0.25 | Each component defaults 50 when totals are zero. |
| 6 | `localPresenceEngine` | L586 | "Do I look trustworthy to someone who finds me locally?" | GBP `gbpData` + reviews + posts + Q&A | completeness 0.20 · velocity 0.25 · response_rate 0.25 · rating 0.30 | Returns hard `score: 0` with locked observation when GBP not connected (L588-596). |
| 7 | `technicalHealthEngine` | L672 | "Is the foundation solid and what is the business cost of current issues?" | `pluginData.psi`, Wordfence `wfFull`, plugin update counts | mobile_perf+desktop_perf/2 (perf) 0.30 · security 0.25 · cwv 0.25 · updates 0.20 | Security defaults 80 when Wordfence absent and 0 vulnerabilities; updates defaults 100 when 0 outdated. |
| 8 | `businessPresenceEngine` | L744 | "What does my complete online presence look like as a whole?" | The 7 engine scores above | See §2e weights | Missing keys treated as 0; also emits top-3 impact-weighted gaps. |

`runAllReports(input)` (L816-834) is the caller entrypoint; it invokes engines 1-7 then feeds their scores into engine 8.

---

## 4. ARION Intelligence Reports — `arion-api/lib/intelligence/*.js`

Canonical 9-report shelf per doc-64 (`arion-api/lib/intelligence/index.js` L54-64, exported as `ARION_INTEL_REPORTS`):

| # | Report key (constant) | Label | Source badge | Calculator | Status | Tier gate (`REPORT_MIN_TIER`) | Data floor |
|---|---|---|---|---|---|---|---|
| 1 | `visibility_trajectory` (`KEY_TRAJ`) | Visibility Trajectory | Google Search Console | `visibilityTrajectory.js` `calculateVisibilityTrajectory` | Live | standard | (per file) |
| 2 | `pagespeed_decay_forecast` (`KEY_PSI_DECAY`) | PageSpeed Decay Forecast | PageSpeed Insights + IA Plugin | Phase-1 stub (`pendingImplementationStub`) | Phase-1 shell | standard | 2 snapshots for distribution / 30+ for forecast |
| 3 | `site_audit_risk_prediction` (`KEY_AUDIT_RISK`) | Site Audit Risk Prediction | SE Ranking audit history | Phase-1 stub | Phase-1 shell | pro | 3 completed audits |
| 4 | `keyword_position_trajectory` (`KEY_KW_TRAJ`) | Keyword Position Trajectory | SE Ranking position history | Phase-1 stub | Phase-1 shell | pro | 90d position history |
| 5 | `backlink_velocity_anomaly` (`KEY_BL_ANOMALY`) | Backlink Velocity Anomaly | SE Ranking backlink stats | Phase-1 stub | Phase-1 shell | pro | 60d backlink snapshots |
| 6 | `content_quality_cluster` (`KEY_CONTENT_CLUSTER`) | Content Quality Cluster | IA Plugin RankMath + GA4 + GSC | Phase-1 stub | Phase-1 shell | pro | Plugin installed + 30d GA4 |
| 7 | `local_pack_visibility_forecast` (`KEY_LOCAL_PACK`) | Local Pack Visibility Forecast | GBP insights + reviews | Phase-1 stub | Phase-1 shell | standard | 60d (90d for confident forecast) |
| 8 | `crawl_budget_optimization` (`KEY_CRAWL_BUDGET`) | Crawl Budget Optimization | SE Ranking audit + GSC index coverage | Phase-1 stub | Phase-1 shell | business | 1 audit + 90d GSC |
| 9 | `competitive_presence_gap` (`KEY_COMP_GAP`) | Competitive Presence Gap | SE Ranking competitor visibility | `competitivePresence.js` `calculateCompetitivePresence` | Live | pro | (per file) |

Legacy report keys kept in `CALCULATORS` for cache back-compat but demoted out of the shelf (`arion-api/lib/intelligence/index.js` L165-171 + REPORT_LABEL/SOURCE L99-124):

| Legacy key | Constant | Real calculator | Source | Legacy `REPORT_MIN_TIER` |
|---|---|---|---|---|
| `seo_authority` | `KEY_SEO` | `seoAuthority.js` `calculateSeoAuthority` | SE Ranking | standard |
| `competitive_presence` | `KEY_COMP` | `competitivePresence.js` `calculateCompetitivePresence` | SE Ranking | pro |
| `crawl_depth` | `KEY_CRAWL` | `crawlDepth.js` `calculateCrawlDepth` | SE Ranking audit | pro |
| `schema_coverage` | `KEY_SCHEMA` | `schemaCoverage.js` `calculateSchemaCoverage` | SE Ranking + IA Plugin | business |
| `pagespeed_distribution` | `KEY_PSI` | `pageSpeedDistribution.js` `calculatePageSpeedDistribution` | PageSpeed Insights | standard |

### Tier unlocks

`arion-api/lib/intelligence/index.js` L72-80 `TIER_UNLOCKS` maps every seo_addon_tier value (`standard`, `pro`, `business`, `starter`, `essentials`, `growth`, `authority`) to the **same** `ALL_NEW_KEYS` set — every unlock check currently returns "unlocked" for the whole 9-report shelf. Per-report gating comes from `REPORT_MIN_TIER` (L174-190), which is enforced by the route layer, not the aggregator. This is intentional per the comment at L68-71: "Intelligence is no longer a flat tier wall. Until the SEO addon catalog is retiered to standard/pro/business in a separate workflow, every SEO-tier gets the same unlock set; the per-report gate in `REPORT_MIN_TIER` below is what actually limits access."

### siteAgeMultiplier

`siteAgeMultiplier(createdAt)` + `applyAgeMultiplier(rawScore, multiplier)` land in `arion-api/lib/intelligence/utils.js` as of 2026-07-03. See §5 for behavior and §6 for the paired `SIGNAL_REGISTRY`. Six calculators (competitivePresence, crawlDepth, pageSpeedDistribution, schemaCoverage, seoAuthority, visibilityTrajectory) consume `ctx.siteAgeMultiplier` seeded by `routes/arion/intelligence.js` and export a `SIGNALS_USED` array of canonical registry keys for provenance.

---

## 5. Site age multiplier

**Status: SHIPPED as of 2026-07-03** (F-Onb-D7). Location: `arion-api/lib/intelligence/utils.js` `siteAgeMultiplier(createdAt)` + `applyAgeMultiplier(rawScore, multiplier)`.

- **Formula:** linear ramp — `0.5` when `ageDays ≤ 7`, `1.0` when `ageDays ≥ 30`, linear between.
- **Application order:** post-score-formula, pre-clamp, pre-tier.
- **Rationale:** brand-new sites lack historical data; showing an "A" score is misleading. Dampening surfaces "we don't know yet" without hiding the report card.
- **Consumers:** six calculators (competitivePresence, crawlDepth, pageSpeedDistribution, schemaCoverage, seoAuthority, visibilityTrajectory) call `applyAgeMultiplier(rawScore, ctx?.siteAgeMultiplier ?? 1.0)` and surface an observation when the multiplier < 1.0. `routes/arion/intelligence.js` seeds `ctx.siteAgeMultiplier` from `site.created_at` before the aggregator runs.
- **Verification:** grep confirms all 6 active calculators wire the helper. NULL/insufficient_data scores pass through unchanged (guarded at `applyAgeMultiplier` line 162).

---

## 6. Signal registry

**Status: SHIPPED as of 2026-07-03** (F-Onb-D7). Location: `arion-api/lib/intelligence/utils.js` `SIGNAL_REGISTRY` (line 107+).

Tier legend:

- `free` — no paid dependency (GSC, PageSpeed public API, IA Plugin data including free Wordfence signals)
- `paid-seranking` — requires an SE Ranking project + AIRT key

`SIGNAL_REGISTRY` keys currently mapped: GSC (impressions_trend / projected_impressions / avg_position), PSI (snapshot + CWV lcp/cls/inp), IA Plugin (rankmath / security), SE Ranking (own_visibility / competitor_avg / referring_domains / dofollow_backlinks / gap_count / gap_rate / keywords_tracked / audit).

Each calculator exports a `SIGNALS_USED` array of canonical keys. The audit / modal layer reads `SIGNAL_REGISTRY[key]` to render provenance ("GSC average position — Google Search Console") and gate paid signals when the tenant lacks the SE Ranking add-on.

Note: the earlier spec included a `paid-wordfence` tier. In practice Wordfence signals are surfaced via the IA Plugin free tier (rule-based scan output) so they are registered as `plugin.security` under `free`. If a future Wordfence Premium integration exposes a metered API, add a `paid-wordfence` tier and re-classify accordingly.

---

## 7. Business Pulse (ARGUS gauges)

**Owner:** `platform-api` (not `arion-api`). Route: `platform-api/routes/argus/businessPulse.js`. Related: `LUMEN-API/src/lib/platformPulse.js`, `iadm-webhooks/src/functions/platform-pulse-refresh.js`, migration `LUMEN-API/db/migrations/050_platform_pulse_caches.sql`.

Business Pulse = average of all **active** Platform Pulses (equal weight), per the locked architecture note at `arion-api/lib/intelligence/platformPulse.js` L3-5:

```
Platform Pulse = (Trend Score + Intelligence Score) / 2
Business Pulse = avg(active Platform Pulses) — equal weight
```

"Active" = tenant subscribes to / has activated this product. Gauges rendered by `Portal/src/pages/argus/ArgusHealthPage.tsx` (see L64-76 for the platform-score composition ARGUS applies per platform when building its own dashboard). The 4-gauge shape (Business Pulse + 3 per-platform Platform Pulses) is documented in the `platform_intelligence_argus` memory reference.

Detailed input mapping for each gauge lives in `platform-api/routes/argus/businessPulse.js` — reconcile there before quoting exact metrics.

---

## 8. Feature gates

Both gates below are ON as of 2026-07-01 and stay ON until Brandon walks this MODEL.md against live data. Do NOT flip via this doc — flip in a separate PR after the walk.

- `INSIGHTS_GLOBAL_GATE` — `Portal/src/components/iainsights/IAInsightsHeader.tsx` L42, currently `true` (banner shown across all Insights headers). Comment at L40 references this file and F-Onb-D8 explicitly.
- `withInsightsComingSoon()` — `Portal/src/pages/ServiceRouter.tsx` L52 wraps every Insights route (ARION, OLIVER, SPARK, ARGUS) — see L468-470, 549-553, 689-691. Currently active (Coming Soon wrapper renders instead of the page body).

---

## 9. Persistence + history

- `arion.ia_insights_score_history` — one row per (tenant, report_key, period_end) with `score`. Used for trend arrows + ghost bars. Read by `platformPulse.js` `computeTrendComponent()` L61-83 (`ROW_NUMBER() OVER (PARTITION BY report_key ORDER BY period_end DESC)`).
- `arion.intelligence_cache` — one row per (tenant, report_key) with `payload_json` + `score` + `relocated_to`. 12h TTL (`CACHE_TTL_MS` in `utils.js` L22). Read by `platformPulse.js` `computeIntelligenceComponent()` L89-110.
- `arion.platform_pulse_cache` — one row per tenant. 6h soft TTL, 24h hard max. Migration 030.
- Prior-score fallback: `/ia-insights/prior-scores` returns row-per-report or null; consumed by the Portal `*IAInsightsHealthPage` components to render the "previous score" delta.

---

## 10. Reconciliation rule

When Intelligence is NULL or all reports are locked, the Portal Platform Score falls back to 100 % Trend Score. Documented at `Portal/src/arion/pages/iainsights/ArionIAInsightsHealthPage.tsx` L20-25 (and mirrored in the Oliver and Spark equivalents). Backend `platformPulse.js` `combineComponents()` L128-… mirrors the same behavior (partial: true, pulse = trend).

**Weighting discrepancy — RESOLVED 2026-07-22 (August score-weight fix):**
all four implementations now compute **50/50** when both components are
present, per Brandon's locked 2026-06-21 rule (`platformPulse.js` L3-5). The
three per-product Portal pages (`ArionIAInsightsHealthPage.tsx`,
`OliverIAInsightsHealthPage.tsx`, `SparkIAInsightsHealthPage.tsx`) were the
60/40 outliers; corrected in the same pass along with the "60% Trend + 40%
Intelligence weighted." message string.

---

## 11. Cross-references

- Locked scope: `overnight-report/64_INTELLIGENCE_TRENDS_REWORK_CANONICAL_SCOPE.md`
- Brandon decision log: 2026-06-21 architecture correction — locks Platform Pulse = (T + I) / 2, Business Pulse = avg(active platform pulses). Recorded verbatim as the header comment in `arion-api/lib/intelligence/platformPulse.js` L1-25.
- F-Onb-D7 (siteAgeMultiplier + SIGNAL_REGISTRY) — designed 2026-07-01, code not yet landed.
- F-Onb-D8 (this doc) — canonical scoring reference, initial audit 2026-07-01.

---

## 12. Known gaps / open items

1. ~~**Weight discrepancy (§2).**~~ **CLOSED 2026-07-22** — 50/50 adopted everywhere (see §10). The 60/40 helpers in the three per-product health pages were corrected in place.
2. ~~**siteAgeMultiplier not implemented (§5).**~~ **STALE — it IS shipped**: `lib/intelligence/utils.js` L140 (verified 2026-07-22; consumed by 6 calculators, e.g. `visibilityTrajectory.js` L98).
3. ~~**SIGNAL_REGISTRY not implemented (§6).**~~ **STALE — it IS shipped**: `lib/intelligence/utils.js` L107 (verified 2026-07-22).
4. **Legacy vs shelf intelligence-key mismatch (§2f, §4).** `platformPulse.js` `ARION_INTEL_REPORT_KEYS` (L44-51) is the pre-doc-64 legacy 6-key set. `index.js` `ARION_INTEL_REPORTS` (L54-64) is the current doc-64 9-key shelf. The Intelligence component of Platform Pulse averages the legacy set, so Platform Pulse currently ignores the 7 new-shelf keys entirely. Update `platformPulse.js` to read from `ARION_INTEL_REPORTS` (imported) once the Phase 2-4 calculators land.
5. **Phase-1 stub reports (§4).** 7 of 9 shelf reports return `pendingImplementationStub` payloads (score=null, state=`insufficient_data`). Real calculators land in doc-64 Phases 2-4. **2026-07-22 R1 brand fix:** the 7 stub CARDS are pulled from the Portal shelf (`arionIntelligenceEngines.ts` `ARION_INTEL_KEYS` → only `visibility_trajectory` + `competitive_presence_gap` render); the backend stubs remain but are unrendered. Note both gates that §8 claims are ON are actually OFF in code (`INSIGHTS_GLOBAL_GATE=false`; `withInsightsComingSoon` has zero call sites) — the card removal replaces them as the brand protection.
6. **Business Pulse gauge input mapping (§7).** Not enumerated in this doc — needs a walk of `platform-api/routes/argus/businessPulse.js` before publication.
7. **Open questions from F-Onb-D8 scoping** (5 items, deferred to Brandon):
   - Which weight wins — 50/50 or 60/40?
   - Should Trend engine 8 (`businessPresenceEngine`) count toward the Trend Score composite, or is it a separate summary card?
   - Do Phase-1 stub reports count against the Intelligence Score denominator (currently they don't, because `score` is null)?
   - When both Trend and Intelligence are partial (some reports missing), does the composite average only what's present or apply a "collecting" penalty?
   - Should the siteAgeMultiplier apply to Trend engines too, or Intelligence-only?

---

## 13. Change log

- 2026-07-01 — Initial audit + doc creation (F-Onb-D8). Documents actual code state including the 50/50-vs-60/40 discrepancy, the missing D7 helpers, and the legacy vs shelf intelligence-key mismatch.

---

## 14. How to update this doc

- Adding, removing, or renaming a Trend Engine → update §3 with new file:line + composite weights + missing-data fallback.
- Adding, removing, or renaming an Intelligence Report → update §4 table (both shelf and legacy sections) and confirm `REPORT_LABEL` / `REPORT_SOURCE` / `REPORT_MIN_TIER` / `CALCULATORS` / `ARION_INTEL_REPORTS` in `index.js` all agree.
- Changing a weight formula → update §2 AND change the code with the exact same numbers. Do not let this doc drift from `platformScoreWeights()` / `platformScore()` / `combineComponents()`.
- Flipping a feature gate → update §8 and reference the commit. This doc must not be the trigger — the walk is.
- Landing `siteAgeMultiplier` / `SIGNAL_REGISTRY` → rewrite §5 / §6 to describe actual behavior and delete the "NOT YET IMPLEMENTED" callouts.
- Reconciling the 50/50 vs 60/40 discrepancy → delete the loser from §2 and update §10 / §12.
