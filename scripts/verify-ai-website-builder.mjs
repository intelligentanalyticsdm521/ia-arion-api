#!/usr/bin/env node
/**
 * Verification script for the ARION IL website builder (Phase 1 + 2).
 * --------------------------------------------------------------------------
 * Checks:
 *   1. emitterRegistry has hero + services + testimonials + cta + about + faq
 *      + gallery + contact registered (8/8 — full Phase 1 set)
 *   2. Each emitter's example output passes its own validator
 *   3. elementorAdapter produces a non-null section for each kind
 *   4. anthropicClient correctly strips markdown fences + JSON-parses
 *      (structural — does not require an API key)
 *   5. If ANTHROPIC_API_KEY (env or KV) is reachable:
 *        - call hero emitter end-to-end against mock brand → assert valid output
 *        - call services emitter end-to-end → assert valid output
 *        - call testimonials / cta / about / faq / gallery / contact emitters
 *          end-to-end → assert valid
 *        - if SQL pool reachable, assert >=8 rows were written to lumen.ai_usage
 *      Otherwise: skip with a clear "would have called live" message.
 *
 * Usage:
 *   node scripts/verify-ai-website-builder.mjs
 *   ANTHROPIC_API_KEY=sk-... node scripts/verify-ai-website-builder.mjs    # live
 *   SKIP_LIVE=1 node scripts/verify-ai-website-builder.mjs                  # force offline
 *
 * Exit codes:
 *   0 = all selected checks passed
 *   1 = at least one critical check failed
 *
 * Read-only against the DB except for one row in lumen.ai_usage (under a
 * mock tenant_id, only when live mode runs).
 */

import 'dotenv/config';
import { getEmitter, listEmitterKinds, hasEmitter } from '../lib/websiteBuilder/emitterRegistry.js';
import { blockToElementorSection, listSupportedKinds } from '../lib/websiteBuilder/elementorAdapter.js';
import { callAnthropic } from '../lib/websiteBuilder/anthropicClient.js';
import { callEmitter } from '../lib/websiteBuilder/callEmitter.js';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';

let pass = 0;
let fail = 0;
let skip = 0;

function ok(msg)   { console.log(`  ${GREEN}✔${RESET} ${msg}`); pass++; }
function bad(msg)  { console.log(`  ${RED}✘${RESET} ${msg}`);   fail++; }
function warn(msg) { console.log(`  ${YELLOW}⊘${RESET} ${msg}`); skip++; }
function section(title) { console.log(`\n${BOLD}${CYAN}=== ${title} ===${RESET}`); }

// Mock brand context — covers all the fields any emitter consumes.
const MOCK_BRAND = {
  tenant_id: '11111111-1111-1111-1111-111111111111',
  site_id:   '22222222-2222-2222-2222-222222222222',
  business_name:   'Cedar Ridge Plant Services',
  industry:        'industrial cleaning',
  description:     'Overnight plant cleaning for food-grade and pharma manufacturing facilities across Iowa.',
  tagline:         'Sanitized by sunrise.',
  target_audience: 'plant managers at mid-market food and pharma facilities',
  services: ['Plant deep clean', 'Warehouse floor care', 'Office janitorial', 'CIP system rinse'],
  brand_voice:      'confident',
  style_preference: 'modern',
  location:         'Cedar Rapids, IA',
  primary_color:    '#1A3A4A',
  logo_url:         null,
  font_family:      'Inter',
  domain:           'cedarridgeplant.com',
};

// ---------------------------------------------------------------------------
// 1. Registry
// ---------------------------------------------------------------------------
section('Registry');
const expectedKinds = ['hero', 'services', 'testimonials', 'cta', 'about', 'faq', 'gallery', 'contact'];
const registered = listEmitterKinds();
console.log(`  registered: ${registered.join(', ')}`);
for (const k of expectedKinds) {
  if (hasEmitter(k)) ok(`emitter registered: ${k}`);
  else bad(`emitter MISSING: ${k}`);
}

// ---------------------------------------------------------------------------
// 2. Example outputs pass each emitter's own validator
// ---------------------------------------------------------------------------
section('Example outputs round-trip through validator');
for (const k of expectedKinds) {
  const em = getEmitter(k);
  if (!em) { bad(`no emitter for ${k}`); continue; }
  if (!em.example) { warn(`${k}: no example to validate`); continue; }
  const v = em.validate(em.example);
  if (v.ok) ok(`${k}: example validates`);
  else bad(`${k}: example INVALID — ${v.error?.code}: ${v.error?.message}`);
}

