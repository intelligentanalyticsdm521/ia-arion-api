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
 * preview that never writes to the page being previewed. New pages are born
 * drafts. There is no per-page staging and there is deliberately not going to
 * be one.
 *
 * ELEMENTOR IS DETECTED, NOT ASSUMED (D-ARION-E, 2026-09-08). Every write below
 * asks lib/websiteBuilder/siteCapability.js what the site actually has and
 * refuses with a sentence when the site says it has no Elementor. Before this,
 * such a save answered 200 and left the page blank on a green toast.
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
 *   POST   /pages/:pageId/preview       -> a signed WordPress preview link
 *   GET    /pages/:pageId/settings      -> slug, layout, parent, home page
 *   POST   /pages/:pageId/settings
 *   POST   /pages/:pageId/trash         -> into WordPress's bin (30 days)
 *   POST   /pages/:pageId/restore
 *   GET    /pages/:pageId/seo           -> title, description, focus keyword
 *   POST   /pages/:pageId/seo
 *   POST   /sections/swap               -> the same words, a different layout
 *   POST   /media                       -> sideload into the site's library
 *   GET    /media/:attachmentId/usage   -> where is this picture used
 *   DELETE /media/:attachmentId         -> only when the answer is nowhere
 *   POST   /media/:attachmentId/replace -> same id, so every page updates
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
  sectionCatalog, sectionKindMeta, parseSectionHandle, swapItemRoles,
} from '../../lib/websiteBuilder/sectionSchema.js';
import { renderAdoptionPreviewHtml } from '../../lib/websiteBuilder/sectionPreview.js';
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
  // ARION pack 1 — the wp-admin-only jobs, all on the same site token.
  fetchPageSettings, writePageSettings, fetchPageSeo, writePageSeo,
  // The site's own header menu, for the builder's page chrome.
  fetchMenus,
  previewPage, trashPage, restorePage,
  fetchMediaUsage, deleteMedia, replaceMedia,
} from '../../lib/websiteBuilder/pageClient.js';
import {
  getSiteCapability, elementorRefusal, allowProFor, NO_ELEMENTOR_MESSAGE,
} from '../../lib/websiteBuilder/siteCapability.js';
import { pluginPost } from '../../lib/pluginClient.js';
// THE WIDGET PANE'S THREE STATES (D-156 conformance, audit point 7). What a
// widget NEEDS lives beside the widget; what this business HAS is asked here,
// through the seams that already answer it — the site (`siteCapability`) and
// `core.tenant_services` (`coreTenants`). No third copy of a tier table.
import {
  widgetCatalog, productsNeeded, ownedProductsFrom, UnsupportedWidgetError,
} from '../../lib/websiteBuilder/elementorWidgets.js';
import { tenantServiceOwnership } from '../../lib/coreTenants.js';
import {
  proposeSectionEdit, proposePageEdit, aiTierGate,
  ACTION_SECTION_EDIT, ACTION_PAGE_EDIT, MAX_INSTRUCTION_CHARS,
} from '../../lib/websiteBuilder/aiEdit.js';
import {
  saveProposal, markProposalsApplied, resolveProposal, listProposals,
} from '../../lib/websiteBuilder/proposalStore.js';
// D-05: an unpublished change has somewhere to live that is NOT the live page.
import {
  saveDraft, getDraft, clearDraft, draftPageIds, wouldUnpublish, UNPUBLISH_REFUSAL,
} from '../../lib/websiteBuilder/pageDraftStore.js';
import {
  libraryPickerRows, buildLibrarySection, neutraliseSampleWords,
} from '../../lib/websiteBuilder/libraryCatalog.js';
import { maybeDevModel } from '../../lib/websiteBuilder/aiDevStub.js';
import { getActionPricing } from '../../lib/argus/callWrapper.js';
import {
  ACTION_GENERATE_SECTION, ACTION_ASSEMBLE_PAGE,
} from '../../lib/websiteBuilder/builderMeter.js';

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

/**
 * THE FALLBACK ONLY (D-ARION-E, 2026-09-08).
 *
 * This used to be the whole answer to "does this site have Elementor Pro", and
 * it never asked the site. `lib/websiteBuilder/siteCapability.js` asks now;
 * this stays as what we fall back to when the site cannot be asked (a plugin
 * older than 1.7.3, or a site that is not answering), because it is what we had
 * before and it is better than refusing a working client their own editor.
 *
 * Reached through `allowProFor(site, capability)`, never called directly by a
 * route any more.
 */
function siteAllowsPro(site) {
  const tier = String(site?.arion_tier || '').trim().toLowerCase();
  return tier !== 'lite';
}

/**
 * The write gate. Returns null to carry on, or sends the refusal and returns
 * true — so a caller reads `if (await refuseWithoutElementor(res, site)) return;`
 *
 * Only a site that TOLD us it has no Elementor is refused. See siteCapability's
 * three answers: "we could not ask" is not "there is none".
 */
