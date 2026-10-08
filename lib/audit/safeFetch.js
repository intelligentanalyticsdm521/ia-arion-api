// lib/audit/safeFetch.js
//
// Every outbound request the audit tool makes goes through here: the pages of
// the website being checked, robots.txt, the link checks, the agency's logo and
// the callback to the caller. All of those addresses come from outside, so this
// is the SSRF guard (contract §E.1, the same rules as the calling side §C.9).
//
//   - http: or https: only (https: only when the caller asks — the callback);
//     no user:password@ in the address; default ports only.
//   - The host is resolved ONCE with dns.lookup(all:true) and refused when ANY
//     address is loopback, private (10/8, 172.16/12, 192.168/16), link-local
//     (169.254/16 — which is where cloud metadata lives — fe80::/10), CGNAT
//     (100.64/10), 0/8, ULA (fc00::/7), ::1, multicast or reserved. IPv6 is read
//     as bytes: an IPv4 address written inside IPv6 (::ffff:7f00:1, ::7f00:1)
//     is checked as IPv4, and only global unicast 2000::/3 outside 6to4,
//     Teredo, NAT64 and documentation ranges passes.
//   - The connection is PINNED to the address that was checked (the `lookup`
//     option), so a second DNS answer cannot swap in an internal address.
//   - Redirects are followed by hand, at most 3, and EVERY hop is checked again.
//   - 8 s per request, 2 MB body cap, and pages must be text/html.
//
// DEV EXCEPTION: loopback (localhost, 127.0.0.1, ::1 — never the private
// ranges) on any port is allowed only when AUDIT_ALLOW_LOCAL === 'true' AND
// WEBSITE_SITE_NAME is absent. WEBSITE_SITE_NAME is set by App Service and a
// laptop never has it, so the exception cannot switch on in production even if
// someone copies the dev setting there (presence-based, not NODE_ENV).

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

export const USER_AGENT = 'ARGUS-Audit/1 (website check)';
export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 3;

/** Plain sentences — these reach the agency's owner and, through them, the visitor. */
export const REFUSAL_WORDS = {
  bad_url: "That address isn't a public website.",
  not_public: "That address isn't a public website.",
  not_https: "That address isn't a public website.",
  unreachable: "We couldn't reach that website.",
  timeout: 'The website took too long to answer.',
  not_html: "That address isn't a web page we can read.",
  too_big: 'That page is too big for us to check.',
  too_many_redirects: 'That website sends visitors round in circles, so we could not check it.',
};

export class SafeFetchRefused extends Error {
  constructor(code, detail = '') {
    super(REFUSAL_WORDS[code] || "We couldn't reach that website.");
    this.name = 'SafeFetchRefused';
    this.code = code;
    this.detail = detail;
  }
}

export function localAllowed(env = process.env) {
  return env.AUDIT_ALLOW_LOCAL === 'true' && !env.WEBSITE_SITE_NAME;
}

function v4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [v4ToInt(base), bits]);

function v4InBlocked(n) {
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((base & mask) >>> 0);
  });
}

/**
 * An IPv6 address as 16 bytes, or null. Handles "::" and a dotted IPv4 tail.
 *
 * Addresses are classified from these BYTES, never from how they are spelt:
 * Node's URL parser rewrites [::ffff:127.0.0.1] as [::ffff:7f00:1], so a text
 * check that only knows the dotted form lets the hex form straight through
 * (the hole this replaced, reviewer finding 7 Oct 2026).
 */
export function v6Bytes(ip) {
  let s = String(ip || '').toLowerCase().replace(/%.*$/, '');
  if (!net.isIPv6(s)) return null;
  let tail = [];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const n = v4ToInt(dotted[1]);
    if (n === null) return null;
    tail = [n >>> 16, n & 0xffff];
    s = s.slice(0, -dotted[1].length);
    if (s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1);
  }
  const compressed = s.includes('::');
  const [h, r] = s.split('::');
  const groupsOf = (x) => (x ? x.split(':').map((g) => parseInt(g, 16)) : []);
  const head = groupsOf(h);
  const rest = compressed ? groupsOf(r) : [];
  const fill = 8 - head.length - rest.length - tail.length;
  if (fill < 0 || (!compressed && fill !== 0)) return null;
  const groups = [...head, ...new Array(fill).fill(0), ...rest, ...tail];
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => { bytes[i * 2] = g >> 8; bytes[i * 2 + 1] = g & 0xff; });
  return bytes;
}

const allZero = (b, from, to) => { for (let i = from; i < to; i++) if (b[i] !== 0) return false; return true; };
const isV6Loopback = (b) => allZero(b, 0, 15) && b[15] === 1;

/**
 * The IPv4 address carried inside an IPv6 one, or null: IPv4-mapped
 * (::ffff:0:0/96) and IPv4-compatible (::/96, other than :: and ::1).
 */
function embeddedV4(b) {
  const mapped = allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff;
  const compatible = allZero(b, 0, 12) && !allZero(b, 12, 16) && !isV6Loopback(b);
  return mapped || compatible ? `${b[12]}.${b[13]}.${b[14]}.${b[15]}` : null;
}

/** The IPv4 form of an address however it is written (1.2.3.4, ::ffff:1.2.3.4, ::ffff:102:304), else null. */
function asV4(ip) {
  if (net.isIPv4(ip)) return ip;
  const b = v6Bytes(ip);
  return b ? embeddedV4(b) : null;
}

export function isLoopback(ip) {
  const s = String(ip || '').toLowerCase();
  const v4 = asV4(s);
  if (v4) return v4.startsWith('127.');
  const b = v6Bytes(s);
  return Boolean(b && isV6Loopback(b));
}

