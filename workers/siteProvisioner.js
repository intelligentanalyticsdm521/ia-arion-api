/**
 * Site Provisioner Worker
 * --------------------------------------------------------------------------
 * Headless Playwright worker that drives Hostinger's AI Website Builder UI on
 * a freshly-provisioned WordPress site, then hands control off to the IA
 * Plugin's bootstrap class via the `?ia_code=...` URL trigger.
 *
 * Architecture:
 *   - Express server on PROVISIONER_PORT (default 8080) — receives jobs.
 *   - POST /run { jobId, ... } returns 202 immediately and runs async.
 *   - Reports progress to arion-api via PROGRESS_CALLBACK_URL.
 *   - Designed to run in an Azure Container App (Playwright Docker image).
 *
 * Flow:
 *   0. Receive job: { tenantId, siteId, domain, wpAdminUrl, wpUser, wpPass,
 *                     prompt, brandName, language, provisionCode, websiteId }
 *   1. Login to wp-admin
 *   2. Navigate to AI Builder onboarding page
 *   3. Paste prompt, submit
 *   4. Confirm essentials (editor=Elementor, language, brand name)
 *   5. Skip Kodee follow-ups (Not now on colors/fonts/logo)
 *   6. Click "Continue to setup"
 *   7. Deploy IA Plugin via Hostinger API
 *   8. Visit wp-admin/admin.php?page=ia-settings&ia_code=PROVISION_CODE
 *      → triggers auto-redeem, which kicks off IA_Bootstrap
 *   9. Worker's job is done — Bootstrap handles the rest server-side
 *
 * Each step has a guarded selector strategy + retry. UI changes from Hostinger
 * are the main fragility risk; we log + screenshot on every failure so a
 * monitoring webhook can alert on broken automation.
 */

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const PORT = Number(process.env.PROVISIONER_PORT || 8080);
const HEADLESS = process.env.PROVISIONER_HEADFUL !== '1';
// Full URL for the worker → arion-api progress callback. Should point to the
// /provisioning/worker-progress endpoint. Example:
//   https://app-arion-api-prod-...azurewebsites.net/provisioning/worker-progress
const PROGRESS_CALLBACK_URL = process.env.PROVISIONER_CALLBACK_URL || '';
const SHARED_SECRET = process.env.PROVISIONER_SHARED_SECRET || '';

const app = express();
app.use(express.json({ limit: '4mb' }));

// Auth: shared secret in header (worker is internal, never user-facing).
function requireSecret(req, res, next) {
  if (!SHARED_SECRET) return next(); // dev mode
  if (req.headers['x-worker-secret'] !== SHARED_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'site-provisioner' }));

app.post('/run', requireSecret, async (req, res) => {
  const job = req.body || {};
  const required = ['jobId', 'siteId', 'tenantId', 'wpAdminUrl', 'wpUser', 'wpPass', 'prompt', 'brandName', 'provisionCode'];
  for (const k of required) {
    if (!job[k]) return res.status(400).json({ error: 'missing_field', field: k });
  }
  // Acknowledge immediately, run async
  res.status(202).json({ ok: true, jobId: job.jobId });
  runJob(job).catch((err) => {
    console.error('[provisioner] job failed:', job.jobId, err);
    reportProgress(job.jobId, 'failed', { error: err.message }).catch(() => {});
  });
});

