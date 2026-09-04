/**
 * ARION site builder — pages, sections, preview, undo, media.
 * ---------------------------------------------------------------------------
 * Mounted at: /arion/sites/:siteId   (routes/arion.js)
 * Auth:       requireAuth + tenantResolution + requireArionAccess upstream
 *             (index.js:191), so every handler can trust req.tenant.tenantId.
 *
 * TIERS (W-4): the editor is on EVERY ARION tier, Lite included. Nothing here
 * is tier-gated except which section archetypes can be ADDED — Lite sites have
 * no Elementor Pro, so the one archetype that needs the Pro form widget is
 * offered with `available:false` and the reason stated, never silently hidden.
 * Only the AI actions (Phase 1B) will cost credits; none of these do.
 *
 * SAFETY (W-3): live edit, a snapshot before every write, one-tap Undo, and a
 * preview that never writes. New pages are born drafts. There is no per-page
 * staging and there is deliberately not going to be one.
 *
 * THE RULE THIS FILE MUST NOT BREAK: never a success response on a failed
 * write (reference_catch_swallow_report_success). Every plugin call's `ok` is
 * checked and a failure becomes a 502 with plain words.
 *
 *   GET    /pages
 *   POST   /pages                       -> new page, draft
 *   GET    /pages/:pageId/sections
 *   PUT    /pages/:pageId/sections      -> snapshot + write
 *   POST   /pages/:pageId/undo
 *   POST   /pages/:pageId/preview       -> HTML, writes nothing
 *   POST   /media                       -> sideload into the site's library
 *   GET    /section-library             -> the "add a section" catalogue
 */

import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import { loadBrandContext } from '../../lib/websiteBuilder/brandContext.js';
import {
  reduceToSectionList, applyFields, validateFields, extractFields,
  sectionCatalog, sectionKindMeta, parseSectionHandle,
} from '../../lib/websiteBuilder/sectionSchema.js';
import { renderSectionListHtml } from '../../lib/websiteBuilder/sectionPreview.js';
import { buildStarterSection } from '../../lib/websiteBuilder/starterSections.js';
import {
  fetchPages, fetchPageSections, writePageSections, undoPage, createPage, sideloadMedia,
} from '../../lib/websiteBuilder/pageClient.js';
import { pluginPost } from '../../lib/pluginClient.js';

const router = Router({ mergeParams: true });

const MAX_SECTIONS_PER_PAGE = 60;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const ALLOWED_MEDIA_TYPES = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
});

/* ── plain-words error helpers ─────────────────────────────────────────── */

function bad(res, code, message, extra = {}) {
  return res.status(400).json({ error: { code, message, status: 400 }, ...extra });
}
function notFound(res, message) {
  return res.status(404).json({ error: { code: 'NOT_FOUND', message, status: 404 } });
}
function boom(res, err, where) {
  console.error(`[${where}]`, err);
  return res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Nothing was changed.', status: 500 },
  });
}

/**
 * Turn a plugin transport failure into an HTTP answer. NEVER 200.
 * A green toast on a failed write is the single most-repeated defect in this
 * codebase; T18/T19 in the walkthrough exist to prove this branch fires.
 */
function pluginFailure(res, result, what) {
  const code = result.error === 'site_not_connected' ? 'SITE_NOT_CONNECTED'
    : result.error === 'not_found' ? 'PAGE_NOT_FOUND'
    : result.error === 'timeout' ? 'SITE_TIMEOUT'
    : result.error === 'unreachable' ? 'SITE_UNREACHABLE'
    : 'SITE_REJECTED';
  const status = result.error === 'site_not_connected' ? 409
    : result.error === 'not_found' ? 404
    : 502;
  const message = result.message
    || (result.error === 'unreachable'
      ? `We could not reach your website, so ${what} did not happen.`
      : `Your website would not accept ${what}.`);
  return res.status(status).json({
    error: { code, message, status },
    meta: { plugin_status: result.pluginStatus || null, http_status: result.status || null },
  });
}

/** The full arion.site row — the token lives on it. */
async function loadSite(pool, tenantId, siteId) {
  const r = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('siteId', sql.UniqueIdentifier, siteId)
    .query('SELECT TOP 1 * FROM arion.site WHERE tenant_id = @tenantId AND site_id = @siteId');
  return r.recordset[0] || null;
}

