/**
 * AI image generation for the customer-onboarding website builder.
 * --------------------------------------------------------------------------
 * Generates a small set of on-brand photorealistic images (hero, about,
 * service tiles, CTA background) via OpenAI `gpt-image-1` and uploads them
 * into the new WordPress site's media library. Returns a bundle of
 * { url, alt } records the AI WB emitters embed into Elementor sections.
 *
 * Pairs with:
 *   - lib/aiCopy.js                — brand copy (text)
 *   - lib/websiteBuilder/*Emitter  — Elementor section emitters that read
 *                                    these image URLs and weave them in
 *   - routes/onboarding/submit.js  — calls us during the `generating_copy`
 *                                    phase, alongside generateSiteCopy()
 *
 * Soft-failure model: a missing OPENAI key is a HARD throw (caller decides
 * whether the phase fails or proceeds image-less). A single per-image
 * failure (network blip, content-policy refusal, upload error) is logged
 * and that slot returns `null` — never blocks the rest of the bundle.
 *
 * Upload strategy: prefer wp-cli over SSH (already used everywhere else in
 * onboarding — same auth, same host, atomic). If SSH is down OR the wp
 * exec returns non-zero, fall back to the IA Plugin REST endpoint
 * `/wp-json/wp/v2/media` (admin context via the freshly-minted provision
 * code → application password handshake the plugin already supports).
 *
 * Cost logging: every successful generation writes one row to
 * `lumen.ai_usage` mirroring callEmitter.js — `surface='arion.website_builder'`,
 * `sub_kind='image:<slot>'`, `provider='openai'`, `model_id='gpt-image-1'`.
 * Token counts on image models are null; we record an estimated `cost_usd`
 * per OpenAI's gpt-image-1 published pricing (Jun 2026):
 *   - 1024x1024 standard ≈ $0.040
 *   - 1536x1024 / 1024x1536 standard ≈ $0.060
 * Pricing constants live at the top of the file — update them in one place
 * if OpenAI changes its rate card.
 */

import sql from 'mssql';
import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';

import { runWpCli, runSshCommand, uploadFileViaSftp } from './hostingerSsh.js';
// The ONE answer to what this business is called (D-48, SEAM-10-A). The prompt
// plan used to read `answers.businessName` off the onboarding questionnaire,
// which on the dev database held another business's fixture entirely.
import { resolveBusinessName, promptName } from './businessName.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const KV_URI = process.env.KEY_VAULT_URI || 'https://kv-iadm-prod.vault.azure.net/';
const OPENAI_URL = 'https://api.openai.com/v1/images/generations';
const OPENAI_MODEL = 'gpt-image-1';
const SURFACE = 'arion.website_builder';

// gpt-image-1 published rate card (USD per image, standard quality, Jun 2026).
// Update here if OpenAI revises. We log this as cost_usd in lumen.ai_usage.
const COST_PER_IMAGE_USD = {
  '1024x1024': 0.040,
  '1024x1536': 0.060,
  '1536x1024': 0.060,
};

// Per-image generation timeout. gpt-image-1 is slow (15-60s typical).
const GEN_TIMEOUT_MS = 120_000;

// ─── Key Vault helpers ──────────────────────────────────────────────────────

let _kv = null;
function kv() {
  if (!_kv) _kv = new SecretClient(KV_URI, new DefaultAzureCredential());
  return _kv;
}

let _openaiKeyCache = null;
async function getOpenAiKey() {
  if (_openaiKeyCache) return _openaiKeyCache;
  const env = process.env.OPENAI_API_KEY;
  if (env) { _openaiKeyCache = env; return env; }
  try {
    const secret = await kv().getSecret('OPENAI-API-KEY');
    _openaiKeyCache = secret.value;
    return _openaiKeyCache;
  } catch (e) {
    throw new Error(`imageGen: OPENAI-API-KEY not available (env + KV both empty): ${e?.message?.slice(0, 200)}`);
  }
}

