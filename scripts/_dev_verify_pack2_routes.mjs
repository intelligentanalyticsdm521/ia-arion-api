#!/usr/bin/env node
/**
 * _dev_verify_pack2_routes.mjs — the ARION pack 2 routes, live, the way the
 * Portal calls them.
 *
 * `_dev_verify_pack2.mjs` drives the PLUGIN. This one drives ARION-API through
 * dev-auth, because the branches that matter most here are the ones between
 * the Portal and the plugin: the shapes the screens read, the refusals a
 * client is supposed to SEE, and the two places where a business's own
 * identity has to be offered rather than invented.
 *
 * The rule underneath all of them: never a success on a failure
 * (`reference_catch_swallow_report_success`).
 *
 *   node scripts/_dev_verify_pack2_routes.mjs [--api http://localhost:4046]
 *
 * Needs: the dev WordPress container on plugin >= 1.7.4, and arion-api running
 * from THIS worktree with DEV_AUTH=1 on the given port.
 */

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const API = arg('api', 'http://localhost:4046');
const TENANT = arg('tenant', 'a0000001-0000-0000-0000-000000000001');
const SITE = arg('site', 'e68a46ae-b5ee-441d-a71c-2afeca12a658');

if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(API)) {
  console.error(`Refusing to run against "${API}" — this script is for the local dev API only.`);
  process.exit(1);
}

let pass = 0;
let fail = 0;
const check = (n, ok, d = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); }
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      'x-dev-tenant': TENANT,
      Authorization: 'Bearer dev',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
}

const base = `/arion/sites/${SITE}`;

console.log(`\n=== ARION pack 2 routes against ${API} ===\n`);

/* ── menus ───────────────────────────────────────────────────────────── */
console.log('-- menus --');
const menus = await api(`${base}/menus`);
check('the Portal can read the menus', menus.status === 200 && Array.isArray(menus.json?.data?.menus),
  `status ${menus.status} ${menus.text.slice(0, 160)}`);
const menu = menus.json?.data?.menus?.[0];
check('...in camelCase, with nothing a client should not read',
  !!menu && typeof menu.menuId === 'number' && Array.isArray(menu.items)
  && !JSON.stringify(menus.json.data).includes('menu_item_parent'),
  JSON.stringify(menu || {}).slice(0, 160));
check('...and the pages a client could add', Array.isArray(menus.json?.data?.addable));
check('...and where the design can put a menu', Array.isArray(menus.json?.data?.locations));

const badId = await api(`${base}/menus/not-a-number`, { method: 'PUT', body: { items: [] } });
check('a menu reference that is not one is refused before anything is written',
  badId.status === 400, `status ${badId.status}`);

const tooMany = await api(`${base}/menus/${menu?.menuId || 1}`, {
  method: 'PUT',
  body: { items: Array.from({ length: 101 }, () => ({ kind: 'custom', title: 'x', url: '/' })) },
});
check('a menu longer than a menu can usefully be is refused', tooMany.status === 400,
  `status ${tooMany.status}`);

const emptyPut = await api(`${base}/menus/${menu?.menuId || 1}`, { method: 'PUT', body: {} });
check('a save with nothing in it is refused rather than reported saved', emptyPut.status === 400);

const noName = await api(`${base}/menus`, { method: 'POST', body: { name: '  ' } });
check('a menu with no name is refused', noName.status === 400, `status ${noName.status}`);

/* ── the brand kit ───────────────────────────────────────────────────── */
console.log('\n-- brand --');
const kit = await api(`${base}/site/kit`);
check('the Portal can read the colours and fonts', kit.status === 200 && typeof kit.json?.data?.kitId === 'number',
  `status ${kit.status} ${kit.text.slice(0, 160)}`);
check('...with what the business identity suggests, or nothing at all',
  kit.json?.data?.suggested !== undefined, JSON.stringify(kit.json?.data?.suggested || null).slice(0, 200));
