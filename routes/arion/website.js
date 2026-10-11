/**
 * ARION site builder — the WHOLE site: menus, brand, header, footer, switches.
 * ---------------------------------------------------------------------------
 * Mounted at: /arion/sites/:siteId   (routes/arion.js)
 * Auth:       requireAuth + tenantResolution + requireArionAccess upstream,
 *             so every handler can trust req.tenant.tenantId.
 *
 * `routes/arion/pages.js` next door owns everything INSIDE a page. This file
 * owns everything that is the same on every page, and every one of these was a
 * job that could only be done by signing into WordPress (ARION pack 2):
 *
 *   GET    /menus                    the navigation, its items, and where the
 *   POST   /menus                    theme can put a menu
 *   PUT    /menus/:menuId            the whole ordered list, every time
 *   POST   /menus/:menuId/undo
 *   GET    /site/kit                 brand colours and fonts (Elementor's kit)
 *   POST   /site/kit
 *   GET    /site/chrome              header and footer, through the theme's
 *   POST   /site/chrome              own options (D-ARION-A)
 *   GET    /site/options             website chat, Book now
 *   POST   /site/options
 *   GET    /pricing-catalogue        the ONE price source, for the pricing
 *                                    section's "Use my current prices"
 *
 * THE RULES THIS FILE KEEPS
 *   - the plugin is the only write path to WordPress (no second mechanism);
 *   - never a success response on a failed write
 *     (reference_catch_swallow_report_success);
 *   - the business's name, colours and prices come from the ONE place each of
 *     them already lives, and are offered as defaults, never re-typed.
 */

import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import { loadBrandContext, BUSINESS_NAME_NOT_SET } from '../../lib/websiteBuilder/brandContext.js';
import { loadServicePrices } from '../../lib/websiteBuilder/servicePricing.js';
import { buildGlobalsPayload, pickDefaultFonts } from '../../lib/elementorGlobals.js';
import {
  fetchMenus, createMenu, writeMenu, undoMenu,
  fetchKit, writeKit, fetchChrome, writeChrome,
  fetchSiteOptions, writeSiteOptions,
} from '../../lib/websiteBuilder/pageClient.js';
import { syncSubscriptionConfigSoon } from '../../lib/websiteBuilder/subscriptionConfig.js';

const router = Router({ mergeParams: true });

const MAX_MENU_ITEMS = 100;

/* ── plain-words error helpers (same shapes as routes/arion/pages.js) ───── */

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
 * A plugin transport failure -> an HTTP answer. NEVER 200.
 *
 * A plugin older than 1.7.4 answers these paths with a 404, and "your website
 * answered 404" is a useless sentence for a client, so that one case is named:
 * it is a plugin update, not a broken website.
 */
function pluginFailure(res, result, what) {
  if (result.error === 'not_found') {
    return res.status(409).json({
      error: {
        code: 'PLUGIN_TOO_OLD',
        message: 'Your website is running an older version of our plugin, which does not know how to do this yet. '
          + 'It updates itself; if this does not clear within a day, tell us.',
        status: 409,
      },
    });
  }
  const code = result.error === 'site_not_connected' ? 'SITE_NOT_CONNECTED'
    : result.error === 'timeout' ? 'SITE_TIMEOUT'
    : result.error === 'unreachable' ? 'SITE_UNREACHABLE'
    : 'SITE_REJECTED';
  const status = result.error === 'site_not_connected' ? 409 : 502;
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

/** Every handler starts the same way. Returns null when it has already answered. */
async function resolve(req, res) {
  const pool = await getServicesPool();
  const site = await loadSite(pool, req.tenant.tenantId, req.params.siteId);
  if (!site) {
    notFound(res, 'We could not find that website on your account.');
    return null;
  }
  return { pool, site };
}

/* ==========================================================================
 * MENUS
 *
 * The single most-missed job in the gap analysis: a client could build a page
 * in the Portal and had no way at all to put it in their own navigation.
 * ======================================================================== */

router.get('/menus', async (req, res) => {
  try {
    const ctx = await resolve(req, res);
    if (!ctx) return;
    const result = await fetchMenus(ctx.site);
    if (!result.ok) return pluginFailure(res, result, 'reading your menus');
    return res.json({ data: publicMenus(result.data), meta: { site_id: ctx.site.site_id } });
  } catch (err) {
    return boom(res, err, 'arion/menus GET');
  }
});

router.post('/menus', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return bad(res, 'NAME_REQUIRED', 'A menu needs a name.');
    if (name.length > 100) return bad(res, 'NAME_TOO_LONG', 'That name is too long for a menu.');

    const ctx = await resolve(req, res);
    if (!ctx) return;
    const result = await createMenu(ctx.site, name);
    if (!result.ok) return pluginFailure(res, result, 'a new menu');
    return res.status(201).json({ data: publicMenus(result.data) });
  } catch (err) {
    return boom(res, err, 'arion/menus POST');
  }
});