let _openaiOrgCache = null;
async function getOpenAiOrg() {
  if (_openaiOrgCache !== null) return _openaiOrgCache;
  const env = process.env.OPENAI_ORG_ID;
  if (env) { _openaiOrgCache = env; return env; }
  try {
    const secret = await kv().getSecret('OPENAI-ORG-ID');
    _openaiOrgCache = secret.value || '';
  } catch {
    // Org header is optional — KV miss is fine.
    _openaiOrgCache = '';
  }
  return _openaiOrgCache;
}

// ─── ai_usage logging (mirror callEmitter.js) ───────────────────────────────

async function logUsage(pool, {
  tenantId, subKind, size, latencyMs, costUsd, ok, errorCode, meta,
}) {
  if (!pool || !tenantId) return;
  try {
    await pool.request()
      .input('tenant_id',     sql.UniqueIdentifier, tenantId)
      .input('surface',       sql.NVarChar(50),     SURFACE)
      .input('sub_kind',      sql.NVarChar(50),     subKind || null)
      .input('provider',      sql.NVarChar(32),     'openai')
      .input('model_id',      sql.NVarChar(64),     OPENAI_MODEL)
      .input('input_tokens',  sql.Int,              null)
      .input('output_tokens', sql.Int,              null)
      .input('latency_ms',    sql.Int,              latencyMs || null)
      .input('cost_usd',      sql.Decimal(10, 4),   costUsd == null ? null : Number(costUsd))
      .input('ok',            sql.Bit,              ok ? 1 : 0)
      .input('error_code',    sql.NVarChar(64),     errorCode || null)
      .input('meta_json',     sql.NVarChar(sql.MAX),
        JSON.stringify({ size: size || null, ...(meta || {}) }))
      .query(`
        INSERT INTO lumen.ai_usage
          (tenant_id, surface, sub_kind, provider, model_id,
           input_tokens, output_tokens, latency_ms, cost_usd,
           ok, error_code, meta_json)
        VALUES
          (@tenant_id, @surface, @sub_kind, @provider, @model_id,
           @input_tokens, @output_tokens, @latency_ms, @cost_usd,
           @ok, @error_code, @meta_json)
      `);
  } catch (e) {
    console.warn(`[imageGen:logUsage] insert failed (non-fatal): ${e?.message?.slice(0, 200)}`);
  }
}

// ─── Prompt builder ─────────────────────────────────────────────────────────

/**
 * Compose the set of (slot, prompt, size) tuples we'll generate.
 * Slot count is bounded: hero + about + cta + up to 3 service tiles = max 6.
 * Tasteful defaults so a bare questionnaire still produces a real bundle.
 */
