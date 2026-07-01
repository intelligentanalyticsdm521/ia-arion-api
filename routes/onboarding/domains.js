/**
 * Onboarding — Domain Routes
 * --------------------------------------------------------------------------
 * Used by the signup flow before a tenant exists in the DB. Handles the three
 * domain paths described in the onboarding spec:
 *
 *   1. /check        — search availability across common TLDs (no auth)
 *   2. /purchase     — buy domain via Hostinger (auth: signup session token)
 *   3. /byod         — register a Bring-Your-Own-Domain entry, get nameserver instructions
 *   4. /byod/status  — poll DNS to see if client has updated their nameservers
 *
 * Pricing markup:
 *   retail = max(wholesale + $4, wholesale * 1.30)
 *
 * "First year free on annual" is enforced at Stripe-checkout time, not here —
 * /check still shows full retail price so clients see real renewal pricing.
 */

import { Router } from 'express';
import {
  getDomainAvailability,
  purchaseDomain,
  enableDomainLock,
  enablePrivacyProtection,
  createWhoisProfile,
  listDomains,
} from '../../lib/hostinger.js';
import {
  verifyHostingerNameservers,
  getByodInstructions,
} from '../../lib/dnsVerifier.js';

const router = Router();

const DEFAULT_TLDS = ['com', 'net', 'co', 'io', 'online', 'shop', 'org'];
const MARKUP_FLAT_USD = 4;
const MARKUP_PCT = 0.30;

/**
 * Apply our markup to a wholesale price. Returns retail price in dollars.
 * @param {number} wholesale - in dollars
 */
function markup(wholesale) {
  if (typeof wholesale !== 'number' || wholesale <= 0) return null;
  const flat = wholesale + MARKUP_FLAT_USD;
  const pct = wholesale * (1 + MARKUP_PCT);
  return Math.round(Math.max(flat, pct) * 100) / 100;
}

/**
 * Validate a label for domain search (the part before the TLD).
 * Letters/digits/hyphens only, 1-63 chars, no leading/trailing hyphen.
 */
function isValidLabel(s) {
  if (typeof s !== 'string') return false;
  const lower = s.toLowerCase().trim();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(lower);
}

/**
 * Validate a fully-qualified domain.
 */
function isValidDomain(s) {
  if (typeof s !== 'string') return false;
  const lower = s.toLowerCase().trim();
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z]{2,})+$/.test(lower);
}

// ---------------------------------------------------------------------------
// POST /check  — search availability across TLDs
// Public endpoint (used during signup before account exists).
// Body: { query: "businessname", tlds?: ["com","co","net"] }
// ---------------------------------------------------------------------------
router.post('/check', async (req, res) => {
  const query = String(req.body?.query || '').toLowerCase().trim();
  const tlds = Array.isArray(req.body?.tlds) && req.body.tlds.length > 0
    ? req.body.tlds.map((t) => String(t).toLowerCase().replace(/^\./, ''))
    : DEFAULT_TLDS;

  // The client may pass either a label ("businessname") or a full domain
  // ("businessname.com") — strip the TLD and treat as a label.
  let label = query;
  if (label.includes('.')) {
    label = label.split('.')[0];
  }

  if (!isValidLabel(label)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid domain label', status: 400 },
    });
  }

  const candidates = tlds.map((tld) => `${label}.${tld}`);

  // Hostinger's availability endpoint may accept a single domain at a time;
  // call in parallel with a small concurrency limit.
  const results = await Promise.all(
    candidates.map(async (domain) => {
      try {
        const r = await getDomainAvailability(domain);
        if (!r) return { domain, available: false, error: 'check_failed' };
        // Normalize whatever shape Hostinger returns into a stable contract
        const available = Boolean(r.available ?? r.is_available ?? false);
        const wholesale = Number(r.price ?? r.registration_price ?? 0) || null;
        const retail = wholesale ? markup(wholesale) : null;
        return {
          domain,
          available,
          price_per_year: retail,
          currency: r.currency || 'USD',
        };
      } catch (err) {
        return { domain, available: false, error: 'check_failed' };
      }
    })
  );

  // Sort: available .com first, then other available, then unavailable
  results.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    const aDotCom = a.domain.endsWith('.com') ? 0 : 1;
    const bDotCom = b.domain.endsWith('.com') ? 0 : 1;
    return aDotCom - bDotCom;
  });

  return res.json({
    data: { results, query: label, tlds_checked: tlds },
    meta: { timestamp: new Date().toISOString() },
  });
});

