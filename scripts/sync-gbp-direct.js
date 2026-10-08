/**
 * GBP sync — bypasses the rate-limited Account Management API by
 * going directly to Business Information API with known account ID.
 */
import sql from 'mssql';
import crypto from 'node:crypto';
import { getServicesPool } from '../db/servicesPool.js';
import { getAccessToken } from '../lib/googleBusiness.js';
import { open as openToken } from '../lib/gbpTokenAtRest.js';

const TENANT_ID = '8c9527b9-8999-4b31-a306-f3d4ccc39fbd';
const KNOWN_ACCOUNT = 'accounts/116040733'; // IA's Google Business account

async function main() {
  console.log('=== GBP Direct Sync ===');
  const pool = await getServicesPool();
  const site = (await pool.request().input('t', sql.UniqueIdentifier, TENANT_ID)
    .query("SELECT site_id, tenant_id, gbp_oauth_token_ref FROM arion.site WHERE tenant_id=@t AND gbp_connected=1")).recordset[0];

  if (!site?.gbp_oauth_token_ref) { console.log('No token'); process.exit(1); }

  const tok = await getAccessToken(openToken(site.gbp_oauth_token_ref));
  if (!tok?.access_token) { console.log('Token refresh failed'); process.exit(1); }

  // Go directly to Business Information API (different quota from Account Management)
  console.log('Fetching locations from Business Information API...');
  const locRes = await fetch(`https://mybusinessbusinessinformation.googleapis.com/v1/${KNOWN_ACCOUNT}/locations?readMask=name,title,storefrontAddress,websiteUri,phoneNumbers,categories,metadata`, {
    headers: { Authorization: 'Bearer ' + tok.access_token }
  });
  if (!locRes.ok) { console.log('Locations failed:', locRes.status, await locRes.text().catch(() => '')); process.exit(1); }
  const locData = await locRes.json();
  const locations = locData.locations || [];
  console.log('Found', locations.length, 'locations');

  const iaLoc = locations.find(l => l.websiteUri?.includes('intelligentanalyticsdm'));
  if (!iaLoc) { console.log('IA location not found'); locations.forEach(l => console.log(' -', l.title, l.websiteUri)); process.exit(1); }

  console.log('Location:', iaLoc.title, iaLoc.name);

  // Upsert profile
  const existing = await pool.request().input('tenantId', sql.UniqueIdentifier, site.tenant_id).input('siteId', sql.UniqueIdentifier, site.site_id)
    .query('SELECT profile_id FROM arion.gbp_profile WHERE tenant_id=@tenantId AND site_id=@siteId');

  const p = { businessName: iaLoc.title, phone: iaLoc.phoneNumbers?.primaryPhone || null, website: iaLoc.websiteUri || null, address: iaLoc.storefrontAddress ? JSON.stringify(iaLoc.storefrontAddress) : null, categories: iaLoc.categories?.primaryCategory?.displayName || null };

  if (existing.recordset.length === 0) {
    await pool.request().input('profileId', sql.UniqueIdentifier, crypto.randomUUID()).input('tenantId', sql.UniqueIdentifier, site.tenant_id).input('siteId', sql.UniqueIdentifier, site.site_id)
      .input('bn', sql.NVarChar(200), p.businessName).input('ph', sql.NVarChar(30), p.phone).input('ws', sql.NVarChar(500), p.website).input('ad', sql.NVarChar(sql.MAX), p.address).input('cat', sql.NVarChar(sql.MAX), p.categories)
      .query('INSERT INTO arion.gbp_profile (profile_id, tenant_id, site_id, business_name, phone, website, address, categories) VALUES (@profileId, @tenantId, @siteId, @bn, @ph, @ws, @ad, @cat)');
    console.log('CREATED profile');
  } else {
    await pool.request().input('tenantId', sql.UniqueIdentifier, site.tenant_id).input('siteId', sql.UniqueIdentifier, site.site_id)
      .input('bn', sql.NVarChar(200), p.businessName).input('ph', sql.NVarChar(30), p.phone).input('ws', sql.NVarChar(500), p.website).input('ad', sql.NVarChar(sql.MAX), p.address).input('cat', sql.NVarChar(sql.MAX), p.categories)
      .query('UPDATE arion.gbp_profile SET business_name=@bn, phone=@ph, website=@ws, address=@ad, categories=@cat, last_synced_at=SYSDATETIMEOFFSET(), updated_at=SYSDATETIMEOFFSET() WHERE tenant_id=@tenantId AND site_id=@siteId');
    console.log('UPDATED profile');
  }

  // Reviews
  console.log('Fetching reviews...');
  const revRes = await fetch(`https://mybusiness.googleapis.com/v4/${KNOWN_ACCOUNT}/${iaLoc.name}/reviews?pageSize=50`, {
    headers: { Authorization: 'Bearer ' + tok.access_token }
  });
  if (revRes.ok) {
    const revData = await revRes.json();
    console.log('Total:', revData.totalReviewCount, 'Avg:', revData.averageRating);
    let count = 0;
    for (const r of (revData.reviews || [])) {
      const rating = { FIVE: 5, FOUR: 4, THREE: 3, TWO: 2, ONE: 1 }[r.starRating] || 0;
      try {
        await pool.request()
          .input('rid', sql.UniqueIdentifier, crypto.randomUUID()).input('tid', sql.UniqueIdentifier, site.tenant_id).input('sid', sql.UniqueIdentifier, site.site_id)
          .input('gid', sql.NVarChar(200), r.reviewId).input('rn', sql.NVarChar(200), r.reviewer?.displayName || 'Anonymous')
          .input('sr', sql.Int, rating).input('rt', sql.NVarChar(sql.MAX), r.comment || null)
          .input('rpt', sql.NVarChar(sql.MAX), r.reviewReply?.comment || null)
          .input('rd', sql.DateTimeOffset, r.createTime ? new Date(r.createTime) : null)
          .query(`IF NOT EXISTS (SELECT 1 FROM arion.gbp_review WHERE tenant_id=@tid AND gbp_review_id=@gid)
            INSERT INTO arion.gbp_review (review_id, tenant_id, site_id, gbp_review_id, reviewer_name, star_rating, review_text, reply_text, review_date, synced_at)
            VALUES (@rid, @tid, @sid, @gid, @rn, @sr, @rt, @rpt, @rd, SYSDATETIMEOFFSET())`);
        count++;
      } catch (e) { console.error('Review err:', e.message); }
    }
    console.log('Synced', count, 'reviews');
    await pool.request().input('tid', sql.UniqueIdentifier, site.tenant_id).input('sid', sql.UniqueIdentifier, site.site_id)
      .input('rc', sql.Int, revData.totalReviewCount || 0).input('ar', sql.Decimal(3, 2), revData.averageRating || 0)
      .query('UPDATE arion.gbp_profile SET review_count=@rc, avg_rating=@ar, updated_at=SYSDATETIMEOFFSET() WHERE tenant_id=@tid AND site_id=@sid');
  } else {
    console.log('Reviews failed:', revRes.status);
  }

  console.log('=== Done ===');
  process.exit(0);
}

main();