function buildPromptPlan({ answers, brandColors, businessName: resolvedName }) {
  // The name is RESOLVED BY THE CALLER from the one business identity and
  // passed in (D-48, SEAM-10-A); `answers.businessName` is not read here any
  // more. A business with no recorded name gets the neutral noun phrase, which
  // is a phrase inside a prompt and is never rendered anywhere.
  const businessName  = String(resolvedName || '').trim() || 'this business';
  const industry      = answers.industry      || 'small business';
  const audience      = answers.targetAudience || 'local customers';
  const brandVoice    = answers.brandVoice    || 'professional';
  const stylePref     = answers.stylePreference || 'modern';
  const location      = answers.location      || '';
  const services      = Array.isArray(answers.services) ? answers.services : [];

  const primary   = brandColors?.primary   || '';
  const secondary = brandColors?.secondary || '';
  const accent    = brandColors?.accent    || '';

  const palette = [primary, secondary, accent].filter(Boolean).join(', ');
  const paletteNote = palette
    ? `Photographic lighting and props should complement a brand palette of ${palette} (use as subtle accents — never as a solid color wash or text overlay).`
    : '';
  const locationNote = location ? ` Setting evokes ${location} subtly.` : '';

  const sharedStyleSuffix = `Photorealistic, ${stylePref}, ${brandVoice} tone. Natural lighting, sharp focus, professional composition. No text, no logos, no watermarks, no overlaid words.${locationNote} ${paletteNote}`.trim();

  const plan = [];

  plan.push({
    slot: 'hero',
    size: '1536x1024',
    altSeed: `${businessName} hero image`,
    prompt: `A wide-angle photorealistic hero image for ${businessName}, a ${industry} business serving ${audience}. The image should convey trust, quality, and the day-to-day work of this kind of business — show people, environment, or product naturally in context (not a stock pose). 16:9 cinematic framing. ${sharedStyleSuffix}`,
  });

  plan.push({
    slot: 'about',
    size: '1024x1024',
    altSeed: `About ${businessName}`,
    prompt: `A photorealistic square image representing the story and team behind ${businessName} (a ${industry} business). Warm, human, candid moment — a craftsperson at work, a small team collaborating, or a thoughtful detail of the trade. ${sharedStyleSuffix}`,
  });

  // Up to 3 service tiles — one per top service from the questionnaire.
  const topServices = services.slice(0, 3);
  for (const svc of topServices) {
    plan.push({
      slot: `service:${svc}`,
      size: '1024x1024',
      altSeed: `${svc} — ${businessName}`,
      prompt: `A photorealistic square image illustrating the service "${svc}" offered by ${businessName} (${industry}). Show the service being delivered or its outcome in a realistic, on-location setting. Editorial photography style. ${sharedStyleSuffix}`,
    });
  }

  plan.push({
    slot: 'cta',
    size: '1536x1024',
    altSeed: `Get in touch with ${businessName}`,
    prompt: `A wide photorealistic background image suitable for a call-to-action band on a ${industry} website — abstract enough to overlay white text on, but concretely evocative of the business (e.g. a soft-focus workspace, a welcoming storefront, calm hands-on detail). Low contrast, ample negative space in the upper-right third. 16:9 framing. ${sharedStyleSuffix}`,
  });

  return plan;
}

// ─── OpenAI call ────────────────────────────────────────────────────────────

/**
 * Internal: generate one image. Returns { buffer, mime } or throws.
 *
 * @param {string} prompt
 * @param {{ size?: string }} [opts]
 */
async function generateOne(prompt, opts = {}) {
  const size = opts.size || '1024x1024';
  const apiKey = await getOpenAiKey();
  const org = await getOpenAiOrg();

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
  if (org) headers['OpenAI-Organization'] = org;

  const res = await globalThis.fetch(OPENAI_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: OPENAI_MODEL,
      prompt,
      size,
      n: 1,
    }),
    signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OpenAI HTTP ${res.status}: ${txt.slice(0, 400)}`);
  }
  const body = await res.json();
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) {
    // gpt-image-1 always returns b64_json by default; a url field would mean
    // older dall-e behavior — surface clearly so we update the parser.
    const url = body?.data?.[0]?.url;
    if (url) throw new Error(`OpenAI returned a URL instead of b64_json — unsupported by this code path: ${url.slice(0, 200)}`);
    throw new Error(`OpenAI response missing image data: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return { buffer: Buffer.from(b64, 'base64'), mime: 'image/png' };
}

// ─── WordPress upload helpers ───────────────────────────────────────────────

/**
 * Upload a single image buffer into the target WP site's media library.
 * Primary path: SCP-style staging via SSH + `wp media import`. Fallback:
 * REST POST to the IA Plugin's media endpoint using the provision code as
 * an admin bearer.
 *
 * Returns the public URL of the uploaded attachment.
 */
