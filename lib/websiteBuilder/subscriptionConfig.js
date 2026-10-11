// lib/websiteBuilder/subscriptionConfig.js — tell each website what the
// business's subscription lets it do on its own pages.
//
// Brandon, 11 Oct 2026: "this should just be a top level permissions setting.
// If you don't have the subscription you don't get any features." / "it's by
// their subscription. ARION pro has different features than ARION lite."
//
// TWO OPTIONS THE IA PLUGIN STORES (pushed by pageClient.pushSubscriptionConfig
// to POST /subscription-config):
//
//   ia_spark_capture  true ONLY when SPARK is decided owned AND the site has at
//                     least one active arion.site_form_config row (the "Send
//                     this form to my SPARK inbox" switch). Anything else is
//                     false: SPARK not owned, SPARK undecided, no form switched
//                     on, ARION decided not owned, or the form lookup failed.
//                     The plugin uses it to decide, on the site, whether to
//                     send the SPARK identify/visitor call and load the chat
//                     tag (features audit rows 1 and 14). Undecided never lets
//                     a SEND or a cross-product WRITE through, so undecided is
//                     false, never true.
//
//   ia_tier           the ARION tier the business pays for, read from the
//                     platform-api payload (lib/entitlements.js productOf).
//                     The plugin's ia_tier was written only at provisioning
//                     and never lowered, so a business that moved from Pro to
//                     Lite kept Pro features on its own site. Pushed only when
//                     ARION is decided owned with a real tier word; a null tier
//                     on an owned ARION, an undecided ARION or ARION not owned
//                     pushes NOTHING for the tier (the key is absent, so the
//                     plugin keeps what it has) and is logged.
//
// WHERE IT IS PUSHED
//   - routes/arion/forms.js POST /config: every switch flip or outcome save.
//   - routes/arion/website.js /site/options: the website settings screen
//     (opened or saved), at most once per ten minutes per site.
//   - runSubscriptionConfigTick below: every connected site, for the daily
//     timer, so a downgrade or a cancelled SPARK reaches the site the same day.
//
// Nothing here reads core.tenant_services and nothing here decides ownership.
import sql from 'mssql';
import { getEntitlements, productOf } from '../entitlements.js';
import { productState } from '../siteCaptureGate.js';
import { pushSubscriptionConfig } from './pageClient.js';
import { BOOKING_SYNC_SITES_SQL } from '../bookingButtonSync.js';

/** The tier words the plugin's IA_Tier_Gate knows, lowest first. */
export const PLUGIN_TIER_WORDS = Object.freeze(['lite', 'standard', 'pro', 'business']);

/**
 * ARION tier words the subscription can carry that the plugin has no rung for,
 * mapped onto the rung the plugin gives them anyway (its own get_tier() treats
 * an unknown word as 'business', its top rung).
 */
const ABOVE_PLUGIN_TIERS = Object.freeze({ enterprise: 'business' });

/**
 * What the subscription says the plugin's ia_tier should be.
 * @returns {{ tier: string|null, reason: string }}
 */
export function pluginTierFrom(payload) {
  const state = productState(payload, 'arion');
  if (state === 'undecided') return { tier: null, reason: 'arion_undecided' };
  if (state === 'not_owned') return { tier: null, reason: 'arion_not_owned' };
  const word = String(productOf(payload, 'arion')?.tier ?? '').trim().toLowerCase();
  if (PLUGIN_TIER_WORDS.includes(word)) return { tier: word, reason: 'arion_tier' };
  if (ABOVE_PLUGIN_TIERS[word]) return { tier: ABOVE_PLUGIN_TIERS[word], reason: 'arion_tier' };
  return { tier: null, reason: 'arion_tier_missing' };
}

/**
 * What the subscription and the form switches say ia_spark_capture should be.
 * @returns {{ capture: boolean, reason: string }}
 */
export function sparkCaptureFrom(payload, activeForms) {
  if (productState(payload, 'arion') === 'not_owned') return { capture: false, reason: 'arion_not_owned' };
  const spark = productState(payload, 'spark');
  if (spark === 'not_owned') return { capture: false, reason: 'spark_not_owned' };
  if (spark !== 'owned') return { capture: false, reason: 'spark_undecided' };
  if (!(Number(activeForms) > 0)) return { capture: false, reason: 'no_form_switched_on' };
  return { capture: true, reason: 'on' };
}

/**
 * The body for POST /subscription-config, and why each value is what it is.
 * Pure: the whole decision, testable without a database or a website.
 */
export function subscriptionConfigBody({ payload, activeForms }) {
  const tier = pluginTierFrom(payload);
  const capture = sparkCaptureFrom(payload, activeForms);
  const body = { ia_spark_capture: capture.capture };
  if (tier.tier) body.ia_tier = tier.tier;
  return { body, tierReason: tier.reason, captureReason: capture.reason };
}

/**
 * How many forms on this site are switched on to send to SPARK. A failed
 * lookup counts as 0: "no form switched on" is the safe direction for a send.
 */
export async function countActiveForms(pool, { tenantId, siteId }) {
  if (!pool || !tenantId || !siteId) return 0;
  try {
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .query(`SELECT COUNT(*) AS active
                FROM arion.site_form_config
               WHERE tenant_id = @tenantId AND site_id = @siteId AND is_active = 1`);
    return Number(r?.recordset?.[0]?.active) || 0;
  } catch (err) {
    console.warn(`[subscriptionConfig] active form lookup failed for site ${siteId}: ${err?.message}`);
    return 0;
  }
}