/** True for any address a public website can never have. */
export function isBlockedAddress(ip) {
  const s = String(ip || '').toLowerCase();
  const v4 = asV4(s);
  if (v4) {
    const n = v4ToInt(v4);
    return n === null || v4InBlocked(n);
  }
  const b = v6Bytes(s);
  if (!b) return true; // not an address at all: refuse
  // Only global unicast (2000::/3) can be a public website. This one rule
  // refuses ::, ::1, NAT64 64:ff9b::/96 and 64:ff9b:1::/48 (an IPv4 address
  // inside), the discard prefix 100::/64, link-local fe80::/10, site-local
  // fec0::/10, unique-local fc00::/7 and multicast ff00::/8.
  if ((b[0] & 0xe0) !== 0x20) return true;
  // Inside 2000::/3, the ranges that carry or relay another address:
  if (b[0] === 0x20 && b[1] === 0x02) return true; // 2002::/16 6to4 (IPv4 in bytes 2-5)
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // 2001::/32 Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && (b[3] & 0xf0) === 0x10) return true; // 2001:10::/28 ORCHID
  return false;
}

/**
 * Check an address before anything connects to it.
 * @returns {Promise<{ url: URL, address: string, family: number }>}
 */
export async function checkUrl(raw, { lookup = dns.promises.lookup, env = process.env, httpsOnly = false } = {}) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new SafeFetchRefused('bad_url', 'unparseable'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SafeFetchRefused('bad_url', url.protocol);
  if (url.username || url.password) throw new SafeFetchRefused('bad_url', 'credentials in address');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new SafeFetchRefused('bad_url', 'no host');

  let addresses;
  if (net.isIP(host)) {
    addresses = [{ address: host, family: net.isIP(host) }];
  } else {
    try {
      addresses = await lookup(host, { all: true });
    } catch (err) {
      throw new SafeFetchRefused('unreachable', `dns: ${err.code || err.message}`);
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) throw new SafeFetchRefused('unreachable', 'no address');

  const devLocal = localAllowed(env) && addresses.every((a) => isLoopback(a.address));
  if (!devLocal) {
    // ANY bad address refuses the whole host: a name that answers one public
    // and one internal address is exactly the rebinding trick.
    const bad = addresses.find((a) => isBlockedAddress(a.address));
    if (bad) throw new SafeFetchRefused('not_public', `${host} -> ${bad.address}`);
    if (url.port && url.port !== '80' && url.port !== '443') throw new SafeFetchRefused('not_public', `port ${url.port}`);
    if (httpsOnly && url.protocol !== 'https:') throw new SafeFetchRefused('not_https', url.protocol);
  }
  return { url, address: addresses[0].address, family: addresses[0].family || net.isIP(addresses[0].address) };
}

function pinnedLookup(address, family) {
  return (_host, opts, cb) => {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (opts && opts.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

const isHtml = (ct) => /\btext\/html\b|\bapplication\/xhtml\+xml\b/i.test(String(ct || ''));

/** One request to an address checkUrl already passed. No redirects. */
export function requestPinned(target, {
  method = 'GET', headers = {}, body = null,
  timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, htmlOnly = false,
} = {}) {
  const { url, address, family } = target;
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, v) => { if (!done) { done = true; clearTimeout(timer); fn(v); } };
    const req = lib.request(url, {
      method,
      headers: { 'User-Agent': USER_AGENT, Accept: htmlOnly ? 'text/html,application/xhtml+xml' : '*/*', ...headers },
      lookup: pinnedLookup(address, family),
    }, (res) => {
      const status = res.statusCode || 0;
      if (htmlOnly && status >= 200 && status < 300 && method !== 'HEAD' && !isHtml(res.headers['content-type'])) {
        res.destroy();
        return finish(reject, new SafeFetchRefused('not_html', String(res.headers['content-type'] || 'none')));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          res.destroy();
          finish(reject, new SafeFetchRefused('too_big', `${size} > ${maxBytes}`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => finish(resolve, { status, headers: res.headers, body: Buffer.concat(chunks), url: url.href }));
      res.on('error', (err) => finish(reject, new SafeFetchRefused('unreachable', err.message)));
    });
    const timer = setTimeout(() => {
      req.destroy();
      finish(reject, new SafeFetchRefused('timeout', `${timeoutMs} ms`));
    }, timeoutMs);
    req.on('error', (err) => finish(reject, err instanceof SafeFetchRefused ? err : new SafeFetchRefused('unreachable', err.code || err.message)));
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * Fetch with every hop checked.
 * @returns {Promise<{ status, headers, body: Buffer, url: string, redirects: string[] }>}
 */
export async function safeFetch(raw, opts = {}) {
  const { maxRedirects = MAX_REDIRECTS, lookup, env, httpsOnly = false, ...reqOpts } = opts;
  let current = String(raw);
  const redirects = [];
  for (let hop = 0; ; hop++) {
    const target = await checkUrl(current, { lookup, env, httpsOnly });
    const res = await requestPinned(target, reqOpts);
    const loc = res.headers.location;
    if (res.status >= 300 && res.status < 400 && loc && maxRedirects > 0) {
      if (hop >= maxRedirects) throw new SafeFetchRefused('too_many_redirects', current);
      let next;
      try { next = new URL(loc, current).href; } catch { throw new SafeFetchRefused('bad_url', `redirect to ${loc}`); }
      redirects.push(next);
      current = next;
      continue;
    }
    return { ...res, redirects };
  }
}

export default { safeFetch, checkUrl, requestPinned, isBlockedAddress, isLoopback, localAllowed, SafeFetchRefused, REFUSAL_WORDS, USER_AGENT };
