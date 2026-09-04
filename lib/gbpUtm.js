/**
 * gbpUtm.js — auto-UTM on the website link we publish to a Google Business
 * Profile.
 * --------------------------------------------------------------------------
 * The convention is LEADGEN_POST_CAPTURE_SCOPE_2026-09-04 §8.3 item 5 (locked
 * as L11): every link WE publish is stamped before it leaves the building, so
 * "this lead came from the Google Business Profile" is a fact instead of a
 * referrer guess — iOS, in-app browsers and most social apps strip referrers.
 *
 *   utm_source=google&utm_medium=gbp&utm_campaign=profile
 *
 * This mirrors `gbpUtms()` / `addUtms()` in
 * LUMEN-API/src/services/attribution/utmBuilder.js. It is a deliberate copy,
 * not a cross-repo import: the two services deploy independently and neither
 * may take a source dependency on the other. Keep the two in step — the
 * medium/source pair is what LUMEN's channel derivation keys on.
 *
 * Rules that make this safe to run over a link a human may have typed:
 *   * a link that already carries `utm_source` is returned EXACTLY as it is —
 *     the client's own tagging always wins, and re-running never double-tags;
 *   * only http/https links are touched;
 *   * unparseable input is returned unchanged;
 *   * pure string transform — no DB, no network, no state.
 */

/** Only http(s) links are ours to tag. */
export function isTaggable(url) {
  const u = String(url == null ? '' : url).trim();
  if (!u) return false;
  if (!/^https?:\/\//i.test(u)) return false;
  if (u.includes('{{') || u.includes('}}')) return false; // unresolved merge tag
  return true;
}

/**
 * Add a UTM set to one URL. Returns the URL unchanged when it already carries
 * a utm_source, when it is not an http(s) link, or when it cannot be parsed.
 *
 * @param {string} url
 * @param {{source?:string, medium?:string, campaign?:string, content?:string, term?:string}} utms
 */
export function addUtms(url, utms = {}) {
  if (!isTaggable(url)) return url;
  const { source, medium, campaign, content, term } = utms;
  if (!source && !medium && !campaign) return url;

  let parsed;
  try {
    parsed = new URL(String(url).trim());
  } catch {
    return url;
  }
  // Idempotent, and the author's own tagging wins.
  if (parsed.searchParams.has('utm_source')) return url;

  const set = (k, v) => {
    if (v == null || v === '') return;
    parsed.searchParams.set(k, String(v));
  };
  set('utm_source', source);
  set('utm_medium', medium);
  set('utm_campaign', campaign);
  set('utm_content', content);
  set('utm_term', term);
  return parsed.toString();
}

/** The UTM set for the website link on a Google Business Profile. */
export function gbpUtms(profileRef) {
  return {
    source: 'google',
    medium: 'gbp',
    campaign: profileRef ? String(profileRef) : 'profile',
  };
}

/**
 * Tag a GBP website link — but only for a tenant that owns SPARK, because
 * SPARK is where the attribution lands. Everything else passes through
 * untouched.
 *
 * @param {string} url
 * @param {object} opts
 * @param {boolean} opts.ownsSpark   the tenant owns SPARK (see tenantOwnsService)
 * @param {string}  [opts.campaign]  defaults to 'profile'
 * @returns {string} the tagged URL, or the input unchanged
 */
export function maybeTagGbpWebsite(url, { ownsSpark, campaign } = {}) {
  if (!ownsSpark) return url;
  return addUtms(url, gbpUtms(campaign));
}
