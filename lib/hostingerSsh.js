/**
 * Hostinger SSH helper — runs wp-cli commands inside a client's WordPress
 * install over SSH using the master account's credentials.
 *
 * Used during onboarding (Step 4d in the working doc):
 *   1. Plain WordPress install via Hostinger API leaves us with a working WP
 *      but no Elementor, no IA plugin, no client user account.
 *   2. This helper finishes the job by running `wp` commands as the master
 *      Hostinger account user.
 *
 * Credentials come from Key Vault (`ARION-HOSTINGER-SSH-*`). The private key
 * stored in KV is a single-line OpenSSH key — we rebuild proper PEM line
 * breaks before handing to ssh2.
 *
 * Connection model: one Client per `runWpCli` call (connects, runs, disconnects).
 * Simple and reliable; the install flow only needs ~5 commands per site and
 * the connection cost (~150ms) is negligible vs the wp-cli execution time.
 */

import { Client } from 'ssh2';
import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';

const KV_URI = process.env.KEY_VAULT_URI || 'https://kv-iadm-prod.vault.azure.net/';
let secretClient = null;
function kv() {
  if (!secretClient) secretClient = new SecretClient(KV_URI, new DefaultAzureCredential());
  return secretClient;
}

// In-memory cache for connection credentials — they don't change often and
// pulling from Key Vault on every onboarding adds ~600ms per call.
let _credCache = null;
const CRED_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getSshCredentials() {
  if (_credCache && Date.now() - _credCache.ts < CRED_TTL_MS) return _credCache.value;

  const [hostS, portS, userS, keyS] = await Promise.all([
    kv().getSecret('ARION-HOSTINGER-SSH-HOST'),
    kv().getSecret('ARION-HOSTINGER-SSH-PORT'),
    kv().getSecret('ARION-HOSTINGER-SSH-USER'),
    kv().getSecret('ARION-HOSTINGER-SSH-PRIVATE-KEY-PEM'),
  ]);

  // The KV-stored key is a single-line string; ssh2 needs proper PEM line breaks.
  // OpenSSH format:
  //   -----BEGIN OPENSSH PRIVATE KEY-----
  //   <base64 lines>
  //   -----END OPENSSH PRIVATE KEY-----
  const privateKey = rehydratePem(keyS.value);

  const cred = {
    host: hostS.value,
    port: Number(portS.value),
    username: userS.value,
    privateKey,
    readyTimeout: 15_000,
  };
  _credCache = { value: cred, ts: Date.now() };
  return cred;
}

/**
 * Rebuild PEM newlines from a single-line OpenSSH key.
 * Handles both:
 *   "-----BEGIN ... ----- <base64 with spaces> -----END ... -----"
 *   "-----BEGIN ... -----\n<base64>\n-----END ... -----\n"  (already correct)
 */
function rehydratePem(raw) {
  if (!raw) throw new Error('hostingerSsh: empty private key');
  if (raw.includes('\n')) return raw; // already multi-line
  const match = raw.match(/-----BEGIN ([^-]+)----- (.+) -----END \1-----/);
  if (!match) throw new Error('hostingerSsh: unexpected key format');
  const header = match[1];
  const body = match[2].trim();
  const lines = body.split(/\s+/).filter(Boolean);
  return [
    `-----BEGIN ${header}-----`,
    ...lines,
    `-----END ${header}-----`,
    '',
  ].join('\n');
}

