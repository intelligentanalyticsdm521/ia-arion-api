// lib/teamSeam.js — how a runner asks "is this job on, and how?" and "what
// does this business's Brief say?", without crashing when the answer cannot
// be had.
//
// The two readers are lib/team/jobState.js (`jobsOn`) and lib/team/brief.js
// (`briefFor`), written by the data stream of the ARGUS employees build
// (CONTRACT_ARGUS_EMPLOYEES_PHASE1 §C.2, §E.4). Every runner here takes them
// as injectable dependencies; these are the defaults.
//
// FAIL CLOSED, NEVER CRASH. They are loaded lazily, on first use. A reader
// that is missing, fails to load, or throws answers `{ ok: false, error }`,
// which every runner reads as "do nothing this tick and say why". It never
// reads as "off" (that would be a decision) and never as "on" (that would be
// acting on "we don't know"). A failure is not cached, so the next tick asks
// again.

async function loadFn(relPath, name) {
  const mod = await import(relPath);
  if (typeof mod[name] !== 'function') throw new Error(`${relPath} has no ${name}()`);
  return mod[name];
}

/** jobsOn(jobKeys, opts) -> { ok: true, on } | { ok: false, error }. Never throws. */
export async function jobsOn(jobKeys, opts = {}) {
  try {
    const fn = await loadFn('./team/jobState.js', 'jobsOn');
    const out = await fn(jobKeys, opts);
    if (!out || (out.ok === true && !(out.on instanceof Map))) {
      return { ok: false, error: 'the job-state reader gave an answer with no list of jobs' };
    }
    return out;
  } catch (err) {
    console.error(`[team] could not read which jobs are on: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/** briefFor(tenantId) -> { ok: true, brief } | { ok: false, error }. Never throws. */
export async function briefFor(tenantId, opts = {}) {
  try {
    const fn = await loadFn('./team/brief.js', 'briefFor');
    const out = await fn(tenantId, opts);
    if (!out || (out.ok === true && !out.brief)) return { ok: false, error: 'the Brief reader gave an empty answer' };
    return out;
  } catch (err) {
    console.error(`[team] could not read the business details for ${tenantId}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

export default { jobsOn, briefFor };