function siteAllowsPro(site) {
  // Lite is the only ARION tier without Elementor Pro
  // (reference_arion_plugin_stack: elementor-pro ships on every tier, but the
  // section library's Pro-dependent variants are filtered for Lite and the
  // Lite plan does not carry the licence). Unknown tier is treated as Pro-
  // capable because that is what every provisioned site actually has.
  const tier = String(site?.arion_tier || '').trim().toLowerCase();
  return tier !== 'lite';
}

/** A page id is a WordPress post id: a positive integer, nothing else. */
function readPageId(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/* ==========================================================================
 * GET /pages — every page, drafts included.
 * ======================================================================== */
router.get('/pages', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const result = await fetchPages(site);
    if (!result.ok) return pluginFailure(res, result, 'reading your pages');

    const pages = Array.isArray(result.data?.pages) ? result.data.pages : [];
    return res.json({
      data: {
        pages: pages.map((p) => ({
          pageId: Number(p.page_id),
          title: String(p.title || '(no title)'),
          slug: String(p.slug || ''),
          status: String(p.status || 'draft'),
          type: String(p.type || 'page'),
          modified: p.modified || null,
          permalink: p.permalink || null,
          iaManaged: !!p.ia_managed,
          sectionCount: Number(p.section_count || 0),
          editableSectionCount: Number(p.editable_section_count || 0),
        })),
        pluginVersion: result.data?.plugin_version || null,
      },
      meta: { site_id: siteId, count: pages.length },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:list');
  }
});

/* ==========================================================================
 * POST /pages — a brand new page. Always a draft (W-3).
 * Body: { title, sections?: [{ kind }] }
 * ======================================================================== */
router.post('/pages', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const title = String(req.body?.title || '').trim();
  const wanted = Array.isArray(req.body?.sections) ? req.body.sections : [];

  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!title) return bad(res, 'TITLE_REQUIRED', 'Give the page a name first.');
  if (wanted.length > MAX_SECTIONS_PER_PAGE) {
    return bad(res, 'TOO_MANY_SECTIONS', `A page can hold up to ${MAX_SECTIONS_PER_PAGE} sections.`);
  }

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const brand = await loadBrandContext(pool, { tenantId, siteId });
    const allowPro = siteAllowsPro(site);

    const nodes = [];
    for (const entry of wanted) {
      const kind = String(entry?.kind || '').toLowerCase();
      const meta = sectionKindMeta(kind);
      if (!meta) return bad(res, 'UNKNOWN_SECTION', `We do not have a section called "${kind}".`);
      if (meta.requiresElementorPro && !allowPro) {
        return bad(res, 'SECTION_NOT_AVAILABLE', meta.proReason);
      }
      const built = buildStarterSection(kind, brand);
      if (!built.ok) return bad(res, built.code.toUpperCase(), built.message);
      nodes.push({ handle: built.node?.settings?._title || null, node: built.node });
    }

    const result = await createPage(site, { title, sections: nodes });
    if (!result.ok) return pluginFailure(res, result, 'creating the page');

    const pageId = Number(result.data?.page_id) || null;
    if (!pageId) {
      // The plugin answered 200 with no id. That is a failure, not a success.
      return res.status(502).json({
        error: {
          code: 'SITE_REJECTED',
          message: 'Your website said it saved the page but did not say where. Nothing has been published.',
          status: 502,
        },
      });
    }

    return res.status(201).json({
      data: {
        pageId,
        title,
        status: 'draft',
        permalink: result.data?.permalink || null,
        previewUrl: result.data?.preview_url || null,
      },
      meta: { site_id: siteId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:create');
  }
});

/* ==========================================================================
 * GET /pages/:pageId/sections — the page as an ordered list of sections.
 * ======================================================================== */
router.get('/pages/:pageId/sections', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const pageId = readPageId(req.params.pageId);
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!pageId) return bad(res, 'BAD_PAGE_ID', 'That page reference is not valid.');

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const result = await fetchPageSections(site, pageId);
    if (!result.ok) return pluginFailure(res, result, 'reading that page');

    const data = result.data || {};
    // The plugin sends the section list AND the raw tree. We re-derive the
    // field values here from the tree, so arion-api is the single authority on
    // what a field means; the plugin's own copy is for direct callers.
    const tree = Array.isArray(data.elementor_data) ? data.elementor_data : [];
    const sections = reduceToSectionList(tree);

    return res.json({
      data: {
        pageId: Number(data.page_id) || pageId,
        title: String(data.title || ''),
        slug: String(data.slug || ''),
        status: String(data.status || 'draft'),
        permalink: data.permalink || null,
        previewUrl: data.preview_url || null,
        modified: data.modified || null,
        canUndo: !!data.can_undo,
        undoCount: Number(data.snapshot_count || 0),
        sections: sections.map(publicSection),
      },
      meta: { site_id: siteId, section_count: sections.length },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:sections');
  }
});

