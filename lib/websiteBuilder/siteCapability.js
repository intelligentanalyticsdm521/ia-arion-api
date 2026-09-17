/**
 * What the WEBSITE can actually do — asked, not assumed (D-ARION-E).
 * ---------------------------------------------------------------------------
 * Before this, ARION decided whether a site had Elementor Pro by reading
 * `arion.site.arion_tier`:
 *
 *     const tier = String(site?.arion_tier || '').toLowerCase();
 *     return tier !== 'lite';          // routes/arion/pages.js, Phase 1A
 *
 * Two things were wrong with that. Elementor PRO is installed by the golden
 * master on every tier (lib/pluginStack.js, allTiers:true), so a Lite site
 * usually does have it — and any client can deactivate either plugin from
 * wp-admin in two clicks, at which point the plan says one thing and the site
 * says another. Nothing anywhere asked the site.
 *
 * The cost of the assumption was a blank page: `ia_write_elementor_data` wrote
 * `_elementor_data`, flipped `_elementor_edit_mode` to 'builder' and answered
 * 200 on a site with no Elementor to render any of it. Green toast, empty page
 * — the absence-based guard failing open that
 * `reference_absence_based_guards_fail_open` and
 * `reference_catch_swallow_report_success` both warn about.
 *
 * SO: the plugin's `/status` now reports the Elementor and Elementor Pro
 * versions (IA plugin >= 1.7.3) and this module reads them.
 *
 * THREE ANSWERS, NOT TWO. `known` matters as much as `elementorActive`:
 *
 *   known:true,  elementorActive:false  -> the site TOLD us. Refuse the editor
 *                                          with a sentence.
 *   known:true,  elementorActive:true   -> carry on.
 *   known:false                          -> we could not ask (site unreachable,
 *                                          or a plugin older than 1.7.3 that
 *                                          has no elementor block). Do NOT
 *                                          refuse on this: an unreachable site
 *                                          fails on its own write with a real
 *                                          error, and inventing a refusal for
 *                                          an old plugin would lock a working
 *                                          client out of their own editor. The
 *                                          plugin's own writer is the guard
 *                                          that cannot be bypassed.
 *
 * CACHE: 5 minutes per site, in process. A client who deactivates Elementor and
 * comes straight back to the Portal can be up to five minutes stale — and the
 * plugin refuses the write regardless, so the worst case is a form that accepts
 * typing and then says no, never a blank page.
 */

import { fetchStatus } from './pageClient.js';

/** The plugin build whose /status carries the elementor block. */
export const MIN_CAPABILITY_PLUGIN_VERSION = '1.7.3';

export const CAPABILITY_TTL_MS = 5 * 60 * 1000;

/**
 * The one sentence the client reads. Same words the plugin uses — word for
 * word, so a client who meets the early refusal here and the writer's refusal
 * inside the plugin is told the same thing twice, not two different things.
 *
 * NO VENDOR NAME (rows A2-52/A2-54, `feedback_no_third_party_product_surface`).
 * The page engine is ours to run and the client never chose it, so naming it
 * tells them nothing they can act on and invites them to go and fix somebody
 * else's plugin. The names stay on the wire — `capability.elementorVersion`,
 * `capability.proVersion` — for our own diagnostics.
 */
export const NO_ELEMENTOR_MESSAGE =
  'Your website cannot show pages built here right now, so saving would leave the page blank '
  + 'and nothing was changed. Tell us and we will switch it back on — the editor works again '
  + 'as soon as we have.';

export const NO_ELEMENTOR_PRO_MESSAGE =
  'This section includes a form, and your website cannot show forms built here right now. '
  + 'Everything else in the editor works without it.';

/** siteId -> { at, value } */
const _cache = new Map();
const CACHE_MAX = 500;

function unknown(reason) {
  return {
    known: false,
    reason,
    elementorActive: null,
    elementorVersion: null,
    proActive: null,
    proVersion: null,
    pluginVersion: null,
    seoPlugin: null,
    iaWidgets: null,
    iaShortcodes: null,
  };
}

