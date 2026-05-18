/**
 * Onboarding — Stripe Webhook
 * --------------------------------------------------------------------------
 * Mounted with raw body parser at /onboarding/webhook so the Stripe signature
 * can be verified against the byte-exact request body.
 *
 * Events we care about:
 *
 *   checkout.session.completed     → payment succeeded; create tenant + site,
 *                                    enqueue provisioning job
 *   customer.subscription.deleted  → mark tenant cancelled
 *   customer.subscription.updated  → if status flips inactive, mark site paused
 *   invoice.payment_failed         → flag account as past_due
 *
 * The handler is intentionally idempotent — duplicate events should be
 * harmless. We use the Stripe event ID as a dedupe key on the platform_event
 * table.
 */

import { Router } from 'express';
import express from 'express';
import sql from 'mssql';
import crypto from 'node:crypto';
import { verifyWebhook } from '../../lib/stripe.js';
import { getServicesPool } from '../../db/servicesPool.js';
import { createProvisionCode } from '../../lib/provisionCodes.js';
import { firePlatformEvent } from '../../lib/platformEvents.js';
import { sendEmail } from '../../lib/email.js';
import { welcomeEmail, paymentFailedEmail } from '../../lib/emailTemplates.js';
import { getPlan } from '../../lib/pricing.js';
import { getPlatformPool } from '../../db/platformPool.js';

const router = Router();

