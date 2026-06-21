// lib/rateLimiter.js — F-SEC2.1
// ---------------------------------------------------------------------------
// In-app sliding-window rate limiter. Process-local, zero deps. Resets on
// pod restart — acceptable for V1 abuse prevention (Brandon's call).
//
// Each key tracks an array of recent hit timestamps (ms). On checkRate we
// prune entries older than the window, count remaining + 1, and return
// {ok, retryAfter}. If ok=false, retryAfter is seconds until the oldest hit
// inside the window falls out.
//
// Use one key per dimension you want to limit on (IP, email, tenant, etc.)
// and call checkRate twice — whichever dimension hits its cap first denies.
//
// Memory:  Map of key → number[]. Janitor sweep every 10 min drops empty
//          keys (last hit older than the window). Bounded under steady
//          unique-key load.

const buckets = new Map(); // key → number[] of hit timestamps in ms

/**
 * Sliding-window check.
 * @param {Object}  args
 * @param {string}  args.key         Cache key (e.g. "ip:1.2.3.4", "email:foo@bar")
 * @param {number}  args.windowSec   Window length in seconds
 * @param {number}  args.maxHits     Max hits allowed in the window (inclusive)
 * @returns {{ok: boolean, retryAfter: number}}  retryAfter is ceiling seconds.
 */
export function checkRate({ key, windowSec, maxHits }) {
  const now = Date.now();
  const cutoff = now - windowSec * 1000;
  let hits = buckets.get(key);
  if (!hits) {
    hits = [];
    buckets.set(key, hits);
  }
  // Prune anything older than the sliding window.
  while (hits.length && hits[0] <= cutoff) hits.shift();
  if (hits.length >= maxHits) {
    // Oldest in-window hit falls out at hits[0] + windowSec*1000.
    const retryAfter = Math.max(1, Math.ceil((hits[0] + windowSec * 1000 - now) / 1000));
    return { ok: false, retryAfter };
  }
  hits.push(now);
  return { ok: true, retryAfter: 0 };
}

/**
 * Extract a client IP from an Express request, honouring x-forwarded-for from
 * the App Service front door. Falls back to socket.remoteAddress. Returns
 * "unknown" as a last resort so the limiter never crashes on a weird request.
 */
export function getClientIp(req) {
  const xff = req.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || req.ip || "unknown";
}

// Periodic janitor — drop keys whose last hit is older than any reasonable
// window (10 min). Keeps the Map bounded under heavy unique-key load
// (e.g. distributed credential-stuffing across many IPs).
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, hits] of buckets) {
    if (!hits.length || hits[hits.length - 1] <= cutoff) buckets.delete(k);
  }
}, 10 * 60 * 1000).unref();
