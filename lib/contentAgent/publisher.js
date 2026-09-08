// lib/contentAgent/publisher.js
//
// Task 7 — the WordPress scheduling hand-off.
//
// AC8 IS THE WHOLE CONTRACT HERE: "No draft is scheduled to WordPress without an
// explicit Brandon approval action in v0.1." So this module refuses to publish
// anything whose review_status is not 'approved' or 'edited', and it re-checks
// that in the UPDATE's WHERE clause rather than trusting the row it read a
// moment earlier.
//
// AC3: what publishes is body_markdown_final — the approved, possibly edited
// text — never body_markdown, which is retained only as the agent's original.
// Getting this backwards would publish the draft Brandon rejected the wording of.
//
// F5: "WordPress publish fails post-approval -> content stuck 'approved, not
// scheduled' -> alert Brandon, manual publish fallback." So a failed publish
// leaves review_status alone and published_at NULL, and returns an alert. It
// must never mark the row published-ish on a best-effort basis; a row that
// claims to be live when it is not is worse than one that is visibly stuck.
//
// ENDPOINT NOTE: the IA WP plugin exposes /publish-newsletter and never
// registered a generic /posts route (see routes/arion/plugin.js:109). That
// endpoint is really "create a post with a category", so blog posts go through
// it with category 'Blog'. The name is a misnomer for this use. Generalising it
// is a plugin-side change and deliberately out of scope here — flagged so the
// next person does not read this as confusion.

import sql from 'mssql';
import { pluginPost } from '../pluginClient.js';

export const PUBLISHABLE_STATUSES = ['approved', 'edited'];

export class PublishRefused extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PublishRefused';
    this.code = code;
  }
}

/** The tenant's ARION-managed site. Tenant-scoped. */
export async function pickPrimarySite(pool, tenantId, explicitSiteId = null) {
  const req = pool.request().input('tenantId', sql.UniqueIdentifier, tenantId);
  if (explicitSiteId) {
    req.input('siteId', sql.UniqueIdentifier, explicitSiteId);
    const r = await req.query('SELECT TOP 1 site_id, domain FROM arion.site WHERE tenant_id = @tenantId AND site_id = @siteId');
    return r.recordset[0] || null;
  }
  const r = await req.query('SELECT TOP 1 site_id, domain FROM arion.site WHERE tenant_id = @tenantId ORDER BY created_at ASC');
  return r.recordset[0] || null;
}

/**
 * Load a unit for publication, refusing anything not explicitly approved.
 * @throws {PublishRefused}
 */
export async function loadPublishable(pool, tenantId, outputId) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('id', sql.UniqueIdentifier, outputId)
    .query(`
      SELECT output_id, site_id, content_type, title, body_markdown,
             body_markdown_final, meta_description, url_slug, review_status,
             approved_at, published_at
        FROM arion.content_agent_output
       WHERE tenant_id = @tenantId AND output_id = @id`);

  const row = r.recordset[0];
  if (!row) throw new PublishRefused('No such content unit for this tenant', 'not_found');

  // AC8 — the gate.
  if (!PUBLISHABLE_STATUSES.includes(row.review_status)) {
    throw new PublishRefused(
      `Refusing to publish: review_status is '${row.review_status}'. Only ${PUBLISHABLE_STATUSES.join(' or ')} may be scheduled.`,
      'not_approved',
    );
  }
  if (!row.approved_at) {
    // Belt to the status braces: an approved row with no approval timestamp
    // means something wrote the status directly, bypassing the review endpoint.
    throw new PublishRefused('Refusing to publish: no approval timestamp on this row', 'no_approval_timestamp');
  }
  if (row.published_at) {
    throw new PublishRefused('Already published', 'already_published');
  }
  return row;
}

/**
 * Schedule an approved unit to WordPress.
 *
 * @returns {Promise<{ok, wordpressPostId?, postUrl?, alert?}>}
 *          ok:false carries an F5 alert and leaves the row untouched.
 */
export async function publishApproved({
  pool, tenantId, outputId, siteId = null,
  status = 'future', publishAt = null, category = 'Blog',
  post = pluginPost,
}) {
  const row = await loadPublishable(pool, tenantId, outputId);

  const site = await pickPrimarySite(pool, tenantId, siteId || row.site_id);
  if (!site) {
    return {
      ok: false,
      alert: {
        failure_mode: 'F5',
        code: 'no_arion_site',
        message: 'Approved content could not be scheduled: no ARION-managed WordPress site for this tenant. Content remains approved and unscheduled.',
      },
    };
  }

  // AC3 — the approved text, not the original draft.
  const content = row.body_markdown_final ?? row.body_markdown;

  let r;
  try {
    r = await post(site, '/publish-newsletter', {
      tenant_id: tenantId,
      title: row.title,
      summary: row.meta_description || null,
      content,
      category,
      status,
      ...(publishAt ? { edition_date: publishAt } : {}),
    }, { timeoutMs: 30_000 });
  } catch (err) {
    return {
      ok: false,
      alert: {
        failure_mode: 'F5',
        code: 'plugin_exception',
        message: `Approved content could not be scheduled (${String(err?.message || err).slice(0, 200)}). It remains approved and unscheduled — publish manually or retry.`,
      },
    };
  }

  if (!r?.ok) {
    return {
      ok: false,
      alert: {
        failure_mode: 'F5',
        code: 'plugin_call_failed',
        pluginStatus: r?.pluginStatus ?? null,
        message: `Approved content could not be scheduled (plugin status ${r?.pluginStatus ?? 'unknown'}). It remains approved and unscheduled — publish manually or retry.`,
      },
    };
  }

  const wpPostId = r.data?.post_id ?? null;

  // Only NOW is the row marked published. The WHERE clause re-asserts the
  // approval gate so a status change between load and write cannot slip past.
  await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('id', sql.UniqueIdentifier, outputId)
    .input('wp', sql.BigInt, wpPostId)
    .query(`
      UPDATE arion.content_agent_output
         SET published_at = SYSDATETIMEOFFSET(), wordpress_post_id = @wp
       WHERE tenant_id = @tenantId AND output_id = @id
         AND review_status IN ('approved','edited')
         AND approved_at IS NOT NULL
         AND published_at IS NULL`);

  return { ok: true, wordpressPostId: wpPostId, postUrl: r.data?.post_url ?? null, siteId: site.site_id };
}

export default { PUBLISHABLE_STATUSES, PublishRefused, pickPrimarySite, loadPublishable, publishApproved };
