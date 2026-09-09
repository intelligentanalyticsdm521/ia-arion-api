// lib/contentAgent/alerts.js
//
// Where the agent's alerts actually GO.
//
// The pipeline has always produced alerts — F3 escalation, F5 publish failure,
// F7 render failure, F8 cost halt, MARGIN breach — and until this file they went
// into a JSON summary that only the Function App's log stream ever read. Scope
// 30.2 says "escalation notifies immediately, not batched" and F5 says "alert
// Brandon"; a log line in an Azure blob is not an alert. So the summary keeps
// its alerts (they are the machine-readable record) and this module is the part
// that tells a human.
//
// TWO SEAMS, AND NEITHER OF THEM IS REIMPLEMENTED HERE
//
//   THE GATE     Every message asks platform-api's ONE preference gate first
//                (lib/notificationGate.js → POST /internal/notify/can-send),
//                with a category_key. No category, no send: the gate treats an
//                unknown key as unknown and the platform's canonical vocabulary
//                is a closed list. These alerts address the BUSINESS OWNER, so
//                the category is `owner_alerts` — the one canonical key that is
//                deliberately not customer-facing.
//
//   THE NAME     Every business name comes from platform-api's ONE business
//                identity (lib/businessIdentityClient.js). Never
//                `tenant.name || tenant.domain || tenantId`, never a literal:
//                the twelve-chain defect the pre-walk passes spent two days
//                deleting. A subject line that says "Fernbrook Garden Rooms"
//                for Summit Lawn is the same bug wearing an envelope.
//
// FAIL DIRECTION. The gate throws GateUnavailable when it cannot decide. That is
// HELD, never sent: the alert is counted as held in the tick summary and next
// Monday asks again. Everything else in this file is best-effort and never
// throws — an alert that cannot be delivered must not cost the cycle that
// produced it, and the run row already records what happened.
//
// RECIPIENT. Configuration, never a hardcoded address (no-fabricated-catalog
// applies to addresses too). CONTENT_AGENT_ALERT_EMAIL first; then
// SITE_REQUEST_NOTIFY_EMAIL, which is the founder inbox this repo already
// knows (lib/siteRequests.js). Neither set = skipped, loudly, as a config gap.

import { canSend, GateUnavailable } from '../notificationGate.js';
import { businessDisplayName } from '../businessIdentityClient.js';
import { sendEmail } from '../email.js';

/** The one canonical category for a message addressed to the business owner. */
export const ALERT_CATEGORY = 'owner_alerts';

/** Alerts a human must see the moment they happen (scope 30.2). */
export const IMMEDIATE_MODES = ['F3', 'F5', 'F8', 'MARGIN'];

/**
 * The ordinary news, added by ARGUS pack 1: "N drafts are waiting for you".
 *
 * Deliberately NOT in IMMEDIATE_MODES. It is once per cycle per business and it
 * is the reason a POC does not read as "the agents did nothing" — but it is not
 * an exception, and treating it as one would train Brandon to ignore the modes
 * that are.
 */
export const DIGEST_MODE = 'DIGEST';

export const OUTCOME = {
  SENT: 'sent',
  HELD: 'held_gate_unavailable',
  SUPPRESSED: 'suppressed_by_preference',
  NO_RECIPIENT: 'no_recipient_configured',
  SEND_FAILED: 'send_failed',
  NOTHING_TO_SEND: 'nothing_to_send',
};

