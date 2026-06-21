// lib/walkthroughClient.js — Onboarding V3 Phase 3 (Batch 14+).
//
// Cross-product equivalent of LUMEN-API's in-process
// completeWalkthroughTaskByKind(tenantId, kind) helper. arion-api ships its
// own thin HTTP client (native fetch — no axios in arion-api) that POSTs to
// LUMEN-API's `/api/v1/walkthrough/tasks/by-kind/:kind/complete` endpoint.
//
// The endpoint flips the matching open walkthrough task from 'pending' →
// 'done' (idempotent — re-firing yields completed=0).
//
// CONSTRAINT (Brandon, 2026-06-20): failure of this call MUST NEVER break the
// parent action. The function is designed to be `.catch(() => {})`-safe — it
// never throws, returns { ok: false } on failure, and times out aggressively.
//
// Two call shapes:
//
//   // 1. Tenant-scoped route (req.tenant.tenantId present):
//   await completeWalkthroughTaskByKind(req, "arion_custom_domain");
//
//   // 2. OAuth callback / non-tenant-scoped route (must pass tenantId
//   //    explicitly because the callback is unauthenticated):
//   await completeWalkthroughTaskByKindFor(tenantId, "connect_gbp");
//
// Both forms return the same { ok, completed, matched, reason? } shape.

const DEFAULT_TIMEOUT_MS = 4000;

function getLumenBase() {
  return (process.env.LUMEN_API_BASE_URL || process.env.SPARK_API_BASE_URL || "").replace(/\/+$/, "");
}

function getAuthHeader(req) {
  return (
    req?.headers?.authorization ||
    req?.headers?.Authorization ||
    null
  );
}

function getTenantIdFromReq(req) {
  return (
    req?.tenant?.tenantId ||
    req?.headers?.["x-tenant-id"] ||
    req?.headers?.["x-tenant-key"] ||
    null
  );
}