router.put('/menus/:menuId', async (req, res) => {
  try {
    const menuId = Number(req.params.menuId);
    if (!Number.isInteger(menuId) || menuId <= 0) return bad(res, 'BAD_MENU_ID', 'That is not a menu.');

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const payload = {};
    if (body.name !== undefined) payload.name = String(body.name || '').trim();
    if (body.locations !== undefined) {
      if (!Array.isArray(body.locations)) return bad(res, 'BAD_LOCATIONS', 'Where a menu goes has to be a list.');
      payload.locations = body.locations.map((l) => String(l));
    }
    if (body.items !== undefined) {
      if (!Array.isArray(body.items)) return bad(res, 'BAD_ITEMS', 'A menu is a list of entries.');
      if (body.items.length > MAX_MENU_ITEMS) {
        return bad(res, 'TOO_MANY_ITEMS', `That is more entries than a menu can usefully hold (max ${MAX_MENU_ITEMS}).`);
      }
      payload.items = body.items.map((i) => ({
        item_id: i?.item_id === undefined ? undefined : Number(i.item_id) || 0,
        kind: String(i?.kind || 'custom'),
        object_id: i?.object_id === undefined ? undefined : Number(i.object_id) || 0,
        title: i?.title === undefined ? undefined : String(i.title),
        url: i?.url === undefined ? undefined : String(i.url),
        parent_index: i?.parent_index === undefined || i?.parent_index === null
          ? null
          : Number(i.parent_index),
      }));
    }
    if (!Object.keys(payload).length) return bad(res, 'NOTHING_TO_DO', 'Nothing to change.');

    const ctx = await resolve(req, res);
    if (!ctx) return;
    const result = await writeMenu(ctx.site, menuId, payload);
    if (!result.ok) return pluginFailure(res, result, 'that menu');
    return res.json({ data: publicMenus(result.data) });
  } catch (err) {
    return boom(res, err, 'arion/menus PUT');
  }
});

router.post('/menus/:menuId/undo', async (req, res) => {
  try {
    const menuId = Number(req.params.menuId);
    if (!Number.isInteger(menuId) || menuId <= 0) return bad(res, 'BAD_MENU_ID', 'That is not a menu.');
    const ctx = await resolve(req, res);
    if (!ctx) return;
    const result = await undoMenu(ctx.site, menuId);
    if (!result.ok) return pluginFailure(res, result, 'putting your menu back');
    return res.json({ data: { ...publicMenus(result.data), restored: !!result.data?.restored } });
  } catch (err) {
    return boom(res, err, 'arion/menus undo');
  }
});

/** camelCase for the Portal, and nothing the Portal does not need. */
export function publicMenus(data) {
  const d = data || {};
  return {
    menus: (Array.isArray(d.menus) ? d.menus : []).map((m) => ({
      menuId: Number(m.menu_id) || 0,
      name: String(m.name || ''),
      locations: Array.isArray(m.locations) ? m.locations.map(String) : [],
      canUndo: !!m.can_undo,
      items: (Array.isArray(m.items) ? m.items : []).map((i) => ({
        itemId: Number(i.item_id) || 0,
        title: String(i.title || ''),
        kind: String(i.kind || 'custom'),
        objectId: Number(i.object_id) || 0,
        url: String(i.url || ''),
        parentItemId: Number(i.parent_item_id) || 0,
      })),
    })),
    locations: (Array.isArray(d.locations) ? d.locations : []).map((l) => ({
      location: String(l.location || ''),
      label: String(l.label || ''),
      menuId: Number(l.menu_id) || 0,
    })),
    addable: (Array.isArray(d.addable) ? d.addable : []).map((a) => ({
      objectId: Number(a.object_id) || 0,
      kind: String(a.kind || 'page'),
      title: String(a.title || ''),
      status: String(a.status || ''),
      url: String(a.url || ''),
    })),
    booking: {
      url: String(d.booking?.url || ''),
      label: String(d.booking?.label || 'Book now'),
    },
    theme: String(d.theme || ''),
    pluginVersion: String(d.plugin_version || ''),
  };
}

