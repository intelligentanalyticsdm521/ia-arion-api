/**
 * Browser Driver client — talks to ca-iadm-browser-driver-prod.
 * --------------------------------------------------------------------------
 * The Container App is a small Express+Playwright service that drives any
 * web workflow we can't reach via public API. Primary use case 2026-06-14
 * onward: Hostinger's hPanel "AI Website Builder for WordPress" flow.
 *
 * Auth: shared bearer token in KV (`BROWSER-DRIVER-SHARED-KEY`). Set the same
 * value on the Container App as an env secret. Rotate by editing the KV
 * secret + restarting the Container App.
 *
 * Failure model: any non-2xx from the driver returns a structured error
 * payload that the orchestrator surfaces; the driver itself returns 200
 * with `{status: 'failed', error, screenshots}` for soft failures so the
 * caller can inspect screenshots without a 500.
 */

import { SecretClient } from '@azure/keyvault-secrets';
import { DefaultAzureCredential } from '@azure/identity';

const DRIVER_BASE = (process.env.BROWSER_DRIVER_URL
  || 'https://ca-iadm-browser-driver-prod.yellowmoss-58b06cce.centralus.azurecontainerapps.io').replace(/\/+$/, '');

const KV_URI = process.env.KEY_VAULT_URI || 'https://kv-iadm-prod.vault.azure.net/';
let _kv = null;
function kv() {
  if (!_kv) _kv = new SecretClient(KV_URI, new DefaultAzureCredential());
  return _kv;
}

// Cache master Hostinger creds for an hour so we don't hit KV on every onboarding
let _credCache = null;
const CRED_TTL_MS = 60 * 60 * 1000;

async function getHpanelCreds() {
  if (_credCache && Date.now() - _credCache.ts < CRED_TTL_MS) return _credCache.value;
  const [login, pw, imapLogin, imapPw] = await Promise.all([
    kv().getSecret('HOSTINGER-LOGIN'),
    kv().getSecret('HOSTINGER-PW'),
    kv().getSecret('hostinger-email-login').catch(() => null),
    kv().getSecret('hostinger-email-password').catch(() => null),
  ]);
  const value = {
    hostingerLogin: login.value,
    hostingerPassword: pw.value,
    imap: (imapLogin && imapPw) ? { login: imapLogin.value, password: imapPw.value } : null,
  };
  _credCache = { value, ts: Date.now() };
  return value;
}

/**
 * Drive Hostinger's hPanel AI Website Builder for WordPress.
 *
 * The driver logs into hPanel.hostinger.com, clicks Add Website on a plan
 * card with capacity, walks through the WordPress + AI build flow, fills the
 * questionnaire prompt + brand details, and waits for the site to come live.
 * On completion the WordPress site has been provisioned by Hostinger itself
 * with Kodee-built pages — no further site-creation API calls needed.
 *
 * @param {object} args
 * @param {string} args.subdomain        e.g. "arion-test14.intelligentanalyticsdm.com"
 * @param {string} args.wpAdminEmail     Email for the WP admin user Kodee creates
 * @param {string} args.wpAdminPassword  Password for the WP admin user
 * @param {string} args.prompt           Free-text site description (Kodee prompt)
 * @param {string} args.brandName        Customer's business name
 * @param {string} [args.primaryColor]   Hex (e.g. "#1A3A4A")
 * @param {string} [args.secondaryColor]
 * @param {string} [args.accentColor]
 * @param {number} [args.timeoutMs=960000]  16 min default (15 in driver + 1 min network slack)
 * @returns {Promise<{status:'completed'|'failed', duration_ms:number, screenshots:string[], error?:string, finalUrl?:string}>}
 */
export async function driveHpanelBuild(args) {
  if (!process.env.BROWSER_DRIVER_SHARED_KEY) {
    throw new Error('browserDriver: BROWSER_DRIVER_SHARED_KEY env var not set');
  }
  const creds = await getHpanelCreds();
  const url = `${DRIVER_BASE}/drive-hpanel-build`;
  const timeoutMs = args.timeoutMs || 960_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const body = {
    hostingerLogin: creds.hostingerLogin,
    hostingerPassword: creds.hostingerPassword,
    subdomain: args.subdomain,
    wpAdminEmail: args.wpAdminEmail,
    wpAdminPassword: args.wpAdminPassword,
    prompt: args.prompt,
    brandName: args.brandName,
    primaryColor: args.primaryColor,
    secondaryColor: args.secondaryColor,
    accentColor: args.accentColor,
    imap: creds.imap,
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.BROWSER_DRIVER_SHARED_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return { status: 'failed', duration_ms: timeoutMs, screenshots: [], error: 'driver timeout' };
    }
    throw err;
  }
  clearTimeout(timer);

  let resBody;
  try {
    resBody = await res.json();
  } catch {
    return { status: 'failed', duration_ms: 0, screenshots: [], error: `non-JSON HTTP ${res.status}` };
  }

  if (!res.ok) {
    return {
      status: 'failed',
      duration_ms: resBody.duration_ms || 0,
      screenshots: resBody.screenshots || [],
      error: resBody.error || `HTTP ${res.status}`,
    };
  }
  return resBody;
}

/**
 * Healthcheck — quick liveness probe for the driver before invoking
 * driveHpanelBuild on a fresh install. Returns true if the driver responds.
 */
export async function pingDriver() {
  try {
    const res = await fetch(`${DRIVER_BASE}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export default { driveHpanelBuild, pingDriver };
