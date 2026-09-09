/**
 * Onboarding driver — wires the ARION IL website builder emitters into the
 * fresh-WP provisioning pipeline that runs from routes/onboarding/submit.js.
 * --------------------------------------------------------------------------
 * V2 of the AI Website Builder (see overnight-report/38_AI_WEBSITE_BUILDER_v2_SCOPE.md)
 * REPLACES the V1 Astra-template-import path:
 *
 *   V1 (now ripped from submit.js):
 *     pickTemplateForIndustry → importStarterTemplate → applyBrandedCopy
 *     (industry-matched Astra template + wp-cli brand-swap on string regex)
 *
 *   V2 (this module):
 *     setElementorGlobals → generateSiteImages → generateAllPages →
 *     postElementorPage (per page) → setStaticFrontPage
 *
 * This module is the orchestrator that submit.js calls during the new pipeline.
 * It depends on:
 *   - callEmitter.js + emitters/* (block-level AI prompts → validated block JSON)
 *   - elementorAdapter.js (block JSON → Elementor section node)
 *   - pageAssembler.js (sections array → _elementor_data tree)
 *   - lib/elementorGlobals.js (POST /wp-json/elementor/v1/globals — built by Agent B)
 *   - lib/imageGen.js (gpt-image-1 → hero/section images — built by Agent A)
 *   - lib/pluginClient.js (resolveSiteHost + auth headers)
 *
 * Per V2 scope F-200 + F-204: each page is built from a kind-specific block
 * sequence. Per F-205: the assembled JSON is POSTed to the IA Plugin's
 * /pages/elementor endpoint (which the plugin already implements). After all
 * pages exist, F-207 sets the homepage as the static front page.
 */

import { callEmitter } from './callEmitter.js';
import { assemblePage } from './pageAssembler.js';
import { resolveSiteHost, buildPluginAuth } from '../pluginClient.js';

// Per-page kind → ordered block sequence. Driven by V2 scope: home is the
// marquee page (hero + services + testimonials + cta), about adds the about
// story + values + testimonials, services expands the services grid + faq,
// contact is intentionally lean (short hero + contact form/methods).
const PAGE_BLUEPRINTS = {
  home: {
    title:  'Home',
    slug:   'home',
    blocks: ['hero', 'services', 'testimonials', 'cta'],
  },
  about: {
    title:  'About',
    slug:   'about',
    blocks: ['hero', 'about', 'testimonials', 'cta'],
  },
  services: {
    title:  'Services',
    slug:   'services',
    blocks: ['hero', 'services', 'faq', 'cta'],
  },
  contact: {
    title:  'Contact',
    slug:   'contact',
    blocks: ['hero', 'contact'],
  },
};

// Per-page hero variant note — non-home pages get a SHORT hero (less vertical
// real estate) so the page content above the fold is the actual section, not
// another marquee. Home stays full-height. Passed into the hero emitter as
// sectionContext.variant_note so the prompt can adjust.
const HERO_VARIANT = {
  home:     { variant_note: 'full-height marquee hero', background_style: 'image' },
  about:    { variant_note: 'short page-header hero (1-line headline only)', background_style: 'solid', cta_href: '#contact' },
  services: { variant_note: 'short page-header hero (1-line headline + 1 sentence)', background_style: 'gradient', cta_href: '#contact' },
  contact:  { variant_note: 'minimal greeting hero (1-line headline only, no CTA needed)', background_style: 'solid', cta_href: '#contact' },
};

const DEFAULT_NAMESPACE = '/wp-json/intelligent-analytics/v1';
const PAGES_ELEMENTOR_PATH = '/pages/elementor';
const REQUEST_TIMEOUT_MS = 60_000;

// The ONE answer to "what is this business called" (D-48, SEAM-10-A). This file
// used to read `answers.businessName` straight off the onboarding
// questionnaire, which is what somebody typed once at signup and — on the dev
// database — held another business's fixture entirely (walk rows D3, S3-7).
import { resolveBusinessName, promptName } from '../businessName.js';