/** What the Portal sees. `node` rides along so a save round-trips untouched. */
function publicSection(entry) {
  return {
    index: entry.index,
    handle: entry.handle,
    kind: entry.kind,
    blueprintId: entry.blueprintId,
    blockId: entry.blockId,
    editable: entry.editable,
    reason: entry.reason,
    label: entry.label,
    fields: entry.fields,
    node: entry.node,
  };
}

/* ==========================================================================
 * Shared: turn an incoming section list into the nodes to publish.
 *
 * A section we authored is PATCHED IN PLACE from its field values, so every
 * style and setting it picked up since we wrote it survives. A section we did
 * not author is passed straight back, byte for byte (SCOPE §3.3).
 * ======================================================================== */
function buildNodes(incoming) {
  const errors = [];
  const nodes = [];

  incoming.forEach((entry, i) => {
    const node = entry?.node;
    if (!node || typeof node !== 'object' || node.elType !== 'section') {
      errors.push({ field: `sections[${i}]`, message: 'One of the sections is missing its content.' });
      return;
    }
    const parsed = parseSectionHandle(node?.settings?._title);
    const kind = parsed?.kind && sectionKindMeta(parsed.kind) ? parsed.kind : null;

    // Custom section, or one of ours with nothing editable in it: carry it
    // through exactly as it came.
    if (!kind || !entry.fields || typeof entry.fields !== 'object') {
      nodes.push({ handle: node?.settings?._title || null, node });
      return;
    }

    const check = validateFields(kind, entry.fields);
    if (!check.ok) {
      for (const e of check.errors) {
        errors.push({ field: `sections[${i}].${e.field}`, message: e.message });
      }
      return;
    }
    nodes.push({ handle: parsed.handle, node: applyFields(node, kind, entry.fields) });
  });

  return { nodes, errors };
}

/* ==========================================================================
 * PUT /pages/:pageId/sections — save. Snapshot first, then write.
 * Body: { sections: [...], title?, status? }
 * ======================================================================== */
