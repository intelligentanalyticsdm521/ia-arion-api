/**
 * Email templates for the onboarding lifecycle.
 *
 * Each template returns { subject, html } ready to pass to sendEmail().
 * Plain-text fallback is auto-derived in lib/email.js.
 *
 * Style guide:
 *   - System fonts only (Postmark renders these well across clients)
 *   - Inline CSS (Gmail strips <style> blocks for promotional/transactional)
 *   - Single primary CTA per email
 *   - No images required (some clients block by default)
 *   - Brand color #EF6C33 for CTAs
 */

const BRAND_NAME = 'Intelligent Analytics';
const BRAND_COLOR = '#EF6C33';
const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.intelligentanalyticsdm.com';

const baseStyles = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  color: #111827;
  line-height: 1.55;
`;

const wrap = (innerHtml) => `
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F9FAFB;padding:32px 0;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:32px;${baseStyles}">
      ${innerHtml}
      <tr><td style="padding-top:32px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">
        ${BRAND_NAME} · <a href="${PORTAL_URL}" style="color:#6b7280;">portal</a> · This is a transactional message about your account.
      </td></tr>
    </table>
  </td></tr>
</table>
`;

const button = (href, label) => `
  <a href="${href}" style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">${label}</a>
`;

// ---------------------------------------------------------------------------
// 1. Welcome email — fired immediately after Stripe checkout success
// ---------------------------------------------------------------------------
export function welcomeEmail({ firstName, planName, billingCycle }) {
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : 'Welcome!';
  const cycleNote = billingCycle === 'annual' ? ' (billed annually)' : ' (billed monthly)';
  return {
    subject: `Welcome to ${BRAND_NAME} — let's build your site`,
    html: wrap(`
      <tr><td>
        <h1 style="margin:0 0 16px;font-size:22px;">${greeting}</h1>
        <p style="margin:0 0 16px;">Thanks for joining ${BRAND_NAME}. Your <strong>${escapeHtml(planName)}</strong> plan${cycleNote} is active and we're ready to build your website.</p>
        <p style="margin:0 0 24px;">Next, head back to the portal to choose your domain and answer a few questions about your business. The whole thing takes about 5 minutes — then we'll handle the rest.</p>
        <p style="margin:0 0 24px;">${button(`${PORTAL_URL}/signup/onboarding`, 'Continue setup →')}</p>
        <p style="margin:0;font-size:14px;color:#6b7280;">Questions? Just reply to this email.</p>
      </td></tr>
    `),
  };
}

// ---------------------------------------------------------------------------
// 2. Site-ready email — fired when IA Plugin reports successful bootstrap
// ---------------------------------------------------------------------------
export function siteReadyEmail({ firstName, domain, wpLoginUrl, portalUrl, partial = false }) {
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi there,';
  const headline = partial
    ? 'Your site is live (with a couple things to check)'
    : '🎉 Your site is live!';
  const partialNote = partial
    ? `<p style="margin:0 0 16px;color:#92400e;background:#fef3c7;padding:12px;border-radius:6px;">A few configuration steps need attention. We'll reach out within an hour with details.</p>`
    : '';
  return {
    subject: partial
      ? `${BRAND_NAME}: your site is live (action items inside)`
      : `${BRAND_NAME}: your site at ${domain} is live!`,
    html: wrap(`
      <tr><td>
        <h1 style="margin:0 0 16px;font-size:22px;">${headline}</h1>
        <p style="margin:0 0 8px;${greeting === 'Hi there,' ? '' : ''}">${greeting}</p>
        <p style="margin:0 0 16px;">Your website at <strong><a href="https://${escapeHtml(domain)}" style="color:${BRAND_COLOR};">${escapeHtml(domain)}</a></strong> is now live. The AI generated your initial pages, branding, and content — feel free to log in and customize.</p>
        ${partialNote}
        <p style="margin:0 0 12px;"><strong>Two ways to get started:</strong></p>
        <p style="margin:0 0 16px;">${button(portalUrl || `${PORTAL_URL}/app/overview`, 'Open your dashboard')}</p>
        <p style="margin:0 0 16px;font-size:14px;">Or log into WordPress directly to edit pages: <a href="${escapeHtml(wpLoginUrl)}" style="color:${BRAND_COLOR};">${escapeHtml(wpLoginUrl)}</a></p>
        <p style="margin:24px 0 0;font-size:14px;color:#6b7280;">A separate email will follow shortly with your portal login credentials.</p>
      </td></tr>
    `),
  };
}

