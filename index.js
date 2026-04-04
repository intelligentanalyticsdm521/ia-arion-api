import 'dotenv/config';
import cors from 'cors';
import express from 'express';

import { requireAuth } from './middleware/requireAuth.js';
import { tenantResolution } from './middleware/tenantResolution.js';
import { requireArionAccess } from './middleware/requireArionAccess.js';

import healthRouter from './routes/health.js';
import arionRouter from './routes/arion.js';
import internalRouter from './routes/internal.js';
import oauthRouter from './routes/oauth.js';
import submitRouter from './routes/submit.js';

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
app.use('/arion', requireAuth, tenantResolution, requireArionAccess, arionRouter);

app.use((req, res) => res.status(404).json({ error: 'not_found', method: req.method, path: req.path }));

app.listen(port, () => {
  console.log('ARION API listening on http://localhost:' + port);
  console.log('[CORS] allowedOrigins: ' + allowedOrigins.join(', '));
});