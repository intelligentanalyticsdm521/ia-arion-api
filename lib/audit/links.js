// lib/audit/links.js
//
// The two links to a report (contract §E.6): keyed links, not a SAS.
//
//   file_url        .../audit/files/<run_id>?k=<visitor key>  — the visitor's email; 30 days
//   owner_file_url  .../audit/files/<run_id>?k=<owner key>    — what the lead keeps; no expiry
//
// Each key is 32 random bytes (base64url). Only the sha256 of a key is stored,
// so a database read cannot rebuild a link. The comparison is constant-time.

import crypto from 'node:crypto';

export const VISITOR_LINK_DAYS = 30;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;

export const newKey = () => crypto.randomBytes(32).toString('base64url');
export const hashKey = (k) => crypto.createHash('sha256').update(String(k), 'utf8').digest('hex');
export const looksLikeKey = (k) => typeof k === 'string' && KEY_RE.test(k);

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

/** A fresh pair of keys and what to store for them. */
export function mintLinks(base, runId, nowMs = Date.now()) {
  const visitorKey = newKey();
  const ownerKey = newKey();
  return {
    file_url: fileUrl(base, runId, visitorKey),
    owner_file_url: fileUrl(base, runId, ownerKey),
    visitor_key_hash: hashKey(visitorKey),
    owner_key_hash: hashKey(ownerKey),
    visitor_link_expires_at: new Date(nowMs + VISITOR_LINK_DAYS * 24 * 3600 * 1000),
  };
}

export default { newKey, hashKey, keyMatches, fileUrl, mintLinks, looksLikeKey, VISITOR_LINK_DAYS };