app.listen(PORT, () => console.log(`site-provisioner listening on :${PORT}`));

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function runJob(job) {
  await reportProgress(job.jobId, 'started', {});

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 IADM-Provisioner',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);

  try {
    await reportProgress(job.jobId, 'wp_login', {});
    await wpLogin(page, job);

    await reportProgress(job.jobId, 'ai_builder_prompt', {});
    await driveAiBuilderPrompt(page, job);

    await reportProgress(job.jobId, 'ai_builder_confirm', {});
    await driveAiBuilderConfirm(page, job);

    await reportProgress(job.jobId, 'kodee_skip', {});
    await skipKodeeFollowups(page);

    await reportProgress(job.jobId, 'ai_builder_finalize', {});
    await finalizeAiBuilder(page);

    // F-onboarding-prep — remove Hostinger default plugins BEFORE installing
    // IA. Keeps the client's plugin list clean and avoids conflicts (e.g.
    // Hostinger AI Assistant overlay competing with IA's admin UI). Best-
    // effort: a single removal failure does NOT abort the job.
    await reportProgress(job.jobId, 'plugin_cleanup', {});
    try {
      const cleanup = await removeDefaultPlugins(page, job);
      await reportProgress(job.jobId, 'plugin_cleanup_result', cleanup);
    } catch (cleanupErr) {
      console.warn('[provisioner] removeDefaultPlugins crashed (continuing):', cleanupErr.message);
    }

    await reportProgress(job.jobId, 'plugin_deploy', {});
    await uploadPluginViaUi(page, job);

    await reportProgress(job.jobId, 'auto_redeem_trigger', {});
    await triggerAutoRedeem(page, job);

    // Worker's job is done. The IA Plugin's bootstrap class now takes over
    // server-side and reports `ready` via /provisioning/site-ready. We don't
    // emit a "completed" state from here — the status endpoint pulls final
    // success from arion.site.provisioning_state.
  } catch (err) {
    const screenshot = await page.screenshot({ type: 'png', fullPage: true }).catch(() => null);
    await reportProgress(job.jobId, 'failed', {
      error: err.message,
      step: err.step || 'unknown',
      screenshot_b64: screenshot ? screenshot.toString('base64').slice(0, 200_000) : null,
    });
    throw err;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Step handlers
// ---------------------------------------------------------------------------

/**
 * Authenticate to wp-admin using the credentials Hostinger created when the
 * WordPress site was provisioned via hosting_createWebsiteV1.
 */
async function wpLogin(page, job) {
  const loginUrl = job.wpAdminUrl.replace(/\/wp-admin\/?$/, '') + '/wp-login.php';
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await page.fill('#user_login', job.wpUser);
  await page.fill('#user_pass', job.wpPass);
  await Promise.all([
    page.waitForLoadState('domcontentloaded'),
    page.click('#wp-submit'),
  ]);
  // After login we should be on /wp-admin/
  if (!page.url().includes('/wp-admin/')) {
    const err = new Error('login_failed: unexpected URL after submit: ' + page.url());
    err.step = 'wp_login';
    throw err;
  }
}

/**
 * Navigate to the AI Builder onboarding page and submit the prompt.
 * URL pattern: /wp-admin/admin.php?page=hostinger-ai-website-creation&source=onboarding
 */
async function driveAiBuilderPrompt(page, job) {
  const url = job.wpAdminUrl.replace(/\/$/, '') + '/admin.php?page=hostinger-ai-website-creation&source=onboarding';
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // The textarea has no stable selector; we look for placeholder + max length
  const textarea = page.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 30_000 });
  await textarea.fill(job.prompt);

  // Submit — there's a circular arrow button at the bottom-right of the prompt box
  const submitBtn = page.locator('button[type="submit"], button:has(svg)').last();
  await submitBtn.click();

  // Page advances to /admin.php?...subPage=ai-website-creation-completion-new
  await page.waitForURL(/ai-website-creation/, { timeout: 60_000 });
}

/**
 * "Confirm the essentials" screen — Editor (Elementor), Language, Brand name.
 * Then click Continue.
 */
async function driveAiBuilderConfirm(page, job) {
  // Editor selector — defaults to Elementor; we just verify it's set
  const editorDropdown = page.getByLabel(/editor/i).or(page.locator('select').first());
  if (await editorDropdown.count() > 0) {
    try {
      await editorDropdown.selectOption({ label: 'Elementor' });
    } catch { /* may already be set */ }
  }

  // Site language — default English (UI language matches user locale, usually fine)
  if (job.language) {
    const langDropdown = page.getByLabel(/language/i);
    if (await langDropdown.count() > 0) {
      try {
        await langDropdown.selectOption({ label: job.language });
      } catch { /* leave default */ }
    }
  }

  // Brand name — required input
  const brandInput = page.getByPlaceholder(/brand name/i).or(page.getByLabel(/brand name/i)).first();
  await brandInput.waitFor({ state: 'visible', timeout: 15_000 });
  await brandInput.fill(job.brandName);

  // Continue button (text varies — "Continue" or arrow-only)
  const continueBtn = page.getByRole('button', { name: /continue/i }).first();
  await continueBtn.click();

  // Wait for the build/preview screen
  await page.waitForLoadState('networkidle', { timeout: 90_000 });
}

/**
 * Decline Kodee's follow-up questions about colors/fonts/logo so the worker
 * doesn't get stuck. We apply branding ourselves later via IA_Branding class.
 */
