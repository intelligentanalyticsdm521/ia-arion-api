/**
 * ONE PRICE LIST for the AI Builder's own two actions (P18).
 * ---------------------------------------------------------------------------
 * The Portal's AI Builder page carried its own credit arithmetic — a `base: 2`
 * plus per-column, per-item and per-image coefficients, with the TODO still on
 * it ("move COSTS + BLOCK_DEFAULTS into a pricing endpoint so DB is source of
 * truth", WebsiteAiBuilder.tsx:17). The server charged something else entirely:
 * `grep meterAndAudit routes/arion/blocks.js` was ZERO hits, so generating a
 * section quoted a price and then debited nothing at all, while `costGuard.js`
 * enforced a dollar ceiling nobody was shown. A UI that quotes a price the
 * server does not charge is the defect `feedback_no_fabricated_catalog` is
 * about, and there were three answers to "what does this cost" in one feature.
 *
 * There is one now: `argus.action_pricing` (db/migrations/065), read and
 * charged through `lib/argus/callWrapper.js` — the same path the section and
 * page AI edits already use.
 *
 * WHY THIS FILE EXISTS AT ALL — the library short-circuit. `callEmitter` answers
 * six of the eight archetypes out of the curated section library with NO
 * provider call and no cost. Wrapping the whole of callEmitter in
 * `meterAndAudit` would debit a client for a free answer, so the two halves of
 * metering are separated here and both go through callWrapper:
 *
 *   assertBuilderCredits()  BEFORE the work — the plan gate, the kill switch
 *                           and the balance, so a client who cannot afford the
 *                           action is told before a token is spent.
 *   chargeBuilderAction()   AFTER it, and ONLY if a provider call happened —
 *                           the audit row and the debit, priced by the row.
 *
 * A row priced at 0 credits charges nothing and says so: that is how
 * "publishing your accepted sections is free" is a fact in the database rather
 * than a word in the UI. Change the row and the code charges it.
 */

import {
  getActionPricing, getBalance, meterAndAudit, isArgusSpendEnabled,
} from '../argus/callWrapper.js';
import { argusTables } from '../argus/tables.js';

/** Generating one section's copy from scratch. */
export const ACTION_GENERATE_SECTION = 'arion.site_generate_section';
/** Assembling accepted sections onto a page and publishing them. */
export const ACTION_ASSEMBLE_PAGE = 'arion.site_assemble_page';

/**
 * Can this business afford this action, right now?
 *
 * @returns {Promise<{ ok: true, credits: number }
 *   | { ok: false, code: string, status: number, message: string, balance?: number, required?: number }>}
 */
export async function assertBuilderCredits({ pool, tenantId, actionType }) {
  let pricing = null;
  try {
    pricing = await getActionPricing(pool, actionType);
  } catch (err) {
    console.warn(`[builderMeter] pricing unreadable for ${actionType}: ${err?.message}`);
  }
  if (!pricing || !pricing.is_active) {
    // An unpriced action is DEAD, not free — exactly what meterAndAudit itself
    // answers with `unknown_action`. Saying so here means the client gets a
    // sentence instead of a stack trace after the work has been done.
    return {
      ok: false,
      code: 'ACTION_NOT_PRICED',
      status: 409,
      message: 'This is not something we can run just now. Nothing was charged — please tell us and we will sort it.',
    };
  }

  const credits = Number(pricing.credits_per_call || 0);
  if (credits <= 0) return { ok: true, credits: 0 };

  const T = await argusTables(pool);
  if (T.consolidated && !(await isArgusSpendEnabled(pool))) {
    return {
      ok: false,
      code: 'AI_SPEND_PAUSED',
      status: 409,
      message: 'AI credit spending is paused at the moment. Nothing was charged.',
    };
  }

  const bal = await getBalance(pool, tenantId);
  if (Number(bal.balance) < credits) {
    return {
      ok: false,
      code: 'INSUFFICIENT_CREDITS',
      status: 402,
      message: `This uses ${credits} ${credits === 1 ? 'credit' : 'credits'} and you have `
        + `${Number(bal.balance)}. Top up and try again — nothing was charged.`,
      balance: Number(bal.balance),
      required: credits,
    };
  }
  return { ok: true, credits };
}

/**
 * Write the audit row and take the credits for work that has already happened.
 *
 * `runCall` is DEGENERATE on purpose: the provider call is already done and its
 * token counts are handed straight back. Everything else in meterAndAudit — the
 * pricing lookup, the cost basis, the outlier guard, the audit row, the
 * `argus.credit_use` debit — runs exactly as it does for every other metered
 * call, so there is still one implementation of the credit rules.
 *
 * @returns {Promise<{ ok: boolean, creditsCharged: number, error?: object }>}
 */
export async function chargeBuilderAction({
  pool, tenantId, userId, actionType, provider, model, meta,
  inputTokens = 0, outputTokens = 0, imageCount = 0,
}) {
  const metered = await meterAndAudit({
    pool, tenantId, userId, actionType, provider, model, meta,
    runCall: async () => ({ inputTokens, outputTokens, imageCount, data: null }),
  });
  if (!metered.ok) {
    console.warn(`[builderMeter] ${actionType} not charged: ${metered.error?.code} ${metered.error?.message}`);
    return { ok: false, creditsCharged: 0, error: metered.error };
  }
  return { ok: true, creditsCharged: Number(metered.audit?.credits_charged ?? 0) };
}

/** What an action costs, for a Portal that must never invent a number. */
export async function builderActionPrice(pool, actionType) {
  let row = null;
  try {
    row = await getActionPricing(pool, actionType);
  } catch (err) {
    console.warn(`[builderMeter] ${actionType} unreadable: ${err?.message}`);
  }
  return {
    actionType,
    credits: row && row.is_active ? Number(row.credits_per_call) : null,
    available: !!(row && row.is_active),
  };
}
