// scripts/dev/exercise-team-jobs.mjs — run each of the web person's wired jobs
// once on a dev business: switch OFF, then ON + Send me first, then ON +
// Automatic. Prints one JSON line per (scenario, job) with what the runner did
// and the database rows it wrote, then removes the rows it wrote.
//
// ARGUS employees, phase 1, stream 2 (CONTRACT_ARGUS_EMPLOYEES_PHASE1 §I.1.8).
//
//   node scripts/dev/exercise-team-jobs.mjs --tenant <business id> [--brief real|stand-in] [--keep]
//
// WHAT IS REAL: the dev services database (run rows, drafts, held replies,
// approvals in advance, the metering wrapper and the dev wallet), the runners,
// the checks, the starter job descriptions read from the dev platform database
// (core.team_job_playbook_version, read only), the ownership check.
//
// WHAT STANDS IN, and why:
//   * the SWITCH. platform-api is the only writer of core.team_job_setting, so
//     this script never writes it: each scenario hands the runner the JobState
//     the switch would produce (no state = off). Flip the real switch through
//     ARGUS → Your team → The web person → Jobs, or PUT /me/team/jobs/:jobKey.
//   * the MODEL. A stand-in through the runners' callImpl seam (null in every
//     real run), so nothing is sent to a provider; metering still runs.
//   * WEBSITE PUBLISHING. The Automatic path's publish door is replaced by one
//     that records the call: a dev business's site can be a real website.
//   * GOOGLE. Reviews come from a scratch fake profile handed straight to the
//     runner; Google is never called and no site row is changed.
//   * the BRIEF, only with --brief stand-in (default real: platform-api
//     GET /internal/business-brief, which needs platform-api running the
//     phase-1 code). The stand-in Brief is generic and says so.
//
// LOCAL ONLY: refuses a SQL server that is not this machine, and any App Service.
// Nothing here knows a business: the business is --tenant.

import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import { getPlatformPool } from '../../db/platformPool.js';
import { runTick } from '../../lib/contentAgent/tick.js';
import { runCycle, AUTOMATIC_DOORS } from '../../lib/contentAgent/runner.js';
import { runReviewReplyTick } from '../../lib/gbpReplyRunner.js';
import { fakeApi } from '../../lib/gbpFake.js';
import { briefFor as realBriefFor } from '../../lib/teamSeam.js';
import { JOB } from '../../lib/jobChecks.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : (process.argv[i + 1] ?? ''); };
const has = (n) => process.argv.includes(`--${n}`);
const die = (m) => { console.error(m); process.exit(1); };
const out = (o) => console.log(JSON.stringify(o));

if (process.env.WEBSITE_SITE_NAME) die('Refusing: this looks like an App Service (WEBSITE_SITE_NAME is set).');
const local = /^(localhost|127\.0\.0\.1|\.|\(local\))([\\,].*)?$/i;
for (const [name, v] of [['services', process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER], ['platform', process.env.PLATFORM_SQL_SERVER || process.env.SQL_SERVER]]) {
  if (!local.test(String(v || ''))) die(`Refusing: the ${name} SQL server "${v}" is not this machine.`);
}
const tenantId = String(arg('tenant') || '');
if (!GUID.test(tenantId)) die('--tenant <business id> is required');
const briefMode = arg('brief') || 'real';
const keep = has('keep');

const pool = await getServicesPool();
const platform = await getPlatformPool();

/* ── the starter job descriptions, read from the dev platform database ── */
async function starter(jobKey) {
  const r = await platform.request()
    .input('k', sql.NVarChar(80), jobKey)
    .query(`SELECT p.playbook_id, v.version, v.definition_json
              FROM core.team_job_playbook p
              JOIN core.team_job_playbook_version v ON v.playbook_id = p.playbook_id AND v.version = p.published_version
             WHERE p.job_key = @k AND p.tenant_id IS NULL`);
  const row = r.recordset[0];
  if (!row) die(`No starter job description for ${jobKey} on this platform database (is migration 042 applied?).`);
  return { id: row.playbook_id, version: Number(row.version), def: JSON.parse(row.definition_json) };
}

