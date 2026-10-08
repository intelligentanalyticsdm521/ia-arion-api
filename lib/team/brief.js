// lib/team/brief.js — the Business Brief, as a job reads it.
//
// briefFor(tenantId) -> { ok: true, brief } | { ok: false, error }
//
// Asks platform-api GET /internal/business-brief/:tenantId, which answers
// with SAVED answers only (a suggestion is never `set`). Same two settings
// every other platform client here uses (PLATFORM_API_URL and
// PLATFORM_INTERNAL_TOKEN, read only through lib/platformEnv.js); nothing new.
//
// A DECLARED COPY of LUMEN src/lib/team/brief.js. Change both.
//
// FAILS CLOSED. Any non-200, a timeout, a body that is not the Brief's shape,
// or a missing setting is { ok: false }, and the runner does nothing for that
// business this tick ("I couldn't read your business details, so I didn't
// write anything."). There is no default Brief and no cache across ticks: a
// job never writes from a guess.

import { platformApiUrl, platformInternalToken } from "../platformEnv.js";

export const REQUEST_TIMEOUT_MS = 5000;

/**
 * @param {string} tenantId
 * @param {{fetchImpl?:Function, log?:object, env?:object}} [opts]
 */
export async function briefFor(tenantId, opts = {}) {
  const log = opts.log || console;
  const env = opts.env || process.env;
  const id = String(tenantId || "").trim().toLowerCase();
  const fail = (error) => {
    log.error?.(`[brief] could not read the business details for ${id || "(no business)"}: ${error}`);
    return { ok: false, error };
  };
  if (!id) return fail("no business id");
  const base = platformApiUrl(env);
  const token = platformInternalToken(env);
  if (!base || !token) return fail("PLATFORM_API_URL / PLATFORM_INTERNAL_TOKEN not configured");
  const doFetch = opts.fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await doFetch(`${String(base).replace(/\/+$/, "")}/internal/business-brief/${encodeURIComponent(id)}`, {
      headers: { "x-internal-token": token },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    return fail(`unreachable (${e?.message || e})`);
  }
  if (!res || res.status !== 200) return fail(`HTTP ${res?.status}`);
  let body;
  try { body = await res.json(); } catch (e) { return fail(`unreadable answer (${e?.message || e})`); }
  if (!body || typeof body !== "object" || typeof body.version !== "number" || !body.fields || typeof body.fields !== "object") {
    return fail("the answer is not the business details");
  }
  return { ok: true, brief: body };
}

export default { briefFor, REQUEST_TIMEOUT_MS };
