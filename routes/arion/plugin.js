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
import { pluginPost } from '../../lib/pluginClient.js';

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

/**
 * POST /arion/plugin/publish-newsletter
 * Body:
 *   { site_id? (uuid), title (required), summary?, content?, issue_number?,
 *     edition_date? (yyyy-mm-dd), category?, status? }
 *
 * Looks up the tenant's primary WordPress site (or the explicit site_id if
 * provided), then forwards the payload to the IA plugin's
 * /publish-newsletter endpoint using the site's stored site_token_raw.
 *
 * Returns: { post_id, post_url, status } from the plugin, plus site_id we
 * routed to.
 */
router.post('/publish-newsletter', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const body = req.body || {};
  if (!body.title || typeof body.title !== 'string' || !body.title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }

  try {
    const pool = await getServicesPool();
    const site = await pickPrimarySite(pool, tenantId, body.site_id || null);
    if (!site) {
      return res.status(404).json({
        error: 'no_arion_site',
        message: 'No ARION-managed WordPress site found for this tenant. Add an ARION site or pass site_id explicitly.',
      });
    }

    const r = await pluginPost(site, '/publish-newsletter', {
      tenant_id: tenantId,
      title: body.title,
      summary: body.summary || null,
      content: body.content || null,
      issue_number: body.issue_number ?? null,
      edition_date: body.edition_date || null,
      category: body.category || 'Newsletter',
      status: body.status || 'publish',
    }, { timeoutMs: 30_000 });

    if (!r.ok) {
      return res.status(502).json({
        error: 'plugin_call_failed',
        plugin_status: r.pluginStatus,
        details: r.errorText || null,
        site_id: site.site_id,
      });
    }
    return res.json({
      ok: true,
      site_id: site.site_id,
      post_id: r.data?.post_id || null,
      post_url: r.data?.post_url || null,
      status: r.data?.status || 'unknown',
    });
  } catch (err) {
    console.error('[arion/plugin/publish-newsletter]', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

export default router;