/**
 * Build a thin "brand" object from the questionnaire answers + branding inputs.
 * Mirrors the shape that brandContext.loadBrandContext() returns so emitters
 * can be called identically from the onboarding flow (where we don't have a
 * persisted site row yet) and from the live builder routes (which do).
 *
 * `businessName` is RESOLVED BY THE CALLER through `resolveBusinessName` — it is
 * not read from `answers` here, and there is no fallback in this function. A
 * business with no recorded name gets `business_name: ''` and
 * `business_name_status: 'not_set'`, exactly as `loadBrandContext` returns, and
 * the emitters and the section library render the sentence rather than a guess.
 */
function answersToBrand({ answers, brandColors, domain, tenantId, siteId, tier, businessName = '', businessNameStatus = 'not_set' }) {
  const services = Array.isArray(answers?.services)
    ? answers.services.map((s) => String(s).trim()).filter(Boolean)
    : [];
  return {
    tenant_id:        tenantId || null,
    site_id:          siteId   || null,
    business_name:    businessName || '',
    business_name_status: businessNameStatus,
    industry:         answers?.industry || '',
    description:      answers?.description || '',
    tagline:          answers?.tagline || '',
    target_audience:  answers?.targetAudience || answers?.target_audience || '',
    services,
    brand_voice:      answers?.brandVoice || answers?.brand_voice || 'professional',
    style_preference: answers?.stylePreference || answers?.style_preference || 'modern',
    location:         answers?.location || '',
    primary_color:    brandColors?.primary   || answers?.primaryColor   || null,
    secondary_color:  brandColors?.secondary || answers?.secondaryColor || null,
    accent_color:     brandColors?.accent    || answers?.accentColor    || null,
    logo_url:         answers?.logoUrl || null,
    font_family:      answers?.fontFamily || null,
    domain:           domain || null,
    email:            answers?.contactEmail || answers?.email || null,
    // Tier flows from the onboarding session (lite | starter | essentials |
    // growth | authority). callEmitter uses it to decide whether to allow
    // Pro-dependent section library variants — only Lite excludes Pro.
    tier:             (tier || answers?.tier || 'lite').toLowerCase(),
  };
}

/**
 * Build the sectionContext to pass into one emitter on one page.
 * Carries page-kind variants + images selected for that page.
 */
function sectionContextFor({ pageKind, blockKind, imageBundle, answers }) {
  const ctx = {};

  // Hero variants per page kind
  if (blockKind === 'hero') {
    Object.assign(ctx, HERO_VARIANT[pageKind] || {});
    // Surface the generated hero image (single shared hero across pages — the
    // imageGen bundle ships one heroImage record). The adapter will land it
    // in the section's background_image slot instead of an empty sentinel.
    const heroImg = imageBundle?.heroImage || null;
    if (heroImg?.url) ctx.image_url = heroImg.url;
    if (heroImg?.alt) ctx.image_alt = heroImg.alt;
  }

  // About emitter — surface the about image so the 2-column story section
  // can render with a real photo instead of the empty placeholder.
  if (blockKind === 'about') {
    const aboutImg = imageBundle?.aboutImage || null;
    if (aboutImg?.url) ctx.image_url = aboutImg.url;
    if (aboutImg?.alt) ctx.image_alt = aboutImg.alt;
  }

  // CTA emitter — pass the cta background image (if generated) so the
  // section background can render the brand-styled visual.
  if (blockKind === 'cta') {
    const ctaImg = imageBundle?.ctaBackgroundImage || null;
    if (ctaImg?.url) {
      ctx.background_style = 'image';
      ctx.image_url = ctaImg.url;
      ctx.image_alt = ctaImg.alt;
    }
  }

  // Services emitter — surface the per-service image bundle so each
  // icon-box can have a real image. imageGen returns servicesImages as a
  // sequence aligned with answers.services order.
  if (blockKind === 'services') {
    const svcImages = Array.isArray(imageBundle?.servicesImages)
      ? imageBundle.servicesImages.filter(Boolean)
      : [];
    if (svcImages.length > 0) ctx.service_images = svcImages;
  }

  // Services emitter — the expanded variant on the /services page gets a
  // "expanded depth" note so the AI doesn't repeat the home-page summary.
  if (blockKind === 'services' && pageKind === 'services') {
    ctx.variant_note = 'expanded services grid — each service gets a longer description (3-4 sentences)';
  }

  // Contact emitter — surface contact channels from the questionnaire so the
  // AI doesn't hallucinate. The emitter prompt already reads brand.email etc.,
  // but we additionally pass any social URLs the customer entered.
  if (blockKind === 'contact') {
    ctx.contact_channels = {
      email:    answers?.contactEmail || answers?.email || null,
      phone:    answers?.contactPhone || answers?.phone || null,
      address:  answers?.contactAddress || answers?.address || null,
      socials:  answers?.socials || answers?.socialLinks || null,
    };
  }

  // FAQ emitter — pass topic seed so questions are business-specific.
  // The name comes off the BRAND object (resolved from the one identity), never
  // off the questionnaire, and a business with no recorded name gets the
  // neutral noun phrase rather than an invented brand.
  if (blockKind === 'faq') {
    const seedName = promptName({ name: brand?.business_name || '', status: brand?.business_name_status || 'not_set' });
    ctx.topic_seed = `${seedName} — ${answers?.industry || 'small business'}`;
  }

  return ctx;
}

