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
    'hostinger-amplitude',
    'hostinger-reach',
    'hostinger-tools',
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

export default {
  runSshCommand,
  runWpCli,
  finishWpSetup,
  stripHostingerOnboardingPlugins,
  createClientEditor,
  ensureAdminPassword,
  applyBranding,
};