async function postByKind({ tenantId, kind, authHeader, timeoutMs }) {
  if (!kind) return { ok: false, reason: "missing_kind" };
  const base = getLumenBase();
  if (!base) return { ok: false, reason: "lumen_base_not_configured" };
  if (!tenantId) return { ok: false, reason: "missing_tenant_id" };

  const url = `${base}/api/v1/walkthrough/tasks/by-kind/${encodeURIComponent(kind)}/complete`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
        "x-tenant-id": tenantId,
      },
      body: "{}",
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[walkthrough] by-kind/${kind} returned ${res.status} for tenant=${tenantId}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    let body = null;
    try { body = await res.json(); } catch { /* ignore */ }
    const data = body?.data || {};
    return { ok: true, completed: data.completed ?? 0, matched: data.matched ?? 0 };
  } catch (err) {
    console.warn(`[walkthrough] by-kind/${kind} failed for tenant=${tenantId}:`, err?.message || err);
    return { ok: false, reason: err?.name === "AbortError" ? "timeout" : "fetch_error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tenant-scoped form — lifts tenant id and Authorization from the inbound
 * Express request. Use from routes where the tenant middleware has populated
 * req.tenant.
 *
 * @param {import('express').Request} req
 * @param {string} kind
 * @param {object} [opts]
 * @returns {Promise<{ ok: boolean, completed?: number, matched?: number, reason?: string }>}
 */
export async function completeWalkthroughTaskByKind(req, kind, opts = {}) {
  return postByKind({
    tenantId: getTenantIdFromReq(req),
    kind,
    authHeader: getAuthHeader(req),
    timeoutMs: opts.timeoutMs,
  });
}

/**
 * Explicit-tenant form — for the Google OAuth callback (and other
 * unauthenticated endpoints) where the tenant id is decoded from state
 * rather than middleware-populated. The LUMEN-API endpoint accepts
 * x-tenant-id without a bearer for service-to-service calls.
 *
 * NOTE: today LUMEN-API's /walkthrough/tasks/by-kind requires authVerify().
 * If no bearer is available the call will 401 and be silently swallowed —
 * acceptable for "best effort" semantics. A follow-up should add an
 * internal/service-token path so the OAuth callback can fire reliably.
 *
 * @param {string} tenantId
 * @param {string} kind
 * @param {object} [opts]
 * @param {string} [opts.authHeader] - optional bearer to forward
 * @returns {Promise<{ ok: boolean, completed?: number, matched?: number, reason?: string }>}
 */
export async function completeWalkthroughTaskByKindFor(tenantId, kind, opts = {}) {
  return postByKind({
    tenantId,
    kind,
    authHeader: opts.authHeader || null,
    timeoutMs: opts.timeoutMs,
  });
}

// ─── SEED ENDPOINT (Batch 16, 2026-06-21) ─────────────────────────────────
//
// Fire-and-forget POST to LUMEN-API to seed the default walkthrough task
// list for a newly-created ARION tenant. Called from the Stripe webhook
// handler in routes/onboarding/webhook.js AFTER core.tenants + arion.tenant
// rows commit, so the very first time the buyer signs into the Portal the
// walkthrough panel already has their personalised "do your first X" list.
//
// AUTH MODEL: the webhook runs without a user bearer, so this helper hits
// LUMEN-API's `/api/v1/internal/walkthrough/seed/:tenantId` route with the
// shared-secret `x-internal-token` header. Set on the arion-api app via
// env `LUMEN_WALKTHROUGH_SEED_TOKEN` (same value as the one on LUMEN-API).
//
// FEATURE FLAG: set env `WALKTHROUGH_AUTO_SEED_DISABLED=1` to suppress all
// outbound seeds in an emergency. Tenant-create itself is unaffected.
//
// CONTRACT: NEVER throws. Idempotent on the LUMEN side.

/**
 * @param {object} opts
 * @param {string} opts.tenantId
 * @param {string[]} [opts.products] - lowercase product keys; default ["arion"]
 *        (the arion-api webhook only fires for ARION purchases).
 * @param {string|null} [opts.tier]
 * @param {string|null} [opts.userId]
 * @param {string} [opts.triggeredBy='arion_webhook']
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ ok: boolean, inserted?: number, skipped?: number, kinds?: string[], reason?: string }>}
 */
export async function seedDefaultTasksForTenant(opts = {}) {
  const {
    tenantId,
    products = ["arion"],
    tier = null,
    userId = null,
    triggeredBy = "arion_webhook",
    timeoutMs,
  } = opts;

  if (!tenantId) return { ok: false, reason: "missing_tenant_id" };

  if (String(process.env.WALKTHROUGH_AUTO_SEED_DISABLED || "").toLowerCase() === "1"
      || String(process.env.WALKTHROUGH_AUTO_SEED_DISABLED || "").toLowerCase() === "true") {
    console.log(`[walkthrough] auto-seed disabled via WALKTHROUGH_AUTO_SEED_DISABLED — skipping tenant=${tenantId}`);
    return { ok: false, reason: "auto_seed_disabled" };
  }

  const base = getLumenBase();
  if (!base) {
    console.warn(`[walkthrough] LUMEN_API_BASE_URL not set — cannot seed walkthrough tasks for tenant=${tenantId}`);
    return { ok: false, reason: "lumen_base_not_configured" };
  }

  const internalToken = process.env.LUMEN_WALKTHROUGH_SEED_TOKEN || process.env.WALKTHROUGH_SEED_INTERNAL_TOKEN || "";
  if (!internalToken) {
    console.warn(`[walkthrough] LUMEN_WALKTHROUGH_SEED_TOKEN not set — skipping seed for tenant=${tenantId}`);
    return { ok: false, reason: "no_internal_token" };
  }

  const url = `${base}/api/v1/internal/walkthrough/seed/${encodeURIComponent(tenantId)}`;
  const body = JSON.stringify({
    products: Array.from(new Set((products || []).map((p) => String(p || "").toLowerCase()).filter(Boolean))),
    tier: tier ? String(tier) : null,
    user_id: userId,
    triggered_by: triggeredBy,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": internalToken,
      },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let detail = "";
      try { detail = (await res.text()).slice(0, 500); } catch { /* ignore */ }
      console.warn(`[walkthrough] seed returned ${res.status} for tenant=${tenantId}: ${detail}`);
      return { ok: false, reason: `http_${res.status}` };
    }
    let parsed = null;
    try { parsed = await res.json(); } catch { /* ignore */ }
    const data = parsed?.data || {};
    console.log(
      `[walkthrough] seeded tenant=${tenantId} inserted=${data.inserted ?? 0} ` +
      `skipped=${data.skipped ?? 0} kinds=${(data.kinds || []).join(",")}`
    );
    return {
      ok: true,
      inserted: data.inserted ?? 0,
      skipped: data.skipped ?? 0,
      kinds: data.kinds || [],
    };
  } catch (err) {
    console.warn(`[walkthrough] seed failed for tenant=${tenantId}:`, err?.message || err);
    return { ok: false, reason: err?.name === "AbortError" ? "timeout" : "fetch_error" };
  } finally {
    clearTimeout(timer);
  }
}
