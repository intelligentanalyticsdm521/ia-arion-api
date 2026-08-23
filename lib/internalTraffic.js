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
    return ip.split(".").every((o) => parseInt(o, 10) <= 255) && parseInt(bits, 10) <= 32;
  }
  if (e.includes(":") && IPV6_RE.test(e)) return true;
  return false;
}

/** Normalize a caller address: strip the IPv4-mapped-IPv6 prefix. */
export function normalizeIp(ip) {
  const e = String(ip || "").trim();
  return e.toLowerCase().startsWith("::ffff:") ? e.slice(7) : e;
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
