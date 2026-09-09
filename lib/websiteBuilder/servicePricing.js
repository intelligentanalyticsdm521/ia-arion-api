/**
 * THE ONE PRICE SOURCE for anything the website says a job costs.
 * ---------------------------------------------------------------------------
 * A price that is typed into a web page is a price that goes stale, and a
 * business that has to remember to change it in two places will change it in
 * one. So the pricing section is BUILT from the business's own services and
 * prices - `oliver.service_offering` joined to `oliver.service_offering_price`,
 * which is the same catalogue the booking page, quotes and invoices read - and
 * "Use my current prices" refills it from here.
 *
 * `unit_amount` is DOLLARS, not cents (memory:
 * reference_oliver_quotes_proposals_rebuild). Reading it as cents is how a $45
 * lawn cut becomes 45 cents on a published page, so the one conversion lives
 * here and nowhere else.
 *
 * FAILS CLOSED, exactly like `resolveBookingHref` next door in brandContext:
 * a business that does not own OLIVER, or whose catalogue cannot be read,
 * gets an EMPTY list and the pricing section starts with blank prompts. It
 * never gets an invented price. `no_fabricated_catalog` is the rule this file
 * exists to keep.
 */

import sql from 'mssql';
import { tenantOwnsService } from '../coreTenants.js';

/** How many rows a pricing section could ever show. Six cards is the max. */
const MAX_OFFERINGS = 24;

/** Dollars -> what a person reads. No currency invention: the row says which. */
export function formatPrice(unitAmount, currency = 'USD') {
  // Number(null) is 0, so an offering with NO default price would have read
  // $0 - a free lawn cut on a published page. No price is no price.
  if (unitAmount === null || unitAmount === undefined || unitAmount === '') return '';
  const n = Number(unitAmount);
  if (!Number.isFinite(n) || n < 0) return '';
  const code = String(currency || 'USD').toUpperCase();
  const symbol = code === 'USD' ? '$' : code === 'GBP' ? '£' : code === 'EUR' ? '€' : '';
  const body = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return symbol ? `${symbol}${body}` : `${body} ${code}`;
}

/** A recurring interval -> the words under the price. '' for a one-off. */
export function formatPeriod(pricingModel, interval, count = 1) {
  const model = String(pricingModel || '').toLowerCase();
  const every = String(interval || '').toLowerCase();
  if (!every || model === 'one_time' || model === 'one_off') return '';
  const n = Number(count) || 1;
  const unit = every.endsWith('s') ? every.slice(0, -1) : every;
  return n > 1 ? `every ${n} ${unit}s` : `per ${unit}`;
}

function parseFeatures(raw) {
  if (!raw) return [];
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((f) => (typeof f === 'string' ? f : f?.text || f?.label || f?.name))
    .map((f) => String(f == null ? '' : f).trim())
    .filter(Boolean)
    .slice(0, 8);
}

/**
 * The business's own services and prices, ready to put on a page.
 *
 * @param {import('mssql').ConnectionPool} pool  the services pool
 * @param {string} tenantId
 * @returns {Promise<{ ok: boolean, reason: string|null, services: object[] }>}
 */
export async function loadServicePrices(pool, tenantId) {
  if (!pool || !tenantId) return { ok: false, reason: 'no_tenant', services: [] };

  let owns = false;
  try {
    owns = await tenantOwnsService(tenantId, 'oliver');
  } catch (err) {
    console.warn(`[servicePricing] ownership check failed for ${tenantId}:`, err?.message);
    return { ok: false, reason: 'ownership_unknown', services: [] };
  }
  if (!owns) return { ok: false, reason: 'no_service_catalogue', services: [] };

  try {
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`
        SELECT TOP (${MAX_OFFERINGS})
               o.offering_id, o.name, o.description, o.default_duration_minutes,
               o.features_json, o.sort_order,
               p.unit_amount, p.currency, p.pricing_model,
               p.recurring_interval, p.recurring_interval_count
          FROM oliver.service_offering o
          LEFT JOIN oliver.service_offering_price p
            ON p.offering_id = o.offering_id
           AND p.tenant_id   = o.tenant_id
           AND p.is_active   = 1
           AND p.is_default  = 1
         WHERE o.tenant_id = @tenantId
           AND o.is_active = 1
         ORDER BY o.sort_order, o.name
      `);

    const services = r.recordset.map((row) => ({
      offering_id: String(row.offering_id),
      name: String(row.name || '').trim(),
      description: String(row.description || '').trim(),
      duration_minutes: row.default_duration_minutes == null ? null : Number(row.default_duration_minutes),
      // '' when the offering has no default active price - a service that is
      // quoted rather than priced. The card then shows no price rather than a
      // made-up one.
      price: row.unit_amount == null ? '' : formatPrice(row.unit_amount, row.currency),
      period: row.unit_amount == null
        ? ''
        : formatPeriod(row.pricing_model, row.recurring_interval, row.recurring_interval_count),
      features: parseFeatures(row.features_json),
    }));

    return { ok: true, reason: null, services };
  } catch (err) {
    console.warn(`[servicePricing] catalogue unreadable for ${tenantId}:`, err?.message);
    return { ok: false, reason: 'catalogue_unreadable', services: [] };
  }
}

/**
 * Those services as the pricing section's `plans`.
 *
 * `offering_id` rides along on every card so a later "Use my current prices"
 * knows which row in the price list each card came from, and so nothing has to
 * match on the NAME - which a client is free to change on the page.
 */
export function plansFromServices(services, { ctaText = 'Get in touch', ctaHref = '#contact', max = 6 } = {}) {
  return (Array.isArray(services) ? services : []).slice(0, max).map((s) => ({
    name: s.name || 'Package',
    price: s.price || '',
    period: s.period || '',
    summary: s.description || '',
    features: Array.isArray(s.features) ? s.features : [],
    cta_text: ctaText,
    cta_href: ctaHref,
    offering_id: s.offering_id || '',
  }));
}

export const __test__ = { parseFeatures, MAX_OFFERINGS };