async function refuseWithoutElementor(res, site) {
  const capability = await getSiteCapability(site);
  const refusal = elementorRefusal(capability);
  if (!refusal) return false;
  res.status(refusal.status).json({
    error: { code: refusal.code, message: refusal.message, status: refusal.status },
    meta: {
      elementor_active: false,
      elementor_version: capability.elementorVersion,
      plugin_version: capability.pluginVersion,
    },
  });
  return true;
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
 *                     (intelligent-analytics.php process_submission())
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
    // D-05: which live pages have work saved but not published. One query for
    // the whole list — a row per page would be a round trip per row, and the
    // Pages screen is the first thing a client opens.
    const withDrafts = await draftPageIds(pool, { tenantId, siteId });
    return res.json({
      data: {
        pages: pages.map((p) => ({
          /** Work saved in the builder that the public has not seen (D-05). */
          hasUnpublishedDraft: withDrafts.has(Number(p.page_id)),
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
  // D-ARION-C: a blog post is composed in the SAME section editor as a page.
  // Everything downstream already accepts a post; the only thing that made
  // "write a post" a wp-admin job was that nothing could create one here.
  const type = String(req.body?.type || 'page').toLowerCase();

  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!title) return bad(res, 'TITLE_REQUIRED', 'Give the page a name first.');
  if (type !== 'page' && type !== 'post') return bad(res, 'BAD_TYPE', 'That is not something we can create.');
  if (wanted.length > MAX_SECTIONS_PER_PAGE) {
    return bad(res, 'TOO_MANY_SECTIONS', `A page can hold up to ${MAX_SECTIONS_PER_PAGE} sections.`);
  }

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    if (await refuseWithoutElementor(res, site)) return undefined;

    const brand = await loadBrandContext(pool, { tenantId, siteId });
    const capability = await getSiteCapability(site);
    const { allowPro } = allowProFor(site, capability);

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

    const result = await createPage(site, { title, type, sections: nodes });
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
        type: String(result.data?.type || type),
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
    const capability = await getSiteCapability(site);
    const { allowPro } = allowProFor(site, capability);
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

    /* D-05: the unpublished draft, if the author left one. `sections` below is
     * still WHAT IS LIVE — the two are sent side by side rather than one
     * overwriting the other, because "Live · draft saved, not published" is
     * two facts and a screen that can only hold one of them is how the walk
     * ended up looking at a 404. */
    const draft = await getDraft(pool, { tenantId, siteId, pageId });

    return res.json({
      data: {
        pageId: Number(data.page_id) || pageId,
        draft: draft ? { savedAt: draft.savedAt, savedBy: draft.savedBy, title: draft.title, sections: draft.sections } : null,
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
    // Which fields of a list item THIS layout has somewhere to keep, and any
    // role the adapter had to guess at. Both null on a section built from our
    // own archetypes, where every field always has a home (pack 2b).
    itemFields: entry.itemFields ?? null,
    roleReview: entry.roleReview ?? null,
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
/**
 * What the WIDGET emitters need to know about this website, gathered once.
 *
 * B-168. A free section may now hold any widget the families publish, and some
 * of those need a plan (`pro`) or one of our products (`ia:<product>`). The
 * answer to "what does this business HAVE" is the one that already exists —
 * `siteCapability` asks the site and `allowProFor` falls back to the tier — and
 * it is handed to `applyFields`, never re-decided inside it.
 *
 * `ownedProducts` is deliberately not asked here: `lockSentence` treats null as
 * "we could not ask", which locks nothing, and refusing a save because an
 * ownership query was slow is the D-ARION-E defect with a new address. The pane
 * already gates the ADD with the real ownership, and a widget the site cannot
 * draw is still refused below, by name.
 */
async function widgetContextFor(site, brand = null) {
  const capability = await getSiteCapability(site);
  const { allowPro } = allowProFor(site, capability);
  return {
    allowPro,
    iaWidgets: capability.iaWidgets ?? null,
    emailTo: String(brand?.email || ''),
  };
}

function buildNodes(incoming, brand = null, widgetCtx = {}) {
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
    /* A WIDGET THIS SITE CANNOT DRAW IS REFUSED BY NAME, NOT SWALLOWED.
     * `resolveWidget` throws `UnsupportedWidgetError` with its own plain
     * sentence — "Available on ARION Standard and above", "we will switch it on
     * for you" — and that sentence is what the author reads. Anything else is a
     * real bug and still boils up to the route's 500, because a page that
     * silently lost a widget is the green-toast-over-a-blank-page failure. */
    try {
      nodes.push({ handle: parsed.handle, node: applyFields(node, kind, addressed.fields, widgetCtx) });
    } catch (err) {
      if (err instanceof UnsupportedWidgetError || err?.code === 'WIDGET_NOT_ON_PLAN') {
        errors.push({ field: `sections[${i}]`, message: err.message });
        return;
      }
      throw err;
    }
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

    /* ── D-05: A SAVE NEVER TAKES A PAGE OFF THE INTERNET ────────────────
     * "Save draft" on a live page used to send status:'draft', which is the
     * same wire as Unpublish — the public URL started returning 404 and the
     * only clue was the page moving into a list headed "Nobody can see these".
     * An unpublished change now lives in arion.site_page_draft (PUT
     * /pages/:pageId/draft); the one way to make a live page a draft is to say
     * so, which the Portal only does behind the Unpublish confirm.
     *
     * The page's CURRENT status is read from the website, not taken from the
     * caller: a client that got it wrong would otherwise talk its way past the
     * guard. */
    if (status === 'draft' && req.body?.unpublish !== true) {
      const current = await fetchPageSections(site, pageId);
      const currentStatus = current.ok ? String(current.data?.status || '') : '';
      if (wouldUnpublish({ currentStatus, requestedStatus: status, unpublish: req.body?.unpublish })) {
        return res.status(409).json({
          error: { code: 'WOULD_UNPUBLISH', message: UNPUBLISH_REFUSAL, status: 409 },
        });
      }
    }

    // Ahead of everything: a site with no Elementor cannot render what we are
    // about to write, and writing it anyway is the blank page this pack exists
    // to stop. The plugin refuses too — two ends, on purpose.
    if (await refuseWithoutElementor(res, site)) return undefined;

    const brand = await loadBrandContext(pool, { tenantId, siteId });
    const { nodes, errors } = buildNodes(incoming, brand, await widgetContextFor(site, brand));
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

    /* The write reached the website, so whatever was being held back is now on
     * it: the draft has been consumed and the row goes. Cleared AFTER the
     * write, never alongside it — the same ordering as the proposal stamp
     * above, and for the same reason. */
    const draftCleared = await clearDraft(pool, { tenantId, siteId, pageId });

    return res.json({
      data: {
        pageId,
        draftCleared: draftCleared.removed > 0,
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
 * PUT /pages/:pageId/draft — hold this work beside the live page (D-05).
 * DELETE /pages/:pageId/draft — throw it away.
 * --------------------------------------------------------------------------
 * Body: { sections: [...], title? }
 *
 * This is what "Save draft" means on a page that is already on the internet.
 * Nothing is sent to the website: the visitor keeps seeing what they were
 * seeing, and the author's work is here when they come back. Publishing is the
 * ordinary PUT /sections with status=publish, which consumes the row.
 *
 * The sections are validated the same way a save validates them — a draft you
 * cannot publish is a trap, and finding out at Publish time is exactly the
 * "I pressed the button and nothing happened" the walk wrote up.
 * ======================================================================== */
router.put('/pages/:pageId/draft', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const pageId = readPageId(req.params.pageId);
  const incoming = Array.isArray(req.body?.sections) ? req.body.sections : null;
  const title = req.body?.title == null ? null : String(req.body.title).trim();

  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!pageId) return bad(res, 'BAD_PAGE_ID', 'That page reference is not valid.');
  if (!incoming || incoming.length === 0) return bad(res, 'NO_SECTIONS', 'There is nothing to save yet.');
  if (incoming.length > MAX_SECTIONS_PER_PAGE) {
    return bad(res, 'TOO_MANY_SECTIONS', `A page can hold up to ${MAX_SECTIONS_PER_PAGE} sections.`);
  }

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const brand = await loadBrandContext(pool, { tenantId, siteId });
    const { nodes, errors } = buildNodes(incoming, brand, await widgetContextFor(site, brand));
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
    if (nodes.length !== incoming.length) {
      return res.status(500).json({
        error: {
          code: 'SECTION_COUNT_MISMATCH',
          message: 'We could not hold that draft safely, so nothing was saved.',
          status: 500,
        },
      });
    }

    const stored = await saveDraft(pool, {
      tenantId, siteId, pageId, sections: incoming, title,
      savedBy: req.user?.email || null,
    });
    // NEVER a green answer on a write that did not land
    // (reference_catch_swallow_report_success).
    if (!stored.ok) {
      return res.status(503).json({
        error: { code: 'DRAFT_NOT_HELD', message: stored.reason, status: 503 },
      });
    }

    return res.json({
      data: {
        pageId,
        savedAt: stored.savedAt,
        sectionsHeld: incoming.length,
        /** Said out loud, because it is the whole point of this route. */
        published: false,
      },
      meta: { site_id: siteId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:draft-save');
  }
});

router.delete('/pages/:pageId/draft', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const pageId = readPageId(req.params.pageId);
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!pageId) return bad(res, 'BAD_PAGE_ID', 'That page reference is not valid.');

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');
    const cleared = await clearDraft(pool, { tenantId, siteId, pageId });
    if (!cleared.ok) {
      return res.status(503).json({
        error: {
          code: 'DRAFT_NOT_CLEARED',
          message: 'We could not throw that draft away. Nothing on your website changed.',
          status: 503,
        },
      });
    }
    return res.json({ data: { pageId, removed: cleared.removed }, meta: { site_id: siteId } });
  } catch (err) {
    return boom(res, err, 'arion/pages:draft-clear');
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

    if (await refuseWithoutElementor(res, site)) return undefined;

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
 * POST /pages/:pageId/preview — WORDPRESS renders it (D-ARION-B).
 * --------------------------------------------------------------------------
 * This used to render the section list to arion-api's own HTML, and
 * lib/websiteBuilder/sectionPreview.js said so in its own header: "It is NOT a
 * pixel-accurate render of the live theme — we do not run Elementor here and we
 * never will". A builder whose preview does not match the site is the complaint
 * this whole area exists to fix, so the preview is now the site itself: the real
 * theme, the real Elementor render, the real fonts and colours.
 *
 * HOW IT STAYS SAFE: the plugin puts the candidate sections on a companion
 * DRAFT page (`_ia_preview_of`), never on the page being previewed, and hands
 * back a link carrying a one-hour key so the client — who has no WordPress
 * account — can open it. The page being previewed keeps its bytes, its
 * snapshots and its Undo ring. `saved:false` rides in the payload and the
 * Portal says it out loud.
 *
 * The approximate renderer is GONE (feedback_replace_means_delete). What is
 * left in sectionPreview.js is the adoption before/after, which answers a
 * different question — "does every word survive if we rebuild this section" —
 * and is not replaced by anything here.
 * ======================================================================== */
router.post('/pages/:pageId/preview', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const pageId = readPageId(req.params.pageId);
  const incoming = Array.isArray(req.body?.sections) ? req.body.sections : null;
  const title = req.body?.title == null ? null : String(req.body.title).trim();

  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!pageId) return bad(res, 'BAD_PAGE_ID', 'That page reference is not valid.');
  if (!incoming) return bad(res, 'NO_SECTIONS', 'There is nothing to preview yet.');
  if (incoming.length === 0) return bad(res, 'NO_SECTIONS', 'There is nothing to preview yet.');
  if (incoming.length > MAX_SECTIONS_PER_PAGE) {
    return bad(res, 'TOO_MANY_SECTIONS', `A page can hold up to ${MAX_SECTIONS_PER_PAGE} sections.`);
  }

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    // No Elementor, no preview. Rendering a blank page and calling it a preview
    // is worse than saying why.
    if (await refuseWithoutElementor(res, site)) return undefined;

    const brand = await loadBrandContext(pool, { tenantId, siteId });

    // The same nodes a Save would write, built the same way, so what the client
    // is looking at IS what publishing does. A form with no recipient is
    // refused here too — a preview that shows a form the save would reject
    // would send somebody to Publish for the error.
    const { nodes, errors } = buildNodes(incoming, brand, await widgetContextFor(site, brand));
    if (errors.length > 0) {
      return res.status(422).json({
        error: {
          code: 'CONTENT_NOT_VALID',
          message: 'Some of what you typed needs another look before it can be previewed. Nothing was saved.',
          status: 422,
        },
        errors,
      });
    }
    if (nodes.length !== incoming.length) {
      return res.status(500).json({
        error: {
          code: 'SECTION_COUNT_MISMATCH',
          message: 'We could not build the preview safely, so nothing was changed.',
          status: 500,
        },
      });
    }

    const result = await previewPage(site, pageId, {
      sections: nodes,
      ...(title ? { title } : {}),
    });
    if (!result.ok) return pluginFailure(res, result, 'building a preview');

    const previewUrl = result.data?.preview_url;
    if (!previewUrl) {
      // A 200 with no link is a failed preview wearing a success.
      return res.status(502).json({
        error: {
          code: 'SITE_REJECTED',
          message: 'Your website built the preview but did not say where it is. Try again.',
          status: 502,
        },
      });
    }

    return res.json({
      data: {
        pageId,
        previewUrl: String(previewUrl),
        expiresAt: result.data?.expires_at || null,
        ttlSeconds: Number(result.data?.ttl_seconds || 0),
        sectionCount: Number(result.data?.sections_previewed || nodes.length),
        /** The page itself was not touched. The Portal shows this. */
        saved: false,
      },
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

    const capability = await getSiteCapability(site);
    const { allowPro } = allowProFor(site, capability);
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

    if (await refuseWithoutElementor(res, site)) return undefined;

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

    const capability = await getSiteCapability(site);
    const { allowPro } = allowProFor(site, capability);
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

    const capability = await getSiteCapability(site);
    const { allowPro } = allowProFor(site, capability);
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

    const capability = await getSiteCapability(site);
    const { allowPro, source: proSource } = allowProFor(site, capability);
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
    const ownership = await tenantServiceOwnership(tenantId, productsNeeded());
    const ownedProducts = ownedProductsFrom(ownership);
    const catalog = sectionCatalog({ allowPro, ownedProducts }).map((entry) => ({
      ...entry,
      fields: sectionKindMeta(entry.kind).fields,
      variants: variants[entry.kind] || [],
    }));

    /* THE WIDGETS, with the same three words a section carries.
     *
     * One question per product, asked once, on the reply the builder already
     * makes on open (convention_data_fetching). `known:false` — a query we
     * could not run — locks NOTHING: telling a client they do not own a
     * product because a database call failed is worse than offering a widget
     * whose publish would refuse with a reason. */
    const widgets = widgetCatalog({
      allowPro,
      iaWidgets: capability.iaWidgets ?? null,
      iaShortcodes: capability.iaShortcodes ?? null,
      ownedProducts,
    });

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
        // One row per widget: `tier` ('free' | 'pro' | 'ia:<product>'),
        // `available`, `reason` ('tier' | 'ownership') and the sentence the
        // client reads. Three states, three sentences, never the bare word
        // "locked" (`reference_nav_visibility_semantics`).
        widgets,
        elementorProAvailable: allowPro,
        // What the site itself says it is running (D-ARION-E). The editor shows
        // a banner and stops offering Save when `active` is false, rather than
        // letting a client type into a form whose save is going to be refused.
        //
        // `pageEngine` and not the vendor's name, deliberately: the Portal is
        // the one place a client reads, and no vendor's UI or vocabulary is ever
        // shown there (feedback_no_third_party_product_surface). The plugin's
        // /status and lib/websiteBuilder/siteCapability.js name it accurately,
        // because nothing a client reads comes off either of them.
        pageEngine: {
          known: !!capability.known,
          active: capability.known ? !!capability.elementorActive : null,
          version: capability.elementorVersion,
          addOnActive: capability.known ? !!capability.proActive : null,
          addOnVersion: capability.proVersion,
          addOnSource: proSource,
          reason: (capability.known && !capability.elementorActive) ? NO_ELEMENTOR_MESSAGE : null,
        },
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
        // THE SITE'S OWN HEADER AND FOOTER (2026-09-16, the website builder).
        //
        // The builder draws them above and below the page as CHROME, so a page
        // never opens looking like it starts at the hero — §7's "the header is
        // pre-placed and already shows the business's information". They are
        // theme-level: the same on every page, edited under Website → Menus,
        // and NOT part of what a publish writes.
        //
        // Best effort by design: a website that will not answer /menus gets an
        // empty menu and a builder that still works. It is chrome.
        chrome: {
          businessName: brand.business_name_status === 'set' ? String(brand.business_name || '') : '',
          logoUrl: String(brand.logo_url || ''),
          contactLine: [brand.email, brand.location].filter(Boolean).join(' · '),
          menu: await primaryMenuItems(site),
        },
      },
      meta: { site_id: siteId, tier: site.arion_tier || null },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:section-library');
  }
});

/**
 * The labels on the site's own primary menu, for the builder's header chrome.
 *
 * Labels only — this draws a picture of the header, it does not edit it, and
 * shipping the URLs would invite somebody to try. Never throws: a menu we
 * cannot read is an empty header band, not a page that will not open.
 */
async function primaryMenuItems(site) {
  try {
    const res = await fetchMenus(site);
    if (!res.ok) return [];
    const menus = Array.isArray(res.data?.menus) ? res.data.menus : [];
    const primary = menus.find((m) => (m.locations || []).includes('primary')) || menus[0];
    return (Array.isArray(primary?.items) ? primary.items : [])
      .filter((i) => Number(i?.parent || 0) === 0)
      .slice(0, 8)
      .map((i) => ({ label: String(i?.title || i?.label || '').trim() }))
      .filter((i) => i.label);
  } catch {
    return [];
  }
}

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

/* ==========================================================================
 * ARION PACK 1 — the jobs that had no Portal home at all (2026-09-08)
 * --------------------------------------------------------------------------
 * Page settings, per-page SEO, trash and restore, swap-the-look, and the two
 * media jobs. Every one of them goes through the PLUGIN on the site token.
 *
 * The route that used to do SEO — PUT /arion/sites/:siteId/content-seo/:postId
 * — is still there and still dead: it needs `arion.site.wp_app_password_ref`,
 * which is NULL on all five production sites and has never been written by
 * anything, and it is gated at Pro. Depth is what a tier gates, not existence
 * (memory: reference_report_tier_model), so these are on every ARION tier.
 * ======================================================================== */

/** The three Elementor page templates, in words a client uses. */
const TEMPLATE_LABELS = Object.freeze({
  '': 'Normal page (your theme’s header and footer)',
  'elementor_header_footer': 'Full width, with your header and footer',
  'elementor_canvas': 'Blank canvas (no header or footer)',
  'elementor_theme': 'Your theme’s own layout',
});

function publicTemplates(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    file: String(r?.file ?? ''),
    label: TEMPLATE_LABELS[String(r?.file ?? '')] || String(r?.label || r?.file || ''),
  }));
}

function publicPageSettings(data) {
  return {
    pageId: Number(data?.page_id) || null,
    title: String(data?.title || ''),
    slug: String(data?.slug || ''),
    // What the address will BECOME when a draft is published, if WordPress has
    // to make it unique. Equal to `slug` when there is nothing to change.
    slugOnPublish: String(data?.slug_on_publish || data?.slug || ''),
    status: String(data?.status || 'draft'),
    type: String(data?.type || 'page'),
    permalink: data?.permalink || null,
    template: String(data?.template ?? ''),
    templates: publicTemplates(data?.templates),
    parentId: Number(data?.parent_id || 0),
    parents: (Array.isArray(data?.parents) ? data.parents : []).map((p) => ({
      pageId: Number(p?.page_id) || null,
      title: String(p?.title || '(no title)'),
      status: String(p?.status || 'draft'),
    })),
    isHomePage: !!data?.is_front_page,
    homePageId: Number(data?.front_page_id || 0),
    blogPageId: Number(data?.blog_page_id || 0),
    // A blog post's own four (D-ARION-C). `null` on a page, so the Portal
    // shows the card only where it means something.
    postFields: data?.post_fields
      ? {
          excerpt: String(data.post_fields.excerpt || ''),
          categories: (Array.isArray(data.post_fields.categories) ? data.post_fields.categories : []).map(String),
          tags: (Array.isArray(data.post_fields.tags) ? data.post_fields.tags : []).map(String),
          featuredImage: {
            id: Number(data.post_fields.featured_image?.id || 0),
            url: String(data.post_fields.featured_image?.url || ''),
          },
          allCategories: (Array.isArray(data.post_fields.all_categories) ? data.post_fields.all_categories : []).map(String),
        }
      : null,
    ...(data?.slug_adjusted ? { slugAdjusted: true } : {}),
    ...(Array.isArray(data?.changed) ? { changed: data.changed } : {}),
  };
}

/* ==========================================================================
 * GET /pages/:pageId/settings
 * ======================================================================== */
router.get('/pages/:pageId/settings', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const pageId = readPageId(req.params.pageId);
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!pageId) return bad(res, 'BAD_PAGE_ID', 'That page reference is not valid.');

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const result = await fetchPageSettings(site, pageId);
    if (!result.ok) return pluginFailure(res, result, 'reading that page’s settings');
    return res.json({ data: publicPageSettings(result.data), meta: { site_id: siteId } });
  } catch (err) {
    return boom(res, err, 'arion/pages:settings-get');
  }
});

/* ==========================================================================
 * POST /pages/:pageId/settings
 * Body: { slug?, template?, parentId?, makeHomePage? }
 *
 * The website reads every value back before it answers, so a 200 here means
 * the site is holding what was asked for — not that the request was accepted.
 * ======================================================================== */
router.post('/pages/:pageId/settings', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const pageId = readPageId(req.params.pageId);
  const body = req.body || {};
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!pageId) return bad(res, 'BAD_PAGE_ID', 'That page reference is not valid.');

  const payload = {};
  if (body.slug !== undefined) {
    const slug = String(body.slug || '').trim();
    if (!slug) return bad(res, 'SLUG_REQUIRED', 'A page address cannot be empty.');
    if (slug.length > 190) return bad(res, 'SLUG_TOO_LONG', 'Keep the address under 190 characters.');
    payload.slug = slug;
  }
  if (body.template !== undefined) payload.template = String(body.template ?? '');
  if (body.parentId !== undefined) {
    const parent = Number(body.parentId);
    if (!Number.isInteger(parent) || parent < 0) {
      return bad(res, 'BAD_PARENT', 'That page reference is not valid.');
    }
    payload.parent_id = parent;
  }
  if (body.makeHomePage) payload.make_homepage = true;
  // A blog post's own fields (D-ARION-C). The plugin REFUSES these on a page
  // rather than dropping them, so a category that could not apply is an error
  // the client sees, not a silent no-op.
  if (body.excerpt !== undefined) payload.excerpt = String(body.excerpt || '');
  for (const key of ['categories', 'tags']) {
    if (body[key] === undefined) continue;
    if (!Array.isArray(body[key])) return bad(res, 'BAD_TERMS', `${key} has to be a list of names.`);
    if (body[key].length > 30) return bad(res, 'TOO_MANY_TERMS', 'That is more than a post needs.');
    payload[key] = body[key].map((t) => String(t || '').trim()).filter(Boolean);
  }
  if (body.featuredImageId !== undefined) {
    const att = Number(body.featuredImageId);
    if (!Number.isInteger(att) || att < 0) return bad(res, 'BAD_IMAGE', 'That picture reference is not valid.');
    payload.featured_image_id = att;
  }
  if (Object.keys(payload).length === 0) {
    return bad(res, 'NOTHING_TO_CHANGE', 'Nothing was sent to change.');
  }

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const result = await writePageSettings(site, pageId, payload);
    if (!result.ok) return pluginFailure(res, result, 'saving those settings');

    // The address and the home page both change which URLs are cached.
    const purge = await pluginPost(site, '/purge-cache', {});
    return res.json({
      data: { ...publicPageSettings(result.data), cachePurged: !!purge.ok },
      meta: { site_id: siteId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:settings-set');
  }
});

/* ==========================================================================
 * POST /pages/:pageId/trash  ·  POST /pages/:pageId/restore
 * ======================================================================== */
router.post('/pages/:pageId/trash', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const pageId = readPageId(req.params.pageId);
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!pageId) return bad(res, 'BAD_PAGE_ID', 'That page reference is not valid.');

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const result = await trashPage(site, pageId);
    if (!result.ok) return pluginFailure(res, result, 'deleting that page');
    const purge = await pluginPost(site, '/purge-cache', {});
    return res.json({
      data: {
        pageId,
        status: String(result.data?.status || 'trash'),
        title: String(result.data?.title || ''),
        cachePurged: !!purge.ok,
      },
      meta: { site_id: siteId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:trash');
  }
});

router.post('/pages/:pageId/restore', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const pageId = readPageId(req.params.pageId);
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!pageId) return bad(res, 'BAD_PAGE_ID', 'That page reference is not valid.');

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const result = await restorePage(site, pageId);
    if (!result.ok) return pluginFailure(res, result, 'bringing that page back');
    const purge = await pluginPost(site, '/purge-cache', {});
    return res.json({
      data: {
        pageId,
        // It comes back as a DRAFT, which is WordPress's own behaviour and the
        // safe one: a page nobody meant to publish does not go live again by
        // being un-deleted.
        status: String(result.data?.status || 'draft'),
        title: String(result.data?.title || ''),
        permalink: result.data?.permalink || null,
        cachePurged: !!purge.ok,
      },
      meta: { site_id: siteId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:restore');
  }
});

/* ==========================================================================
 * GET|POST /pages/:pageId/seo — the three SEO fields, on every tier.
 * ======================================================================== */
function publicSeo(data) {
  const seo = data?.seo || {};
  const plugin = data?.seo_plugin || {};
  return {
    pageId: Number(data?.page_id) || null,
    title: String(seo.title || ''),
    description: String(seo.description || ''),
    focusKeyword: String(seo.focus_keyword || ''),
    recommended: {
      title: Number(data?.recommended?.title || 60),
      description: Number(data?.recommended?.description || 160),
    },
    // A site with no SEO plugin active STORES these fine — they are ordinary
    // post meta — but nothing renders them. Saying so is the difference
    // between a client trusting the field and wondering why Google ignores it.
    seoPluginActive: !!plugin.active,
    seoPluginNote: plugin.active ? null
      : 'We have saved these on your website, but its SEO plugin is not switched on at the moment, '
        + 'so search engines will not see them yet. Ask us and we will turn it back on.',
    ...(Array.isArray(data?.changed) ? { changed: data.changed } : {}),
  };
}

router.get('/pages/:pageId/seo', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const pageId = readPageId(req.params.pageId);
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!pageId) return bad(res, 'BAD_PAGE_ID', 'That page reference is not valid.');

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const result = await fetchPageSeo(site, pageId);
    if (!result.ok) return pluginFailure(res, result, 'reading that page’s search settings');
    return res.json({ data: publicSeo(result.data), meta: { site_id: siteId } });
  } catch (err) {
    return boom(res, err, 'arion/pages:seo-get');
  }
});

const SEO_LIMITS = Object.freeze({ title: 200, description: 500, focusKeyword: 200 });

router.post('/pages/:pageId/seo', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const pageId = readPageId(req.params.pageId);
  const body = req.body || {};
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!pageId) return bad(res, 'BAD_PAGE_ID', 'That page reference is not valid.');

  const payload = {};
  const errors = [];
  for (const [field, key] of [['title', 'title'], ['description', 'description'], ['focusKeyword', 'focus_keyword']]) {
    if (body[field] === undefined) continue;
    const value = String(body[field] ?? '').trim();
    if (value.length > SEO_LIMITS[field]) {
      errors.push({ field, message: `Keep this under ${SEO_LIMITS[field]} characters.` });
      continue;
    }
    payload[key] = value;
  }
  if (errors.length) {
    return res.status(422).json({
      error: { code: 'CONTENT_NOT_VALID', message: 'Some of what you typed needs another look. Nothing was saved.', status: 422 },
      errors,
    });
  }
  if (Object.keys(payload).length === 0) {
    return bad(res, 'NOTHING_TO_CHANGE', 'Nothing was sent to change.');
  }

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const result = await writePageSeo(site, pageId, payload);
    if (!result.ok) return pluginFailure(res, result, 'saving those search settings');
    const purge = await pluginPost(site, '/purge-cache', {});
    return res.json({
      data: { ...publicSeo(result.data), cachePurged: !!purge.ok },
      meta: { site_id: siteId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:seo-set');
  }
});

/* ==========================================================================
 * POST /sections/swap — the same words in a different layout (D-ARION-F).
 * Body: { blueprintId, kind, fields }
 *
 * Both halves already existed and nothing joined them: `buildLibrarySection`
 * builds a curated layout, `applyFields` writes a section's values onto a
 * node. Swapping is the two of them in a row.
 *
 * Writes NOTHING. The swapped section reaches the website on the next Save,
 * like every other edit, so the plugin snapshot and one-tap Undo cover it.
 *
 * The layout IS replaced — that is the point — so anything the old layout
 * carried that the new one has no place for is reported back and the sheet
 * shows the same warning the adoption sheet uses.
 * ======================================================================== */
router.post('/sections/swap', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const blueprintId = String(req.body?.blueprintId || '').trim();
  const kind = String(req.body?.kind || '').toLowerCase();
  const fields = (req.body?.fields && typeof req.body.fields === 'object') ? req.body.fields : null;

  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!blueprintId) return bad(res, 'BAD_BLUEPRINT', 'Pick a layout first.');
  if (!kind || !sectionKindMeta(kind)) return bad(res, 'UNKNOWN_SECTION', `We do not have a section called "${kind}".`);
  if (!fields) return bad(res, 'NO_FIELDS', 'The section’s wording did not arrive, so nothing was changed.');

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const capability = await getSiteCapability(site);
    const { allowPro } = allowProFor(site, capability);
    const brand = await loadBrandContext(pool, { tenantId, siteId });

    const built = await buildLibrarySection({ blueprintId, brand, allowPro });
    if (!built.ok) return bad(res, built.code, built.message);

    // A layout for a DIFFERENT kind of section is not a swap, it is a
    // different section — and it would silently drop every word, because the
    // field names do not line up.
    if (built.kind !== kind) {
      return bad(res, 'WRONG_SECTION_KIND',
        'That layout is for a different kind of section, so your wording would not fit it. '
        + 'Add it as a new section instead.');
    }

    const check = validateFields(kind, fields);
    if (!check.ok) {
      return res.status(422).json({
        error: {
          code: 'CONTENT_NOT_VALID',
          message: 'Some of what is in this section will not fit that layout. Nothing was changed.',
          status: 422,
        },
        errors: check.errors,
      });
    }

    let node;
    try {
      node = applyFields(built.node, kind, fields, {
        allowPro, iaWidgets: capability.iaWidgets ?? null, emailTo: String(brand?.email || ''),
      });
    } catch (err) {
      // A widget this site cannot draw, named. Same rule as `buildNodes`.
      if (err instanceof UnsupportedWidgetError || err?.code === 'WIDGET_NOT_ON_PLAN') {
        return bad(res, 'WIDGET_NOT_ON_PLAN', err.message);
      }
      throw err;
    }
    const [entry] = reduceToSectionList([node]);
    if (!entry?.editable) {
      return bad(res, 'SECTION_NOT_EDITABLE',
        'The editor could not take charge of every part of that layout, so we did not use it.');
    }

    // What did NOT survive the swap. `applyFields` clones the last card for
    // extra list items, so a longer list is carried; a field the new layout
    // simply has no slot for is not, and the client is told which.
    const before = fields;
    const after = entry.fields || {};
    const dropped = Object.keys(before).filter((key) => {
      const had = before[key];
      if (had == null || had === '' || (Array.isArray(had) && had.length === 0)) return false;
      const now = after[key];
      return now == null || now === '' || (Array.isArray(now) && now.length === 0);
    });

    return res.status(200).json({
      data: {
        section: publicSection(entry),
        blueprintId,
        dropped,
        warning: 'The layout is replaced, so this section will look different. Your wording and '
          + 'pictures come across. You can put it back with Undo after you save.',
      },
      meta: { site_id: siteId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:swap-section');
  }
});

/* ==========================================================================
 * POST /sections/roles/swap — "no, that box is the other one" (pack 2b).
 * Body: { kind, list, roles: [a, b], node }
 *
 * A hand-drawn card does not say which of its two text blocks is the period
 * and which is the list of what is included, and on some layouts nothing in
 * the content says either. `libraryAdapter.assignRoles` reaches for a marker
 * first — a currency sign, a bullet, a quotation mark — and only falls back to
 * "the longer one" when there is none. When it falls back it WRITES THAT DOWN
 * on the section, the edit sheet shows it with "check this", and this route is
 * the one tap that puts it right.
 *
 * Writes NOTHING. The swapped section reaches the website on the next Save,
 * like every other edit, so the snapshot and one-tap Undo cover it. Only the
 * two role markers move; not one setting of the layout is touched.
 * ======================================================================== */
router.post('/sections/roles/swap', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const kind = String(req.body?.kind || '').toLowerCase();
  const list = String(req.body?.list || '').trim();
  const roles = Array.isArray(req.body?.roles) ? req.body.roles.map((r) => String(r || '')) : [];
  const node = (req.body?.node && typeof req.body.node === 'object') ? req.body.node : null;

  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!kind || !sectionKindMeta(kind)) return bad(res, 'UNKNOWN_SECTION', `We do not have a section called "${kind}".`);
  if (!node) return bad(res, 'NO_SECTION', 'The section did not arrive, so nothing was changed.');
  if (roles.length !== 2 || !roles[0] || !roles[1] || roles[0] === roles[1]) {
    return bad(res, 'BAD_ROLES', 'Say which two to swap over.');
  }

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const swapped = swapItemRoles(node, kind, list, roles[0], roles[1]);
    if (!swapped.ok) {
      return bad(res, 'NOTHING_TO_SWAP',
        'Those two are not two halves of the same card on this section, so there is nothing to swap.');
    }

    // The markers moved, so the PROMPTS have to move with them: the box the
    // client is about to type a quote into must still say "What they said"
    // after the swap, not "Their job or company". Only a value that is still
    // one of our prompts is touched, so a section they have already filled in
    // comes through the swap exactly as a swap has always worked — the two
    // sets of words change places (D-93).
    const settled = neutraliseSampleWords(swapped.node, kind, { onlyPrompts: true });

    const [entry] = reduceToSectionList([settled]);
    if (!entry?.editable) {
      return bad(res, 'SECTION_NOT_EDITABLE',
        'Swapping those two would leave a part of this section we could not look after, so we did not.');
    }
    return res.status(200).json({
      data: { section: publicSection(entry), swapped: swapped.swapped },
      meta: { site_id: siteId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:swap-roles');
  }
});

/* ==========================================================================
 * MEDIA — where is it used, delete it, replace it in place.
 * ======================================================================== */
function publicUsage(data) {
  const places = Array.isArray(data?.places) ? data.places : [];
  const notes = Array.isArray(data?.notes) ? data.notes : [];
  const NOTE_TEXT = {
    site_icon: 'It is your website’s icon (the little picture in a browser tab).',
    custom_logo: 'It is your website’s logo.',
  };
  return {
    attachmentId: Number(data?.attachment_id) || null,
    filename: String(data?.filename || ''),
    used: !!data?.used,
    complete: String(data?.scan || '') === 'complete',
    places: places.map((p) => ({
      pageId: Number(p?.post_id) || null,
      title: String(p?.title || '(no title)'),
      status: String(p?.status || ''),
      type: String(p?.type || 'page'),
      permalink: p?.permalink || null,
    })),
    notes: notes.map((n) => NOTE_TEXT[String(n)] || String(n)),
    canDelete: !data?.used && String(data?.scan || '') === 'complete',
  };
}

router.get('/media/:attachmentId/usage', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const attachmentId = readPageId(req.params.attachmentId);
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!attachmentId) return bad(res, 'BAD_MEDIA_ID', 'That picture reference is not valid.');

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const result = await fetchMediaUsage(site, attachmentId);
    if (!result.ok) return pluginFailure(res, result, 'checking where that picture is used');
    return res.json({ data: publicUsage(result.data), meta: { site_id: siteId } });
  } catch (err) {
    return boom(res, err, 'arion/pages:media-usage');
  }
});

