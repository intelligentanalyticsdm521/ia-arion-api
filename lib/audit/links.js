// lib/audit/links.js
//
// The two links to a report (contract §E.6): keyed links, not a SAS.
//
//   file_url        .../audit/files/<run_id>?k=<visitor key>  — the visitor's email; 30 days
//   owner_file_url  .../audit/files/<run_id>?k=<owner key>    — what the lead keeps; no expiry
//
// EACH KEY IS DERIVED, NOT STORED. A key is HMAC-SHA256 over the run id and
// the link kind, under a sub-key of AUDIT_CALLER_KEY (the same secret that
// already protects every caller's signing secret). That gives 32 bytes that
// look random to anyone without the secret, and it means a repeat ask for the
// same run gets the SAME two links back. With random keys a retry had to
// re-key the run, and the links already emailed to the visitor and kept on
// the lead quietly stopped working (reviewer finding, 7 Oct 2026).
//
// Only the sha256 of each key is stored, so a database read alone cannot
// rebuild a link. Clearing a stored hash revokes that link. The comparison is
// constant-time. Fails closed: no AUDIT_CALLER_KEY, no links (AuditNotConfigured).

import crypto from 'node:crypto';
import { callerKey } from './callers.js';

export const VISITOR_LINK_DAYS = 30;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
export const KINDS = ['visitor', 'owner'];

export const hashKey = (k) => crypto.createHash('sha256').update(String(k), 'utf8').digest('hex');
export const looksLikeKey = (k) => typeof k === 'string' && KEY_RE.test(k);

/** The link key for one run and kind ('visitor' | 'owner'). */
export function linkKey(runId, kind, env = process.env) {
  if (!KINDS.includes(kind)) throw new Error(`[audit links] unknown link kind ${kind}`);
  const sub = crypto.createHmac('sha256', callerKey(env)).update('site-audit-link-key/v1').digest();
  return crypto.createHmac('sha256', sub).update(`${kind}:${String(runId).toLowerCase()}`).digest('base64url');
}

/** Constant-time: does this key hash to the stored hash? */
export function keyMatches(key, storedHash) {
  if (!looksLikeKey(key) || typeof storedHash !== 'string' || storedHash.length !== 64) return false;
  const a = Buffer.from(hashKey(key), 'utf8');
  const b = Buffer.from(storedHash.toLowerCase(), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function fileUrl(base, runId, key) {
  return `${String(base).replace(/\/+$/, '')}/audit/files/${String(runId).toLowerCase()}?k=${key}`;
}

/** The run's two links and their hashes. The same run always gives the same pair. */
export function linksFor(base, runId, env = process.env) {
  const visitorKey = linkKey(runId, 'visitor', env);
  const ownerKey = linkKey(runId, 'owner', env);
  return {
    file_url: fileUrl(base, runId, visitorKey),
    owner_file_url: fileUrl(base, runId, ownerKey),
    visitor_key_hash: hashKey(visitorKey),
    owner_key_hash: hashKey(ownerKey),
  };
}

/** The links plus what to store the first time: the hashes and the visitor link's expiry. */
export function mintLinks(base, runId, nowMs = Date.now(), env = process.env) {
  return { ...linksFor(base, runId, env), visitor_link_expires_at: new Date(nowMs + VISITOR_LINK_DAYS * 24 * 3600 * 1000) };
}

/** True when the stored hashes are this run's derived keys (false for a run keyed some other way). */
export function storedLinksAreOurs(row, env = process.env) {
  if (!row?.visitor_key_hash || !row?.owner_key_hash) return false;
  const l = linksFor('x', row.run_id, env);
  return l.visitor_key_hash === String(row.visitor_key_hash).toLowerCase() && l.owner_key_hash === String(row.owner_key_hash).toLowerCase();
}

export default { hashKey, keyMatches, fileUrl, linkKey, linksFor, mintLinks, storedLinksAreOurs, looksLikeKey, VISITOR_LINK_DAYS };