/**
 * Open an SSH connection, run a single command, return { stdout, stderr, code }.
 * Closes the connection when done.
 *
 * @param {string} command  - shell command to run on the remote host
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export async function runSshCommand(command) {
  const cred = await getSshCredentials();
  console.log(`[hostingerSsh] exec: ${command.slice(0, 200)}`);
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          console.error('[hostingerSsh] exec error:', err.message);
          conn.end();
          return reject(err);
        }
        let stdout = '';
        let stderr = '';
        stream
          .on('close', (code) => {
            conn.end();
            console.log(`[hostingerSsh] exit ${code}, stdout=${stdout.length}b stderr=${stderr.length}b`);
            if (stdout) console.log(`[hostingerSsh] stdout: ${stdout.slice(0, 800)}`);
            if (stderr) console.log(`[hostingerSsh] stderr: ${stderr.slice(0, 800)}`);
            resolve({ stdout, stderr, code: code ?? 0 });
          })
          .on('data', (d) => { stdout += d.toString(); })
          .stderr.on('data', (d) => { stderr += d.toString(); });
      });
    }).on('error', (err) => {
      console.error('[hostingerSsh] connection error:', err.message);
      reject(err);
    })
      .connect(cred);
  });
}

/**
 * Run a wp-cli command inside a specific domain's WP install.
 * Hostinger layout: `~/domains/{domain}/public_html/`
 *
 * Errors raise with stdout/stderr attached. Caller chooses to swallow or
 * surface. Most wp-cli ops are idempotent (plugin install on already-installed
 * exits 0), so the common pattern is to let errors throw.
 *
 * @param {string} domain
 * @param {string} wpArgs - the wp-cli args (without leading `wp`)
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export async function runWpCli(domain, wpArgs) {
  const path = `~/domains/${domain}/public_html`;
  const command = `cd ${path} && wp ${wpArgs}`;
  const result = await runSshCommand(command);
  if (result.code !== 0) {
    const err = new Error(`wp-cli failed (exit ${result.code}): ${result.stderr || result.stdout}`.slice(0, 500));
    err.stdout = result.stdout;
    err.stderr = result.stderr;
    err.code = result.code;
    throw err;
  }
  return result;
}

/**
 * Finish the WordPress site setup for a freshly-installed site:
 *   1. Add the client as an editor-level user (so they can edit content but
 *      can't break the site by removing IA Plugin or breaking Elementor).
 *   2. Install + activate Elementor.
 *   3. Install + activate the IA Plugin (downloaded from arion-api gated endpoint).
 *
 * Returns the wp-cli outputs collected so the caller can log them.
 *
 * @param {object} params
 * @param {string} params.domain
 * @param {string} params.clientEmail
 * @param {string} params.clientFirstName
 * @param {string} params.clientLastName
 * @param {string} params.pluginDownloadUrl - e.g. arion-api `/plugin/download?token=<provisionCode>`
 */
/**
 * Strip Hostinger's stock onboarding/AI-assistant plugins so the customer never
 * sees Kodee's wp-admin wizard once we land them in WordPress. Run AFTER
 * Kodee has finished generating the site (it needs these plugins live to do
 * its work) and BEFORE our tier plugin stack is installed.
 *
 * Best-effort per plugin: older Hostinger images may not ship all of them.
 * The tryWp swallow covers "not in list" / "doesn't exist".
 */
export async function stripHostingerOnboardingPlugins(domain) {
  const stockPlugins = [
    'hostinger-easy-onboarding',
    'hostinger-ai-assistant',
    'hostinger-ai-plugin',
    'hostinger-amplitude',
    'hostinger-reach',
    'hostinger-tools',
    'hostinger-tools-plugin',
    'hostinger',
  ];
  const logs = [];
  for (const slug of stockPlugins) {
    logs.push(await tryWp(domain, `plugin deactivate ${slug}`));
    logs.push(await tryWp(domain, `plugin delete ${slug}`));
  }
  // Clear Hostinger's first-run option so a re-installed plugin can't relaunch
  // the wizard later.
  logs.push(await tryWp(domain, `option delete hostinger_easy_onboarding`));
  logs.push(await tryWp(domain, `option delete hostinger_easy_onboarding_state`));
  return { logs };
}

/**
 * Create the client's editor-level WP user. Idempotent — if the user already
 * exists (e.g. retry after partial success), the swallow regex in tryWp
 * handles it cleanly.
 */
export async function createClientEditor({ domain, clientEmail, clientFirstName, clientLastName }) {
  return tryWp(
    domain,
    `user create ${escapeArg(clientEmail)} ${escapeArg(clientEmail)} --role=editor --first_name=${escapeArg(clientFirstName)} --last_name=${escapeArg(clientLastName)} --send-email=0`,
  );
}

/**
 * Reset the WP admin password to a known value. Called right after
 * waitForWpReady so the browser-driver can log in with the password the
 * orchestrator just generated, even when /submit is a retry against an
 * existing WP install (where Hostinger's `installWordPress` returned
 * "already installed" and the password from THIS run never reached WP).
 *
 * Idempotent: if the user doesn't exist yet, wp-cli errors and we fall back
 * to creating it.
 */
