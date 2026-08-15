/**
 * hostingSnapshot.js — capture domain, DNS and SSL state into
 * arion.site_hosting_snapshot (migration 052).
 *
 * Brandon 2026-08-14: "Hosting we don't have a single report... We should have
 * data from hostinger that we can pull here, right?" We should, and we do — the
 * Hostinger integration exposes registration, DNS and SSL, and every call was
 * live-only. Nothing stored means nothing trended and no report possible.
 *
 * Read-only against Hostinger; the only write is our own snapshot row.
 * Every block is independently caught: a domain whose DNS lookup fails must
 * still get its SSL row, and a total failure must not cost the caller its own
 * work — this runs inside the nightly plugin snapshot.
 */
import sql from 'mssql';
import { getDnsRecords, getSslStatus, getDomainInfo } from './hostinger.js';

const daysUntil = (d) => {
  if (!d) return null;
  const t = new Date(d).getTime();
  if (!isFinite(t)) return null;
  return Math.round((t - Date.now()) / 86400000);
};

/**
 * @returns {Promise<{written: boolean, reason?: string}>}
 */
export async function captureHostingSnapshot(pool, site, log = () => {}) {
  const domain = String(site.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!domain) return { written: false, reason: 'no domain' };

  const row = {
    ssl_valid: null, ssl_issuer: null, ssl_expires_at: null, ssl_days_left: null,
    domain_expires_at: null, domain_days_left: null, domain_auto_renew: null, registrar: null,
    nameservers: null, a_record: null,
    has_spf: null, has_dkim: null, has_dmarc: null, mx_count: null,
    dns_record_count: null,
  };

  try {
    const ssl = await getSslStatus(domain);
    if (ssl) {
      row.ssl_valid = ssl.valid ?? ssl.status === 'active' ? 1 : 0;
      row.ssl_issuer = (ssl.issuer || ssl.provider || null)?.toString().slice(0, 200) ?? null;
      row.ssl_expires_at = ssl.expires_at || ssl.valid_until || ssl.expiresAt || null;
      row.ssl_days_left = daysUntil(row.ssl_expires_at);
    }
  } catch (e) { log(`  ssl skipped: ${e.message.slice(0, 80)}`); }

  try {
    const info = await getDomainInfo(domain);
    if (info) {
      row.domain_expires_at = info.expires_at || info.expiry_date || info.expiresAt || null;
      row.domain_days_left = daysUntil(row.domain_expires_at);
      row.domain_auto_renew = info.auto_renew ?? info.autoRenew ?? null;
      row.registrar = (info.registrar || info.provider || null)?.toString().slice(0, 200) ?? null;
    }
  } catch (e) { log(`  domain info skipped: ${e.message.slice(0, 80)}`); }

  try {
    const dns = await getDnsRecords(domain);
    const records = Array.isArray(dns) ? dns : dns?.records || [];
    if (records.length) {
      row.dns_record_count = records.length;
      const typed = (t) => records.filter((r) => String(r.type || '').toUpperCase() === t);
      const txt = typed('TXT').map((r) => String(r.content || r.value || '').toLowerCase());

      row.mx_count = typed('MX').length;
      // SPF and DMARC are TXT records with known prefixes. DKIM lives on a
      // selector subdomain, so its presence is inferred from the record name
      // rather than the value.
      row.has_spf = txt.some((v) => v.includes('v=spf1')) ? 1 : 0;
      row.has_dmarc = txt.some((v) => v.includes('v=dmarc1')) ? 1 : 0;
      row.has_dkim = records.some((r) => /_domainkey/i.test(String(r.name || ''))) ? 1 : 0;

      const ns = typed('NS').map((r) => r.content || r.value).filter(Boolean);
      if (ns.length) row.nameservers = ns.join(', ').slice(0, 500);
      const a = typed('A')[0];
      if (a) row.a_record = String(a.content || a.value || '').slice(0, 100);
    }
  } catch (e) { log(`  dns skipped: ${e.message.slice(0, 80)}`); }

  const anything = Object.values(row).some((v) => v !== null);
  if (!anything) return { written: false, reason: 'hostinger returned nothing' };

  const today = new Date().toISOString().slice(0, 10);
  await pool.request()
    .input('tenantId', sql.UniqueIdentifier, site.tenant_id)
    .input('siteId', sql.UniqueIdentifier, site.site_id)
    .input('day', sql.Date, today)
    .input('sslValid', sql.Bit, row.ssl_valid)
    .input('sslIssuer', sql.NVarChar(200), row.ssl_issuer)
    .input('sslExp', sql.DateTime2, row.ssl_expires_at)
    .input('sslDays', sql.Int, row.ssl_days_left)
    .input('domExp', sql.DateTime2, row.domain_expires_at)
    .input('domDays', sql.Int, row.domain_days_left)
    .input('domAuto', sql.Bit, row.domain_auto_renew == null ? null : (row.domain_auto_renew ? 1 : 0))
    .input('registrar', sql.NVarChar(200), row.registrar)
    .input('ns', sql.NVarChar(500), row.nameservers)
    .input('aRec', sql.NVarChar(100), row.a_record)
    .input('spf', sql.Bit, row.has_spf)
    .input('dkim', sql.Bit, row.has_dkim)
    .input('dmarc', sql.Bit, row.has_dmarc)
    .input('mx', sql.Int, row.mx_count)
    .input('dnsCount', sql.Int, row.dns_record_count)
    .query(`
      MERGE arion.site_hosting_snapshot AS tgt
      USING (VALUES (@siteId, @day)) AS src(site_id, snapshot_date)
        ON tgt.site_id = src.site_id AND tgt.snapshot_date = src.snapshot_date
      WHEN MATCHED THEN UPDATE SET
        ssl_valid = @sslValid, ssl_issuer = @sslIssuer, ssl_expires_at = @sslExp,
        ssl_days_left = @sslDays, domain_expires_at = @domExp, domain_days_left = @domDays,
        domain_auto_renew = @domAuto, registrar = @registrar, nameservers = @ns,
        a_record = @aRec, has_spf = @spf, has_dkim = @dkim, has_dmarc = @dmarc,
        mx_count = @mx, dns_record_count = @dnsCount, captured_at = SYSDATETIMEOFFSET()
      WHEN NOT MATCHED THEN INSERT
        (tenant_id, site_id, snapshot_date, ssl_valid, ssl_issuer, ssl_expires_at, ssl_days_left,
         domain_expires_at, domain_days_left, domain_auto_renew, registrar, nameservers, a_record,
         has_spf, has_dkim, has_dmarc, mx_count, dns_record_count)
      VALUES
        (@tenantId, @siteId, @day, @sslValid, @sslIssuer, @sslExp, @sslDays,
         @domExp, @domDays, @domAuto, @registrar, @ns, @aRec,
         @spf, @dkim, @dmarc, @mx, @dnsCount);`);

  return { written: true };
}

export default { captureHostingSnapshot };
