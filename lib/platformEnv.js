// lib/platformEnv.js — ONE name for the platform-api address, ONE for the
// token oliver sends it. Seams audit §11 (SEAM-11).
//
// Canonical, everywhere, in every service:
//
//     PLATFORM_API_URL          where platform-api is
//     PLATFORM_INTERNAL_TOKEN   the secret arion-api sends platform-api's /internal/*
//
// Four legacy names were in use for those two things, and which one a file read
// depended on when it was written: `PLATFORM_API_BASE_URL` (auditLog, roleGuard),
// `PLATFORM_API_BASE`, `PLATFORM_INTERNAL_SERVICE_TOKEN` and
// `LUMEN_INTERNAL_SERVICE_TOKEN` (notificationGate, ownerAlert). Two files
// reading two different names for the same secret is not a style problem: set
// one of them on the App Service and half the calls authenticate.
//
// The aliases are accepted for ONE more release, with a startup WARNING each.
// After that release they come out and this file goes with them.
//
// ── WHAT THIS FILE IS NOT ABOUT ───────────────────────────────────────────
// Only the token arion-api SENDS TO platform-api, and platform-api's address.
// Two other secrets look similar and are deliberately untouched:
//
//   · `PROVISIONER_SHARED_SECRET` — arion's OWN INBOUND secret, checked on
//     arion's own provisioning routes. A different secret protecting a
//     different service, in the other direction.
//   · `FOUNDER_ADMIN_TOKEN` — the static bearer a SCRIPT presents to
//     middleware/requireFounder.js. Also inbound, also not this.
//
// Collapsing any of those into PLATFORM_INTERNAL_TOKEN would make one value
// open three doors.
//
// CREATED by seams pack 4b. lib/entitlements.js had its own private `baseUrl()`
// and `token()` reading the same five names — the second env-reading copy in
// this repo, which is exactly the SEAM-11 shape one repo lower down. Both read
// through this file now.

/** Legacy → canonical, in preference order after the canonical name. */
const URL_ALIASES = ["PLATFORM_API_BASE_URL", "PLATFORM_API_BASE"];
const TOKEN_ALIASES = ["PLATFORM_INTERNAL_SERVICE_TOKEN", "LUMEN_INTERNAL_SERVICE_TOKEN"];

const CANONICAL_URL = "PLATFORM_API_URL";
const CANONICAL_TOKEN = "PLATFORM_INTERNAL_TOKEN";

/** First of `names` with a non-empty value, or null. Never returns the value. */
function firstNameSet(env, names) {
  for (const n of names) {
    if (String(env?.[n] ?? "").trim()) return n;
  }
  return null;
}

function readFirst(env, names) {
  const name = firstNameSet(env, names);
  return name ? String(env[name]).trim() : "";
}

/** platform-api's base URL, trailing slashes stripped. "" when unset. */
export function platformApiUrl(env = process.env) {
  return readFirst(env, [CANONICAL_URL, ...URL_ALIASES]).replace(/\/+$/, "");
}

/** The secret oliver sends platform-api's /internal/*. "" when unset. */
export function platformInternalToken(env = process.env) {
  return readFirst(env, [CANONICAL_TOKEN, ...TOKEN_ALIASES]);
}

function warningFor(legacyName, canonicalName) {
  return (
    `[config] \`${legacyName}\` is a legacy name for \`${canonicalName}\` and will be removed ` +
    `after the next release. Set \`${canonicalName}\` in this service's configuration ` +
    `(.env locally, App Service application settings in Azure). ` +
    `Compatibility shim: arion-api/lib/platformEnv.js`
  );
}

/**
 * The warnings this configuration earns — one per concern, naming the legacy
 * name actually being relied on.
 *
 * A legacy name only warns when it is LOAD-BEARING: the canonical name is
 * absent and the fallback is what the calls are really using. A stale legacy
 * var sitting next to a correct canonical one changes no behaviour, and
 * warning about it every boot is how people learn to scroll past warnings.
 *
 * Never contains a value — these lines go to logs.
 */
export function aliasWarnings(env = process.env) {
  const out = [];
  if (!String(env?.[CANONICAL_URL] ?? "").trim()) {
    const legacy = firstNameSet(env, URL_ALIASES);
    if (legacy) out.push(warningFor(legacy, CANONICAL_URL));
  }
  if (!String(env?.[CANONICAL_TOKEN] ?? "").trim()) {
    const legacy = firstNameSet(env, TOKEN_ALIASES);
    if (legacy) out.push(warningFor(legacy, CANONICAL_TOKEN));
  }
  return out;
}

const _warned = new Set();

/** Emit each warning ONCE per process. Called at boot; safe to call again. */
export function warnOnAliases(env = process.env, log = console.warn) {
  for (const w of aliasWarnings(env)) {
    if (_warned.has(w)) continue;
    _warned.add(w);
    log(w);
  }
}

/** Test seam. */
export function resetAliasWarnings() { _warned.clear(); }
