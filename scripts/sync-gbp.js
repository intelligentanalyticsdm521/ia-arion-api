/**
 * GBP-only sync — separated because the Account Management API has a 1 req/min quota.
 */
import sql from 'mssql';
import crypto from 'node:crypto';
import { getServicesPool } from '../db/servicesPool.js';
import { getAccessToken } from '../lib/googleBusiness.js';
import { open as openToken } from '../lib/gbpTokenAtRest.js';

const TENANT_ID = '8c9527b9-8999-4b31-a306-f3d4ccc39fbd';

async function googleFetch(token, url) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Google API ${res.status}: ${t.slice(0, 300)}`); }
  return res.json();
}

async function main() {
  console.log('═══ GBP Sync ═══');
  const pool = await getServicesPool();
  const site = (await pool.request().input('t', sql.UniqueIdentifier, TENANT_ID)
    .query("SELECT site_id, tenant_id, gbp_oauth_token_ref FROM arion.site WHERE tenant_id=@t AND gbp_connected=1")).recordset[0];

  if (!site?.gbp_oauth_token_ref) { console.log('No token'); process.exit(1); }

  const tok = await getAccessToken(openToken(site.gbp_oauth_token_ref));
  if (!tok?.access_token) { console.log('Token refresh failed'); process.exit(1); }
  console.log('Got access token');

  // 1. Accounts
  const acctData = await googleFetch(tok.access_token, 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
  const account = acctData.accounts?.[0];
  console.log('Account:', account?.name, account?.accountName);
  if (!account) { console.log('No account'); process.exit(1); }

  // 2. Locations
  const locData = await googleFetch(tok.access_token,
    `https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title,storefrontAddress,websiteUri,phoneNumbers,categories,metadata`);
  const loc = locData.locations?.[0];
  console.log('Location:', loc?.name, loc?.title);
  if (!loc) { console.log('No locations'); process.exit(1); }

  // 3. Upsert profile
  const existing = await pool.request()
    .input('tenantId', sql.UniqueIdentifier, site.tenant_id)
    .input('siteId', sql.UniqueIdentifier, site.site_id)
    .query('SELECT profile_id FROM arion.gbp_profile WHERE tenant_id=@tenantId AND site_id=@siteId');

  const profileParams = {
    businessName: loc.title || null,
    phone: loc.phoneNumbers?.primaryPhone || null,
    website: loc.websiteUri || null,
    address: loc.storefrontAddress ? JSON.stringify(loc.storefrontAddress) : null,
    categories: loc.categories?.primaryCategory?.displayName || null,
  };

  if (existing.recordset.length === 0) {
    await pool.request()
      .input('profileId', sql.UniqueIdentifier, crypto.randomUUID())
      .input('tenantId', sql.UniqueIdentifier, site.tenant_id)
      .input('siteId', sql.UniqueIdentifier, site.site_id)
      .input('businessName', sql.NVarChar(200), profileParams.businessName)
      .input('phone', sql.NVarChar(30), profileParams.phone)
      .input('website', sql.NVarChar(500), profileParams.website)
      .input('address', sql.NVarChar(sql.MAX), profileParams.address)
      .input('categories', sql.NVarChar(sql.MAX), profileParams.categories)
      .query(`INSERT INTO arion.gbp_profile (profile_id, tenant_id, site_id, business_name, phone, website, address, categories)
              VALUES (@profileId, @tenantId, @siteId, @businessName, @phone, @website, @address, @categories)`);
    console.log('Created profile for', profileParams.businessName);
  } else {
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, site.tenant_id)
      .input('siteId', sql.UniqueIdentifier, site.site_id)
      .input('businessName', sql.NVarChar(200), profileParams.businessName)
      .input('phone', sql.NVarChar(30), profileParams.phone)
      .input('website', sql.NVarChar(500), profileParams.website)
      .input('address', sql.NVarChar(sql.MAX), profileParams.address)
      .input('categories', sql.NVarChar(sql.MAX), profileParams.categories)
      .query(`UPDATE arion.gbp_profile SET business_name=@businessName, phone=@phone, website=@website, address=@address, categories=@categories, last_synced_at=SYSDATETIMEOFFSET(), updated_at=SYSDATETIMEOFFSET() WHERE tenant_id=@tenantId AND site_id=@siteId`);
    console.log('Updated profile for', profileParams.businessName);
  }

  // 4. Reviews
  try {
    const revData = await googleFetch(tok.access_token, `https://mybusiness.googleapis.com/v4/${account.name}/${loc.name}/reviews?pageSize=50`);
    console.log('Reviews:', revData.totalReviewCount, 'total, avg:', revData.averageRating);
    let count = 0;
    for (const r of (revData.reviews || [])) {
      const ratingNum = { FIVE: 5, FOUR: 4, THREE: 3, TWO: 2, ONE: 1 }[r.starRating] || 0;
      try {
        await pool.request()
          .input('reviewId', sql.UniqueIdentifier, crypto.randomUUID())
          .input('tenantId', sql.UniqueIdentifier, site.tenant_id)
          .input('siteId', sql.UniqueIdentifier, site.site_id)
          .input('gbpReviewId', sql.NVarChar(200), r.reviewId)
          .input('reviewerName', sql.NVarChar(200), r.reviewer?.displayName || 'Anonymous')
          .input('starRating', sql.Int, ratingNum)
          .input('reviewText', sql.NVarChar(sql.MAX), r.comment || null)
          .input('replyText', sql.NVarChar(sql.MAX), r.reviewReply?.comment || null)
          .input('reviewDate', sql.DateTimeOffset, r.createTime ? new Date(r.createTime) : null)
          .query(`IF NOT EXISTS (SELECT 1 FROM arion.gbp_review WHERE tenant_id=@tenantId AND gbp_review_id=@gbpReviewId)
                  INSERT INTO arion.gbp_review (review_id, tenant_id, site_id, gbp_review_id, reviewer_name, star_rating, review_text, reply_text, review_date, synced_at)
                  VALUES (@reviewId, @tenantId, @siteId, @gbpReviewId, @reviewerName, @starRating, @reviewText, @replyText, @reviewDate, SYSDATETIMEOFFSET())`);
        count++;
      } catch (e) { console.error('Review error:', e.message); }
    }
    console.log(`Synced ${count} reviews`);
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, site.tenant_id)
      .input('siteId', sql.UniqueIdentifier, site.site_id)
      .input('reviewCount', sql.Int, revData.totalReviewCount || 0)
      .input('avgRating', sql.Decimal(3, 2), revData.averageRating || 0)
      .query('UPDATE arion.gbp_profile SET review_count=@reviewCount, avg_rating=@avgRating, updated_at=SYSDATETIMEOFFSET() WHERE tenant_id=@tenantId AND site_id=@siteId');
  } catch (e) { console.error('Reviews failed:', e.message); }

  console.log('═══ GBP Sync complete ═══');
  process.exit(0);
}

main();
