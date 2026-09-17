/**
 * arion.site_page_draft — an unpublished draft held BESIDE a live page.
 * ---------------------------------------------------------------------------
 * Migration db/migrations/066_site_page_draft.sql.
 *
 * D-05 of BUILDER_USER_TEST_2026-09-16 — the most dangerous single behaviour
 * the walk found — was that "save without publishing" had only one spelling on
 * the wire: set the WordPress post to `draft`. That is the same wire as "take
 * this page off the internet", so pressing **Save draft** on a live home page
 * 404'd the site, silently.
 *
 * The fix is a place for unfinished work to live that is not the live page.
 * One row per page, holding the sections the author last saved. The live page
 * is not touched at all; the public URL never moves. Publishing writes the
 * draft through the ordinary save path and clears the row.
 *
 * ── BEST-EFFORT ABOUT THE TABLE, STRICT ABOUT THE DATA ────────────────────
 * Same rule as proposalStore.js, with the sign flipped where it matters:
 *
 *   READING a draft is best effort. A missing table, an unreadable row — the
 *   page still opens, on the live version, which is the truth.
 *
 *   WRITING one is NOT. `saveDraft` returns `{ ok: false }` when the row did
 *   not land, and the route turns that into a refusal the author can read.
 *   A "Saved" that saved nothing is the whole reason this file exists
 *   (reference_catch_swallow_report_success).
 */

import sql from 'mssql';

const TABLE = 'arion.site_page_draft';

/** A page's worth of sections, generously. Bigger than this is not a page. */
export const MAX_DRAFT_BYTES = 2_000_000;

/**
 * Store (or replace) the draft for one page.
 *
 * @returns {Promise<{ ok: boolean, savedAt?: string, reason?: string }>}
 */
export async function saveDraft(pool, {
  tenantId, siteId, pageId, sections, title = null, savedBy = null,
}) {
  const json = JSON.stringify(sections ?? []);
  if (json.length > MAX_DRAFT_BYTES) {
    return { ok: false, reason: 'That page is too big to hold as a draft. Publish it, or take a section off.' };
  }
  try {
    const r = await pool.request()
      .input('tenant_id', sql.UniqueIdentifier, tenantId)
      .input('site_id', sql.UniqueIdentifier, siteId)
      .input('page_id', sql.Int, pageId)
      .input('sections_json', sql.NVarChar(sql.MAX), json)
      .input('title', sql.NVarChar(400), title == null ? null : String(title).slice(0, 400))
      .input('saved_by', sql.NVarChar(320), savedBy == null ? null : String(savedBy).slice(0, 320))
      .query(`MERGE ${TABLE} WITH (HOLDLOCK) AS t
                USING (SELECT @tenant_id AS tenant_id, @site_id AS site_id, @page_id AS page_id) AS s
                   ON t.tenant_id = s.tenant_id AND t.site_id = s.site_id AND t.page_id = s.page_id
              WHEN MATCHED THEN UPDATE SET
                    sections_json = @sections_json, title = @title,
                    saved_at = SYSUTCDATETIME(), saved_by = @saved_by
              WHEN NOT MATCHED THEN INSERT
                    (tenant_id, site_id, page_id, sections_json, title, saved_by)
                    VALUES (@tenant_id, @site_id, @page_id, @sections_json, @title, @saved_by)
              OUTPUT INSERTED.saved_at AS saved_at;`);
    const savedAt = r.recordset?.[0]?.saved_at;
    if (!savedAt) return { ok: false, reason: 'The draft did not save. Nothing was changed on your website.' };
    return { ok: true, savedAt: new Date(savedAt).toISOString() };
  } catch (err) {
    console.warn('[sitePageDraft] could not save the draft:', err?.message);
    return { ok: false, reason: 'We could not hold that draft. Nothing was changed on your website.' };
  }
}

/**
 * The draft for one page, or null.
 *
 * Best effort: a page whose draft cannot be read still opens on what is live,
 * which is true, rather than refusing to open at all.
 */
