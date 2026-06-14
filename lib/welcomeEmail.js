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
 * Best-effort: a failed send does NOT block the orchestrator. The site is
 * already live; the customer can be re-emailed manually if needed. We log
 * the result so ops can re-trigger.
 */

import { sendEmail } from './email.js';
import { webcrypto as crypto } from 'node:crypto';

const PORTAL_BASE = (process.env.PORTAL_BASE_URL
  || 'https://portal.intelligentanalyticsdm.com').replace(/\/+$/, '');

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
 * this on arion.signup_session.welcome_token so platform-api can validate.
 */
export function generateSetupToken() {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Buffer.from(buf).toString('base64url');
}

/**
 * Send the "your site is ready" + CIAM activation email.
 *
 * @param {object} args
 * @param {string} args.toEmail
 * @param {string} args.firstName       - falls back to "there"
 * @param {string} args.brandName       - business name from questionnaire
 * @param {string} args.tenantId
 * @param {string} args.wpAdminUrl      - e.g. https://example.com/wp-admin/
 * @param {string} args.wpAdminLogin
 * @param {string} args.wpAdminPassword
 * @param {string} args.setupToken      - opaque token; portal verifies via platform-api
 * @returns {Promise<{ok: boolean, message_id?: string, error?: string}>}
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
}) {
  const safeFirstName = (firstName || '').trim() || 'there';
  const activationUrl = buildActivationUrl({ email: toEmail, setupToken, tenantId });

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #1A3A4A; max-width: 600px; margin: 0 auto; padding: 24px;">
      <h1 style="color: #1A3A4A; font-size: 24px; margin-bottom: 8px;">Your ${escapeHtml(brandName)} site is live, ${escapeHtml(safeFirstName)}.</h1>
      <p style="font-size: 16px; line-height: 1.5;">
        Two quick steps to wrap up onboarding:
      </p>

      <h2 style="font-size: 18px; color: #1A3A4A; margin-top: 24px;">1. Activate your IADM customer portal account</h2>
      <p style="font-size: 15px; line-height: 1.5;">
        This is where you'll see your SEO data, manage your subscription, and submit support requests. Click below to set your password:
      </p>
      <p style="margin: 16px 0;">
        <a href="${escapeAttr(activationUrl)}" style="display: inline-block; background: #FEC82C; color: #1A3A4A; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-weight: 600;">
          Activate my account
        </a>
      </p>
      <p style="font-size: 13px; color: #6B7280;">If the button doesn't work, paste this URL into your browser:<br>${escapeHtml(activationUrl)}</p>

      <h2 style="font-size: 18px; color: #1A3A4A; margin-top: 32px;">2. Log in to your WordPress site (optional)</h2>
      <p style="font-size: 15px; line-height: 1.5;">
        Your site editor is here. You can review the auto-generated content and tweak anything you want:
      </p>
      <table style="font-size: 14px; line-height: 1.6; background: #F9FAFB; border-radius: 8px; padding: 16px; width: 100%;">
        <tr><td style="padding: 4px 8px;"><strong>WP admin:</strong></td><td style="padding: 4px 8px;"><a href="${escapeAttr(wpAdminUrl)}">${escapeHtml(wpAdminUrl)}</a></td></tr>
        <tr><td style="padding: 4px 8px;"><strong>Username:</strong></td><td style="padding: 4px 8px;"><code>${escapeHtml(wpAdminLogin)}</code></td></tr>
        <tr><td style="padding: 4px 8px;"><strong>Password:</strong></td><td style="padding: 4px 8px;"><code>${escapeHtml(wpAdminPassword)}</code></td></tr>
      </table>
      <p style="font-size: 13px; color: #6B7280; margin-top: 12px;">
        Change the password after your first login (Users → Profile in WP admin).
      </p>

      <p style="font-size: 14px; color: #6B7280; margin-top: 32px;">
        Questions? Just reply to this email — it routes straight to the team.<br>
        — Intelligent Analytics DM
      </p>
    </div>
  `.trim();

  const text = [
    `Your ${brandName} site is live, ${safeFirstName}.`,
    '',
    'Two quick steps to wrap up onboarding:',
    '',
    '1. Activate your IADM customer portal account:',
    `   ${activationUrl}`,
    '',
    '2. Log in to your WordPress site (optional):',
    `   WP admin: ${wpAdminUrl}`,
    `   Username: ${wpAdminLogin}`,
    `   Password: ${wpAdminPassword}`,
    '',
    'Change the password after your first login (Users → Profile in WP admin).',
    '',
    'Questions? Just reply — it routes straight to the team.',
    '— Intelligent Analytics DM',
  ].join('\n');

  return sendEmail({
    to: toEmail,
    subject: `${brandName} — your site is ready. Activate your portal.`,
    html,
    text,
    tag: 'onboarding-welcome',
    metadata: { tenant_id: tenantId },
  });
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}

export default { sendOnboardingWelcomeEmail, generateSetupToken, buildActivationUrl };
