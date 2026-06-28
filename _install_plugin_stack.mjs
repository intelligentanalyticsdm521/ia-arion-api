import { installPluginsForTier } from './lib/pluginStack.js';
import { stripHostingerOnboardingPlugins } from './lib/hostingerSsh.js';

const PROVISION = {
  'briarwoodsmiles.com':  'IAPV-9EMM-VLNM-83TS',
  'midwestagservices.com': 'IAPV-KA4H-TQHZ-445F',
};
const SLUGS = [
  'intelligent-analytics',
  'hello-elementor',
  'elementor',
  'elementor-pro',
  'wordfence',
  'ewww-image-optimizer',
  'seo-by-rank-math',
  'litespeed-cache',
  'wp-mail-smtp',
  'safe-svg',
  'advanced-custom-fields',
];
const ARION_API_BASE = 'https://app-arion-api-prod-e6fuc9gzd8f3hqfe.centralus-01.azurewebsites.net';

const domain = process.argv[2];
if (!domain || !PROVISION[domain]) {
  console.error('Usage: node _install_plugin_stack.mjs <domain>');
  console.error('Known domains:', Object.keys(PROVISION).join(', '));
  process.exit(2);
}
const provisionCode = PROVISION[domain];
const downloadUrl = `${ARION_API_BASE}/plugin/download?token=${provisionCode}`;

(async () => {
  console.log(`[${domain}] strip stock Hostinger plugins…`);
  try {
    await stripHostingerOnboardingPlugins(domain);
    console.log(`[${domain}] strip OK`);
  } catch (e) {
    console.log(`[${domain}] strip warn: ${(e.message || '').slice(0, 200)}`);
  }
  console.log(`[${domain}] installing Pro-tier stack…`);
  const res = await installPluginsForTier({
    domain,
    tier: 'pro',
    installShop: false,
    publishPdfs: false,
    iaPluginDownloadUrl: downloadUrl,
    provisionCode,
    onlySlugs: SLUGS,
  });
  console.log(`[${domain}] installed:`, res.installed || []);
  console.log(`[${domain}] skipped: `, res.skipped || []);
  console.log(`[${domain}] failed:  `, res.failed || []);
})().catch((e) => {
  console.error(`[${domain}] FATAL:`, e.message);
  process.exit(1);
});
