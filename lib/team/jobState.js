// lib/team/jobState.js — "which businesses have this job ON, and how?"
//
// The read half of ARGUS employees, phase 1 (CONTRACT_ARGUS_EMPLOYEES_PHASE1
// §C.2). The switches live in the platform database (core.team_job_setting,
// platform-api migration 042) and platform-api is their only writer. This
// file only reads, one statement per tick, on the platform pool every runner
// already holds for the ownership check.
//
// A DECLARED COPY of LUMEN src/lib/team/jobState.js (same rule, same SQL, same
// words; ESM here, CommonJS there). Change both. The shared fixture
// test/fixtures/agent-jobs-contract.json pins the SQL text in both repos and
// in platform-api, and each repo's test hashes its copy of the fixture.
//
// FAILS CLOSED FOR ACTING. A job does something for a business ONLY when all
// of these hold, and anything else reads as "do nothing":
//   - a setting row exists with enabled = 1 (no row = off: born off)
//   - the job is 'live' and its switch lives on the team (setting_home 'team')
//   - the job needs no hire, or the business has an active hire for that
//     employee, or the business is the platform owner or an agency
//   - the pinned job description can be read, parses, and is for this job
//     (otherwise it is logged at error and dropped: it does nothing)
// The mode is Automatic only when the job allows a choice (mode_rule 'either')
// and the row says 'automatic'; anything else is "Send me first".
//
// NEVER ACTS ON "WE DON'T KNOW", AND NEVER DENIES ON IT EITHER. When the
// platform database cannot be read the answer is { ok: false, error } and the
// runner does nothing this tick and records the reason on its run row. It
// never writes "off" and never returns a partial or a remembered map. This is
// deliberately the OPPOSITE direction from lib/productOwnership.js ("unknown =
// runs as before"): ownership is a decision to DENY, a job switch is a
// decision to ACT. A future reader must not "fix" one to match the other
// (finding F9).
//
// No caching for timers (one query per tick). jobStateFor() keeps a 60-second
// cache of ok:true answers for one business, for per-event callers; an ok:false
// answer is never cached.

import sql from "mssql";

/** The one statement (iadm_platform). Pinned verbatim by the shared fixture. */
export const JOB_STATE_SQL = `SELECT s.tenant_id, s.job_key, s.mode, s.mode_set_by, s.mode_set_at, s.vars_json, s.playbook_id, s.playbook_version,
       j.state, j.setting_home, j.mode_rule, j.hire_required, j.employee_key, v.definition_json, t.tenant_kind,
       CASE WHEN EXISTS (SELECT 1 FROM core.team_hire h
                          WHERE h.tenant_id = s.tenant_id AND h.employee_key = j.employee_key AND h.ended_at IS NULL)
            THEN 1 ELSE 0 END AS hired
  FROM core.team_job_setting s
  JOIN core.team_job j  ON j.job_key = s.job_key
  JOIN core.tenants  t  ON t.tenant_id = s.tenant_id
  LEFT JOIN core.team_job_playbook_version v ON v.playbook_id = s.playbook_id AND v.version = s.playbook_version
 WHERE s.enabled = 1 AND s.job_key IN ({keys}){only}`;

export const CACHE_TTL_MS = 60 * 1000;
const AGENCY_KINDS = new Set(["platform_owner", "agency"]);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const _cache = new Map(); // `${TENANT}|${keys}` -> { at, answer }

export function clearJobStateCache() { _cache.clear(); }

const truthy = (v) => v === true || v === 1 || v === "1";
const upper = (v) => String(v || "").trim().toUpperCase();
function isObj(v) { return v != null && typeof v === "object" && !Array.isArray(v); }

/** The same limits platform-api's validator holds a var to (lib/team/definition.js varProblem). */
export function varInLimits(spec, value) {
  switch (spec?.type) {
    case "int":
    case "stars":
      return Number.isInteger(value) && value >= spec.min && value <= spec.max;
    case "list":
      return Array.isArray(value) && value.length <= spec.max_items
        && value.every((x) => typeof x === "string" && x.trim() && x.length <= spec.max_len);
    case "choice":
      return Array.isArray(spec.options) && spec.options.includes(value);
    case "time":
      return typeof value === "string" && TIME_RE.test(value);
    default:
      return false;
  }
}

/** The description's defaults overlaid by the owner's values; a bad stored value falls back to the default. */
export function resolveVars(defs, stored, { log = console, where = "" } = {}) {
  const out = {};
  const over = isObj(stored) ? stored : {};
  for (const [name, spec] of Object.entries(isObj(defs) ? defs : {})) {
    out[name] = spec?.default;
    if (!Object.prototype.hasOwnProperty.call(over, name)) continue;
    if (varInLimits(spec, over[name])) out[name] = over[name];
    else log.error?.(`[job-state] ${where} setting '${name}' is outside its limits; using ${JSON.stringify(spec?.default)}`);
  }
  return out;
}

