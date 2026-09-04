#!/usr/bin/env node
/**
 * _dev_seed_wp_fixture.mjs — register the dev WordPress container as an ARION
 * site and fill it with fixture pages.
 *
 * Called by dev-stack\start-dev-wp.ps1. Safe to re-run.
 *
 * ⚠ LOCAL DEV ONLY. It refuses to run unless the SQL target is the local
 * container, gated on the PRESENCE of the dev markers rather than the absence
 * of a production one — an absence-based guard fails open
 * (memory: reference_absence_based_guards_fail_open,
 *  feedback_verify_db_target_before_writing). Every business, person, address
 * and phone number below is invented (memory: feedback_no_real_client_data_in_dev).
 *
 * What it creates on the fixture site:
 *   Home            published — hero, services, testimonials, call to action
 *   About us        published — about, a HAND-BUILT Elementor section with no
 *                   ia: handle (so the "Custom section" round trip is real),
 *                   then an FAQ
 *   Our workshop    published — FIVE hand-built sections and nothing else, the
 *                   way every page on the five real sites is: a banner and a
 *                   three-card row the Phase 3 mapper can take charge of, a
 *                   quote block with a Pro form it can take charge of on
 *                   Standard and above but must refuse on Lite, a video band
 *                   it must refuse because it cannot carry a video, and an
 *                   awards strip it cannot identify at all
 *   Contact         published — the contact + form section
 *   Autumn offer    DRAFT     — proves the pages list shows drafts, which the
 *                   publish-only /content/seo-detail never could
 *
 * Usage:
 *   node scripts/_dev_seed_wp_fixture.mjs --apply \
 *        --site-id=<uuid> --tenant-id=<uuid> --token=<raw> \
 *        --domain=localhost:8084 --tier=business [--reseed]
 */

import 'dotenv/config';
import sql from 'mssql';
import crypto from 'node:crypto';
import { getServicesPool } from '../db/servicesPool.js';
import { hashSiteToken } from '../lib/siteToken.js';
import { blockToElementorSection } from '../lib/websiteBuilder/elementorAdapter.js';

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const i = a.indexOf('=');
      return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)];
    }),
);

const APPLY    = !!args.apply;
const RESEED   = !!args.reseed;
const SITE_ID  = String(args['site-id'] || '');
const TENANT   = String(args['tenant-id'] || 'a0000001-0000-0000-0000-000000000001');
const TOKEN    = String(args.token || '');
const DOMAIN   = String(args.domain || 'localhost:8084');
const TIER     = String(args.tier || 'business');
const BASE     = `http://${DOMAIN}/wp-json/intelligent-analytics/v1`;

function die(msg) { console.error(`\n[seed] ${msg}\n`); process.exit(1); }
if (!SITE_ID) die('--site-id=<uuid> is required');
if (!TOKEN)   die('--token=<raw site token> is required');

/* ── the guard ──────────────────────────────────────────────────────────── */

async function assertLocalDev(pool) {
  const r = await pool.request().query('SELECT DB_NAME() db, @@SERVERNAME srv, SUSER_SNAME() login');
  const { db, srv, login } = r.recordset[0];
  const server = String(process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER || '');
  // PRESENT dev markers: the connection string points at loopback AND the login
  // is the container's SA. Either one missing and we stop.
  const loopback = /^(localhost|127\.0\.0\.1)(,\d+)?$/i.test(server.trim());
  const saLogin  = /^sa$/i.test(String(login).trim());
  console.log(`[seed] target: db=${db} server=${srv} login=${login} (conn "${server}")`);
  if (!loopback || !saLogin) {
    die(`Refusing to run: this is not the local dev SQL container.\n`
      + `       Expected SERVICES_SQL_SERVER=localhost,1433 and login SA; got "${server}" / "${login}".`);
  }
  if (!/^iadm_services$/i.test(String(db))) die(`Expected the iadm_services database, got "${db}".`);
}

/* ── the fixture business ───────────────────────────────────────────────── */

const BRAND = {
  business_name: 'Fernbrook Garden Rooms',
  email: 'hello@fernbrook.invalid',
  primary_color: '#245A4A',
  accent_color: '#E8B33C',
};

