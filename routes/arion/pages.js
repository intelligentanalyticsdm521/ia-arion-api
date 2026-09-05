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
 * offered with `available:false` and the reason stated, never silently hidden
 * — and the AI actions, which need a paid plan ("Lite never gets LLM",
 * feedback_intelligence_tier_data_gated). Only the AI actions cost credits.
 *
 * AI (Phase 1B): the model PROPOSES field values and nothing else. A proposal
 * is stored, shown to the client as a before/after, and reaches the website
 * only through the ordinary save below — same snapshot, same Undo. Every call
 * is metered through ARGUS before a token is spent (lib/websiteBuilder/aiEdit.js).
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
 *   GET    /ai-pricing                  -> what an AI action costs, from the DB
 *   POST   /pages/:pageId/sections/:handle/ai-edit  -> propose, never write
 *   POST   /pages/:pageId/ai-edit                   -> propose across the page
 *   GET    /pages/:pageId/proposals
 *   POST   /proposals/:proposalId/discard
 *
 * ADOPTION (Phase 3, W-5): a section built on the website itself can be taken
 * charge of, one at a time, never automatically, always previewed, always
 * reversible for 30 days from the original bytes we kept:
 *
 *   GET    /pages/:pageId/adoptions
 *   POST   /pages/:pageId/sections/:index/adopt-preview   -> writes NOTHING
 *   POST   /pages/:pageId/sections/:index/adopt
 *   POST   /pages/:pageId/adoptions/:adoptionId/undo
 */

import { Router } from 'express';
import crypto from 'node:crypto';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import { loadBrandContext, BUSINESS_NAME_NOT_SET } from '../../lib/websiteBuilder/brandContext.js';
import {
  reduceToSectionList, applyFields, validateFields, extractFields,
  sectionCatalog, sectionKindMeta, parseSectionHandle,
} from '../../lib/websiteBuilder/sectionSchema.js';
import { renderSectionListHtml, renderAdoptionPreviewHtml } from '../../lib/websiteBuilder/sectionPreview.js';
import {
  analyseSection, analysePage, buildAdoptedSection, sectionFingerprint,
  previewTools, ADOPT_MIN_CONFIDENCE, ADOPT_UNDO_DAYS,
} from '../../lib/websiteBuilder/adoption.js';
import {
  recordAdoption, getAdoption, listAdoptions, markReverted, AdoptionTooBigError,
} from '../../lib/websiteBuilder/adoptionStore.js';
import { buildStarterSection } from '../../lib/websiteBuilder/starterSections.js';
import {
  fetchPages, fetchPageSections, writePageSections, undoPage, createPage, sideloadMedia,
  listMedia, setMediaAlt, pushBookingConfig,
} from '../../lib/websiteBuilder/pageClient.js';
import { pluginPost } from '../../lib/pluginClient.js';
import {
  proposeSectionEdit, proposePageEdit, aiTierGate,
  ACTION_SECTION_EDIT, ACTION_PAGE_EDIT, MAX_INSTRUCTION_CHARS,
} from '../../lib/websiteBuilder/aiEdit.js';
import {
  saveProposal, markProposalsApplied, resolveProposal, listProposals,
} from '../../lib/websiteBuilder/proposalStore.js';
import { libraryPickerRows, buildLibrarySection } from '../../lib/websiteBuilder/libraryCatalog.js';
import { maybeDevModel } from '../../lib/websiteBuilder/aiDevStub.js';
import { getActionPricing } from '../../lib/argus/callWrapper.js';

const router = Router({ mergeParams: true });

const MAX_SECTIONS_PER_PAGE = 60;
const TOP_LEVEL_EL_TYPES = Object.freeze(new Set(['section', 'container']));
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
 * Forms: the wires an edit must never cut.
 *
 * A form section carries three things that are ROUTING, not copy:
 *   form_css_class  — the plugin's interceptor types every submission from it
 *                     (class-ia-form-interceptor.php:127)
 *   email_to        — whose inbox the enquiry lands in
 *   the visitor id  — read from the __ia_vid COOKIE at submit time, server
 *                     side, so it is not in the markup at all and no edit can
 *                     drop it (intelligent-analytics.php, form interceptor)
 *
 * The first two survive because `applyFields` only writes the settings a
 * binding names and the editor always sends back what it read. The third
 * needs nothing. What DOES need code is the fail-loud rule: a form with no
 * recipient must not reach a website, because it would collect enquiries
 * nobody ever sees.
 * ======================================================================== */

/**
 * Fill a form section's recipient from the business's own email when the
 * section does not carry one, and refuse the save when neither has one.
 *
 * Deliberately NOT an overwrite: a site whose form already points somewhere
 * (an office inbox, a shared alias) keeps pointing there. This only fills a
 * blank, which is the case that ships a form nobody reads.
 *
 * @returns {{ ok: true, fields: object } | { ok: false, message: string }}
 */