function parseJson(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return null; }
}

/**
 * One row of JOB_STATE_SQL -> a JobState, or null (and the reason) when it
 * may not act.
 */
export function rowToJobState(row, { log = console } = {}) {
  const jobKey = String(row.job_key || "");
  const tenantId = upper(row.tenant_id);
  if (row.state !== "live") return { state: null, why: `${jobKey} is not built yet` };
  if (row.setting_home !== "team") return { state: null, why: `${jobKey} is not switched on the team` };
  const kind = String(row.tenant_kind || "").trim().toLowerCase();
  if (truthy(row.hire_required) && !truthy(row.hired) && !AGENCY_KINDS.has(kind)) {
    return { state: null, why: `${jobKey} needs ${row.employee_key} on the team` };
  }
  const def = parseJson(row.definition_json);
  if (!isObj(def) || def.job !== jobKey) {
    log.error?.(`[job-state] ${jobKey} is on for ${tenantId} with no readable playbook; it does nothing`);
    return { state: null, why: `${jobKey} has no readable job description` };
  }
  const mode = row.mode_rule === "either" && row.mode === "automatic" ? "automatic" : "review";
  return {
    state: {
      jobKey,
      tenantId,
      employeeKey: row.employee_key,
      mode,
      modeSetBy: row.mode_set_by ?? null,
      modeSetAt: row.mode_set_at instanceof Date ? row.mode_set_at.toISOString() : (row.mode_set_at ?? null),
      vars: resolveVars(def.vars, parseJson(row.vars_json), { log, where: `${jobKey} for ${tenantId}:` }),
      playbook: { id: row.playbook_id, version: Number(row.playbook_version), def },
    },
  };
}

/**
 * jobsOn(jobKeys, { tenantId = null, pool, getPool, log = console }) ->
 *   { ok: true,  on: Map<TENANT_ID_UPPER, Map<jobKey, JobState>> }   // only jobs that may act
 *   { ok: false, error: string }                                      // could not read: act on nothing
 */
export async function jobsOn(jobKeys, opts = {}) {
  const log = opts.log || console;
  const keys = [...new Set((Array.isArray(jobKeys) ? jobKeys : []).map(String).filter(Boolean))];
  if (!keys.length) return { ok: false, error: "no job was named" };
  let rows;
  try {
    let pool = opts.pool;
    if (!pool) {
      const get = opts.getPool || (await import("../../db/platformPool.js")).getPlatformPool;
      pool = await get();
    }
    if (!pool || typeof pool.request !== "function") throw new Error("no platform database connection");
    const req = pool.request();
    keys.forEach((k, i) => req.input(`k${i}`, sql.NVarChar(80), k));
    let only = "";
    if (opts.tenantId) {
      req.input("only", sql.UniqueIdentifier, String(opts.tenantId));
      only = " AND s.tenant_id = @only";
    }
    const text = JOB_STATE_SQL.replace("{keys}", keys.map((_, i) => `@k${i}`).join(", ")).replace("{only}", only);
    const r = await req.query(text);
    rows = r?.recordset;
    if (!Array.isArray(rows)) throw new Error("the platform database gave an answer this code does not understand");
  } catch (e) {
    const error = `could not read which jobs are on: ${e?.message || e}`;
    log.error?.(`[job-state] ${error} — nothing runs this tick`);
    return { ok: false, error };
  }
  const on = new Map();
  for (const row of rows) {
    const { state } = rowToJobState(row, { log });
    if (!state) continue;
    if (!on.has(state.tenantId)) on.set(state.tenantId, new Map());
    on.get(state.tenantId).set(state.jobKey, state);
  }
  return { ok: true, on };
}

/**
 * One business, one job, for per-event callers. → { ok: true, state: JobState|null } | { ok: false, error }
 * ok:true answers are cached for 60 seconds; ok:false never is.
 */
export async function jobStateFor(tenantId, jobKey, opts = {}) {
  const now = opts.now || Date.now;
  const key = `${upper(tenantId)}|${jobKey}`;
  const hit = _cache.get(key);
  if (hit && now() - hit.at < CACHE_TTL_MS) return hit.answer;
  const r = await jobsOn([jobKey], { ...opts, tenantId });
  if (!r.ok) return r;
  const answer = { ok: true, state: r.on.get(upper(tenantId))?.get(jobKey) || null };
  _cache.set(key, { at: now(), answer });
  return answer;
}

export default { JOB_STATE_SQL, jobsOn, jobStateFor, rowToJobState, resolveVars, varInLimits, clearJobStateCache, CACHE_TTL_MS };
