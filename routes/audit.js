// routes/audit.js
//
// The website check, as any agency's CUSTOM ACTION (contract §E.2, §E.6).
//
//   POST /audit/runs            public, SIGNED (X-Workflow-Key + X-Workflow-Signature over the raw body)
//   GET  /audit/files/:runId?k= public, KEYED (the visitor's 30-day link or the lead's lasting link)
//
// Mounted in index.js BEFORE express.json, with express.raw here, because the
// signature is over the exact bytes that arrived (the Stripe webhook does the
// same, index.js).
//
// NOTHING HERE KNOWS WHICH AGENCY IS CALLING. The caller row says who; the
// signed body's `business` block says how the report should look. The only
// visitor details kept are the website and the visitor's business name (for
// the report's heading) — not their name, email or phone.

import express from 'express';
import { getServicesPool } from '../db/servicesPool.js';
import { getCallerByKeyId, getCallerById, decryptSecret, AuditNotConfigured } from '../lib/audit/callers.js';
import { verify } from '../lib/audit/signature.js';
import { createSqlRepo, STALE } from '../lib/audit/runs.js';
import { createAuditRunner, PLAIN } from '../lib/audit/runner.js';
import { normaliseSiteUrl, urlKey } from '../lib/audit/crawl.js';
import { checkUrl } from '../lib/audit/safeFetch.js';
import { mintLinks, linksFor, storedLinksAreOurs, keyMatches, looksLikeKey } from '../lib/audit/links.js';
import { openPdf as realOpenPdf } from '../lib/audit/store.js';
import { escapeHtml } from '../lib/audit/report.js';

export const TOOL_NAME = 'Website check';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export const WORDS = {
  notConfigured: "The website check can't run right now. Please try again later or contact support.",
  // The owner reads this inside "did not finish: your tool said: …", so it
  // says what happened and what to do.
  dailyLimit: "Today's limit of website checks was reached, so this one didn't run. Reply to this visitor yourself — checks start again tomorrow.",
  linkWrong: "This link isn't right. Ask the business that sent it to you for a fresh copy.",
  linkExpired: (name) => `This link has expired. Ask ${name || 'the business that sent it'} for a fresh copy.`,
  fileTrouble: "We couldn't open this report right now. Please try again in a few minutes.",
};

