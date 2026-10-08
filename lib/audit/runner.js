// lib/audit/runner.js
//
// One audit, start to finish (contract §E.3–§E.7):
//
//   queued -> running -> (PageSpeed mobile then desktop, alongside the crawl)
//          -> score -> the report in the caller's branding, painted as a PDF -> private blob
//          -> two keyed links -> done -> signed callback to the caller
//
// and on any failure: failed with a plain sentence -> signed callback saying so.
//
// RULES THIS FILE KEEPS
//   - Two audits at a time per process (semaphore 2); the rest wait their turn.
//   - The whole run has a 5-minute hard cap. PageSpeed has its own two attempts
//     (lib/pagespeed.js); the crawl and the PDF get one retry on a thrown error.
//   - A website on a local address (the dev exception) is not sent to PageSpeed:
//     Google cannot reach it, so speed reads "We couldn't measure speed this time."
//   - Never reports success it did not have. A failure is written to the run
//     row with a plain reason and sent to the caller; a callback that cannot be
//     delivered after 3 attempts (0 s, 60 s, 300 s) leaves status
//     'callback_failed' and the caller's own deadline marks its side failed.
//   - Nothing here knows which agency is calling. Branding is the signed
//     `business` block; the secret is the caller row's.
//
// Every outside thing is a dependency (`deps`), so the tests run the real flow
// with fakes for PageSpeed, fetch, the PDF painter, the blob and the callback.

import { crawl as realCrawl } from './crawl.js';
import { scoreAudit } from './score.js';
import { renderPdf as realRenderPdf } from './report.js';
import { storePdf as realStorePdf } from './store.js';
import { mintLinks } from './links.js';
import { sign } from './signature.js';
import { safeFetch, checkUrl, isLoopback, SafeFetchRefused } from './safeFetch.js';
import { runPageSpeedTest } from '../pagespeed.js';

export const RUN_CAP_MS = 5 * 60 * 1000;
export const CALLBACK_AT_MS = [0, 60_000, 300_000];

export const PLAIN = {
  unreachable: "We couldn't reach that website.",
  notPublic: "That address isn't a public website.",
  tooSlow: 'The website took too long to answer.',
  noReport: "The report couldn't be made this time.",
  // We DID reach the website in these four, so they must not say we didn't.
  homeError: "That website's home page showed an error instead of the page, so there was nothing to check.",
  notHtml: "That address isn't a web page we can read.",
  tooBig: "That website's home page is too big for us to check.",
  redirectLoop: "That website keeps sending us from one address to another, so we couldn't check it.",
};

class RunTimeout extends Error {
  constructor() { super('run cap'); this.name = 'RunTimeout'; }
}
class ReportFailed extends Error {
  constructor(cause) { super(cause?.message || 'report'); this.name = 'ReportFailed'; this.cause = cause; }
}

/** Any thrown error -> the one plain sentence that is true of it. */
export function plainError(err) {
  if (err instanceof RunTimeout) return PLAIN.tooSlow;
  if (err instanceof ReportFailed) return PLAIN.noReport;
  if (err?.code === 'home_status') return PLAIN.homeError; // the site answered 404, 500 …
  if (err instanceof SafeFetchRefused) {
    if (['bad_url', 'not_public', 'not_https'].includes(err.code)) return PLAIN.notPublic;
    if (err.code === 'timeout') return PLAIN.tooSlow;
    if (err.code === 'not_html') return PLAIN.notHtml;
    if (err.code === 'too_big') return PLAIN.tooBig;
    if (err.code === 'too_many_redirects') return PLAIN.redirectLoop;
    return PLAIN.unreachable;
  }
  return PLAIN.unreachable;
}

export function createSemaphore(limit) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= limit || !waiting.length) return;
    active += 1;
    const { fn, resolve, reject } = waiting.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active -= 1; next(); });
  };
  return {
    run(fn) { return new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); next(); }); },
    get active() { return active; },
    get waiting() { return waiting.length; },
  };
}

const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

async function withCap(promise, ms) {
  let t;
  try {
    return await Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new RunTimeout()), ms); })]);
  } finally {
    clearTimeout(t);
  }
}

async function onceMore(fn, { retryIf = () => true } = {}) {
  try { return await fn(); } catch (err) {
    if (!retryIf(err)) throw err;
    return fn();
  }
}

/** The caller's logo as an embedded data: URI, fetched through the SSRF guard. Null on anything odd. */
export async function fetchLogoDataUri(logoUrl, fetch) {
  if (!logoUrl || typeof logoUrl !== 'string' || logoUrl.length > 1000) return null;
  try {
    const res = await fetch(logoUrl, { maxBytes: 1024 * 1024, timeoutMs: 5000 });
    const ct = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (res.status !== 200 || !/^image\/(?:png|jpeg|gif|webp|svg\+xml)$/.test(ct) || !res.body.length) return null;
    return `data:${ct};base64,${res.body.toString('base64')}`;
  } catch {
    return null; // the report is made without a logo; nothing else depends on it
  }
}

