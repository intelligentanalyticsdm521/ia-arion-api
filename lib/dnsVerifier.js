/**
 * DNS Verifier
 * --------------------------------------------------------------------------
 * Used by the BYOD onboarding flow to detect when a client has updated their
 * nameservers to point at Hostinger. We poll public DNS (Google + Cloudflare
 * DoH) since some clients sit behind networks where direct DNS resolvers are
 * blocked or slow.
 *
 * The check passes when the apex domain's NS records contain at least one
 * Hostinger-controlled nameserver (`*.dns-parking.com` is what Hostinger uses
 * for sites under their default DNS).
 */

const HOSTINGER_NS_PATTERNS = [
  /\.dns-parking\.com\.?$/i,
  /\.hostinger\.com\.?$/i,
];

const DOH_RESOLVERS = [
  'https://dns.google/resolve',
  'https://cloudflare-dns.com/dns-query',
];

/**
 * Resolve NS records for a domain via DNS-over-HTTPS.
 * Tries Google first, then Cloudflare. Returns a flat array of NS host strings.
 * @param {string} domain
 * @returns {Promise<string[]>}
 */
export async function lookupNameservers(domain) {
  const lower = domain.toLowerCase().replace(/\.$/, '');
  for (const resolver of DOH_RESOLVERS) {
    try {
      const url = `${resolver}?name=${encodeURIComponent(lower)}&type=NS`;
      const res = await fetch(url, {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const answers = Array.isArray(data.Answer) ? data.Answer : [];
      const nss = answers
        .filter((a) => a.type === 2) // NS record type
        .map((a) => String(a.data || '').toLowerCase().replace(/\.$/, ''))
        .filter(Boolean);
      if (nss.length > 0) return nss;
    } catch (err) {
      // try next resolver
    }
  }
  return [];
}

/**
 * Walk a domain up toward its registrable parent and find the first level
 * that actually returns NS records. NS records for subdomains are usually
 * empty in the Answer section (delegation is at the parent), so we have to
 * climb to find the authoritative nameservers.
 *
 * Caps at 5 labels to avoid runaway requests on weird inputs.
 *
 * @param {string} domain
 * @returns {Promise<{nameservers: string[], resolvedAt: string}>}
 */
async function lookupNameserversWalkingUp(domain) {
  let current = domain.toLowerCase().replace(/\.$/, '');
  for (let i = 0; i < 5; i++) {
    const nss = await lookupNameservers(current);
    if (nss.length > 0) return { nameservers: nss, resolvedAt: current };
    const idx = current.indexOf('.');
    if (idx < 0) break;
    const next = current.slice(idx + 1);
    if (!next || next === current || !next.includes('.')) break; // stop at registrable
    current = next;
  }
  return { nameservers: [], resolvedAt: domain };
}

/**
 * Determine whether a domain's NS records currently point to Hostinger.
 * Walks up to the registrable parent so subdomains of Hostinger-managed
 * domains correctly pass (e.g. arion-test.intelligentanalyticsdm.com inherits
 * intelligentanalyticsdm.com's NS records, but the DoH query at the subdomain
 * level returns no Answer rows — only the parent does).
 *
 * @param {string} domain
 * @returns {Promise<{pointsToHostinger: boolean, nameservers: string[], resolvedAt: string, checkedAt: string}>}
 */
export async function verifyHostingerNameservers(domain) {
  const { nameservers, resolvedAt } = await lookupNameserversWalkingUp(domain);
  const pointsToHostinger = nameservers.some((ns) =>
    HOSTINGER_NS_PATTERNS.some((re) => re.test(ns))
  );
  return {
    pointsToHostinger,
    nameservers,
    resolvedAt,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Poll DNS until nameservers point to Hostinger or timeout is reached.
 *
 * @param {string} domain
 * @param {object} [opts]
 * @param {number} [opts.maxWaitMs=14400000] - 4 hours default
 * @param {number} [opts.intervalMs=30000]   - 30s between checks
 * @param {(status: object) => void} [opts.onTick] - optional progress callback
 * @returns {Promise<{verified: boolean, nameservers: string[], elapsedMs: number, reason?: string}>}
 */
export async function pollUntilVerified(domain, opts = {}) {
  const maxWaitMs = opts.maxWaitMs ?? 4 * 60 * 60 * 1000; // 4 hours
  const intervalMs = opts.intervalMs ?? 30_000;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const status = await verifyHostingerNameservers(domain);
    if (typeof opts.onTick === 'function') opts.onTick(status);
    if (status.pointsToHostinger) {
      return {
        verified: true,
        nameservers: status.nameservers,
        elapsedMs: Date.now() - start,
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return {
    verified: false,
    nameservers: [],
    elapsedMs: Date.now() - start,
    reason: 'timeout',
  };
}

/**
 * Generate the human-readable instructions to give to a BYOD client.
 * Used by the onboarding UI.
 * @param {string} domain
 * @returns {{step1: string, step2: string, nameservers: string[], note: string}}
 */
export function getByodInstructions(domain) {
  return {
    step1: `Sign in to wherever you registered ${domain} (e.g. GoDaddy, Namecheap, Google Domains).`,
    step2: 'Find the "Nameservers" or "DNS" setting and replace the existing nameservers with these:',
    nameservers: ['ns1.dns-parking.com', 'ns2.dns-parking.com'],
    note: 'DNS changes typically take 30 minutes to a few hours to propagate. We\'ll keep checking and start building your site as soon as your domain points to us.',
  };
}
