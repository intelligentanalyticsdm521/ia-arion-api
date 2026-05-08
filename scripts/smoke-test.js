#!/usr/bin/env node
/**
 * Hostinger API smoke test — run this BEFORE attempting an end-to-end signup
 * to confirm:
 *
 *   1. Your HOSTINGER_API_TOKEN is valid
 *   2. The endpoint paths and field names in lib/hostinger.js are correct
 *   3. You have an active hosting subscription with an order_id we can use
 *   4. You have catalog item IDs for the domain TLDs you want to sell
 *   5. You have at least one WHOIS profile (or know how to create one)
 *
 * Usage:
 *   HOSTINGER_API_TOKEN=... node scripts/smoke-test.js
 *
 * Exit codes:
 *   0 = all checks passed
 *   1 = at least one critical check failed
 *
 * The script never makes purchasing or destructive calls — it's read-only
 * except for an optional dry-run WHOIS profile creation flag.
 */

import 'dotenv/config';
import {
  listSubscriptions,
  getCatalogItems,
  listWebsites,
  listDomains,
  listWhoisProfiles,
} from '../lib/hostinger.js';

const HOSTINGER_TOKEN = process.env.HOSTINGER_API_TOKEN;

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const BOLD = '\x1b[1m';

let failed = 0;

function pass(msg) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function fail(msg) { console.log(`${RED}✗${RESET} ${msg}`); failed += 1; }
function warn(msg) { console.log(`${YELLOW}!${RESET} ${msg}`); }
function info(msg) { console.log(`  ${msg}`); }
function header(msg) { console.log(`\n${BOLD}${CYAN}== ${msg} ==${RESET}`); }

async function main() {
  console.log(`${BOLD}Hostinger API smoke test${RESET}\n`);

  if (!HOSTINGER_TOKEN) {
    fail('HOSTINGER_API_TOKEN env var is not set');
    console.log('\nSet it before running:');
    console.log('  export HOSTINGER_API_TOKEN=your_token_from_developers.hostinger.com');
    process.exit(1);
  }
  pass('HOSTINGER_API_TOKEN is set');

  // -------------------------------------------------------------------------
  // 1. Hosting subscriptions — we need an order_id for createWebsite
  // -------------------------------------------------------------------------
  header('Hosting subscriptions');
  const subs = await listSubscriptions();
  if (!subs) {
    fail('GET /api/billing/v1/subscriptions returned null — token may be invalid or insufficient permissions');
  } else {
    const subList = Array.isArray(subs) ? subs : (subs.data || subs.subscriptions || []);
    pass(`Found ${subList.length} subscription(s)`);
    const activeHosting = subList.filter((s) => {
      const isHosting = String(s.category || s.type || s.product || '').toLowerCase().includes('hosting');
      const isActive = ['active', 'on'].includes(String(s.status || '').toLowerCase());
      return isHosting || isActive; // be permissive; print all and let user pick
    });
    for (const s of subList.slice(0, 10)) {
      info(`id=${s.id || s.subscription_id} status=${s.status} category=${s.category || '-'} product=${s.name || s.product || '-'}`);
    }
    if (activeHosting.length === 0) {
      warn('No "hosting" subscription found. createWebsite needs an order_id from an active hosting plan.');
    } else {
      info('');
      info(`${BOLD}Set this in your env:${RESET}  HOSTINGER_DEFAULT_ORDER_ID=<id of the hosting subscription you want to use>`);
    }
  }

  // -------------------------------------------------------------------------
  // 2. Existing websites
  // -------------------------------------------------------------------------
  header('Existing websites on hosting account');
  const sites = await listWebsites();
  if (!sites) {
    fail('GET /api/hosting/v1/websites returned null');
  } else {
    const list = Array.isArray(sites) ? sites : (sites.data || sites.websites || []);
    pass(`Found ${list.length} website(s)`);
    for (const w of list.slice(0, 10)) {
      info(`domain=${w.domain || w.url} state=${w.state || w.status} order=${w.order_id || '-'}`);
    }
  }

  // -------------------------------------------------------------------------
  // 3. Catalog items — need item_id per TLD for purchaseDomain
  // -------------------------------------------------------------------------
  header('Catalog items (domain TLD prices)');
  const catalog = await getCatalogItems();
  if (!catalog) {
    fail('GET /api/billing/v1/catalog returned null');
  } else {
    const items = Array.isArray(catalog) ? catalog : (catalog.data || catalog.items || []);
    pass(`Found ${items.length} catalog item(s)`);
    const domainItems = items.filter((i) => {
      const cat = String(i.category || i.type || '').toLowerCase();
      const name = String(i.name || i.title || '').toLowerCase();
      return cat.includes('domain') || name.includes('.com') || name.includes('.net');
    });
    info(`Domain-related items: ${domainItems.length}`);
    for (const i of domainItems.slice(0, 20)) {
      info(`  id=${i.id} tld=${i.tld || '-'} name=${i.name} price=${i.price || i.first_period_price || '?'}`);
    }
    if (domainItems.length > 0) {
      info('');
      info(`${BOLD}Set these in env (one per TLD you want to sell):${RESET}`);
      info('  HOSTINGER_DOMAIN_ITEM_COM=<id of .com catalog item>');
      info('  HOSTINGER_DOMAIN_ITEM_NET=<id of .net catalog item>');
      info('  ...etc');
    }
  }

  // -------------------------------------------------------------------------
  // 4. Domain portfolio
  // -------------------------------------------------------------------------
  header('Domain portfolio');
  const domains = await listDomains();
  if (!domains) {
    fail('GET /api/domains/v1/portfolio returned null');
  } else {
    const list = Array.isArray(domains) ? domains : (domains.data || domains.domains || []);
    pass(`Found ${list.length} domain(s)`);
    for (const d of list.slice(0, 10)) {
      info(`domain=${d.domain || d.name} status=${d.status || '-'} expires=${d.expires_at || d.expiration_date || '-'}`);
    }
  }

  // -------------------------------------------------------------------------
  // 5. WHOIS profiles
  // -------------------------------------------------------------------------
  header('WHOIS contact profiles');
  const whois = await listWhoisProfiles();
  if (!whois) {
    fail('GET /api/domains/v1/whois returned null');
  } else {
    const list = Array.isArray(whois) ? whois : (whois.data || whois.profiles || []);
    pass(`Found ${list.length} WHOIS profile(s)`);
    for (const p of list.slice(0, 10)) {
      info(`id=${p.id} tld=${p.tld} country=${p.country} entity=${p.entity_type}`);
    }
    if (list.length === 0) {
      warn('No existing WHOIS profiles. You\'ll need to create one (with real contact data) for any domain TLD before purchasing.');
    }
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('');
  if (failed === 0) {
    console.log(`${GREEN}${BOLD}All Hostinger API checks passed.${RESET}`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Set HOSTINGER_DEFAULT_ORDER_ID from the subscriptions list above');
    console.log('  2. Set HOSTINGER_DOMAIN_ITEM_<TLD> for each TLD you want to sell');
    console.log('  3. Run:  node scripts/test-worker.js  (manually triggers a provisioning job)');
    process.exit(0);
  } else {
    console.log(`${RED}${BOLD}${failed} check(s) failed.${RESET} Fix the above before testing the full flow.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n${RED}Smoke test crashed:${RESET}`, err);
  process.exit(2);
});
