// middleware/requireArionSubscription.js — the signed-in ARION setup routes
// follow the business's ARION subscription.
//
// Brandon, 11 Oct 2026: "If they don't have the subscription you don't get any
// features."
//
// /onboarding/runner, /onboarding/google-oauth and /onboarding/bing-oauth are
// mounted with requireAuth + tenantResolution only (no requireArionAccess),
// because they run during the post-checkout setup. But every one of them is
// ARION work done for the business's website, much of it paid for by us:
// queuing Hostinger hosting, the AI website builder, SE Ranking keyword and
// competitor seeding, the IA plugin install, an editor user on WordPress, and
// creating Google Analytics, Search Console, Business Profile and Bing
// properties through the IA master accounts. A business whose ARION had ended
// could still start any of them, because its arion.site row is still there.
//
// THE ANSWER: platform-api's payload through the thin client
// (lib/entitlements.js), read with the same productState the website routes
// use (lib/siteCaptureGate.js). Nothing here reads core.tenant_services.
//   ARION decided owned      -> carry on.
//   ARION decided not owned  -> 403, nothing started, the reason in words.
//   undecided                -> a step that STARTS something (any method but
//                               GET/HEAD/OPTIONS) is held: 503, nothing
//                               started, try again (the Portal's runner
//                               retries). A status read carries on and is
//                               logged: never lock a paying business out of
//                               its own progress over our hiccup.
// A buyer who has just checked out is owned: the Stripe webhook switches
// ARION on, and platform-api also counts a live Stripe subscription.
import { entitlementsFor, productState } from '../lib/siteCaptureGate.js';
import { getEntitlements } from '../lib/entitlements.js';

export const ARION_SUBSCRIPTION_WORDS = Object.freeze({
  OFF: "ARION is not in this business's subscription, so this setup step was not started.",
  HELD: "We could not confirm this business's ARION subscription just now, so nothing was started. Try again in a minute.",
});

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function requireArionSubscription(deps = {}) {
  return async function arionSubscriptionGate(req, res, next) {
    const tenantId = req.tenant?.tenantId;
    const payload = await entitlementsFor(tenantId, deps.getEntitlements || getEntitlements);
    const state = productState(payload, 'arion');
    if (state === 'owned') return next();
    if (state === 'not_owned') {
      return res.status(403).json({
        error: { code: 'ARION_NOT_IN_SUBSCRIPTION', message: ARION_SUBSCRIPTION_WORDS.OFF, status: 403 },
      });
    }
    if (READS.has(String(req.method || '').toUpperCase())) {
      console.warn(`[requireArionSubscription] ARION subscription undecided for ${tenantId}; allowing the read ${req.method} ${req.originalUrl || req.url}`);
      return next();
    }
    console.warn(`[requireArionSubscription] ARION subscription undecided for ${tenantId}; held ${req.method} ${req.originalUrl || req.url}, nothing started`);
    return res.status(503).json({
      error: { code: 'SUBSCRIPTION_UNCONFIRMED', message: ARION_SUBSCRIPTION_WORDS.HELD, status: 503 },
    });
  };
}

export default requireArionSubscription;
