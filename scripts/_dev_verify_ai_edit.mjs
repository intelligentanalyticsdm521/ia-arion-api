#!/usr/bin/env node
/**
 * _dev_verify_ai_edit.mjs — drive the Phase 1B routes against the LOCAL
 * arion-api + dev WordPress and print a PASS/FAIL matrix.
 *
 * Its companion `_dev_verify_site_builder.mjs` drives the plugin directly.
 * This one drives arion-api, because everything Phase 1B adds lives there:
 * the plan gate, the ARGUS metering, the proposal row, the curated-library
 * mapping, and the rule that binds them — an approved suggestion reaches the
 * website only through the ordinary save.
 *
 * It asserts on the content coming back, never on the absence of an error
 * (feedback_assert_presence_not_just_absence), and it breaks four things on
 * purpose (feedback_mutation_test_your_guards).
 *
 * ⚠ Dev only, twice over: it refuses any base URL but loopback, and the model
 * call it exercises is the local stand-in (ARION_AI_DEV_STUB), so no real
 * provider request is ever made. The metering around that call is REAL — the
 * ARGUS audit row and the credit debit are written exactly as in production,
 * which is the point.
 *
 *   node scripts/_dev_verify_ai_edit.mjs [--api http://localhost:4034]
 */

import 'dotenv/config';
import sql from 'mssql';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const API = arg('api', `http://localhost:${process.env.PORT || 4034}`);
const SITE = arg('site-id', 'e68a46ae-b5ee-441d-a71c-2afeca12a658');
const TENANT = arg('tenant-id', 'a0000001-0000-0000-0000-000000000001');

if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(API)) {
  console.error(`Refusing to run against "${API}" — local dev only.`);
  process.exit(1);
}
const sqlServer = String(process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER || '');
if (!/^(localhost|127\.0\.0\.1)/i.test(sqlServer)) {
  console.error(`Refusing: SERVICES_SQL_SERVER=${sqlServer} is not local.`);
  process.exit(1);
}

