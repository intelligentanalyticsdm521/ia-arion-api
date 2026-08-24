// lib/internalTraffic.js — Sept 2026 Release A (F4).
//
// The internal-traffic exclusion model, in one place:
//   effective list for a site = IA platform entries (env IA_INTERNAL_IPS,
//   comma-separated IPs/CIDRs — updatable as an App Service setting, no
//   deploy) + the tenant's own entries (arion.site.internal_ip_json,
//   managed from the Portal's "Exclude internal traffic" card).
//
// The list only ever reaches the browser as a per-visitor BOOLEAN — the
// plugin's /visitor-flags endpoint checks REMOTE_ADDR against it server-side.

const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
const IPV6_RE = /^[0-9a-f:]+$/i;

export function isValidIpOrCidr(entry) {
  const e = String(entry || "").trim();
  if (!e) return false;
  if (IP_RE.test(e)) return e.split(".").every((o) => parseInt(o, 10) <= 255);
  if (CIDR_RE.test(e)) {
    const [ip, bits] = e.split("/");
    // /0 rejected on BOTH sides (JS here, PHP ia_valid_ip_or_cidr): the PHP
    // matcher short-circuits bits<=0, so a stored /0 would show as active in
    // the card while excluding nobody.
    const b = parseInt(bits, 10);
    return ip.split(".").every((o) => parseInt(o, 10) <= 255) && b >= 1 && b <= 32;
  }
  if (e.includes(":") && IPV6_RE.test(e)) return true;
  return false;
}

/**
 * Normalize a caller address: strip the IPv4-mapped-IPv6 prefix and any
 * trailing :port. Azure App Service's front end appends the client PORT to
 * X-Forwarded-For ("203.0.113.5:49123"), so without the strip the one-click
 * "Exclude my current network" 400s in prod while testing green on localhost
 * (adversarial-review finding).
 */
export function normalizeIp(ip) {
  let e = String(ip || "").trim();
  if (e.toLowerCase().startsWith("::ffff:")) e = e.slice(7);
  // Bracketed IPv6 with port: [2001:db8::1]:443
  const br = /^\[([0-9a-f:]+)\](?::\d+)?$/i.exec(e);
  if (br) return br[1];
  // IPv4 with port: exactly one colon, dotted-quad before it.
  const v4p = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/.exec(e);
  if (v4p) return v4p[1];
  return e;
}

/** The caller's real address: first X-Forwarded-For hop, else socket. */
export function callerIp(req) {
  const xff = String(req.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  return normalizeIp(xff || req.ip || req.connection?.remoteAddress || "");
}

/** IA's platform-wide entries (office/home/static egress — Brandon-owned). */
export function platformInternalIps() {
  return String(process.env.IA_INTERNAL_IPS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(isValidIpOrCidr);
}

/** The tenant's own entries off the arion.site row. */
export function siteInternalIps(site) {
  try {
    const list = JSON.parse(site?.internal_ip_json || "[]");
    return Array.isArray(list) ? list.filter(isValidIpOrCidr) : [];
  } catch {
    return [];
  }
}

/** Labeled union for the Portal card (platform entries are not removable). */
export function effectiveInternalIps(site) {
  const platform = platformInternalIps().map((ip) => ({ ip, source: "platform" }));
  const own = siteInternalIps(site).map((ip) => ({ ip, source: "site" }));
  const seen = new Set(platform.map((x) => x.ip));
  return [...platform, ...own.filter((x) => !seen.has(x.ip))];
}

/** The flat merged list the plugin stores in ia_internal_ip_list. */
export function mergedInternalIps(site) {
  return effectiveInternalIps(site).map((x) => x.ip);
}
