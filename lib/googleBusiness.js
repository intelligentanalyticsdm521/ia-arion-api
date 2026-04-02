/**
 * Google Business Profile API Client
 * Uses per-site OAuth access tokens (stored in Key Vault, referenced by arion.site.gbp_oauth_token_ref).
 *
 * API surfaces:
 *   - Business Information: https://mybusinessbusinessinformation.googleapis.com/v1
 *   - Reviews (legacy v4):  https://mybusiness.googleapis.com/v4
 *   - Performance:           https://businessprofileperformance.googleapis.com/v1
 *
 * All public methods take an accessToken as the first parameter.
 */

const INFO_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const REVIEWS_BASE = 'https://mybusiness.googleapis.com/v4';
const PERF_BASE = 'https://businessprofileperformance.googleapis.com/v1';

const GOOGLE_OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const GOOGLE_OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

// ---------------------------------------------------------------------------
// Token refresh placeholder
// ---------------------------------------------------------------------------

/**
 * Attempt to refresh an expired access token using a refresh token.
 * Requires GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET env vars.
 *
 * @param {string} refreshToken - The OAuth refresh token
 * @returns {Promise<{access_token: string, expires_in: number}|null>}
 */
export async function refreshAccessToken(refreshToken) {
  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET) {
    console.error('[googleBusiness] GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET not set -- cannot refresh token');
    return null;
  }

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_OAUTH_CLIENT_ID,
        client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[googleBusiness] Token refresh failed:', res.status, text.slice(0, 200));
      return null;
    }

    return await res.json();
  } catch (err) {
    console.error('[googleBusiness] Token refresh error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core request helper
// ---------------------------------------------------------------------------

/**
 * Make an authenticated request to a Google API.
 * @param {string} accessToken - OAuth access token
 * @param {string} method      - HTTP method
 * @param {string} url         - Full URL
 * @param {object} [body]      - JSON body for POST/PUT/PATCH
 * @param {number} [attempt=1]
 * @returns {Promise<object|null>}
 */
async function request(accessToken, method, url, body = undefined, attempt = 1) {
  if (!accessToken) {
    console.error('[googleBusiness] No access token provided');
    return null;
  }

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');

      // 401 might mean the token is expired -- caller should refresh and retry
      if (res.status === 401) {
        console.error('[googleBusiness] 401 Unauthorized -- access token may be expired');
        return null;
      }

      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    return await res.json().catch(() => null);
  } catch (err) {
    if (attempt < 3) {
      const delay = 2 ** attempt * 500;
      await new Promise((r) => setTimeout(r, delay));
      return request(accessToken, method, url, body, attempt + 1);
    }

    console.error(`[googleBusiness] ${method} ${url} failed after 3 attempts:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Business Information API
// ---------------------------------------------------------------------------

/**
 * Get a Google Business Profile location.
 * @param {string} accessToken - OAuth access token
 * @param {string} locationId  - e.g. "locations/12345" or just "12345"
 * @returns {Promise<object|null>}
 */
export async function getProfile(accessToken, locationId) {
  try {
    const locPath = locationId.startsWith('locations/') ? locationId : `locations/${locationId}`;
    return await request(accessToken, 'GET', `${INFO_BASE}/${locPath}?readMask=name,title,storefrontAddress,websiteUri,phoneNumbers,categories`);
  } catch (err) {
    console.error('[googleBusiness] getProfile error:', err.message);
    return null;
  }
}

/**
 * Update fields on a Google Business Profile location.
 * @param {string} accessToken - OAuth access token
 * @param {string} locationId  - e.g. "locations/12345"
 * @param {object} fields      - Fields to update (e.g. { title, websiteUri, phoneNumbers })
 * @returns {Promise<object|null>}
 */
export async function updateProfile(accessToken, locationId, fields) {
  try {
    const locPath = locationId.startsWith('locations/') ? locationId : `locations/${locationId}`;
    const updateMask = Object.keys(fields).join(',');
    return await request(
      accessToken,
      'PATCH',
      `${INFO_BASE}/${locPath}?updateMask=${encodeURIComponent(updateMask)}`,
      fields,
    );
  } catch (err) {
    console.error('[googleBusiness] updateProfile error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reviews API (legacy v4)
// ---------------------------------------------------------------------------

/**
 * List reviews for a location.
 * @param {string} accessToken - OAuth access token
 * @param {string} accountId   - e.g. "accounts/12345" or "12345"
 * @param {string} locationId  - e.g. "locations/67890" or "67890"
 * @param {number} [pageSize=50]
 * @returns {Promise<{reviews: Array<object>, totalReviewCount?: number, averageRating?: number}|null>}
 */
export async function getReviews(accessToken, accountId, locationId, pageSize = 50) {
  try {
    const acctPath = accountId.startsWith('accounts/') ? accountId : `accounts/${accountId}`;
    const locPath = locationId.startsWith('locations/') ? locationId : `locations/${locationId}`;
    return await request(
      accessToken,
      'GET',
      `${REVIEWS_BASE}/${acctPath}/${locPath}/reviews?pageSize=${pageSize}`,
    );
  } catch (err) {
    console.error('[googleBusiness] getReviews error:', err.message);
    return null;
  }
}

/**
 * Reply to a review.
 * @param {string} accessToken - OAuth access token
 * @param {string} reviewName  - Full resource name (e.g. "accounts/123/locations/456/reviews/789")
 * @param {string} replyText   - The reply message
 * @returns {Promise<object|null>}
 */
export async function replyToReview(accessToken, reviewName, replyText) {
  try {
    return await request(
      accessToken,
      'PUT',
      `${REVIEWS_BASE}/${reviewName}/reply`,
      { comment: replyText },
    );
  } catch (err) {
    console.error('[googleBusiness] replyToReview error:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Performance API
// ---------------------------------------------------------------------------

/**
 * Get performance metrics for a location over a date range.
 * @param {string} accessToken - OAuth access token
 * @param {string} locationId  - e.g. "locations/12345"
 * @param {{ startDate: string, endDate: string }} dateRange - ISO date strings (YYYY-MM-DD)
 * @returns {Promise<object|null>}
 */
export async function getPerformanceMetrics(accessToken, locationId, dateRange) {
  try {
    const locPath = locationId.startsWith('locations/') ? locationId : `locations/${locationId}`;

    // dailyMetricsTimeSeries endpoint
    const params = new URLSearchParams({
      'dailyRange.startDate.year': dateRange.startDate.split('-')[0],
      'dailyRange.startDate.month': String(parseInt(dateRange.startDate.split('-')[1], 10)),
      'dailyRange.startDate.day': String(parseInt(dateRange.startDate.split('-')[2], 10)),
      'dailyRange.endDate.year': dateRange.endDate.split('-')[0],
      'dailyRange.endDate.month': String(parseInt(dateRange.endDate.split('-')[1], 10)),
      'dailyRange.endDate.day': String(parseInt(dateRange.endDate.split('-')[2], 10)),
      'dailyMetrics': 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
    });

    return await request(
      accessToken,
      'GET',
      `${PERF_BASE}/${locPath}:getDailyMetricsTimeSeries?${params}`,
    );
  } catch (err) {
    console.error('[googleBusiness] getPerformanceMetrics error:', err.message);
    return null;
  }
}

export { refreshAccessToken as getAccessToken };