/**
 * Generate ONE page (hero/services/testimonials/etc.) by calling each emitter
 * in sequence, then running the elementorAdapter (via assemblePage) to flatten
 * the section list into a single _elementor_data array.
 *
 * Soft-failure: if any single emitter fails, we skip that block and continue
 * with the rest of the page. Going dark on one slow Anthropic call should not
 * fail the entire onboarding — the customer still gets a launched site.
 *
 * @returns {Promise<{ slug, title, elementorData: Array, sectionsBuilt: number,
 *                     skipped: Array, emitterResults: Array }>}
 */
async function generateOnePage({
  pageKind, brand, sectionContexts, tenantId, siteId, imageBundle, answers,
}) {
  const blueprint = PAGE_BLUEPRINTS[pageKind];
  if (!blueprint) {
    return {
      slug: pageKind, title: pageKind, elementorData: [],
      sectionsBuilt: 0, skipped: [{ reason: `unknown page kind ${pageKind}` }],
      emitterResults: [], sectionsUsed: [],
    };
  }

  // Call each emitter in display order. Sequential — Anthropic is happy with
  // parallel but onboarding isn't time-critical and sequential makes the
  // cost-guard's per-tenant tracking more accurate.
  const draftsInOrder = [];
  const emitterResults = [];
  // sectionsUsed tracks library hits per page so the route handler can
  // surface them in provisioning_details_json.sections_used[] for downstream
  // attribution + library-coverage telemetry.
  const sectionsUsed = [];
  for (const blockKind of blueprint.blocks) {
    const sectionContext = sectionContextFor({
      pageKind, blockKind, imageBundle, answers,
    });
    let result;
    try {
      result = await callEmitter({
        kind:    blockKind,
        brand,
        sectionContext,
        tenantId,
        siteId,
        // Skip the cost-guard during onboarding — the customer JUST paid for
        // the build, blocking on a $-cap edge case would be catastrophic UX.
        opts:    { skipCapGuard: true },
      });
    } catch (e) {
      result = { ok: false, error: { code: 'exception', message: e.message } };
    }
    emitterResults.push({
      kind: blockKind,
      ok: !!result?.ok,
      source: result?.source || null,
      blueprint_id: result?.blueprint_id || null,
      error: result?.error || null,
    });

    if (!result?.ok || !result.block) {
      console.warn(`[onboardingDriver] ${pageKind}/${blockKind} emitter failed: ${result?.error?.message || 'no block'}`);
      continue;
    }
    if (result.source === 'section_library' && result.blueprint_id) {
      sectionsUsed.push({
        page:         blueprint.slug,
        block_kind:   blockKind,
        blueprint_id: result.blueprint_id,
        archetype:    result.libraryMeta?.archetype || null,
        variant_key:  result.libraryMeta?.variant_key || null,
      });
    }
    draftsInOrder.push({
      kind: blockKind,
      block_json: result.block,
      // Prefer the freshly-adapted elementor JSON returned by callEmitter so
      // assemblePage can pick it up without re-running the adapter.
      elementor_json: result.elementor || null,
    });
  }

  // Assemble. Brand CSS variables are injected into the first section by
  // assemblePage automatically.
  const built = assemblePage(draftsInOrder, brand, {
    seedPrefix: `${siteId || 'onboarding'}-${pageKind}`,
  });

  return {
    slug: blueprint.slug,
    title: blueprint.title,
    elementorData: built.elementorData,
    sectionsBuilt: built.sectionsBuilt,
    skipped: built.skipped,
    emitterResults,
    sectionsUsed,
  };
}

