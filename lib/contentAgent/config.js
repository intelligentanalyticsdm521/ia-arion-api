// lib/contentAgent/config.js
//
// Every tunable the Content & Social Agent reads, in one place.
//
// These are thresholds a human argues about, so they do not belong scattered
// through the pipeline as magic numbers. Anything here that is still awaiting
// Brandon's answer is marked PENDING with the question number from the scope
// doc's Section 36 and a conservative default — conservative meaning "errs
// toward not spending money and not publishing", never "errs toward running".

// ---------------------------------------------------------------------------
// Models — scope 12.2
// ---------------------------------------------------------------------------
// Sonnet 5 drafts; Haiku 4.5 does the cheap mechanical scans (quality auto-fail,
// escalation phrase detection) where full reasoning buys nothing.
//
// Both ids MUST exist in argus/callWrapper.js PROVIDER_COSTS. A model missing
// from that table records a null cost basis, which silently switches off
// outlier-refund protection — the exact class of fail-open bug this codebase
// has been bitten by before. There is a test asserting this.
export const MODELS = {
  DRAFT: 'claude-sonnet-5',
  SCAN: 'claude-haiku-4-5',
};

// Scope 12.2 says no fallback provider: if Claude is unavailable the run halts
// and logs rather than switching models, so voice stays consistent. AC4.
export const ALLOW_MODEL_FALLBACK = false;

// ---------------------------------------------------------------------------
// The kill switch — scope 35 (the rollback plan)
// ---------------------------------------------------------------------------
// Flip this and the agent stops; the manual content workflow carries on with
// zero data loss. It lives HERE as well as on the arion-func timer because a
// switch that only exists in the scheduler does not stop a hand-rolled POST to
// /internal/content-agent-tick, and "the timer is off" is not the same
// statement as "the agent cannot run".
//
// DELIBERATELY BROADER THAN THE TIMER'S CHECK. arion-func tests
// `=== "true"`. This treats ANY value that is not an explicit off-word as ON
// (i.e. disabled), because the two mistakes are not symmetric: a switch set to
// `1` that we read as "not disabled" keeps drafting and keeps spending, while
// a switch set to gibberish that we read as "disabled" costs nothing and says
// so in the log. The asymmetry is pinned by test.
export const KILL_SWITCH_ENV = 'CONTENT_AGENT_DISABLED';
const KILL_SWITCH_OFF_VALUES = new Set(['', 'false', '0', 'no', 'off']);