const BLOCKS = {
  hero: {
    headline: 'Garden rooms built to last a lifetime',
    subheadline: 'Insulated, wired and finished in four weeks — designed and built by the same three people from start to finish.',
    cta_text: 'Book a site visit',
    cta_href: '#contact',
    image_alt: 'A finished cedar-clad garden room at dusk',
    background_style: 'solid',
  },
  services: {
    headline: 'What we build',
    subheadline: 'Three shapes, endlessly adjusted to your garden.',
    services: [
      { title: 'Garden offices', description: 'A warm, quiet room to work in, wired for two desks and ready the week it lands.', icon_name: 'briefcase' },
      { title: 'Studios and workshops', description: 'Higher ceilings, wider doors and a floor that takes a kiln or a table saw.', icon_name: 'tools' },
      { title: 'Guest rooms', description: 'Insulated to full building standards with a shower room plumbed in.', icon_name: 'home' },
    ],
  },
  testimonials: {
    headline: 'What our customers say',
    subheadline: 'Gardens across the county, four years running.',
    testimonials: [
      { quote: 'They arrived on the Monday and we were working in it by the Friday of the following week. Not one surprise on the invoice.', attribution: 'Priya N.', role: 'Garden office, Marsden', rating: 5 },
      { quote: 'The insulation is the real thing. It has been through two winters without a heater on most days.', attribution: 'Tom B.', role: 'Studio, Farnley', rating: 5 },
    ],
  },
  cta: {
    headline: 'Thinking about the bottom of your garden?',
    subheadline: 'Send us a photo and rough measurements and we will come back with a price.',
    primary_cta_text: 'Book a site visit',
    primary_cta_href: '#contact',
    secondary_cta_text: 'Call 01000 960 118',
    secondary_cta_href: 'tel:+441000960118',
    background_style: 'gradient',
  },
  about: {
    headline: 'About Fernbrook',
    subheadline: 'Three joiners, one workshop, no subcontractors.',
    story_paragraphs: [
      'Fernbrook started in 2016 in a rented barn with one bandsaw and a very patient landlord.',
      'We build every frame in the workshop and put it up ourselves, which is why the same three faces turn up on day one and on handover day.',
    ],
    values: [
      { title: 'One team, start to finish', description: 'The people who quote the job are the people who build it.' },
      { title: 'Priced once', description: 'The number on the quote is the number on the invoice.' },
    ],
    image_alt: 'Two joiners lifting a wall frame into place',
  },
  faq: {
    headline: 'Questions we get asked',
    subheadline: '',
    faqs: [
      { question: 'Do I need planning permission?', answer: 'Usually not, as long as the room stays under 2.5 m at the eaves and covers less than half the garden. We check yours before we quote.' },
      { question: 'How long does it take?', answer: 'Four weeks from deposit for a standard office; six for anything with plumbing.' },
      { question: 'What is the guarantee?', answer: 'Ten years on the structure, two on the fittings.' },
    ],
  },
  contact: {
    headline: 'Get in touch',
    subheadline: 'Tell us roughly what you are after and we will come and measure up.',
    contact_methods: [
      { kind: 'phone', label: 'Call us', value: '01000 960 118', href: 'tel:+441000960118' },
      { kind: 'email', label: 'Email', value: 'hello@fernbrook.invalid', href: 'mailto:hello@fernbrook.invalid' },
    ],
    form_config: { fields: ['Name', 'Email', 'Phone', 'Message'], submit_text: 'Send' },
    form_purpose: 'quote',
  },
  offerHero: {
    headline: 'Autumn build slots',
    subheadline: 'Three slots left before Christmas. Deposit holds the date.',
    cta_text: 'Ask about a slot',
    cta_href: '#contact',
    image_alt: '',
    background_style: 'gradient',
  },
};

function section(kind, block, seed) {
  return blockToElementorSection({
    kind, block, brand: BRAND, seedId: `fixture-${seed}`, blockId: `fx-${seed}`,
  });
}

/* ── hand-built sections for the Phase 3 adoption walk ──────────────────
 *
 * Nothing on these carries an `ia:` handle or a field marker, exactly like the
 * five real sites. Between them they cover every answer the mapper can give:
 * two it can take charge of, one it cannot identify, one carrying content it
 * cannot carry over. So "N of M sections adoptable" on the fixture site is a
 * real number with a real reason for every row.
 * --------------------------------------------------------------------- */

