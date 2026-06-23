/**
 * IA-master Bing Webmaster Tools client.
 *
 * Wraps the BING_WMT_API_KEY master key (kebab-case secret name
 * `BING-WMT-API-KEY`, verified present in kv-IADM-prod 2026-06-23) for
 * two onboarding-only operations the existing bingWebmaster.js doesn't
 * cover:
 *
 *   • probeBingFootprint(domain) — list every site the IA master account
 *     can see and report whether the customer's domain is already in
 *     there. Used to answer the "Not sure" case at onboarding time.
 *   • inviteSiteUser(siteUrl, email) — invite the customer (by email) as
 *     a User Manager / Owner on the IA-master-created site so they own
 *     the data going forward. Bing's REST surface is `AddSiteRoles`.
 *
 * Honest reality:
 *   Bing Webmaster Tools' "ownership transfer" is limited — the
 *   AddSiteRoles endpoint adds the customer's Microsoft account as a
 *   Read / ReadWrite / Admin user on the site, but the original IA
 *   master account stays as the verifying owner. That's fine for the
 *   onboarding contract ("they own the data") and matches how the
 *   existing /arion/bing/auto-connect flow is documented (one-click
 *   agency-mode connection). If we ever need to remove the master from
 *   the site post-invite there's a corresponding RemoveSiteRole call.
 */

import { addSite, getSiteEntry, verifyKey } from './bingWebmaster.js';
import { getSecret } from './secrets.js';

const BING_WMT_BASE = 'https://ssl.bing.com/webmaster/api.svc/json';

async function loadMasterKey() {
  // Prefer env var (process.env.BING_WMT_API_KEY) — the existing path in
  // routes/arion.js relies on it — but fall back to Key Vault so we don't
  // need a redeploy if the env var hasn't been wired through App Settings.
  return (
    process.env.BING_WMT_API_KEY
    || (await getSecret('BING_WMT_API_KEY', 'BING-WMT-API-KEY'))
    || null
  );
}

/**
 * Probe the master Bing account for the domain. Returns
 *   {
 *     configured: boolean,           // false when no key in env or KV
 *     found: boolean,                // domain already added to master
 *     entry: { Url, IsVerified, ... } | null,
 *     allSites: number,              // count of sites under master
 *     route: 'byo' | 'ia',
 *   }
 *
 * Brandon design: when the master already has the site (re-onboarding the
 * same domain) we route to 'byo' because the customer is likely the original
 * Bing owner and we don't want to invite them onto a site they already own.
 */
export async function probeBingFootprint(domain) {
  const cleanDomain = String(domain || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();
  if (!cleanDomain) {
    return { configured: true, found: false, entry: null, allSites: 0, route: 'ia' };
  }
  const masterKey = await loadMasterKey();
  if (!masterKey) {
    return { configured: false, error: 'bing_master_not_configured', found: false, entry: null, allSites: 0, route: 'byo' };
  }
  try {
    const candidates = [
      `https://${cleanDomain}/`,
      `http://${cleanDomain}/`,
      `https://www.${cleanDomain}/`,
      `http://www.${cleanDomain}/`,
    ];
    let entry = null;
    for (const cand of candidates) {
      entry = await getSiteEntry(masterKey, cand);
      if (entry) break;
    }
    // Total site count via the verify helper which lists everything.
    const verification = await verifyKey(masterKey, cleanDomain);
    const allSites = Array.isArray(verification?.sites) ? verification.sites.length : 0;
    return {
      configured: true,
      found: !!entry,
      entry,
      allSites,
      route: entry ? 'byo' : 'ia',
    };
  } catch (err) {
    console.warn('[iaMasterBing] probeBingFootprint failed:', err.message);
    return { configured: true, found: false, entry: null, allSites: 0, route: 'ia', error: err.message };
  }
}

/**
 * Invite the customer's Microsoft account email as a User Manager on the
 * IA-master-created Bing Webmaster site. Owner-level invitations require
 * the invitee to have already signed in to Bing Webmaster Tools at least
 * once with the email being invited; we surface that nuance in the result.
 */
export async function inviteBingSiteUser({ siteUrl, email, authCode = null }) {
  const masterKey = await loadMasterKey();
  if (!masterKey) return { ok: false, error: 'bing_master_not_configured' };
  if (!siteUrl || !email) return { ok: false, error: 'site_url_and_email_required' };
  // First make sure the site is on the master account (no-op if already added).
  await addSite(masterKey, siteUrl).catch(() => { /* idempotent */ });

  const url = `${BING_WMT_BASE}/AddSiteRoles?apikey=${encodeURIComponent(masterKey)}`;
  // Bing's documented payload — DelegatedCode is optional but recommended for
  // owner-level invites; we pass it through when the caller has one.
  const body = {
    siteRole: {
      Url: siteUrl,
      Email: email,
      Role: 'OWNER',     // Other valid values: 'READ_ONLY', 'READ_WRITE'
      ...(authCode ? { DelegatedCode: authCode } : {}),
    },
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      // Common case: the invitee email has never signed into Bing Webmaster
      // before. We treat this as a pending state — the founder dashboard
      // surfaces it as "waiting for client first-login".
      if (/UserNotFound|UnknownUser|NotRegistered/i.test(text)) {
        return { ok: false, pending: true, error: 'invitee_not_yet_signed_into_bing' };
      }
      return { ok: false, error: text.slice(0, 300) || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function isBingMasterConfigured() {
  const key = await loadMasterKey();
  return !!key;
}