export async function isLocalTarget(url, { lookup, env } = {}) {
  try {
    const t = await checkUrl(url, { lookup, env });
    return isLoopback(t.address);
  } catch {
    return false;
  }
}

/**
 * @param {object} deps
 * @param {object} deps.repo                 lib/audit/runs.js shape
 * @param {(callerId) => Promise<{caller, secret}>} deps.callerSecret
 * @param {string|(() => string)} [deps.publicBase]
 */
export function createAuditRunner(deps) {
  const d = {
    fetch: (url, opts) => safeFetch(url, opts),
    pagespeed: runPageSpeedTest,
    crawl: realCrawl,
    renderPdf: realRenderPdf,
    storePdf: realStorePdf,
    sleep: sleepReal,
    now: () => Date.now(),
    callbackAtMs: CALLBACK_AT_MS,
    runCapMs: RUN_CAP_MS,
    concurrency: 2,
    log: console,
    ...deps,
  };
  const sem = createSemaphore(d.concurrency);

  /**
   * POST the signed result to the caller. Returns true when the caller took it.
   *
   * The signed body names the run it is about (`run_id`, the caller's own id)
   * and what kind of message it is (`kind: 'result'`), so a captured body
   * cannot be replayed onto another run's callback address: the signature
   * covers the binding, not only the header.
   */
  async function deliver(run, payload) {
    const { caller, secret } = await d.callerSecret(run.caller_id);
    const body = JSON.stringify({ kind: 'result', run_id: run.external_run_id, ...payload });
    let lastError = null;
    let waited = 0;
    for (let i = 0; i < d.callbackAtMs.length; i++) {
      const wait = d.callbackAtMs[i] - waited;
      if (wait > 0) await d.sleep(wait);
      waited = d.callbackAtMs[i];
      try {
        const res = await d.fetch(run.callback_url, {
          method: 'POST',
          httpsOnly: true,
          maxRedirects: 0,
          timeoutMs: 10_000,
          maxBytes: 64 * 1024,
          headers: {
            'Content-Type': 'application/json',
            'X-Workflow-Key': caller.key_id,
            'X-Workflow-Run': run.external_run_id,
            'X-Workflow-Signature': sign(body, secret, d.now()),
          },
          body,
        });
        if (res.status >= 200 && res.status < 300) {
          await d.repo.recordCallback(run.run_id, { attempts: i + 1 });
          return true;
        }
        lastError = `the caller answered ${res.status}`;
        // A 4xx will not change on a retry (bad signature, run no longer waiting).
        if (res.status >= 400 && res.status < 500) {
          await d.repo.recordCallback(run.run_id, { attempts: i + 1, lastError, callbackFailed: true });
          return false;
        }
      } catch (err) {
        lastError = `could not reach the caller (${err.code || err.message})`;
      }
      await d.repo.recordCallback(run.run_id, { attempts: i + 1, lastError });
    }
    await d.repo.recordCallback(run.run_id, { attempts: d.callbackAtMs.length, lastError, callbackFailed: true });
    return false;
  }

  /**
   * The audit itself: facts -> score -> PDF -> blob. Returns what markDone needs.
   *
   * `signal` is aborted when the 5-minute cap fires. The run is already marked
   * failed by then, so from that point nothing new starts: no more pages, no
   * logo, no PDF, and above all no blob that no row would point to.
   */
  async function audit(run, base, signal) {
    const stopIfCancelled = () => { if (signal?.aborted) throw new RunTimeout(); };
    const business = parse(run.business_json) || {};
    const visitor = parse(run.visitor_json) || {};
    const deadline = d.now() + 60_000;
    const links = mintLinks(base, run.run_id, d.now(), d.env || process.env);
    const local = await isLocalTarget(run.url, { lookup: d.lookup, env: d.env });

    const psiChain = (async () => {
      if (local) return { mobile: null, desktop: null };
      const mobile = await d.pagespeed(run.url, 'mobile').catch(() => null);
      if (signal?.aborted) return { mobile, desktop: null };
      const desktop = await d.pagespeed(run.url, 'desktop').catch(() => null);
      return { mobile, desktop };
    })();
    const crawlP = onceMore(() => d.crawl(run.url, { fetch: d.fetch, deadline, signal }), {
      // An address we refuse will be refused again, and a cancelled run is over: do not knock twice.
      retryIf: (err) => !signal?.aborted && !(err instanceof SafeFetchRefused && ['bad_url', 'not_public', 'not_https'].includes(err.code)),
    });
    const [psi, crawlResult] = await Promise.all([psiChain, crawlP]);
    stopIfCancelled(); // cap check: after the crawl

    const result = scoreAudit({ crawl: crawlResult, psiMobile: psi.mobile, psiDesktop: psi.desktop });
    let blobPath;
    try {
      const logoDataUri = await fetchLogoDataUri(business.logo_url, d.fetch);
      const report = { business, logoDataUri, visitor, url: run.url, result, now: new Date(d.now()) };
      stopIfCancelled(); // cap check: before the PDF
      const pdf = await onceMore(() => d.renderPdf(report), { retryIf: () => !signal?.aborted });
      stopIfCancelled(); // cap check: before the blob
      blobPath = await d.storePdf({ callerId: run.caller_id, runId: run.run_id, buffer: pdf });
    } catch (err) {
      if (err instanceof RunTimeout) throw err;
      throw new ReportFailed(err);
    }
    return {
      done: {
        score: result.score,
        summary_plain: result.summary_plain,
        findings_json: JSON.stringify({ sentence: result.sentence, sections: result.sections, topFindings: result.topFindings, notes: result.notes }),
        psi_json: JSON.stringify(psi),
        crawl_json: JSON.stringify(crawlResult),
        blob_path: blobPath,
        visitor_key_hash: links.visitor_key_hash,
        owner_key_hash: links.owner_key_hash,
        visitor_link_expires_at: links.visitor_link_expires_at,
      },
      answer: { status: 'done', file_url: links.file_url, owner_file_url: links.owner_file_url, summary: result.summary_plain, score: result.score },
    };
  }

  /**
   * Phase 1: run one queued audit and write its outcome (done or failed).
   * Returns { run, payload, settled }, where `settled` resolves once the audit
   * has REALLY stopped (after a cap it may still be finishing its current
   * step). Never throws for an audit problem.
   */
  async function execute(runId, { base } = {}) {
    const baseUrl = base || (typeof d.publicBase === 'function' ? d.publicBase() : d.publicBase);
    const run = await d.repo.getRun(runId);
    if (!run || run.status !== 'queued') return { skipped: true };
    if (!(await d.repo.markRunning(runId))) return { skipped: true };
    const ac = new AbortController();
    const inner = audit(run, baseUrl, ac.signal);
    const settled = inner.then(() => {}, () => {});
    let payload;
    try {
      const out = await withCap(inner, d.runCapMs);
      await d.repo.markDone(runId, out.done);
      payload = out.answer;
    } catch (err) {
      if (err instanceof RunTimeout) ac.abort();
      const plain = plainError(err);
      d.log.error?.(`[audit] run ${runId} failed: ${err?.cause?.message || err?.detail || err?.message}`);
      await d.repo.markFailed(runId, plain);
      payload = { status: 'failed', error: plain };
    }
    return { run, payload, settled };
  }

  /** Phase 2: tell the caller. Runs OUTSIDE the audit slots: callback back-off never blocks another audit. */
  async function report({ run, payload }) {
    const delivered = await deliver(run, payload).catch(async (err) => {
      d.log.error?.(`[audit] run ${run.run_id} callback could not be sent: ${err.message}`);
      await d.repo.recordCallback(run.run_id, { attempts: 0, lastError: `could not sign the result (${err.message})`, callbackFailed: true });
      return false;
    });
    return { ...payload, delivered };
  }

  /** Run one queued audit now and tell the caller (no semaphore; tests and the sweep's failures use it). */
  async function runNow(runId, opts) {
    const r = await execute(runId, opts);
    if (r.skipped) return r;
    const told = report(r);
    await r.settled;
    return told;
  }

  /**
   * Queue a run behind the semaphore (2 at a time). The slot is held until the
   * audit has truly stopped, even after a cap, so the limit of two is real;
   * it is released before the callback, so a slow or dead callback server
   * holds no slot. Resolves with the final outcome (the route does not await it).
   */
  function start(runId, opts) {
    return new Promise((resolve) => {
      sem.run(async () => {
        const r = await execute(runId, opts);
        if (r.skipped) { resolve(r); return; }
        report(r).then(resolve);
        await r.settled;
      }).catch((err) => {
        d.log.error?.(`[audit] run ${runId} could not run: ${err.message}`);
        resolve({ skipped: true, error: err.message });
      });
    });
  }

  /**
   * Find runs whose worker died (a restart or a deploy) and start them again,
   * or fail them in plain words when they have had their two starts. Called
   * at boot and on a slow tick (routes/audit.js startAuditSweep).
   */
  async function sweep({ base } = {}) {
    const ids = await d.repo.listStale();
    const out = [];
    for (const id of ids) {
      const revived = await d.repo.reviveStale(id, { failPlain: PLAIN.noReport });
      if (revived === 'restart') { start(id, { base }); out.push([id, 'restart']); }
      if (revived === 'failed') {
        const run = await d.repo.getRun(id);
        if (run) report({ run, payload: { status: 'failed', error: PLAIN.noReport } });
        out.push([id, 'failed']);
      }
    }
    return out;
  }

  return { runNow, deliver, start, sweep, semaphore: sem };
}

export default { createAuditRunner, plainError, createSemaphore, fetchLogoDataUri, PLAIN, RUN_CAP_MS, CALLBACK_AT_MS };