// ---------------------------------------------------------------------------
// 3. Payment failed — fired by Stripe webhook on invoice.payment_failed
// ---------------------------------------------------------------------------
export function paymentFailedEmail({ firstName, amountUsd, updatePaymentUrl }) {
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi there,';
  return {
    subject: `${BRAND_NAME}: action required — payment failed`,
    html: wrap(`
      <tr><td>
        <h1 style="margin:0 0 16px;font-size:22px;">Your payment didn't go through</h1>
        <p style="margin:0 0 16px;">${greeting}</p>
        <p style="margin:0 0 16px;">We weren't able to charge your card for this billing cycle${amountUsd ? ` ($${amountUsd.toFixed(2)})` : ''}. To keep your service active, please update your payment method.</p>
        <p style="margin:0 0 24px;">${button(updatePaymentUrl || `${PORTAL_URL}/app/settings?tab=billing`, 'Update payment method')}</p>
        <p style="margin:0;font-size:14px;color:#6b7280;">If we can't collect within 5 days, your site will be paused until billing is restored. Reply to this email if you need help.</p>
      </td></tr>
    `),
  };
}

// ---------------------------------------------------------------------------
// 4. BYOD propagation reminder — sent if DNS hasn't propagated after 1hr
// ---------------------------------------------------------------------------
export function byodPendingEmail({ firstName, domain }) {
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi there,';
  return {
    subject: `${BRAND_NAME}: still waiting on your domain's nameservers`,
    html: wrap(`
      <tr><td>
        <h1 style="margin:0 0 16px;font-size:22px;">Your domain isn't pointing to us yet</h1>
        <p style="margin:0 0 16px;">${greeting}</p>
        <p style="margin:0 0 16px;">We're ready to build your site at <strong>${escapeHtml(domain)}</strong>, but the domain's nameservers haven't been updated yet. DNS changes can take anywhere from 30 minutes to 24 hours to propagate.</p>
        <p style="margin:0 0 16px;">If you've already updated them, no action needed — we'll keep checking and start automatically. If you haven't yet, here's what to do:</p>
        <ol style="margin:0 0 24px;padding-left:20px;">
          <li>Sign in to wherever you registered <strong>${escapeHtml(domain)}</strong> (GoDaddy, Namecheap, etc.)</li>
          <li>Find the "Nameservers" or "DNS" setting</li>
          <li>Replace the existing nameservers with: <code>ns1.dns-parking.com</code> and <code>ns2.dns-parking.com</code></li>
        </ol>
        <p style="margin:0;font-size:14px;color:#6b7280;">Stuck? Reply to this email and we'll help.</p>
      </td></tr>
    `),
  };
}

// ---------------------------------------------------------------------------
// 5. Portal account created — sent when Entra user is invited
// ---------------------------------------------------------------------------
export function portalAccountInviteEmail({ firstName, email, inviteRedeemUrl }) {
  const greeting = firstName ? `Hi ${escapeHtml(firstName)},` : 'Hi there,';
  return {
    subject: `${BRAND_NAME}: set up your portal account`,
    html: wrap(`
      <tr><td>
        <h1 style="margin:0 0 16px;font-size:22px;">One more click to access your dashboard</h1>
        <p style="margin:0 0 16px;">${greeting}</p>
        <p style="margin:0 0 16px;">Your ${BRAND_NAME} account has been created for <strong>${escapeHtml(email)}</strong>. Click below to set your password and sign into your dashboard.</p>
        <p style="margin:0 0 24px;">${button(inviteRedeemUrl, 'Set up account →')}</p>
        <p style="margin:0;font-size:14px;color:#6b7280;">This link expires in 7 days. If it expires, just visit ${PORTAL_URL} and click "Forgot password".</p>
      </td></tr>
    `),
  };
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