export function publicBaseFrom(req, env = process.env) {
  const configured = String(env.ARION_PUBLIC_BASE_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  const proto = env.WEBSITE_SITE_NAME ? 'https' : req.protocol;
  return `${proto}://${req.get('host')}`;
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Keep only the branding block (strings, hex colours) — nothing else from the request is stored. */
function cleanBusiness(b) {
  const str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  const colours = {};
  for (const k of ['primary', 'secondary', 'accent', 'text', 'background']) {
    const v = b?.colours?.[k];
    if (typeof v === 'string' && HEX_RE.test(v.trim())) colours[k] = v.trim();
  }
  return { name: str(b?.name, 200), website: str(b?.website, 300), phone: str(b?.phone, 60), logo_url: str(b?.logo_url, 1000), colours };
}

function plainPage(res, status, sentence) {
  res.status(status).type('html').set('Cache-Control', 'no-store').send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Website check</title></head>`
    + `<body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;color:#111827">`
    + `<p style="font-size:18px;line-height:1.5">${escapeHtml(sentence)}</p></body></html>`);
}

/**
 * @param {object} deps
 * @param {object} deps.repo
 * @param {(keyId: string) => Promise<object|null>} deps.findCaller
 * @param {(caller: object) => string} deps.secretOf
 * @param {{ start: (runId, opts) => Promise }} deps.runner
 * @param {(blobPath: string) => Promise<NodeJS.ReadableStream>} deps.openPdf
 */
export function createAuditRouter(deps) {
  const d = { now: () => Date.now(), env: process.env, lookup: undefined, log: console, ...deps };
  const router = express.Router();
  const raw = express.raw({ type: () => true, limit: '64kb' });

  const startRun = (runId, base) => setImmediate(() => {
    Promise.resolve(d.runner.start(runId, { base })).catch((err) => d.log.error?.(`[audit] run ${runId} did not start: ${err.message}`));
  });

  /**
   * What to say about a run that already exists ("answer as before", §E.2.6).
   *
   * A finished run answers with the SAME two links every time: the keys are
   * derived from the run id (lib/audit/links.js), and hashes already stored
   * are never replaced, so a retry cannot break the link the visitor was
   * emailed or the one the lead keeps. A row with no links yet (a same-website
   * copy) gets its first pair here.
   *
   * A queued or running run whose worker died (a restart drops the in-memory
   * queue) is started again when the caller asks again, instead of answering
   * "accepted" for ever (lib/audit/runs.js reviveStale).
   */
  async function answerFor(row, base) {
    if (row.status === 'queued' || row.status === 'running') {
      const revived = await d.repo.reviveStale(row.run_id, { failPlain: PLAIN.noReport });
      if (revived === 'failed') return [200, { status: 'failed', error: PLAIN.noReport }];
      if (revived === 'restart') startRun(row.run_id, base);
      return [202, { status: 'accepted' }];
    }
    if ((row.status === 'done' || row.status === 'callback_failed') && row.blob_path) {
      const done = { status: 'done', summary: row.summary_plain, score: row.score };
      if (!row.visitor_key_hash && !row.owner_key_hash) {
        const links = mintLinks(base, row.run_id, d.now(), d.env);
        await d.repo.setLinks(row.run_id, links);
        return [200, { ...done, file_url: links.file_url, owner_file_url: links.owner_file_url }];
      }
      // Keyed some other way (an older row): its links are left exactly as they are.
      if (!storedLinksAreOurs(row, d.env)) return [200, done];
      const links = linksFor(base, row.run_id, d.env);
      return [200, { ...done, file_url: links.file_url, owner_file_url: links.owner_file_url }];
    }
    return [200, { status: 'failed', error: row.error_plain || PLAIN.unreachable }];
  }

  router.post('/runs', raw, async (req, res, next) => {
    try {
      const keyId = req.get('X-Workflow-Key');
      const caller = keyId ? await d.findCaller(keyId) : null;
      if (!caller) return res.status(401).json({ error: 'unknown_key' });

      let secret;
      try {
        secret = d.secretOf(caller);
      } catch (err) {
        if (err instanceof AuditNotConfigured) return res.status(503).json({ error: 'not_configured', message: WORDS.notConfigured });
        throw err;
      }

      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const sig = verify(body, req.get('X-Workflow-Signature'), secret, d.now());
      if (!sig.ok) return res.status(401).json({ error: sig.error });

      let msg;
      try { msg = JSON.parse(body.toString('utf8')); } catch { msg = null; }
      if (!msg || typeof msg !== 'object') return res.status(400).json({ error: 'bad_request', message: 'The request body must be JSON.' });

      if (msg.type === 'ping') return res.json({ status: 'ok', name: TOOL_NAME });
      if (msg.type !== 'run') return res.status(400).json({ error: 'bad_request', message: 'type must be "run" or "ping".' });

      const runId = typeof msg.run_id === 'string' ? msg.run_id.trim() : '';
      if (!runId || runId.length > 80) return res.status(400).json({ error: 'bad_request', message: 'run_id is required.' });
      const site = normaliseSiteUrl(msg.visitor?.website || msg.visitor?.url);
      if (!site) return res.status(400).json({ error: 'bad_request', message: "The visitor's website is missing or is not a web address." });
      const business = cleanBusiness(msg.business);
      if (!business.name) return res.status(400).json({ error: 'bad_request', message: 'business.name is required.' });
      if (typeof msg.callback_url !== 'string' || msg.callback_url.length > 1000) {
        return res.status(400).json({ error: 'bad_request', message: 'callback_url is required.' });
      }
      try {
        await checkUrl(msg.callback_url, { httpsOnly: true, lookup: d.lookup, env: d.env });
      } catch {
        return res.status(400).json({ error: 'bad_request', message: 'callback_url must be a public https address.' });
      }

      const base = publicBaseFrom(req, d.env);
      const callerId = caller.caller_id;

      // Same run asked for again: answer as before.
      const existing = await d.repo.findByExternal(callerId, runId);
      if (existing) {
        const [status, out] = await answerFor(existing, base);
        return res.status(status).json(out);
      }

      const day = utcDay(d.now());
      const key = urlKey(site);
      const common = {
        caller_id: callerId,
        external_run_id: runId,
        url: site.slice(0, 1000),
        url_key: key,
        audit_day: day,
        callback_url: msg.callback_url,
        business_json: JSON.stringify(business),
        visitor_json: JSON.stringify({
          business: typeof msg.visitor?.business === 'string' ? msg.visitor.business.trim().slice(0, 200) : null,
          website: site,
        }),
      };

      // One audit per website per day per caller: a second ask today gets the
      // same report under links of its own.
      const today = await d.repo.findDoneToday(callerId, key, day);
      if (today) {
        const ins = await d.repo.insertRun({
          ...common,
          status: 'done',
          score: today.score,
          summary_plain: today.summary_plain,
          findings_json: today.findings_json,
          psi_json: today.psi_json,
          crawl_json: today.crawl_json,
          blob_path: today.blob_path,
          finished_at: new Date(d.now()),
          copied_from_run_id: today.copied_from_run_id || today.run_id,
        });
        const row = await d.repo.getRun(ins.run_id);
        const [status, out] = await answerFor(row, base);
        return res.status(status).json(out);
      }

      // The daily limit is checked and the run inserted in ONE step (a per-caller,
      // per-day lock in SQL), so a burst cannot slip past the count. Absent
      // limit means 0: fails closed.
      const ins = await d.repo.insertRun({ ...common, status: 'queued' }, { dailyLimit: caller.daily_limit ?? 0 });
      if (ins.overLimit) return res.json({ status: 'failed', error: WORDS.dailyLimit });
      if (!ins.inserted) {
        const [status, out] = await answerFor(await d.repo.getRun(ins.run_id), base);
        return res.status(status).json(out);
      }
      res.status(202).json({ status: 'accepted' });
      startRun(ins.run_id, base);
    } catch (err) {
      next(err);
    }
  });

  router.get('/files/:runId', async (req, res) => {
    const { runId } = req.params;
    const k = req.query.k;
    if (!GUID_RE.test(runId) || !looksLikeKey(k)) return plainPage(res, 404, WORDS.linkWrong);
    let row;
    try {
      row = await d.repo.getRun(runId);
    } catch (err) {
      d.log.error?.(`[audit] file lookup failed: ${err.message}`);
      return plainPage(res, 500, WORDS.fileTrouble);
    }
    if (!row || !row.blob_path) return plainPage(res, 404, WORDS.linkWrong);
    const owner = keyMatches(k, row.owner_key_hash);
    const visitor = !owner && keyMatches(k, row.visitor_key_hash);
    if (!owner && !visitor) return plainPage(res, 404, WORDS.linkWrong);
    if (visitor) {
      const exp = row.visitor_link_expires_at ? new Date(row.visitor_link_expires_at).getTime() : 0;
      if (!exp || exp < d.now()) {
        let name = null;
        try { name = JSON.parse(row.business_json || '{}').name || null; } catch { /* no name: generic words */ }
        return plainPage(res, 410, WORDS.linkExpired(name));
      }
    }
    try {
      const stream = await d.openPdf(row.blob_path);
      res.status(200).set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="website-audit.pdf"',
        'Cache-Control': 'private, max-age=0',
        'X-Content-Type-Options': 'nosniff',
      });
      stream.on('error', (err) => {
        d.log.error?.(`[audit] file stream failed: ${err.message}`);
        if (!res.headersSent) plainPage(res, 500, WORDS.fileTrouble); else res.destroy(err);
      });
      stream.pipe(res);
    } catch (err) {
      d.log.error?.(`[audit] file open failed: ${err.message}`);
      return plainPage(res, 500, WORDS.fileTrouble);
    }
  });

  return router;
}

