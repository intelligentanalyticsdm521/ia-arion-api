/**
 * /arion/plugin/* — cross-product plugin proxy endpoints.
 *
 * LUMEN-API (and any other product) calls these endpoints to talk to the
 * IA WordPress plugin without needing to know about per-site tokens. ARION
 * already owns the arion.site table and the X-Arion-Site-Token outbound
 * client, so we route plugin calls through here.
 *
 * Auth: same as the rest of /arion/* — bearer token + tenant header + the
 * caller must have ARION access for this tenant.
 */
import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';

import { resolveSiteHost } from '../../lib/pluginClient.js';

const router = Router();

/**
 * Pick the primary site for a tenant — newest non-archived site that has
 * either a domain or wp_admin_url configured. Returns null if none.
 */
async function pickPrimarySite(pool, tenantId, explicitSiteId) {
  if (explicitSiteId) {
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, explicitSiteId)
      .query('SELECT TOP 1 * FROM arion.site WHERE tenant_id=@tenantId AND site_id=@siteId');
    return r.recordset[0] || null;
  }
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .query(`SELECT TOP 1 *
            FROM arion.site
            WHERE tenant_id = @tenantId
              AND (domain IS NOT NULL OR wp_admin_url IS NOT NULL)
            ORDER BY created_at DESC`);
  return r.recordset[0] || null;
}

/* ==========================================================================
 * DELETED 2026-09-09 (ARION pack 2, D-ARION-C): POST /publish-newsletter.
 *
 * It forwarded to the IA plugin's `/publish-newsletter` route, and the plugin
 * has never registered such a route - `grep register_rest_route` across
 * intelligent-analytics.php and includes/ finds no such path in any version.
 * So publishing a newsletter to WordPress from the Portal answered
 * `plugin_call_failed` on the first real call and has never once worked
 * (GAP_ANALYSIS_2026-09-08, ARION). Keeping a proxy to nothing meant the
 * failure looked like a website problem instead of a missing feature.
 *
 * WRITING A POST NOW HAS A REAL HOME: ARION -> Website -> Pages -> New post
 * composes a blog post in the same section editor as a page, through the
 * plugin routes that do exist (POST /pages with type=post, then the section
 * save and the page-settings sheet for its categories, tags and picture).
 *
 * ONE CALLER IS LEFT AND IS NOT OURS TO CHANGE: LUMEN-API
 * `src/routes/newsletters.js:376` still POSTs here from
 * `/newsletters/:id/publish`. It already treats a failure as a recorded
 * `wp_status` rather than an error, so it degrades exactly as it did before -
 * it just says 404 instead of 502 now. Pointing it at the new post path is
 * SPARK's call to make, in SPARK's repo.
 * ======================================================================== */

/**
 * GET /arion/plugin/posts?category=Newsletter&limit=50
 * Returns recent WordPress posts from the tenant's primary site so SPARK
 * Newsletter Studio can offer an "Import from ARION" flow.
 *
 * 2026-06-13 fix: the IA plugin never registered a /posts REST route —
 * SPARK's calls 404'd with "rest_no_route" every time. WordPress core
 * already ships /wp-json/wp/v2/posts publicly for published content, no
 * auth needed. We hit that directly, resolve the category by name → id
 * via /wp/v2/categories?search=…, then return a normalized payload that
 * matches the shape SparkNewsletterPage expects.
 */
