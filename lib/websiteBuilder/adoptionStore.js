/**
 * arion.site_section_adoption — read and write.
 * ---------------------------------------------------------------------------
 * Migration db/migrations/061_site_section_adoption.sql.
 *
 * One row per section the client has told us to take charge of. It carries the
 * ORIGINAL Elementor bytes, which is the whole reason the table exists: the
 * plugin's Undo ring is whole-page, 20 deep and shared with every ordinary
 * save, so it cannot answer "put this one section back exactly as it was, a
 * fortnight and thirty edits later". This can.
 *
 * THE ONE RULE HERE
 *
 * Unlike `proposalStore`, a failure to store is NOT best-effort. A proposal
 * that fails to record still leaves the client with a proposal they can read;
 * an adoption that fails to record leaves them with a rewritten section and no
 * way back. So `recordAdoption` is called BEFORE the write and its failure
 * stops the write (`reference_catch_swallow_report_success` — the failure mode
 * here would be a green toast over a one-way door).
 */

import sql from 'mssql';

const TABLE = 'arion.site_section_adoption';

/** Big enough for a real hand-built section; a page is 60 of these at most. */
const MAX_NODE_BYTES = 2_000_000;

export class AdoptionTooBigError extends Error {
  constructor(bytes) {
    super(`section is ${bytes} bytes, over the ${MAX_NODE_BYTES} we can keep for Undo`);
    this.name = 'AdoptionTooBigError';
    this.code = 'SECTION_TOO_BIG';
  }
}

function encodeNode(node) {
  const s = JSON.stringify(node ?? null);
  if (s.length > MAX_NODE_BYTES) throw new AdoptionTooBigError(s.length);
  return s;
}

/**
 * Write the adoption record. Called BEFORE the page write, so that a section
 * can never reach the website without its way back already stored.
 *
 * Throws on failure — deliberately. The caller turns that into a plain 500
 * with "nothing was changed", which is true because nothing has been written
 * yet at that point.
 */
export async function recordAdoption(pool, {
  adoptionId, tenantId, siteId, pageId, sectionIndex,
  handle, kind, confidence, originalNode, adoptedNode, unmapped = [], actorEmail = null,
}) {
  await pool.request()
    .input('adoption_id', sql.UniqueIdentifier, adoptionId)
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .input('site_id', sql.UniqueIdentifier, siteId)
    .input('page_id', sql.Int, pageId)
    .input('section_index', sql.Int, sectionIndex)
    .input('handle', sql.NVarChar(200), String(handle || '').slice(0, 200))
    .input('kind', sql.NVarChar(40), String(kind || '').slice(0, 40))
    .input('confidence', sql.Decimal(4, 3), Number(confidence) || 0)
    .input('original_json', sql.NVarChar(sql.MAX), encodeNode(originalNode))
    .input('adopted_json', sql.NVarChar(sql.MAX), encodeNode(adoptedNode))
    .input('unmapped_json', sql.NVarChar(sql.MAX), JSON.stringify(unmapped || []))
    .input('actor_email', sql.NVarChar(320), actorEmail)
    .query(`INSERT INTO ${TABLE}
              (adoption_id, tenant_id, site_id, page_id, section_index, handle, kind,
               confidence, original_json, adopted_json, unmapped_json, actor_email, status)
            VALUES
              (@adoption_id, @tenant_id, @site_id, @page_id, @section_index, @handle, @kind,
               @confidence, @original_json, @adopted_json, @unmapped_json, @actor_email, 'adopted')`);
  return { ok: true, adoptionId };
}

/** One adoption, scoped to the caller's own business. */
export async function getAdoption(pool, { tenantId, siteId, adoptionId }) {
  const r = await pool.request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .input('site_id', sql.UniqueIdentifier, siteId)
    .input('adoption_id', sql.UniqueIdentifier, adoptionId)
    .query(`SELECT TOP 1 * FROM ${TABLE}
             WHERE tenant_id = @tenant_id AND site_id = @site_id AND adoption_id = @adoption_id`);
  return r.recordset[0] || null;
}

/**
 * Every adoption on one page that has not been reverted — what the Portal
 * needs to put an "adopted · Undo adoption" note on a row.
 *
 * `original_json` is deliberately NOT selected: the list is rendered on every
 * page open and a page of adopted sections would drag megabytes of Elementor
 * JSON through the API for a note that says four words.
 */
export async function listAdoptions(pool, { tenantId, siteId, pageId, limit = 60 }) {
  const r = await pool.request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .input('site_id', sql.UniqueIdentifier, siteId)
    .input('page_id', sql.Int, pageId)
    .input('limit', sql.Int, Math.max(1, Math.min(Number(limit) || 60, 200)))
    .query(`SELECT TOP (@limit) adoption_id, page_id, section_index, handle, kind, confidence,
                   status, actor_email, adopted_at, reverted_at, unmapped_json
              FROM ${TABLE}
             WHERE tenant_id = @tenant_id AND site_id = @site_id AND page_id = @page_id
             ORDER BY adopted_at DESC`);
  return r.recordset || [];
}

/**
 * Mark an adoption reverted. Only a row still at `adopted` moves, so a double
 * tap on "Undo adoption" cannot put the original back twice — the second tap
 * gets "there is nothing to undo here" instead of quietly overwriting whatever
 * the client has typed since.
 *
 * @returns {Promise<number>} rows actually moved (0 or 1)
 */
export async function markReverted(pool, { tenantId, siteId, adoptionId }) {
  const r = await pool.request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .input('site_id', sql.UniqueIdentifier, siteId)
    .input('adoption_id', sql.UniqueIdentifier, adoptionId)
    .query(`UPDATE ${TABLE}
               SET status = 'reverted', reverted_at = SYSUTCDATETIME()
             WHERE tenant_id = @tenant_id AND site_id = @site_id
               AND adoption_id = @adoption_id AND status = 'adopted';
            SELECT @@ROWCOUNT AS moved;`);
  return Number(r.recordset?.[0]?.moved || 0);
}

export const __test__ = { TABLE, MAX_NODE_BYTES, encodeNode };
