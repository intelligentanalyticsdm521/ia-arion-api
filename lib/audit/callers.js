// lib/audit/callers.js
//
// Who may call the website audit tool, and the secret both sides sign with.
//
// A caller is any agency that registered the tool as its own custom action
// (scripts/register-audit-caller.mjs). Nothing in this file knows which agency;
// the row carries everything.
//
// THE SECRET IS STORED ENCRYPTED (AES-256-GCM) under AUDIT_CALLER_KEY, a
// 32-byte base64 key. It has to be recoverable in clear because we SIGN the
// callback with it as well as verify the request — a hash could only compare.
//
// FAILS CLOSED: no key (or a key that is not 32 bytes) throws AuditNotConfigured
// everywhere, laptop and App Service alike. There is no placeholder key to fall
// back to (the LUMEN vault's placeholder fallback is the defect this avoids —
// contract finding F1). The route answers 503 with a plain sentence.

import crypto from 'node:crypto';
import sql from 'mssql';

export class AuditNotConfigured extends Error {
  constructor(reason) {
    super(`[audit] AUDIT_CALLER_KEY is ${reason} — the audit tool cannot read or store caller secrets.`);
    this.name = 'AuditNotConfigured';
  }
}

/** The 32-byte key, or AuditNotConfigured. */
export function callerKey(env = process.env) {
  const raw = String(env.AUDIT_CALLER_KEY || '').trim();
  if (!raw) throw new AuditNotConfigured('not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new AuditNotConfigured('not a 32-byte base64 key');
  return key;
}

/** Clear secret -> { secret_iv, secret_tag, secret_ciphertext } (all base64). */
export function encryptSecret(clear, env = process.env) {
  if (!clear || typeof clear !== 'string') throw new Error('[audit] a secret is required');
  const key = callerKey(env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(clear, 'utf8'), cipher.final()]);
  return {
    secret_iv: iv.toString('base64'),
    secret_tag: cipher.getAuthTag().toString('base64'),
    secret_ciphertext: ct.toString('base64'),
  };
}

