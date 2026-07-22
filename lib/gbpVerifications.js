// lib/gbpVerifications.js
//
// Google My Business Verifications API v1 wrapper (GBP Connect Batch B,
// 2026-07-22).
//
// Why this exists:
//   Batch B's "I need one created" flow creates the listing on the CLIENT'S
//   token under the CLIENT'S account (client = PRIMARY_OWNER; the IA-master
//   autoProvisionGoogle model is SUPERSEDED and must not be called). A brand
//   new listing is unverified, so the portal drives Google's verification
//   flow end-to-end without leaving ARION:
//     fetch options → request verification → complete with PIN → poll
//     VoiceOfMerchant until hasVoiceOfMerchant === true.
//
// Resource-name contract:
//   Callers hold "accounts/{a}/locations/{l}" (that is what arion.site.
//   gbp_location_name stores). The Verifications API addresses locations as
//   "locations/{l}" ONLY — normalizeLocationName() strips the account half
//   here so no caller has to know that quirk. Verification resource names
//   ("locations/{l}/verifications/{v}") are already API-shaped and pass
//   through untouched.
//
// Error mapping is shared with lib/gbpApi.js#googleFetch — one place knows
// gbp_quota_exceeded / gbp_api_disabled.
//
// References:
//   https://mybusinessverifications.googleapis.com/v1
//   lib/gbpApi.js (googleFetch, listAllGbpLocations — T5 is_verified signal)
//   routes/arion.js (/sites/:siteId/gbp/verification-* routes)

import { googleFetch } from './gbpApi.js';

const BASE = 'https://mybusinessverifications.googleapis.com/v1';

/**
 * Normalize any of "accounts/{a}/locations/{l}", "locations/{l}" or a bare
 * "{l}" to the "locations/{l}" form the Verifications API expects.
 */
export function normalizeLocationName(locationName) {
  if (!locationName || typeof locationName !== 'string') return null;
  const parts = locationName.split('/').filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join('/');
  return `locations/${parts[0]}`;
}

/**
 * POST locations/{l}:fetchVerificationOptions
 * Returns Google's response: { options: [{ verificationMethod, phoneNumber?,
 * addressData?, emailData?, announcement? }, ...] }.
 */
export async function fetchVerificationOptions(accessToken, locationName, { languageCode = 'en-US' } = {}) {
  const loc = normalizeLocationName(locationName);
  return googleFetch(accessToken, 'POST', `${BASE}/${loc}:fetchVerificationOptions`, { languageCode });
}

/**
 * POST locations/{l}:verify — start a verification with the chosen option.
 *
 * `option` is either a bare method string ("PHONE_CALL") or the option object
 * returned by fetchVerificationOptions (optionally enriched by the portal
 * with emailAddress / mailerContact). We build Google's VerifyLocationRequest
 * from it: { method, languageCode } plus the method-specific contact field.
 *
 * Returns { verification: { name, method, state, createTime, ... } }.
 */
export async function requestVerification(accessToken, locationName, option, { languageCode = 'en-US' } = {}) {
  const loc = normalizeLocationName(locationName);
  const opt = typeof option === 'string' ? { verificationMethod: option } : (option || {});
  const method = opt.verificationMethod || opt.method;
  if (!method) {
    const err = new Error('requestVerification: option must carry verificationMethod');
    err.code = 'gbp_invalid_verification_option';
    throw err;
  }
  const body = { method, languageCode: opt.languageCode || languageCode };
  // Method-specific context. Only forward what the option carries — Google
  // rejects fields that do not belong to the chosen method.
  if (opt.phoneNumber) body.phoneNumber = opt.phoneNumber;
  if (opt.emailAddress) body.emailAddress = opt.emailAddress;
  else if (opt.emailData?.user && opt.emailData?.domain) body.emailAddress = `${opt.emailData.user}@${opt.emailData.domain}`;
  if (opt.mailerContact) body.mailerContact = opt.mailerContact;
  return googleFetch(accessToken, 'POST', `${BASE}/${loc}:verify`, body);
}

/**
 * POST {verificationName}:complete — submit the PIN the client received.
 * verificationName is "locations/{l}/verifications/{v}" (from the verify
 * response) and is already API-shaped: no normalization.
 * Returns { verification: { ..., state: "COMPLETED" | ... } }.
 */
export async function completeVerification(accessToken, verificationName, pin) {
  if (!verificationName || !pin) {
    const err = new Error('completeVerification: verificationName and pin are required');
    err.code = 'gbp_invalid_verification_complete';
    throw err;
  }
  return googleFetch(accessToken, 'POST', `${BASE}/${verificationName}:complete`, { pin: String(pin) });
}

/**
 * GET locations/{l}/verifications — list past + pending verification
 * attempts. Returns { verifications: [...] } (may be empty).
 */
export async function listVerifications(accessToken, locationName) {
  const loc = normalizeLocationName(locationName);
  return googleFetch(accessToken, 'GET', `${BASE}/${loc}/verifications`);
}

/**
 * GET locations/{l}/VoiceOfMerchantState — Google's authoritative "is this
 * listing live" signal. hasVoiceOfMerchant === true is THE verified state
 * (same signal T5 reads from listing metadata) — treat anything else as
 * unverified, fail-closed.
 */
export async function getVoiceOfMerchantState(accessToken, locationName) {
  const loc = normalizeLocationName(locationName);
  return googleFetch(accessToken, 'GET', `${BASE}/${loc}/VoiceOfMerchantState`);
}