/* ==========================================================================
 * BRAND — the Elementor kit's colours and fonts.
 *
 * Until now the ONLY writer was wp-cli over Hostinger SSH at provisioning
 * (lib/elementorGlobals.js), so a client could never change their own colours
 * and a BYO-hosted site could not be branded at all.
 *
 * The suggested values come from the ONE business identity: the colour and
 * font already recorded against the site, run through the SAME payload
 * builder the SSH path used, so the Portal and provisioning agree on what
 * "our brand" means.
 * ======================================================================== */

export function publicKit(data, suggested) {
  const d = data || {};
  return {
    kitId: Number(d.kit_id) || 0,
    colors: (Array.isArray(d.colors) ? d.colors : []).map((c) => ({
      id: String(c.id || ''), title: String(c.title || ''), color: String(c.color || ''),
    })),
    typography: (Array.isArray(d.typography) ? d.typography : []).map((t) => ({
      id: String(t.id || ''), title: String(t.title || ''),
      fontFamily: String(t.font_family || ''), fontWeight: String(t.font_weight || ''),
    })),
    suggested: suggested || null,
    pluginVersion: String(d.plugin_version || ''),
  };
}

/** What the business's own identity says its brand is. Never a guess. */
function suggestedBrand(brand) {
  const primary = String(brand?.primary_color || '').trim();
  const fonts = pickDefaultFonts(brand?.industry);
  const headingFont = String(brand?.font_family || '').trim() || fonts.heading;
  // buildGlobalsPayload is the ONE description of "our brand as an Elementor
  // kit". It needs three colours; we only ever record one, so the other two
  // are derived from it and clearly labelled as suggestions the client can
  // change. Without a recorded colour there is no suggestion at all - an
  // invented brand colour is a fabricated answer.
  if (!primary) {
    return {
      hasBrandColour: false,
      colors: [],
      typography: [
        { id: 'primary', fontFamily: headingFont, fontWeight: '700' },
        { id: 'secondary', fontFamily: String(brand?.font_family || '').trim() || fonts.body, fontWeight: '400' },
      ],
    };
  }
  const payload = buildGlobalsPayload({
    brandName: brand?.business_name,
    primaryColor: primary,
    secondaryColor: primary,
    accentColor: primary,
    headingFont,
    bodyFont: String(brand?.font_family || '').trim() || fonts.body,
  });
  return {
    hasBrandColour: true,
    colors: payload.system_colors.map((c) => ({ id: c._id, title: c.title, color: c.color })),
    typography: payload.system_typography.map((t) => ({
      id: t._id, fontFamily: t.typography_font_family, fontWeight: t.typography_font_weight,
    })),
  };
}

router.get('/site/kit', async (req, res) => {
  try {
    const ctx = await resolve(req, res);
    if (!ctx) return;
    const [result, brand] = await Promise.all([
      fetchKit(ctx.site),
      loadBrandContext(ctx.pool, { tenantId: req.tenant.tenantId, siteId: ctx.site.site_id }),
    ]);
    if (!result.ok) {
      // The plugin refuses a kit read on a site with no Elementor, and says so
      // in the same sentence the editor uses. Pass it through rather than
      // translating it into "your website answered an error".
      if (result.status === 409 && result.data?.code === 'elementor_missing') {
        return res.status(409).json({
          error: { code: 'ELEMENTOR_NOT_ACTIVE', message: String(result.data.error), status: 409 },
        });
      }
      return pluginFailure(res, result, 'reading your colours and fonts');
    }
    return res.json({ data: publicKit(result.data, suggestedBrand(brand)) });
  } catch (err) {
    return boom(res, err, 'arion/site/kit GET');
  }
});

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

router.post('/site/kit', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const payload = {};
    if (body.colors !== undefined) {
      if (!Array.isArray(body.colors)) return bad(res, 'BAD_COLOURS', 'Colours have to be a list.');
      for (const c of body.colors) {
        if (!c || !String(c.id || '').trim()) return bad(res, 'BAD_COLOURS', 'Every colour needs to say which one it is.');
        if (!HEX.test(String(c.color || '').trim())) {
          return bad(res, 'BAD_COLOUR', 'That is not a colour we can use — it needs to look like #1A3A4A.');
        }
      }
      payload.colors = body.colors.map((c) => ({ id: String(c.id), color: String(c.color).trim() }));
    }
    if (body.typography !== undefined) {
      if (!Array.isArray(body.typography)) return bad(res, 'BAD_FONTS', 'Fonts have to be a list.');
      for (const t of body.typography) {
        if (!t || !String(t.id || '').trim()) return bad(res, 'BAD_FONTS', 'Every font needs to say which one it is.');
        if (!String(t.fontFamily || t.font_family || '').trim()) {
          return bad(res, 'BAD_FONT', 'A font needs a name.');
        }
      }
      payload.typography = body.typography.map((t) => ({
        id: String(t.id),
        font_family: String(t.fontFamily || t.font_family).trim(),
        font_weight: String(t.fontWeight || t.font_weight || ''),
      }));
    }
    if (!Object.keys(payload).length) return bad(res, 'NOTHING_TO_DO', 'Send colours, fonts, or both.');

    const ctx = await resolve(req, res);
    if (!ctx) return;
    const result = await writeKit(ctx.site, payload);
    if (!result.ok) {
      if (result.status === 409 && result.data?.code === 'elementor_missing') {
        return res.status(409).json({
          error: { code: 'ELEMENTOR_NOT_ACTIVE', message: String(result.data.error), status: 409 },
        });
      }
      return pluginFailure(res, result, 'your colours and fonts');
    }
    return res.json({ data: publicKit(result.data, null) });
  } catch (err) {
    return boom(res, err, 'arion/site/kit POST');
  }
});