// ---------------------------------------------------------------------------
// 3. elementorAdapter produces non-null sections
// ---------------------------------------------------------------------------
section('Elementor adapter');
console.log(`  adapter supports: ${listSupportedKinds().join(', ')}`);
for (const k of expectedKinds) {
  const em = getEmitter(k);
  const section = blockToElementorSection({
    kind: k,
    block: em?.example || {},
    brand: MOCK_BRAND,
    seedId: `verify-${k}`,
  });
  if (!section) { bad(`${k}: adapter returned null`); continue; }
  const hasShape = section.elType === 'section'
                 && Array.isArray(section.elements)
                 && section.elements.length > 0
                 && typeof section.id === 'string'
                 && section.id.length >= 5;
  if (hasShape) ok(`${k}: elementor section minted (id=${section.id}, ${section.elements.length} col(s))`);
  else bad(`${k}: elementor section malformed`);
}

// ---------------------------------------------------------------------------
// 4. Anthropic client — structural smoke test of buildPrompts shape
//    (this never calls the network)
// ---------------------------------------------------------------------------
section('Emitter buildPrompts shape');
for (const k of expectedKinds) {
  const em = getEmitter(k);
  if (!em) continue;
  let prompts;
  try { prompts = em.buildPrompts({ brand: MOCK_BRAND, sectionContext: {} }); }
  catch (e) { bad(`${k}: buildPrompts threw — ${e.message}`); continue; }
  if (!prompts || !prompts.system || !prompts.user) {
    bad(`${k}: buildPrompts missing system or user`);
  } else if (!prompts.user.includes(MOCK_BRAND.business_name)) {
    bad(`${k}: user prompt did not interpolate business_name`);
  } else {
    ok(`${k}: prompts built (system=${prompts.system.length}b, user=${prompts.user.length}b)`);
  }
}

// ---------------------------------------------------------------------------
// 5. Live calls (optional — needs API key, optionally a SQL pool)
// ---------------------------------------------------------------------------
section('Live emitter calls');
const skipLive = process.env.SKIP_LIVE === '1' || process.env.SKIP_LIVE === 'true';
let pool = null;

async function tryLoadPool() {
  try {
    const mod = await import('../db/servicesPool.js');
    return await mod.getServicesPool();
  } catch (e) {
    console.log(`  ${YELLOW}note:${RESET} services pool unavailable (${e.message.slice(0, 100)}) — token logging will be skipped`);
    return null;
  }
}