router.put('/pages/:pageId/sections', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const pageId = readPageId(req.params.pageId);
  const incoming = Array.isArray(req.body?.sections) ? req.body.sections : null;
  const title = req.body?.title == null ? null : String(req.body.title).trim();
  const status = req.body?.status == null ? null : String(req.body.status).toLowerCase();

  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!pageId) return bad(res, 'BAD_PAGE_ID', 'That page reference is not valid.');
  if (!incoming) return bad(res, 'NO_SECTIONS', 'The page content did not arrive. Nothing was saved.');
  if (incoming.length === 0) return bad(res, 'NO_SECTIONS', 'A page needs at least one section.');
  if (incoming.length > MAX_SECTIONS_PER_PAGE) {
    return bad(res, 'TOO_MANY_SECTIONS', `A page can hold up to ${MAX_SECTIONS_PER_PAGE} sections.`);
  }
  if (status && !['draft', 'publish', 'private'].includes(status)) {
    return bad(res, 'BAD_STATUS', 'A page can be a draft, published, or private.');
  }

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const { nodes, errors } = buildNodes(incoming);
    if (errors.length > 0) {
      return res.status(422).json({
        error: {
          code: 'CONTENT_NOT_VALID',
          message: 'Some of what you typed needs another look. Nothing was saved.',
          status: 422,
        },
        errors,
      });
    }

    // Refuse to save a page that lost a section on the way in. The unknown-
    // section splice is load-bearing for every existing site, so a count that
    // does not match is a bug, not a save (SCOPE §6 risks).
    if (nodes.length !== incoming.length) {
      return res.status(500).json({
        error: {
          code: 'SECTION_COUNT_MISMATCH',
          message: 'We could not rebuild the page safely, so nothing was saved.',
          status: 500,
        },
      });
    }

    const result = await writePageSections(site, pageId, {
      sections: nodes,
      ...(title ? { title } : {}),
      ...(status ? { status } : {}),
    });
    if (!result.ok) return pluginFailure(res, result, 'saving the page');
    if (result.data?.success === false) {
      return pluginFailure(res, { ...result, ok: false, error: 'plugin_rejected' }, 'saving the page');
    }

    // Published content sits behind LiteSpeed on every ARION site; without
    // this the client hits Save, reloads, and sees the old page.
    const purge = await pluginPost(site, '/purge-cache', {});

    return res.json({
      data: {
        pageId,
        status: result.data?.status || status || null,
        permalink: result.data?.permalink || null,
        previewUrl: result.data?.preview_url || null,
        sectionsWritten: nodes.length,
        canUndo: true,
        undoCount: Number(result.data?.snapshot_count || 0),
        cachePurged: !!purge.ok,
      },
      meta: { site_id: siteId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:save');
  }
});

/* ==========================================================================
 * POST /pages/:pageId/undo — put the previous version back.
 * ======================================================================== */
router.post('/pages/:pageId/undo', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const pageId = readPageId(req.params.pageId);
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!pageId) return bad(res, 'BAD_PAGE_ID', 'That page reference is not valid.');

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const result = await undoPage(site, pageId);
    if (!result.ok) return pluginFailure(res, result, 'undoing the last change');
    if (result.data?.restored === false) {
      return res.status(409).json({
        error: {
          code: 'NOTHING_TO_UNDO',
          message: 'There is no earlier version of this page to go back to.',
          status: 409,
        },
      });
    }

    const purge = await pluginPost(site, '/purge-cache', {});
    return res.json({
      data: {
        pageId,
        restoredFrom: result.data?.captured_at || null,
        canUndo: !!result.data?.can_undo,
        undoCount: Number(result.data?.snapshot_count || 0),
        cachePurged: !!purge.ok,
      },
      meta: { site_id: siteId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:undo');
  }
});

/* ==========================================================================
 * POST /pages/:pageId/preview — HTML for the preview pane. Writes nothing.
 * ======================================================================== */
router.post('/pages/:pageId/preview', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const incoming = Array.isArray(req.body?.sections) ? req.body.sections : null;
  const pageTitle = String(req.body?.title || 'Preview');

  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!incoming) return bad(res, 'NO_SECTIONS', 'There is nothing to preview yet.');
  if (incoming.length > MAX_SECTIONS_PER_PAGE) {
    return bad(res, 'TOO_MANY_SECTIONS', `A page can hold up to ${MAX_SECTIONS_PER_PAGE} sections.`);
  }

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const brand = await loadBrandContext(pool, { tenantId, siteId });

    // Render from the values the client is looking at right now. Anything they
    // did not touch is read back out of its own node, so a preview of an
    // untouched section shows what the site shows.
    const forRender = incoming.map((entry) => {
      const parsed = parseSectionHandle(entry?.node?.settings?._title);
      const kind = parsed?.kind && sectionKindMeta(parsed.kind) ? parsed.kind : null;
      if (!kind) return { kind: null, fields: null };
      const fields = (entry?.fields && typeof entry.fields === 'object')
        ? entry.fields
        : extractFields(entry.node, kind);
      return { kind, fields };
    });

    const html = renderSectionListHtml(forRender, brand, { pageTitle });
    return res.json({
      data: { html, sectionCount: forRender.length, saved: false },
      meta: { site_id: siteId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:preview');
  }
});

/* ==========================================================================
 * POST /media — put a picture in the website's own media library.
 * Body: { url } | { filename, contentType, dataBase64, alt? }
 * ======================================================================== */