/* ==========================================================================
 * HEADER AND FOOTER — through the ACTIVE THEME's own options (D-ARION-A).
 *
 * Not Elementor Pro's Theme Builder: that ties the feature to a licence seat
 * we have not settled for Lite (2027), and it does not exist on a site
 * somebody else built. The plugin says which of the fields the running theme
 * actually offers; a field it does not offer comes back unsupported WITH the
 * reason, and is never written blind.
 * ======================================================================== */

export function publicChrome(data, suggested) {
  const d = data || {};
  return {
    theme: String(d.theme || ''),
    themeFamily: String(d.theme_family || ''),
    fields: (Array.isArray(d.fields) ? d.fields : []).map((f) => ({
      key: String(f.key || ''),
      group: String(f.group || 'header'),
      label: String(f.label || ''),
      type: String(f.type || 'text'),
      supported: !!f.supported,
      reason: f.reason ? String(f.reason) : null,
      value: f.value === undefined ? null : f.value,
      options: Array.isArray(f.options) ? f.options.map(String) : undefined,
      help: f.help ? String(f.help) : undefined,
      imageUrl: f.image_url === undefined ? undefined : String(f.image_url || ''),
    })),
    menuLocations: (Array.isArray(d.menu_locations) ? d.menu_locations : []).map((m) => ({
      location: String(m.location || ''),
      label: String(m.label || ''),
      menuId: Number(m.menu_id) || 0,
      menuName: String(m.menu_name || ''),
    })),
    booking: {
      url: String(d.booking?.url || ''),
      inHeader: !!d.booking?.in_header,
      label: String(d.booking?.label || 'Book now'),
    },
    suggested: suggested || null,
    pluginVersion: String(d.plugin_version || ''),
  };
}

/**
 * What the header and footer should say, from the ONE business identity.
 *
 * The business NAME comes from the resolver every other surface uses, and a
 * business with no recorded name gets no suggestion — a builder that prints
 * a made-up name into a site's header is the twelfth-chain defect all over
 * again (memory: reference_platform_seams_audit / businessName.js).
 */
function suggestedChrome(brand) {
  const name = String(brand?.business_name || '').trim();
  const known = name && name !== BUSINESS_NAME_NOT_SET;
  return {
    businessName: known ? name : '',
    tagline: String(brand?.tagline || ''),
    footerText: known ? `© ${new Date().getFullYear()} ${name}. All rights reserved.` : '',
    logoUrl: String(brand?.logo_url || ''),
    bookingUrl: String(brand?.booking_href || ''),
  };
}

router.get('/site/chrome', async (req, res) => {
  try {
    const ctx = await resolve(req, res);
    if (!ctx) return;
    const [result, brand] = await Promise.all([
      fetchChrome(ctx.site),
      loadBrandContext(ctx.pool, { tenantId: req.tenant.tenantId, siteId: ctx.site.site_id }),
    ]);
    if (!result.ok) return pluginFailure(res, result, 'reading your header and footer');
    return res.json({ data: publicChrome(result.data, suggestedChrome(brand)) });
  } catch (err) {
    return boom(res, err, 'arion/site/chrome GET');
  }
});

router.post('/site/chrome', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    if (!Object.keys(body).length) return bad(res, 'NOTHING_TO_DO', 'Nothing to change.');

    const ctx = await resolve(req, res);
    if (!ctx) return;
    const result = await writeChrome(ctx.site, body);
    if (!result.ok) {
      // The plugin refuses a key it does not own, and a field the theme does
      // not offer, in words. Those are the client's answer, not ours.
      if (result.status === 400 || result.status === 409) {
        return res.status(result.status).json({
          error: {
            code: String(result.data?.code || 'REFUSED').toUpperCase(),
            message: String(result.data?.error || result.message),
            status: result.status,
          },
        });
      }
      return pluginFailure(res, result, 'your header and footer');
    }
    return res.json({ data: publicChrome(result.data, null) });
  } catch (err) {
    return boom(res, err, 'arion/site/chrome POST');
  }
});