function stateFor(jobKey, playbook, mode) {
  const vars = {};
  for (const [k, v] of Object.entries(playbook.def.vars || {})) vars[k] = v.default;
  return {
    jobKey, tenantId: tenantId.toUpperCase(), employeeKey: 'web',
    mode, modeSetBy: mode === 'automatic' ? 'the exercise script' : null,
    modeSetAt: mode === 'automatic' ? new Date().toISOString() : null,
    vars, playbook,
  };
}
const jobsOnFor = (state) => async (keys) => ({
  ok: true,
  on: state && keys.includes(state.jobKey) ? new Map([[state.tenantId, new Map([[state.jobKey, state]])]]) : new Map(),
});

/* ── the Brief ─────────────────────────────────────────────────────────── */
const STAND_IN_BRIEF = {
  version: 0, saved_at: null, borrowed: { businessName: null },
  fields: {
    services: { set: true, value: [{ name: 'Lawn care' }, { name: 'Hedge trimming' }] },
    serviceArea: { set: true, value: { cities: ['Springfield'] } },
    brandVoice: { set: true, value: 'Plain and friendly.' },
    offersAllowed: { set: true, value: [{ words: 'Free spring yard check' }] },
  },
};
let briefFor;
if (briefMode === 'stand-in') {
  briefFor = async () => ({ ok: true, brief: { ...STAND_IN_BRIEF, tenantId } });
} else {
  briefFor = realBriefFor;
  const probe = await realBriefFor(tenantId);
  if (!probe.ok) die(`The real Brief could not be read (${probe.error}). Start platform-api with the phase-1 code, or pass --brief stand-in.`);
}

/* ── the stand-ins ─────────────────────────────────────────────────────── */
const KEYWORD = 'exercise spring lawn care';
const research = async () => ({ provider: 'none', capabilities: { provider: 'none', label: 'no keyword tool' }, rows: [{ keyword: KEYWORD, intent: 'informational' }], detail: 'exercise stand-in' });

function contentStandIn({ userTurn = '' } = {}) {
  const social = /CONTENT TYPE: social_post/.test(userTurn);
  const kw = (/PRIMARY KEYWORD:\s*(.+)/i.exec(String(userTurn)) || [])[1]?.trim() || KEYWORD;
  const para = `Plan the first visit for ${kw} when the ground is dry enough to walk on without leaving prints. Clear leaves from the beds, check the edges, and note where water sits after rain. A short list written on the first warm weekend saves a lot of guessing later in the season.`;
  const body = social
    ? `Spring is a good time for ${kw}. Walk the yard once, note the soft spots and the beds that need edging, and book the first visit before the busy weeks.`
    : [`Getting ${kw} right starts with one walk around the yard.`, '', `## What ${kw} looks like in the first week`, '', ...Array(8).fill(para)].join('\n');
  const text = JSON.stringify({
    title: `${kw.charAt(0).toUpperCase()}${kw.slice(1)}: a first-week checklist`,
    body_markdown: body,
    meta_description: `A plain first-week checklist for ${kw}: what to look at, what to note, and when to book the first visit before the season gets busy.`,
    url_slug: kw.replace(/\s+/g, '-'),
    cover_image_prompt: 'A tidy spring lawn in morning light.',
    confidence_note: 'Exercise stand-in text.',
  });
  return { inputTokens: 100, outputTokens: 200, imageCount: 0, data: { text } };
}
const replyStandIn = async (prompt) => ({ text: /2-star|1-star|3-star/.test(prompt.user) ? 'Thank you for telling us. We are sorry the visit fell short and would like to put it right.' : 'Thank you for the kind words. We are glad the yard looks good.', inputTokens: 50, outputTokens: 30 });

const published = [];
const doors = {
  ...AUTOMATIC_DOORS,
  publish: async (_p, a) => { published.push(a.outputId); return { ok: true, standIn: true }; },
};