router.post('/media', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const body = req.body || {};
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');

  const fromUrl = String(body.url || '').trim();
  const dataBase64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : '';
  const contentType = String(body.contentType || '').trim().toLowerCase();

  if (!fromUrl && !dataBase64) {
    return bad(res, 'NO_IMAGE', 'Choose a picture to upload first.');
  }
  if (fromUrl && !/^https?:\/\//i.test(fromUrl)) {
    return bad(res, 'BAD_IMAGE_URL', 'A picture address has to start with http:// or https://.');
  }
  if (dataBase64) {
    if (!ALLOWED_MEDIA_TYPES[contentType]) {
      return bad(res, 'BAD_IMAGE_TYPE',
        'That file type is not supported. Use a JPG, PNG, GIF or WebP picture.');
    }
    // base64 inflates by 4/3; check the decoded size, not the string length.
    const approxBytes = Math.floor((dataBase64.length * 3) / 4);
    if (approxBytes > MAX_MEDIA_BYTES) {
      return bad(res, 'IMAGE_TOO_BIG', 'That picture is over 10 MB. Try a smaller one.');
    }
  }

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const result = await sideloadMedia(site, {
      url: fromUrl || undefined,
      filename: body.filename ? String(body.filename).slice(0, 180) : undefined,
      content_type: contentType || undefined,
      data_base64: dataBase64 || undefined,
      alt: body.alt ? String(body.alt).slice(0, 300) : undefined,
    });
    if (!result.ok) return pluginFailure(res, result, 'uploading the picture');

    const url = result.data?.url;
    if (!url) {
      return res.status(502).json({
        error: {
          code: 'SITE_REJECTED',
          message: 'Your website took the picture but did not say where it went. Try again.',
          status: 502,
        },
      });
    }
    return res.status(201).json({
      data: {
        url,
        attachmentId: Number(result.data?.attachment_id) || null,
        alt: result.data?.alt || '',
      },
      meta: { site_id: siteId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:media');
  }
});

/* ==========================================================================
 * POST /sections — build ONE new section, ready to drop into the editor.
 *
 * Writes nothing anywhere. The Portal never invents Elementor JSON, so when a
 * client picks a section from the library the server builds the node, fills it
 * from the business's own brand context, and hands it back as an ordinary
 * section-list entry. It reaches the website on the next Save like any other.
 * ======================================================================== */
router.post('/sections', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const kind = String(req.body?.kind || '').toLowerCase();
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');

  const meta = sectionKindMeta(kind);
  if (!meta) return bad(res, 'UNKNOWN_SECTION', `We do not have a section called "${kind}".`);

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    if (meta.requiresElementorPro && !siteAllowsPro(site)) {
      return bad(res, 'SECTION_NOT_AVAILABLE', meta.proReason);
    }

    const brand = await loadBrandContext(pool, { tenantId, siteId });
    const built = buildStarterSection(kind, brand);
    if (!built.ok) return bad(res, built.code.toUpperCase(), built.message);

    const [entry] = reduceToSectionList([built.node]);
    return res.status(201).json({ data: { section: publicSection(entry) }, meta: { site_id: siteId } });
  } catch (err) {
    return boom(res, err, 'arion/pages:build-section');
  }
});

/* ==========================================================================
 * GET /section-library — what "add a section" can offer this website.
 * ======================================================================== */
router.get('/section-library', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const allowPro = siteAllowsPro(site);
    // The FULL field spec goes to the Portal — labels, types, limits, choices,
    // and the sub-fields of every list. The edit sheet renders from this, so
    // there is one description of a section and it lives in sectionSchema.js.
    const catalog = sectionCatalog({ allowPro }).map((entry) => ({
      ...entry,
      fields: sectionKindMeta(entry.kind).fields,
    }));

    return res.json({
      data: { sections: catalog, elementorProAvailable: allowPro },
      meta: { site_id: siteId, tier: site.arion_tier || null },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:section-library');
  }
});

export default router;
export const __test__ = { buildNodes, siteAllowsPro, readPageId, ALLOWED_MEDIA_TYPES, MAX_SECTIONS_PER_PAGE };
