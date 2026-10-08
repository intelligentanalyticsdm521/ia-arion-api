// lib/gbpTokenAtRest.js — the Google refresh token, sealed while it sits in the database.
//
// arion.site.gbp_oauth_token_ref (and its sibling gsc_oauth_token_ref) held the
// Google refresh token in clear text, despite the _ref name. Every other
// credential column in the schema holds a vault reference, ciphertext or a
// hash. This module is the ONLY place in lib/ and routes/ that reads those two
// columns (test/gbp-token-at-rest.test.mjs fails if any other file names them
// outside a SQL string), so a new reader cannot skip open().
//
// Stored shape when sealed:  enc:v1:<base64 iv>:<base64 tag>:<base64 ciphertext>
// AES-256-GCM under GBP_TOKEN_KEY (base64, 32 bytes). The cipher primitives are
// the ones the website-audit caller secrets already use (lib/audit/callers.js).
//
// SHIPS BEFORE THE KEY EXISTS:
//   - store: key set -> sealed; key unset -> the token as it is, with ONE warning
//     per process saying tokens are being stored unsealed.
//   - open: an enc:v1: value is decrypted, and a missing, malformed or wrong key
//     (or a tampered value) FAILS CLOSED with a plain sentence. Ciphertext is
//     never handed back as if it were a token. Any other non-empty value is a
//     legacy clear token: returned as it is and counted (legacyReads()), so the
//     code works before scripts/encrypt-gbp-tokens.mjs rewrites the rows.

import sql from 'mssql';
import { encryptSecret, decryptSecret } from './audit/callers.js';

export const SEALED_PREFIX = 'enc:v1:';

/** What an owner (or a log) reads when a stored connection cannot be opened. Plain words, no key names. */
export const UNREADABLE_WORDS = 'The saved Google connection for this website could not be read on this server, so nothing was sent to Google. Connect Google again in Settings.';
export const BAD_KEY_WORDS = 'The server setting that seals saved Google connections is not a valid key, so no Google connection was saved or read.';

export class GbpTokenUnreadable extends Error {
  constructor(message = UNREADABLE_WORDS) {
    super(message);
    this.name = 'GbpTokenUnreadable';
    this.code = 'gbp_token_unreadable';
  }
}

/** The 32-byte key as base64, or null when the setting is unset. A set but malformed key throws (never treated as unset). */
export function tokenKey(env = process.env) {
  const raw = String(env.GBP_TOKEN_KEY || '').trim();
  if (!raw) return null;
  if (Buffer.from(raw, 'base64').length !== 32) throw new GbpTokenUnreadable(BAD_KEY_WORDS);
  return raw;
}

export function isSealed(value) {
  return typeof value === 'string' && value.startsWith(SEALED_PREFIX);
}

/** Clear token -> enc:v1:<iv>:<tag>:<ciphertext>. Requires the key. */
export function seal(token, env = process.env) {
  if (!token || typeof token !== 'string') throw new Error('A token is required to seal.');
  if (isSealed(token)) throw new Error('That value is already sealed.');
  const key = tokenKey(env);
  if (!key) throw new GbpTokenUnreadable(BAD_KEY_WORDS);
  const enc = encryptSecret(token, { AUDIT_CALLER_KEY: key });
  return `${SEALED_PREFIX}${enc.secret_iv}:${enc.secret_tag}:${enc.secret_ciphertext}`;
}

let legacyCount = 0;
/** How many clear (not yet sealed) tokens this process has read. */
export function legacyReads() { return legacyCount; }
export function resetLegacyReads() { legacyCount = 0; }

/**
 * Stored value -> the token (or null when empty).
 * enc:v1: -> decrypted; fails closed. Anything else non-empty -> as it is, counted as legacy.
 */