/* ==========================================================================
 * SITE OPTIONS — the website chat bubble and the Book now button.
 * Both lived only on a wp-admin settings screen, which means a client had to
 * sign into WordPress to switch on the chat bubble the Portal sold them.
 * ======================================================================== */

export function publicSiteOptions(data) {
  const d = data || {};
  return {
    chat: {
      enabled: !!d.chat?.enabled,
      fallbackUrl: String(d.chat?.fallback_url || ''),
    },
    booking: {
      url: String(d.booking?.url || ''),
      inHeader: !!d.booking?.in_header,
      label: String(d.booking?.label || 'Book now'),
      tierAllows: !!d.booking?.tier_allows,
    },
    pluginVersion: String(d.plugin_version || ''),
  };
}

router.get('/site/options', async (req, res) => {
  try {
    const ctx = await resolve(req, res);
    if (!ctx) return;
    // Opening the website settings also tells the site what the subscription
    // lets it do (SPARK capture, the ARION tier). Fire and forget, at most once
    // per ten minutes per site; it never delays or changes this answer.
    syncSubscriptionConfigSoon(ctx.pool, ctx.site);
    const result = await fetchSiteOptions(ctx.site);
    if (!result.ok) return pluginFailure(res, result, 'reading your website settings');
    return res.json({ data: publicSiteOptions(result.data) });
  } catch (err) {
    return boom(res, err, 'arion/site/options GET');
  }
});

const OPTION_KEYS = Object.freeze(['chatEnabled', 'chatFallbackUrl', 'bookingInHeader', 'bookingLabel']);
const OPTION_WIRE = Object.freeze({
  chatEnabled: 'chat_enabled',
  chatFallbackUrl: 'chat_fallback_url',
  bookingInHeader: 'booking_in_header',
  bookingLabel: 'booking_label',
});

router.post('/site/options', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const payload = {};
    for (const key of Object.keys(body)) {
      if (!OPTION_KEYS.includes(key)) {
        return bad(res, 'NOT_A_SETTING', `We do not set "${key}" on your website.`);
      }
      payload[OPTION_WIRE[key]] = body[key];
    }
    if (!Object.keys(payload).length) return bad(res, 'NOTHING_TO_DO', 'Nothing to change.');
    if (payload.booking_label !== undefined && String(payload.booking_label).length > 40) {
      return bad(res, 'LABEL_TOO_LONG', 'That is too long for a button.');
    }

    const ctx = await resolve(req, res);
    if (!ctx) return;
    syncSubscriptionConfigSoon(ctx.pool, ctx.site);
    const result = await writeSiteOptions(ctx.site, payload);
    if (!result.ok) {
      if (result.status === 400 || result.status === 409) {
        return res.status(result.status).json({
          error: {
            code: String(result.data?.code || 'REFUSED').toUpperCase(),
            message: String(result.data?.error || result.message),
            status: result.status,
          },
        });
      }
      return pluginFailure(res, result, 'your website settings');
    }
    return res.json({ data: publicSiteOptions(result.data) });
  } catch (err) {
    return boom(res, err, 'arion/site/options POST');
  }
});

/* ==========================================================================
 * THE ONE PRICE SOURCE — what the pricing section fills itself from.
 * ======================================================================== */

router.get('/pricing-catalogue', async (req, res) => {
  try {
    const ctx = await resolve(req, res);
    if (!ctx) return;
    const list = await loadServicePrices(ctx.pool, req.tenant.tenantId);
    return res.json({
      data: {
        available: list.ok,
        // Why there is nothing to offer, so the Portal can say it rather than
        // showing an empty box: 'no_service_catalogue' means this business
        // does not keep its services and prices with us.
        reason: list.reason,
        services: list.services.map((s) => ({
          offeringId: s.offering_id,
          name: s.name,
          description: s.description,
          durationMinutes: s.duration_minutes,
          price: s.price,
          period: s.period,
          features: s.features,
        })),
      },
    });
  } catch (err) {
    return boom(res, err, 'arion/pricing-catalogue');
  }
});

export default router;
export const __test__ = { publicMenus, publicKit, publicChrome, publicSiteOptions, suggestedBrand, suggestedChrome };
