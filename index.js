import 'dotenv/config';
import cors from 'cors';
import express from 'express';

import { requireAuth } from './middleware/requireAuth.js';
import { tenantResolution } from './middleware/tenantResolution.js';
import { requireArionAccess } from './middleware/requireArionAccess.js';
import { actingTenantGuard } from './lib/consultingAccess.js';

import healthRouter from './routes/health.js';
import arionRouter from './routes/arion.js';
import internalRouter from './routes/internal.js';
import oauthRouter from './routes/oauth.js';
import submitRouter from './routes/submit.js';
import onboardingDomainsRouter from './routes/onboarding/domains.js';
import onboardingCheckoutRouter from './routes/onboarding/checkout.js';
import onboardingWebhookRouter from './routes/onboarding/webhook.js';
import onboardingSubmitRouter from './routes/onboarding/submit.js';
import onboardingStatusRouter from './routes/onboarding/status.js';
import onboardingSessionInfoRouter from './routes/onboarding/session-info.js';
import onboardingActivateRouter from './routes/onboarding/activate.js';
import adminOnboardExistingRouter from './routes/admin/onboardExisting.js';
import provisioningRouter from './routes/provisioning.js';
import pluginRouter from './routes/plugin.js';

const app = express();
const port = process.env.PORT || 3000;

process.on('unhandledRejection', (err) => console.error('[fatal] unhandledRejection', err));
process.on('uncaughtException', (err) => console.error('[fatal] uncaughtException', err));

function getCorsOrigins() {
  const raw = (process.env.CORS_ORIGINS || '').trim();
  if (!raw) return ['http://localhost:5173', 'http://127.0.0.1:5173'];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function isAllowedScmOrigin(origin) {
  return typeof origin === "string" && /^https:\/\/.+\.scm\..+\.azurewebsites\.net$/i.test(origin);
}

const allowedOrigins = getCorsOrigins();
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    if (isAllowedScmOrigin(origin)) return callback(null, true);
    return callback(new Error('CORS blocked for origin: ' + origin));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'x-tenant-key', 'x-tenant-id', 'x-site-id', 'x-arion-ingest-key', 'x-portal-context'],
  credentials: false
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use((req, res, next) => (req.method === 'OPTIONS' ? res.sendStatus(204) : next()));

// Mount the Stripe webhook BEFORE express.json so the router can apply raw-body
// parsing internally (signature verification needs the byte-exact request body).
app.use('/onboarding/webhook', onboardingWebhookRouter);

app.use(express.json({ limit: '2mb' }));

const startedAt = new Date().toISOString();
app.get('/__meta', (req, res) => {
  res.json({
    service: 'arion-api',
    startedAt,
    node: process.version,
    env: process.env.NODE_ENV || 'unknown',
    config: {
      authMode: process.env.AUTH_MODE || 'unset',
      hasPlatformSqlServer: Boolean((process.env.PLATFORM_SQL_SERVER || process.env.SQL_SERVER || '').trim()),
      hasServicesSqlServer: Boolean((process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER || '').trim()),
      hasAuthMetadata: Boolean((process.env.AUTH_METADATA_ADDRESS || '').trim()),
      hasAuthAudience: Boolean((process.env.AUTH_API_AUDIENCE || '').trim()),
      hasProviderKey: Boolean((process.env.AUTH_PROVIDER_KEY || '').trim()),
      hasAllowedClients: Boolean((process.env.AUTH_ALLOWED_CLIENT_IDS || '').trim()),
      arionServiceKey: (process.env.ARION_SERVICE_KEY || 'arion').trim(),
      hasGoogleOAuth: Boolean((process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim()),
      hasSeRanking: Boolean((process.env.SERANKING_API_SYSTEM_KEY || process.env.SE_RANKING_API_SYSTEM_KEY || '').trim()),
      hasIngestKey: Boolean((process.env.ARION_INGEST_KEY || '').trim())
    }
  });
});

app.use('/health', healthRouter);
app.use('/internal', internalRouter);
app.use('/oauth', oauthRouter);
app.use('/', submitRouter);
// Onboarding routes are public (no auth) — used during signup before a tenant exists.
// Each route does its own validation; sensitive paths require a signup session token.
app.use('/onboarding/domains', onboardingDomainsRouter);
app.use('/onboarding/checkout', onboardingCheckoutRouter);
app.use('/onboarding/submit', onboardingSubmitRouter);
app.use('/onboarding/status', onboardingStatusRouter);
app.use('/onboarding/session-info', onboardingSessionInfoRouter);
app.use('/onboarding/activate', onboardingActivateRouter);
// Founder admin — onboard a client whose site was built outside the system
// (e.g. via Hostinger Kodee manually). Auth via Bearer FOUNDER_ADMIN_TOKEN.
app.use('/admin', adminOnboardExistingRouter);
// Provisioning endpoints (no JWT auth — authenticated via single-use provisioning code in body
// or the PROVISIONER_SHARED_SECRET header for worker callbacks).
// Called by the IA Plugin's bootstrap class on a freshly-provisioned client site.
app.use('/provisioning', provisioningRouter);

// F-139 — IA Plugin distribution gateway. /plugin/manifest (site-token auth)
// + /plugin/download (provision_code OR site-token auth). Streams the plugin
// .zip from PRIVATE blob storage (stiadmprod/plugins/) via arion-api's
// managed identity. Mounted at root so install-time WP-CLI calls don't need
// an auth header — just the ?token=<provision_code> query string.
app.use('/plugin', pluginRouter);

app.use('/arion', requireAuth, tenantResolution, actingTenantGuard, requireArionAccess, arionRouter);

app.use((req, res) => res.status(404).json({ error: 'not_found', method: req.method, path: req.path }));

app.listen(port, () => {
  console.log('ARION API listening on http://localhost:' + port);
  console.log('[CORS] allowedOrigins: ' + allowedOrigins.join(', '));
});