function withFormRecipient(kind, fields, brand) {
  if (kind !== 'contact' || !fields || typeof fields !== 'object') return { ok: true, fields };
  const current = String(fields.email_to || '').trim();
  if (current) return { ok: true, fields };

  const fallback = String(brand?.email || '').trim();
  if (!fallback) {
    return {
      ok: false,
      message: 'We do not have an email address for your business yet, so this form '
        + 'would have nowhere to send enquiries. Add one under Settings → Your business, '
        + 'then publish again. Nothing was saved.',
    };
  }
  return { ok: true, fields: { ...fields, email_to: fallback } };
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
          // Phase 3: an UPPER BOUND on how many of the rest could be made
          // editable, from the website's own coarse widget census. A page with
          // nothing editable but a candidate on it still opens — that is the
          // one page a client most needs to open (found clicking the list).
          // The exact answer costs a full read per section and arrives when
          // the page is opened; the list words this as "up to N" so the two
          // can differ without the list having lied.
          adoptCandidateCount: Number(p.adopt_candidate_count || 0),
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

    /* --- Phase 3: which greyed rows could be made editable, and which
     * editable rows got that way by adoption. ---------------------------- */
    const allowPro = siteAllowsPro(site);
    const view = analysePage(sections, { allowPro });
    // The plugin has its own opinion, from its own widget census, and the two
    // are compared rather than trusted: a row the Portal is about to offer
    // that the plugin says it has never seen is a mirror drift, and the
    // Phase 2 verifier's job is to catch exactly that.
    const pluginRows = Array.isArray(data.sections) ? data.sections : [];

    let adoptions = [];
    try {
      adoptions = await listAdoptions(pool, { tenantId, siteId, pageId });
    } catch (err) {
      // The note on a row is a nicety; the page must still open without it.
      console.warn('[arion/pages:sections] adoption records unreadable:', err?.message);
    }
    const byHandle = new Map();
    for (const row of adoptions) {
      if (row.status !== 'adopted') continue;
      if (!byHandle.has(row.handle)) byHandle.set(row.handle, row);
    }

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
        sections: sections.map((entry, i) => {
          const row = view.rows[i] || {};
          const pluginRow = pluginRows[i] || null;
          return publicSection(entry, {
            adoptable: !!row.adoptable,
            adoptReason: row.reason || null,
            adoptReasonText: row.reasonText || null,
            adoptKind: row.kind || null,
            adoptKindLabel: row.kindLabel || null,
            adoptWhy: row.why || null,
            adoptPreview: row.preview || null,
            adoptConfidence: row.confidence ?? null,
            adoptConfidenceLabel: row.confidenceLabel || null,
            fingerprint: row.fingerprint || sectionFingerprint(entry.node),
            // The plugin's own pre-grey hint, so the Portal can grey a row
            // without asking arion-api to re-analyse it.
            pluginAdoptable: pluginRow ? !!pluginRow.adoptable : null,
            adoption: entry.editable ? publicAdoption(byHandle.get(entry.handle)) : null,
          });
        }),
        adoption: {
          customCount: view.customCount,
          adoptableCount: view.adoptableCount,
          undoDays: ADOPT_UNDO_DAYS,
        },
      },
      meta: { site_id: siteId, section_count: sections.length },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:sections');
  }
});

/**
 * What the Portal sees. `node` rides along so a save round-trips untouched.
 *
 * `extra` carries the Phase 3 adoption view: whether a greyed row can be made
 * editable, and whether an editable one got that way by being adopted (so the
 * row can show the note and offer "Undo adoption"). It is optional so the two
 * other callers — `POST /sections`, which just built the thing — stay as they
 * were.
 */
