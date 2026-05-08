/**
 * Stripe Client + Helpers
 * --------------------------------------------------------------------------
 * Thin wrapper around the Stripe Node SDK so the rest of the app doesn't
 * import `stripe` directly. Centralizes:
 *   - Lazy client init (avoids requiring the env var at module load time)
 *   - Idempotency key helpers
 *   - Customer + checkout session creation patterns
 *   - Webhook signature verification
 *
 * The module never throws on missing config — it returns `null` for the
 * client if the env var is absent so health checks can surface the issue
 * cleanly instead of crashing on require.
 */

import Stripe from 'stripe';
import crypto from 'node:crypto';

let _client = null;

/**
 * Lazily-initialized Stripe client. Returns null if STRIPE_SECRET_KEY is unset.
 * @returns {Stripe|null}
 */
export function getStripeClient() {
  if (_client) return _client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.warn('[stripe] STRIPE_SECRET_KEY is not set — Stripe client unavailable');
    return null;
  }
  _client = new Stripe(key, {
    apiVersion: '2024-06-20',
    maxNetworkRetries: 2,
    timeout: 15_000,
    appInfo: { name: 'arion-api', version: '1.0.0' },
  });
  return _client;
}

/**
 * Generate an idempotency key for a logical operation. Stripe will return the
 * same response for the same key within 24h — protects against double-charges
 * if the client retries.
 */
export function idempotencyKey(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(String(p) + '|');
  return h.digest('hex').slice(0, 32);
}

/**
 * Create or fetch a Stripe customer for a tenant signup.
 * @param {object} params
 * @param {string} params.email
 * @param {string} [params.name]
 * @param {object} [params.metadata]
 * @returns {Promise<Stripe.Customer|null>}
 */
export async function ensureCustomer({ email, name, metadata = {} }) {
  const stripe = getStripeClient();
  if (!stripe) return null;
  if (!email) throw new Error('ensureCustomer: email is required');

  // Look for existing by email — no fancy dedupe, first match wins.
  const existing = await stripe.customers.list({ email, limit: 1 });
  if (existing.data.length > 0) return existing.data[0];

  return stripe.customers.create(
    { email, name: name || email, metadata },
    { idempotencyKey: idempotencyKey('customer', email) }
  );
}

/**
 * Verify a webhook payload signature.
 * @param {Buffer|string} rawBody  - the raw request body
 * @param {string} signature       - the Stripe-Signature header
 * @returns {Stripe.Event}         - throws if invalid
 */
export function verifyWebhook(rawBody, signature) {
  const stripe = getStripeClient();
  if (!stripe) throw new Error('Stripe client not initialized');
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET not set');
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}
