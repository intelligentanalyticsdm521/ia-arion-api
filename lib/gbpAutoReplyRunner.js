/**
 * GBP auto-reply runner (Pro+ automation, Brandon 2026-07-22).
 * --------------------------------------------------------------------------
 * For every site that opted into gbp_auto_reply and is on Pro+ tier, find
 * reviews at/above the owner's minimum star gate that have NO reply yet,
 * draft a brand-voice reply with Claude (metered on the tenant wallet), and
 * post it to Google. Idempotent by nature — a review that already has a
 * reply is skipped, so re-runs never double-reply.
 *
 * Triggered by the arion-func timer via the internal endpoint; also directly
 * unit-runnable. All the GBP + AI + credit machinery already lives here, so
 * this keeps the worker in one service (arion-func stays a thin scheduler).
 */

import sql from 'mssql';
import { fetchReviews, replyToReview } from './gbpApi.js';
import { draftReviewReply } from './gbpAiReply.js';
import { meetsMinTier } from './tierCheck.js';

const MAX_REPLIES_PER_SITE_PER_TICK = 10; // safety cap on spend + rate

export async function runGbpAutoReplyTick(pool, log = () => {}) {
  const summary = { sitesConsidered: 0, sitesEligible: 0, drafted: 0, posted: 0, skippedInsufficientCredits: 0, errors: [] };

  const sites = (await pool.request().query(`
    SELECT tenant_id, site_id, arion_tier, gbp_location_name, gbp_oauth_token_ref,
           gbp_auto_reply_min_stars
      FROM arion.site
     WHERE gbp_auto_reply = 1
       AND gbp_connected = 1
       AND gbp_oauth_token_ref IS NOT NULL
       AND gbp_location_name IS NOT NULL`)).recordset;

  summary.sitesConsidered = sites.length;

  for (const site of sites) {
    // Pro+ gate re-checked here so a downgrade silently stops auto-reply.
    if (!meetsMinTier(site.arion_tier, 'pro')) continue;
    summary.sitesEligible++;
    const minStars = site.gbp_auto_reply_min_stars ?? 4;

    let reviewData;
    try {
      reviewData = await fetchReviews(site.gbp_oauth_token_ref, site.gbp_location_name);
    } catch (e) {
      summary.errors.push(`fetchReviews ${site.site_id}: ${e.message}`);
      continue;
    }
    if (reviewData?.error) { summary.errors.push(`fetchReviews ${site.site_id}: ${reviewData.error}`); continue; }

    const candidates = (reviewData.reviews || [])
      .filter(r => !r.replyComment && (r.starRating || 0) >= minStars)
      .slice(0, MAX_REPLIES_PER_SITE_PER_TICK);

    for (const review of candidates) {
      let draft;
      try {
        draft = await draftReviewReply({ pool, tenantId: site.tenant_id, userId: null, review });
      } catch (e) {
        summary.errors.push(`draft ${site.site_id}/${review.reviewId}: ${e.message}`);
        continue;
      }
      if (!draft.ok) {
        if (draft.code === 'insufficient_credits') { summary.skippedInsufficientCredits++; break; } // stop this site — no wallet
        summary.errors.push(`draft ${site.site_id}/${review.reviewId}: ${draft.code}`);
        continue;
      }
      summary.drafted++;
      try {
        const posted = await replyToReview(site.gbp_oauth_token_ref, site.gbp_location_name, review.reviewId, draft.draft);
        if (posted?.error) { summary.errors.push(`reply ${site.site_id}/${review.reviewId}: ${posted.error}`); continue; }
        summary.posted++;
        log(`auto-replied ${site.site_id} review=${review.reviewId} (${review.starRating}★)`);
      } catch (e) {
        summary.errors.push(`reply ${site.site_id}/${review.reviewId}: ${e.message}`);
      }
    }
  }
  return summary;
}
