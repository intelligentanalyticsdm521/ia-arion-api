/**
 * Google Services - fetches data from Google APIs using stored refresh tokens.
 */

import { getAccessToken } from './googleBusiness.js';

function dateString(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().split('T')[0];
}

async function googleFetch(accessToken, method, url, body = undefined) {
  const headers = {
    Authorization: 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
  };
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Google API ' + res.status + ': ' + text.slice(0, 300));
  }
  return res.json();
}

export async function getSearchConsoleData(refreshToken, siteUrl, days = 28) {
  try {
    const tokenData = await getAccessToken(refreshToken);
    if (!tokenData) return null;
    const encodedSite = encodeURIComponent(siteUrl);
    const url = 'https://www.googleapis.com/webmasters/v3/sites/' + encodedSite + '/searchAnalytics/query';
    const body = { startDate: dateString(days), endDate: dateString(1), dimensions: ['query'], rowLimit: 25 };
    const data = await googleFetch(tokenData.access_token, 'POST', url, body);
    const rows = (data.rows || []).map(r => ({
      query: r.keys?.[0] || '', clicks: r.clicks || 0, impressions: r.impressions || 0, ctr: r.ctr || 0, position: r.position || 0,
    }));
    const summary = rows.reduce((acc, r) => { acc.clicks += r.clicks; acc.impressions += r.impressions; return acc; }, { clicks: 0, impressions: 0, ctr: 0, position: 0 });
    if (summary.impressions > 0) summary.ctr = summary.clicks / summary.impressions;
    if (rows.length > 0) summary.position = rows.reduce((s, r) => s + r.position, 0) / rows.length;
    return { queries: rows, summary };
  } catch (err) {
    console.error('[googleServices] getSearchConsoleData error:', err.message);
    return null;
  }
}

async function gscDimension(refreshToken, siteUrl, dimension, days, limit) {
  days = days || 28;
  limit = limit || 25;
  try {
    const tokenData = await getAccessToken(refreshToken);
    if (!tokenData) return null;
    const encodedSite = encodeURIComponent(siteUrl);
    const url = 'https://www.googleapis.com/webmasters/v3/sites/' + encodedSite + '/searchAnalytics/query';
    const body = { startDate: dateString(days), endDate: dateString(1), dimensions: [dimension], rowLimit: limit };
    const data = await googleFetch(tokenData.access_token, 'POST', url, body);
    return (data.rows || []).map(r => {
      const obj = { clicks: r.clicks || 0, impressions: r.impressions || 0, ctr: r.ctr || 0, position: r.position || 0 };
      obj[dimension] = r.keys?.[0] || '';
      return obj;
    });
  } catch (err) {
    console.error('[googleServices] gscDimension(' + dimension + ') error:', err.message);
    return null;
  }
}

export function getSearchConsolePages(refreshToken, siteUrl, days) {
  return gscDimension(refreshToken, siteUrl, 'page', days);
}
export function getSearchConsoleDevices(refreshToken, siteUrl, days) {
  return gscDimension(refreshToken, siteUrl, 'device', days, 10);
}
export function getSearchConsoleCountries(refreshToken, siteUrl, days) {
  return gscDimension(refreshToken, siteUrl, 'country', days);
}

export async function getAnalyticsData(refreshToken, propertyId, days) {
  days = days || 28;
  try {
    const tokenData = await getAccessToken(refreshToken);
    if (!tokenData) return null;
    const propPath = propertyId.startsWith('properties/') ? propertyId : 'properties/' + propertyId;
    const url = 'https://analyticsdata.googleapis.com/v1beta/' + propPath + ':runReport';
    const summaryBody = {
      dateRanges: [{ startDate: days + 'daysAgo', endDate: 'yesterday' }],
      metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }, { name: 'engagementRate' }, { name: 'averageSessionDuration' }, { name: 'conversions' }],
    };
    const summaryData = await googleFetch(tokenData.access_token, 'POST', url, summaryBody);
    const mv = summaryData.rows?.[0]?.metricValues || [];
    const summary = {
      users: parseInt(mv[0]?.value || '0', 10), sessions: parseInt(mv[1]?.value || '0', 10),
      views: parseInt(mv[2]?.value || '0', 10), engagementRate: parseFloat(mv[3]?.value || '0'),
      avgEngagementTimeSeconds: parseFloat(mv[4]?.value || '0'), conversions: parseInt(mv[5]?.value || '0', 10), revenueUsd: null,
    };

    let topPages = [];
    try {
      const pb = { dateRanges: [{ startDate: days + 'daysAgo', endDate: 'yesterday' }], dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }], limit: '10', orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }] };
      const pd = await googleFetch(tokenData.access_token, 'POST', url, pb);
      topPages = (pd.rows || []).map(r => ({ page: r.dimensionValues?.[0]?.value || '', views: parseInt(r.metricValues?.[0]?.value || '0', 10), users: parseInt(r.metricValues?.[1]?.value || '0', 10) }));
    } catch (e) { console.error('[googleServices] GA4 topPages error:', e.message); }

    let topSources = [];
    try {
      const sb = { dateRanges: [{ startDate: days + 'daysAgo', endDate: 'yesterday' }], dimensions: [{ name: 'sessionSource' }], metrics: [{ name: 'sessions' }, { name: 'activeUsers' }], limit: '10', orderBys: [{ metric: { metricName: 'sessions' }, desc: true }] };
      const sd = await googleFetch(tokenData.access_token, 'POST', url, sb);
      topSources = (sd.rows || []).map(r => ({ source: r.dimensionValues?.[0]?.value || '', sessions: parseInt(r.metricValues?.[0]?.value || '0', 10), users: parseInt(r.metricValues?.[1]?.value || '0', 10) }));
    } catch (e) { console.error('[googleServices] GA4 topSources error:', e.message); }

    let devices = [];
    try {
      const devBody = { dateRanges: [{ startDate: days + 'daysAgo', endDate: 'yesterday' }], dimensions: [{ name: 'deviceCategory' }], metrics: [{ name: 'sessions' }], limit: '5' };
      const dd = await googleFetch(tokenData.access_token, 'POST', url, devBody);
      devices = (dd.rows || []).map(r => ({ device: r.dimensionValues?.[0]?.value || '', sessions: parseInt(r.metricValues?.[0]?.value || '0', 10) }));
    } catch (e) { console.error('[googleServices] GA4 devices error:', e.message); }

    return { summary, topPages, topSources, devices, geos: [], landingPages: [] };
  } catch (err) {
    console.error('[googleServices] getAnalyticsData error:', err.message);
    return null;
  }
}

