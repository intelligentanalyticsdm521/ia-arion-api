/**
 * Site provisioning codes.
 *
 * Lifecycle:
 *   1. IA staff (or the onboarding function app) calls
 *      POST /internal/provision-codes/create { siteId } — returns raw code.
 *   2. Staff shares the code with the client (or embeds it in onboarding).
 *   3. Client installs the plugin, pastes the code into Settings →
 *      "Connect to ARION", plugin calls its own /provision/redeem which
 *      calls our /public/provision-codes/redeem { code, site_url, admin_email }.
 *   4. We validate + mark redeemed + generate a new site_token (returning
 *      the raw token to the plugin, storing the hash).
 *
 * Format: "IAPV-XXXX-XXXX-XXXX" (18 chars including prefix + dashes,
 * excluding confusing chars 0/O/I/1).
 */

import crypto from 'node:crypto';
import sql from 'mssql';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // removed 0 O 1 I
const CODE_GROUP_LEN = 4;
const CODE_GROUPS = 3;
const CODE_PREFIX = 'IAPV';
const DEFAULT_TTL_DAYS = 7;

/** Generate a fresh provisioning code like IAPV-ABCD-EFGH-JKLM. */
export function generateProvisionCode() {
  const groups = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    let group = '';
    const bytes = crypto.randomBytes(CODE_GROUP_LEN);
    for (let i = 0; i < CODE_GROUP_LEN; i++) {
      group += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    groups.push(group);
  }
  return `${CODE_PREFIX}-${groups.join('-')}`;
}

/** SHA-256 hash of a provisioning code (code itself is never stored). */
export function hashProvisionCode(code) {
  return crypto.createHash('sha256').update(code.toUpperCase().trim()).digest('hex');
}

/** Validate the textual format without DB lookup. */
export function isValidCodeFormat(code) {
  if (typeof code !== 'string') return false;
  const pattern = new RegExp(`^${CODE_PREFIX}-[A-Z2-9]{${CODE_GROUP_LEN}}-[A-Z2-9]{${CODE_GROUP_LEN}}-[A-Z2-9]{${CODE_GROUP_LEN}}$`);
  return pattern.test(code.toUpperCase().trim());
}

/**
 * Create a new provisioning code row for a site.
 * Returns { code_id, code, expires_at } — the raw `code` is ONLY returned here.
 */
export async function createProvisionCode(pool, { tenantId, siteId, createdBy, ttlDays = DEFAULT_TTL_DAYS }) {
  const code = generateProvisionCode();
  const codeHash = hashProvisionCode(code);
  const expiresAt = new Date(Date.now() + ttlDays * 86400_000);

  const result = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('siteId', sql.UniqueIdentifier, siteId)
    .input('codeHash', sql.NVarChar(64), codeHash)
    .input('createdBy', sql.NVarChar(100), createdBy || null)
    .input('expiresAt', sql.DateTimeOffset, expiresAt)
    .query(`
      INSERT INTO arion.site_provision_code
        (tenant_id, site_id, code_hash, created_by, expires_at)
      OUTPUT inserted.code_id
      VALUES (@tenantId, @siteId, @codeHash, @createdBy, @expiresAt)
    `);

  return {
    code_id: result.recordset[0].code_id,
    code,
    expires_at: expiresAt.toISOString(),
  };
}

/**
 * Redeem a provisioning code. Single-use. Marks redeemed_at + stores the
 * caller-reported home URL.
 *
 * Returns { ok, code_row, reason } where reason is one of:
 *   - 'invalid_format'
 *   - 'not_found'
 *   - 'already_redeemed'
 *   - 'expired'
 *   - 'revoked'
 */
export async function redeemProvisionCode(pool, { code, fromUrl }) {
  if (!isValidCodeFormat(code)) {
    return { ok: false, reason: 'invalid_format' };
  }
  const codeHash = hashProvisionCode(code);

  const transaction = pool.transaction();
  await transaction.begin();

  try {
    const result = await transaction.request()
      .input('codeHash', sql.NVarChar(64), codeHash)
      .query(`
        SELECT TOP 1 code_id, tenant_id, site_id, expires_at, redeemed_at, revoked_at
        FROM arion.site_provision_code
        WHERE code_hash = @codeHash
      `);

    if (result.recordset.length === 0) {
      await transaction.commit();
      return { ok: false, reason: 'not_found' };
    }

    const row = result.recordset[0];
    if (row.revoked_at) {
      await transaction.commit();
      return { ok: false, reason: 'revoked' };
    }
    if (row.redeemed_at) {
      await transaction.commit();
      return { ok: false, reason: 'already_redeemed' };
    }
    if (new Date(row.expires_at) < new Date()) {
      await transaction.commit();
      return { ok: false, reason: 'expired' };
    }

    await transaction.request()
      .input('codeId', sql.UniqueIdentifier, row.code_id)
      .input('fromUrl', sql.NVarChar(500), fromUrl || null)
      .query(`
        UPDATE arion.site_provision_code
        SET redeemed_at = SYSDATETIMEOFFSET(),
            redeemed_from_url = @fromUrl
        WHERE code_id = @codeId
      `);

    await transaction.commit();

    return {
      ok: true,
      code_row: {
        code_id: row.code_id,
        tenant_id: row.tenant_id,
        site_id: row.site_id,
      },
    };
  } catch (err) {
    await transaction.rollback();
    throw err;
  }
}
