// lib/audit/signature.js
//
// The custom-action signature, the same scheme the calling side uses
// (contract §C.9 step 4):
//
//   X-Workflow-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + "." + rawBody)>
//
// The RAW request bytes are signed, which is why routes/audit.js is mounted
// before express.json. A signature is good only within 300 seconds of `t`
// (the replay window). Comparison is constant-time with an equal-length check
// first (timingSafeEqual throws on unequal lengths).

import crypto from 'node:crypto';

export const WINDOW_SECONDS = 300;

function hmacHex(secret, t, rawBody) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  return crypto.createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${t}.`, 'utf8'), body]))
    .digest('hex');
}

/** The header value for a body, signed now (or at `nowMs`). */
export function sign(rawBody, secret, nowMs = Date.now()) {
  const t = Math.floor(nowMs / 1000);
  return `t=${t},v1=${hmacHex(secret, t, rawBody)}`;
}

function parseHeader(header) {
  const out = {};
  for (const part of String(header || '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * @returns {{ ok: true } | { ok: false, error: 'bad_signature' | 'stale_signature' }}
 */
export function verify(rawBody, header, secret, nowMs = Date.now()) {
  if (!secret) return { ok: false, error: 'bad_signature' };
  const { t, v1 } = parseHeader(header);
  if (!t || !v1 || !/^\d{1,12}$/.test(t) || !/^[0-9a-f]{64}$/i.test(v1)) {
    return { ok: false, error: 'bad_signature' };
  }
  const expected = Buffer.from(hmacHex(secret, Number(t), rawBody), 'utf8');
  const given = Buffer.from(v1.toLowerCase(), 'utf8');
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, error: 'bad_signature' };
  }
  if (Math.abs(Math.floor(nowMs / 1000) - Number(t)) > WINDOW_SECONDS) {
    return { ok: false, error: 'stale_signature' };
  }
  return { ok: true };
}

export default { sign, verify, WINDOW_SECONDS };