export function alertRecipient(env = process.env) {
  return (env.CONTENT_AGENT_ALERT_EMAIL || env.SITE_REQUEST_NOTIFY_EMAIL || '').trim() || null;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Render one tenant's alerts. Pure, so the wording is testable without a
 * network. The business NAME is passed in — this function never resolves it,
 * because there is exactly one resolver and it is not here.
 */
export function renderAlertEmail({ businessName, alerts }) {
  const worst = alerts.find((a) => IMMEDIATE_MODES.includes(a.failure_mode)) || alerts[0];
  // A digest-only message must not wear a failure code in its subject line: an
  // envelope that says "F3" for "3 drafts are waiting" is an envelope that gets
  // filtered.
  const onlyDigest = alerts.every((a) => a.failure_mode === DIGEST_MODE);
  const subject = onlyDigest
    ? `${businessName}: ${alerts.length === 1 ? 'a draft is' : `${alerts.length} items are`} waiting for you`
    : `Content agent — ${alerts.length === 1 ? worst.code || worst.failure_mode : `${alerts.length} items`} for ${businessName}`;
  const rows = alerts
    .map((a) => `<li><strong>${esc(a.failure_mode)}</strong> ${esc(a.code || '')}<br/>${esc(a.message)}</li>`)
    .join('');
  const html = `<p>The content agent has something for you on <strong>${esc(businessName)}</strong>.</p><ul>${rows}</ul>`
    + '<p>Nothing here has been published. Drafts wait in the review queue until you approve them.</p>';
  const text = `The content agent has something for you on ${businessName}.\n\n`
    + alerts.map((a) => `- [${a.failure_mode}] ${a.code || ''} ${a.message}`).join('\n')
    + '\n\nNothing here has been published. Drafts wait in the review queue until you approve them.';
  return { subject, html, text };
}

/**
 * Send one tenant's alerts, through the gate, named by the one identity.
 *
 * @returns {Promise<{outcome, reason?, to?, businessName?, count}>} never throws
 */
export async function notifyTenantAlerts({
  tenantId, alerts = [], log = () => {},
  gate = canSend, resolveName = businessDisplayName, send = sendEmail, env = process.env,
}) {
  if (!alerts.length) return { outcome: OUTCOME.NOTHING_TO_SEND, count: 0 };

  const to = alertRecipient(env);
  if (!to) {
    log(`alerts for ${tenantId} NOT sent: neither CONTENT_AGENT_ALERT_EMAIL nor SITE_REQUEST_NOTIFY_EMAIL is set (${alerts.length} alert(s) recorded in the run log)`);
    return { outcome: OUTCOME.NO_RECIPIENT, count: alerts.length };
  }

  let verdict;
  try {
    verdict = await gate({ tenantId, channel: 'email', to, categoryKey: ALERT_CATEGORY });
  } catch (err) {
    if (!(err instanceof GateUnavailable)) throw err;
    // HELD. Not sent, not lost: the alerts stay in the summary and the run log.
    log(`alerts for ${tenantId} HELD — the preference gate could not decide (${err.reason}). Nothing was sent; next cycle asks again.`);
    return { outcome: OUTCOME.HELD, reason: err.reason, count: alerts.length };
  }

  if (!verdict?.allowed) {
    log(`alerts for ${tenantId} suppressed by preference (${verdict?.reason || 'no reason given'})`);
    return { outcome: OUTCOME.SUPPRESSED, reason: verdict?.reason || null, count: alerts.length };
  }

  // The ONE identity. Never throws (see businessIdentityClient) — a stale or
  // neutral name still beats an alert nobody can read.
  const businessName = await resolveName(tenantId);
  const { subject, html, text } = renderAlertEmail({ businessName, alerts });

  try {
    await send({
      to, subject, html, text,
      tag: 'content-agent-alert',
      metadata: {
        tenant_id: String(tenantId),
        category_key: ALERT_CATEGORY,
        failure_modes: alerts.map((a) => a.failure_mode).join(','),
      },
    });
    return { outcome: OUTCOME.SENT, to, businessName, count: alerts.length };
  } catch (err) {
    log(`alerts for ${tenantId} could not be emailed (${err.message}) — they remain in the run log and the tick summary`);
    return { outcome: OUTCOME.SEND_FAILED, reason: err.message, count: alerts.length };
  }
}

/**
 * Every tenant's alerts in one pass, one message per business.
 *
 * Grouped per tenant deliberately: an alert about one client's content must not
 * arrive in the same envelope as another client's, because the envelope is
 * where a name leak would be invisible.
 */
export async function notifyAlerts({ alerts = [], log = () => {}, ...deps }) {
  const byTenant = new Map();
  for (const a of alerts) {
    if (!a?.tenantId) continue;
    if (!byTenant.has(a.tenantId)) byTenant.set(a.tenantId, []);
    byTenant.get(a.tenantId).push(a);
  }
  const results = [];
  for (const [tenantId, list] of byTenant) {
    results.push({ tenantId, ...(await notifyTenantAlerts({ tenantId, alerts: list, log, ...deps })) });
  }
  return results;
}

export default {
  ALERT_CATEGORY, IMMEDIATE_MODES, DIGEST_MODE, OUTCOME, alertRecipient,
  renderAlertEmail, notifyTenantAlerts, notifyAlerts,
};
