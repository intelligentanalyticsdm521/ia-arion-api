// middleware/requireFounder.js — the founder gate the Portal can actually use.
//
// arion-api's only founder gate was a static bearer (FOUNDER_ADMIN_TOKEN,
// routes/admin/onboardExisting.js). That works for a script or a curl, but a
// browser page cannot hold it — shipping it in the Portal bundle would publish
// the secret to every visitor. So the founder queue page had no way in.
//
// This accepts EITHER:
//   1. the static FOUNDER_ADMIN_TOKEN bearer — unchanged, so the onboard
//      script and any server-to-server caller keep working; or
//   2. a normal Portal sign-in whose user holds an ACTIVE founder /
//      super_admin platform role in iadm_platform.
//
// (2) WAS "the same question platform-api's isFounderCaller asks", written out
// again here in this repo's own SQL. SEAMS PACK 4B: it is now literally that
// question, asked over POST /internal/founder, so the two cannot drift. The
// SQL that used to live in findFounderRole is deleted; the predicate — which
// role keys count, which columns are matched — lives once, in platform-api
// lib/founder.js, including arion's extra `pr.name = 'SUPER_ADMIN'` spelling,
// which was carried across deliberately so consolidating does not quietly lock
// somebody out who passes today.
// Per reference_role_access_model the gate is FOUNDER, not "super user in the
// UI sense"; the Portal mirrors it with RequireFounderRoute so a client never
// sees the page, and this middleware is what actually stops them.
//
// Deliberately NOT tenant-scoped: the queue spans every business, so there is
// no x-tenant-key to resolve and requireArionAccess does not apply.
import { requireAuth } from "./requireAuth.js";
import { resolveFounderFacts, FounderUnavailable } from "../lib/founderClient.js";

/** Bearer matches the static founder token. False when the token is unset. */
export function matchesFounderAdminToken(req) {
  const expected = process.env.FOUNDER_ADMIN_TOKEN || "";
  if (!expected) return false;
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") && h.slice(7) === expected;
}

/**
 * Does the signed-in caller hold an active founder / super-admin platform
 * role? Returns `{ roleKey }` or null.
 *
 * SEAMS PACK 4B — one call to the ONE answer. `is_founder` is the platform
 * ROLE, which is what this gate has always meant and what
 * reference_role_access_model says the founder is.
 *
 * Throws FounderUnavailable when there is no answer — never null. A gate that
 * reads "could not check" as "not a founder" answers 403, which tells a
 * founder we checked and refused them; the caller below turns it into 503.
 */
export async function findFounderRole(claims) {
  const facts = await resolveFounderFacts(claims);
  return facts.is_founder ? { roleKey: facts.role_key || "founder" } : null;
}

/**
 * The half that runs AFTER requireAuth has proved who the caller is.
 *
 * A caller who is signed in but not a founder gets 403 (they exist, they are
 * simply not allowed) — never a 401, which would send the Portal off to
 * re-authenticate in a loop. A lookup we could not RUN is a 503, never a quiet
 * pass: an unreachable platform DB must not open the queue to everyone.
 *
 * PRE-WALK 2 found this answering 500. Walk row W-4B-F.7 states the rule for
 * the same question on view-as: **503 `founder_lookup_unavailable`, retryable
 * — NOT 403**, because "we could not check" and "we checked and you may not"
 * are different statements and only one of them is actionable. A 500 is worse
 * than the 403 the row forbids: it is neither actionable NOR attributable — a
 * founder reading it cannot tell a stopped platform-api from a bug in this
 * page. platform-api's own resolver already answers exactly this
 * (routes/internal/founder.js:69), and the retry hint is the shape
 * middleware/sqlTokenRetry.js already uses.
 *
 * Exported with an injectable pool so the refusal can be tested without a
 * database — every dev fixture user carries the founder role, so dev traffic
 * cannot exercise the refusal on its own.
 */
export async function founderRoleGate(req, res, next, resolve = findFounderRole) {
  try {
    const founder = await resolve(req.auth);
    if (!founder) {
      return res.status(403).json({
        error: { code: "FORBIDDEN", message: "Founder access required", status: 403 },
      });
    }
    req.founderAuth = { via: "platform_role", roleKey: founder.roleKey };
    return next();
  } catch (err) {
    // A lookup we could not RUN is 503, never the 403 above: "we checked and
    // you may not" is a different statement from "we could not check", and a
    // founder can act on only one of them.
    const why = err instanceof FounderUnavailable || err?.name === "FounderUnavailable"
      ? err.reason : err.message;
    console.error("[requireFounder] founder lookup unavailable:", why);
    // Retry-After is what makes "retryable" a fact the browser can act on
    // rather than a word in a JSON body.
    res.set("Retry-After", "5");
    return res.status(503).json({
      error: {
        code: "founder_lookup_unavailable",
        message: "We could not check whether you are the founder. Try again in a moment.",
        status: 503,
        retryable: true,
        reason: why,
      },
    });
  }
}

/** Gate: static founder token OR a founder-role Portal sign-in. */
export function requireFounder(req, res, next) {
  if (matchesFounderAdminToken(req)) {
    req.founderAuth = { via: "admin_token" };
    return next();
  }
  // requireAuth answers 401 itself when the token is missing or invalid.
  return requireAuth(req, res, () => founderRoleGate(req, res, next));
}
