/**
 * arion.site_edit_proposal — read and write.
 * ---------------------------------------------------------------------------
 * Migration db/migrations/059_site_edit_proposal.sql.
 *
 * A proposal is what ARGUS AI suggested and what it cost. It is written the
 * moment the model answers, at status `proposed`, and it never becomes
 * `applied` until the save that carried it actually reached the website. That
 * ordering matters: stamping `applied` alongside the write, rather than before
 * it, is the difference between an audit trail and a story
 * (reference_catch_swallow_report_success).
 *
 * Discarding does not refund. The model call happened, the credits were
 * debited by ARGUS at call time, and the row keeps `credits_charged` so the
 * client can see what they paid for even when they threw the answer away.
 *
 * Every function here is best-effort about the TABLE and strict about the
 * DATA: if migration 059 has not been applied the writes return false and say
 * so in the log, because a missing audit row must never fail a client's edit
 * — but a write that claims to have happened and did not is never reported as
 * success.
 */

import sql from 'mssql';

const TABLE = 'arion.site_edit_proposal';
const MAX_JSON = 400_000; // a page's worth of field values, generously

function clip(value) {
  const s = JSON.stringify(value ?? null);
  return s.length > MAX_JSON ? JSON.stringify({ _truncated: true, bytes: s.length }) : s;
}

/**
 * Store a proposal. Returns { ok, stored } — `stored:false` means the row did
 * not land (table absent, for instance); the caller still returns the
 * proposal to the client, because the proposal itself is real.
 */
export async function saveProposal(pool, {
  proposalId, tenantId, siteId, pageId, scope,
  sectionHandle = null, sectionIndex = null, sectionKind = null,
  instruction, before, after, diffPlain, creditsCharged = null, model = null, actorEmail = null,
}) {
  try {
    await pool.request()
      .input('proposal_id', sql.UniqueIdentifier, proposalId)
      .input('tenant_id', sql.UniqueIdentifier, tenantId)
      .input('site_id', sql.UniqueIdentifier, siteId)
      .input('page_id', sql.Int, pageId)
      .input('scope', sql.NVarChar(10), scope)
      .input('section_handle', sql.NVarChar(200), sectionHandle)
      .input('section_index', sql.Int, sectionIndex)
      .input('section_kind', sql.NVarChar(40), sectionKind)
      .input('instruction', sql.NVarChar(2000), String(instruction || '').slice(0, 2000))
      .input('before_json', sql.NVarChar(sql.MAX), clip(before))
      .input('after_json', sql.NVarChar(sql.MAX), clip(after))
      .input('diff_plain', sql.NVarChar(sql.MAX), diffPlain == null ? null : String(diffPlain))
      .input('credits_charged', sql.Int, creditsCharged)
      .input('model', sql.NVarChar(64), model)
      .input('actor_email', sql.NVarChar(320), actorEmail)
      .query(`INSERT INTO ${TABLE}
                (proposal_id, tenant_id, site_id, page_id, scope, section_handle, section_index,
                 section_kind, instruction, before_json, after_json, diff_plain,
                 status, credits_charged, model, actor_email)
              VALUES
                (@proposal_id, @tenant_id, @site_id, @page_id, @scope, @section_handle, @section_index,
                 @section_kind, @instruction, @before_json, @after_json, @diff_plain,
                 'proposed', @credits_charged, @model, @actor_email)`);
    return { ok: true, stored: true };
  } catch (err) {
    console.warn('[siteEditProposal] could not record the proposal:', err?.message);
    return { ok: true, stored: false, reason: err?.message || 'insert failed' };
  }
}

/** One proposal, scoped to the caller's own business. */
export async function getProposal(pool, { tenantId, siteId, proposalId }) {
  const r = await pool.request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .input('site_id', sql.UniqueIdentifier, siteId)
    .input('proposal_id', sql.UniqueIdentifier, proposalId)
    .query(`SELECT TOP 1 * FROM ${TABLE}
             WHERE tenant_id = @tenant_id AND site_id = @site_id AND proposal_id = @proposal_id`);
  return r.recordset[0] || null;
}

/**
 * Move a proposal to `applied` or `discarded`. Only a row still at `proposed`
 * moves, so a double-tap on Approve cannot stamp the same proposal twice and
 * an already-discarded proposal cannot be resurrected by a stale save.
 *
 * @returns {Promise<number>} rows actually moved (0 or 1)
 */
export async function resolveProposal(pool, { tenantId, siteId, proposalId, status }) {
  if (status !== 'applied' && status !== 'discarded') {
    throw new Error(`resolveProposal: refusing unknown status "${status}"`);
  }
  const r = await pool.request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .input('site_id', sql.UniqueIdentifier, siteId)
    .input('proposal_id', sql.UniqueIdentifier, proposalId)
    .input('status', sql.NVarChar(12), status)
    .query(`UPDATE ${TABLE}
               SET status = @status, resolved_at = SYSUTCDATETIME()
             WHERE tenant_id = @tenant_id AND site_id = @site_id
               AND proposal_id = @proposal_id AND status = 'proposed';
            SELECT @@ROWCOUNT AS moved;`);
  return Number(r.recordset?.[0]?.moved || 0);
}

/**
 * Mark several proposals applied, after a save that actually reached the
 * site. Never throws — an audit stamp must not turn a successful publish into
 * an error the client sees.
 *
 * @returns {Promise<{ applied: number, ids: string[] }>}
 */
export async function markProposalsApplied(pool, { tenantId, siteId, proposalIds }) {
  const ids = [...new Set((proposalIds || []).map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 20);
  let applied = 0;
  const done = [];
  for (const id of ids) {
    try {
      const moved = await resolveProposal(pool, { tenantId, siteId, proposalId: id, status: 'applied' });
      if (moved) { applied += 1; done.push(id); }
    } catch (err) {
      console.warn('[siteEditProposal] could not stamp a proposal applied:', err?.message);
    }
  }
  return { applied, ids: done };
}

/** Recent proposals for one page — the "what has ARGUS changed here" list. */
export async function listProposals(pool, { tenantId, siteId, pageId, limit = 20 }) {
  const r = await pool.request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .input('site_id', sql.UniqueIdentifier, siteId)
    .input('page_id', sql.Int, pageId)
    .input('limit', sql.Int, Math.max(1, Math.min(Number(limit) || 20, 100)))
    .query(`SELECT TOP (@limit) proposal_id, scope, section_handle, section_index, section_kind,
                   instruction, diff_plain, status, credits_charged, actor_email, created_at, resolved_at
              FROM ${TABLE}
             WHERE tenant_id = @tenant_id AND site_id = @site_id AND page_id = @page_id
             ORDER BY created_at DESC`);
  return r.recordset || [];
}

export const __test__ = { clip, MAX_JSON, TABLE };