async function skipKodeeFollowups(page) {
  // The Kodee panel surfaces a "Not now" button after each prompt.
  // It may appear 0-3 times depending on what Kodee asks. Click whenever
  // visible until it disappears or 30s elapses.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const notNow = page.getByRole('button', { name: /not now/i }).first();
    if (await notNow.isVisible().catch(() => false)) {
      await notNow.click().catch(() => {});
      await page.waitForTimeout(2000);
      continue;
    }
    // Also dismiss "confirm" prompts by clicking the "Confirm" button that
    // pre-populates with our pre-supplied answer (pages list, brand, etc.)
    const confirmBtn = page.getByRole('button', { name: /^confirm$/i }).first();
    if (await confirmBtn.isVisible().catch(() => false)) {
      await confirmBtn.click().catch(() => {});
      await page.waitForTimeout(2000);
      continue;
    }
    break;
  }
}

/**
 * Click "Continue to setup" to finalize the AI build and land in WP admin.
 */
async function finalizeAiBuilder(page) {
  const finishBtn = page.getByRole('button', { name: /continue to setup|setup in wp admin/i }).first();
  await finishBtn.waitFor({ state: 'visible', timeout: 180_000 }); // AI generation can take 1-3min
  await Promise.all([
    page.waitForURL(/wp-admin\/?(\?|$)/, { timeout: 60_000 }),
    finishBtn.click(),
  ]);
}

/**
 * Upload the IA Plugin via wp-admin's Plugins → Add New → Upload UI.
 *
 * Hostinger doesn't expose a plugin-install API endpoint, so we use the
 * already-authenticated browser session to upload the .zip directly.
 *
 * Steps:
 *   1. Download the plugin archive from IA_PLUGIN_ARCHIVE_URL to a tempfile
 *   2. Navigate to /wp-admin/plugin-install.php?tab=upload
 *   3. setInputFiles() on the file input
 *   4. Click "Install Now"
 *   5. Wait for "Activate Plugin" link, click it
 */
/**
 * Remove Hostinger default plugins the client doesn't need.
 *
 * Why this exists: a fresh Hostinger WP install ships with several plugins
 * the founder considers bloat (per locked decision — see
 * reference_oliver_tier_matrix.md and 2026-06-12 onboarding requirement).
 * Removing them keeps the client's plugin list clean and avoids the IA
 * plugin sharing CSS/JS hooks with caching plugins that conflict.
 *
 * Configurable via env var IA_HOSTINGER_REMOVE_PLUGINS (comma-separated
 * plugin SLUGS — same string as in the wp-admin URL, e.g. "hostinger" or
 * "hostinger-easy-onboarding"). Default kill list below.
 *
 * NOT removed by default (the founder can extend the list if they want):
 *   - litespeed-cache : actively useful for caching; bloated only if unused
 *   - akismet         : WP-shipped anti-spam, security tool
 *
 * Each removal is best-effort. A missing plugin is skipped silently. A
 * single removal failure does NOT abort the whole provisioning job — the
 * worker logs the failure and continues so the client still gets the IA
 * plugin installed and the site usable.
 */
const DEFAULT_REMOVE_SLUGS = [
  'hostinger',                    // Hostinger Tools
  'hostinger-ai-assistant',       // Hostinger AI Assistant
  'hostinger-easy-onboarding',    // Hostinger Easy Onboarding wizard
  'hello-dolly',                  // WP default decorative plugin
];

async function removeDefaultPlugins(page, job) {
  const envList = (process.env.IA_HOSTINGER_REMOVE_PLUGINS || '').trim();
  const slugs = envList
    ? envList.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_REMOVE_SLUGS;

  if (!slugs.length) return { removed: [], skipped: [], failed: [] };

  const removed = [];
  const skipped = [];
  const failed = [];

  // Land on plugins.php once. WP-admin lists every plugin with both a
  // Deactivate link and (after deactivation) a Delete link — each carrying
  // its own CSRF nonce in the href.
  await page.goto(job.wpAdminUrl.replace(/\/$/, '') + '/plugins.php', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });

  for (const slug of slugs) {
    try {
      // WP renders each plugin row as <tr data-slug="<slug>"> on modern
      // versions, falling back to id="<slug>" on older themes. Match both.
      const rowSel = `tr[data-slug="${slug}"], tr#${slug}`;
      const row = page.locator(rowSel).first();
      if (!(await row.isVisible().catch(() => false))) {
        skipped.push({ slug, reason: 'not installed' });
        continue;
      }

      // 1. Deactivate (if active). Inactive plugins skip straight to delete.
      const deactivate = row.locator('a:has-text("Deactivate")').first();
      if (await deactivate.isVisible().catch(() => false)) {
        await deactivate.click();
        await page.waitForLoadState('domcontentloaded');
        // After reload the row may have moved — re-locate.
      }

      // 2. Delete. WP shows a confirm() JS dialog → accept it.
      page.once('dialog', async (d) => { await d.accept(); });
      const rowAfter = page.locator(rowSel).first();
      const del = rowAfter.locator('a:has-text("Delete")').first();
      if (!(await del.isVisible().catch(() => false))) {
        // Some Hostinger plugins are "must-use" or hidden from delete.
        failed.push({ slug, reason: 'no Delete link' });
        continue;
      }
      await del.click();
      await page.waitForLoadState('domcontentloaded');

      // 3. After delete WP either reloads the table or shows a success
      // message. Either way, verify the row is gone.
      const stillThere = await page.locator(rowSel).first().isVisible().catch(() => false);
      if (stillThere) {
        failed.push({ slug, reason: 'row still present after delete' });
      } else {
        removed.push(slug);
      }
    } catch (e) {
      console.warn(`[removeDefaultPlugins] ${slug} failed:`, e.message);
      failed.push({ slug, reason: e.message });
    }
  }

  return { removed, skipped, failed };
}

