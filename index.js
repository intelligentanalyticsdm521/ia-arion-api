import 'dotenv/config';
import { errorLogObserver } from './middleware/errorLogObserver.js';
import cors from 'cors';
import express from 'express';

import { requireAuth } from './middleware/requireAuth.js';
import { tenantResolution } from './middleware/tenantResolution.js';
import { requireArionAccess } from './middleware/requireArionAccess.js';
// ARION tier gate — "does your ARION tier include this feature?" (2026-08-06).
// NOTE: lib/tierCheck.js requireTier() is NOT used: it reads req.siteRecord,
// which nothing in this tree populates, so it would evaluate every request as
// 'lite' and lock out every customer. requireArionTier resolves the tier from
// arion.site.arion_tier / arion.tenant.plan instead.
import { requireArionTier } from './middleware/requireArionTier.js';
import { enforceEmergencyReadOnly } from './middleware/enforceEmergencyReadOnly.js';
import { enforceViewAsReadOnly } from './middleware/enforceViewAsReadOnly.js';

import healthRouter from './routes/health.js';
import arionRouter from './routes/arion.js';
import ssoRouter from './routes/sso.js';
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
import onboardingActivateResendRouter from './routes/onboarding/activateResend.js';
import onboardingRunnerRouter from './routes/onboarding/runner.js';
import onboardingGoogleOauthRouter from './routes/onboarding/google-oauth.js';
import onboardingBingOauthRouter from './routes/onboarding/bing-oauth.js';
import adminOnboardExistingRouter from './routes/admin/onboardExisting.js';
import adminSiteRequestsRouter from './routes/admin/siteRequests.js';
import provisioningRouter from './routes/provisioning.js';
import pluginRouter from './routes/plugin.js';
import argusRouter from './routes/argus.js';
import intelligenceRouter from './routes/intelligence.js';

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
  // x-actas-mode: the Portal attaches it to EVERY request during a founder
  // emergency act-as session (emergencyActAs.ts). Missing from this list it
  // fails preflight and the browser blocks every ARION call for the whole
  // 30-minute session (found 2026-07-26 walking Briarwood in dev).
  allowedHeaders: ['Authorization', 'Content-Type', 'x-tenant-key', 'x-tenant-id', 'x-site-id', 'x-arion-ingest-key', 'x-portal-context', 'x-dev-tenant', 'x-dev-tier', 'x-actas-mode'],
  credentials: false
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use((req, res, next) => (req.method === 'OPTIONS' ? res.sendStatus(204) : next()));

// Mount the Stripe webhook BEFORE express.json so the router can apply raw-body
// parsing internally (signature verification needs the byte-exact request body).
app.use('/onboarding/webhook', onboardingWebhookRouter);

app.use(express.json({ limit: '2mb' }));

// Sept-A F7: passive >=400 observer -> core.error_log.
app.use(errorLogObserver('arion'));

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
// 2026-06-27 — Resend route mounted BEFORE /onboarding/activate so the
// `/resend` sub-path doesn't get swallowed by activate.js' `POST /` handler.
app.use('/onboarding/activate/resend', onboardingActivateResendRouter);
app.use('/onboarding/activate', onboardingActivateRouter);

// OnboardingRunner orchestrator — drives the Portal-side engine in
// Portal/src/lib/onboardingRunner/. Each route maps 1:1 to a Step in
// arionSteps.ts. Authenticated (JWT + tenant) since the Runner only
// runs post-checkout when the customer is logged in.
app.use(
  '/onboarding/runner',
  requireAuth,
  enforceEmergencyReadOnly(),
  enforceViewAsReadOnly(),
  tenantResolution,
  onboardingRunnerRouter,
);

