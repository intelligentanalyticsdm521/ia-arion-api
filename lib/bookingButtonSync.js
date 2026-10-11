// lib/bookingButtonSync.js — keep every website's "Book now" button in step
// with the business's OLIVER subscription, without anybody opening an editor.
//
// FEATURES row 17 (audit 2026-10-11): the plugin stores the booking address
// ARION last pushed (/booking-config) and renders [ia_book_now] and the header
// menu item from it. ARION pushed only at provisioning and when the website
// editor was opened, so when OLIVER ended the button stayed on the site,
// pointing at a booking page the business no longer pays for.
//
// This tick, rung daily by the arion-func timer through
// POST /internal/booking-button-sync-tick, asks the ONE answer
// (brandContext.resolveBookingTarget, which reads the platform-api payload)
// for each connected site and pushes it:
//   OLIVER decided not owned, or no active booking page -> push '' (button off)
//   OLIVER owned with an active booking page             -> push the address
//   undecided                                            -> push NOTHING; the
//     site keeps what it had and the next tick asks again.
import { resolveBookingTarget } from './websiteBuilder/brandContext.js';
import { pushBookingConfig } from './websiteBuilder/pageClient.js';

export const BOOKING_SYNC_SITES_SQL = `
  SELECT *
    FROM arion.site
   WHERE (status IS NULL OR status <> 'suspended')
     AND (site_token_raw IS NOT NULL OR wp_app_password_ref IS NOT NULL)`;

/**
 * One tick. Never throws for one site; a failed site is counted and logged.
 *
 * @param {object} pool  the services pool
 * @param {Function} log
 * @param {object} [deps] { resolve, push } test seams
 */
export async function runBookingButtonSyncTick(pool, log = () => {}, deps = {}) {
  const resolve = deps.resolve || resolveBookingTarget;
  const push = deps.push || pushBookingConfig;
  const summary = { sites: 0, pointed: 0, cleared: 0, held: 0, old_plugin: 0, failed: 0, held_reasons: [] };

  const sites = (await pool.request().query(BOOKING_SYNC_SITES_SQL)).recordset || [];
  summary.sites = sites.length;
  const perBusiness = new Map(); // one answer per business per tick

  for (const site of sites) {
    const key = String(site.tenant_id || '').toUpperCase();
    try {
      if (!perBusiness.has(key)) perBusiness.set(key, await resolve(pool, site.tenant_id));
      const target = perBusiness.get(key);
      if (!target || target.decided !== true) {
        summary.held++;
        summary.held_reasons.push({ site_id: site.site_id, reason: target?.reason || 'undecided' });
        log(`${site.domain || site.site_id}: left as it is — ${target?.reason || 'undecided'}`);
        continue;
      }
      const r = await push(site, { bookingUrl: target.href });
      if (r?.ok) {
        if (target.href) summary.pointed++;
        else summary.cleared++;
        log(`${site.domain || site.site_id}: ${target.href ? `book-now points at ${target.href}` : `book-now taken off (${target.reason})`}`);
      } else if (r?.error === 'not_found') {
        // Older plugin builds have no /booking-config. Not a fault.
        summary.old_plugin++;
      } else {
        summary.failed++;
        log(`${site.domain || site.site_id}: push failed (${r?.error || r?.status || 'no answer'})`);
      }
    } catch (err) {
      summary.failed++;
      log(`${site.domain || site.site_id}: ${err?.message}`);
    }
  }
  return summary;
}

export default { runBookingButtonSyncTick, BOOKING_SYNC_SITES_SQL };