/* ── what the runner wrote ─────────────────────────────────────────────── */
async function contentRows(runIds) {
  if (!runIds.length) return [];
  const req = pool.request();
  const names = runIds.map((id, i) => { req.input(`r${i}`, sql.UniqueIdentifier, id); return `@r${i}`; });
  const r = await req.query(`SELECT o.output_id, o.run_id, o.content_type, o.job_key, o.review_status, o.approved_in_advance,
                                    o.reviewed_by, o.brief_cited_json, o.scheduled_social_post_id, o.handoff_error_plain
                               FROM arion.content_agent_output o WHERE o.run_id IN (${names.join(', ')})`);
  return r.recordset;
}
async function contentRuns(since) {
  const r = await pool.request()
    .input('t', sql.UniqueIdentifier, tenantId).input('since', sql.DateTimeOffset, since)
    .query(`SELECT run_id, job_key, playbook_version, status, decision_rule_flags_json, error_detail
              FROM arion.content_agent_run_log WHERE tenant_id = @t AND triggered_at >= @since ORDER BY triggered_at`);
  return r.recordset;
}
async function replyRows(since) {
  const r = await pool.request()
    .input('t', sql.UniqueIdentifier, tenantId).input('since', sql.DateTimeOffset, since)
    .query(`SELECT d.draft_id, d.run_id, d.gbp_review_id, d.star_rating, d.status, d.held_reason, d.decided_by
              FROM arion.gbp_reply_draft d WHERE d.tenant_id = @t AND d.created_at >= @since ORDER BY d.created_at`);
  return r.recordset;
}
async function replyRuns(since) {
  const r = await pool.request()
    .input('t', sql.UniqueIdentifier, tenantId).input('since', sql.DateTimeOffset, since)
    .query(`SELECT run_id, status, outcome, drafted, held, posted, playbook_version, notes_json
              FROM arion.gbp_reply_run WHERE tenant_id = @t AND started_at >= @since ORDER BY started_at`);
  return r.recordset;
}

/* ── the fake Google profile, keyed by the business's connected site ───── */
const sites = (await pool.request().input('t', sql.UniqueIdentifier, tenantId).query(`
  SELECT site_id, gbp_location_name, arion_tier FROM arion.site
   WHERE tenant_id = @t AND gbp_connected = 1 AND gbp_oauth_token_ref IS NOT NULL AND gbp_location_name IS NOT NULL`)).recordset;
const fakeFile = path.join(os.tmpdir(), `exercise-gbp-${process.pid}.json`);
function seedReviews(tag) {
  const all = fs.existsSync(fakeFile) ? JSON.parse(fs.readFileSync(fakeFile, 'utf8')) : {};
  for (const s of sites) {
    const loc = all[s.gbp_location_name] || (all[s.gbp_location_name] = { reviews: [], replies: [] });
    loc.reviews.push(
      { reviewId: `exercise-${tag}-2`, reviewerName: 'Sam', starRating: 2, comment: 'Late twice and the edges were missed.' },
      { reviewId: `exercise-${tag}-5`, reviewerName: 'Lee', starRating: 5, comment: 'Great job on the spring clean-up.' },
    );
  }
  fs.writeFileSync(fakeFile, JSON.stringify(all, null, 2));
}

/* ── the scenarios ─────────────────────────────────────────────────────── */
const started = new Date(Date.now() - 1000);
const createdRuns = [];
const createdReplyRuns = [];
const scenarios = ['off', 'review', 'automatic'];
const playbooks = {};
for (const k of [JOB.BLOG, JOB.SOCIAL, JOB.REVIEWS]) playbooks[k] = await starter(k);
out({ exercise: 'web person', tenant: tenantId, brief: briefMode, starter_versions: Object.fromEntries(Object.entries(playbooks).map(([k, v]) => [k, v.version])), connected_sites: sites.length });