router.delete('/media/:attachmentId', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const attachmentId = readPageId(req.params.attachmentId);
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!attachmentId) return bad(res, 'BAD_MEDIA_ID', 'That picture reference is not valid.');

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const result = await deleteMedia(site, attachmentId);
    if (!result.ok) {
      // A refusal because the picture is still in use is not a transport
      // failure — it is the answer, and it carries the list of pages.
      const stillUsed = result.status === 409 && result.data && ('used' in result.data);
      if (stillUsed) {
        return res.status(409).json({
          error: {
            code: 'PICTURE_IN_USE',
            message: String(result.data.error
              || 'This picture is still being used, so it was not deleted.'),
            status: 409,
          },
          data: publicUsage(result.data),
        });
      }
      return pluginFailure(res, result, 'deleting that picture');
    }
    return res.json({
      data: {
        attachmentId,
        deleted: true,
        filename: String(result.data?.filename || ''),
      },
      meta: { site_id: siteId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:media-delete');
  }
});

router.post('/media/:attachmentId/replace', async (req, res) => {
  const tenantId = req.tenant?.tenantId;
  const { siteId } = req.params;
  const attachmentId = readPageId(req.params.attachmentId);
  const body = req.body || {};
  if (!tenantId || !siteId) return bad(res, 'BAD_REQUEST', 'We could not work out which website you mean.');
  if (!attachmentId) return bad(res, 'BAD_MEDIA_ID', 'That picture reference is not valid.');

  const fromUrl = String(body.url || '').trim();
  const dataBase64 = typeof body.dataBase64 === 'string' ? body.dataBase64 : '';
  if (!fromUrl && !dataBase64) return bad(res, 'NO_IMAGE', 'Choose the new picture first.');
  if (fromUrl && !/^https?:\/\//i.test(fromUrl)) {
    return bad(res, 'BAD_IMAGE_URL', 'A picture address has to start with http:// or https://.');
  }
  if (dataBase64) {
    const approxBytes = Math.floor((dataBase64.length * 3) / 4);
    if (approxBytes > MAX_MEDIA_BYTES) {
      return bad(res, 'IMAGE_TOO_BIG', 'That picture is over 10 MB. Try a smaller one.');
    }
  }

  try {
    const pool = await getServicesPool();
    const site = await loadSite(pool, tenantId, siteId);
    if (!site) return notFound(res, 'That website is not on your account.');

    const result = await replaceMedia(site, attachmentId, {
      url: fromUrl || undefined,
      data_base64: dataBase64 || undefined,
      alt: body.alt ? String(body.alt).slice(0, 300) : undefined,
    });
    if (!result.ok) return pluginFailure(res, result, 'replacing that picture');

    // Every page keeps the same attachment id and the same address, so they
    // all show the new picture with no edit and no publish. The one honest
    // caveat is the client's own browser cache.
    const purge = await pluginPost(site, '/purge-cache', {});
    return res.json({
      data: {
        attachmentId,
        url: String(result.data?.url || ''),
        filename: String(result.data?.filename || ''),
        width: result.data?.width == null ? null : Number(result.data.width),
        height: result.data?.height == null ? null : Number(result.data.height),
        bytes: result.data?.bytes == null ? null : Number(result.data.bytes),
        sizeCount: Number(result.data?.size_count || 0),
        usedOn: Number(result.data?.used_on || 0),
        alt: String(result.data?.alt || ''),
        cachePurged: !!purge.ok,
        note: 'Every page using this picture now shows the new one. Your own browser may hold the '
          + 'old picture for a while — reload the page to see it.',
      },
      meta: { site_id: siteId },
    });
  } catch (err) {
    return boom(res, err, 'arion/pages:media-replace');
  }
});

