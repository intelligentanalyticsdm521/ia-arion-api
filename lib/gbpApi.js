/**
 * Google Business Profile API helpers.
 * Consolidated read + write helpers for My Business Information API v1,
 * Business Profile Performance API, and My Business v4 (reviews/posts/questions).
 */

import { getAccessToken } from './googleBusiness.js';

async function googleFetch(accessToken, method, url, body = undefined) {
  const headers = {
    Authorization: 'Bearer ' + accessToken,
    'Content-Type': 'application/json',
  };
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error('Google API ' + res.status + ': ' + text.slice(0, 300));
    err.status = res.status;
    err.body = text;
    // Detect the Business Profile API "zero quota" case — the Google Cloud project
    // has the API enabled but no quota allocated. This is not an auth failure and
    // not a missing location; the UI needs to guide the user to request quota.
    if (res.status === 429 && /RATE_LIMIT_EXCEEDED|quota|quota_limit_value.*0/i.test(text)) {
      err.code = 'gbp_quota_exceeded';
    } else if (res.status === 403 && /disabled|has not been used|SERVICE_DISABLED/i.test(text)) {
      err.code = 'gbp_api_disabled';
    }
    throw err;
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/**
 * Resolve a usable locationName (`accounts/{accountId}/locations/{locationId}`)
 * for a token. If one isn't already stored on the site, fetch accounts then the
 * first location under the first account.
 */
export async function resolveGbpLocationName(accessToken) {
  let accountsData;
  try {
    accountsData = await googleFetch(accessToken, 'GET', 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
  } catch (err) {
    // Re-throw with the code so the caller can surface a specific UI message
    if (err.code) { err.resolvePath = 'accounts'; throw err; }
    throw err;
  }
  const accounts = accountsData.accounts || [];
  if (accounts.length === 0) return null;
  const accountName = accounts[0].name; // "accounts/{accountId}"
  // Fetch locations for that account
  const readMask = 'name';
  const locUrl = 'https://mybusinessbusinessinformation.googleapis.com/v1/' + accountName + '/locations?readMask=' + encodeURIComponent(readMask) + '&pageSize=100';
  const locData = await googleFetch(accessToken, 'GET', locUrl);
  const locations = locData.locations || [];
  if (locations.length === 0) return null;
  // location.name is "locations/{locationId}" — combine with account
  const locationName = `${accountName}/${locations[0].name}`;
  return locationName;
}

/**
 * Fetch full business info via My Business Information API v1.
 * Returns the raw GBP location object. Caller should format the address per spec.
 */
export async function fetchBusinessInfo(refreshToken, locationName) {
  const tokenData = await getAccessToken(refreshToken);
  if (!tokenData) return null;
  let locName = locationName;
  if (!locName) {
    locName = await resolveGbpLocationName(tokenData.access_token);
    if (!locName) return { error: 'location_not_found' };
  }
  // locName is "accounts/{a}/locations/{l}" — the Information API uses "locations/{l}" only
  const locOnly = locName.split('/').slice(-2).join('/'); // "locations/{l}"
  const readMask = 'name,title,storefrontAddress,websiteUri,phoneNumbers,categories,regularHours,specialHours,profile,metadata';
  const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${locOnly}?readMask=${encodeURIComponent(readMask)}`;
  try {
    const data = await googleFetch(tokenData.access_token, 'GET', url);
    return { location: data, locationName: locName };
  } catch (err) {
    if (err.status === 401) return { error: 'gbp_auth_expired' };
    if (err.status === 404) return { error: 'location_not_found' };
    console.error('[gbpApi] fetchBusinessInfo error:', err.message);
    return { error: err.message };
  }
}

/**
 * PATCH business info via My Business Information API v1.
 * Accepts a partial update object and an updateMask string.
 */
export async function patchBusinessInfo(refreshToken, locationName, updateMask, body) {
  const tokenData = await getAccessToken(refreshToken);
  if (!tokenData) return { error: 'no_token' };
  const locOnly = locationName.split('/').slice(-2).join('/');
  const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${locOnly}?updateMask=${encodeURIComponent(updateMask)}`;
  try {
    const data = await googleFetch(tokenData.access_token, 'PATCH', url, body);
    return { location: data };
  } catch (err) {
    console.error('[gbpApi] patchBusinessInfo error:', err.message);
    return { error: err.message };
  }
}

/**
 * Fetch Business Profile Performance metrics (impressions, clicks, calls, etc.).
 * Period in days. Returns totals + daily breakdown.
 */
export async function fetchPerformance(refreshToken, locationName, period = 30) {
  const tokenData = await getAccessToken(refreshToken);
  if (!tokenData) return { error: 'no_token' };
  const locOnly = locationName.split('/').slice(-2).join('/');
  const endDate = new Date(); endDate.setDate(endDate.getDate() - 1); // yesterday
  const startDate = new Date(); startDate.setDate(startDate.getDate() - period);
  const dailyMetrics = [
    'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
    'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
    'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
    'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    'CALL_CLICKS',
    'WEBSITE_CLICKS',
    'BUSINESS_DIRECTION_REQUESTS',
    'BUSINESS_CONVERSATIONS',
    'BUSINESS_BOOKINGS',
  ];
  const params = new URLSearchParams({
    'dailyRange.startDate.year': String(startDate.getFullYear()),
    'dailyRange.startDate.month': String(startDate.getMonth() + 1),
    'dailyRange.startDate.day': String(startDate.getDate()),
    'dailyRange.endDate.year': String(endDate.getFullYear()),
    'dailyRange.endDate.month': String(endDate.getMonth() + 1),
    'dailyRange.endDate.day': String(endDate.getDate()),
  });
  const url = `https://businessprofileperformance.googleapis.com/v1/${locOnly}:fetchMultiDailyMetricsTimeSeries?${params}&` + dailyMetrics.map(m => `dailyMetrics=${m}`).join('&');
  try {
    const data = await googleFetch(tokenData.access_token, 'GET', url);
    return { data };
  } catch (err) {
    console.error('[gbpApi] fetchPerformance error:', err.message);
    return { error: err.message };
  }
}

/**
 * Parse multi-daily metric timeseries into totals + dailyBreakdown.
 * `multiDailyMetricTimeSeries` is the top-level GBP Performance API response field.
 */
export function summarizePerformance(perfPayload) {
  const series = perfPayload?.multiDailyMetricTimeSeries?.[0]?.dailyMetricTimeSeries || [];
  // Index metrics by name
  const byMetric = {};
  for (const s of series) {
    const metric = s.dailyMetric;
    const values = s.timeSeries?.datedValues || [];
    byMetric[metric] = values;
  }
  const get = (m) => byMetric[m] || [];
  const sumM = (m) => get(m).reduce((s, v) => s + Number(v.value || 0), 0);
  // Dates come from the first metric series (all share the same dates)
  const firstSeries = series[0];
  const dates = (firstSeries?.timeSeries?.datedValues || []).map(d => {
    const date = d.date;
    return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
  });
  const daily = dates.map((d, i) => {
    const at = (m) => Number(get(m)[i]?.value || 0);
    const impressions =
      at('BUSINESS_IMPRESSIONS_DESKTOP_MAPS') +
      at('BUSINESS_IMPRESSIONS_DESKTOP_SEARCH') +
      at('BUSINESS_IMPRESSIONS_MOBILE_MAPS') +
      at('BUSINESS_IMPRESSIONS_MOBILE_SEARCH');
    return {
      date: d,
      impressions,
      calls: at('CALL_CLICKS'),
      websiteClicks: at('WEBSITE_CLICKS'),
      directions: at('BUSINESS_DIRECTION_REQUESTS'),
    };
  });
  const impressionsDesktopMaps = sumM('BUSINESS_IMPRESSIONS_DESKTOP_MAPS');
  const impressionsDesktopSearch = sumM('BUSINESS_IMPRESSIONS_DESKTOP_SEARCH');
  const impressionsMobileMaps = sumM('BUSINESS_IMPRESSIONS_MOBILE_MAPS');
  const impressionsMobileSearch = sumM('BUSINESS_IMPRESSIONS_MOBILE_SEARCH');
  return {
    impressions: impressionsDesktopMaps + impressionsDesktopSearch + impressionsMobileMaps + impressionsMobileSearch,
    impressionsDesktopMaps,
    impressionsDesktopSearch,
    impressionsMobileMaps,
    impressionsMobileSearch,
    calls: sumM('CALL_CLICKS'),
    websiteClicks: sumM('WEBSITE_CLICKS'),
    directionsRequests: sumM('BUSINESS_DIRECTION_REQUESTS'),
    conversations: sumM('BUSINESS_CONVERSATIONS'),
    bookings: sumM('BUSINESS_BOOKINGS'),
    dailyBreakdown: daily,
  };
}

/**
 * Format a GBP storefrontAddress into a single-line string.
 * Returns null if the address is missing core fields. Never returns the string "null".
 */
export function formatAddress(storefront) {
  if (!storefront || typeof storefront !== 'object') return null;
  const lines = Array.isArray(storefront.addressLines) ? storefront.addressLines.filter(Boolean) : [];
  const locality = storefront.locality || '';
  const admin = storefront.administrativeArea || '';
  const postal = storefront.postalCode || '';
  const parts = [];
  if (lines.length > 0) parts.push(lines.join(', '));
  if (locality) parts.push(locality);
  if (admin || postal) parts.push([admin, postal].filter(Boolean).join(' '));
  if (parts.length === 0) return null;
  return parts.join(', ');
}

/**
 * Fetch reviews ordered by most recent update.
 * Map starRating enum to numeric.
 */
const STAR_MAP = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
export async function fetchReviews(refreshToken, locationName) {
  const tokenData = await getAccessToken(refreshToken);
  if (!tokenData) return { error: 'no_token' };
  if (!locationName) {
    locationName = await resolveGbpLocationName(tokenData.access_token);
    if (!locationName) return { error: 'location_not_found' };
  }
  const url = `https://mybusiness.googleapis.com/v4/${locationName}/reviews?orderBy=updateTime desc&pageSize=50`;
  try {
    const data = await googleFetch(tokenData.access_token, 'GET', url);
    const reviews = (data.reviews || []).map(r => ({
      reviewId: r.reviewId || r.name?.split('/').pop() || '',
      reviewerName: r.reviewer?.displayName || 'Anonymous',
      starRating: STAR_MAP[r.starRating] || 0,
      comment: r.comment || null,
      createTime: r.createTime,
      updateTime: r.updateTime,
      replyComment: r.reviewReply?.comment || null,
      replyUpdateTime: r.reviewReply?.updateTime || null,
    }));
    return {
      totalReviewCount: data.totalReviewCount || reviews.length,
      averageRating: Number(data.averageRating || 0),
      reviews,
    };
  } catch (err) {
    console.error('[gbpApi] fetchReviews error:', err.message);
    return { error: err.message };
  }
}

/** PUT a review reply. */
export async function replyToReview(refreshToken, locationName, reviewId, comment) {
  const tokenData = await getAccessToken(refreshToken);
  if (!tokenData) return { error: 'no_token' };
  const url = `https://mybusiness.googleapis.com/v4/${locationName}/reviews/${encodeURIComponent(reviewId)}/reply`;
  try {
    const data = await googleFetch(tokenData.access_token, 'PUT', url, { comment });
    return { reply: data };
  } catch (err) {
    console.error('[gbpApi] replyToReview error:', err.message);
    return { error: err.message };
  }
}

/** DELETE a review reply. */
export async function deleteReviewReply(refreshToken, locationName, reviewId) {
  const tokenData = await getAccessToken(refreshToken);
  if (!tokenData) return { error: 'no_token' };
  const url = `https://mybusiness.googleapis.com/v4/${locationName}/reviews/${encodeURIComponent(reviewId)}/reply`;
  try {
    await googleFetch(tokenData.access_token, 'DELETE', url);
    return { deleted: true };
  } catch (err) {
    console.error('[gbpApi] deleteReviewReply error:', err.message);
    return { error: err.message };
  }
}

/** Fetch local posts. */
export async function fetchLocalPosts(refreshToken, locationName) {
  const tokenData = await getAccessToken(refreshToken);
  if (!tokenData) return { error: 'no_token' };
  if (!locationName) {
    locationName = await resolveGbpLocationName(tokenData.access_token);
    if (!locationName) return { error: 'location_not_found' };
  }
  const url = `https://mybusiness.googleapis.com/v4/${locationName}/localPosts?pageSize=50`;
  try {
    const data = await googleFetch(tokenData.access_token, 'GET', url);
    const posts = (data.localPosts || []).map(p => ({
      postId: p.name?.split('/').pop() || '',
      topicType: p.topicType || null,
      summary: p.summary || '',
      createTime: p.createTime,
      updateTime: p.updateTime,
      state: p.state || null,
      searchUrl: p.searchUrl || null,
      callToAction: p.callToAction || null,
      event: p.event || null,
      offer: p.offer || null,
      media: p.media || [],
    }));
    return { posts };
  } catch (err) {
    console.error('[gbpApi] fetchLocalPosts error:', err.message);
    return { error: err.message };
  }
}

/** POST a new local post. */
export async function createLocalPost(refreshToken, locationName, postBody) {
  const tokenData = await getAccessToken(refreshToken);
  if (!tokenData) return { error: 'no_token' };
  const url = `https://mybusiness.googleapis.com/v4/${locationName}/localPosts`;
  try {
    const data = await googleFetch(tokenData.access_token, 'POST', url, postBody);
    return { post: data };
  } catch (err) {
    console.error('[gbpApi] createLocalPost error:', err.message);
    return { error: err.message };
  }
}

/** DELETE a local post. */
export async function deleteLocalPost(refreshToken, locationName, postId) {
  const tokenData = await getAccessToken(refreshToken);
  if (!tokenData) return { error: 'no_token' };
  const url = `https://mybusiness.googleapis.com/v4/${locationName}/localPosts/${encodeURIComponent(postId)}`;
  try {
    await googleFetch(tokenData.access_token, 'DELETE', url);
    return { deleted: true };
  } catch (err) {
    console.error('[gbpApi] deleteLocalPost error:', err.message);
    return { error: err.message };
  }
}

/**
 * Fetch Q&A.
 *
 * IMPORTANT: Google retired the public Q&A API in 2022 — there is no public
 * endpoint that replaces mybusinessqanda.googleapis.com. Q&A on Business
 * Profile must be managed manually in the Google Business Profile dashboard.
 * This function returns { unavailable: true } so the Portal can render a
 * "managed manually in GBP" message instead of an error.
 */
export async function fetchQuestions(refreshToken, locationName) {
  return {
    unavailable: true,
    reason: 'google_api_retired',
    note: 'Google retired the public Business Profile Q&A API. Manage questions + answers directly in your Google Business Profile dashboard at business.google.com.',
    questions: [],
  };
}

/** POST an answer to a question. NOTE: Q&A API was retired by Google. */
export async function answerQuestion(refreshToken, locationName, questionId, text) {
  return {
    unavailable: true,
    reason: 'google_api_retired',
    note: 'Google retired the Q&A API. Answer questions directly in your Google Business Profile dashboard.',
  };
}