/** Adoptable → hero. One big headline over a background picture, one button. */
function handBuiltHero() {
  return {
    id: 'hbhero1',
    elType: 'section',
    settings: {
      _title: 'Workshop banner (built in Elementor)',
      background_image: { url: `http://${DOMAIN}/wp-content/uploads/fernbrook-hero.jpg`, id: '' },
      background_background: 'classic',
      layout: 'full_width',
    },
    elements: [{
      id: 'hbherocol', elType: 'column', settings: { _column_size: 100 },
      elements: [
        {
          id: 'hbheroh', elType: 'widget', widgetType: 'heading',
          settings: { title: 'Built in Shropshire, delivered to your garden', header_size: 'h1', align: 'center' },
        },
        {
          id: 'hbherop', elType: 'widget', widgetType: 'text-editor',
          settings: { editor: '<p>Insulated garden rooms, made to measure, up in three weeks.</p>', align: 'center' },
        },
        {
          id: 'hbherob', elType: 'widget', widgetType: 'button',
          settings: { text: 'Book a survey', link: { url: '/contact/', is_external: '', nofollow: '' }, align: 'center' },
        },
      ],
    }],
    isInner: false,
  };
}

/** Adoptable → services. Three matching columns of heading and paragraph. */
function handBuiltServices() {
  const card = (n, title, body) => ({
    id: `hbsvccol${n}`, elType: 'column', settings: { _column_size: 33 },
    elements: [
      { id: `hbsvch${n}`, elType: 'widget', widgetType: 'heading', settings: { title, header_size: 'h3', align: 'center' } },
      { id: `hbsvcp${n}`, elType: 'widget', widgetType: 'text-editor', settings: { editor: `<p>${body}</p>`, align: 'center' } },
    ],
  });
  return {
    id: 'hbsvc1',
    elType: 'section',
    settings: { _title: 'Three things we make (built in Elementor)', structure: '30' },
    elements: [
      {
        id: 'hbsvchcol', elType: 'column', settings: { _column_size: 100 },
        elements: [{
          id: 'hbsvchead', elType: 'widget', widgetType: 'heading',
          settings: { title: 'Three things we make', header_size: 'h2', align: 'center' },
        }],
      },
      card(1, 'Garden offices', 'Insulated, wired and ready to work in on the day it lands.'),
      card(2, 'Garden gyms', 'Rubber floors, mirrors and a door wide enough for a rack.'),
      card(3, 'Studios', 'Soundproofed to order, for people who make a noise.'),
    ],
    isInner: false,
  };
}

/**
 * NOT adoptable → the mapper cannot say what this is.
 * A heading in one column and a line in another matches no archetype, so the
 * row stays greyed and says so. This one has been on the fixture since 1A and
 * is also what proves a custom section round-trips byte for byte
 * (SCOPE §3.3, walkthrough T3/T6).
 */
function handBuiltSection() {
  return {
    id: 'hand001',
    elType: 'section',
    settings: { _title: 'Awards strip (built in Elementor)', structure: '20', gap: 'default' },
    elements: [
      {
        id: 'handcol1', elType: 'column', settings: { _column_size: 50 },
        elements: [{
          id: 'handw1', elType: 'widget', widgetType: 'heading',
          settings: { title: 'County Build Awards 2025', header_size: 'h3', align: 'center' },
        }],
      },
      {
        id: 'handcol2', elType: 'column', settings: { _column_size: 50 },
        elements: [{
          id: 'handw2', elType: 'widget', widgetType: 'text-editor',
          settings: { editor: '<p>Highly commended, small workshop of the year.</p>', align: 'center' },
        }],
      },
    ],
    isInner: false,
  };
}

/**
 * NOT adoptable → it holds a video, and the editor has no field for one.
 * Reads as a call to action otherwise, so this is the row that proves the
 * mapper refuses on CONTENT it cannot carry rather than on confidence alone.
 */
