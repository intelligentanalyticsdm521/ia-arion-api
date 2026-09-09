// lib/businessName.js — what this business is called, for anything ARION
// writes onto a client's own website.
//
// ONE READER OF ONE SOURCE. It asks `lib/businessIdentityClient.js`, which asks
// platform-api's `lib/businessIdentity.js`, which is the platform's single
// answer to "what is this business called" (seams audit §10, SEAM-10-A, D-48:
// one name per business; a second brand is a second business).
//
// ── WHY THIS FILE EXISTS, 2026-09-08 (ARION pack 1) ───────────────────────
// PRE-WALK 2 took the twelfth name chain out of the website builder's
// `brandContext.js`. It left FOUR readers behind that still took the business's
// name straight off the ARION onboarding questionnaire:
//
//   lib/websiteBuilder/onboardingDriver.js:90   answersToBrand()  -> every
//                                               emitter prompt for a new site
//   lib/websiteBuilder/onboardingDriver.js:180  the FAQ topic seed
//   lib/hostingerSsh.js:519  createFallbackPages() -> `answers.businessName ||
//                            'Your Business'`, printed as an <h1> on six
//                            placeholder pages
//   lib/aiCopy.js:104-127    the fallback copy bundle AND the prompt
//   lib/imageGen.js:143      the image prompts
//
// The questionnaire is what somebody typed once, during signup, and on the dev
// database it held ANOTHER business's fixture — which is how Summit Lawn's own
// section library came back branded "Fernbrook Garden Rooms" (walk rows D3,
// S3-7). Worse, two of those readers had their own invented last resort
// ("Your Business", "this business"), so a business with no recorded name got a
// made-up one published on its own home page.
//
// THE RULE: a business with no recorded name is a real answer, and the answer is
// not a name. `name` comes back empty, `status` says why, and the CALLER decides
// what to render:
//
//   · text a visitor will read  -> BUSINESS_NAME_NOT_SET, never a guess
//     (brandContext re-exports the constant; it is defined here so there is
//      one of it)
//   · a phrase inside a model PROMPT -> `promptName()`, which returns the
//     neutral noun phrase "this business". That is not a brand: nothing
//     renders it, it only stops a prompt reading "write a hero for ".
//
// NEVER THROWS, and never adds a `||`. If you find yourself wanting one here,
// you are building the thirteenth chain.

import { getBusinessIdentity } from './businessIdentityClient.js';

/**
 * What a surface prints when the business has no recorded name. NOT a name:
 * a builder that prints a placeholder as a site's BRAND has invented one,
 * which is the whole reason the twelfth chain was a defect.
 */
export const BUSINESS_NAME_NOT_SET = 'Business name not set';

/** The neutral noun phrase for the inside of a prompt. Never rendered. */
export const NEUTRAL_PROMPT_NAME = 'this business';

/**
 * @param {string} tenantId
 * @returns {Promise<{ name: string, status: 'set'|'not_set'|'unknown', identity: object|null }>}
 *   `name` is '' unless `status` is 'set'.
 *   'unknown' means the resolver could not be reached and we have never had an
 *   answer for this business — which is a different fact from 'they have no
 *   name', and the two must not be collapsed.
 */
export async function resolveBusinessName(tenantId) {
  if (!tenantId) return { name: '', status: 'not_set', identity: null };
  let identity = null;
  try {
    identity = await getBusinessIdentity(tenantId);
  } catch (err) {
    // The client itself never throws; this is belt and braces so a name lookup
    // can never be the reason a site build fails.
    console.error(`[businessName] identity lookup threw for ${tenantId}: ${err?.message}`);
  }
  const named = !!(identity && identity.found && identity.name_source !== 'neutral');
  return {
    name: named ? String(identity.display_name || '').trim() : '',
    status: named ? 'set' : (identity && identity.stale ? 'unknown' : 'not_set'),
    identity,
  };
}

/** The name to RENDER: the real one, or the sentence. Never a guess. */
export function displayName(resolved) {
  return resolved && resolved.status === 'set' && resolved.name
    ? resolved.name
    : BUSINESS_NAME_NOT_SET;
}

/** The name to put INSIDE A PROMPT: the real one, or a neutral noun phrase. */
export function promptName(resolved) {
  return resolved && resolved.status === 'set' && resolved.name
    ? resolved.name
    : NEUTRAL_PROMPT_NAME;
}