export async function ensureAdminPassword({ domain, adminLogin, adminEmail, adminPassword }) {
  try {
    return await runWpCli(
      domain,
      `user update ${escapeArg(adminLogin)} --user_pass=${escapeArg(adminPassword)}`,
    );
  } catch (err) {
    const msg = (err.stderr || err.message || '').toString();
    if (/invalid user|user.*not found|no user/i.test(msg)) {
      // User doesn't exist yet — create it at admin role.
      return runWpCli(
        domain,
        `user create ${escapeArg(adminLogin)} ${escapeArg(adminEmail)} --role=administrator --user_pass=${escapeArg(adminPassword)} --send-email=0`,
      );
    }
    throw err;
  }
}

/**
 * Legacy wrapper kept for any caller still using the older API. New code
 * should call stripHostingerOnboardingPlugins + createClientEditor +
 * installPluginsForTier (from lib/pluginStack.js) directly, in that order.
 *
 * @deprecated since 2026-06-14 — use the explicit functions instead.
 */
export async function finishWpSetup({ domain, clientEmail, clientFirstName, clientLastName, pluginDownloadUrl }) {
  const logs = [];
  const strip = await stripHostingerOnboardingPlugins(domain);
  logs.push(...strip.logs);
  logs.push(await createClientEditor({ domain, clientEmail, clientFirstName, clientLastName }));
  logs.push(await runWpCli(domain, 'plugin install elementor --activate'));
  logs.push(await runWpCli(domain, `plugin install ${escapeArg(pluginDownloadUrl)} --activate`));
  return { logs };
}

/**
 * Whitelist the SE Ranking audit crawler so Wordfence Free (installed on every
 * ARION-provisioned site as part of the Golden Master stack) doesn't 403 it.
 *
 * Without this, three ARION Intelligence reports (schema_coverage, crawl_depth,
 * competitive_presence) and the SE Ranking project's audit/keyword crawler all
 * silently fail on a freshly-provisioned site until the founder logs into
 * wp-admin and adds the allowlist by hand.
 *
 * SE Ranking publishes their User-Agent strings:
 *   - "SE Ranking Bot"       (audit + site monitor)
 *   - "SEranking"            (older audit crawler)
 *   - "SE-Ranking"           (some Brave/Backlink endpoints)
 *
 * Strategy (defense-in-depth, both layers run; both are idempotent):
 *
 *   1. `wfConfig::set('liveTraf_ignoreUA', ...)` — Wordfence's "Don't log
 *      requests from these User-Agents" list. Stops Wordfence's PHP-level
 *      rate-limiter + login-firewall from gating the crawler. Pipe-separated
 *      string, one regex per line in Wordfence's UI but stored joined.
 *
 *   2. `.htaccess` rule above the `# Wordfence WAF` block — declares an
 *      `allow_seranking` env var when the UA matches, and allows requests
 *      bearing it. Survives even if wfConfig is reset, and is what stops
 *      Apache-level 403s from the mod_security-style WAF that Wordfence
 *      Free injects on activation.
 *
 * Both steps soft-fail (best-effort): a missing wfConfig class, a missing
 * .htaccess, or any other error logs a warning and continues. The caller
 * (installPluginsForTier) treats this as non-critical — the site still
 * provisions successfully and the founder can re-run the step manually if
 * a follow-up SE Ranking probe still 403s.
 *
 * @param {string} domain
 * @returns {Promise<{ok: boolean, wfConfig: boolean, htaccess: boolean, details: string}>}
 */