const suggested = kit.json?.data?.suggested;
check('...and a suggested palette is only ever offered when a brand colour is ON FILE',
  !suggested || suggested.hasBrandColour === (suggested.colors.length > 0),
  JSON.stringify(suggested).slice(0, 200));

const badHex = await api(`${base}/site/kit`, { method: 'POST', body: { colors: [{ id: 'primary', color: 'blue' }] } });
check('a colour that is not a colour is refused with a sentence',
  badHex.status === 400 && /#1A3A4A/.test(String(badHex.json?.error?.message || '')),
  `status ${badHex.status} ${badHex.text.slice(0, 160)}`);

const noId = await api(`${base}/site/kit`, { method: 'POST', body: { colors: [{ color: '#123456' }] } });
check('a colour that does not say which one it is is refused', noId.status === 400);

/* ── header and footer ───────────────────────────────────────────────── */
console.log('\n-- header and footer --');
const chrome = await api(`${base}/site/chrome`);
check('the Portal can read the header and footer', chrome.status === 200 && Array.isArray(chrome.json?.data?.fields),
  `status ${chrome.status} ${chrome.text.slice(0, 160)}`);
check('...and is told which design is running', !!chrome.json?.data?.theme, String(chrome.json?.data?.theme));
const fields = chrome.json?.data?.fields || [];
check('every field says whether the design offers it, and why not',
  fields.every((f) => typeof f.supported === 'boolean' && (f.supported || typeof f.reason === 'string')),
  JSON.stringify(fields.filter((f) => !f.supported).map((f) => [f.key, f.reason])).slice(0, 200));
check('the menu positions are read-only context, so there is one writer',
  Array.isArray(chrome.json?.data?.menuLocations));

const sugg = chrome.json?.data?.suggested;
check('the suggested wording comes from the ONE business identity',
  !!sugg && typeof sugg.businessName === 'string' && typeof sugg.footerText === 'string',
  JSON.stringify(sugg).slice(0, 200));
check('...and a business with no recorded name is offered NOTHING, never a guess',
  !sugg || (sugg.businessName ? sugg.footerText.includes(sugg.businessName) : sugg.footerText === ''),
  JSON.stringify(sugg).slice(0, 200));

const notOurs = await api(`${base}/site/chrome`, { method: 'POST', body: { admin_email: 'x@y.z' } });
check('a setting we do not own comes back as a refusal the client can read',
  notOurs.status === 400 && /do not set/i.test(String(notOurs.json?.error?.message || '')),
  `status ${notOurs.status} ${notOurs.text.slice(0, 160)}`);

const nothingToDo = await api(`${base}/site/chrome`, { method: 'POST', body: {} });
check('an empty save is refused', nothingToDo.status === 400);

/* ── the two switches ────────────────────────────────────────────────── */
console.log('\n-- site options --');
const options = await api(`${base}/site/options`);
check('the Portal can read both switches',
  options.status === 200 && typeof options.json?.data?.chat?.enabled === 'boolean',
  `status ${options.status} ${options.text.slice(0, 160)}`);
check('...and whether the plan allows the booking button',
  typeof options.json?.data?.booking?.tierAllows === 'boolean');

const notASetting = await api(`${base}/site/options`, { method: 'POST', body: { adminEmail: 'x@y.z' } });
check('a setting we do not own is refused, in words',
  notASetting.status === 400 && /do not set/i.test(String(notASetting.json?.error?.message || '')),
  `status ${notASetting.status}`);

const longLabel = await api(`${base}/site/options`, { method: 'POST', body: { bookingLabel: 'x'.repeat(60) } });
check('a button label longer than a button is refused', longLabel.status === 400);

/* ── the one price source ────────────────────────────────────────────── */
console.log('\n-- the price list --');
const prices = await api(`${base}/pricing-catalogue`);
check('the Portal can ask for the business own prices',
  prices.status === 200 && typeof prices.json?.data?.available === 'boolean',
  `status ${prices.status} ${prices.text.slice(0, 160)}`);
