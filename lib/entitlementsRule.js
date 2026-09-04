// lib/entitlementsRule.js — SEAM-3-B, and nothing else.
//
//   WHEN WE CANNOT DECIDE WHAT A BUSINESS BOUGHT:
//   ALLOW THE FEATURE. REFUSE THE SPEND.
//
// Both halves. They point in opposite directions, which is exactly why eight
// different files each picked one and the platform ended up answering the same
// question two ways:
//
//   * Refusing the FEATURE on an unknown answer is the 2026-08-17 incident.
//     Production never set OLIVER_API_BASE_URL, LUMEN's tier read returned
//     nothing, and every SPARK Pro/Business route 403'd for every tenant —
//     while the Portal, reading its tier elsewhere, showed the same features
//     unlocked. A customer must never see a locked door because of our outage.
//
//   * Allowing the SPEND on an unknown answer costs real money for a business
//     that may be on the free rung: an LLM judgement, a lead credit, an SMS
//     segment, a bought phone number. services/il/tier.js has failed closed on
//     purpose since it shipped, and it was right to.
//
// THIS FILE IS A DECLARED COPY. The same two functions exist byte-for-byte in
// platform-api lib/entitlements.js, LUMEN src/lib/entitlements.js, arion-api
// lib/entitlements.js and Portal src/lib/entitlements.ts, because there is no
// shared package across an ESM service, a CJS service, a Function App and a
// browser bundle (audit §10 / SEAM-9-A, October work).
//
// They cannot drift: test/fixtures/entitlement-rule-cases.json is BYTE-IDENTICAL
// in every one of those repos, every suite runs every case in it, and each repo
// has a mutation test that inverts one half and proves the suite goes red.

/**
 * May this business USE a feature? An entry we could not decide ALLOWS.
 * @param {object|null} entry   a { active|owned|tier, decided } node
 * @param {string|null} minTier when the entry carries a tier
 */
export function mayUseFeature(entry, minTier = null) {
  if (!entry) return true;
  if (entry.decided === false) return true;
  if (minTier) {
    if (!entry.tier) return true;
    return rankOf(entry.tier) >= rankOf(minTier);
  }
  if (typeof entry.active === "boolean") return entry.active;
  if (typeof entry.owned === "boolean") return entry.owned;
  return true;
}

/**
 * May this business make us SPEND? An entry we could not decide REFUSES.
 * "Spend" is money or a metered unit leaving: an LLM call, a lead credit, an
 * SMS segment, a phone number, a paid enrichment.
 */
export function maySpend(entry, minTier = null) {
  if (!entry) return false;
  if (entry.decided === false) return false;
  if (minTier) return !!entry.tier && rankOf(entry.tier) >= rankOf(minTier);
  if (typeof entry.active === "boolean") return entry.active;
  if (typeof entry.owned === "boolean") return entry.owned;
  return false;
}

/** The one ladder. Delivered in every payload as `rank`; this is the copy used
 *  when there is no payload to read it from. 'active' = paid but the Stripe
 *  product name carried no tier word, treated as Standard so a naming accident
 *  never locks a paying customer out. */
export const RANK = Object.freeze({
  lite: 1, standard: 2, active: 2, pro: 3, business: 4, enterprise: 5,
});

export function rankOf(tier) {
  if (!tier) return 0;
  return RANK[String(tier).toLowerCase()] || 0;
}

export function tierMeets(current, required) {
  return rankOf(current) >= rankOf(required);
}

export default { mayUseFeature, maySpend, RANK, rankOf, tierMeets };
