/**
 * Transactional email — Postmark client.
 * --------------------------------------------------------------------------
 * Postmark chosen for reliability + deliverability on transactional flows
 * (signup confirmations, site-ready notifications, payment-failure dunning).
 * Switching providers later is a one-file change since this module is the
 * only thing that imports the SDK.
 *
 * The module is best-effort — a failed email never blocks the caller. We
 * log + swallow errors and rely on Postmark's retries for transient failures.
 *
 * Env vars:
 *   POSTMARK_SERVER_TOKEN     - per-server API token
 *   POSTMARK_FROM_ADDRESS     - sender (e.g. "Intelligent Analytics <hello@iadm.com>")
 *   POSTMARK_REPLY_TO         - reply-to override (optional)
 *   POSTMARK_MESSAGE_STREAM   - "outbound" (default) or a custom stream
 */

const POSTMARK_API_BASE = 'https://api.postmarkapp.com';

/**
 * Send a transactional email.
 *
 * @param {object} args
 * @param {string} args.to            - recipient email
 * @param {string} args.subject
 * @param {string} args.html          - HTML body
 * @param {string} [args.text]        - plain-text fallback (auto-derived if absent)
 * @param {string} [args.tag]         - Postmark tag for analytics (e.g. "site-ready")
 * @param {object} [args.metadata]    - tracking metadata (tenant_id, site_id, etc.)
 * @returns {Promise<{ok: boolean, message_id?: string, error?: string}>}
 */
export async function sendEmail({ to, subject, html, text, tag, metadata }) {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  const from = process.env.POSTMARK_FROM_ADDRESS;
  if (!token || !from) {
    console.warn('[email] POSTMARK_SERVER_TOKEN or POSTMARK_FROM_ADDRESS not set — skipping send');
    return { ok: false, error: 'not_configured' };
  }
  if (!to || !subject || !html) {
    return { ok: false, error: 'missing_required_fields' };
  }

  const payload = {
    From: from,
    To: to,
    Subject: subject,
    HtmlBody: html,
    TextBody: text || htmlToText(html),
    MessageStream: process.env.POSTMARK_MESSAGE_STREAM || 'outbound',
    TrackOpens: true,
    TrackLinks: 'HtmlOnly',
  };
  if (process.env.POSTMARK_REPLY_TO) payload.ReplyTo = process.env.POSTMARK_REPLY_TO;
  if (tag) payload.Tag = tag;
  if (metadata) payload.Metadata = metadata;

  try {
    const res = await fetch(`${POSTMARK_API_BASE}/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Postmark-Server-Token': token,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[email] postmark ${res.status}:`, data);
      return { ok: false, error: data?.Message || `HTTP ${res.status}` };
    }
    return { ok: true, message_id: data?.MessageID };
  } catch (err) {
    console.error('[email] send failed:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Naive HTML → text fallback. Strips tags + collapses whitespace. Good enough
 * for transactional templates we control.
 */
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