/**
 * Ask the site what it has. Never throws.
 *
 * @param {object} site an arion.site row
 * @param {{ force?: boolean, fetchImpl?: Function }} [opts]
 */
export async function getSiteCapability(site, opts = {}) {
  const siteId = String(site?.site_id || '');
  if (!siteId) return unknown('no_site');

  if (!opts.force) {
    const hit = _cache.get(siteId);
    if (hit && Date.now() - hit.at < CAPABILITY_TTL_MS) return hit.value;
  }

  let res;
  try {
    res = await fetchStatus(site, { fetchImpl: opts.fetchImpl });
  } catch (err) {
    // fetchStatus never throws; this is belt and braces so a capability probe
    // can never be the reason an editor page fails to open.
    return unknown(`status_threw:${err?.message || 'unknown'}`);
  }

  const data = res?.data || null;
  if (!res?.ok || !data) return unknown('status_unavailable');

  const el = data.elementor;
  // PRESENCE of the block, not absence of an error: a plugin below 1.7.3
  // answers /status happily and simply does not mention Elementor, and reading
  // `!!undefined` there would tell us "no Elementor" about a site that has it.
  if (!el || typeof el !== 'object' || typeof el.active !== 'boolean') {
    return unknown('plugin_too_old');
  }

  const value = {
    known: true,
    reason: null,
    elementorActive: !!el.active,
    elementorVersion: el.version ? String(el.version) : null,
    proActive: !!el.pro_active,
    proVersion: el.pro_version ? String(el.pro_version) : null,
    pluginVersion: data.plugin_version ? String(data.plugin_version) : null,
    seoPlugin: data.seo_plugin && data.seo_plugin.plugin ? String(data.seo_plugin.plugin) : null,
    /**
     * WHAT OF OURS THIS SITE CAN ACTUALLY DRAW.
     *
     * The PRESENCE of the list, never the absence of it: a plugin that does
     * not report these answers `null`, which means "we were not told" and
     * locks nothing — and the day the plugin release reports them (D-159,
     * spec in D156_CONFORMANCE_HANDOFF_2026-09-17.md) every site starts
     * getting the right answer with no change here. An EMPTY array is a real
     * answer and means "none", which is what makes the Lite form's fallback
     * gate honest (`reference_absence_based_guards_fail_open`).
     */
    iaWidgets: Array.isArray(data.ia_widgets) ? data.ia_widgets.map(String) : null,
    iaShortcodes: Array.isArray(data.ia_shortcodes) ? data.ia_shortcodes.map(String) : null,
  };

  if (_cache.size >= CACHE_MAX) _cache.clear();
  _cache.set(siteId, { at: Date.now(), value });
  return value;
}

/**
 * The editor's own gate. Returns null to carry on, or the refusal to send.
 *
 * Only a site that SAID it has no Elementor is refused (see the three answers
 * above), and the refusal is a sentence with a 409, never a 200.
 */
export function elementorRefusal(capability) {
  if (!capability || !capability.known) return null;
  if (capability.elementorActive) return null;
  return {
    status: 409,
    code: 'ELEMENTOR_NOT_ACTIVE',
    message: NO_ELEMENTOR_MESSAGE,
  };
}

/**
 * May this site have the Pro-only section archetypes?
 *
 * Detected when the site answered; otherwise the old tier inference, which is
 * all we had before and is still better than nothing for a plugin below 1.7.3.
 * The tier fallback is `!== 'lite'` exactly as it was, so an un-upgraded site
 * behaves as it did today.
 */
export function allowProFor(site, capability) {
  if (capability && capability.known) {
    return { allowPro: !!capability.proActive, source: 'detected' };
  }
  const tier = String(site?.arion_tier || '').trim().toLowerCase();
  return { allowPro: tier !== 'lite', source: 'tier' };
}

/** TEST/DEV seam. */
export function __resetCapabilityCache() { _cache.clear(); }

export const __test__ = { _cache, unknown };
