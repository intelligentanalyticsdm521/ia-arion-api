/**
 * Onboarding "Your site is ready" welcome email.
 * --------------------------------------------------------------------------
 * Sent at the end of /onboarding/submit success. Delivers:
 *   - the customer's WP admin URL + login + temporary password (so they can
 *     log in to their WP site immediately)
 *   - a link to portal.intelligentanalyticsdm.com to activate the IADM
 *     customer portal account via the shared CIAM (Entra External ID)
 *
 * The shared CIAM signup is invoked by URL — we pass the email + a setup
 * token so the portal /welcome route can finish linking the tenant when
 * the user clicks through. The setup token is stored on arion.signup_session
 * (column added in this migration) so the Portal can exchange it via
 * platform-api `/api/v1/onboarding/activate`.
 *
 * --------------------------------------------------------------------------
 * ROUTING (2026-06-24): hardcoded HTML templates were deleted. All welcome
 * emails now route through LUMEN-API's templated email pipeline so SPARK
 * owns the body copy + merge-tag resolution + sending. arion-api supplies:
 *   - the template key (client-onboard vs self-onboard)
 *   - tenant id (for per-tenant template overrides + audit)
 *   - recipient email
 *   - context payload (first name, business name, activation URL, etc.)
 * LUMEN-API resolves the template, renders the body, sends via SPARK, and
 * returns { campaign_id, message_id }.
 *
 * Internal auth: shared-secret `x-internal-token` header. Same pattern as
 * walkthroughClient.js seed call. Env var: LUMEN_EMAIL_INTERNAL_TOKEN
 * (falls back to LUMEN_WALKTHROUGH_SEED_TOKEN for bootstrap so the rollout
 * can ship before a separate KV secret is provisioned).
 *
 * On LUMEN-API failure we surface the error to the caller (no silent
 * Postmark fallback — Postmark has been removed from this path entirely).
 */

import { webcrypto as crypto } from 'node:crypto';

const PORTAL_BASE = (process.env.PORTAL_BASE_URL
  || 'https://portal.intelligentanalyticsdm.com').replace(/\/+$/, '');

const DEFAULT_TIMEOUT_MS = 10_000;

// 2026-06-27 — Bug B fix. The welcome email is IA sending to a new IA
// customer, regardless of whether onboarding flowed through Path A
// (self-serve checkout) or Path B (founder wizard). The LUMEN-API
// campaign / recipient / event rows must land in IA's SPARK history
// (NOT the client tenant's). Previously this helper passed the CLIENT
// tenantId through, which wrote campaigns into the client's SPARK.
const FOUNDER_TENANT_ID = (process.env.FOUNDER_TENANT_ID
  || '8C9527B9-8999-4B31-A306-F3D4CCC39FBD').toUpperCase();

// Template keys live in lumen.email_template (LUMEN-API migration 005+).
// These are the canonical onboarding welcome templates the Portal admin
// can edit under SPARK > Templates > System.
export const TEMPLATE_KEY_CLIENT_ONBOARD = 'welcome_email_client_onboard';
export const TEMPLATE_KEY_SELF_ONBOARD   = 'welcome_email_self_onboard';

function getLumenBase() {
  return (process.env.LUMEN_API_BASE_URL
    || process.env.SPARK_API_BASE_URL
    || '').replace(/\/+$/, '');
}

function getInternalToken() {
  // Prefer a dedicated email-internal token; fall back to the walkthrough
  // seed token so the first deploy doesn't need a separate KV provision.
  return process.env.LUMEN_EMAIL_INTERNAL_TOKEN
    || process.env.LUMEN_WALKTHROUGH_SEED_TOKEN
    || process.env.WALKTHROUGH_SEED_INTERNAL_TOKEN
    || '';
}

/**
 * Build the activation URL the customer clicks from the email.
 */
