/**
 * coreTenants.js — platform-DB (iadm_platform) core.tenants lookup-or-mint.
 *
 * WHY THIS EXISTS
 * --------------------------------------------------------------------------
 * The ARION self-serve Stripe webhook used to mint a brand new
 * `crypto.randomUUID()` for the buyer and INSERT it into `arion.tenant` +
 * `arion.site` only — never touching `core.tenants` in the platform DB.
 *
 * When the same buyer later signed into the Portal, `oliver-api`'s
 * `/signup/complete` would call `core.sp_create_tenant` which mints a
 * DIFFERENT tenant_id and writes it to `core.tenants`. The Portal/middleware
 * resolves `req.tenant.tenantId` from `core.tenants` (see
 * `arion-api/middleware/tenantResolution.js`). The dashboard then queries
 * `arion.site WHERE tenant_id = @core.tenants.tenant_id` and gets 0 rows.
 * The buyer sees "no site connected" while the orphaned `arion.site` row
 * sits unreachable. Diagnosed in a multi-agent workflow 2026-06-20.
 *
 * THE FIX (this module)
 * --------------------------------------------------------------------------
 * Before stamping anything into arion.*, the webhook calls
 * `resolveTenantForBuyer({email, name})` which:
 *   1. Looks up an existing core.tenants row by buyer email — via direct
 *      `primary_contact_email` match OR via `core.users.email → core.tenant_users`
 *      join (mirrors `routes/admin/onboardExisting.js` which is the working
 *      founder-side analog of the same lookup).
 *   2. If a row exists, returns THAT tenant_id (binds arion.* to the
 *      canonical core.tenants record — fixes the orphan immediately).
 *   3. If no row exists, mints a fresh GUID AND inserts a minimal
 *      `core.tenants` row with that same GUID so any future call to
 *      `core.sp_create_tenant` / `oliver-api /signup/complete` etc. that
 *      tries to create a duplicate is a no-op (or, more importantly,
 *      `sp_create_tenant` is never called for this buyer — they use the
 *      ARION-specific signup path through `arion.signup_session`).
 *
 * Schema note: `core.tenants` lives in `iadm_platform`, NOT `iadm_services`
 * where the rest of `arion.*` lives. We use `getPlatformPool()` for it.
 * The required NOT NULL columns are `name` (varchar 100) and `slug`
 * (NVARCHAR 63 UNIQUE — added by platform-api migration 010). Slug
 * generation matches the helper in `routes/admin/onboardExisting.js`.
 */

import sql from 'mssql';
import crypto from 'node:crypto';
import { getPlatformPool } from '../db/platformPool.js';

/**
 * Find an existing core.tenants row for this buyer, or create one.
 *
 * @param {object} opts
 * @param {string} opts.email - buyer email (required)
 * @param {string} [opts.name] - business name candidate (falls back to email)
 * @param {string} [opts.tier] - subscription tier slug (default 'starter')
 * @param {string} [opts.product] - signup_product (default 'arion')
 * @param {string} [opts.billingCycle] - 'monthly' | 'annual' (default 'monthly')
 * @param {string} [opts.stripeCustomerId]
 * @param {string} [opts.stripeSubscriptionId]
 *
 * @returns {Promise<{tenantId:string, source:'existing'|'created'}>}
 */
export async function resolveTenantForBuyer({
  email,
  name,
  tier = 'starter',
  product = 'arion',
  billingCycle = 'monthly',
  stripeCustomerId = null,
  stripeSubscriptionId = null,
} = {}) {
  if (!email) throw new Error('resolveTenantForBuyer: email is required');
  const safeEmail = String(email).trim().toLowerCase();
  const safeName = String(name || '').trim() || safeEmail;

  const platformPool = await getPlatformPool();

  // 1) Look for an existing tenant via either path:
  //    (a) core.tenants.primary_contact_email direct match, OR
  //    (b) core.users.email → core.tenant_users → core.tenants join
  //   (mirrors onboardExisting.js domain-or-user lookup; we use email
  //    instead of domain because at Stripe-webhook time the buyer hasn't
  //    confirmed a domain yet)
  const hit = await platformPool.request()
    .input('email', sql.NVarChar(640), safeEmail)
    .query(`
      SELECT TOP 1 t.tenant_id
      FROM core.tenants t
      LEFT JOIN core.users u ON LOWER(u.email) = @email
      LEFT JOIN core.tenant_users tu ON tu.user_id = u.user_id AND tu.tenant_id = t.tenant_id
      WHERE LOWER(t.primary_contact_email) = @email
         OR tu.tenant_id IS NOT NULL
      ORDER BY t.created_at ASC
    `);

  if (hit.recordset.length > 0) {
    return { tenantId: hit.recordset[0].tenant_id, source: 'existing' };
  }

  // 2) No existing row — mint a GUID AND seed a minimal core.tenants row
  //    using that same GUID. This is the "structural orphan fix": from the
  //    moment arion.tenant/arion.site are written, the canonical
  //    core.tenants row that any future sign-in (and the
  //    tenantResolution middleware in particular) will use already points
  //    to the same tenant_id.
  const tenantId = crypto.randomUUID();
  const slug = await generateUniqueSlug(platformPool, safeName);

  await platformPool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('name', sql.NVarChar(100), safeName.slice(0, 100))
    .input('fullName', sql.NVarChar(200), safeName.slice(0, 200))
    .input('slug', sql.NVarChar(63), slug)
    .input('status', sql.NVarChar(20), 'pending_onboarding')
    .input('tier', sql.NVarChar(20), String(tier).slice(0, 20))
    .input('email', sql.NVarChar(640), safeEmail)
    .input('product', sql.NVarChar(20), String(product).slice(0, 20))
    .input('billing', sql.NVarChar(20), String(billingCycle).slice(0, 20))
    .input('cust', sql.NVarChar(100), stripeCustomerId || null)
    .input('sub', sql.NVarChar(100), stripeSubscriptionId || null)
    .query(`
      INSERT INTO core.tenants
        (tenant_id, name, full_name, slug, status, subscription_tier,
         primary_contact_email, signup_product, billing_cycle,
         saas_stripe_customer_id, saas_stripe_subscription_id)
      VALUES
        (@tid, @name, @fullName, @slug, @status, @tier,
         @email, @product, @billing, @cust, @sub)
    `);

  return { tenantId, source: 'created' };
}