function handBuiltVideoBand() {
  return {
    id: 'hbvid1',
    elType: 'section',
    settings: { _title: 'See one being built (built in Elementor)', structure: '10' },
    elements: [{
      id: 'hbvidcol', elType: 'column', settings: { _column_size: 100 },
      elements: [
        {
          id: 'hbvidh', elType: 'widget', widgetType: 'heading',
          settings: { title: 'See one being built', header_size: 'h2', align: 'center' },
        },
        {
          id: 'hbvidv', elType: 'widget', widgetType: 'video',
          settings: { youtube_url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', video_type: 'youtube' },
        },
        {
          id: 'hbvidb', elType: 'widget', widgetType: 'button',
          settings: { text: 'Watch the build', link: { url: '#', is_external: '', nofollow: '' }, align: 'center' },
        },
      ],
    }],
    isInner: false,
  };
}

/**
 * Adoptable on Standard and above, REFUSED on Lite.
 * A hand-built contact block with an Elementor Pro form on it. The mapper
 * reads it as a contact section either way; the tier is what decides whether
 * the offer is made, because a Lite site has no Pro form widget to rebuild it
 * with. This is the only fixture row that proves the tier gate on the
 * adoption path rather than on the "add a section" picker.
 */
function handBuiltContact() {
  return {
    id: 'hbcon1',
    elType: 'section',
    settings: { _title: 'Get a quote (built in Elementor)', structure: '20' },
    elements: [
      {
        id: 'hbconcol1', elType: 'column', settings: { _column_size: 50 },
        elements: [
          {
            id: 'hbconh', elType: 'widget', widgetType: 'heading',
            settings: { title: 'Ask us for a price', header_size: 'h2', align: 'left' },
          },
          {
            id: 'hbconl', elType: 'widget', widgetType: 'icon-list',
            settings: {
              icon_list: [
                { _id: 'hbcl1', text: 'Phone: 01952 000 000', selected_icon: { value: 'fas fa-phone', library: 'fa-solid' }, link: { url: 'tel:01952000000', is_external: '', nofollow: '' } },
                { _id: 'hbcl2', text: 'Email: hello@fernbrook.invalid', selected_icon: { value: 'fas fa-envelope', library: 'fa-solid' }, link: { url: 'mailto:hello@fernbrook.invalid', is_external: '', nofollow: '' } },
              ],
            },
          },
        ],
      },
      {
        id: 'hbconcol2', elType: 'column', settings: { _column_size: 50 },
        elements: [{
          id: 'hbconf', elType: 'widget', widgetType: 'form',
          settings: {
            form_name: 'Quote request',
            form_css_class: 'ia-quote',
            email_to: 'quotes@fernbrook.invalid',
            button_text: 'Send my details',
            form_fields: [
              { _id: 'hbf1', custom_id: 'name', field_type: 'text', field_label: 'Name', required: 'true', width: '100' },
              { _id: 'hbf2', custom_id: 'email', field_type: 'email', field_label: 'Email', required: 'true', width: '100' },
              { _id: 'hbf3', custom_id: 'square_footage', field_type: 'number', field_label: 'Square Footage', required: '', width: '100' },
              { _id: 'hbf4', custom_id: 'message', field_type: 'textarea', field_label: 'Message', required: '', width: '100' },
            ],
          },
        }],
      },
    ],
    isInner: false,
  };
}

/* ── the plugin calls ───────────────────────────────────────────────────── */

async function plugin(path, { method = 'GET', body } = {}) {
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}_ia_cb=${Date.now()}`;
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'X-Arion-Site-Token': TOKEN,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    throw new Error(`plugin ${method} ${path} -> ${res.status} ${String(text).slice(0, 300)}`);
  }
  return parsed;
}

/**
 * Empty a page's Undo ring.
 *
 * `--reseed` claims to rebuild the fixture pages, and it did rebuild their
 * CONTENT — but the snapshot ring is post meta and survived, so a "freshly
 * seeded" page arrived with a dozen versions of somebody's click-through
 * still in it. Two things went wrong because of that: the 1A verifier's
 * "Undo with nothing left says so rather than pretending" popped a stale
 * snapshot and failed, and popping it PUT AN OLD PAGE BACK — the fixture was
 * then wrong for everything that ran afterwards.
 *
 * Undo is the only way to drain the ring, and it rewrites the page as it
 * goes; that is fine here because the fixture write lands immediately after.
 * `/pages/elementor` (the seeder's write path) pushes no snapshot of its own,
 * so a seeded page ends with exactly nothing to undo, which is what "fresh"
 * has to mean.
 */
async function drainUndoRing(pageId) {
  for (let i = 0; i < 30; i++) {
    const out = await plugin(`/pages/${pageId}/undo`, { method: 'POST', body: {} });
    if (!out || out.restored === false) return i;
  }
  console.warn(`[seed] page #${pageId} still had snapshots after 30 undos — carrying on`);
  return 30;
}

/**
 * Write one fixture page. Re-running replaces the same page (matched by
 * title), so the seed is idempotent and never leaves duplicates behind.
 */
