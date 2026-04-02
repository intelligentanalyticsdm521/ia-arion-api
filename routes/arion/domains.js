import { Router } from 'express';
import sql from 'mssql';
import crypto from 'node:crypto';
import { getServicesPool } from '../../db/servicesPool.js';

const router = Router({ mergeParams: true });

const HOSTINGER_API_BASE = process.env.HOSTINGER_API_BASE || 'https://api.hostinger.com/v1';
const HOSTINGER_API_KEY = process.env.HOSTINGER_API_KEY;

async function hostingerFetch(endpoint, options = {}) {
  const url = HOSTINGER_API_BASE + endpoint;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + HOSTINGER_API_KEY,
      ...(options.headers || {})
    }
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.message || 'Hostinger API error');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// POST /search - domain availability search via Hostinger
router.post('/search', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { domain, tlds } = req.body;

  if (!domain || typeof domain !== 'string') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'domain is required', status: 400 } });
  }

  try {
    const searchTlds = Array.isArray(tlds) && tlds.length > 0 ? tlds : ['com', 'net', 'org'];
    const result = await hostingerFetch('/domains/availability', {
      method: 'POST',
      body: JSON.stringify({ domain, tlds: searchTlds })
    });

    res.json({ data: result, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[domains:search]', err);
    const status = err.status || 500;
    res.status(status).json({ error: { code: status === 500 ? 'INTERNAL_ERROR' : 'UPSTREAM_ERROR', message: err.message, status } });
  }
});

// POST /register - domain registration
router.post('/register', async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const siteId = req.params.siteId;
  const { domain, registrant, period_years = 1 } = req.body;

  if (!domain || typeof domain !== 'string') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'domain is required', status: 400 } });
  }

  if (!registrant || !registrant.email) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'registrant with email is required', status: 400 } });
  }

  try {
    const pool = await getServicesPool();

    // Check if domain already registered for this tenant
    const existing = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('domain', sql.NVarChar(253), domain.toLowerCase())
      .query('SELECT domain_id FROM arion.site_domain WHERE tenant_id = @tenantId AND domain_name = @domain');

    if (existing.recordset.length > 0) {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'Domain already registered for this tenant', status: 409 } });
    }

    // Register via Hostinger
    const registration = await hostingerFetch('/domains/register', {
      method: 'POST',
      body: JSON.stringify({ domain, registrant, period: period_years })
    });

    // Store in DB
    const domainId = crypto.randomUUID();
    await pool.request()
      .input('domainId', sql.UniqueIdentifier, domainId)
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('domainName', sql.NVarChar(253), domain.toLowerCase())
      .input('registrar', sql.NVarChar(50), 'hostinger')
      .input('registrationRef', sql.NVarChar(200), registration.order_id || null)
      .input('periodYears', sql.Int, period_years)
      .query(`
        INSERT INTO arion.site_domain
          (domain_id, tenant_id, site_id, domain_name, registrar, registration_ref, period_years, status, created_at)
        VALUES
          (@domainId, @tenantId, @siteId, @domainName, @registrar, @registrationRef, @periodYears, 'active', SYSDATETIMEOFFSET())
      `);

    res.json({ data: { domain_id: domainId, domain, registration_ref: registration.order_id || null, status: 'active' }, meta: { tenant_id: tenantId, timestamp: new Date().toISOString() } });
  } catch (err) {
    console.error('[domains:register]', err);
    const status = err.status || 500;
    res.status(status).json({ error: { code: status === 500 ? 'INTERNAL_ERROR' : 'UPSTREAM_ERROR', message: err.message, status } });
  }
});

export default router;