async function wpGet(host, path, query = {}) {
  const qs = new URLSearchParams(query).toString();
  const url = `https://${host}/wp-json/wp/v2${path}${qs ? '?' + qs : ''}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    const body = await r.text();
    let data = null;
    try { data = body ? JSON.parse(body) : null; } catch { /* not JSON */ }
    return { ok: r.ok, status: r.status, data, errorText: !r.ok ? (data?.message || body || '').slice(0, 300) : null };
  } catch (e) {
    return { ok: false, status: 0, data: null, errorText: e.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET /arion/plugin/posts/:postId
 *
 * One post, WITH its rendered body.
 *
 * The list endpoint above deliberately returns only a 300-character excerpt:
 * pulling full HTML for fifty posts to draw a picker is wasteful, and most of
 * it is thrown away. But importing a newsletter needs the actual article, and
 * until now nothing could reach it — the Newsletter Studio's import recorded a
 * title and a link and had no way to mail what the post said.
 *
 * Answers { post_id, title, content_html, excerpt, post_url, published_at }.
 */
router.get('/posts/:postId', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const postId = parseInt(req.params.postId, 10);
  if (!Number.isFinite(postId)) return res.status(400).json({ error: 'bad_post_id' });
  try {
    const pool = await getServicesPool();
    const site = await pickPrimarySite(pool, tenantId, req.query.site_id || null);
    if (!site) {
      return res.status(404).json({
        error: 'no_arion_site',
        message: 'No ARION-managed WordPress site found for this tenant.',
      });
    }
    const host = resolveSiteHost(site);
    if (!host) {
      return res.status(404).json({
        error: 'no_site_host',
        message: 'Site row has no domain or wp_admin_url configured.',
      });
    }

    const r = await wpGet(host, `/posts/${postId}`, {});
    if (!r.ok) {
      return res.status(r.status === 404 ? 404 : 502).json({
        error: r.status === 404 ? 'post_not_found' : 'wp_fetch_failed',
        plugin_status: r.status === 404 ? undefined : 'error',
        details: r.errorText,
      });
    }
    const p = r.data || {};
    return res.json({
      ok: true,
      site_id: site.site_id,
      post: {
        post_id: p.id,
        title: (p.title?.rendered || '').replace(/<[^>]+>/g, '').trim(),
        // The body, as WordPress renders it. Kept verbatim — the caller decides
        // how to make it email-safe, because that transformation depends on
        // where it is going and doing it here would lose the original.
        content_html: p.content?.rendered || '',
        excerpt: (p.excerpt?.rendered || '').replace(/<[^>]+>/g, '').trim(),
        post_url: p.link,
        published_at: p.date_gmt ? p.date_gmt + 'Z' : p.date,
      },
    });
  } catch (err) {
    console.error('[arion/plugin/posts/:postId]', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

router.get('/posts', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  // 2026-06-13: per-tenant taxonomy override. Default is `both` taxonomies
  // (category OR tag) matching the term "newsletter". Caller can pass:
  //   - taxonomy_type=category|tag|both (default 'both')
  //   - taxonomy_value=<term>           (default 'newsletter')
  //   - Legacy: ?category=X is kept for backward compat. If provided we
  //     treat it as taxonomy_type=both, taxonomy_value=X.
  const legacyCategory = (req.query.category || '').toString().trim();
  const taxonomyType  = (req.query.taxonomy_type || (legacyCategory ? 'both' : 'both')).toString().toLowerCase();
  const taxonomyValue = (req.query.taxonomy_value || legacyCategory || 'newsletter').toString().trim();
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
  try {
    const pool = await getServicesPool();
    const site = await pickPrimarySite(pool, tenantId, req.query.site_id || null);
    if (!site) {
      return res.status(404).json({
        error: 'no_arion_site',
        message: 'No ARION-managed WordPress site found for this tenant.',
      });
    }
    const host = resolveSiteHost(site);
    if (!host) {
      return res.status(404).json({
        error: 'no_site_host',
        message: 'Site row has no domain or wp_admin_url configured.',
      });
    }

    // Resolve the taxonomy term against WP. Type controls which side(s) of
    // the taxonomy we query — caller-configured per tenant.
    let categoryId = null;
    let tagId = null;
    if (taxonomyValue) {
      const wanted = taxonomyValue.toLowerCase();
      const pickMatch = (list) => list?.find(x => String(x.slug || '').toLowerCase() === wanted)
                              || list?.find(x => String(x.name || '').toLowerCase() === wanted)
                              || list?.find(x => x.count > 0)
                              || list?.[0];

      const tasks = [];
      if (taxonomyType === 'category' || taxonomyType === 'both') {
        tasks.push(wpGet(host, '/categories', { search: taxonomyValue, per_page: '10' }).then(r => ({ kind: 'cat', r })));
      }
      if (taxonomyType === 'tag' || taxonomyType === 'both') {
        tasks.push(wpGet(host, '/tags', { search: taxonomyValue, per_page: '10' }).then(r => ({ kind: 'tag', r })));
      }
      const taskResults = await Promise.all(tasks);
      const failures = taskResults.filter(t => !t.r.ok);
      if (failures.length === taskResults.length && taskResults.length > 0) {
        return res.status(502).json({
          error: 'wp_taxonomy_failed',
          plugin_status: failures[0].r.status === 404 ? 'wp_rest_disabled' : 'error',
          details: failures[0].r.errorText,
        });
      }
      for (const t of taskResults) {
        if (!t.r.ok) continue;
        if (t.kind === 'cat') categoryId = pickMatch(t.r.data)?.id || null;
        if (t.kind === 'tag') tagId = pickMatch(t.r.data)?.id || null;
      }
    }

    // Build a single combined post list. Run each filter as its own query and
    // dedupe by post id. If neither taxonomy matched, fall through to recent
    // posts (no filter) so the modal isn't empty for a brand-new tenant.
    const baseQuery = { per_page: String(limit), status: 'publish', orderby: 'date', order: 'desc' };
    const queries = [];
    if (categoryId) queries.push({ ...baseQuery, categories: String(categoryId) });
    if (tagId)      queries.push({ ...baseQuery, tags: String(tagId) });
    if (queries.length === 0) queries.push(baseQuery);

    const results = await Promise.all(queries.map(q => wpGet(host, '/posts', q)));
    const firstError = results.find(r => !r.ok);
    if (firstError && results.every(r => !r.ok)) {
      return res.status(502).json({
        error: 'wp_posts_failed',
        plugin_status: firstError.status === 404 ? 'wp_rest_disabled' : 'error',
        details: firstError.errorText,
      });
    }
    const merged = new Map();
    for (const r of results) {
      if (!r.ok) continue;
      for (const p of (r.data || [])) {
        if (!merged.has(p.id)) merged.set(p.id, p);
      }
    }
    const postsRes = { ok: true, data: Array.from(merged.values()).slice(0, limit) };

    // Normalize to the shape SparkNewsletterPage expects
    const posts = (postsRes.data || []).map(p => ({
      post_id: p.id,
      title: (p.title?.rendered || '').replace(/<[^>]+>/g, '').trim(),
      excerpt: (p.excerpt?.rendered || '').replace(/<[^>]+>/g, '').trim().slice(0, 300),
      post_url: p.link,
      published_at: p.date_gmt ? p.date_gmt + 'Z' : p.date,
      categories: Array.isArray(p.categories) ? p.categories : [],
      issue_number: null,
      edition_date: null,
      from_spark: false,
    }));

    return res.json({
      ok: true,
      site_id: site.site_id,
      posts,
      count: posts.length,
    });
  } catch (err) {
    console.error('[arion/plugin/posts]', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

export default router;