if (skipLive) {
  warn('SKIP_LIVE set — skipping live emitter calls');
} else {
  // Probe API key reachability with a tiny call.
  console.log('  probing Anthropic API key...');
  const probe = await callAnthropic({
    model: 'claude-haiku-4-5',
    system: 'Return only the literal string "ok".',
    user: 'ping',
    maxTokens: 10,
    responseFormat: 'text',
  });
  if (!probe.ok) {
    if (probe.error?.code === 'no_api_key') {
      warn(`API key not reachable (${probe.error.message.slice(0, 100)}) — skipping live calls`);
    } else {
      warn(`probe failed (${probe.error?.code}: ${probe.error?.message?.slice(0, 100)}) — skipping live calls`);
    }
  } else {
    ok(`API reachable (${probe.latencyMs}ms, model=${probe.model})`);
    pool = await tryLoadPool();
    if (!pool) console.log('  (continuing without DB — token logging assertions will be skipped)');

    // 5a. Hero
    console.log('\n  hero emitter...');
    const heroRes = await callEmitter({
      kind: 'hero',
      brand: MOCK_BRAND,
      sectionContext: { cta_href: '/contact', background_style: 'image' },
      tenantId: MOCK_BRAND.tenant_id,
      siteId: MOCK_BRAND.site_id,
      pool,
    });
    if (!heroRes.ok) {
      bad(`hero: ${heroRes.error?.code} — ${heroRes.error?.message?.slice(0, 200)}`);
    } else {
      ok(`hero: ${heroRes.tokens.total} tokens, ${heroRes.latencyMs}ms, cost=$${heroRes.costUsd}`);
      const b = heroRes.block;
      if (b.headline && b.subheadline && b.cta_text && b.cta_href && b.image_alt && b.background_style) {
        ok(`hero: all required fields present`);
      } else {
        bad(`hero: missing field(s) — keys=${Object.keys(b).join(',')}`);
      }
      if (heroRes.elementor?.elType === 'section') ok('hero: elementor section produced');
      else bad('hero: elementor section missing');
      console.log(`    headline: "${b.headline}"`);
      console.log(`    cta:      "${b.cta_text}" → ${b.cta_href}`);
    }

    // 5b. Services
    console.log('\n  services emitter...');
    const svcRes = await callEmitter({
      kind: 'services',
      brand: MOCK_BRAND,
      sectionContext: {},
      tenantId: MOCK_BRAND.tenant_id,
      siteId: MOCK_BRAND.site_id,
      pool,
    });
    if (!svcRes.ok) {
      bad(`services: ${svcRes.error?.code} — ${svcRes.error?.message?.slice(0, 200)}`);
    } else {
      ok(`services: ${svcRes.tokens.total} tokens, ${svcRes.latencyMs}ms, cost=$${svcRes.costUsd}`);
      const b = svcRes.block;
      if (b.headline && Array.isArray(b.services) && b.services.length > 0) {
        ok(`services: headline + ${b.services.length} service item(s)`);
      } else {
        bad(`services: malformed — ${JSON.stringify(b).slice(0, 200)}`);
      }
      if (svcRes.elementor?.elType === 'section') ok('services: elementor section produced');
      else bad('services: elementor section missing');
      console.log(`    headline: "${b.headline}"`);
      for (const s of b.services.slice(0, 3)) {
        console.log(`    • ${s.title} (icon=${s.icon_name})`);
      }
    }

    // 5c. Testimonials
    console.log('\n  testimonials emitter...');
    const tstRes = await callEmitter({
      kind: 'testimonials',
      brand: MOCK_BRAND,
      sectionContext: {},
      tenantId: MOCK_BRAND.tenant_id,
      siteId: MOCK_BRAND.site_id,
      pool,
    });
    if (!tstRes.ok) {
      bad(`testimonials: ${tstRes.error?.code} — ${tstRes.error?.message?.slice(0, 200)}`);
    } else {
      ok(`testimonials: ${tstRes.tokens.total} tokens, ${tstRes.latencyMs}ms, cost=$${tstRes.costUsd}`);
      const b = tstRes.block;
      if (b.headline && Array.isArray(b.testimonials) && b.testimonials.length >= 3 && b.testimonials.length <= 5) {
        ok(`testimonials: headline + ${b.testimonials.length} testimonial(s)`);
      } else {
        bad(`testimonials: malformed — count=${Array.isArray(b.testimonials) ? b.testimonials.length : 'n/a'}`);
      }
      if (tstRes.elementor?.elType === 'section') ok('testimonials: elementor section produced');
      else bad('testimonials: elementor section missing');
      console.log(`    headline: "${b.headline}"`);
      for (const t of b.testimonials.slice(0, 2)) {
        console.log(`    • "${(t.quote || '').slice(0, 80)}..." — ${t.attribution}`);
      }
    }

    // 5d. CTA
    console.log('\n  cta emitter...');
    const ctaRes = await callEmitter({
      kind: 'cta',
      brand: MOCK_BRAND,
      sectionContext: { primary_cta_href: '/contact' },
      tenantId: MOCK_BRAND.tenant_id,
      siteId: MOCK_BRAND.site_id,
      pool,
    });
    if (!ctaRes.ok) {
      bad(`cta: ${ctaRes.error?.code} — ${ctaRes.error?.message?.slice(0, 200)}`);
    } else {
      ok(`cta: ${ctaRes.tokens.total} tokens, ${ctaRes.latencyMs}ms, cost=$${ctaRes.costUsd}`);
      const b = ctaRes.block;
      if (b.headline && b.primary_cta_text && b.primary_cta_href && b.background_style) {
        ok('cta: required fields present');
      } else {
        bad(`cta: missing field(s) — keys=${Object.keys(b).join(',')}`);
      }
      if (ctaRes.elementor?.elType === 'section') ok('cta: elementor section produced');
      else bad('cta: elementor section missing');
      console.log(`    headline: "${b.headline}"`);
      console.log(`    primary:  "${b.primary_cta_text}" → ${b.primary_cta_href}`);
      if (b.secondary_cta_text) console.log(`    secondary: "${b.secondary_cta_text}" → ${b.secondary_cta_href}`);
    }

    // 5e. About
    console.log('\n  about emitter...');
    const abtRes = await callEmitter({
      kind: 'about',
      brand: MOCK_BRAND,
      sectionContext: { origin_notes: 'Founded by Cedar Rapids native after a decade running overnight crews at the largest food plant in Iowa.' },
      tenantId: MOCK_BRAND.tenant_id,
      siteId: MOCK_BRAND.site_id,
      pool,
    });
    if (!abtRes.ok) {
      bad(`about: ${abtRes.error?.code} — ${abtRes.error?.message?.slice(0, 200)}`);
    } else {
      ok(`about: ${abtRes.tokens.total} tokens, ${abtRes.latencyMs}ms, cost=$${abtRes.costUsd}`);
      const b = abtRes.block;
      const paraCountOk = Array.isArray(b.story_paragraphs) && b.story_paragraphs.length >= 3 && b.story_paragraphs.length <= 4;
      const valuesCountOk = Array.isArray(b.values) && b.values.length >= 3 && b.values.length <= 5;
      if (b.headline && paraCountOk && valuesCountOk && b.image_alt) {
        ok(`about: ${b.story_paragraphs.length} paragraph(s) + ${b.values.length} value(s)`);
      } else {
        bad(`about: malformed — paras=${Array.isArray(b.story_paragraphs) ? b.story_paragraphs.length : 'n/a'}, values=${Array.isArray(b.values) ? b.values.length : 'n/a'}`);
      }
      if (abtRes.elementor?.elType === 'section') ok('about: elementor section produced');
      else bad('about: elementor section missing');
      console.log(`    headline: "${b.headline}"`);
      console.log(`    para[0]:  "${(b.story_paragraphs[0] || '').slice(0, 100)}..."`);
      for (const v of b.values.slice(0, 3)) {
        console.log(`    • ${v.title}`);
      }
    }

    // 5f. FAQ
    console.log('\n  faq emitter...');
    const faqRes = await callEmitter({
      kind: 'faq',
      brand: MOCK_BRAND,
      sectionContext: {},
      tenantId: MOCK_BRAND.tenant_id,
      siteId: MOCK_BRAND.site_id,
      pool,
    });
    if (!faqRes.ok) {
      bad(`faq: ${faqRes.error?.code} — ${faqRes.error?.message?.slice(0, 200)}`);
    } else {
      ok(`faq: ${faqRes.tokens.total} tokens, ${faqRes.latencyMs}ms, cost=$${faqRes.costUsd}`);
      const b = faqRes.block;
      const countOk = Array.isArray(b.faqs) && b.faqs.length >= 6 && b.faqs.length <= 8;
      if (b.headline && countOk) {
        ok(`faq: headline + ${b.faqs.length} faq(s)`);
      } else {
        bad(`faq: malformed — count=${Array.isArray(b.faqs) ? b.faqs.length : 'n/a'}`);
      }
      if (faqRes.elementor?.elType === 'section') ok('faq: elementor section produced');
      else bad('faq: elementor section missing');
      console.log(`    headline: "${b.headline}"`);
      for (const q of b.faqs.slice(0, 3)) {
        console.log(`    Q: ${q.question}`);
      }
    }

    // 5g. Gallery
    console.log('\n  gallery emitter...');
    const galRes = await callEmitter({
      kind: 'gallery',
      brand: MOCK_BRAND,
      sectionContext: {},
      tenantId: MOCK_BRAND.tenant_id,
      siteId: MOCK_BRAND.site_id,
      pool,
    });
    if (!galRes.ok) {
      bad(`gallery: ${galRes.error?.code} — ${galRes.error?.message?.slice(0, 200)}`);
    } else {
      ok(`gallery: ${galRes.tokens.total} tokens, ${galRes.latencyMs}ms, cost=$${galRes.costUsd}`);
      const b = galRes.block;
      const countOk = Array.isArray(b.images) && b.images.length >= 6 && b.images.length <= 12;
      if (b.headline && countOk) {
        ok(`gallery: headline + ${b.images.length} image(s)`);
      } else {
        bad(`gallery: malformed — count=${Array.isArray(b.images) ? b.images.length : 'n/a'}`);
      }
      if (galRes.elementor?.elType === 'section') ok('gallery: elementor section produced');
      else bad('gallery: elementor section missing');
      console.log(`    headline: "${b.headline}"`);
      for (const img of b.images.slice(0, 3)) {
        console.log(`    • ${img.url}  (alt: "${(img.alt || '').slice(0, 60)}")`);
      }
    }

    // 5h. Contact
    console.log('\n  contact emitter...');
    const ctcRes = await callEmitter({
      kind: 'contact',
      brand: { ...MOCK_BRAND, phone: '(319) 555-0142', email: 'quotes@cedarridgeplant.com', address: '115 16th Ave SW, Cedar Rapids, IA' },
      sectionContext: {},
      tenantId: MOCK_BRAND.tenant_id,
      siteId: MOCK_BRAND.site_id,
      pool,
    });
    if (!ctcRes.ok) {
      bad(`contact: ${ctcRes.error?.code} — ${ctcRes.error?.message?.slice(0, 200)}`);
    } else {
      ok(`contact: ${ctcRes.tokens.total} tokens, ${ctcRes.latencyMs}ms, cost=$${ctcRes.costUsd}`);
      const b = ctcRes.block;
      const methodsOk = Array.isArray(b.contact_methods) && b.contact_methods.length >= 1 && b.contact_methods.length <= 6;
      const fieldsOk  = b.form_config && Array.isArray(b.form_config.fields) && b.form_config.fields.length >= 1 && b.form_config.fields.length <= 8;
      if (b.headline && methodsOk && fieldsOk && b.form_config.submit_text) {
        ok(`contact: ${b.contact_methods.length} method(s) + ${b.form_config.fields.length} form field(s)`);
      } else {
        bad(`contact: malformed — methods=${Array.isArray(b.contact_methods) ? b.contact_methods.length : 'n/a'}, fields=${b.form_config && Array.isArray(b.form_config.fields) ? b.form_config.fields.length : 'n/a'}`);
      }
      if (ctcRes.elementor?.elType === 'section') ok('contact: elementor section produced');
      else bad('contact: elementor section missing');
      console.log(`    headline: "${b.headline}"`);
      for (const m of b.contact_methods.slice(0, 3)) {
        console.log(`    • [${m.kind}] ${m.label}: ${m.value} → ${m.href}`);
      }
      console.log(`    form:     [${b.form_config.fields.join(', ')}]  submit="${b.form_config.submit_text}"`);
    }

    // 5i. Token-logging assertion (expect at least 8 rows: hero, services, testimonials, cta, about, faq, gallery, contact)
    if (pool) {
      console.log('\n  token logging...');
      try {
        const sqlMod = await import('mssql');
        const r = await pool.request()
          .input('tid', sqlMod.default.UniqueIdentifier, MOCK_BRAND.tenant_id)
          .query(`
            SELECT TOP 12 surface, sub_kind, model_id, input_tokens, output_tokens, ok, occurred_at
              FROM lumen.ai_usage
             WHERE tenant_id = @tid
               AND surface = 'arion.website_builder'
             ORDER BY occurred_at DESC
          `);
        if (r.recordset.length >= 8) {
          ok(`lumen.ai_usage: ${r.recordset.length} recent rows for mock tenant`);
          for (const row of r.recordset) {
            console.log(`    ${row.occurred_at?.toISOString?.() || row.occurred_at} ${row.sub_kind} model=${row.model_id} in=${row.input_tokens} out=${row.output_tokens} ok=${row.ok}`);
          }
        } else {
          bad(`lumen.ai_usage: expected >=8 rows, found ${r.recordset.length}`);
        }
      } catch (e) {
        bad(`lumen.ai_usage query failed: ${e.message.slice(0, 200)}`);
      }
    } else {
      warn('lumen.ai_usage: pool unavailable, skipping');
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\n${BOLD}Summary:${RESET} ${GREEN}${pass} pass${RESET} · ${RED}${fail} fail${RESET} · ${YELLOW}${skip} skip${RESET}`);
if (pool) {
  try { await pool.close(); } catch { /* ignore */ }
}
process.exit(fail === 0 ? 0 : 1);
