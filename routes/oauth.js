import { Router } from 'express';
import sql from 'mssql';
import { getServicesPool } from '../db/servicesPool.js';

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