/**
 * Generate ALL four pages (home/about/services/contact) for the new site.
 *
 * @param {object} args
 * @param {string} args.domain
 * @param {object} args.answers       — questionnaire payload
 * @param {object} [args.copyBundle]  — V1 copy bundle (unused in V2 but kept for forward-compat)
 * @param {object} [args.imageBundle] — { hero_by_page: {home,about,...}, sections: [...] } from Agent A
 * @param {object} args.brandColors   — { primary, secondary, accent }
 * @param {string} [args.tenantId]
 * @param {string} [args.siteId]
 * @returns {Promise<Array<{ slug, title, elementorData, sectionsBuilt, skipped, emitterResults }>>}
 */
export async function generateAllPages({
  domain, answers, copyBundle, imageBundle, brandColors,
  tenantId, siteId, tier,
}) {
  // Once, here, and threaded down. Every emitter prompt on a new site reads it.
  const resolvedName = await resolveBusinessName(tenantId);
  const brand = answersToBrand({
    answers, brandColors, domain, tenantId, siteId, tier,
    businessName: resolvedName.name,
    businessNameStatus: resolvedName.status,
  });
  const out = [];
  for (const pageKind of Object.keys(PAGE_BLUEPRINTS)) {
    const page = await generateOnePage({
      pageKind, brand, sectionContexts: null,
      tenantId, siteId, imageBundle, answers,
    });
    out.push(page);
  }
  return out;
}

/**
 * POST one page's _elementor_data to the IA Plugin's
 * /wp-json/intelligent-analytics/v1/pages/elementor endpoint.
 *
 * Auth — onboarding runs BEFORE the site_token_raw lands in arion.site
 * (token is minted later in the provisioning code flow), so we authenticate
 * with the provision code header `X-Arion-Provision-Code: <code>` (mirrors
 * the same fallback the IA Plugin uses for its first-redeem call) OR with
 * the wp-admin app password if available. The plugin's check_token_or_admin
 * permission callback accepts both.
 *
 * @param {object} args
 * @param {string} args.domain
 * @param {string} args.slug             — e.g. 'home'
 * @param {string} args.title            — e.g. 'Home'
 * @param {Array<object>} args.elementorData
 * @param {string} [args.provisionCode]  — issued earlier in submit.js
 * @param {object} [args.site]           — optional arion.site row for pluginClient auth
 * @returns {Promise<{ ok, postId?, editUrl?, permalink?, error?, httpStatus? }>}
 */