async function uploadPluginViaUi(page, job) {
  const archiveUrl = process.env.IA_PLUGIN_ARCHIVE_URL;
  if (!archiveUrl) {
    const err = new Error('IA_PLUGIN_ARCHIVE_URL not configured');
    err.step = 'plugin_deploy';
    throw err;
  }

  // Download to temp
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ia-plugin-'));
  const tmpPath = path.join(tmpDir, 'intelligent-analytics.zip');
  try {
    const dlRes = await fetch(archiveUrl, { signal: AbortSignal.timeout(60_000) });
    if (!dlRes.ok) throw new Error(`Plugin archive download failed: HTTP ${dlRes.status}`);
    const buf = Buffer.from(await dlRes.arrayBuffer());
    await fs.writeFile(tmpPath, buf);

    // Navigate to upload page
    const uploadUrl = job.wpAdminUrl.replace(/\/$/, '') + '/plugin-install.php?tab=upload';
    await page.goto(uploadUrl, { waitUntil: 'domcontentloaded' });

    // Set the file
    const fileInput = page.locator('input[type="file"][name="pluginzip"]');
    await fileInput.waitFor({ state: 'attached', timeout: 15_000 });
    await fileInput.setInputFiles(tmpPath);

    // Click Install Now
    const installBtn = page.locator('input[name="install-plugin-submit"], button:has-text("Install Now")').first();
    await installBtn.click();

    // Wait for the Activate link (or "plugin already exists" warning)
    const activateLink = page.locator('a:has-text("Activate Plugin"), a:has-text("Activate")').first();
    try {
      await activateLink.waitFor({ state: 'visible', timeout: 90_000 });
      await activateLink.click();
      // After activation we land on plugins list
      await page.waitForURL(/plugins\.php/, { timeout: 30_000 });
    } catch (waitErr) {
      // Could be "plugin destination already exists" (already installed) — try activating from plugins page instead
      await page.goto(job.wpAdminUrl.replace(/\/$/, '') + '/plugins.php', { waitUntil: 'domcontentloaded' });
      const activateInList = page.locator('tr[data-slug="intelligent-analytics"] a:has-text("Activate"), tr#intelligent-analytics a:has-text("Activate")').first();
      if (await activateInList.isVisible().catch(() => false)) {
        await activateInList.click();
        await page.waitForLoadState('domcontentloaded');
      }
      // If neither path worked, surface the error
      if (!page.url().includes('plugins.php')) {
        const err = new Error('Plugin upload completed but activation could not be confirmed: ' + waitErr.message);
        err.step = 'plugin_deploy';
        throw err;
      }
    }
  } finally {
    // Best-effort temp cleanup
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Visit wp-admin with ?ia_code=... to trigger the IA Plugin's auto-redeem.
 * The plugin's existing `maybe_auto_redeem_pending_code` handler picks up the
 * URL param, redeems against arion-api, stores site_token, then the
 * IA_Bootstrap class takes over on the next admin_init.
 */
async function triggerAutoRedeem(page, job) {
  const triggerUrl = job.wpAdminUrl.replace(/\/$/, '') +
    '/admin.php?page=ia-settings&ia_code=' + encodeURIComponent(job.provisionCode);
  await page.goto(triggerUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // Give the auto-redeem hook a moment to call arion-api
  await page.waitForTimeout(5000);
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

async function reportProgress(jobId, state, details) {
  if (!PROGRESS_CALLBACK_URL) return;
  try {
    await fetch(PROGRESS_CALLBACK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-worker-secret': SHARED_SECRET,
      },
      body: JSON.stringify({ jobId, state, details, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn('[provisioner] progress callback failed:', state, err.message);
  }
}