export async function getBusinessProfile(refreshToken) {
  try {
    const tokenData = await getAccessToken(refreshToken);
    if (!tokenData) return null;
    const token = tokenData.access_token;
    const accountsData = await googleFetch(token, 'GET', 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
    const accounts = (accountsData.accounts || []).map(a => ({ name: a.name, accountName: a.accountName, type: a.type }));
    let locations = [];
    if (accounts.length > 0) {
      try {
        const locData = await googleFetch(token, 'GET', 'https://mybusinessbusinessinformation.googleapis.com/v1/' + accounts[0].name + '/locations?readMask=name,title,storefrontAddress,websiteUri,phoneNumbers,categories,metadata');
        locations = (locData.locations || []).map(l => ({
          name: l.name, title: l.title, address: l.storefrontAddress || null, websiteUrl: l.websiteUri || null,
          phone: l.phoneNumbers?.primaryPhone || null, primaryCategory: l.categories?.primaryCategory?.displayName || null, mapsUri: l.metadata?.mapsUri || null,
        }));
      } catch (e) { console.error('[googleServices] GBP locations error:', e.message); }
    }
    return { accounts, locations };
  } catch (err) {
    console.error('[googleServices] getBusinessProfile error:', err.message);
    return null;
  }
}

export async function getReviews(refreshToken, accountId, locationId) {
  try {
    const tokenData = await getAccessToken(refreshToken);
    if (!tokenData) return null;
    const acctPath = accountId.startsWith('accounts/') ? accountId : 'accounts/' + accountId;
    const locPath = locationId.startsWith('locations/') ? locationId : 'locations/' + locationId;
    const data = await googleFetch(tokenData.access_token, 'GET', 'https://mybusiness.googleapis.com/v4/' + acctPath + '/' + locPath + '/reviews?pageSize=50');
    return {
      reviews: (data.reviews || []).map(r => ({
        reviewId: r.reviewId, reviewer: r.reviewer?.displayName || 'Anonymous', starRating: r.starRating,
        comment: r.comment || '', createTime: r.createTime, updateTime: r.updateTime, reviewReply: r.reviewReply?.comment || null,
      })),
      totalReviewCount: data.totalReviewCount || 0, averageRating: data.averageRating || 0,
    };
  } catch (err) {
    console.error('[googleServices] getReviews error:', err.message);
    return null;
  }
}

export async function getPerformanceMetrics(refreshToken, locationName, days) {
  days = days || 28;
  try {
    const tokenData = await getAccessToken(refreshToken);
    if (!tokenData) return null;
    const locPath = locationName.startsWith('locations/') ? locationName : 'locations/' + locationName;
    const startDate = new Date(); startDate.setDate(startDate.getDate() - days);
    const endDate = new Date(); endDate.setDate(endDate.getDate() - 1);
    const params = new URLSearchParams({
      'dailyRange.startDate.year': String(startDate.getFullYear()),
      'dailyRange.startDate.month': String(startDate.getMonth() + 1),
      'dailyRange.startDate.day': String(startDate.getDate()),
      'dailyRange.endDate.year': String(endDate.getFullYear()),
      'dailyRange.endDate.month': String(endDate.getMonth() + 1),
      'dailyRange.endDate.day': String(endDate.getDate()),
    });
    const metrics = ['BUSINESS_IMPRESSIONS_DESKTOP_MAPS','BUSINESS_IMPRESSIONS_DESKTOP_SEARCH','BUSINESS_IMPRESSIONS_MOBILE_MAPS','BUSINESS_IMPRESSIONS_MOBILE_SEARCH','WEBSITE_CLICKS','CALL_CLICKS','BUSINESS_DIRECTION_REQUESTS'];
    const url = 'https://businessprofileperformance.googleapis.com/v1/' + locPath + ':fetchMultiDailyMetricsTimeSeries?' + params + '&dailyMetrics=' + metrics.join('&dailyMetrics=');
    const data = await googleFetch(tokenData.access_token, 'GET', url);
    return data;
  } catch (err) {
    console.error('[googleServices] getPerformanceMetrics error:', err.message);
    return null;
  }
}
