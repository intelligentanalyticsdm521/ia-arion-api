import sql from 'mssql';
import crypto from 'node:crypto';

/**
 * Fire a platform event into argus.platform_events.
 * Accepts either a ConnectionPool or a Transaction as the first argument
 * so it can participate in the caller's transaction.
 *
 * @param {import('mssql').ConnectionPool | import('mssql').Transaction} poolOrTx
 * @param {object} opts
 * @param {string} opts.tenantId
 * @param {string} opts.eventType        e.g. 'arion.form.submitted'
 * @param {string} [opts.sourceProduct]  defaults to 'arion'
 * @param {object} [opts.payload]        JSON-serialisable
 * @param {string} [opts.eventRefId]     source record id
 * @returns {Promise<string>} eventId
 */
export async function firePlatformEvent(poolOrTx, { tenantId, eventType, sourceProduct = 'arion', payload = null, eventRefId = null }) {
  const eventId = crypto.randomUUID();
  await poolOrTx.request()
    .input('eventId', sql.UniqueIdentifier, eventId)
    .input('tenantId', sql.UniqueIdentifier, tenantId)
    .input('eventType', sql.NVarChar(100), eventType)
    .input('source', sql.NVarChar(50), sourceProduct)
    .input('payload', sql.NVarChar(sql.MAX), payload ? JSON.stringify(payload) : null)
    .input('eventRefId', sql.UniqueIdentifier, eventRefId)
    .query(`
      INSERT INTO argus.platform_events
        (event_id, tenant_id, event_type, source_product, payload, event_ref_id, status, created_at)
      VALUES
        (@eventId, @tenantId, @eventType, @source, @payload, @eventRefId, 'pending', SYSDATETIMEOFFSET())
    `);
  return eventId;
}