async function upsertPage(existing, { title, status, sections }) {
  const found = existing.find((p) => p.title === title);
  if (found) {
    const drained = await drainUndoRing(found.page_id);
    if (drained > 0) console.log(`[seed] cleared ${drained} old version${drained === 1 ? '' : 's'} of "${title}"`);
  }
  const body = { page_id: found ? found.page_id : null, title, status, elementor_data: sections };
  const out = await plugin('/pages/elementor', { method: 'POST', body });
  const pageId = out?.page_id;
  if (!pageId) throw new Error(`the plugin saved "${title}" without returning a page id`);
  console.log(`[seed] ${found ? 'updated' : 'created'} "${title}" (#${pageId}, ${status}) — ${sections.length} sections`);
  return pageId;
}

/* ── main ───────────────────────────────────────────────────────────────── */

(async () => {
  if (!APPLY) {
    console.log('[seed] dry run — pass --apply to write anything');
  }

  const pool = await getServicesPool();
  await assertLocalDev(pool);

  // 1. The arion.site row, shaped the way provision/redeem shapes it
  //    (routes/submit.js:652-673): hash for verification, raw for outbound.
  if (APPLY) {
    await pool.request()
      .input('siteId',   sql.UniqueIdentifier, SITE_ID)
      .input('tenantId', sql.UniqueIdentifier, TENANT)
      .input('domain',   sql.NVarChar(253),    DOMAIN)
      .input('tier',     sql.NVarChar(20),     TIER)
      .input('hash',     sql.NVarChar(64),     hashSiteToken(TOKEN))
      .input('raw',      sql.NVarChar(256),    TOKEN)
      .input('adminUrl', sql.NVarChar(500),    `http://${DOMAIN}/wp-admin/`)
      .input('primary',  sql.NVarChar(20),     BRAND.primary_color)
      .query(`
        MERGE arion.site AS t
        USING (SELECT @siteId AS site_id) AS s ON t.site_id = s.site_id
        WHEN MATCHED THEN UPDATE SET
          tenant_id = @tenantId, domain = @domain, arion_tier = @tier,
          site_token_hash = @hash, site_token_raw = @raw,
          site_token_last_rotated = SYSDATETIMEOFFSET(),
          wp_admin_url = @adminUrl, branding_primary_color = @primary,
          plugin_status = 'connected', plugin_connected_at = SYSDATETIMEOFFSET(),
          plugin_last_status_at = SYSDATETIMEOFFSET(), updated_at = SYSDATETIMEOFFSET()
        WHEN NOT MATCHED THEN INSERT
          (site_id, tenant_id, domain, arion_tier, site_token_hash, site_token_raw,
           site_token_last_rotated, wp_admin_url, branding_primary_color,
           plugin_status, plugin_connected_at, plugin_last_status_at,
           status, created_at, updated_at)
          VALUES
          (@siteId, @tenantId, @domain, @tier, @hash, @raw,
           SYSDATETIMEOFFSET(), @adminUrl, @primary,
           'connected', SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(),
           'active', SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET());
      `);
    console.log(`[seed] arion.site ${SITE_ID} -> ${DOMAIN} (tier ${TIER}, tenant ${TENANT})`);
  }

  // 1b. The signup session the brand context reads.
  //
  // Without it `loadBrandContext` answers with an empty business name and an
  // empty notification email, and everything downstream quietly degrades: a
  // starter hero says "Welcome to our business", and the curated CONTACT
  // layouts are refused outright because a form has to know which inbox to
  // notify. On a real site this row is written at signup; the fixture was
  // missing it, so the fixture was not actually the shape a client's site is.
  if (APPLY) {
    await pool.request()
      .input('siteId',   sql.UniqueIdentifier, SITE_ID)
      .input('tenantId', sql.UniqueIdentifier, TENANT)
      .input('email',    sql.NVarChar(320),    BRAND.email)
      .input('stripe',   sql.NVarChar(255),    `dev-fixture-${SITE_ID}`)
      .input('answers',  sql.NVarChar(sql.MAX), JSON.stringify({
        businessName:   BRAND.business_name,
        contactEmail:   BRAND.email,
        industry:       'Garden rooms and outbuildings',
        tagline:        'Garden rooms built to last a lifetime',
        description:    'A three-person joinery firm building insulated garden rooms, studios and guest rooms.',
        targetAudience: 'Homeowners who need another room and do not want to move',
        services:       BLOCKS.services.services.map((x) => x.title),
        brandVoice:     'warm, plain-spoken, unhurried',
        stylePreference: 'clean, photographic',
        location:       'Fernbrook and forty miles around it',
      }))
      .query(`
        MERGE arion.signup_session AS t
        USING (SELECT @stripe AS stripe_session_id) AS s
          ON t.stripe_session_id = s.stripe_session_id
        WHEN MATCHED THEN UPDATE SET
          tenant_id = @tenantId, site_id = @siteId, email = @email,
          questionnaire_json = @answers, questionnaire_submitted_at = SYSDATETIMEOFFSET(),
          submitted_at = SYSDATETIMEOFFSET()
        WHEN NOT MATCHED THEN INSERT
          (stripe_session_id, tenant_id, site_id, email, questionnaire_json,
           questionnaire_submitted_at, created_at, submitted_at)
          VALUES
          (@stripe, @tenantId, @siteId, @email, @answers,
           SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET());
      `);
    console.log(`[seed] brand context: ${BRAND.business_name} <${BRAND.email}>`);
  }

  // 2. Prove the plugin answers before writing anything into it.
  const health = await plugin('/status');
  const status = health?.data ?? health ?? {};
  console.log(`[seed] plugin says: v${status.plugin_version || '?'}, tier ${status.tier || '?'}, `
    + `token ${status.token_configured ? 'set' : 'MISSING'}`);
  if (!status.token_configured) die('the plugin has no site token — re-run start-dev-wp.ps1');

  const listed = await plugin('/pages');
  const existing = Array.isArray(listed?.pages) ? listed.pages : [];
  if (existing.length && !RESEED) {
    const managed = existing.filter((p) => p.ia_managed);
    if (managed.length >= 3) {
      console.log(`[seed] ${managed.length} fixture pages already there — pass --reseed to rebuild them`);
      console.log('[seed] done');
      process.exit(0);
    }
  }

  if (!APPLY) { console.log('[seed] dry run finished'); process.exit(0); }

  await upsertPage(existing, {
    title: 'Home',
    status: 'publish',
    sections: [
      section('hero', BLOCKS.hero, 'home-hero'),
      section('services', BLOCKS.services, 'home-services'),
      section('testimonials', BLOCKS.testimonials, 'home-testimonials'),
      section('cta', BLOCKS.cta, 'home-cta'),
    ],
  });

  await upsertPage(existing, {
    title: 'About us',
    status: 'publish',
    sections: [
      section('about', BLOCKS.about, 'about-story'),
      handBuiltSection(),
      section('faq', BLOCKS.faq, 'about-faq'),
    ],
  });

  // Phase 3: a page that is ALL hand-built, the way every page on the five
  // real sites is. Four sections, two the mapper can take charge of and two it
  // must refuse — one because it cannot say what the section is, one because
  // it holds a video the editor has no field for.
  await upsertPage(existing, {
    title: 'Our workshop',
    status: 'publish',
    sections: [
      handBuiltHero(),
      handBuiltServices(),
      handBuiltContact(),
      handBuiltVideoBand(),
      handBuiltSection(),
    ],
  });

  await upsertPage(existing, {
    title: 'Contact',
    status: 'publish',
    // The form widget is Elementor PRO. Dev installs Elementor free only, so
    // the widget renders as a placeholder on the front end — the FIELDS still
    // read and write, which is what the editor is being tested on here.
    sections: [ section('contact', BLOCKS.contact, 'contact-main') ],
  });

  await upsertPage(existing, {
    title: 'Autumn offer',
    status: 'draft',
    sections: [
      section('hero', BLOCKS.offerHero, 'offer-hero'),
      section('cta', BLOCKS.cta, 'offer-cta'),
    ],
  });

  const after = await plugin('/pages');
  const rows = Array.isArray(after?.pages) ? after.pages : [];
  console.log(`\n[seed] the site now lists ${rows.length} pages:`);
  for (const p of rows) {
    console.log(`  #${String(p.page_id).padStart(4)}  ${p.status.padEnd(8)} ${p.ia_managed ? 'editable' : 'custom  '} ` +
                `${p.editable_section_count}/${p.section_count} sections  ${p.title}`);
  }
  console.log('\n[seed] done');
  process.exit(0);
})().catch((err) => {
  console.error('\n[seed] FAILED:', err.message);
  process.exit(1);
});
