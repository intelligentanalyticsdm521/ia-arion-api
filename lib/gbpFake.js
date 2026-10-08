// lib/gbpFake.js — Google reviews on a dev machine, from a file.
//
// ARGUS employees, phase 1 (CONTRACT_ARGUS_EMPLOYEES_PHASE1 §G.5). The review
// replies job cannot be exercised on dev without a real Google Business
// Profile, so a dev machine may point it at a JSON file instead:
//
//   { "<location name>": { "reviews": [ { reviewId, reviewerName, starRating,
//                                         comment, createTime } ],
//                          "replies": [ { reviewId, comment, at } ] } }
//
// TWO LOCKS, BOTH REQUIRED (the safeUrl.localAllowed rule):
//   1. process.env.WEBSITE_SITE_NAME is unset (every App Service sets it, so
//      production can never take this path), AND
//   2. process.env.ARION_GBP_FAKE_FILE names a file.
// Either lock missing -> the real Google functions. A test proves a set
// WEBSITE_SITE_NAME ignores the file.

import fs from 'node:fs';
import { fetchReviews as realFetchReviews, replyToReview as realReplyToReview } from './gbpApi.js';

export function fakeEnabled(env = process.env) {
  return !env.WEBSITE_SITE_NAME && !!String(env.ARION_GBP_FAKE_FILE || '').trim();
}

function readFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

export function fakeApi(file) {
  return {
    fake: true,
    async fetchReviews(_token, locationName) {
      const all = readFile(file);
      const loc = all[locationName] || { reviews: [], replies: [] };
      const replies = new Map((loc.replies || []).map((r) => [String(r.reviewId), r]));
      const reviews = (loc.reviews || []).map((r) => ({
        reviewId: String(r.reviewId),
        reviewerName: r.reviewerName || 'A customer',
        starRating: Number(r.starRating) || 0,
        comment: r.comment ?? null,
        createTime: r.createTime || null,
        updateTime: r.updateTime || r.createTime || null,
        replyComment: replies.get(String(r.reviewId))?.comment || r.replyComment || null,
        replyUpdateTime: replies.get(String(r.reviewId))?.at || null,
      }));
      return { totalReviewCount: reviews.length, averageRating: 0, reviews };
    },
    async replyToReview(_token, locationName, reviewId, comment) {
      const all = readFile(file);
      const loc = all[locationName] || (all[locationName] = { reviews: [], replies: [] });
      loc.replies = (loc.replies || []).filter((r) => String(r.reviewId) !== String(reviewId));
      loc.replies.push({ reviewId: String(reviewId), comment, at: new Date().toISOString() });
      fs.writeFileSync(file, JSON.stringify(all, null, 2));
      return { reply: { comment } };
    },
  };
}

/** The sentence a machine that is not the live service answers when asked to post. */
export const NOT_LIVE_WORDS = "Replies are posted to Google only by the live service. On this machine, set ARION_GBP_FAKE_FILE to try it.";

/**
 * The review functions to use: the file on a dev machine with both locks;
 * Google on the live service. A machine that is NEITHER (no App Service, no
 * fake file) may READ Google but never POSTS to it: a dev database can hold a
 * real business's Google connection, and a test run must not answer its real
 * reviews. Fail closed: the post is refused with a sentence.
 */
export function reviewsApi(env = process.env) {
  if (fakeEnabled(env)) return fakeApi(String(env.ARION_GBP_FAKE_FILE).trim());
  if (!env.WEBSITE_SITE_NAME) {
    return { fake: false, readOnly: true, fetchReviews: realFetchReviews, replyToReview: async () => ({ error: NOT_LIVE_WORDS }) };
  }
  return { fake: false, fetchReviews: realFetchReviews, replyToReview: realReplyToReview };
}

export default { fakeEnabled, fakeApi, reviewsApi };