export async function whitelistSeRankingCrawler(domain) {
  const result = { ok: false, wfConfig: false, htaccess: false, details: '' };

  // Step 1 — Wordfence wfConfig key. liveTraf_ignoreUA is a newline-separated
  // string in the UI; stored as a single string in wp_options. We READ first
  // so we don't blow away pre-existing allowlist entries.
  try {
    const phpRead = `if (!class_exists('wfConfig')) { echo 'WF_MISSING'; return; } $v = wfConfig::get('liveTraf_ignoreUA', ''); echo is_string($v) ? $v : '';`;
    const readRes = await runWpCli(domain, `eval ${JSON.stringify(phpRead)}`);
    const existing = (readRes.stdout || '').trim();
    if (existing === 'WF_MISSING') {
      result.details += 'wfConfig: wordfence not loaded; ';
    } else {
      const targets = ['SE Ranking Bot', 'SEranking', 'SE-Ranking'];
      const lines = existing.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const lower = new Set(lines.map((s) => s.toLowerCase()));
      const toAdd = targets.filter((t) => !lower.has(t.toLowerCase()));
      if (toAdd.length === 0) {
        result.wfConfig = true;
        result.details += 'wfConfig: already whitelisted; ';
      } else {
        const merged = [...lines, ...toAdd].join('\n');
        const escaped = merged.replace(/'/g, `'\\''`);
        const phpWrite = `if (!class_exists('wfConfig')) { echo 'WF_MISSING'; return; } wfConfig::set('liveTraf_ignoreUA', '${escaped}'); echo 'OK';`;
        const writeRes = await runWpCli(domain, `eval ${JSON.stringify(phpWrite)}`);
        if ((writeRes.stdout || '').includes('OK')) {
          result.wfConfig = true;
          result.details += `wfConfig: added ${toAdd.length} UA(s); `;
        } else {
          result.details += `wfConfig: write returned '${(writeRes.stdout || '').slice(0, 80)}'; `;
        }
      }
    }
  } catch (err) {
    result.details += `wfConfig error: ${(err.message || '').slice(0, 200)}; `;
  }

  // Step 2 — .htaccess block. Web-server-layer allow rule sits ABOVE the
  // Wordfence WAF block so a UA match short-circuits mod_security-style
  // pattern matching. Block is sentinel-wrapped for idempotency.
  try {
    const htaccessPath = `~/domains/${domain}/public_html/.htaccess`;
    const sentinelStart = '# BEGIN IA SE Ranking Allowlist';
    const sentinelEnd = '# END IA SE Ranking Allowlist';
    const block = [
      sentinelStart,
      '<IfModule mod_setenvif.c>',
      '    SetEnvIfNoCase User-Agent "SE Ranking Bot" allow_seranking=1',
      '    SetEnvIfNoCase User-Agent "SEranking" allow_seranking=1',
      '    SetEnvIfNoCase User-Agent "SE-Ranking" allow_seranking=1',
      '</IfModule>',
      '<IfModule mod_authz_core.c>',
      '    <RequireAny>',
      '        Require all granted',
      '        Require env allow_seranking',
      '    </RequireAny>',
      '</IfModule>',
      sentinelEnd,
    ].join('\n');

    // Single shell command: if sentinel exists, skip; otherwise prepend.
    // `grep -q` returns 0 if found. We write the new block to a temp file, then
    // concatenate. Using printf %s (not echo) preserves embedded quotes.
    const escapedBlock = block.replace(/'/g, `'\\''`);
    const cmd = [
      `if grep -q '${sentinelStart}' ${htaccessPath} 2>/dev/null; then`,
      `  echo 'IA_HTACCESS_ALREADY_PRESENT';`,
      `else`,
      `  touch ${htaccessPath} &&`,
      `  printf '%s\\n' '${escapedBlock}' > /tmp/ia-seranking-allow.$$ &&`,
      `  cat ${htaccessPath} >> /tmp/ia-seranking-allow.$$ &&`,
      `  mv /tmp/ia-seranking-allow.$$ ${htaccessPath} &&`,
      `  echo 'IA_HTACCESS_PREPENDED';`,
      `fi`,
    ].join(' ');
    const res = await runSshCommand(cmd);
    const out = (res.stdout || '').trim();
    if (out.includes('IA_HTACCESS_ALREADY_PRESENT')) {
      result.htaccess = true;
      result.details += '.htaccess: already present; ';
    } else if (out.includes('IA_HTACCESS_PREPENDED')) {
      result.htaccess = true;
      result.details += '.htaccess: prepended; ';
    } else {
      result.details += `.htaccess: unexpected output '${out.slice(0, 100)}'; `;
    }
  } catch (err) {
    result.details += `.htaccess error: ${(err.message || '').slice(0, 200)}; `;
  }

  result.ok = result.wfConfig || result.htaccess;
  return result;
}

/**
 * Apply branding from the questionnaire — colors, fonts, brand name — via
 * Elementor's WP options. The IA Plugin reads these on next admin_init and
 * applies them across the theme.
 *
 * @param {object} params
 * @param {string} params.domain
 * @param {string} params.brandName
 * @param {string} [params.primaryColor]
 * @param {string} [params.secondaryColor]
 * @param {string} [params.accentColor]
 */
export async function applyBranding({ domain, brandName, primaryColor, secondaryColor, accentColor }) {
  const sets = [];
  // Site title (also used by IA Plugin)
  sets.push(`option update blogname ${escapeArg(brandName)}`);
  // IA Plugin reads these option keys to populate Elementor's global colors.
  if (primaryColor)   sets.push(`option update ia_brand_primary_color ${escapeArg(primaryColor)}`);
  if (secondaryColor) sets.push(`option update ia_brand_secondary_color ${escapeArg(secondaryColor)}`);
  if (accentColor)    sets.push(`option update ia_brand_accent_color ${escapeArg(accentColor)}`);

  const out = [];
  for (const cmd of sets) out.push(await runWpCli(domain, cmd));
  return out;
}

/**
 * Fallback content generator. When Kodee soft-fails (no pages built), seed the
 * site with 6 placeholder pages from the questionnaire so the customer never
 * lands on a bare WP install. Each page is plain HTML — Elementor / the
 * customer's edits come later. Idempotent: skips pages that already exist
 * (matched by slug).
 *
 * Returns the slug list created (or skipped) for logging.
 *
 * @param {object} params
 * @param {string} params.domain
 * @param {object} params.answers - the questionnaire body
 */
export async function createFallbackPages({ domain, answers }) {
  const brandName = answers.businessName || 'Your Business';
  const tagline = answers.tagline || '';
  const description = answers.description || '';
  const services = Array.isArray(answers.services) ? answers.services : [];
  const audience = answers.targetAudience || '';
  const pages = [
    {
      slug: 'home',
      title: 'Home',
      content: [
        `<h1>${escapeHtml(brandName)}</h1>`,
        tagline ? `<p style="font-size:1.2em;">${escapeHtml(tagline)}</p>` : '',
        `<p>${escapeHtml(description)}</p>`,
        services.length ? `<h2>What We Do</h2><ul>${services.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ul>` : '',
        `<p><a href="/contact/">Get in touch →</a></p>`,
      ].filter(Boolean).join('\n'),
    },
    {
      slug: 'about',
      title: 'About',
      content: [
        `<h1>About ${escapeHtml(brandName)}</h1>`,
        `<p>${escapeHtml(description)}</p>`,
        audience ? `<h2>Who We Serve</h2><p>${escapeHtml(audience)}</p>` : '',
      ].filter(Boolean).join('\n'),
    },
    {
      slug: 'services',
      title: 'Services',
      content: [
        `<h1>Our Services</h1>`,
        services.length ? services.map((s) => `<h2>${escapeHtml(s)}</h2><p>Learn more about ${escapeHtml(s.toLowerCase())}.</p>`).join('\n') : `<p>Service details coming soon.</p>`,
      ].join('\n'),
    },
    {
      slug: 'pricing',
      title: 'Pricing',
      content: `<h1>Pricing</h1>\n<p>Reach out for a custom quote — every engagement is different.</p>`,
    },
    {
      slug: 'blog',
      title: 'Blog',
      content: `<h1>Blog</h1>\n<p>Articles coming soon.</p>`,
    },
    {
      slug: 'contact',
      title: 'Contact',
      content: `<h1>Contact ${escapeHtml(brandName)}</h1>\n<p>We'd love to hear from you.</p>`,
    },
  ];

  const created = [];
  const skipped = [];
  for (const p of pages) {
    // wp post create --post_type=page --post_status=publish --post_name=<slug> --post_title=<title> --post_content=<html>
    const args = [
      'post create',
      `--post_type=page`,
      `--post_status=publish`,
      `--post_name=${escapeArg(p.slug)}`,
      `--post_title=${escapeArg(p.title)}`,
      `--post_content=${escapeArg(p.content)}`,
    ].join(' ');
    try {
      // First check if a page with this slug exists. wp post list --post_type=page --name=<slug>.
      const exists = await runWpCli(domain, `post list --post_type=page --name=${escapeArg(p.slug)} --format=ids`);
      if (exists.stdout && exists.stdout.trim().length > 0) {
        skipped.push(p.slug);
        continue;
      }
      await runWpCli(domain, args);
      created.push(p.slug);
    } catch (err) {
      // Best-effort — one bad page shouldn't block the rest.
      console.warn(`[hostingerSsh] createFallbackPages: ${p.slug} failed: ${(err.message || '').slice(0, 200)}`);
    }
  }

  // Set Home as the static front page so visitors land on it.
  try {
    await runWpCli(domain, `option update show_on_front 'page'`);
    const homeId = await runWpCli(domain, `post list --post_type=page --name='home' --format=ids`);
    const hid = (homeId.stdout || '').trim();
    if (hid) await runWpCli(domain, `option update page_on_front ${hid}`);
  } catch (err) {
    console.warn(`[hostingerSsh] createFallbackPages: front-page assign failed: ${err.message.slice(0, 200)}`);
  }

  return { created, skipped };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Import an Astra Starter Template into a freshly-installed WP site.
 * Requires the astra-sites plugin to already be installed + active (it ships
 * in the Golden Master plugin stack). Resets existing content so the template
 * lands cleanly.
 *
 * If the import fails (template ID unavailable, plugin error), creates a basic
 * fallback page set so the customer at least gets a non-blank site.
 *
 * @param {object} args
 * @param {string} args.domain
 * @param {number} args.templateId   Astra template ID from templateRegistry
 * @param {object} args.answers      Questionnaire — used for fallback content
 * @returns {Promise<{ok: boolean, templateId: number, fallback: boolean, output: string}>}
 */
export async function importStarterTemplate({ domain, templateId, answers }) {
  try {
    // --reset clears any existing content; --yes skips interactive prompts.
    const res = await runWpCli(
      domain,
      `starter-templates import ${Number(templateId)} --reset --yes`,
    );
    return { ok: true, templateId, fallback: false, output: (res.stdout || '').slice(0, 600) };
  } catch (err) {
    const msg = (err.stderr || err.message || '').toString().slice(0, 500);
    console.warn(`[hostingerSsh] importStarterTemplate failed for ${templateId}: ${msg}`);
    // Soft-fail to the placeholder-pages path so the customer at least sees
    // a launched site; the brand-swap step still runs over whatever is there.
    try {
      await createFallbackPages({ domain, answers });
      return { ok: false, templateId, fallback: true, output: msg };
    } catch (fbErr) {
      return { ok: false, templateId, fallback: false, output: msg + ' | fallback failed: ' + fbErr.message };
    }
  }
}

/**
 * Splice the questionnaire + Claude-generated copy into the imported template.
 *
 *   - Site title + tagline  → blogname / blogdescription
 *   - Brand colors          → IA plugin option keys (already applied by applyBranding)
 *   - Logo URL              → site_icon + custom_logo (if logoUrl provided)
 *   - Hero / About / Service pages → text-replace the template's placeholder
 *     copy with copyBundle.{heroHeadline, heroSubtext, aboutBody, services[*].blurb}
 *
 * Text replacement uses wp post update with --post_content for whole-content
 * swap on the matching slug. We don't try to surgically replace single
 * widgets inside Elementor JSON — too brittle across template variants.
 *
 * @param {object} args
 * @param {string} args.domain
 * @param {object} args.answers
 * @param {object} args.copyBundle   Output of generateSiteCopy()
 * @param {string} [args.logoUrl]
 * @returns {Promise<{applied: string[], errors: string[]}>}
 */
export async function applyBrandedCopy({ domain, answers, copyBundle, logoUrl }) {
  const applied = [];
  const errors = [];

  const push = async (label, fn) => {
    try { await fn(); applied.push(label); }
    catch (e) { errors.push(`${label}: ${(e.stderr || e.message || '').toString().slice(0, 200)}`); }
  };

  // Site title + tagline
  await push('blogname', () =>
    runWpCli(domain, `option update blogname ${escapeArg(answers.businessName || '')}`));
  await push('blogdescription', () =>
    runWpCli(domain, `option update blogdescription ${escapeArg(answers.tagline || copyBundle.heroHeadline || '')}`));

  // Home page: replace content with hero block
  const homeContent = buildHomeContent(answers, copyBundle);
  await push('home page', () => upsertPageBySlug(domain, 'home', 'Home', homeContent, true));

  // About page
  const aboutContent = buildAboutContent(answers, copyBundle);
  await push('about page', () => upsertPageBySlug(domain, 'about', copyBundle.aboutHeadline || 'About', aboutContent, false));

  // Services page
  const servicesContent = buildServicesContent(answers, copyBundle);
  await push('services page', () => upsertPageBySlug(domain, 'services', 'Services', servicesContent, false));

  // Contact page
  const contactContent = `<p>${escapeHtml(copyBundle.contactIntro || '')}</p>\n<!-- wp:shortcode -->[contact-form-7]<!-- /wp:shortcode -->`;
  await push('contact page', () => upsertPageBySlug(domain, 'contact', 'Contact', contactContent, false));

  // Welcome blog post (skip if exists)
  if (copyBundle.blogIntroPost && copyBundle.blogIntroPost.title) {
    await push('welcome post', async () => {
      const existing = await runWpCli(domain, `post list --post_type=post --name='welcome' --format=ids`);
      if (!(existing.stdout || '').trim()) {
        await runWpCli(
          domain,
          `post create --post_type=post --post_status=publish --post_name='welcome' --post_title=${escapeArg(copyBundle.blogIntroPost.title)} --post_content=${escapeArg(`<p>${copyBundle.blogIntroPost.body}</p>`)}`,
        );
      }
    });
  }

  // Logo (if customer provided)
  if (logoUrl) {
    await push('site logo', async () => {
      // Sideload the image into the media library, then set as custom_logo
      const sideload = await runWpCli(domain, `media import ${escapeArg(logoUrl)} --porcelain`);
      const attId = (sideload.stdout || '').trim();
      if (attId) await runWpCli(domain, `option update custom_logo ${attId}`);
    });
  }

  return { applied, errors };
}

function buildHomeContent(answers, c) {
  const services = Array.isArray(answers.services) ? answers.services : [];
  return [
    `<!-- wp:heading {"level":1} --><h1>${escapeHtml(c.heroHeadline)}</h1><!-- /wp:heading -->`,
    `<!-- wp:paragraph --><p>${escapeHtml(c.heroSubtext)}</p><!-- /wp:paragraph -->`,
    services.length
      ? `<!-- wp:heading --><h2>What We Do</h2><!-- /wp:heading --><!-- wp:list --><ul>${
          services.map((s) => `<li>${escapeHtml(s)}</li>`).join('')
        }</ul><!-- /wp:list -->`
      : '',
    `<!-- wp:paragraph --><p><a href="/contact/">${escapeHtml(c.heroCta || 'Get in touch')} →</a></p><!-- /wp:paragraph -->`,
  ].filter(Boolean).join('\n');
}

function buildAboutContent(answers, c) {
  return [
    `<!-- wp:heading {"level":1} --><h1>${escapeHtml(c.aboutHeadline || 'About')}</h1><!-- /wp:heading -->`,
    `<!-- wp:paragraph --><p>${escapeHtml(c.aboutBody)}</p><!-- /wp:paragraph -->`,
    answers.targetAudience
      ? `<!-- wp:heading --><h2>Who We Serve</h2><!-- /wp:heading --><!-- wp:paragraph --><p>${escapeHtml(answers.targetAudience)}</p><!-- /wp:paragraph -->`
      : '',
  ].filter(Boolean).join('\n');
}

function buildServicesContent(answers, c) {
  const list = (c.services && c.services.length) ? c.services
    : (Array.isArray(answers.services) ? answers.services.map((name) => ({ name, blurb: `Learn more about our ${String(name).toLowerCase()}.` })) : []);
  const blocks = list.map((s) =>
    `<!-- wp:heading {"level":2} --><h2>${escapeHtml(s.name)}</h2><!-- /wp:heading --><!-- wp:paragraph --><p>${escapeHtml(s.blurb || '')}</p><!-- /wp:paragraph -->`,
  ).join('\n');
  return `<!-- wp:heading {"level":1} --><h1>Services</h1><!-- /wp:heading -->\n${blocks}`;
}

async function upsertPageBySlug(domain, slug, title, content, setAsFront) {
  const exists = await runWpCli(domain, `post list --post_type=page --name=${escapeArg(slug)} --format=ids`);
  const id = (exists.stdout || '').trim();
  if (id) {
    await runWpCli(domain, `post update ${id} --post_title=${escapeArg(title)} --post_content=${escapeArg(content)} --post_status=publish`);
    if (setAsFront) {
      await runWpCli(domain, `option update show_on_front 'page'`);
      await runWpCli(domain, `option update page_on_front ${id}`);
    }
    return;
  }
  const created = await runWpCli(
    domain,
    `post create --post_type=page --post_status=publish --post_name=${escapeArg(slug)} --post_title=${escapeArg(title)} --post_content=${escapeArg(content)} --porcelain`,
  );
  const newId = (created.stdout || '').trim();
  if (setAsFront && newId) {
    await runWpCli(domain, `option update show_on_front 'page'`);
    await runWpCli(domain, `option update page_on_front ${newId}`);
  }
}

/**
 * Try a wp-cli command and swallow "already exists" errors. Returns the
 * result either way. Used for ops where the desired end-state is what
 * matters, not strict success.
 */
async function tryWp(domain, args) {
  try {
    return await runWpCli(domain, args);
  } catch (err) {
    const msg = (err.stderr || err.message || '').toString();
    // wp-cli idempotent-failure phrasings we want to swallow:
    //   "username is already registered" (user create)
    //   "email is already used"           (user create)
    //   "user with that login already exists"
    //   "Plugin 'foo' is already active"  (plugin activate)
    //   "is already installed"            (plugin install)
    //   "Option 'foo' is not registered"  (option delete on missing key)
    //   "Plugin 'foo' is not in the list" (plugin delete on missing)
    //   "doesn't exist"                   (plugin delete / option delete on missing)
    if (/already (registered|exists|used|installed|active|has|in use)/i.test(msg)
      || /user with that login/i.test(msg)
      || /not (registered|installed|in the list)/i.test(msg)
      || /doesn'?t exist/i.test(msg)
      || /could not be found/i.test(msg)) {
      return { stdout: '', stderr: msg, code: 0, swallowed: true };
    }
    throw err;
  }
}

/** Single-quote escape for shell arguments. */
function escapeArg(s) {
  return `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;
}

/**
 * Upload a Buffer to a remote path via SFTP.
 *
 * Why this exists: SSH exec is bounded by the SSH packet size (~32KB default),
 * which means the previous "echo <b64> | base64 -d > file" trick silently fails
 * for anything larger than a few KB. Binary uploads (images, archives) MUST go
 * over SFTP. ssh2 ships an sftp() subsystem on the same connection, so we
 * piggyback on the existing credential + connect logic.
 *
 * @param {Buffer} buffer       raw bytes to upload
 * @param {string} remotePath   absolute path on the remote box (e.g. /tmp/iag-x.png)
 * @returns {Promise<void>}
 */
export async function uploadFileViaSftp(buffer, remotePath) {
  const cred = await getSshCredentials();
  console.log(`[hostingerSsh] sftp upload: ${remotePath} (${buffer.length} bytes)`);
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          return reject(new Error(`sftp open failed: ${err.message}`));
        }
        const stream = sftp.createWriteStream(remotePath);
        let settled = false;
        const done = (e) => {
          if (settled) return;
          settled = true;
          conn.end();
          if (e) reject(e); else resolve();
        };
        stream.on('error', (e) => done(new Error(`sftp write error: ${e.message}`)));
        stream.on('close', () => done(null));
        stream.end(buffer);
      });
    }).on('error', (err) => {
      reject(new Error(`sftp connect failed: ${err.message}`));
    }).connect(cred);
  });
}

export default {
  runSshCommand,
  runWpCli,
  uploadFileViaSftp,
  finishWpSetup,
  stripHostingerOnboardingPlugins,
  createClientEditor,
  ensureAdminPassword,
  applyBranding,
  applyBrandedCopy,
  importStarterTemplate,
  createFallbackPages,
  whitelistSeRankingCrawler,
};