check('...and is told WHY there are none, rather than shown an empty box',
  prices.json?.data?.available === true || typeof prices.json?.data?.reason === 'string',
  JSON.stringify(prices.json?.data).slice(0, 200));
check('...and every price that IS offered carries which service it came from',
  (prices.json?.data?.services || []).every((s) => typeof s.offeringId === 'string' && s.offeringId.length > 0),
  JSON.stringify(prices.json?.data?.services || []).slice(0, 200));

/* ── the new section kinds, through the picker ───────────────────────── */
console.log('\n-- the three new sections --');
const library = await api(`${base}/section-library`);
const kinds = (library.json?.data?.sections || []).map((k) => k.kind);
check('pricing, team and stats are in the "add a section" picker',
  ['pricing', 'team', 'stats'].every((k) => kinds.includes(k)), kinds.join(','));
check('...and all three are available on EVERY tier - none of them needs the paid add-on',
  (library.json?.data?.sections || [])
    .filter((k) => ['pricing', 'team', 'stats'].includes(k.kind))
    .every((k) => k.available === true),
  JSON.stringify((library.json?.data?.sections || [])
    .filter((k) => ['pricing', 'team', 'stats'].includes(k.kind))
    .map((k) => [k.kind, k.available])));
let pricingPlans = null;
for (const kind of ['pricing', 'team', 'stats']) {
  const built = await api(`${base}/sections`, { method: 'POST', body: { kind } });
  check(`a ${kind} section can be added, and comes back editable`,
    (built.status === 200 || built.status === 201) && built.json?.data?.section?.editable !== false,
    `status ${built.status} ${built.text.slice(0, 160)}`);
  if (kind === 'pricing') pricingPlans = built.json?.data?.section?.fields?.plans || null;
}

/* THE CLAIM THIS PACK MAKES ABOUT PRICES, checked against the real rows.
   "A price is never typed twice" is only true if a brand-new pricing section
   already carries the business's OWN prices - the same ones the booking page
   and the invoices read. Asserting the price is THERE, not that nothing went
   wrong (memory: feedback_assert_presence_not_just_absence). */
const catalogue = await api(`${base}/pricing-catalogue`);
const catServices = catalogue.json?.data?.services || [];
const catPriced = catServices.filter((s) => String(s.price || '').trim() !== '');
if (catPriced.length > 0) {
  const byId = new Map(catServices.map((s) => [s.offeringId, s]));
  check('a brand-new pricing section already carries the business own prices',
    Array.isArray(pricingPlans) && pricingPlans.length > 0
      && pricingPlans.every((p) => byId.has(p.offering_id))
      && pricingPlans.some((p) => p.price === byId.get(p.offering_id).price && p.price !== ''),
    JSON.stringify((pricingPlans || []).map((p) => [p.name, p.price, p.offering_id])).slice(0, 260));
  check('...and every card says WHICH service its price came from, so it is never typed twice',
    (pricingPlans || []).every((p) => String(p.offering_id || '') !== ''),
    JSON.stringify((pricingPlans || []).map((p) => p.offering_id)));
  check('...with the priced services first, so the top card is not blank',
    (pricingPlans || [])[0] && String(pricingPlans[0].price || '').trim() !== '',
    JSON.stringify((pricingPlans || []).map((p) => p.price)));
} else {
  check('a business with no priced services is told so rather than shown a made-up price',
    Array.isArray(pricingPlans) && pricingPlans.every((p) => String(p.price || '') === ''),
    JSON.stringify(pricingPlans));
}

/* ── a website that cannot be reached fails LOUDLY ───────────────────── */
console.log('\n-- a site that is not there --');
const ghost = await api('/arion/sites/00000000-0000-0000-0000-000000000000/menus');
check('a website that is not on this account is a 404, not an empty list',
  ghost.status === 404, `status ${ghost.status}`);

console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
process.exit(fail === 0 ? 0 : 1);
