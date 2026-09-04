// lib/reservedSlugs.js — a business address the apps can actually route (D-38).
//
// Under the path model the FIRST path segment on a shared host names the
// business:
//
//     customer.ia-dm.com/summit-lawn/jobs/JOB-00152
//     crew.ia-dm.com/summit-lawn/schedule
//     book.ia-dm.com/summit-lawn
//
// Some first segments are not businesses — the public, token-authenticated
// pages that must work with no business context at all, and the static asset
// directories the host serves itself. Until now each app kept its OWN list
// (customer: p, unsubscribe · crew: p, present · booking: confirm, cancel) and
// **nothing validated a tenant slug against any of them at creation**. A
// business created with the slug `p` would have been unreachable: its customers
// would have landed on somebody else's proposal token route.
//
// ONE LIST. `reserved-slugs.json` beside this file is the UNION of what the
// three apps reserve, and the same bytes are in the three app repos
// (`src/lib/reserved-slugs.json`) and in oliver-api (`lib/reserved-slugs.json`).
// Each of the five repos pins its sha256 in its own suite, so a change in one
// turns all five red until they match — a business slug and an app path segment
// can no longer disagree.
//
// arion-api matters here because it ALSO creates tenants: `lib/coreTenants.js`
// and `routes/admin/onboardExisting.js` both mint a slug from a business name,
// and neither knew anything about the reserved list. oliver-api being fixed
// alone would have left the defect open in the one repo nobody was looking at.
//
// TWO DIFFERENT ANSWERS, DELIBERATELY
//   · A slug a caller TYPED is refused, with a reason they can read. Silently
//     changing what somebody asked for is how you get a business whose printed
//     address is not its address.
//   · A slug DERIVED from a business name is repaired, because a business
//     called "P" must still be able to finish signing up. Failing an onboarding
//     over a name the customer cannot be expected to know about is a worse
//     outcome than an address with a suffix on it — and the derive paths
//     already append a suffix for collisions, so the shape is one people have
//     already seen.
//
// Every slug arion mints is DERIVED — there is no route here where a caller
// types one — so `repairDerivedSlug` is the function this repo uses.
// `validateSlug` is exported for symmetry with oliver-api and to keep the two
// copies readable side by side.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const doc = JSON.parse(fs.readFileSync(path.join(HERE, "reserved-slugs.json"), "utf8"));

/** The union, as the JSON lists it. */
export const RESERVED_SEGMENTS = Object.freeze([...doc.segments]);
const RESERVED = new Set(RESERVED_SEGMENTS);

/**
 * The shape of an address.
 *
 * Lowercase, starts alphanumeric, hyphens allowed, 63 characters — a DNS label,
 * because the legacy `{slug}.customer.ia-dm.com` form still has to resolve and
 * every one of those links ever printed still works.
 *
 * This is also what keeps `sw.js`, `manifest.webmanifest`, `favicon.ico`,
 * `robots.txt` and every other dotted file at the origin root out: a dot is not
 * in the character class, so they can never be slugs and do not need listing.
 */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isReservedSlug(slug) {
  return RESERVED.has(String(slug || "").toLowerCase().trim());
}

/**
 * May this be a business's address?
 *
 * @returns {{ok: true, slug: string} | {ok: false, code: string, reason: string}}
 * `reason` is written to be shown to a person, not logged at one.
 */
export function validateSlug(input) {
  const slug = String(input || "").toLowerCase().trim();

  if (!slug) {
    return { ok: false, code: "slug_required", reason: "A web address is required." };
  }
  if (!SLUG_RE.test(slug)) {
    return {
      ok: false,
      code: "invalid_slug",
      reason:
        "A web address can use lowercase letters, numbers and hyphens only, must start with a letter or number, " +
        "and can be at most 63 characters.",
    };
  }
  if (RESERVED.has(slug)) {
    return {
      ok: false,
      code: "reserved_slug",
      reason:
        `"${slug}" is reserved for links we send your customers, so it cannot be a business web address. ` +
        `Try "${slug}-${suggestionSuffix(slug)}" or something closer to your business name.`,
    };
  }
  return { ok: true, slug };
}

/** A suggestion that is itself valid, so the person can just accept it. */
function suggestionSuffix(slug) {
  return slug.length <= 2 ? "co" : "hq";
}

/**
 * Turn a DERIVED slug into one that is safe to store, without ever throwing.
 *
 * `disambiguator` is the same short id fragment the collision paths already
 * append, so a repaired address looks exactly like a de-duplicated one.
 * Returns the input unchanged when it is already fine.
 */
export function repairDerivedSlug(candidate, disambiguator) {
  const suffix = String(disambiguator || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8) || "co";

  let slug = String(candidate || "").toLowerCase().trim();

  // Nothing usable came out of the business name at all.
  if (!slug) return `tenant-${suffix}`;

  if (RESERVED.has(slug)) slug = `${slug}-${suffix}`;
  if (!SLUG_RE.test(slug)) {
    slug = slug.replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-+/, "").slice(0, 63);
    if (!slug || !/^[a-z0-9]/.test(slug)) slug = `tenant-${suffix}`;
  }
  slug = slug.slice(0, 63).replace(/-+$/, "");
  // The trim above can uncover a reserved word or empty the string.
  if (!slug || RESERVED.has(slug)) slug = `${slug || "tenant"}-${suffix}`.slice(0, 63);
  return slug;
}
