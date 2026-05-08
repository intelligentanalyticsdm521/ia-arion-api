/**
 * Worker Client — POSTs jobs to the Playwright site-provisioner Container App.
 *
 * Auth: shared secret in `x-worker-secret` header. The worker validates the
 * secret on every /run call. Both arion-api and the worker container read the
 * secret from PROVISIONER_SHARED_SECRET env var (deployed identically to both).
 *
 * The worker returns 202 immediately and processes async; this module is
 * fire-and-forget except for the initial dispatch ack.
 */

const PROVISIONER_URL = process.env.PROVISIONER_URL || '';
const PROVISIONER_SHARED_SECRET = process.env.PROVISIONER_SHARED_SECRET || '';

/**
 * Dispatch a provisioning job to the worker.
 *
 * @param {object} job  - the full job payload (jobId, prompt, brandName, wp creds, etc.)
 * @returns {Promise<{ok: boolean, error?: string, status?: number}>}
 */
export async function dispatchJob(job) {
  if (!PROVISIONER_URL) {
    return { ok: false, error: 'PROVISIONER_URL not configured' };
  }
  try {
    const res = await fetch(rtrim(PROVISIONER_URL) + '/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-worker-secret': PROVISIONER_SHARED_SECRET,
      },
      body: JSON.stringify(job),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 202 || res.status === 200) {
      return { ok: true };
    }
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: text.slice(0, 300) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function rtrim(s) {
  return String(s).replace(/\/+$/, '');
}
