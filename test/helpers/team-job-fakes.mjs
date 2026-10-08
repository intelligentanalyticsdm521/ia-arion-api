// test/helpers/team-job-fakes.mjs — stand-ins for the two readers a runner
// asks before it works: "is this job on, and how?" (jobsOn) and "what does
// the Brief say?" (briefFor), shaped exactly as CONTRACT_ARGUS_EMPLOYEES_
// PHASE1 §C.2 and §E.4 declare them. The starter playbooks are the §D.1/§D.3
// shapes that migration 042 seeds.

const CONTENT_READS = ['brief.services', 'brief.servicesSummary', 'brief.serviceArea', 'brief.brandVoice', 'brief.doNotSay',
  'brief.noGoList', 'brief.idealCustomer', 'brief.differentiators', 'brief.offersAllowed', 'brief.proofAllowed',
  'brief.namesNeverMention', 'brief.namesYouMayMention', 'brief.competitors', 'brief.customerWords'];
const CONTENT_CHECKS = ['no_price', 'offers_from_brief_only', 'no_invented_proof',
  'no_names_from_never_name', 'no_competitor_names', 'no_ranking_promise'];

export const STARTERS = Object.freeze({
  'arion.blog_posts': {
    schema: 'agent-job/1', job: 'arion.blog_posts', name: 'Blog posts',
    trigger: { type: 'schedule', every: 'week', day: 'mon' },
    reads: CONTENT_READS,
    steps: [
      { id: 'pick', action: 'arion.pick_topic', words: 'Picks a topic people near you search for' },
      { id: 'write', action: 'arion.draft_blog_post', words: 'Writes the post from what I know about your business' },
      { id: 'check', checks: CONTENT_CHECKS, words: 'Checks it against what I never do' },
      { id: 'post', action: 'arion.publish_blog_post', hold: 'by_mode', words: 'Puts it on your website' },
    ],
    vars: {
      posts_per_week: { label: 'Posts a week', type: 'int', default: 1, min: 1, max: 3 },
      seed_topics: { label: 'Topics to lean towards', type: 'list', default: [], max_items: 10, max_len: 80 },
    },
  },
  'arion.social_posts': {
    schema: 'agent-job/1', job: 'arion.social_posts', name: 'Social posts',
    trigger: { type: 'schedule', every: 'week', day: 'mon' },
    reads: CONTENT_READS,
    steps: [
      { id: 'pick', action: 'arion.pick_topic', words: 'Picks a topic people near you search for' },
      { id: 'write', action: 'arion.draft_social_post', words: 'Writes the post' },
      { id: 'check', checks: CONTENT_CHECKS, words: 'Checks it against what I never do' },
      { id: 'post', action: 'arion.schedule_social_post', hold: 'by_mode', words: 'Schedules it on your social accounts' },
    ],
    vars: {
      posts_per_week: { label: 'Posts a week', type: 'int', default: 2, min: 1, max: 7 },
      seed_topics: { label: 'Topics to lean towards', type: 'list', default: [], max_items: 10, max_len: 80 },
      post_time: { label: 'Time to post', type: 'time', default: '10:00' },
    },
  },
  'arion.review_replies': {
    schema: 'agent-job/1', job: 'arion.review_replies', name: 'Google review replies',
    trigger: { type: 'schedule', every: 'day' },
    reads: ['brief.brandVoice', 'brief.doNotSay', 'brief.offersAllowed', 'brief.namesNeverMention', 'brief.competitors', 'brief.businessName'],
    steps: [
      { id: 'read', action: 'arion.read_new_reviews', words: 'Reads your new Google reviews' },
      { id: 'write', action: 'arion.draft_review_reply', words: 'Writes a reply in your voice' },
      { id: 'check', checks: ['no_price', 'offers_from_brief_only', 'no_names_from_never_name', 'no_competitor_names', 'low_star_review_asks', 'hold_complaint_legal_refund'], words: 'Checks it against what I never do' },
      { id: 'post', action: 'arion.post_review_reply', hold: 'by_mode', words: 'Posts the reply on Google' },
    ],
    vars: { automatic_min_stars: { label: 'Answer by itself from', type: 'stars', default: 4, min: 4, max: 5 } },
  },
});

/** One JobState (§C.2). */
export function jobState(tenantId, jobKey, over = {}) {
  const def = over.def || STARTERS[jobKey];
  const vars = {};
  for (const [k, v] of Object.entries(def?.vars || {})) vars[k] = v.default;
  return {
    jobKey, tenantId, employeeKey: 'web', mode: 'review', modeSetBy: null, modeSetAt: null,
    vars: { ...vars, ...(over.vars || {}) },
    playbook: { id: 'pb-' + jobKey, version: over.version ?? 1, def },
    ...Object.fromEntries(Object.entries(over).filter(([k]) => !['def', 'vars', 'version'].includes(k))),
  };
}

/**
 * jobsOn stand-in. `on` = { tenantId: [jobKey | [jobKey, overrides]] }.
 * Records every call in `.calls`.
 */
export function fakeJobsOn(on = {}) {
  const fn = async (jobKeys, opts = {}) => {
    fn.calls.push({ jobKeys, opts });
    const map = new Map();
    for (const [tenantId, jobs] of Object.entries(on)) {
      if (opts.tenantId && String(opts.tenantId).toUpperCase() !== tenantId.toUpperCase()) continue;
      const inner = new Map();
      for (const j of jobs) {
        const [key, over] = Array.isArray(j) ? j : [j, {}];
        if (jobKeys.includes(key)) inner.set(key, jobState(tenantId, key, over));
      }
      if (inner.size) map.set(tenantId.toUpperCase(), inner);
    }
    return { ok: true, on: map };
  };
  fn.calls = [];
  return fn;
}

export const JOBS_UNREADABLE = async () => ({ ok: false, error: 'platform database unreachable' });

/** A saved Brief (§E.4). `fields` = { api: value } for answers that are set. */
export function brief(fields = {}, { version = 7, savedAt = '2026-10-02T14:10:00Z', businessName = 'The Business' } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = { set: true, value: v };
  return { tenantId: null, version, saved_at: savedAt, fields: out, borrowed: { businessName } };
}

export const BRIEF_WITH_SERVICES = brief({ services: [{ name: 'Lawn care' }, 'Hedge trimming'], serviceArea: { cities: ['Springfield'] } });

export function fakeBriefFor(b = BRIEF_WITH_SERVICES) {
  const fn = async (tenantId) => { fn.calls.push(tenantId); return { ok: true, brief: { ...b, tenantId } }; };
  fn.calls = [];
  return fn;
}

export const BRIEF_UNREADABLE = async () => ({ ok: false, error: 'platform-api answered 503' });