export async function postElementorPage({
  domain, slug, title, elementorData, provisionCode, site,
}) {
  if (!domain) {
    return { ok: false, error: 'domain required' };
  }
  if (!Array.isArray(elementorData)) {
    return { ok: false, error: 'elementorData must be an array' };
  }

  const host = resolveSiteHost(site || { domain });
  if (!host) return { ok: false, error: 'no_domain_for_site' };

  // Authentication headers — prefer site_token_raw / app password if a site
  // row was passed (post-token-mint case). Otherwise fall back to the
  // provision-code header which the IA plugin's redeem flow accepts.
  const headers = {
    'Content-Type': 'application/json',
    Accept:         'application/json',
  };
  if (site) {
    const auth = buildPluginAuth(site);
    if (auth.ok) Object.assign(headers, auth.headers);
  }
  if (provisionCode) {
    headers['X-Arion-Provision-Code'] = provisionCode;
  }

  const url = `https://${host}${DEFAULT_NAMESPACE}${PAGES_ELEMENTOR_PATH}`;
  const body = {
    page_id:        null,            // null → plugin creates a new page
    title:          title || slug,
    slug:           slug || null,    // plugin can use this to set post_name
    status:         'publish',
    flip_to_builder: true,
    elementor_data: elementorData,
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const text = await res.text().catch(() => '');
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* ignore */ }

    if (!res.ok) {
      return {
        ok: false,
        httpStatus: res.status,
        error: (parsed?.error || parsed?.message || text || `HTTP ${res.status}`).toString().slice(0, 500),
      };
    }

    const data = parsed?.data ?? parsed ?? {};
    const postId = data.page_id || data.post_id || data.postId || null;

    // ─── CACHE PURGE (best-effort, post-publish) ──────────────────────────
    // A meta-only REST write to _elementor_data does NOT trigger
    // LiteSpeed / Hostinger auto-purge, and Elementor's per-page CSS file
    // (uploads/elementor/css/post-<id>.css) is stale until flush-css runs.
    // Without this, customers see the OLD page until something else
    // invalidates the cache. Per the section-library handoff §6.
    //
    // Both calls are best-effort: if SSH is unreachable (off-Hostinger),
    // wp-cli isn't installed (LiteSpeed missing), or the post wasn't really
    // built with Elementor (defensive), we log and continue — the page is
    // still published successfully; the next manual cache-clear or
    // wp-cron tick will catch it.
    await purgeCachesForPage({ domain, postId }).catch((e) => {
      console.warn(`[onboardingDriver] cache purge threw (non-fatal): ${e?.message?.slice(0, 200)}`);
    });

    return {
      ok:        true,
      httpStatus: res.status,
      postId,
      editUrl:   data.edit_url || data.elementor_edit_url || null,
      permalink: data.permalink || null,
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      httpStatus: err.name === 'AbortError' ? 0 : null,
    };
  }
}

/**
 * Best-effort cache invalidation after writing a page's _elementor_data:
 *   1. `wp litespeed-purge all`              — full LiteSpeed flush
 *   2. `wp elementor flush-css <page_id>`    — regenerate per-page Elementor CSS
 *
 * Both can fail benignly (off-Hostinger sites, missing wp-cli, sites
 * without LiteSpeed, etc.) — we swallow errors and never abort the publish
 * flow. Per scope: catch failures; don't abort.
 *
 * @param {object} args
 * @param {string} args.domain
 * @param {number|string|null} [args.postId]
 */
async function purgeCachesForPage({ domain, postId }) {
  if (!domain) return;
  let runWpCli;
  try {
    ({ runWpCli } = await import('../hostingerSsh.js'));
  } catch (e) {
    // hostingerSsh not importable (test/dev) — silently bail.
    return;
  }

  // LiteSpeed: always attempt — the cache plugin may or may not be active;
  // wp-cli returns a non-fatal error either way.
  try {
    await runWpCli(domain, 'litespeed-purge all');
  } catch (e) {
    // Common failure: wp_litespeed_command unknown — site not on LiteSpeed.
    // Quiet expected case so we don't drown the onboarding log.
    if (!/unknown\s+command|wp_litespeed/i.test(e.message || '')) {
      console.warn(`[onboardingDriver] litespeed-purge non-fatal: ${e.message?.slice(0, 200)}`);
    }
  }

  // Elementor: flush-css only if we know the page id; otherwise nothing to
  // flush (the call needs a target). Elementor 3.x ships this as
  // `wp elementor flush-css <post-id>` — older versions used
  // `wp elementor flush_css`; newer Elementor accepts the dashed form.
  if (postId) {
    try {
      await runWpCli(domain, `elementor flush-css ${postId}`);
    } catch (e) {
      // If the dashed form failed, try the legacy underscored variant once.
      try {
        await runWpCli(domain, `elementor flush_css ${postId}`);
      } catch (e2) {
        console.warn(`[onboardingDriver] elementor flush-css non-fatal: ${e2.message?.slice(0, 200)}`);
      }
    }
  }
}