// ---------------------------------------------------------------------------
// GET /hostinger-existing  — list domains already on the IA master Hostinger
// account. Used by the founder wizard when `domain_choice = 'hostinger_existing'`
// so the operator can pick from a real dropdown instead of typing an FQDN.
// Public (signup context); returns just {domain, status, expires_at}, no PII.
// ---------------------------------------------------------------------------
router.get('/hostinger-existing', async (req, res) => {
  try {
    const raw = await listDomains();
    // Upstream returns either an array or {data:[...]} or {domains:[...]}.
    const list = Array.isArray(raw) ? raw : (raw?.data || raw?.domains || []);
    const domains = list
      .map((d) => ({
        domain: d.domain || d.name || null,
        status: d.status || null,
        expires_at: d.expires_at || d.expiration_date || null,
      }))
      .filter((d) => d.domain);
    return res.json({
      data: { domains },
      meta: { count: domains.length, timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[onboarding/domains:hostinger-existing]', err);
    return res.status(502).json({
      error: { code: 'UPSTREAM_ERROR', message: err.message || 'Hostinger listDomains failed', status: 502 },
    });
  }
});

// ---------------------------------------------------------------------------
// POST /purchase  — buy a domain on the client's behalf
// Requires: signup session token OR authenticated tenant.
// Body: { domain, whois: {...}, period: 1, signupSessionId? | tenantId? }
// ---------------------------------------------------------------------------
router.post('/purchase', async (req, res) => {
  const { domain, whois, period = 1 } = req.body || {};

  if (!isValidDomain(domain)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid domain', status: 400 },
    });
  }
  if (!whois || !whois.email || !whois.first_name || !whois.last_name) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'whois profile is required (first_name, last_name, email)', status: 400 },
    });
  }

  try {
    // 1. Ensure a WHOIS profile exists. We could look up by email and reuse,
    //    but for now create a fresh profile per signup; reconcile in a later pass.
    const whoisRes = await createWhoisProfile({
      tld: domain.split('.').pop(),
      country: whois.country || 'US',
      entity_type: whois.entity_type || 'individual',
      first_name: whois.first_name,
      last_name: whois.last_name,
      email: whois.email,
      phone: whois.phone || '',
      address1: whois.address1 || '',
      city: whois.city || '',
      state: whois.state || '',
      zip: whois.zip || '',
    });
    if (!whoisRes.ok) {
      return res.status(502).json({
        error: { code: 'UPSTREAM_ERROR', message: 'WHOIS profile creation failed: ' + whoisRes.error, status: 502 },
      });
    }
    const whoisProfileId = whoisRes.data?.id || whoisRes.data?.profile_id;

    // 2. Purchase the domain
    const purchase = await purchaseDomain({
      domain,
      whoisProfileId,
      period: Math.max(1, Math.min(10, Number(period) || 1)),
      privacyProtection: true,
    });
    if (!purchase.ok) {
      return res.status(502).json({
        error: { code: 'UPSTREAM_ERROR', message: 'Domain purchase failed: ' + purchase.error, status: 502 },
      });
    }

    // 3. Lock the domain (defense against unauthorized transfer)
    enableDomainLock(domain).catch((e) => console.warn('[onboarding/domains] enableDomainLock failed:', e.message));
    enablePrivacyProtection(domain).catch((e) => console.warn('[onboarding/domains] enablePrivacyProtection failed:', e.message));

    return res.json({
      data: {
        domain,
        status: 'registered',
        whois_profile_id: whoisProfileId,
        order_id: purchase.data?.order_id || null,
        period_years: period,
      },
      meta: { timestamp: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[onboarding/domains:purchase]', err);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: err.message, status: 500 },
    });
  }
});

// ---------------------------------------------------------------------------
// POST /byod  — client wants to use a domain they already own
// Body: { domain }
// Returns nameserver instructions to display in the UI.
// ---------------------------------------------------------------------------
router.post('/byod', async (req, res) => {
  const domain = String(req.body?.domain || '').toLowerCase().trim();
  if (!isValidDomain(domain)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid domain', status: 400 },
    });
  }

  // Run an immediate verification check so the UI can show "already pointed!"
  // if the client happens to have already updated their NS.
  const status = await verifyHostingerNameservers(domain);
  const instructions = getByodInstructions(domain);

  return res.json({
    data: {
      domain,
      verified: status.pointsToHostinger,
      current_nameservers: status.nameservers,
      instructions,
    },
    meta: { timestamp: new Date().toISOString() },
  });
});

// ---------------------------------------------------------------------------
// GET /byod/status?domain=...  — poll endpoint for the UI to call every 30s
// ---------------------------------------------------------------------------
router.get('/byod/status', async (req, res) => {
  const domain = String(req.query?.domain || '').toLowerCase().trim();
  if (!isValidDomain(domain)) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid domain', status: 400 },
    });
  }
  const status = await verifyHostingerNameservers(domain);
  return res.json({
    data: {
      domain,
      verified: status.pointsToHostinger,
      nameservers: status.nameservers,
      checked_at: status.checkedAt,
    },
    meta: { timestamp: new Date().toISOString() },
  });
});

export default router;