/* --------------------------------------------------------------------------
 * GET /ai-pricing — what an AI action costs, read from the database.
 *
 * The Portal shows "This uses N credits" BEFORE the client sends anything, and
 * N comes from here. It is never hardcoded in the UI.
 *
 * ONE PRICE SURFACE (P18, 2026-09-08). This now answers for all four builder
 * actions, including the two the AI Builder page used to price itself with a
 * hand-written coefficient table (`SECTION_COSTS`, `BLOCK_DEFAULTS` and a TODO
 * asking for exactly this endpoint) while the server debited nothing at all.
 * That table is deleted; every number a client sees comes from
 * argus.action_pricing through here.
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
    for (const [key, actionType] of [
      ['section', ACTION_SECTION_EDIT],
      ['page', ACTION_PAGE_EDIT],
      ['generate', ACTION_GENERATE_SECTION],
      ['assemble', ACTION_ASSEMBLE_PAGE],
    ]) {
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
        // The one thing a client asks about a ready-made layout. Six of the
        // eight archetypes are answered from our own curated library with no
        // model call, and those are free — so the page says so instead of
        // quoting a price it will not charge.
        libraryNote: 'Ready-made layouts come from our own library, and those cost nothing. '
          + 'We only charge when we write something new for you.',
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
  publicPageSettings, publicTemplates, publicSeo, publicUsage, TEMPLATE_LABELS, SEO_LIMITS,
  TOP_LEVEL_EL_TYPES, aiFailure, withFormRecipient, publicMediaItem,
  syncBookingButton, bookingPushed, BOOKING_PUSH_TTL_MS,
  readSectionIndex, publicSection, publicAdoption, loadLiveSection,
};