/**
 * Set the static front page so visitors hit /home instead of the blog roll.
 *
 * Tries the IA Plugin's /onboarding/apply-defaults endpoint first (which can
 * set show_on_front + page_on_front when given a homeSlug). Falls back to
 * direct wp-cli over SSH (works only for Hostinger-hosted sites) so off-
 * Hostinger sites still benefit from the front-page flip.
 *
 * @param {object} args
 * @param {string} args.domain
 * @param {string} args.slug             — slug of the page to set as front page (default 'home')
 * @param {number} [args.pageId]         — preferred: WP post ID returned by postElementorPage
 * @param {string} [args.provisionCode]
 * @param {object} [args.site]
 * @returns {Promise<{ ok, source?, error? }>}
 */
export async function setStaticFrontPage({
  domain, slug = 'home', pageId, provisionCode, site,
}) {
  if (!domain) return { ok: false, error: 'domain required' };

  // Path 1 — IA Plugin sets it via REST (lives at /onboarding/set-front-page;
  // plugin treats this as an extension to apply-defaults). If the plugin
  // doesn't have this route yet (older versions), this returns 404 and we
  // fall through to wp-cli.
  const host = resolveSiteHost(site || { domain });
  if (host) {
    const headers = {
      'Content-Type': 'application/json',
      Accept:         'application/json',
    };
    if (site) {
      const auth = buildPluginAuth(site);
      if (auth.ok) Object.assign(headers, auth.headers);
    }
    if (provisionCode) headers['X-Arion-Provision-Code'] = provisionCode;

    try {
      const url = `https://${host}${DEFAULT_NAMESPACE}/onboarding/set-front-page`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ slug, page_id: pageId || null }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        return { ok: true, source: 'plugin_rest' };
      }
      // 404 = endpoint not deployed yet — fall through. Any other error: log
      // and try wp-cli as a safety net.
      if (res.status !== 404) {
        const txt = await res.text().catch(() => '');
        console.warn(`[onboardingDriver] set-front-page plugin route returned ${res.status}: ${txt.slice(0, 200)}`);
      }
    } catch (e) {
      console.warn(`[onboardingDriver] set-front-page plugin call threw: ${e.message.slice(0, 200)}`);
    }
  }

  // Path 2 — wp-cli over SSH (Hostinger sites only). Import lazily so the
  // dependency on hostingerSsh doesn't break callers running off-Hostinger
  // (e.g. dry-run tests).
  try {
    const { runWpCli } = await import('../hostingerSsh.js');
    // Find the page id by slug if not supplied.
    let resolvedPageId = pageId;
    if (!resolvedPageId) {
      const findRes = await runWpCli(
        domain,
        `post list --post_type=page --name=${slug} --field=ID`,
      );
      resolvedPageId = parseInt((findRes.stdout || '').trim().split('\n')[0], 10) || null;
    }
    if (!resolvedPageId) {
      return { ok: false, error: `no page with slug "${slug}" found via wp-cli` };
    }
    await runWpCli(domain, `option update show_on_front page`);
    await runWpCli(domain, `option update page_on_front ${resolvedPageId}`);
    return { ok: true, source: 'wp_cli', pageId: resolvedPageId };
  } catch (e) {
    return { ok: false, error: e.message.slice(0, 300), source: 'wp_cli_failed' };
  }
}

export const __test__ = {
  PAGE_BLUEPRINTS, HERO_VARIANT, answersToBrand, sectionContextFor, generateOnePage,
  purgeCachesForPage,
};
