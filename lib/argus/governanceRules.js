// lib/argus/governanceRules.js — the ARGUS shared escalation rules, read from where they live.
//
// A copy of the matcher in `oliver-api/lib/governance/rules.js`
// (`evaluateEscalation` + `loadEscalationMatcher`), which is the origin. LUMEN
// holds the third copy. Three copies because the agents run in three deployments
// with no shared package — the same arrangement the notification-gate client has
// across five repos — and a contract test in each repo asserts they have not
// drifted.
//
// WHY THIS EXISTS AT ALL. `argus.governance_rule` has born-inactive semantics,
// edit-deactivates-and-bumps-version semantics, a full CRUD API and a working
// matcher — and until ARGUS pack 1 the matcher had NO CALLER outside its own test
// file. Every agent kept its own hard-coded guardrails and the governance index
// copied each agent's own flags column through. So a rule Brandon wrote, saved and
// activated changed NOTHING about what any agent produced, on a page that
// reasonably reads as though it did.
//
// FAIL DIRECTION. Rules we cannot read are reported as `unavailable` and the
// matcher then escalates NOTHING. Deliberate, and the same choice the suite
// ceiling makes: every agent keeps its own hard-coded boundary-language check as
// the inner ring, so an unreadable rule table cannot let a forbidden phrase
// through — it can only fail to apply the EXTRA rules a founder added. Failing
// closed would stop every agent on every business the moment a GRANT is missing
// (the live S-6 gap on SCHEMA::argus), which is worse. The run records
// `unavailable` either way, so it is never silent.

import sql from 'mssql';

const safeJson = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

/** ACTIVE escalation rules for one business. */
export async function listActiveEscalationRules(pool, tenantId) {
  const r = await pool.request()
    .input('tenantId', sql.NVarChar(100), String(tenantId))
    .query(`SELECT rule_id, name, rule_type, rule_definition, applies_to_agents, active
              FROM argus.governance_rule
             WHERE tenant_id = @tenantId AND active = 1 AND rule_type = 'escalation'`);
  return r.recordset.map((x) => ({
    ...x,
    rule_definition: safeJson(x.rule_definition, {}),
    applies_to_agents: safeJson(x.applies_to_agents, null),
  }));
}

/**
 * Pure enforcement — no reasoning, no model. Byte-identical in intent to
 * oliver-api/lib/governance/rules.js:129.
 */
export function evaluateEscalation(text, rules, agentKey) {
  const hits = [];
  const body = String(text || '');
  for (const rule of rules) {
    if (!rule.active) continue;
    if (rule.rule_type !== 'escalation') continue;
    const scope = rule.applies_to_agents;
    if (Array.isArray(scope) && scope.length && !scope.includes(agentKey)) continue;
    for (const pattern of rule.rule_definition?.match?.any_of || []) {
      let re;
      try { re = new RegExp(pattern, 'i'); } catch { continue; }
      const m = body.match(re);
      if (m) { hits.push({ rule_id: rule.rule_id, name: rule.name, matched: m[0], pattern }); break; }
    }
  }
  return { escalate: hits.length > 0, hits };
}

/** Loaded ONCE per cycle, not once per draft. */
export async function loadEscalationMatcher(pool, tenantId, agentKey) {
  let rules = [];
  let unavailable = null;
  try {
    rules = await listActiveEscalationRules(pool, tenantId);
  } catch (err) {
    unavailable = err.message;
  }
  return {
    ruleCount: rules.length,
    unavailable,
    match: (text) => (unavailable ? { escalate: false, hits: [] } : evaluateEscalation(text, rules, agentKey)),
  };
}

export default { listActiveEscalationRules, evaluateEscalation, loadEscalationMatcher };