export function open(value, env = process.env) {
  if (value === null || value === undefined) return null;
  const v = String(value);
  if (!v.trim()) return null;
  if (!isSealed(v)) {
    legacyCount += 1;
    return v;
  }
  const parts = v.slice(SEALED_PREFIX.length).split(':');
  if (parts.length !== 3 || parts.some((p) => !p)) throw new GbpTokenUnreadable();
  // GCM accepts a shortened tag unless the length is pinned: a 16-byte tag and a
  // 12-byte iv, exactly, or the value is unreadable (fail closed).
  if (Buffer.from(parts[1], 'base64').length !== 16 || Buffer.from(parts[0], 'base64').length !== 12) throw new GbpTokenUnreadable();
  let key;
  try { key = tokenKey(env); } catch { throw new GbpTokenUnreadable(); }
  if (!key) throw new GbpTokenUnreadable();
  let clear;
  try {
    clear = decryptSecret({ secret_iv: parts[0], secret_tag: parts[1], secret_ciphertext: parts[2] }, { AUDIT_CALLER_KEY: key });
  } catch {
    throw new GbpTokenUnreadable();
  }
  if (!clear || isSealed(clear)) throw new GbpTokenUnreadable();
  return clear;
}

let warnedUnsealed = false;
/** For tests: let the once-per-process warning fire again. */
export function resetStoreWarning() { warnedUnsealed = false; }

/**
 * The value to WRITE to the column for a fresh refresh token.
 * Key set -> sealed. Key unset -> the token as it is, and one warning per process.
 */
export function forStore(token, env = process.env, log = console) {
  if (!token) return null;
  if (tokenKey(env)) return seal(token, env);
  if (!warnedUnsealed) {
    warnedUnsealed = true;
    log.warn('[gbp-token] GBP_TOKEN_KEY is unset: Google refresh tokens are being stored unsealed. Set it and run scripts/encrypt-gbp-tokens.mjs.');
  }
  return token;
}

/**
 * THE write of a fresh refresh token (the Google connect callback). Sealed when
 * the key is set; marks Business Profile and Search Console connected.
 */
export async function storeGoogleRefreshToken(pool, { tenantId, siteId, refreshToken }, env = process.env, log = console) {
  const stored = forStore(refreshToken, env, log);
  if (!stored) throw new Error('A refresh token is required.');
  return pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('siteId', sql.UniqueIdentifier, siteId)
    .input('refreshToken', sql.NVarChar(2000), stored)
    .query(`
      UPDATE arion.site
      SET gbp_oauth_token_ref = @refreshToken,
          gbp_connected = 1,
          gsc_connected = 1,
          updated_at = GETUTCDATE()
      WHERE tenant_id = @tenantId AND site_id = @siteId
    `);
}

/* ── Readers. Every read of the two columns in lib/ and routes/ is one of these. ── */

/** True when the site has a stored Google Business Profile token (sealed or not). Never opens it. */
export function hasSiteToken(site) {
  return !!(site && site.gbp_oauth_token_ref);
}

/** True when the site has a stored Search Console token, or the Business Profile one it falls back to. */
export function hasSearchToken(site) {
  return !!(site && (site.gsc_oauth_token_ref || site.gbp_oauth_token_ref));
}

/** The Business Profile refresh token, opened. null when there is none. Fails closed. */
export function siteRefreshToken(site, env = process.env) {
  return site ? open(site.gbp_oauth_token_ref, env) : null;
}

/** The Search Console token (falls back to the Business Profile one), opened. null when there is none. Fails closed. */
export function siteSearchToken(site, env = process.env) {
  if (!site) return null;
  return open(site.gsc_oauth_token_ref || site.gbp_oauth_token_ref, env);
}

export default {
  SEALED_PREFIX, UNREADABLE_WORDS, BAD_KEY_WORDS, GbpTokenUnreadable, tokenKey, isSealed, seal, open,
  legacyReads, resetLegacyReads, forStore, resetStoreWarning, storeGoogleRefreshToken, hasSiteToken, hasSearchToken, siteRefreshToken, siteSearchToken,
};