function publicSection(entry, extra = null) {
  const out = {
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
  return extra ? { ...out, ...extra } : out;
}

/** The adoption record a row is carrying, in the shape the Portal renders. */
function publicAdoption(row) {
  if (!row) return null;
  const at = row.adopted_at ? new Date(row.adopted_at) : null;
  const undoUntil = at ? new Date(at.getTime() + ADOPT_UNDO_DAYS * 86_400_000) : null;
  return {
    adoptionId: String(row.adoption_id),
    kind: row.kind || null,
    confidence: row.confidence == null ? null : Number(row.confidence),
    adoptedAt: at ? at.toISOString() : null,
    adoptedBy: row.actor_email || null,
    undoUntil: undoUntil ? undoUntil.toISOString() : null,
    canUndo: !!(undoUntil && undoUntil.getTime() > Date.now()),
  };
}

/* ==========================================================================
 * Shared: turn an incoming section list into the nodes to publish.
 *
 * A section we authored is PATCHED IN PLACE from its field values, so every
 * style and setting it picked up since we wrote it survives. A section we did
 * not author is passed straight back, byte for byte (SCOPE §3.3).
 * ======================================================================== */
function buildNodes(incoming, brand = null) {
  const errors = [];
  const nodes = [];

  incoming.forEach((entry, i) => {
    const node = entry?.node;
    // `section` is classic Elementor; `container` is the flexbox element every
    // curated-library blueprint is built from. Both are legitimate top-level
    // page nodes and both must survive the round trip.
    if (!node || typeof node !== 'object' || !TOP_LEVEL_EL_TYPES.has(node.elType)) {
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

    // The form's recipient, before anything else is checked — a form that
    // cannot be addressed is not a validation nicety, it is a lead going in
    // the bin (SCOPE §2.5, the 1A fail-loud rule).
    const addressed = withFormRecipient(kind, entry.fields, brand);
    if (!addressed.ok) {
      errors.push({ field: `sections[${i}].email_to`, message: addressed.message });
      return;
    }

    const check = validateFields(kind, addressed.fields);
    if (!check.ok) {
      for (const e of check.errors) {
        errors.push({ field: `sections[${i}].${e.field}`, message: e.message });
      }
      return;
    }
    nodes.push({ handle: parsed.handle, node: applyFields(node, kind, addressed.fields) });
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
  // The AI proposals this save is carrying. They are stamped `applied` AFTER
  // the write reaches the website, never before — an audit row that records a
  // publish that did not happen is worse than no audit row at all.
  const proposalIds = Array.isArray(req.body?.proposalIds) ? req.body.proposalIds : [];

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

    const brand = await loadBrandContext(pool, { tenantId, siteId });
    const { nodes, errors } = buildNodes(incoming, brand);
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

    // The write landed, so and only so the proposals it carried are `applied`.
    const stamped = proposalIds.length
      ? await markProposalsApplied(pool, { tenantId, siteId, proposalIds })
      : { applied: 0, ids: [] };

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
        proposalsApplied: stamped.applied,
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
 * ADOPTION (Phase 3, decision W-5)
 * --------------------------------------------------------------------------
 * "Never give a client a section they cannot edit" is the 1A rule. Its mirror
 * on the five existing sites is: never leave a client a section they cannot
 * edit if we can honestly offer to change that.
 *
 * The offer is per section, previewed, opt-in, and reversible:
 *
 *   adopt-preview  reads the live page, guesses the archetype, re-emits it,
 *                  renders both sides, and WRITES NOTHING ANYWHERE.
 *   adopt          re-reads the live page (the preview may be minutes old),
 *                  proves the section is still the one that was previewed,
 *                  stores the ORIGINAL BYTES, then writes through the ordinary
 *                  save path — plugin snapshot, Undo ring, cache purge.
 *   undo           splices those exact bytes back at that exact position.
 *
 * There is deliberately no "adopt everything". The Portal offers a checklist
 * and each row is ticked, so every adoption is a decision somebody made about
 * a section they looked at.
 * ======================================================================== */

/**
 * Read the live page and pull out one top-level section by index.
 *
 * Always a fresh read, never the tree the Portal is holding: the client's
 * browser may be minutes behind somebody editing in Elementor, and adoption
 * replaces a whole section.
 */
async function loadLiveSection(site, pageId, index) {
  const result = await fetchPageSections(site, pageId);
  if (!result.ok) return { ok: false, plugin: result };
  const data = result.data || {};
  const tree = Array.isArray(data.elementor_data) ? data.elementor_data : [];
  if (index < 0 || index >= tree.length) {
    return { ok: false, code: 'SECTION_NOT_FOUND', message: 'That section is not on the page any more.' };
  }
  const sections = reduceToSectionList(tree);
  return { ok: true, data, tree, sections, entry: sections[index], node: tree[index] };
}

/**
 * The index in the URL is a position in the page: 0..MAX-1, nothing else.
 * Digits only — `Number('')` and `Number(' ')` are both 0, and "adopt the
 * section at position nothing" must not resolve to "adopt the first one".
 */
function readSectionIndex(raw) {
  if (!/^\d{1,3}$/.test(String(raw ?? ''))) return null;
  const n = Number(raw);
  return n >= 0 && n < MAX_SECTIONS_PER_PAGE ? n : null;
}

/* ==========================================================================
 * GET /pages/:pageId/adoptions — what has been adopted on this page.
 * ======================================================================== */
router.get('/pages/:pageId/adoptions', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const pageId = readPageId(req.params.pageId);
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!pageId) return bad(res, 'BAD_PAGE_ID', 'That page reference is not valid.');

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const rows = await listAdoptions(pool, { tenantId, siteId, pageId });
    return res.json({
      data: {
        adoptions: rows.map((r) => ({
          ...publicAdoption(r),
          handle: r.handle,
          sectionIndex: r.section_index,
          status: r.status,
          revertedAt: r.reverted_at ? new Date(r.reverted_at).toISOString() : null,
        })),
        undoDays: ADOPT_UNDO_DAYS,
      },
      meta: { site_id: siteId, page_id: pageId, count: rows.length },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:adoptions');
  }
});

/* ==========================================================================
 * POST /pages/:pageId/sections/:index/adopt-preview
 *
 * WRITES NOTHING. Not to the website, not to our own tables. The one test
 * that matters here is the mutation test: break that and the suite goes red.
 * ======================================================================== */
router.post('/pages/:pageId/sections/:index/adopt-preview', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const pageId = readPageId(req.params.pageId);
  const index = readSectionIndex(req.params.index);
  const fixes = (req.body?.fixes && typeof req.body.fixes === 'object' && !Array.isArray(req.body.fixes))
    ? req.body.fixes : null;

  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!pageId) return bad(res, 'BAD_PAGE_ID', 'That page reference is not valid.');
  if (index === null) return bad(res, 'BAD_SECTION_INDEX', 'That section reference is not valid.');

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const live = await loadLiveSection(site, pageId, index);
    if (!live.ok) {
      if (live.plugin) return pluginFailure(res, live.plugin, 'reading that section');
      return bad(res, live.code, live.message);
    }
    if (live.entry.editable) {
      return bad(res, 'ALREADY_EDITABLE', 'You can already edit that section here.');
    }

    const allowPro = siteAllowsPro(site);
    const analysis = analyseSection(live.node, { allowPro });
    const brand = await loadBrandContext(pool, { tenantId, siteId });

    if (!analysis.adoptable) {
      // Not an error — this is the honest answer, and the Portal shows it as
      // the reason the row stays greyed. 200 with adoptable:false.
      return res.json({
        data: {
          adoptable: false,
          reason: analysis.reason,
          reasonText: analysis.reasonText,
          kind: analysis.kind,
          kindLabel: analysis.label,
          confidence: analysis.confidence,
          confidenceLabel: analysis.confidenceLabel,
          unmapped: analysis.unmapped,
          fingerprint: sectionFingerprint(live.node),
          html: null,
          saved: false,
        },
        meta: { site_id: siteId, page_id: pageId, index, min_confidence: ADOPT_MIN_CONFIDENCE },
      });
    }

    const built = buildAdoptedSection({ analysis, brand, blockId: crypto.randomUUID(), fixes });
    if (!built.ok) return bad(res, built.code, built.message, built.errors ? { errors: built.errors } : {});

    const html = renderAdoptionPreviewHtml({
      node: live.node,
      kind: built.kind,
      fields: built.fields,
      kindLabel: analysis.label,
      warnings: analysis.warnings,
      tools: previewTools,
    }, brand);

    return res.json({
      data: {
        adoptable: true,
        kind: built.kind,
        kindLabel: analysis.label,
        why: analysis.why,
        confidence: analysis.confidence,
        confidenceLabel: analysis.confidenceLabel,
        warnings: analysis.warnings,
        unmapped: analysis.unmapped,
        // What the client still has to fill in before this can be published —
        // a picture's description, most often. The Portal renders one input
        // per entry and sends them back as `fixes`.
        needsInput: analysis.needsInput,
        fields: built.fields,
        dropped: built.dropped,
        fingerprint: sectionFingerprint(live.node),
        html,
        /** Nothing has been written. The Portal shows this, and T-rows prove it. */
        saved: false,
      },
      meta: { site_id: siteId, page_id: pageId, index, min_confidence: ADOPT_MIN_CONFIDENCE },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:adopt-preview');
  }
});

/* ==========================================================================
 * POST /pages/:pageId/sections/:index/adopt — do it.
 * Body: { fingerprint, fixes? }
 * ======================================================================== */
router.post('/pages/:pageId/sections/:index/adopt', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const pageId = readPageId(req.params.pageId);
  const index = readSectionIndex(req.params.index);
  const fingerprint = String(req.body?.fingerprint || '').trim();
  const fixes = (req.body?.fixes && typeof req.body.fixes === 'object' && !Array.isArray(req.body.fixes))
    ? req.body.fixes : null;

  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!pageId) return bad(res, 'BAD_PAGE_ID', 'That page reference is not valid.');
  if (index === null) return bad(res, 'BAD_SECTION_INDEX', 'That section reference is not valid.');
  // The fingerprint comes from the preview the client just looked at. Without
  // it we would be adopting "whatever is at position 3 right now", which is a
  // different section from the one they said yes to if anything moved.
  if (!fingerprint) {
    return bad(res, 'PREVIEW_REQUIRED', 'Have a look at the before-and-after first, then tap again.');
  }

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const live = await loadLiveSection(site, pageId, index);
    if (!live.ok) {
      if (live.plugin) return pluginFailure(res, live.plugin, 'reading that section');
      return bad(res, live.code, live.message);
    }
    if (live.entry.editable) {
      return bad(res, 'ALREADY_EDITABLE', 'You can already edit that section here.');
    }
    if (sectionFingerprint(live.node) !== fingerprint) {
      return res.status(409).json({
        error: {
          code: 'SECTION_CHANGED',
          message: 'This section has changed on your website since you looked at it, so we have not '
            + 'touched it. Open the before-and-after again and it will show you what is there now.',
          status: 409,
        },
      });
    }

    const allowPro = siteAllowsPro(site);
    const analysis = analyseSection(live.node, { allowPro });
    if (!analysis.adoptable) {
      return bad(res, 'NOT_ADOPTABLE', analysis.reasonText
        || 'We cannot take charge of that section, so it is exactly as it was.');
    }

    const brand = await loadBrandContext(pool, { tenantId, siteId });
    const adoptionId = crypto.randomUUID();
    // `validate: true` only on the write path — the preview deliberately shows
    // a section that is not yet publishable so the client can see what it needs.
    const built = buildAdoptedSection({
      analysis, brand, blockId: adoptionId, fixes, validate: true,
    });
    if (!built.ok) {
      const status = built.code === 'CONTENT_NOT_VALID' ? 422 : 400;
      return res.status(status).json({
        error: { code: built.code, message: built.message, status },
        ...(built.errors ? { errors: built.errors } : {}),
      });
    }

    // A form's recipient, before anything is written — the same fail-loud rule
    // the ordinary save obeys. A form that cannot be addressed is a lead in
    // the bin, not a validation nicety (SCOPE §2.5).
    const addressed = withFormRecipient(built.kind, built.fields, brand);
    if (!addressed.ok) {
      return res.status(422).json({
        error: { code: 'NO_FORM_RECIPIENT', message: addressed.message, status: 422 },
      });
    }

    /* --- the way back goes in FIRST -------------------------------------
     * The plugin's Undo ring is whole-page, twenty deep and shared with every
     * other save, so it cannot answer "put this one section back a fortnight
     * later". This row can, and it is written before the page is touched: a
     * section must never reach the website without its original bytes already
     * stored (migration 061 explains the whole of it).
     * ------------------------------------------------------------------- */
    try {
      await recordAdoption(pool, {
        adoptionId, tenantId, siteId, pageId, sectionIndex: index,
        handle: built.handle, kind: built.kind, confidence: analysis.confidence,
        originalNode: live.node, adoptedNode: built.node,
        unmapped: analysis.unmapped,
        actorEmail: req.user?.email || null,
      });
    } catch (err) {
      if (err instanceof AdoptionTooBigError) {
        return bad(res, 'SECTION_TOO_BIG',
          'That section is too big for us to keep a copy of, so we have not changed it. '
          + 'Ask us to look at it instead.');
      }
      console.error('[arion/pages:adopt] could not store the way back:', err);
      return res.status(500).json({
        error: {
          code: 'ADOPT_NOT_RECORDED',
          message: 'We could not store a copy of this section to undo from, so we have not changed it.',
          status: 500,
        },
      });
    }

    /* --- then the ordinary save path, unchanged --------------------------- */
    const nodes = live.tree.map((node, i) => (
      i === index
        ? { handle: built.handle, node: built.node }
        : { handle: node?.settings?._title || null, node }
    ));

    const result = await writePageSections(site, pageId, { sections: nodes });
    if (!result.ok || result.data?.success === false) {
      // The write did not land, so the adoption did not happen. Retire the
      // record rather than leave a row claiming a section was adopted.
      await markReverted(pool, { tenantId, siteId, adoptionId }).catch(() => {});
      return pluginFailure(res, { ...result, ok: false, error: result.error || 'plugin_rejected' },
        'taking charge of that section');
    }

    const purge = await pluginPost(site, '/purge-cache', {});

    // Read it back through the ordinary read, and prove the thing we wanted
    // actually appeared (feedback_assert_presence_not_just_absence).
    const [entry] = reduceToSectionList([built.node]);

    return res.status(201).json({
      data: {
        adoptionId,
        pageId,
        index,
        kind: built.kind,
        handle: built.handle,
        confidence: analysis.confidence,
        section: publicSection({ ...entry, index }, {
          adoptable: false,
          adoptReason: null,
          adoptReasonText: null,
          fingerprint: sectionFingerprint(built.node),
          adoption: publicAdoption({
            adoption_id: adoptionId,
            kind: built.kind,
            confidence: analysis.confidence,
            adopted_at: new Date(),
            actor_email: req.user?.email || null,
          }),
        }),
        undoDays: ADOPT_UNDO_DAYS,
        sectionsWritten: nodes.length,
        cachePurged: !!purge.ok,
        undoCount: Number(result.data?.snapshot_count || 0),
      },
      meta: { site_id: siteId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:adopt');
  }
});

/* ==========================================================================
 * POST /pages/:pageId/adoptions/:adoptionId/undo — put the original back.
 *
 * Byte-identical. Not "something like it" — the stored JSON is spliced back in
 * at the position the adopted section now occupies, and the test asserts the
 * restored slice equals the original slice exactly.
 * ======================================================================== */
router.post('/pages/:pageId/adoptions/:adoptionId/undo', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId, adoptionId } = req.params;
  const pageId = readPageId(req.params.pageId);
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!pageId) return bad(res, 'BAD_PAGE_ID', 'That page reference is not valid.');
  if (!/^[0-9a-f-]{36}$/i.test(String(adoptionId || ''))) {
    return bad(res, 'BAD_ADOPTION_ID', 'That reference is not valid.');
  }

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const row = await getAdoption(pool, { tenantId, siteId, adoptionId });
    if (!row || Number(row.page_id) !== pageId) {
      return notFound(res, 'We have no record of taking charge of that section.');
    }
    if (row.status !== 'adopted') {
      return res.status(409).json({
        error: {
          code: 'ALREADY_UNDONE',
          message: 'That section has already been put back the way it was.',
          status: 409,
        },
      });
    }
    const adoptedAt = new Date(row.adopted_at);
    const expires = adoptedAt.getTime() + ADOPT_UNDO_DAYS * 86_400_000;
    if (Number.isFinite(expires) && expires < Date.now()) {
      return res.status(409).json({
        error: {
          code: 'UNDO_WINDOW_CLOSED',
          message: `You can put a section back the way it was for ${ADOPT_UNDO_DAYS} days. `
            + 'That window has passed, so ask us if you need it back.',
          status: 409,
        },
      });
    }

    let original;
    try {
      original = JSON.parse(row.original_json);
    } catch {
      return res.status(500).json({
        error: {
          code: 'ORIGINAL_UNREADABLE',
          message: 'We could not read the copy we kept, so nothing was changed. Please tell us about this.',
          status: 500,
        },
      });
    }

    const read = await fetchPageSections(site, pageId);
    if (!read.ok) return pluginFailure(res, read, 'reading that page');
    const tree = Array.isArray(read.data?.elementor_data) ? read.data.elementor_data : [];

    // Find the adopted section by its HANDLE first — the client may have
    // reordered the page since — and only fall back to the index it had.
    let at = tree.findIndex((n) => n?.settings?._title === row.handle);
    if (at < 0 && Number(row.section_index) < tree.length) {
      const candidate = tree[Number(row.section_index)];
      if (candidate?.settings?._title === row.handle) at = Number(row.section_index);
    }
    if (at < 0) {
      return res.status(409).json({
        error: {
          code: 'ADOPTED_SECTION_GONE',
          message: 'That section is not on the page any more, so there is nothing to put back. '
            + 'Use Undo last change if you have just removed it.',
          status: 409,
        },
      });
    }

    const nodes = tree.map((node, i) => (
      i === at
        ? { handle: original?.settings?._title || null, node: original }
        : { handle: node?.settings?._title || null, node }
    ));

    const result = await writePageSections(site, pageId, { sections: nodes });
    if (!result.ok || result.data?.success === false) {
      return pluginFailure(res, { ...result, ok: false, error: result.error || 'plugin_rejected' },
        'putting that section back');
    }

    const moved = await markReverted(pool, { tenantId, siteId, adoptionId });
    const purge = await pluginPost(site, '/purge-cache', {});

    return res.json({
      data: {
        adoptionId,
        pageId,
        index: at,
        restored: true,
        recordUpdated: moved === 1,
        cachePurged: !!purge.ok,
        undoCount: Number(result.data?.snapshot_count || 0),
      },
      meta: { site_id: siteId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:adopt-undo');
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
 * GET /media — the website's own picture library, a page at a time.
 *
 * Query: page, perPage (1-60), search.
 *
 * "Where do I get a picture from?" is the single most common reason a client
 * opens wp-admin (2026-08-24 audit §6). The picker in the edit sheet reads
 * this, so the answer is "the ones already on your website" before it is
 * "upload another one".
 * ======================================================================== */
router.get('/media', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');

  const page = Math.max(1, Number(req.query.page) || 1);
  const perPage = Math.min(60, Math.max(1, Number(req.query.perPage) || 24));
  const search = String(req.query.search || '').trim().slice(0, 120);

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const result = await listMedia(site, { page, perPage, search });
    if (!result.ok) return pluginFailure(res, result, 'reading your pictures');

    const items = Array.isArray(result.data?.items) ? result.data.items : [];
    return res.json({
      data: {
        items: items.map(publicMediaItem),
        page: Number(result.data?.page) || page,
        perPage: Number(result.data?.per_page) || perPage,
        total: Number(result.data?.total) || 0,
        totalPages: Number(result.data?.total_pages) || 0,
        search,
      },
      meta: { site_id: siteId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:media-list');
  }
});

/** One picture, in the words the picker uses. */
function publicMediaItem(row) {
  return {
    attachmentId: Number(row?.attachment_id) || null,
    url: String(row?.url || ''),
    thumbnailUrl: String(row?.thumbnail_url || row?.url || ''),
    alt: String(row?.alt || ''),
    title: String(row?.title || ''),
    filename: String(row?.filename || ''),
    mime: String(row?.mime || ''),
    width: row?.width == null ? null : Number(row.width),
    height: row?.height == null ? null : Number(row.height),
    bytes: row?.bytes == null ? null : Number(row.bytes),
    uploadedAt: row?.uploaded_at || null,
    // How many rendered sizes WordPress made. With a real attachment id on
    // the widget, Elementor turns these into srcset/sizes by itself — which
    // is why the picker hands the id back and the schema stores it.
    sizeCount: Array.isArray(row?.sizes) ? row.sizes.length : 0,
  };
}

/* ==========================================================================
 * POST /media/:attachmentId/alt — describe a picture, once, for every page
 * it appears on. Alt lives on the attachment, not on the widget.
 * ======================================================================== */
router.post('/media/:attachmentId/alt', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const attachmentId = readPageId(req.params.attachmentId);
  const alt = String(req.body?.alt ?? '').trim();

  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!attachmentId) return bad(res, 'BAD_MEDIA_ID', 'That picture reference is not valid.');
  if (!alt) return bad(res, 'ALT_REQUIRED', 'Type a short description of the picture first.');
  if (alt.length > 300) return bad(res, 'ALT_TOO_LONG', 'Keep the description under 300 characters.');

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const result = await setMediaAlt(site, attachmentId, alt);
    if (!result.ok) return pluginFailure(res, result, 'saving that description');

    return res.json({
      data: { attachmentId, alt: String(result.data?.alt ?? alt) },
      meta: { site_id: siteId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:media-alt');
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
  const blueprintId = String(req.body?.blueprintId || '').trim();
  const kind = String(req.body?.kind || '').toLowerCase();
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');

  // Either a plain archetype ("a hero, filled from my details") or one of the
  // curated library's own layouts. The library path is Phase 1B; the rule it
  // obeys is unchanged from 1A — a layout the editor cannot take charge of is
  // never offered and, if asked for anyway, is refused with the reason.
  const meta = blueprintId ? null : sectionKindMeta(kind);
  if (!blueprintId && !meta) return bad(res, 'UNKNOWN_SECTION', `We do not have a section called "${kind}".`);

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const allowPro = siteAllowsPro(site);
    if (meta?.requiresElementorPro && !allowPro) {
      return bad(res, 'SECTION_NOT_AVAILABLE', meta.proReason);
    }

    const brand = await loadBrandContext(pool, { tenantId, siteId });

    let node;
    if (blueprintId) {
      const built = await buildLibrarySection({ blueprintId, brand, allowPro });
      if (!built.ok) return bad(res, built.code, built.message);
      node = built.node;
    } else {
      const built = buildStarterSection(kind, brand);
      if (!built.ok) return bad(res, built.code.toUpperCase(), built.message);
      node = built.node;
    }

    const [entry] = reduceToSectionList([node]);
    if (!entry?.editable) {
      // Belt and braces: whatever we just built, if the ordinary read path
      // cannot edit it, the client is not getting it.
      return bad(res, 'SECTION_NOT_EDITABLE',
        'The editor could not take charge of every part of that layout, so we did not add it.');
    }
    return res.status(201).json({
      data: { section: publicSection(entry), blueprintId: blueprintId || null },
      meta: { site_id: siteId },
    });
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
    const brand = await loadBrandContext(pool, { tenantId, siteId });
    // Curated-library layouts, but only the ones the editor can look after
    // afterwards. Unreachable library (local dev, blob hiccup) means an empty
    // list and the eight scratch archetypes — a smaller menu, not a broken one.
    let variants = {};
    try {
      variants = await libraryPickerRows({ allowPro, brand });
    } catch (err) {
      console.warn('[arion/pages:section-library] library variants unavailable:', err?.message);
    }

    // The FULL field spec goes to the Portal — labels, types, limits, choices,
    // and the sub-fields of every list. The edit sheet renders from this, so
    // there is one description of a section and it lives in sectionSchema.js.
    const catalog = sectionCatalog({ allowPro }).map((entry) => ({
      ...entry,
      fields: sectionKindMeta(entry.kind).fields,
      variants: variants[entry.kind] || [],
    }));

    const gate = aiTierGate(site);
    const bookingHref = String(brand.booking_href || '');

    // Keep the site-wide "Book now" button in step with the booking page's
    // real state, without a timer and without a second Portal surface. Fire
    // and forget, throttled, and it can never affect this response — the
    // editor must not fail because a config push did.
    syncBookingButton(site, bookingHref);

    return res.json({
      data: {
        sections: catalog,
        elementorProAvailable: allowPro,
        ai: { available: gate.allowed, reason: gate.message },
        // What the editor needs to offer sensible defaults without inventing
        // anything: where "Link to your booking page" goes, and the inbox a
        // form's read-only recipient shows.
        bookingHref,
        businessEmail: String(brand.email || ''),
        // PRE-WALK 2 read "Fernbrook Garden Rooms" here for Summit Lawn: the
        // builder had its own name chain over the onboarding questionnaire.
        // It is the ONE business identity now, and a business with no recorded
        // name gets the SENTENCE, never a guess (walk rows D3, S3-7).
        businessName: brand.business_name_status === 'set'
          ? String(brand.business_name || '')
          : BUSINESS_NAME_NOT_SET,
        businessNameStatus: brand.business_name_status || 'not_set',
      },
      meta: { site_id: siteId, tier: site.arion_tier || null },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:section-library');
  }
});

/* --------------------------------------------------------------------------
 * Booking button sync (Ops B6).
 *
 * ARION knows whether the tenant owns OLIVER and has an active booking page;
 * the plugin only knows what it was last told. Pushing on every editor open
 * would be one extra HTTP per page, so it is throttled to once per site per
 * ten minutes AND skipped when nothing has changed since the last push.
 *
 * In-process memory on purpose: the worst a restart costs is one extra push.
 * ------------------------------------------------------------------------ */
const BOOKING_PUSH_TTL_MS = 10 * 60 * 1000;
const bookingPushed = new Map(); // siteId -> { href, at }

function syncBookingButton(site, bookingHref) {
  const siteId = String(site?.site_id || '');
  if (!siteId) return;
  const last = bookingPushed.get(siteId);
  const now = Date.now();
  if (last && last.href === bookingHref && (now - last.at) < BOOKING_PUSH_TTL_MS) return;
  bookingPushed.set(siteId, { href: bookingHref, at: now });

  Promise.resolve()
    .then(() => pushBookingConfig(site, { bookingUrl: bookingHref }))
    .then((r) => {
      if (!r.ok) {
        // Older plugin builds have no /booking-config; that is a 404, not a
        // fault, and it must not be retried every ten minutes forever with a
        // scary log line.
        const known = r.error === 'not_found';
        if (!known) {
          console.warn(`[arion/pages:booking-sync] ${site.domain}: ${r.error || r.status}`);
        }
      }
    })
    .catch((err) => console.warn('[arion/pages:booking-sync]', err?.message));
}

/* ==========================================================================
 * "Ask ARGUS to change it" — Phase 1B.
 *
 * Everything below PROPOSES. Nothing below writes to a website. A proposal
 * becomes real when the client approves it and the ordinary
 * PUT /pages/:pageId/sections carries it, which is why there is no "apply"
 * route here: a second write path would be a second thing to keep safe, and
 * the save path already has the snapshot, the Undo and the cache purge.
 * ======================================================================== */

/** Everything the two AI routes need before they can spend anything. */
async function aiPreflight(req, res) {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  if (!tenantId || !siteId) { bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.'); return null; }

  const pageId = readPageId(req.params.pageId);
  if (!pageId) { bad(res, 'BAD_PAGE_ID', 'That page reference is not valid.'); return null; }

  const instruction = String(req.body?.instruction || '').trim();
  if (!instruction) { bad(res, 'NO_INSTRUCTION', 'Tell us what you would like changed first.'); return null; }
  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    bad(res, 'INSTRUCTION_TOO_LONG',
      `Keep the request under ${MAX_INSTRUCTION_CHARS} characters — a sentence or two works best.`);
    return null;
  }

  const pool = await getServicesPool();
  const site = await loadSite(pool, tenantId, siteId);
  if (!site) { notFound(res, 'That website is not on your account.'); return null; }

  // The plan gate is here, ahead of everything expensive. A refused plan
  // costs no token, no credit and no round trip to a model.
  const gate = aiTierGate(site);
  if (!gate.allowed) {
    res.status(403).json({
      error: { code: 'AI_NOT_ON_THIS_PLAN', message: gate.message, status: 403 },
      meta: { current_tier: gate.tier },
    });
    return null;
  }

  const brand = await loadBrandContext(pool, { tenantId, siteId });
  return { tenantId, siteId, pageId, instruction, pool, site, brand };
}

function aiFailure(res, error) {
  const status = Number(error?.status) || 502;
  return res.status(status).json({
    error: {
      code: error?.code || 'AI_FAILED',
      message: error?.message || 'ARGUS AI could not answer just now. Nothing was changed.',
      status,
    },
    ...(error?.errors ? { errors: error.errors } : {}),
    ...(error?.balance != null ? { meta: { balance: error.balance, required: error.required } } : {}),
  });
}

/* --------------------------------------------------------------------------
 * POST /pages/:pageId/sections/:handle/ai-edit
 * Body: { instruction, section: { index?, fields, node } }
 *
 * The section travels in the body, exactly as it does for Preview: the editor
 * is looking at unsaved changes and those are what the client means when they
 * say "make this friendlier". `:handle` names the section for the audit row;
 * it is not unique on a page (two heroes share one), so `index` rides along.
 * ------------------------------------------------------------------------ */
router.post('/pages/:pageId/sections/:handle/ai-edit', async (req, res) => {
  let ctx;
  try {
    ctx = await aiPreflight(req, res);
  } catch (err) {
    return boom(res, err, 'arion/pages:ai-edit-section:preflight');
  }
  if (!ctx) return undefined;

  const handle = String(req.params.handle || '');
  const incoming = req.body?.section || {};
  const node = incoming.node;
  const parsed = parseSectionHandle(node?.settings?._title);
  const kind = parsed?.kind && sectionKindMeta(parsed.kind) ? parsed.kind : null;

  if (!kind) {
    return bad(res, 'SECTION_NOT_EDITABLE',
      'That section was built on the website itself, so ARGUS AI cannot change it here. Use “Ask us to change it”.');
  }
  const fields = (incoming.fields && typeof incoming.fields === 'object')
    ? incoming.fields
    : extractFields(node, kind);

  try {
    const result = await proposeSectionEdit({
      pool: ctx.pool,
      tenantId: ctx.tenantId,
      userId: req.user?.userId || req.user?.oid || null,
      site: ctx.site,
      kind,
      fields,
      brand: ctx.brand,
      instruction: ctx.instruction,
      // Local dev only, and only against a local database. Everything else on
      // this path — the plan gate, the balance check, the ARGUS audit row, the
      // debit — runs exactly as it does in production; the stand-in replaces
      // the provider request and nothing else. Null in every other environment.
      ...(maybeDevModel() ? { callModel: maybeDevModel() } : {}),
    });
    if (!result.ok) return aiFailure(res, result.error);

    const p = result.proposal;
    const stored = await saveProposal(ctx.pool, {
      proposalId: p.proposal_id,
      tenantId: ctx.tenantId,
      siteId: ctx.siteId,
      pageId: ctx.pageId,
      scope: 'section',
      sectionHandle: handle.slice(0, 200) || null,
      sectionIndex: Number.isInteger(Number(incoming.index)) ? Number(incoming.index) : null,
      sectionKind: kind,
      instruction: ctx.instruction,
      before: p.before,
      after: p.after,
      diffPlain: p.diff_plain,
      creditsCharged: p.cost_units,
      model: p.model,
      actorEmail: req.user?.email || null,
    });

    return res.status(201).json({
      data: {
        proposal_id: p.proposal_id,
        scope: 'section',
        kind,
        before: p.before,
        after: p.after,
        diff: p.diff,
        diff_plain: p.diff_plain,
        summary: p.summary,
        cost_units: p.cost_units,
        recorded: stored.stored,
        poweredBy: 'ARGUS AI',
      },
      meta: { site_id: ctx.siteId, page_id: ctx.pageId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:ai-edit-section');
  }
});

/* --------------------------------------------------------------------------
 * POST /pages/:pageId/ai-edit
 * Body: { instruction, sections: [ { fields, node } ] }
 *
 * Page-level: "make the tone warmer", "add a section about winter services".
 * It may propose edits to existing sections AND brand-new sections, which the
 * Portal shows as rows marked "· proposed" until they are approved.
 * ------------------------------------------------------------------------ */
router.post('/pages/:pageId/ai-edit', async (req, res) => {
  let ctx;
  try {
    ctx = await aiPreflight(req, res);
  } catch (err) {
    return boom(res, err, 'arion/pages:ai-edit-page:preflight');
  }
  if (!ctx) return undefined;

  const incoming = Array.isArray(req.body?.sections) ? req.body.sections : null;
  if (!incoming || incoming.length === 0) {
    return bad(res, 'NO_SECTIONS', 'There is nothing on this page to change yet.');
  }
  if (incoming.length > MAX_SECTIONS_PER_PAGE) {
    return bad(res, 'TOO_MANY_SECTIONS', `A page can hold up to ${MAX_SECTIONS_PER_PAGE} sections.`);
  }

  // Describe the page to the engine in its own vocabulary: which sections it
  // may touch, and what they currently say.
  const described = incoming.map((entry, i) => {
    const parsed = parseSectionHandle(entry?.node?.settings?._title);
    const kind = parsed?.kind && sectionKindMeta(parsed.kind) ? parsed.kind : null;
    const fields = (entry?.fields && typeof entry.fields === 'object')
      ? entry.fields
      : (kind ? extractFields(entry.node, kind) : null);
    return { index: i, kind, editable: !!kind && !!fields, fields };
  });

  try {
    const result = await proposePageEdit({
      pool: ctx.pool,
      tenantId: ctx.tenantId,
      userId: req.user?.userId || req.user?.oid || null,
      site: ctx.site,
      sections: described,
      brand: ctx.brand,
      instruction: ctx.instruction,
      ...(maybeDevModel() ? { callModel: maybeDevModel() } : {}),
    });
    if (!result.ok) return aiFailure(res, result.error);

    const p = result.proposal;

    // A proposed NEW section needs a real Elementor node before the editor can
    // show it, preview it or save it. The server builds it, the same way "add
    // a section" does, and then applies the proposed copy to it — the Portal
    // still never invents Elementor JSON.
    const additions = [];
    for (const add of p.additions) {
      const built = buildStarterSection(add.kind, ctx.brand);
      if (!built.ok) continue;
      const base = extractFields(built.node, add.kind);
      const merged = { ...base, ...add.fields };
      const check = validateFields(add.kind, merged);
      if (!check.ok) continue;
      const node = applyFields(built.node, add.kind, merged);
      const [entry] = reduceToSectionList([node]);
      if (!entry?.editable) continue;
      additions.push({
        afterIndex: add.afterIndex,
        label: add.label,
        diff: add.diff,
        section: publicSection(entry),
      });
    }

    if (p.edits.length === 0 && additions.length === 0) {
      return res.status(422).json({
        error: {
          code: 'AI_NOTHING_TO_CHANGE',
          message: 'ARGUS AI did not find anything it could change for that request. Try describing it a different way.',
          status: 422,
        },
      });
    }

    const stored = await saveProposal(ctx.pool, {
      proposalId: p.proposal_id,
      tenantId: ctx.tenantId,
      siteId: ctx.siteId,
      pageId: ctx.pageId,
      scope: 'page',
      instruction: ctx.instruction,
      before: p.edits.map((e) => ({ index: e.index, fields: e.before })),
      after: {
        edits: p.edits.map((e) => ({ index: e.index, fields: e.after })),
        additions: additions.map((a) => ({ afterIndex: a.afterIndex, kind: a.section.kind, fields: a.section.fields })),
      },
      diffPlain: p.diff_plain,
      creditsCharged: p.cost_units,
      model: p.model,
      actorEmail: req.user?.email || null,
    });

    return res.status(201).json({
      data: {
        proposal_id: p.proposal_id,
        scope: 'page',
        edits: p.edits.map((e) => ({
          index: e.index, kind: e.kind, label: e.label, before: e.before, after: e.after, diff: e.diff,
        })),
        additions,
        skipped: p.skipped,
        diff_plain: p.diff_plain,
        summary: p.summary,
        cost_units: p.cost_units,
        recorded: stored.stored,
        poweredBy: 'ARGUS AI',
      },
      meta: { site_id: ctx.siteId, page_id: ctx.pageId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:ai-edit-page');
  }
});

/* --------------------------------------------------------------------------
 * POST /proposals/:proposalId/discard — the client said no.
 *
 * No refund, and the row says so: the model call happened and ARGUS debited
 * it at call time. Pretending otherwise would mean the credit ledger and the
 * proposal list disagree.
 * ------------------------------------------------------------------------ */
router.post('/proposals/:proposalId/discard', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId, proposalId } = req.params;
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!/^[0-9a-f-]{36}$/i.test(String(proposalId || ''))) {
    return bad(res, 'BAD_PROPOSAL_ID', 'That suggestion reference is not valid.');
  }

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const moved = await resolveProposal(pool, { tenantId, siteId, proposalId, status: 'discarded' });
    if (moved === 0) {
      return res.status(409).json({
        error: {
          code: 'PROPOSAL_ALREADY_RESOLVED',
          message: 'That suggestion has already been used or thrown away.',
          status: 409,
        },
      });
    }
    return res.json({ data: { proposalId, status: 'discarded' }, meta: { site_id: siteId } });
  } catch (err) {
    return boom(res, err, 'arion/pages:proposal-discard');
  }
});

/* --------------------------------------------------------------------------
 * GET /pages/:pageId/proposals — what ARGUS has suggested on this page.
 * ------------------------------------------------------------------------ */
router.get('/pages/:pageId/proposals', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const pageId = readPageId(req.params.pageId);
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!pageId) return bad(res, 'BAD_PAGE_ID', 'That page reference is not valid.');

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    let rows = [];
    try {
      rows = await listProposals(pool, { tenantId, siteId, pageId });
    } catch (err) {
      // Migration 059 not applied here yet. An empty history is the truth in
      // that case, and it must not take the editor down with it.
      console.warn('[arion/pages:proposals] history unavailable:', err?.message);
    }
    return res.json({
      data: {
        proposals: rows.map((r) => ({
          proposalId: r.proposal_id,
          scope: r.scope,
          sectionKind: r.section_kind,
          sectionIndex: r.section_index,
          instruction: r.instruction,
          diffPlain: r.diff_plain,
          status: r.status,
          creditsCharged: r.credits_charged,
          by: r.actor_email,
          createdAt: r.created_at,
          resolvedAt: r.resolved_at,
        })),
      },
      meta: { site_id: siteId, page_id: pageId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:proposals');
  }
});

/* --------------------------------------------------------------------------
 * GET /ai-pricing — what an AI action costs, read from the database.
 *
 * The Portal shows "This uses N credits" BEFORE the client sends anything,
 * and N comes from here. It is never hardcoded in the UI: the existing
 * WebsiteAiBuilder page does exactly that and the server charges something
 * else, which is the defect SCOPE §2.4 records (feedback_no_fabricated_catalog).
 * ------------------------------------------------------------------------ */
router.get('/ai-pricing', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const gate = aiTierGate(site);
    const actions = {};
    for (const [key, actionType] of [['section', ACTION_SECTION_EDIT], ['page', ACTION_PAGE_EDIT]]) {
      let row = null;
      try {
        row = await getActionPricing(pool, actionType);
      } catch (err) {
        console.warn(`[arion/pages:ai-pricing] ${actionType} unreadable:`, err?.message);
      }
      actions[key] = {
        actionType,
        credits: row && row.is_active ? Number(row.credits_per_call) : null,
        available: !!(row && row.is_active),
      };
    }

    return res.json({
      data: {
        actions,
        ai: { available: gate.allowed, reason: gate.message },
        poweredBy: 'ARGUS AI',
      },
      meta: { site_id: siteId, tier: site.arion_tier || null },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:ai-pricing');
  }
});

export default router;
export const __test__ = {
  buildNodes, siteAllowsPro, readPageId, ALLOWED_MEDIA_TYPES, MAX_SECTIONS_PER_PAGE,
  TOP_LEVEL_EL_TYPES, aiFailure, withFormRecipient, publicMediaItem,
  syncBookingButton, bookingPushed, BOOKING_PUSH_TTL_MS,
  readSectionIndex, publicSection, publicAdoption, loadLiveSection,
};