/** True when the agent must not run at all. */
export function isContentAgentDisabled(env = process.env) {
  const raw = env[KILL_SWITCH_ENV];
  if (raw === undefined || raw === null) return false;
  return !KILL_SWITCH_OFF_VALUES.has(String(raw).trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Cost — scope 29, AC7, failure mode F8
// ---------------------------------------------------------------------------
// PENDING Q3: "What's the per-run/per-cycle hard cost ceiling before the agent
// halts and requires manual reset?"
//
// Defaults below are ~10x the scope's own per-unit estimate: loose enough that
// a normal cycle never trips them, tight enough that a retry storm dies at
// pocket change instead of at the monthly budget.
//
// NOTE ON THE SCOPE'S MATH (flagged 2026-08-23): sections 1.3, 12.2 and 29 all
// price Sonnet 5 at $2/$10 per million tokens. That is PROMOTIONAL pricing that
// expires 2026-08-31. Standard is $3/$15, which is what
// argus/callWrapper.js PROVIDER_COSTS already carries, deliberately, so margin
// is never overstated. Re-running section 29's own estimate at standard rates:
// 10K in + 4K out = (10000/1e6 * 3) + (4000/1e6 * 15) = $0.03 + $0.06 = $0.09
// per blog post, against the doc's stated $0.05-$0.08. At ~30 units/month that
// is ~$2.70, so AC7's "<$10/month" still holds comfortably — but the per-unit
// figure in the doc is low and should be restated.
export const COST = {
  MAX_USD_PER_RUN: 1.0,
  MAX_USD_PER_CYCLE: 3.0,
  // Once a cycle trips its ceiling the agent stays halted until a human clears
  // it. Auto-resuming after a cost breach would defeat the purpose of a breaker.
  REQUIRES_MANUAL_RESET: true,
};

// ---------------------------------------------------------------------------
// Keyword qualification — scope 12.5, 13.2, SEO Standards 2-4
// ---------------------------------------------------------------------------
// The KD ceiling moves with the site's domain-authority stage: a new domain
// that chases KD 40 terms ranks for nothing, while an established one that
// caps at KD 15 leaves traffic on the table.
//
// GAP: IA_SEO_Standards v1.0 is referenced by the scope doc but is not present
// in overnight-report/ or Session Sync, so the exact ladder could not be read
// from source. The shape below follows the doc's own signal (13.2 cites "KD<15"
// as the current working threshold) and is deliberately conservative. CONFIRM
// against IA_SEO_Standards before the agent runs unattended.
export const KD_CEILING_BY_STAGE = {
  new: 15,        // < 6 months, minimal authority — the doc's cited threshold
  emerging: 25,
  established: 40,
  authoritative: 60,
};
export const DEFAULT_AUTHORITY_STAGE = 'new';

// A keyword with no search volume is not worth a post regardless of difficulty.
export const MIN_SEARCH_VOLUME = 20;

// Scope 12.4/12.5: intent must match what a blog post can actually satisfy.
// Transactional intent belongs on a service page, not a post — drafting a blog
// against it produces content that cannot convert and cannot rank.
export const ALLOWED_INTENTS = ['informational', 'commercial'];

// ---------------------------------------------------------------------------
// Dedup + staleness — AC5, Decision Rule 21.1, edge case E4
// ---------------------------------------------------------------------------
export const DEDUP_WINDOW_DAYS = 90;

// E4: "define a staleness threshold, e.g. re-pull if last research is over
// 7 days old". Taking the doc's own suggested value.
export const RESEARCH_STALE_AFTER_DAYS = 7;

// Scope 12.5: two retries, then skip the slot and log "no qualifying topic
// this cycle" rather than forcing a weak post.
export const MAX_TOPIC_RETRIES = 2;

// ---------------------------------------------------------------------------
// Drafting — scope 12.4
// ---------------------------------------------------------------------------
export const DRAFT = {
  MAX_TOKENS: 16000,
  // One retry if required fields are missing or the keyword-placement
  // mechanical check fails (scope 12.4, failure mode F4).
  MAX_VALIDATION_RETRIES: 1,
  TIMEOUT_MS: 120_000,
};

// Scope 12.3: prompt caching on the stable brand/rules portion. The cached
// prefix must clear ~1024 tokens or it silently does not cache at all.
export const CACHE_MIN_PREFIX_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Content types
// ---------------------------------------------------------------------------
export const CONTENT_TYPES = ['blog_post', 'social_carousel', 'social_post'];

// Scope 14: v0.1 handles IL-authored posts only. "Brandon's Take" and
// co-authored types need his actual input and are explicitly out of scope.
export const SUPPORTED_POST_KINDS = ['il_authored'];

export default {
  KILL_SWITCH_ENV,
  isContentAgentDisabled,
  MODELS,
  ALLOW_MODEL_FALLBACK,
  COST,
  KD_CEILING_BY_STAGE,
  DEFAULT_AUTHORITY_STAGE,
  MIN_SEARCH_VOLUME,
  ALLOWED_INTENTS,
  DEDUP_WINDOW_DAYS,
  RESEARCH_STALE_AFTER_DAYS,
  MAX_TOPIC_RETRIES,
  DRAFT,
  CACHE_MIN_PREFIX_TOKENS,
  CONTENT_TYPES,
  SUPPORTED_POST_KINDS,
};