async function uploadToWordPress({ domain, buffer, filename, alt, provisionCode }) {
  // ── Primary: SSH + wp-cli ────────────────────────────────────────────────
  const remoteTmp = `/tmp/iag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${filename}`;
  try {
    // Push the bytes via SFTP. (Previously we tried `echo <b64> | base64 -d`
    // over `conn.exec`, but the SSH exec packet is capped at ~32KB by default,
    // so any real gpt-image-1 PNG — ~1-3MB — silently dropped before
    // wp-cli could see it. SFTP streams the whole buffer cleanly on the same
    // ssh2 connection.)
    try {
      await uploadFileViaSftp(buffer, remoteTmp);
    } catch (e) {
      throw new Error(`sftp stage failed: ${e?.message?.slice(0, 200)}`);
    }

    // `wp media import` prints the new attachment ID with --porcelain.
    const altArg = alt ? ` --alt=${shellSingleQuote(alt)}` : '';
    const titleArg = alt ? ` --title=${shellSingleQuote(alt)}` : '';
    const importRes = await runWpCli(domain, `media import ${remoteTmp}${altArg}${titleArg} --porcelain`);
    const attId = (importRes.stdout || '').trim().split(/\s+/).pop();
    if (!attId || !/^\d+$/.test(attId)) {
      throw new Error(`wp media import returned no attachment id: ${importRes.stdout?.slice(0, 200)}`);
    }

    // Get the public URL.
    const urlRes = await runWpCli(domain, `eval ${shellSingleQuote(`echo wp_get_attachment_url(${attId});`)}`);
    const url = (urlRes.stdout || '').trim();
    if (!url) throw new Error(`wp eval returned no URL for attachment ${attId}`);

    return { url, attachmentId: Number(attId), source: 'wp-cli' };
  } catch (sshErr) {
    console.warn(`[imageGen] wp-cli upload failed for ${filename}: ${sshErr?.message?.slice(0, 200)} — trying REST fallback`);
    // ── Fallback: IA Plugin REST POST /wp-json/wp/v2/media ─────────────────
    if (!provisionCode) {
      throw new Error(`wp-cli upload failed and no provisionCode for REST fallback: ${sshErr.message}`);
    }
    return uploadViaPluginRest({ domain, buffer, filename, alt, provisionCode });
  } finally {
    // Best-effort: clean up the staged tmp file. Swallow any error.
    runSshCommand(`rm -f ${remoteTmp}`).catch(() => {});
  }
}

/**
 * REST fallback for media upload. The IA Plugin accepts a provision-code
 * bearer for admin-context calls during onboarding; we POST the raw image
 * bytes with the standard WP REST media headers.
 */
async function uploadViaPluginRest({ domain, buffer, filename, alt, provisionCode }) {
  const url = `https://${domain}/wp-json/wp/v2/media`;
  const res = await globalThis.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      'Content-Type': 'image/png',
      'Authorization': `Bearer ${provisionCode}`,
    },
    body: buffer,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`WP REST media POST ${res.status}: ${txt.slice(0, 300)}`);
  }
  const body = await res.json();
  const pubUrl = body?.source_url || body?.guid?.rendered;
  if (!pubUrl) throw new Error(`WP REST media POST returned no source_url: ${JSON.stringify(body).slice(0, 200)}`);

  // Patch alt-text if provided (separate endpoint per WP REST API).
  if (alt && body?.id) {
    try {
      await globalThis.fetch(`${url}/${body.id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${provisionCode}`,
        },
        body: JSON.stringify({ alt_text: alt, title: alt }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      console.warn(`[imageGen] alt-text patch failed (non-fatal): ${e?.message?.slice(0, 200)}`);
    }
  }

  return { url: pubUrl, attachmentId: body?.id || null, source: 'plugin-rest' };
}

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Generate the full site image bundle.
 *
 * @param {object} args
 * @param {object} args.answers           Questionnaire payload (same shape as aiCopy.js)
 * @param {object} [args.brandColors]     { primary, secondary, accent }
 * @param {string} args.domain            Target WP site domain (used for wp-cli + REST)
 * @param {string} [args.provisionCode]   IA Plugin provision code for REST fallback
 * @param {object} [args.pool]            mssql pool for ai_usage logging
 * @param {string} [args.tenantId]        UUID for ai_usage logging
 * @param {string} [args.siteId]          Logged in ai_usage meta
 *
 * @returns {Promise<{
 *   heroImage:           {url, alt}|null,
 *   aboutImage:          {url, alt}|null,
 *   servicesImages:      Array<{url, alt}|null>,
 *   ctaBackgroundImage:  {url, alt}|null,
 *   stats: { attempted: number, succeeded: number, failed: number },
 *   errors: Array<{slot: string, message: string}>
 * }>}
 */
