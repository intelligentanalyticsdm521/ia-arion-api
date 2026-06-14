/**
 * Browser Driver client — talks to ca-iadm-browser-driver-prod.
 * --------------------------------------------------------------------------
 * The Container App is a small Express+Playwright service that drives any
 * wp-admin (or other web) workflow we can't reach via public API. The first
 * use case is Hostinger's Kodee AI WordPress builder (no public API; only
 * accessible via the wp-admin wizard).
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

const DRIVER_BASE = (process.env.BROWSER_DRIVER_URL
  || 'https://ca-iadm-browser-driver-prod.eastus.azurecontainerapps.io').replace(/\/+$/, '');

/**
 * Drive Hostinger's Kodee AI WordPress builder for a freshly-installed site.
 *
 * @param {object} args
 * @param {string} args.domain            - target wp-admin domain (no scheme)
 * @param {string} args.adminLogin        - WP admin username
 * @param {string} args.adminPassword     - WP admin password
 * @param {string} args.prompt            - questionnaire-derived prompt (<=2000 chars)
 * @param {number} [args.timeoutMs=300000] - 5 min default — Kodee builds take 2-4 min
 * @returns {Promise<{status:'completed'|'failed', duration_ms:number, screenshots:string[], error?:string}>}
 */
export async function driveKodeeBuild({ domain, adminLogin, adminPassword, prompt, timeoutMs = 300_000 }) {
  if (!process.env.BROWSER_DRIVER_SHARED_KEY) {
    throw new Error('browserDriver: BROWSER_DRIVER_SHARED_KEY env var not set');
  }
  const url = `${DRIVER_BASE}/drive-kodee`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.BROWSER_DRIVER_SHARED_KEY}`,
      },
      body: JSON.stringify({ domain, adminLogin, adminPassword, prompt }),
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

  let body;
  try {
    body = await res.json();
  } catch {
    return { status: 'failed', duration_ms: 0, screenshots: [], error: `non-JSON HTTP ${res.status}` };
  }

  if (!res.ok) {
    return {
      status: 'failed',
      duration_ms: body.duration_ms || 0,
      screenshots: body.screenshots || [],
      error: body.error || `HTTP ${res.status}`,
    };
  }
  return body;
}

/**
 * Healthcheck — quick liveness probe for the driver before invoking
 * driveKodeeBuild on a fresh install. Returns true if the driver responds.
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

export default { driveKodeeBuild, pingDriver };