export async function getDraft(pool, { tenantId, siteId, pageId }) {
  try {
    const r = await pool.request()
      .input('tenant_id', sql.UniqueIdentifier, tenantId)
      .input('site_id', sql.UniqueIdentifier, siteId)
      .input('page_id', sql.Int, pageId)
      .query(`SELECT TOP 1 sections_json, title, saved_at, saved_by FROM ${TABLE}
               WHERE tenant_id = @tenant_id AND site_id = @site_id AND page_id = @page_id`);
    const row = r.recordset?.[0];
    if (!row) return null;
    let sections;
    try { sections = JSON.parse(row.sections_json); } catch { return null; }
    if (!Array.isArray(sections)) return null;
    return {
      sections,
      title: row.title || null,
      savedAt: row.saved_at ? new Date(row.saved_at).toISOString() : null,
      savedBy: row.saved_by || null,
    };
  } catch (err) {
    console.warn('[sitePageDraft] could not read the draft:', err?.message);
    return null;
  }
}

/**
 * Throw the draft away — on Discard, and on the publish that consumed it.
 *
 * Never throws: a publish that reached the website must not be reported as a
 * failure because the housekeeping row would not delete. The caller is told
 * whether it went, so it can say "still held" rather than "gone".
 *
 * @returns {Promise<{ ok: boolean, removed: number }>}
 */
export async function clearDraft(pool, { tenantId, siteId, pageId }) {
  try {
    const r = await pool.request()
      .input('tenant_id', sql.UniqueIdentifier, tenantId)
      .input('site_id', sql.UniqueIdentifier, siteId)
      .input('page_id', sql.Int, pageId)
      .query(`DELETE FROM ${TABLE}
               WHERE tenant_id = @tenant_id AND site_id = @site_id AND page_id = @page_id;
              SELECT @@ROWCOUNT AS removed;`);
    return { ok: true, removed: Number(r.recordset?.[0]?.removed || 0) };
  } catch (err) {
    console.warn('[sitePageDraft] could not clear the draft:', err?.message);
    return { ok: false, removed: 0 };
  }
}

/**
 * Which of these pages have unpublished changes.
 *
 * One query for the whole list, so the Pages screen can say "Live · draft
 * saved" on a row without a round trip per row. Best effort, and an empty Set
 * when the table is not there yet.
 *
 * @returns {Promise<Set<number>>}
 */
export async function draftPageIds(pool, { tenantId, siteId }) {
  try {
    const r = await pool.request()
      .input('tenant_id', sql.UniqueIdentifier, tenantId)
      .input('site_id', sql.UniqueIdentifier, siteId)
      .query(`SELECT page_id FROM ${TABLE} WHERE tenant_id = @tenant_id AND site_id = @site_id`);
    return new Set((r.recordset || []).map((row) => Number(row.page_id)).filter(Number.isFinite));
  } catch (err) {
    console.warn('[sitePageDraft] could not list drafts:', err?.message);
    return new Set();
  }
}

/**
 * THE GUARD. Is this save about to take a live page off the internet?
 *
 * D-05 in one function, so it is a `node --test` case and not a shape you have
 * to reproduce against WordPress. Pure — the route hands it what it already
 * knows.
 *
 * `unpublish: true` is the ONE way through, and the Portal only sets it behind
 * the Unpublish confirm that says what will happen. An absent flag is a refusal
 * rather than a permission, because an old client that does not know about this
 * must fail closed (feedback_absence_based_guards_fail_open: the marker we gate
 * on is the PRESENCE of an explicit intention to unpublish).
 */
export function wouldUnpublish({ currentStatus, requestedStatus, unpublish }) {
  if (unpublish === true) return false;
  if (String(requestedStatus || '') !== 'draft') return false;
  return String(currentStatus || '') === 'publish';
}

/** What the author reads when the guard fires. Their words, their options. */
export const UNPUBLISH_REFUSAL =
  'This page is live. Saving holds your changes as a draft beside it — it never takes the page '
  + 'off the internet. To take it off, use Unpublish.';
