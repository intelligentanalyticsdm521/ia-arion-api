#!/usr/bin/env node
/**
 * Manual worker trigger — bypasses Stripe/checkout/DB and dispatches a
 * provisioning job directly to the running Playwright worker.
 *
 * Use this to test the AI Builder UI walkthrough + plugin upload + bootstrap
 * against a real Hostinger WP site you've set up in advance.
 *
 * Prerequisites:
 *   - The worker is running (locally or in Container Apps), reachable at PROVISIONER_URL
 *   - A fresh Hostinger WordPress site exists at <DOMAIN>, with admin creds known
 *   - The IA Plugin v2.1.0 zip is hosted at IA_PLUGIN_ARCHIVE_URL (public URL)
 *   - You have a valid provisioning code (or the script can mint one — see below)
 *
 * Usage:
 *   PROVISIONER_URL=http://localhost:8080 \
 *   PROVISIONER_SHARED_SECRET=devsecret \
 *   IA_PLUGIN_ARCHIVE_URL=https://.../intelligent-analytics-2.1.0.zip \
 *   node scripts/test-worker.js \
 *     --domain=test.com \
 *     --wpAdminUrl=https://test.com/wp-admin/ \
 *     --wpUser=admin \
 *     --wpPass='...' \
 *     --businessName='Test Co' \
 *     --code=IAPV-XXXX-XXXX-XXXX
 *
 * What it does:
 *   1. Builds a job payload from the args + a generated AI prompt
 *   2. POSTs to <PROVISIONER_URL>/run with the shared-secret header
 *   3. Worker returns 202; processing happens async
 *   4. You watch the worker logs to see phase transitions
 *
 * No DB writes, no Stripe, no email — just the worker.
 */

import 'dotenv/config';
import { buildAiPrompt } from '../lib/promptBuilder.js';

const PROVISIONER_URL = process.env.PROVISIONER_URL || 'http://localhost:8080';
const SHARED_SECRET = process.env.PROVISIONER_SHARED_SECRET || '';

function parseArgs() {
  const out = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function need(args, key) {
  if (!args[key]) {
    console.error(`Missing required arg: --${key}`);
    process.exit(1);
  }
  return args[key];
}

async function main() {
  const args = parseArgs();
  if (process.argv.includes('--help') || process.argv.length < 3) {
    console.log(`Usage:
  node scripts/test-worker.js \\
    --domain=test.com \\
    --wpAdminUrl=https://test.com/wp-admin/ \\
    --wpUser=admin \\
    --wpPass='your-admin-password' \\
    --businessName='Test Co' \\
    --industry='Coffee shop' \\
    --description='A neighborhood coffee shop in Austin' \\
    --code=IAPV-XXXX-XXXX-XXXX

Optional:
  --tenantId=<uuid>           defaults to a random UUID
  --siteId=<uuid>             defaults to a random UUID
  --jobId=<uuid>              defaults to a random UUID
  --brandName='Test Co'       defaults to --businessName
  --language=English          defaults to English
`);
    process.exit(0);
  }

  const domain = need(args, 'domain');
  const wpAdminUrl = need(args, 'wpAdminUrl');
  const wpUser = need(args, 'wpUser');
  const wpPass = need(args, 'wpPass');
  const businessName = need(args, 'businessName');
  const code = need(args, 'code');

  // Build a minimal but realistic prompt from the args
  const { prompt, length } = buildAiPrompt({
    businessName,
    industry: args.industry || 'Small business',
    description: args.description || `${businessName} is a small local business.`,
    services: ['Service A', 'Service B', 'Service C'],
    targetAudience: 'Local customers',
    location: 'TBD',
    brandVoice: 'Professional',
    stylePreference: 'Modern',
    pages: ['Home', 'About', 'Services', 'Contact'],
  });
  console.log(`Generated prompt (${length} chars):\n---\n${prompt}\n---\n`);

  const tenantId = args.tenantId || crypto.randomUUID();
  const siteId = args.siteId || crypto.randomUUID();
  const jobId = args.jobId || crypto.randomUUID();

  const payload = {
    jobId,
    tenantId,
    siteId,
    domain,
    websiteId: args.websiteId || null,
    wpAdminUrl,
    wpUser,
    wpPass,
    prompt,
    brandName: args.brandName || businessName,
    language: args.language || 'English',
    provisionCode: code,
  };

  console.log(`Dispatching to ${PROVISIONER_URL}/run …`);
  const res = await fetch(`${PROVISIONER_URL}/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-worker-secret': SHARED_SECRET,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}: ${text}`);
  if (res.status !== 202 && res.status !== 200) {
    process.exit(1);
  }
  console.log('\nJob accepted. Watch the worker logs for phase transitions:');
  console.log(`  jobId: ${jobId}`);
  console.log(`  Worker should walk through: wp_login → ai_builder_prompt → ai_builder_confirm → kodee_skip → ai_builder_finalize → plugin_deploy → auto_redeem_trigger`);
  console.log(`\nIf the worker is configured with PROVISIONER_CALLBACK_URL pointing to your arion-api,`);
  console.log(`you'll see arion.provisioning_job rows updating in real time.`);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