export async function generateSiteImages({
  answers,
  brandColors,
  domain,
  provisionCode,
  pool,
  tenantId,
  siteId,
}) {
  if (!answers || typeof answers !== 'object') {
    throw new Error('imageGen.generateSiteImages: answers required');
  }
  if (!domain) {
    throw new Error('imageGen.generateSiteImages: domain required');
  }

  // Fail fast if no key — the caller (submit.js) decides whether to skip or
  // surface. Cheap to call: cached after first hit.
  await getOpenAiKey();

  const resolvedName = await resolveBusinessName(tenantId);
  const plan = buildPromptPlan({ answers, brandColors, businessName: promptName(resolvedName) });

  const bundle = {
    heroImage: null,
    aboutImage: null,
    servicesImages: [],
    ctaBackgroundImage: null,
    stats: { attempted: 0, succeeded: 0, failed: 0 },
    errors: [],
  };

  for (const item of plan) {
    bundle.stats.attempted++;
    const t0 = Date.now();
    const size = item.size;
    const subKind = `image:${item.slot.split(':')[0]}`; // 'image:hero', 'image:service', etc.

    try {
      const { buffer, mime } = await generateOne(item.prompt, { size });
      const ext = mime === 'image/png' ? 'png' : 'jpg';
      const safeSlot = item.slot.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
      const filename = `iag-${safeSlot}-${Date.now()}.${ext}`;

      const uploaded = await uploadToWordPress({
        domain,
        buffer,
        filename,
        alt: item.altSeed,
        provisionCode,
      });

      const latencyMs = Date.now() - t0;
      const costUsd = COST_PER_IMAGE_USD[size] ?? null;

      const record = { url: uploaded.url, alt: item.altSeed };
      assignSlot(bundle, item.slot, record);
      bundle.stats.succeeded++;

      await logUsage(pool, {
        tenantId,
        subKind,
        size,
        latencyMs,
        costUsd,
        ok: true,
        errorCode: null,
        meta: { site_id: siteId || null, slot: item.slot, source: uploaded.source, attachment_id: uploaded.attachmentId },
      });
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const msg = err?.message?.slice(0, 300) || 'unknown';
      console.warn(`[imageGen] slot=${item.slot} failed: ${msg}`);
      bundle.stats.failed++;
      bundle.errors.push({ slot: item.slot, message: msg });
      assignSlot(bundle, item.slot, null);

      await logUsage(pool, {
        tenantId,
        subKind,
        size,
        latencyMs,
        costUsd: null,
        ok: false,
        errorCode: classifyError(err),
        meta: { site_id: siteId || null, slot: item.slot, error: msg },
      });
    }
  }

  return bundle;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

function assignSlot(bundle, slot, record) {
  if (slot === 'hero') bundle.heroImage = record;
  else if (slot === 'about') bundle.aboutImage = record;
  else if (slot === 'cta') bundle.ctaBackgroundImage = record;
  else if (slot.startsWith('service:')) bundle.servicesImages.push(record);
}

function classifyError(err) {
  const m = (err?.message || '').toLowerCase();
  if (m.includes('content_policy') || m.includes('safety')) return 'content_policy';
  if (m.includes('rate limit') || m.includes('429')) return 'rate_limited';
  if (m.includes('timeout') || m.includes('aborted')) return 'timeout';
  if (m.includes('http 4')) return 'openai_4xx';
  if (m.includes('http 5')) return 'openai_5xx';
  if (m.includes('wp-cli') || m.includes('wp media') || m.includes('wp eval')) return 'wp_upload_failed';
  if (m.includes('wp rest') || m.includes('wp/v2/media')) return 'rest_upload_failed';
  return 'unknown';
}

/** Single-quote escape for shell args (mirrors hostingerSsh.js). */
function shellSingleQuote(s) {
  return `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;
}

// Exported for tests + the verifier script.
export { generateOne, buildPromptPlan, COST_PER_IMAGE_USD };

export default { generateSiteImages, generateOne, buildPromptPlan };
