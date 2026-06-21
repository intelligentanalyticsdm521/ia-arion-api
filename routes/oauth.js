import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../db/servicesPool.js';
import { getPlatformPool } from '../db/platformPool.js';

const router = Router();

// ─── GET /oauth/google/connect ────────────────────────────────
// Legacy direct-link flow (portal can also use POST /arion/integrations/google/connect)
router.get('/google/connect', async (req, res) => {
  const { scope, redirect_uri, tenant_id, site_id } = req.query;
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) {
    return res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Google OAuth not configured', status: 503 } });
  }
  const state = Buffer.from(JSON.stringify({ tenantId: tenant_id, siteId: site_id, scope })).toString('base64url');
  const callbackUrl = redirect_uri || process.env.GOOGLE_OAUTH_REDIRECT_URI || '';
  const params = new URLSearchParams({
    client_id: clientId, redirect_uri: callbackUrl, response_type: 'code',
    scope: scope || 'openid profile email', state, access_type: 'offline', prompt: 'consent'
  });
  res.json({ data: { oauth_url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() }, meta: { timestamp: new Date().toISOString() } });
});

// ─── GET /oauth/google/callback ───────────────────────────────
// Google redirects here after user consents
router.get('/google/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  // Handle OAuth errors from Google
  if (oauthError) {
    console.error('[oauth/google/callback] OAuth error from Google:', oauthError);
    return res.status(400).send(`
      <html><body>
        <h2>Google Connection Failed</h2>
        <p>Error: ${oauthError}</p>
        <p>Please close this window and try again.</p>
      </body></html>
    `);
  }

  if (!code || !state) {
    return res.status(400).send(`
      <html><body>
        <h2>Google Connection Failed</h2>
        <p>Missing authorization code or state parameter.</p>
        <p>Please close this window and try again.</p>
      </body></html>
    `);
  }

  let stateData;
  try {
    stateData = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  } catch (err) {
    console.error('[oauth/google/callback] Failed to parse state:', err.message);
    return res.status(400).send(`
      <html><body>
        <h2>Google Connection Failed</h2>
        <p>Invalid state parameter.</p>
      </body></html>
    `);
  }

  const { tenantId, siteId, returnUrl } = stateData;
  if (!tenantId || !siteId) {
    return res.status(400).send(`
      <html><body>
        <h2>Google Connection Failed</h2>
        <p>Missing tenantId or siteId in state.</p>
      </body></html>
    `);
  }

  // Exchange authorization code for tokens
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI || '';

  if (!clientId || !clientSecret) {
    console.error('[oauth/google/callback] Missing GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET');
    return res.status(503).send(`
      <html><body>
        <h2>Google Connection Failed</h2>
        <p>OAuth not configured on server.</p>
      </body></html>
    `);
  }

  let tokens;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text().catch(() => '');
      console.error('[oauth/google/callback] Token exchange failed:', tokenRes.status, errText.slice(0, 500));
      return res.status(502).send(`
        <html><body>
          <h2>Google Connection Failed</h2>
          <p>Failed to exchange authorization code for tokens.</p>
          <p>Please try again.</p>
        </body></html>
      `);
    }

    tokens = await tokenRes.json();
  } catch (err) {
    console.error('[oauth/google/callback] Token exchange error:', err.message);
    return res.status(502).send(`
      <html><body>
        <h2>Google Connection Failed</h2>
        <p>Error communicating with Google: ${err.message}</p>
      </body></html>
    `);
  }

  const refreshToken = tokens.refresh_token;
  if (!refreshToken) {
    console.error('[oauth/google/callback] No refresh_token in response. Tokens:', Object.keys(tokens).join(', '));
    return res.status(502).send(`
      <html><body>
        <h2>Google Connection Failed</h2>
        <p>Google did not return a refresh token. Please revoke access and try again.</p>
      </body></html>
    `);
  }

  // Store refresh token and update connection flags in the database
  try {
    const pool = await getServicesPool();
    await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .input('siteId', sql.UniqueIdentifier, siteId)
      .input('refreshToken', sql.NVarChar(2000), refreshToken)
      .query(`
        UPDATE arion.site
        SET gbp_oauth_token_ref = @refreshToken,
            gbp_connected = 1,
            gsc_connected = 1,
            updated_at = GETUTCDATE()
        WHERE tenant_id = @tenantId AND site_id = @siteId
      `);

    console.log(`[oauth/google/callback] Successfully stored refresh token for tenant=${tenantId} site=${siteId}`);

    // v2.0.13: Immediately auto-select GBP location, GA4 property, and GSC site
    // when there's no ambiguity. The 90% case is "one Google account, one
    // business" — without this the user sees "Connected" in Settings but
    // "Not connected" on Business pages because gbp_location_name is null.
    try {
      const { getAccessToken } = await import('../lib/googleBusiness.js');
      const tokenData = await getAccessToken(refreshToken);
      if (tokenData?.access_token) {
        const accessToken = tokenData.access_token;
        const siteRow = await pool.request()
          .input('siteId', sql.UniqueIdentifier, siteId)
          .query('SELECT domain FROM arion.site WHERE site_id = @siteId');
        const siteDomain = siteRow.recordset[0]?.domain || '';
        const siteHost = String(siteDomain).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');

        // GBP — auto-pick if single listing or unique domain match
        try {
          const { listAllGbpLocations } = await import('../lib/gbpApi.js');
          const locations = await listAllGbpLocations(accessToken, siteDomain);
          const exactMatches = locations.filter((l) => l.match_score >= 1.0);
          let pick = null;
          if (locations.length === 1) pick = locations[0];
          else if (exactMatches.length === 1) pick = exactMatches[0];
          if (pick) {
            await pool.request()
              .input('siteId', sql.UniqueIdentifier, siteId)
              .input('locationName', sql.NVarChar(200), pick.location_name)
              .input('placeId', sql.NVarChar(80), pick.place_id || null)
              .query('UPDATE arion.site SET gbp_location_name = @locationName, gbp_place_id = @placeId WHERE site_id = @siteId');
            console.log(`[oauth/google/callback] Auto-picked GBP location: ${pick.title} (${pick.location_name})`);
            // Push Google review URL to the shared tenant profile so OLIVER
            // (review automation/invoices) and others use it automatically.
            if (pick.place_id || pick.review_uri) {
              try {
                const tRow = await pool.request()
                  .input('siteId', sql.UniqueIdentifier, siteId)
                  .query('SELECT tenant_id FROM arion.site WHERE site_id = @siteId');
                const tid = tRow.recordset[0]?.tenant_id;
                if (tid) {
                  const platformPool = await getPlatformPool();
                  await platformPool.request()
                    .input('tenantId', sql.UniqueIdentifier, tid)
                    .input('placeId', sql.NVarChar(80), pick.place_id || null)
                    .input('reviewUrl', sql.NVarChar(500), pick.review_uri || null)
                    .query('UPDATE core.tenants SET google_place_id = @placeId, google_review_url = @reviewUrl WHERE tenant_id = @tenantId');
                }
              } catch (shareErr) {
                console.warn('[oauth/google/callback] shared-profile GBP write skipped:', shareErr.message);
              }
            }
          } else {
            console.log(`[oauth/google/callback] GBP picker needed — ${locations.length} locations, ${exactMatches.length} domain matches`);
          }
        } catch (e) { console.warn('[oauth/google/callback] GBP auto-pick failed:', e.message); }

        // Onboarding V3 Phase 3 — multi-location auto-import.
        // Persist EVERY discoverable GBP location to arion.business_location
        // so multi-branch tenants (regional plumbing chains, multi-location
        // dental practices, etc.) get all their locations rather than just
        // the one anchored to this site. Best-effort: failure shouldn't
        // break the OAuth callback. See lib/integrations/gbpSync.js.
        try {
          const tRow = await pool.request()
            .input('siteId', sql.UniqueIdentifier, siteId)
            .query('SELECT tenant_id FROM arion.site WHERE site_id = @siteId');
          const tid = tRow.recordset[0]?.tenant_id;
          if (tid) {
            const { syncAllLocations } = await import('../lib/integrations/gbpSync.js');
            const syncResult = await syncAllLocations(tid, accessToken, { siteId, siteDomain });
            console.log(`[oauth/google/callback] GBP multi-location sync: added=${syncResult.added} updated=${syncResult.updated} removed=${syncResult.removed} total=${syncResult.total}`);
          }
        } catch (e) { console.warn('[oauth/google/callback] GBP multi-location sync failed:', e.message); }

        // GA4 — auto-pick if single property or domain match
        try {
          const ga4Res = await fetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries', {
            headers: { Authorization: 'Bearer ' + accessToken }
          });
          if (ga4Res.ok) {
            const data = await ga4Res.json();
            const props = [];
            for (const acct of (data.accountSummaries || [])) {
              for (const prop of (acct.propertySummaries || [])) {
                props.push({ propertyId: prop.property.replace('properties/', ''), displayName: prop.displayName });
              }
            }
            // Robust matcher: strip non-alphanumeric, check substring both directions
            const cleanHost = siteHost.toLowerCase().replace(/[^a-z0-9]/g, '');
            const ga4Match = props.find((p) => {
              const cleanDn = (p.displayName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              if (!cleanDn) return false;
              return cleanHost.includes(cleanDn) || cleanDn.includes(cleanHost);
            });
            const ga4Pick = ga4Match || (props.length === 1 ? props[0] : null);
            if (ga4Pick) {
              await pool.request()
                .input('siteId', sql.UniqueIdentifier, siteId)
                .input('ga4PropertyId', sql.NVarChar(40), ga4Pick.propertyId)
                .query('UPDATE arion.site SET ga4_property_id = @ga4PropertyId WHERE site_id = @siteId');
              console.log(`[oauth/google/callback] Auto-picked GA4: ${ga4Pick.displayName}`);
            }
          }
        } catch (e) { console.warn('[oauth/google/callback] GA4 auto-pick failed:', e.message); }

        // GSC — auto-pick if single site or exact domain match
        try {
          const gscRes = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
            headers: { Authorization: 'Bearer ' + accessToken }
          });
          if (gscRes.ok) {
            const data = await gscRes.json();
            const sites = (data.siteEntry || []).map(s => ({ siteUrl: s.siteUrl }));
            const gscMatch = sites.find((s) => {
              const sHost = String(s.siteUrl || '').replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
              return sHost === siteHost;
            });
            const gscPick = gscMatch || (sites.length === 1 ? sites[0] : null);
            if (gscPick) {
              await pool.request()
                .input('siteId', sql.UniqueIdentifier, siteId)
                .input('gscSiteUrl', sql.NVarChar(500), gscPick.siteUrl)
                .query('UPDATE arion.site SET gsc_site_url = @gscSiteUrl WHERE site_id = @siteId');
              console.log(`[oauth/google/callback] Auto-picked GSC: ${gscPick.siteUrl}`);
            }
          }
        } catch (e) { console.warn('[oauth/google/callback] GSC auto-pick failed:', e.message); }
      }
    } catch (e) { console.warn('[oauth/google/callback] auto-select outer failed:', e.message); }
  } catch (err) {
    console.error('[oauth/google/callback] DB update error:', err.message);
    return res.status(500).send(`
      <html><body>
        <h2>Google Connection Failed</h2>
        <p>Failed to save connection. Please try again.</p>
      </body></html>
    `);
  }

  // Redirect back to portal settings with selectProperties flag
  const portalUrl = process.env.PORTAL_URL || 'https://portal.intelligentanalyticsdm.com';
  const redirectTo = returnUrl || `${portalUrl}/app/settings?tab=connected&selectProperties=true&siteId=${encodeURIComponent(siteId)}`;
  res.redirect(redirectTo);
});

export default router;