export function buildActivationUrl({ email, setupToken, tenantId }) {
  const params = new URLSearchParams({
    email,
    setup_token: setupToken,
    tenant_id: tenantId,
  });
  return `${PORTAL_BASE}/welcome?${params.toString()}`;
}

/**
 * Generate a one-time setup token (32-byte URL-safe base64). Caller persists
 * the SHA-256 hash on arion.signup_session.welcome_token (F-SEC1.1 / .3) so
 * platform-api can validate the inbound plaintext token via constant-time
 * hash compare. 72h TTL is enforced at the read side.
 */
export function generateSetupToken() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString('base64url');
}

/**
 * Send the "your site is ready" + CIAM activation email via LUMEN-API.
 *
 * @param {object} args
 * @param {string} args.toEmail                  - recipient email address
 * @param {string} args.firstName                - falls back to "there"
 * @param {string} args.brandName                - business name from questionnaire
 * @param {string} args.tenantId                 - core tenant id
 * @param {string} [args.wpAdminUrl]             - e.g. https://example.com/wp-admin/
 * @param {string} [args.wpAdminLogin]
 * @param {string} [args.wpAdminPassword]
 * @param {string} args.setupToken               - plaintext one-time token
 * @param {string} [args.iaPluginDownloadUrl]    - manual install fallback URL
 * @param {boolean} [args.existingWebsite=false] - true for BYO-WP onboarding
 * @param {('client_onboard'|'self_onboard')} [args.path='client_onboard']
 *   - which template family to use. 'client_onboard' = founder wizard or
 *     migration script; 'self_onboard' = post-checkout self-serve flow.
 * @param {string[]} [args.productList]          - product slugs the buyer just
 *   purchased (e.g. ['arion','oliver']); rendered in self-onboard welcome.
 * @param {string} [args.onboardingLink]         - deep link to the post-CIAM
 *   orientation page for self-onboard flow.
 * @param {object} [args.extraContext]           - additional merge-tag vars
 *   to forward to LUMEN-API for template rendering.
 * @param {number} [args.timeoutMs]              - per-request timeout override
 * @returns {Promise<{
 *   ok: boolean,
 *   campaign_id?: string,
 *   message_id?: string,
 *   template_key?: string,
 *   error?: string,
 *   status?: number,
 * }>}
 */
