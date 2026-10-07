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
import { createSqlRepo } from '../lib/audit/runs.js';
import { createAuditRunner, PLAIN } from '../lib/audit/runner.js';
import { normaliseSiteUrl, urlKey } from '../lib/audit/crawl.js';
import { checkUrl } from '../lib/audit/safeFetch.js';
import { mintLinks, keyMatches, looksLikeKey } from '../lib/audit/links.js';
import { openPdf as realOpenPdf } from '../lib/audit/store.js';
import { escapeHtml } from '../lib/audit/report.js';

export const TOOL_NAME = 'Website check';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export const WORDS = {
  notConfigured: "The website check can't run right now. Please try again later or contact support.",
  dailyLimit: "The audit tool's daily limit was reached.",
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

  /** What to say about a run that already exists. */
  async function answerFor(row, base) {
    if (row.status === 'queued' || row.status === 'running') return [202, { status: 'accepted' }];
    if ((row.status === 'done' || row.status === 'callback_failed') && row.blob_path) {
      const links = mintLinks(base, row.run_id, d.now());
      await d.repo.setLinks(row.run_id, links);
      return [200, { status: 'done', file_url: links.file_url, owner_file_url: links.owner_file_url, summary: row.summary_plain, score: row.score }];
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
        });
        const row = await d.repo.getRun(ins.run_id);
        const [status, out] = await answerFor(row, base);
        return res.status(status).json(out);
      }

      const used = await d.repo.countToday(callerId, day);
      if (used >= (caller.daily_limit ?? 0)) {
        return res.json({ status: 'failed', error: WORDS.dailyLimit });
      }

      const ins = await d.repo.insertRun({ ...common, status: 'queued' });
      if (!ins.inserted) {
        const [status, out] = await answerFor(await d.repo.getRun(ins.run_id), base);
        return res.status(status).json(out);
      }
      res.status(202).json({ status: 'accepted' });
      setImmediate(() => {
        Promise.resolve(d.runner.start(ins.run_id, { base })).catch((err) => d.log.error?.(`[audit] run ${ins.run_id} did not start: ${err.message}`));
      });
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

export default createAuditRouter({
  repo,
  runner,
  findCaller: async (keyId) => getCallerByKeyId(await getServicesPool(), keyId),
  secretOf: (caller) => decryptSecret(caller),
  openPdf: realOpenPdf,
});