/** Row (with secret_iv/tag/ciphertext) -> clear secret. Throws on a tampered row. */
export function decryptSecret(row, env = process.env) {
  const key = callerKey(env);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(row.secret_iv, 'base64'));
  decipher.setAuthTag(Buffer.from(row.secret_tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(row.secret_ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

const CALLER_COLS = `caller_id, key_id, label, owner_tenant_id, secret_iv, secret_tag,
  secret_ciphertext, status, daily_limit, created_at, created_by`;

/** The ACTIVE caller for an X-Workflow-Key, or null. */
export async function getCallerByKeyId(pool, keyId) {
  if (!keyId || typeof keyId !== 'string' || keyId.length > 40) return null;
  const r = await pool.request()
    .input('k', sql.NVarChar(40), keyId)
    .query(`SELECT ${CALLER_COLS} FROM arion.site_audit_caller WHERE key_id = @k AND status = 'active'`);
  return r.recordset[0] || null;
}

export async function getCallerById(pool, callerId) {
  const r = await pool.request()
    .input('id', sql.UniqueIdentifier, callerId)
    .query(`SELECT ${CALLER_COLS} FROM arion.site_audit_caller WHERE caller_id = @id`);
  return r.recordset[0] || null;
}

/** The caller for a key id whatever its status (registration needs to see a switched-off one), or null. */
export async function getCallerByKeyIdAnyStatus(pool, keyId) {
  const r = await pool.request()
    .input('k', sql.NVarChar(40), keyId)
    .query(`SELECT ${CALLER_COLS} FROM arion.site_audit_caller WHERE key_id = @k`);
  return r.recordset[0] || null;
}

/** Registration refused: re-running for a key id must not quietly move it or switch it back on. */
export class CallerChangeRefused extends Error {
  constructor(message, code) { super(message); this.name = 'CallerChangeRefused'; this.code = code; }
}

/**
 * What registering this key id would do to the row that already has it.
 *   - no row: insert.
 *   - another owner: refused unless moveOwner (every past check's visibility moves with it).
 *   - switched off: refused unless reactivate.
 * Pure, so the rules are tested without a database.
 */
export function planCallerUpsert(existing, { ownerTenantId, moveOwner = false, reactivate = false }) {
  if (!existing) return { action: 'insert', status: 'active' };
  const sameOwner = String(existing.owner_tenant_id).toLowerCase() === String(ownerTenantId).toLowerCase();
  if (!sameOwner && !moveOwner) {
    return { refuse: new CallerChangeRefused(`Key ${existing.key_id} belongs to business ${existing.owner_tenant_id}, not ${ownerTenantId}. Nothing was changed. Re-run with --move-owner if its past website checks should move to the new business.`, 'owner_change') };
  }
  if (existing.status !== 'active' && !reactivate) {
    return { refuse: new CallerChangeRefused(`Key ${existing.key_id} is switched off (${existing.status}). Nothing was changed. Re-run with --reactivate to switch it back on.`, 'inactive') };
  }
  return { action: 'update', status: 'active', ownerChanged: !sameOwner, from: { owner: existing.owner_tenant_id, status: existing.status } };
}

/**
 * Register a caller, or replace the secret of an existing key id (the owner
 * pressed "Replace the secret" in their tool's settings). Returns caller_id.
 * Throws CallerChangeRefused when that would move the key to another business
 * or switch a switched-off key back on without saying so (planCallerUpsert).
 */
export async function upsertCaller(pool, { keyId, label, ownerTenantId, secret, dailyLimit = 50, createdBy = null, moveOwner = false, reactivate = false }, env = process.env) {
  const existing = await getCallerByKeyIdAnyStatus(pool, keyId);
  const plan = planCallerUpsert(existing, { ownerTenantId, moveOwner, reactivate });
  if (plan.refuse) throw plan.refuse;
  const enc = encryptSecret(secret, env);
  const r = await pool.request()
    .input('k', sql.NVarChar(40), keyId)
    .input('label', sql.NVarChar(200), label)
    .input('owner', sql.UniqueIdentifier, ownerTenantId)
    .input('iv', sql.NVarChar(48), enc.secret_iv)
    .input('tag', sql.NVarChar(48), enc.secret_tag)
    .input('ct', sql.NVarChar(sql.MAX), enc.secret_ciphertext)
    .input('lim', sql.Int, dailyLimit)
    .input('by', sql.NVarChar(200), createdBy)
    .input('move', sql.Bit, moveOwner ? 1 : 0)
    .input('react', sql.Bit, reactivate ? 1 : 0)
    .query(`
      IF EXISTS (SELECT 1 FROM arion.site_audit_caller WHERE key_id = @k)
      BEGIN
        -- The same rules again in SQL, in case the row changed since it was read.
        UPDATE arion.site_audit_caller
           SET label = @label, owner_tenant_id = @owner, secret_iv = @iv, secret_tag = @tag,
               secret_ciphertext = @ct, daily_limit = @lim, status = 'active'
         WHERE key_id = @k
           AND (owner_tenant_id = @owner OR @move = 1)
           AND (status = 'active' OR @react = 1);
        DECLARE @n INT = @@ROWCOUNT;
        SELECT caller_id, @n AS changed FROM arion.site_audit_caller WHERE key_id = @k;
      END
      ELSE
      BEGIN
        INSERT INTO arion.site_audit_caller
          (key_id, label, owner_tenant_id, secret_iv, secret_tag, secret_ciphertext, daily_limit, created_by)
        VALUES (@k, @label, @owner, @iv, @tag, @ct, @lim, @by);
        SELECT caller_id, 1 AS changed FROM arion.site_audit_caller WHERE key_id = @k;
      END`);
  const row = r.recordset[0];
  if (!row || !row.changed) throw new CallerChangeRefused(`Key ${keyId} changed while it was being registered. Nothing was changed. Run the command again.`, 'raced');
  return row.caller_id;
}

export default { AuditNotConfigured, CallerChangeRefused, callerKey, encryptSecret, decryptSecret, getCallerByKeyId, getCallerByKeyIdAnyStatus, getCallerById, planCallerUpsert, upsertCaller };