// ---- the real wiring ------------------------------------------------------

const repo = createSqlRepo(getServicesPool);
const runner = createAuditRunner({
  repo,
  callerSecret: async (callerId) => {
    const caller = await getCallerById(await getServicesPool(), callerId);
    if (!caller) throw new Error('the caller was removed');
    return { caller, secret: decryptSecret(caller) };
  },
  publicBase: () => String(process.env.ARION_PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
});

export { repo as auditRepo, runner as auditRunner };

/**
 * Start again any run a restart or deploy dropped (lib/audit/runner.js sweep):
 * once shortly after boot, then every 5 minutes. Needs ARION_PUBLIC_BASE_URL,
 * because a run started here has no request to take the link address from;
 * without it the sweep stays off and says so (a repeat POST from the caller
 * still restarts a lost run).
 */
export function startAuditSweep({ firstMs = 30_000, everyMs = 5 * 60_000, env = process.env, log = console } = {}) {
  const base = String(env.ARION_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!base) {
    log.warn?.('[audit] the lost-run sweep is off: ARION_PUBLIC_BASE_URL is not set, so restarted runs could not build their links.');
    return null;
  }
  const tick = () => runner.sweep({ base }).then((done) => {
    if (done.length) log.log?.(`[audit] sweep: ${done.map(([id, what]) => `${id} ${what}`).join(', ')}`);
  }).catch((err) => log.error?.(`[audit] sweep failed: ${err.message}`));
  const first = setTimeout(tick, firstMs);
  const every = setInterval(tick, everyMs);
  first.unref?.();
  every.unref?.();
  return { stop: () => { clearTimeout(first); clearInterval(every); } };
}

export default createAuditRouter({
  repo,
  runner,
  findCaller: async (keyId) => getCallerByKeyId(await getServicesPool(), keyId),
  secretOf: (caller) => decryptSecret(caller),
  openPdf: realOpenPdf,
});
