// middleware/requireSiteArion.js — the website routes stop when ARION ends.
//
// The site-token routes (/forms/submit, /bookings/submit, /webhooks/site-event)
// are mounted without requireArionAccess on purpose: the caller is a WordPress
// site holding a site token, not a signed-in person. They still act for the
// site's business, so they follow that business's subscription: when ARION is
// DECIDED not owned, nothing is collected and the site is told why.
//
// Undecided (platform-api unreachable or not configured) lets the request
// through and logs it. A form submission is the business's own data, and
// losing a customer's inquiry over our outage is worse than collecting it.
//
// Runs AFTER requireSiteToken (it needs req.tenant). The payload it read is
// left on req.entitlements so the route does not ask twice.
import { CAPTURE_WORDS, entitlementsFor, productState } from '../lib/siteCaptureGate.js';
import { getEntitlements } from '../lib/entitlements.js';

export function requireSiteArion(deps = {}) {
  return async function siteArionGate(req, res, next) {
    const tenantId = req.tenant?.tenantId;
    const fetcher = deps.getEntitlements || getEntitlements;
    const payload = await entitlementsFor(tenantId, fetcher);
    req.entitlements = payload;
    const state = productState(payload, 'arion');
    if (state === 'not_owned') {
      return res.status(403).json({ error: 'arion_not_enabled', message: CAPTURE_WORDS.ARION_OFF });
    }
    if (state === 'undecided') {
      console.warn(`[requireSiteArion] ARION subscription undecided for ${tenantId}; collecting as before`);
    }
    return next();
  };
}

export default requireSiteArion;