/** A plugin answer -> one word for logs and for the Portal. */
function outcomeOf(r, body) {
  if (r?.ok) {
    // The plugin reads the options back before it answers. If it says it holds
    // something else, the push did not take.
    const held = r.data && typeof r.data === 'object' ? r.data : {};
    if (Object.prototype.hasOwnProperty.call(held, 'ia_spark_capture')
        && Boolean(held.ia_spark_capture) !== body.ia_spark_capture) return 'not_held';
    if (body.ia_tier && held.ia_tier && String(held.ia_tier).toLowerCase() !== body.ia_tier) return 'not_held';
    return 'ok';
  }
  if (r?.error === 'not_found') return 'plugin_too_old';
  if (r?.error === 'site_not_connected' || r?.error === 'no_domain_for_site') return 'site_not_connected';
  return 'failed';
}

/**
 * Work out and push one site's two options. Never throws.
 *
 * @param {object} pool  the services pool
 * @param {object} site  the full arion.site row (the token lives on it)
 * @param {object} [deps] { getEntitlements, push, payload, log } test seams;
 *                        `payload` reuses an answer already fetched this tick.
 * @returns {Promise<{ pushed: boolean, outcome: string, body: object,
 *                     tier_reason: string, capture_reason: string, error?: string }>}
 */
export async function pushSiteSubscriptionConfig(pool, site, deps = {}) {
  const log = deps.log || ((m) => console.log(m));
  const push = deps.push || pushSubscriptionConfig;
  const tenantId = site?.tenant_id;
  const siteId = site?.site_id;
  let payload = deps.payload;
  if (payload === undefined) {
    try {
      payload = (await (deps.getEntitlements || getEntitlements)(tenantId)) || null;
    } catch (err) {
      console.warn(`[subscriptionConfig] could not read the subscription for ${tenantId}: ${err?.message}`);
      payload = null;
    }
  }
  const activeForms = await countActiveForms(pool, { tenantId, siteId });
  const { body, tierReason, captureReason } = subscriptionConfigBody({ payload, activeForms });
  const label = site?.domain || siteId || 'site';
  if (!body.ia_tier) log(`[subscriptionConfig] ${label}: ia_tier not pushed (${tierReason}); the site keeps the tier it has`);

  let r;
  try {
    r = await push(site, body, { timeoutMs: deps.timeoutMs });
  } catch (err) {
    r = { ok: false, error: err?.message || 'push_threw' };
  }
  const outcome = outcomeOf(r, body);
  if (outcome !== 'ok' && outcome !== 'plugin_too_old') {
    log(`[subscriptionConfig] ${label}: push ${outcome} (${r?.error || r?.status || 'no answer'})`);
  }
  return {
    pushed: outcome === 'ok',
    outcome,
    via: r?.via || null,
    body,
    tier_reason: tierReason,
    capture_reason: captureReason,
    ...(outcome === 'ok' ? {} : { error: String(r?.error || r?.status || outcome) }),
  };
}

/* ── the settings screen: at most once per ten minutes per site ─────────── */

export const SUBSCRIPTION_PUSH_TTL_MS = 10 * 60 * 1000;
export const subscriptionPushed = new Map(); // siteId -> at

/**
 * Fire-and-forget push for a screen the business opened. Never throws, never
 * delays the screen, and does not push the same site twice in ten minutes.
 */
export function syncSubscriptionConfigSoon(pool, site, deps = {}) {
  const siteId = String(site?.site_id || '');
  if (!siteId) return false;
  const now = Date.now();
  const last = subscriptionPushed.get(siteId);
  if (last && (now - last) < SUBSCRIPTION_PUSH_TTL_MS) return false;
  subscriptionPushed.set(siteId, now);
  Promise.resolve()
    .then(() => pushSiteSubscriptionConfig(pool, site, deps))
    .then((r) => { if (!r.pushed && r.outcome !== 'plugin_too_old') subscriptionPushed.delete(siteId); })
    .catch(() => subscriptionPushed.delete(siteId));
  return true;
}

/* ── the daily tick: every connected site ───────────────────────────────── */

/**
 * One pass over every connected site. One subscription answer per business
 * per tick. Never throws for one site; a failed site is counted and logged.
 */
export async function runSubscriptionConfigTick(pool, log = () => {}, deps = {}) {
  const fetchPayload = deps.getEntitlements || getEntitlements;
  const summary = { sites: 0, pushed: 0, capture_on: 0, tier_pushed: 0, tier_held: 0, old_plugin: 0, failed: 0 };
  const sites = (await pool.request().query(BOOKING_SYNC_SITES_SQL)).recordset || [];
  summary.sites = sites.length;
  const perBusiness = new Map();

  for (const site of sites) {
    const key = String(site.tenant_id || '').toUpperCase();
    try {
      if (!perBusiness.has(key)) {
        let payload = null;
        try { payload = (await fetchPayload(site.tenant_id)) || null; } catch { payload = null; }
        perBusiness.set(key, payload);
      }
      const r = await pushSiteSubscriptionConfig(pool, site, { ...deps, payload: perBusiness.get(key), log });
      if (r.body.ia_tier) summary.tier_pushed++;
      else summary.tier_held++;
      if (r.outcome === 'ok') {
        summary.pushed++;
        if (r.body.ia_spark_capture) summary.capture_on++;
      } else if (r.outcome === 'plugin_too_old') {
        summary.old_plugin++;
      } else {
        summary.failed++;
      }
    } catch (err) {
      summary.failed++;
      log(`[subscriptionConfig] ${site.domain || site.site_id}: ${err?.message}`);
    }
  }
  return summary;
}

export default {
  PLUGIN_TIER_WORDS, pluginTierFrom, sparkCaptureFrom, subscriptionConfigBody,
  countActiveForms, pushSiteSubscriptionConfig, syncSubscriptionConfigSoon,
  runSubscriptionConfigTick, SUBSCRIPTION_PUSH_TTL_MS, subscriptionPushed,
};