// ─────────────────────────────────────────────────────────────────────────
// Enable a product service for a tenant in core.tenant_services (platform DB).
//
// Path A self-serve was missing this: the founder path (admin/onboardExisting.js
// step 4) inserts the core.tenant_services (arion, is_enabled=1) row, but the
// Stripe webhook + submit.js did not — so requireArionAccess hard-403'd every
// arion-api call and the buyer signed in but couldn't load site/SEO/analytics.
//
// Looks up service_id by service_key from core.services (never hardcode —
// convention_never_hardcode_service_ids), with the same historical UUID
// fallback onboardExisting.js uses so a missing core.services row still works.
// Idempotent (IF NOT EXISTS). Returns { enabled, reason }.
// ─────────────────────────────────────────────────────────────────────────
const HARDCODED_FALLBACK_SERVICE_IDS = Object.freeze({
  arion: '44444444-4444-4444-4444-444444444444',
});

export async function enableServiceForTenant(tenantId, serviceKey = 'arion') {
  if (!tenantId) return { enabled: false, reason: 'no_tenant_id' };
  const key = String(serviceKey).trim().toLowerCase();
  const platformPool = await getPlatformPool();

  let serviceId = null;
  try {
    const r = await platformPool.request()
      .input('key', sql.NVarChar(50), key)
      .query('SELECT TOP 1 service_id FROM core.services WHERE LOWER(service_key) = @key');
    serviceId = r.recordset[0]?.service_id || null;
  } catch (err) {
    console.warn(`[coreTenants] core.services lookup failed for '${key}':`, err.message);
  }
  if (!serviceId) {
    serviceId = HARDCODED_FALLBACK_SERVICE_IDS[key] || null;
    if (serviceId) {
      console.warn(`[coreTenants] core.services has no row for service_key='${key}' — falling back to hardcoded ${serviceId}`);
    } else {
      console.warn(`[coreTenants] no service_id for '${key}' and no fallback — cannot enable service for tenant ${tenantId}`);
      return { enabled: false, reason: 'no_service_id' };
    }
  }

  await platformPool.request()
    .input('tid', sql.UniqueIdentifier, tenantId)
    .input('sid', sql.UniqueIdentifier, serviceId)
    .query(`
      IF NOT EXISTS (SELECT 1 FROM core.tenant_services WHERE tenant_id = @tid AND service_id = @sid)
      INSERT INTO core.tenant_services (tenant_id, service_id, is_enabled) VALUES (@tid, @sid, 1)
    `);
  return { enabled: true, reason: 'ok', serviceId };
}

/**
 * Lowercase, hyphenated, 3-63 char slug for core.tenants.slug
 * (NOT NULL UNIQUE since platform-api migration 010). Loop on collision.
 * Mirrors `generateUniqueSlug` in routes/admin/onboardExisting.js so the
 * shape of slugs minted from either path is identical.
 */
async function generateUniqueSlug(pool, name) {
  let base = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  if (base.length < 3) base = 'tenant-' + crypto.randomUUID().slice(0, 6);
  let candidate = base;
  let n = 2;
  while (true) {
    const hit = await pool.request()
      .input('slug', sql.NVarChar(63), candidate)
      .query('SELECT 1 AS h FROM core.tenants WHERE slug = @slug');
    if (hit.recordset.length === 0) return candidate;
    candidate = `${base}-${n}`.slice(0, 63);
    n++;
    if (n > 100) return `${base}-${crypto.randomUUID().slice(0, 6)}`.slice(0, 63);
  }
}
