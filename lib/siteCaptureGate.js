// lib/siteCaptureGate.js — what a website form, booking request or plugin
// event may do, decided by the business's subscription.
//
// Brandon, 11 Oct 2026: "They only get the features for subscriptions they are
// signed up for." / "if they don't have ARION + SPARK we don't do this lead
// form capture unless they have SPARK and they've set their lead forms up for
// capture."
//
// TWO QUESTIONS, ONE ANSWER. Both come from platform-api's entitlement payload
// (lib/entitlements.js, the thin client). Nothing here reads
// core.tenant_services and nothing here decides ownership itself.
//
//   1. Does the business own ARION? The website, its forms and its page views
//      are ARION. Decided "no" -> the site-token routes refuse with 403
//      { error: 'arion_not_enabled' } (middleware/requireSiteArion.js) and the
//      beacon stores nothing. Undecided -> allowed and logged: capture is the
//      business's own data, and a platform-api hiccup must never lose a lead.
//
//   2. May this submission be written into SPARK? Only when SPARK is decided
//      owned AND the form has an active arion.site_form_config row (that row is
//      the "send this form to my SPARK inbox" switch; it does not exist until
//      the business sets the form up, so it starts off). Anything else writes
//      no SPARK row of any kind. Undecided SPARK is HELD: no SPARK row now, the
//      ARION record and the event are still written, and the event processor
//      decides delivery when it can.
import sql from 'mssql';
import { getEntitlements, productOf } from './entitlements.js';

export const CAPTURE_WORDS = Object.freeze({
  ARION_OFF: "ARION is not in this business's subscription, so this website's forms and visits are not being collected.",
  SPARK_OFF: "SPARK is not in this business's subscription, so this submission was kept with the website and not added to SPARK.",
  SPARK_HELD: "We could not confirm this business's SPARK subscription just now, so this submission was kept with the website and not added to SPARK yet.",
  FORM_OFF: "This form is not set up to send to the SPARK inbox, so this submission was kept with the website and not added to SPARK.",
  SPARK_ON: 'Added to SPARK.',
});

/**
 * 'owned' | 'not_owned' | 'undecided' for one product, read from the payload.
 * No payload, an undecided payload or an undecided node is 'undecided'.
 */
export function productState(payload, product) {
  if (!payload) return 'undecided';
  const node = productOf(payload, product);
  if (!node || node.decided === false) return 'undecided';
  if (node.owned === true) return 'owned';
  if (node.owned === false) return 'not_owned';
  return 'undecided';
}

/** The entitlement payload, or null. Never throws. */
export async function entitlementsFor(tenantId, fetcher = getEntitlements) {
  if (!tenantId) return null;
  try {
    return (await fetcher(tenantId)) || null;
  } catch (err) {
    console.warn(`[siteCapture] could not read the subscription for ${tenantId}: ${err?.message}`);
    return null;
  }
}

/**
 * The form's active arion.site_form_config row, or null (none, no form id, or
 * the lookup failed). Never throws: a lookup that breaks must not cost the
 * ARION record of the submission, and "no row" already means "do not send to
 * SPARK", which is the safe direction.
 */
export async function loadFormConfig(pool, { tenantId, siteId, formId }) {
  if (!pool || !tenantId || !siteId || formId === undefined || formId === null || formId === '') return null;
  try {
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('formId', sql.NVarChar(120), String(formId))
      .query(`SELECT TOP 1 form_type, apply_tags, add_to_list_id, marketing_optin
                FROM arion.site_form_config
               WHERE tenant_id=@tenantId AND site_id=@siteId
                 AND form_id=@formId AND is_active=1`);
    return r?.recordset?.[0] || null;
  } catch (err) {
    console.warn('[siteCapture] form config lookup failed:', err?.message);
    return null;
  }
}

/**
 * May this submission write anything into SPARK?
 *
 * @returns {{ write: boolean, capture: 'on'|'spark_not_owned'|'held'|'form_not_set_up', reason: string }}
 */
export function sparkCaptureDecision({ payload, formConfig, tenantId = null, where = 'submission' }) {
  const state = productState(payload, 'spark');
  if (state === 'not_owned') {
    return { write: false, capture: 'spark_not_owned', reason: CAPTURE_WORDS.SPARK_OFF };
  }
  if (state === 'undecided') {
    console.warn(`[siteCapture] ${where} for ${tenantId}: SPARK subscription undecided; no SPARK rows written, the event is still queued`);
    return { write: false, capture: 'held', reason: CAPTURE_WORDS.SPARK_HELD };
  }
  if (!formConfig) {
    return { write: false, capture: 'form_not_set_up', reason: CAPTURE_WORDS.FORM_OFF };
  }
  return { write: true, capture: 'on', reason: CAPTURE_WORDS.SPARK_ON };
}

export default { CAPTURE_WORDS, productState, entitlementsFor, loadFormConfig, sparkCaptureDecision };