for (const scenario of scenarios) {
  for (const jobKey of [JOB.BLOG, JOB.SOCIAL]) {
    const since = new Date(Date.now() - 1000);
    const state = scenario === 'off' ? null : stateFor(jobKey, playbooks[jobKey], scenario === 'automatic' ? 'automatic' : 'review');
    const summary = await runTick({
      pool, env: {}, tenantFilter: tenantId, jobKeys: [jobKey], triggerSource: 'manual',
      jobsOn: jobsOnFor(state), briefFor, doResearch: research, notify: async () => [],
      callImpl: contentStandIn,
      cycle: (args) => runCycle({ ...args, doors }),
      log: () => {},
    });
    // Only runs this step created (a run seen in an earlier step is not repeated).
    const runs = (await contentRuns(started)).filter((r) => !createdRuns.includes(r.run_id));
    createdRuns.push(...runs.map((r) => r.run_id));
    const rows = await contentRows(runs.map((r) => r.run_id));
    out({
      scenario, job: jobKey, ran: summary.ran, results: summary.results.map((r) => ({ status: r.status, outcome: r.outcome, drafted: r.drafted, approvedInAdvance: r.approvedInAdvance, words: r.words })),
      run_rows: runs.map((r) => ({ job_key: r.job_key, playbook_version: r.playbook_version, status: r.status, flags: r.decision_rule_flags_json, error: r.error_detail })),
      output_rows: rows.map((o) => ({ job_key: o.job_key, review_status: o.review_status, approved_in_advance: o.approved_in_advance, reviewed_by: o.reviewed_by, brief_cited: o.brief_cited_json, social_post: o.scheduled_social_post_id, handoff_error: o.handoff_error_plain })),
      publish_stand_in_calls: published.splice(0),
    });
  }

  // Google review replies.
  const since = new Date(Date.now() - 1000);
  seedReviews(`${scenario}-${Date.now()}`);
  const state = scenario === 'off' ? null : stateFor(JOB.REVIEWS, playbooks[JOB.REVIEWS], scenario === 'automatic' ? 'automatic' : 'review');
  const summary = await runReviewReplyTick(pool, () => {}, {
    jobsOn: jobsOnFor(state), briefFor, api: fakeApi(fakeFile), tenantFilter: tenantId, triggerSource: 'manual', callImpl: replyStandIn,
  });
  const fake = JSON.parse(fs.readFileSync(fakeFile, 'utf8'));
  const newReplyRuns = (await replyRuns(started)).filter((r) => !createdReplyRuns.includes(r.run_id));
  createdReplyRuns.push(...newReplyRuns.map((r) => r.run_id));
  out({
    scenario, job: JOB.REVIEWS, tenants: summary.tenants, drafted: summary.drafted, held: summary.held, posted: summary.posted, errors: summary.errors,
    run_rows: newReplyRuns,
    reply_rows: (await replyRows(started)).filter((d) => newReplyRuns.some((r) => r.run_id === d.run_id))
      .map((d) => ({ review: d.gbp_review_id, stars: d.star_rating, status: d.status, held_reason: d.held_reason, decided_by: d.decided_by })),
    fake_profile_replies: Object.values(fake).reduce((n, l) => n + (l.replies || []).length, 0),
  });
}

/* ── tidy up what this run wrote (unless --keep) ───────────────────────── */
if (!keep) {
  // Only the rows THIS run created, by their run ids.
  // The Automatic social scenario hands its post to LUMEN for real, which
  // writes a draft in core.tenant_social_post (and its targets). Its id is on
  // the output row (scheduled_social_post_id), so it is read BEFORE the
  // outputs go and removed with them: "removed what this exercise wrote"
  // must be true.
  const socialPostIds = [...new Set((await contentRows(createdRuns))
    .map((o) => o.scheduled_social_post_id).filter((id) => GUID.test(String(id || ''))).map(String))];
  const req = pool.request().input('t', sql.UniqueIdentifier, tenantId);
  const cr = createdRuns.map((id, i) => { req.input(`c${i}`, sql.UniqueIdentifier, id); return `@c${i}`; });
  const rr = createdReplyRuns.map((id, i) => { req.input(`g${i}`, sql.UniqueIdentifier, id); return `@g${i}`; });
  const sp = socialPostIds.map((id, i) => { req.input(`p${i}`, sql.UniqueIdentifier, id); return `@p${i}`; });
  const parts = [];
  if (rr.length) {
    parts.push(`DELETE FROM arion.gbp_reply_draft WHERE tenant_id = @t AND run_id IN (${rr.join(', ')});`);
    parts.push(`DELETE FROM arion.gbp_reply_run WHERE tenant_id = @t AND run_id IN (${rr.join(', ')});`);
  }
  if (sp.length) {
    parts.push(`DELETE FROM core.tenant_social_post_target WHERE post_id IN (${sp.join(', ')});`);
    parts.push(`DELETE FROM core.tenant_social_post WHERE tenant_id = @t AND post_id IN (${sp.join(', ')});`);
  }
  if (cr.length) {
    parts.push(`DELETE FROM arion.content_agent_output WHERE tenant_id = @t AND run_id IN (${cr.join(', ')});`);
    parts.push(`DELETE FROM arion.content_agent_run_log WHERE tenant_id = @t AND run_id IN (${cr.join(', ')});`);
  }
  parts.push(`DELETE FROM arion.content_keyword_candidate WHERE tenant_id = @t AND keyword = N'${KEYWORD}';`);
  await req.query(parts.join(' '));
  out({ cleanup: `removed what this exercise wrote: ${createdRuns.length} content run(s) and their drafts, ${socialPostIds.length} social post draft(s) the hand-off made, ${createdReplyRuns.length} review run(s) and their replies, the stand-in keyword`, note: 'metering audit rows and the dev wallet are left as every dev run leaves them' });
}
fs.rmSync(fakeFile, { force: true });
await pool.close?.();
await platform.close?.();
process.exit(0);