export async function sendOnboardingWelcomeEmail({
  toEmail,
  firstName,
  brandName,
  tenantId,
  wpAdminUrl,
  wpAdminLogin,
  wpAdminPassword,
  setupToken,
  iaPluginDownloadUrl = null,
  existingWebsite = false,
  path = 'client_onboard',
  productList,
  onboardingLink,
  extraContext,
  timeoutMs,
}) {
  if (!toEmail) return { ok: false, error: 'missing_recipient_email' };
  if (!tenantId) return { ok: false, error: 'missing_tenant_id' };
  // setupToken is required for client-onboard (post-provisioning email needs
  // a CIAM activation URL). It's optional for self-onboard (the post-Stripe
  // welcome happens before the customer ever sees CIAM — they get the
  // activation URL later, from the post-provisioning email).
  if (!setupToken && path !== 'self_onboard') {
    return { ok: false, error: 'missing_setup_token' };
  }

  const base = getLumenBase();
  if (!base) {
    return { ok: false, error: 'lumen_api_base_url_not_configured' };
  }
  const internalToken = getInternalToken();
  if (!internalToken) {
    return { ok: false, error: 'lumen_email_internal_token_not_configured' };
  }

  const safeFirstName = (firstName || '').trim() || 'there';
  const welcomeLink = setupToken
    ? buildActivationUrl({ email: toEmail, setupToken, tenantId })
    : null;

  // Path-based template selection. 'self_onboard' is for the Stripe-checkout
  // self-serve buyer; everything else (founder wizard, migration script,
  // existing-website admin onboard) is 'client_onboard'.
  const templateKey = path === 'self_onboard'
    ? TEMPLATE_KEY_SELF_ONBOARD
    : TEMPLATE_KEY_CLIENT_ONBOARD;

  // Context for LUMEN-API's mergeTagCatalog resolver. Templates use
  // user-friendly tags ({{first name}}, {{business name}}, {{welcome link}})
  // which the catalog maps to schema dot-paths (contact.first_name,
  // tenant.business_name, vars.welcome_link). Must be NESTED — previously this
  // helper sent flat snake_case (first_name, business_name) which never
  // resolved, so every welcome email rendered "Hi there" with a blank
  // business name and no activation link. Fixed 2026-06-27 alongside the
  // Bug B tenant-routing fix.
  const context = {
    contact: {
      first_name: safeFirstName,
      full_name:  safeFirstName,
      email:      toEmail,
    },
    tenant: {
      business_name: brandName || '',
    },
    vars: {
      welcome_link:    welcomeLink,
      onboarding_link: onboardingLink || null,
      product_list:    Array.isArray(productList) ? productList : undefined,
    },
    // Flat snake_case aliases preserved for any non-template consumer that
    // reads them directly (no template uses these, but keep for back-compat).
    first_name:        safeFirstName,
    business_name:     brandName || '',
    welcome_link:      welcomeLink,
    activation_link:   welcomeLink,
    existing_website:  Boolean(existingWebsite),
    wp_admin_url:      wpAdminUrl || null,
    wp_admin_login:    wpAdminLogin || null,
    wp_admin_password: wpAdminPassword || null,
    ia_plugin_download_url: iaPluginDownloadUrl || null,
    product_list:      Array.isArray(productList) ? productList : undefined,
    onboarding_link:   onboardingLink || undefined,
    ...(extraContext && typeof extraContext === 'object' ? extraContext : {}),
  };

  // Bug B fix (2026-06-27): SPARK pipeline routing always uses IA tenant id.
  // The CLIENT tenant id continues to flow through `context.client_tenant_id`
  // for templates that want to reference it (e.g. activation URL already
  // carries it explicitly).
  const url = `${base}/api/v1/internal/email/send-by-template-key`;
  const sparkSenderTenantId = FOUNDER_TENANT_ID;
  const enrichedContext = {
    ...context,
    client_tenant_id: tenantId,
  };
  const body = JSON.stringify({
    tenantId: sparkSenderTenantId,
    templateKey,
    recipientEmail: toEmail,
    context: enrichedContext,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'Accept':          'application/json',
        'x-internal-token': internalToken,
        'x-tenant-id':     sparkSenderTenantId,
      },
      body,
      signal: ctrl.signal,
    });

    let parsed = null;
    try { parsed = await res.json(); } catch { /* tolerate empty body */ }

    if (!res.ok) {
      const errMsg = parsed?.error
        || parsed?.message
        || `lumen_api_http_${res.status}`;
      console.error(
        `[welcomeEmail] LUMEN-API send-by-template-key ${res.status} ` +
        `tenant=${tenantId} template=${templateKey}: ${String(errMsg).slice(0, 300)}`
      );
      return {
        ok: false,
        error: String(errMsg).slice(0, 300),
        status: res.status,
        template_key: templateKey,
      };
    }

    const data = parsed?.data || parsed || {};
    return {
      ok: true,
      campaign_id:  data.campaign_id || data.campaignId || null,
      message_id:   data.message_id || data.messageId || null,
      template_key: templateKey,
    };
  } catch (err) {
    const reason = err?.name === 'AbortError' ? 'timeout' : (err?.message || 'fetch_error');
    console.error(
      `[welcomeEmail] LUMEN-API send-by-template-key failed ` +
      `tenant=${tenantId} template=${templateKey}: ${reason}`
    );
    return { ok: false, error: reason, template_key: templateKey };
  } finally {
    clearTimeout(timer);
  }
}

export default { sendOnboardingWelcomeEmail, generateSetupToken, buildActivationUrl };
