/**
 * A stand-in for the writing model, for LOCAL dev and the click-through only.
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * The standing rule is that the whole editor is walked in the real dev app
 * before Brandon sees it (feedback_exhaustive_ui_test_before_walkthrough), and
 * the standing rule for exercises is that no real model call is made. Those
 * two together need a seam: something that answers the shape a model answers,
 * deterministically, for free, so every screen of the propose/preview/approve
 * flow can actually be clicked.
 *
 * It is a DEV SEAM, not a feature. It changes nothing about metering: the call
 * still goes through meterAndAudit, still checks the plan, still checks the
 * balance, still writes the ARGUS audit row and still debits the credits. The
 * only thing swapped out is the HTTP request to the provider — which is the
 * only part of the path that costs money and the only part that cannot be
 * exercised offline.
 *
 * HARD GUARDRAILS, in the shape lib/devAuth.js already uses:
 *   1. Inert unless ARION_AI_DEV_STUB is explicitly "1"/"true".
 *   2. Refuses when NODE_ENV === 'production'.
 *   3. Refuses unless the database this process is pointed at is LOCAL. That
 *      is the load-bearing one: an env var can be set by accident, a
 *      connection string to localhost cannot be prod
 *      (feedback_verify_db_target_before_writing).
 *
 * All three are PRESENCE checks on a dev marker, never the absence of a prod
 * one (reference_absence_based_guards_fail_open).
 */

const LOCAL_SERVER = /^(localhost|127\.0\.0\.1|\[::1\])(,|$|:)/i;

/** Is this process pointed at a local SQL Server? */
export function isLocalDatabase(env = process.env) {
  const server = String(env.SERVICES_SQL_SERVER || env.SQL_SERVER || '').trim();
  return LOCAL_SERVER.test(server);
}

export function devStubActive(env = process.env) {
  const on = ['1', 'true'].includes(String(env.ARION_AI_DEV_STUB || '').toLowerCase());
  if (!on) return false;
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
    console.warn('[aiDevStub] refusing: NODE_ENV=production');
    return false;
  }
  if (!isLocalDatabase(env)) {
    console.warn('[aiDevStub] refusing: the database is not local');
    return false;
  }
  return true;
}

/* ==========================================================================
 * What the stand-in writes
 *
 * Deterministic and obviously synthetic, so nobody mistakes a walkthrough
 * screenshot for real copy. It reads the instruction well enough to exercise
 * the three branches that matter on screen: a section rewrite, a page-wide
 * tone change, and a request that asks for a new section.
 * ======================================================================== */

const WARM = (s) => `${String(s || '').replace(/\.$/, '')} — and we would love to help.`;

function sectionAnswer({ user }) {
  const now = readBlock(user, 'WHAT THE SECTION SAYS NOW');
  const asked = readBlock(user, 'WHAT THE OWNER ASKED FOR');
  let fields = {};
  try {
    const current = JSON.parse(now || '{}');
    if (typeof current.headline === 'string' && current.headline) {
      fields.headline = shorten(`${current.headline} you can count on`, 140);
    }
    if (typeof current.subheadline === 'string' && current.subheadline) {
      fields.subheadline = shorten(WARM(current.subheadline), 400);
    }
    if (Object.keys(fields).length === 0) fields = { headline: 'A friendlier headline' };
  } catch {
    fields = { headline: 'A friendlier headline' };
  }
  return { fields, summary: `Rewrote the wording for: ${shorten(asked, 90)}` };
}

function pageAnswer({ user }) {
  const page = safeParse(readBlock(user, 'THE PAGE AS IT IS NOW'), []);
  const asked = readBlock(user, 'WHAT THE OWNER ASKED FOR');
  const editable = (Array.isArray(page) ? page : []).filter((s) => s && s.kind && !s.locked);

  const edits = editable.slice(0, 2).map((s) => {
    const fields = {};
    if (typeof s.fields?.headline === 'string' && s.fields.headline) {
      fields.headline = shorten(`${s.fields.headline} you can count on`, 140);
    }
    return { index: s.index, fields };
  }).filter((e) => Object.keys(e.fields).length > 0);

  const wantsNew = /\badd\b|\bnew section\b|\bsection about\b/i.test(asked);
  const add_sections = wantsNew ? [{
    kind: 'faq',
    after_index: editable.length ? editable[editable.length - 1].index : -1,
    fields: {
      headline: 'Questions we get asked',
      faqs: [{ question: shorten(`What about ${asked.replace(/[.?!]+$/, '')}?`, 200), answer: 'Yes — get in touch and we will talk it through.' }],
    },
  }] : [];

  return { edits, add_sections, summary: `Adjusted ${edits.length} section${edits.length === 1 ? '' : 's'}${wantsNew ? ' and suggested one new one' : ''}.` };
}

function readBlock(text, header) {
  const src = String(text || '');
  const start = src.indexOf(header);
  if (start < 0) return '';
  const after = src.slice(start + header.length);
  const nextHeader = after.search(/\n[A-Z][A-Z ]{6,}\n/);
  return (nextHeader < 0 ? after : after.slice(0, nextHeader)).trim();
}

function safeParse(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function shorten(s, max) {
  const t = String(s || '').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * A `callAnthropic`-shaped function, or null when the seam is off.
 * The routes pass whatever this returns straight through to the engine's
 * `callModel`, so `null` means "use the real client".
 */
export function maybeDevModel(env = process.env) {
  if (!devStubActive(env)) return null;
  return async ({ model, system, user }) => {
    const isPage = /you are changing one page/i.test(String(system || ''));
    const data = isPage ? pageAnswer({ user }) : sectionAnswer({ user });
    const text = JSON.stringify(data);
    return {
      ok: true,
      data,
      text,
      // Token counts in the right order of magnitude so the ARGUS audit row,
      // the cost basis and the outlier guard all see realistic numbers.
      inputTokens: Math.ceil((String(system).length + String(user).length) / 4),
      outputTokens: Math.ceil(text.length / 4),
      model,
      latencyMs: 5,
    };
  };
}

export const __test__ = { readBlock, safeParse, shorten, sectionAnswer, pageAnswer, LOCAL_SERVER };