// Google + Bing dual-path onboarding orchestrators (Brandon-locked 2026-06-23).
// Same auth chain as the runner — only the post-checkout authenticated wizard
// hits these. See routes/onboarding/google-oauth.js + bing-oauth.js for the
// YES / NO / NOT_SURE answer routing and the IA-master auto-provision flow.
app.use(
  '/onboarding/google-oauth',
  requireAuth,
  enforceEmergencyReadOnly(),
  enforceViewAsReadOnly(),
  tenantResolution,
  onboardingGoogleOauthRouter,
);
app.use(
  '/onboarding/bing-oauth',
  requireAuth,
  enforceEmergencyReadOnly(),
  enforceViewAsReadOnly(),
  tenantResolution,
  onboardingBingOauthRouter,
);

// Founder admin — onboard a client whose site was built outside the system
// (e.g. via Hostinger Kodee manually). Auth via Bearer FOUNDER_ADMIN_TOKEN.
app.use('/admin', adminOnboardExistingRouter);
// Founder queue for ARION change requests (Foundation §3A3) — same token gate.
app.use('/admin', adminSiteRequestsRouter);
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

// Founder super-user "Emergency act-as" read-only enforcement.
//
// enforceEmergencyReadOnly is inserted right after requireAuth so it has the
// JWT claims to identify the founder, but BEFORE tenantResolution +
// requireArionAccess so non-GET requests are 403'd before any tenant-scope
// logic runs. It is a NO-OP when no x-actas-mode header is sent — normal
// traffic and "switch" mode are unaffected. Mirrors oliver-api's chain.
// /arion/sso/* uses X-Arion-Site-Token auth (plugin webhook), NOT Bearer.
// Must mount BEFORE the requireAuth-protected /arion namespace so first-match
// routes /arion/sso/verify to ssoRouter instead of falling into requireAuth.
app.use('/arion/sso', express.json(), ssoRouter);
app.use('/arion', requireAuth, enforceEmergencyReadOnly(), enforceViewAsReadOnly(), tenantResolution, requireArionAccess, requireArionTier(), arionRouter);
// ARGUS AI credit endpoints — gated by standard tenant resolution, not
// product-access (every tenant can see their balance even without ARION).
app.use('/argus', requireAuth, enforceEmergencyReadOnly(), enforceViewAsReadOnly(), tenantResolution, argusRouter);

// Brandon 2026-06-21 — ARION Platform Pulse (Trend+Intel)/2 per the canonical
// equal-weight architecture. Read by platform-api to compose Business Pulse.
// Requires ARION access since the cache lives in arion.platform_pulse_cache.
app.use('/intelligence', requireAuth, enforceEmergencyReadOnly(), enforceViewAsReadOnly(), tenantResolution, requireArionAccess, requireArionTier(), intelligenceRouter);

app.use((req, res) => res.status(404).json({ error: 'not_found', method: req.method, path: req.path }));

// FINAL JSON ERROR RESPONDER.
//
// Without a 4-arity handler here, Express's own finalhandler answers every
// unhandled error -- with text/html, and (finalhandler/index.js:176)
// `if (env !== "production") msg = err.stack` puts the STACK IN THE RESPONSE
// BODY. express/lib/application.js:78 reads `process.env.NODE_ENV ||
// "development"`, so an app with NODE_ENV merely UNSET runs in development
// mode and leaks.
//
// That is not hypothetical: api-platform-iadm-prod had no NODE_ENV and was
// publishing stack traces and its entire CORS allowlist to anonymous callers
// until 2026-07-17. This app currently sets NODE_ENV=production, so the leak is
// MASKED -- but that makes safety depend on an app setting staying correct,
// which is the bug that bit the hub. This handler does not depend on it.
//
// 4-arity is load-bearing: Express only treats a middleware as an error handler
// if fn.length === 4. Do not drop the unused `next` -- doing so silently
// un-registers this and restores the leak with no error anywhere.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = Number(err?.status || err?.statusCode) || 500;
  console.error(`[error] ${req.method} ${req.originalUrl} -> ${status}:`, err?.stack || err);
  if (res.headersSent) return;
  res.status(status).json({
    error: status === 400 ? "bad_request" : status < 500 ? "request_failed" : "internal_error",
    status,
  });
});

app.listen(port, () => {
  console.log('ARION API listening on http://localhost:' + port);
  console.log('[CORS] allowedOrigins: ' + allowedOrigins.join(', '));
});