// IMPORTANT: this route uses raw body parser, NOT express.json()
router.post('/', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).send('missing signature');

  let event;
  try {
    event = verifyWebhook(req.body, sig);
  } catch (err) {
    console.error('[webhook] signature verification failed:', err.message);
    return res.status(400).send('invalid signature');
  }

  // Dedupe by event ID — short-circuit if we've already processed
  try {
    const pool = await getServicesPool();
    const seen = await pool.request()
      .input('eventId', sql.NVarChar(200), event.id)
      .query(`SELECT TOP 1 1 AS hit FROM arion.stripe_webhook_log WHERE event_id = @eventId`);
    if (seen.recordset.length > 0) {
      return res.json({ received: true, deduped: true });
    }

    await pool.request()
      .input('eventId', sql.NVarChar(200), event.id)
      .input('eventType', sql.NVarChar(100), event.type)
      .input('payload', sql.NVarChar(sql.MAX), JSON.stringify(event).slice(0, 200_000))
      .query(`
        INSERT INTO arion.stripe_webhook_log (event_id, event_type, payload, received_at)
        VALUES (@eventId, @eventType, @payload, SYSDATETIMEOFFSET())
      `);

    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(pool, event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(pool, event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(pool, event.data.object);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(pool, event.data.object);
        break;
      default:
        // Acknowledge but ignore — Stripe sends many event types we don't act on.
        break;
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('[webhook] handler error:', err);
    // Return 500 so Stripe retries
    return res.status(500).send('webhook handler error');
  }
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * checkout.session.completed — create tenant + site + provisioning job.
 *
 * The session metadata carries everything we need to start provisioning:
 *   plan, billing_cycle, domain_mode, domain_name
 *
 * We do NOT have the questionnaire answers yet — those come in /onboarding/submit
 * after Stripe redirects back to the portal. So this handler only sets up
 * the tenant shell; provisioning kicks off when the questionnaire is submitted.
 */
async function handleCheckoutCompleted(pool, session) {
  const meta = session.metadata || {};
  const customerEmail = session.customer_details?.email || session.customer_email;
  if (!customerEmail) {
    console.warn('[webhook] checkout.completed without email — cannot create tenant');
    return;
  }

  // OLIVER / SPARK self-serve = GUEST checkout. There is no Entra account or
  // core.tenants row yet (created via the provisioning proc on first sign-in).
  // Record a durable, schema-safe paid intent in core.signup_intent and stop.
  // ARION keeps its existing arion.* website-build path below, unchanged.
  const product = String(meta.product || 'arion').toLowerCase();
  if (product === 'oliver' || product === 'spark') {
    try {
      const pp = await getPlatformPool();
      await pp.request()
        .input('sid', sql.NVarChar(200), session.id)
        .input('email', sql.NVarChar(320), customerEmail)
        .input('product', sql.NVarChar(20), product)
        .input('plan', sql.NVarChar(40), meta.plan || 'standard')
        .input('billing', sql.NVarChar(20), meta.billing_cycle || 'monthly')
        .input('cust', sql.NVarChar(100), session.customer || null)
        .input('sub', sql.NVarChar(100), session.subscription || null)
        .query(`
          IF NOT EXISTS (SELECT 1 FROM core.signup_intent WHERE stripe_session_id=@sid)
          INSERT INTO core.signup_intent
            (stripe_session_id, email, product, [plan], billing_cycle,
             stripe_customer_id, stripe_subscription_id, status)
          VALUES (@sid, @email, @product, @plan, @billing, @cust, @sub, 'paid')
        `);
      console.log(`[webhook] ${product} signup intent recorded → session=${session.id} email=${customerEmail}`);
    } catch (err) {
      console.error('[webhook] signup_intent upsert failed:', err.message);
      throw err; // let Stripe retry — we must not lose a paid signup
    }
    return;
  }

  // Idempotency: if we already created a tenant for this checkout session, skip.
  const existing = await pool.request()
    .input('sessionId', sql.NVarChar(200), session.id)
    .query(`SELECT TOP 1 tenant_id FROM arion.signup_session WHERE stripe_session_id = @sessionId`);

  let tenantId;
  let siteId;
  if (existing.recordset.length > 0) {
    tenantId = existing.recordset[0].tenant_id;
    // Look up siteId
    const siteRow = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`SELECT TOP 1 site_id FROM arion.site WHERE tenant_id = @tenantId ORDER BY created_at DESC`);
    siteId = siteRow.recordset[0]?.site_id;
  } else {
    tenantId = crypto.randomUUID();
    siteId = crypto.randomUUID();

    // Create tenant + site rows
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('email', sql.NVarChar(320), customerEmail)
      .input('plan', sql.NVarChar(40), meta.plan || 'starter')
      .input('billingCycle', sql.NVarChar(20), meta.billing_cycle || 'monthly')
      .input('stripeCustomerId', sql.NVarChar(200), session.customer || '')
      .input('stripeSubscriptionId', sql.NVarChar(200), session.subscription || '')
      .query(`
        INSERT INTO arion.tenant
          (tenant_id, primary_email, [plan], billing_cycle, stripe_customer_id, stripe_subscription_id, status, created_at)
        VALUES
          (@tenantId, @email, @plan, @billingCycle, @stripeCustomerId, @stripeSubscriptionId, 'pending_onboarding', SYSDATETIMEOFFSET())
      `);

    await pool.request()
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('domain', sql.NVarChar(253), meta.domain_name || '')
      .input('domainMode', sql.NVarChar(20), meta.domain_mode || 'byod')
      .input('tier', sql.NVarChar(40), meta.plan || 'starter')
      .query(`
        INSERT INTO arion.site
          (site_id, tenant_id, domain, domain_mode, tier, provisioning_state, created_at)
        VALUES
          (@siteId, @tenantId, @domain, @domainMode, @tier, 'awaiting_questionnaire', SYSDATETIMEOFFSET())
      `);

    // Track signup session for resumption (client lands on /onboarding?session_id=)
    await pool.request()
      .input('sessionId', sql.NVarChar(200), session.id)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('email', sql.NVarChar(320), customerEmail)
      .query(`
        INSERT INTO arion.signup_session
          (stripe_session_id, tenant_id, site_id, email, created_at)
        VALUES
          (@sessionId, @tenantId, @siteId, @email, SYSDATETIMEOFFSET())
      `);

    // Pre-issue a provisioning code so the Playwright worker has it ready when
    // the questionnaire submits and provisioning kicks off.
    await createProvisionCode(pool, {
      tenantId,
      siteId,
      createdBy: 'stripe_webhook',
      ttlDays: 14,
    });

    await firePlatformEvent(pool, {
      tenantId,
      eventType: 'arion.tenant.signed_up',
      eventRefId: tenantId,
      payload: { plan: meta.plan, billing_cycle: meta.billing_cycle, email: customerEmail },
    });

    // Welcome email — fire and forget (don't fail the webhook if email is down)
    const planMeta = getPlan(meta.plan || 'starter');
    const firstName = parseFirstName(session.customer_details?.name || '');
    const tpl = welcomeEmail({
      firstName,
      planName: planMeta?.name || 'your',
      billingCycle: meta.billing_cycle || 'monthly',
    });
    sendEmail({
      to: customerEmail,
      subject: tpl.subject,
      html: tpl.html,
      tag: 'welcome',
      metadata: { tenant_id: tenantId, site_id: siteId, stripe_session_id: session.id },
    }).catch((err) => console.warn('[webhook] welcome email failed:', err.message));
  }

  console.log(`[webhook] checkout.completed → tenant=${tenantId} site=${siteId}`);
}

function parseFirstName(fullName) {
  if (!fullName) return '';
  return String(fullName).split(/\s+/)[0] || '';
}

async function handleSubscriptionDeleted(pool, sub) {
  await pool.request()
    .input('subId', sql.NVarChar(200), sub.id)
    .query(`UPDATE arion.tenant SET status = 'cancelled', updated_at = SYSDATETIMEOFFSET() WHERE stripe_subscription_id = @subId`);
}

async function handleSubscriptionUpdated(pool, sub) {
  // Only act on inactive transitions; active-to-active no-ops are ignored.
  if (['canceled', 'unpaid', 'incomplete_expired', 'past_due'].includes(sub.status)) {
    await pool.request()
      .input('subId', sql.NVarChar(200), sub.id)
      .input('status', sql.NVarChar(40), sub.status)
      .query(`UPDATE arion.tenant SET status = @status, updated_at = SYSDATETIMEOFFSET() WHERE stripe_subscription_id = @subId`);
  }
}

async function handlePaymentFailed(pool, invoice) {
  if (!invoice.subscription) return;

  // Mark tenant past_due + look up email for the dunning notice
  const r = await pool.request()
    .input('subId', sql.NVarChar(200), invoice.subscription)
    .query(`
      UPDATE arion.tenant
      SET status = 'past_due', updated_at = SYSDATETIMEOFFSET()
      OUTPUT inserted.primary_email
      WHERE stripe_subscription_id = @subId
    `);

  const email = r.recordset[0]?.primary_email;
  if (!email) return;

  const amountUsd = invoice.amount_due ? invoice.amount_due / 100 : null;
  const tpl = paymentFailedEmail({ firstName: '', amountUsd, updatePaymentUrl: null });
  sendEmail({
    to: email,
    subject: tpl.subject,
    html: tpl.html,
    tag: 'payment_failed',
    metadata: { stripe_subscription_id: invoice.subscription, invoice_id: invoice.id },
  }).catch((err) => console.warn('[webhook] payment-failed email failed:', err.message));
}

export default router;