let pass = 0;
let fail = 0;
const failed = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failed.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}/arion/sites/${SITE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-dev-tenant': TENANT },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

let pool;
async function db() {
  if (!pool) {
    pool = await sql.connect({
      server: sqlServer.split(',')[0],
      port: parseInt(sqlServer.split(',')[1] || '1433', 10),
      database: process.env.SERVICES_SQL_DATABASE || 'iadm_services',
      user: process.env.SQL_USER, password: process.env.SQL_PASSWORD,
      options: { encrypt: false, trustServerCertificate: true },
    });
  }
  return pool;
}

const setTier = async (tier) => (await db()).request()
  .input('t', sql.NVarChar(20), tier).input('s', sql.UniqueIdentifier, SITE)
  .query('UPDATE arion.site SET arion_tier = @t WHERE site_id = @s');

const countAudit = async () => Number((await (await db()).request()
  .query("SELECT COUNT(*) c FROM argus.ai_call_audit WHERE action_type LIKE 'arion.site_edit%'"))
  .recordset[0].c);

const countDebits = async () => Number((await (await db()).request()
  .query("SELECT COUNT(*) c FROM argus.credit_use WHERE feature_key LIKE 'arion.site_edit%'"))
  .recordset[0].c);

const proposalStatus = async (id) => (await (await db()).request()
  .input('p', sql.UniqueIdentifier, id)
  .query('SELECT status, credits_charged FROM arion.site_edit_proposal WHERE proposal_id = @p'))
  .recordset[0] || null;

const SECTION_NODE = {
  elType: 'section',
  settings: { _title: 'ia:hero:scratch:verify' },
  elements: [{
    id: 'v1', elType: 'column', settings: {}, elements: [
      { id: 'v2', elType: 'widget', widgetType: 'heading', settings: { _ia_field: 'hero.headline', title: 'Verification headline' } },
    ],
  }],
};

(async () => {
  console.log(`\n=== Phase 1B: "Ask ARGUS to change it" — ${API}, site ${SITE} ===\n`);

  const originalTier = (await (await db()).request()
    .input('s', sql.UniqueIdentifier, SITE)
    .query('SELECT arion_tier FROM arion.site WHERE site_id = @s')).recordset[0]?.arion_tier || 'business';

  try {
    /* ── the price comes from the database, not from the UI ─────────────── */
    await setTier('business');
    const pricing = await call('/ai-pricing');
    check('GET /ai-pricing answers with the credit cost of both actions',
      pricing.status === 200
      && Number.isInteger(pricing.json?.data?.actions?.section?.credits)
      && Number.isInteger(pricing.json?.data?.actions?.page?.credits),
      JSON.stringify(pricing.json?.data?.actions));
    check('the price is the one migration 059 wrote (1 section, 6 page)',
      pricing.json?.data?.actions?.section?.credits === 1
      && pricing.json?.data?.actions?.page?.credits === 6);
    check('the answer names ARGUS AI and no vendor',
      pricing.json?.data?.poweredBy === 'ARGUS AI'
      && !/claude|anthropic|openai/i.test(pricing.text));

    /* ── the plan gate, before anything is spent ────────────────────────── */
    await setTier('lite');
    const auditBefore = await countAudit();
    const litePricing = await call('/ai-pricing');
    check('a Lite site is told the AI actions are not on its plan',
      litePricing.json?.data?.ai?.available === false
      && /ARION Standard/.test(litePricing.json?.data?.ai?.reason || ''));

    const liteEdit = await call('/pages/10/sections/x/ai-edit', {
      method: 'POST',
      body: { instruction: 'warmer', section: { index: 0, fields: { headline: 'x' }, node: SECTION_NODE } },
    });
    check('a Lite site asking for an AI edit is refused with the upsell, 403',
      liteEdit.status === 403 && liteEdit.json?.error?.code === 'AI_NOT_ON_THIS_PLAN',
      `status ${liteEdit.status}`);
    check('and nothing was metered for it',
      (await countAudit()) === auditBefore,
      'an ARGUS audit row appeared for a refused plan');

    const liteLibrary = await call('/section-library');
    const contact = (liteLibrary.json?.data?.sections || []).find((s) => s.kind === 'contact');
    check('a Lite site is shown the Pro-only section greyed, with the reason',
      contact && contact.available === false && /Elementor Pro/.test(contact.unavailableReason || ''));
    check('and the rest of the editor is still fully on offer for Lite',
      (liteLibrary.json?.data?.sections || []).filter((s) => s.available).length >= 7);

    /* ── one proposal, one metered call, nothing written ────────────────── */
    await setTier('business');
    const a0 = await countAudit();
    const d0 = await countDebits();

    const propose = await call('/pages/10/sections/ia%3Ahero%3Ascratch%3Averify/ai-edit', {
      method: 'POST',
      body: {
        instruction: 'Make this warmer',
        section: { index: 0, fields: { headline: 'Verification headline' }, node: SECTION_NODE },
      },
    });
    check('an AI edit answers with a PROPOSAL, not a saved page',
      propose.status === 201 && !!propose.json?.data?.proposal_id
      && Array.isArray(propose.json?.data?.diff) && propose.json.data.diff.length > 0,
      `status ${propose.status}`);
    check('the proposal carries a before AND an after for every changed field',
      propose.json?.data?.diff?.every((r) => 'beforeText' in r && 'afterText' in r && r.beforeText !== r.afterText));
    check('and it says what it cost, in credits',
      propose.json?.data?.cost_units === 1, `cost ${propose.json?.data?.cost_units}`);
    check('exactly ONE ARGUS audit row was written for it',
      (await countAudit()) === a0 + 1, `${(await countAudit()) - a0} rows`);
    check('exactly ONE credit debit was written for it',
      (await countDebits()) === d0 + 1);

    const pid = propose.json?.data?.proposal_id;
    const stored = await proposalStatus(pid);
    check('the proposal is recorded at status "proposed", never "applied"',
      stored?.status === 'proposed', JSON.stringify(stored));

    /* ── approving is the ordinary save, and only then is it applied ────── */
    const page = await call('/pages/10/sections');
    const sections = (page.json?.data?.sections || []).map((s) => ({ fields: s.fields, node: s.node }));
    check('the page reads back before the save so the approval carries the real tree',
      sections.length > 0);

    const NEW_HEADLINE = `Verified by the 1B check ${Date.now()}`;
    const beforeHeadline = page.json?.data?.sections?.[0]?.fields?.headline;
    sections[0] = { ...sections[0], fields: { ...sections[0].fields, headline: NEW_HEADLINE } };

    const saved = await call('/pages/10/sections', {
      method: 'PUT', body: { sections, proposalIds: [pid] },
    });
    check('approving writes through the ordinary save path',
      saved.status === 200 && saved.json?.data?.sectionsWritten === sections.length,
      `status ${saved.status}`);
    check('the save reports how many suggestions it carried',
      saved.json?.data?.proposalsApplied === 1, JSON.stringify(saved.json?.data?.proposalsApplied));
    check('and ONLY THEN is the proposal stamped applied',
      (await proposalStatus(pid))?.status === 'applied');

    const readBack = await call('/pages/10/sections');
    check('the new wording is on the page, read back from the website',
      readBack.json?.data?.sections?.[0]?.fields?.headline === NEW_HEADLINE);
    check('and Undo can still reach the version before it',
      readBack.json?.data?.canUndo === true);

    const undone = await call('/pages/10/undo', { method: 'POST' });
    check('Undo covers an AI edit exactly as it covers a typed one',
      undone.status === 200
      && (await call('/pages/10/sections')).json?.data?.sections?.[0]?.fields?.headline === beforeHeadline);

    /* ── discarding ─────────────────────────────────────────────────────── */
    const second = await call('/pages/10/sections/ia%3Ahero%3Ascratch%3Averify/ai-edit', {
      method: 'POST',
      body: { instruction: 'shorter', section: { index: 0, fields: { headline: 'Verification headline' }, node: SECTION_NODE } },
    });
    const pid2 = second.json?.data?.proposal_id;
    const discard = await call(`/proposals/${pid2}/discard`, { method: 'POST' });
    check('discarding a suggestion is accepted', discard.status === 200);
    check('and the row says discarded, keeping what it cost',
      (await proposalStatus(pid2))?.status === 'discarded'
      && (await proposalStatus(pid2))?.credits_charged === 1);
    const twice = await call(`/proposals/${pid2}/discard`, { method: 'POST' });
    check('a suggestion cannot be resolved twice', twice.status === 409, `status ${twice.status}`);

    /* ── page-level ─────────────────────────────────────────────────────── */
    const pageDetail = await call('/pages/10/sections');
    const pageSections = (pageDetail.json?.data?.sections || []).map((s) => ({ fields: s.fields, node: s.node }));
    const a1 = await countAudit();
    const pageEdit = await call('/pages/10/ai-edit', {
      method: 'POST',
      body: { instruction: 'Make the tone warmer and add a section about winter services', sections: pageSections },
    });
    check('a page instruction answers with edits and, when asked, new sections',
      pageEdit.status === 201 && Array.isArray(pageEdit.json?.data?.edits)
      && Array.isArray(pageEdit.json?.data?.additions),
      `status ${pageEdit.status}`);
    check('a whole page is ONE metered call, not one per section',
      (await countAudit()) === a1 + 1);
    check('a proposed new section arrives as a real, editable section',
      (pageEdit.json?.data?.additions || []).every((a) => a.section?.editable === true && a.section?.fields));
    check('and it costs what the page action is priced at',
      pageEdit.json?.data?.cost_units === 6, `cost ${pageEdit.json?.data?.cost_units}`);
    await call(`/proposals/${pageEdit.json?.data?.proposal_id}/discard`, { method: 'POST' });

    /* ── the curated library ────────────────────────────────────────────── */
    const library = await call('/section-library');
    const offered = (library.json?.data?.sections || [])
      .reduce((n, s) => n + (s.variants || []).filter((v) => v.available).length, 0);
    check('the picker offers curated layouts', offered > 0, `${offered} offered`);
    check('and every one of them is a layout the editor can look after',
      (library.json?.data?.sections || []).every((s) => (s.variants || []).every((v) => typeof v.blueprintId === 'string')));

    const heroVariant = (library.json?.data?.sections || [])
      .find((s) => s.kind === 'hero')?.variants?.find((v) => v.available);
    if (heroVariant) {
      const built = await call('/sections', { method: 'POST', body: { kind: 'hero', blueprintId: heroVariant.blueprintId } });
      check('a curated layout builds into an EDITABLE section',
        built.status === 201 && built.json?.data?.section?.editable === true
        && typeof built.json?.data?.section?.fields?.headline === 'string',
        `status ${built.status}`);
      check('and it keeps the design it was drawn with',
        !!built.json?.data?.section?.node?.settings?.background_color
        || !!built.json?.data?.section?.node?.settings?.background_background);
    } else {
      check('a curated layout builds into an EDITABLE section', false, 'no library reachable — set SECTION_LIBRARY_LOCAL_FILE');
    }

    /* ── break it on purpose ────────────────────────────────────────────── */
    const a2 = await countAudit();
    const empty = await call('/pages/10/sections/x/ai-edit', {
      method: 'POST', body: { instruction: '   ', section: { fields: {}, node: SECTION_NODE } },
    });
    check('an empty instruction is refused before anything is spent',
      empty.status === 400 && (await countAudit()) === a2, `status ${empty.status}`);

    const tooLong = await call('/pages/10/sections/x/ai-edit', {
      method: 'POST', body: { instruction: 'x'.repeat(1200), section: { fields: {}, node: SECTION_NODE } },
    });
    check('an over-long instruction is refused before anything is spent',
      tooLong.status === 400 && (await countAudit()) === a2, `status ${tooLong.status}`);

    const custom = await call('/pages/11/sections/x/ai-edit', {
      method: 'POST',
      body: {
        instruction: 'change it',
        section: { fields: null, node: { elType: 'section', settings: { _title: 'Awards strip' } } },
      },
    });
    check('ARGUS is refused on a section built on the website itself',
      custom.status === 400 && custom.json?.error?.code === 'SECTION_NOT_EDITABLE'
      && (await countAudit()) === a2, `status ${custom.status}`);

    const ghostBlueprint = await call('/sections', { method: 'POST', body: { kind: 'hero', blueprintId: 'pricing.3col-cards.v1' } });
    check('a layout the editor cannot look after is refused even when asked for by id',
      ghostBlueprint.status === 400, `status ${ghostBlueprint.status}`);
  } finally {
    await setTier(originalTier).catch(() => {});
    if (pool) await pool.close().catch(() => {});
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  for (const f of failed) console.log(`  FAILED: ${f}`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('\nverification crashed:', err);
  process.exit(1);
});
