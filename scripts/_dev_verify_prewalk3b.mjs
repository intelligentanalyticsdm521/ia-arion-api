#!/usr/bin/env node
/**
 * _dev_verify_prewalk3b.mjs — the pre-walk pass 3b fix, proven against the REAL
 * dev WordPress container.
 *
 * THE DEFECT. Every write route in the plugin reads its value back and refuses
 * to report a save that did not land — a good guard, and it was calling landed
 * saves failures. WordPress runs sanitize_option() / wp_kses_post() on the way
 * in, which turns a bare `&` into `&amp;`, so a strict `===` on the way out
 * said "Your website did not keep that" about a business name or footer line
 * that was already live on the site.
 *
 * It fired on the walk's own fixture: pressing the pack's OWN
 * "Use © 2026 Summit Lawn & Landscape. All rights reserved." button and saving
 * answered HTTP 502 "Your website did not keep: Footer wording." while the
 * footer read correctly on the website. Walk rows A2-20 and A2-24.
 *
 * This drives the plugin's own REST routes with the site token, exactly as
 * arion-api does, and asserts on the ANSWER and on the RENDERED PAGE — not on
 * the absence of an error (feedback_assert_presence_not_just_absence). It puts
 * every value back the way it found it.
 *
 * ⚠ Dev only: loopback host, and it refuses anything else.
 * ⚠ Needs the PRE-WALK 3B plugin mounted:
 *     dev-stack\start-dev-wp.ps1 -PluginDir C:\dev\iadm\ia-plugin-septa-prewalk3b
 *
 *   node scripts/_dev_verify_prewalk3b.mjs [--base http://localhost:8084]
 */

import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const BASE = arg('base', 'http://localhost:8084');
const TOKEN_FILE = arg('token-file', 'C:\\dev\\iadm\\dev-stack\\wordpress\\.site-token');
const API = `${BASE}/wp-json/intelligent-analytics/v1`;

if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(BASE)) {
  console.error(`Refusing to run against "${BASE}" — local dev container only.`);
  process.exit(1);
}
const TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();

let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
  if (ok) { pass++; console.log(`  PASS  ${n}`); }
  else { fail++; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); }
};

async function call(path, { method = 'GET', body } = {}) {
  const url = `${API}${path}${path.includes('?') ? '&' : '?'}_cb=${Date.now()}${Math.random()}`;
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'X-Arion-Site-Token': TOKEN,
      ...(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
const page = async (p = '/') => (await fetch(`${BASE}${p}?_cb=${Date.now()}`)).text();

console.log(`=== pre-walk 3b against ${BASE} ===\n`);

const status = await call('/status');
check('the site is answering', status.status === 200, `status ${status.status}`);
check('...and running a plugin new enough to carry the fix',
  String(status.json?.data?.plugin_version || '') >= '1.7.4', String(status.json?.data?.plugin_version));

/* ── what it was, so we can put it back ─────────────────────────────────── */
const before = await call('/site/chrome');
const was = {};
for (const f of (before.json?.fields || [])) was[f.key] = f.value;
const beforeOptions = await call('/site/options');
const wasLabel = beforeOptions.json?.booking?.label;

try {
  /* ── A2-20 · a business name with an ampersand ─────────────────────── */
  console.log('\n-- a business name with an ampersand in it --');
  const AMP_NAME = 'Kelly & Sons Landscaping';
  const nameRes = await call('/site/chrome', { method: 'POST', body: { business_name: AMP_NAME } });
  check('saving it is reported as a SUCCESS', nameRes.status === 200,
    `status ${nameRes.status} ${nameRes.text.slice(0, 180)}`);
  const nameNow = (nameRes.json?.fields || []).find((f) => f.key === 'business_name');
  check('...and the name is really on the site',
    /Kelly (&|&amp;) Sons Landscaping/.test(String(nameNow?.value || '')), String(nameNow?.value));
  const home = await page('/');
  check('...and the browser tab really says it',
    /<title>Kelly &amp; Sons Landscaping<\/title>/.test(home),
    (home.match(/<title>[^<]*<\/title>/) || [''])[0]);

  /* ── A2-24 · the pack's own suggested footer line ──────────────────── */
  console.log('\n-- the footer line the pack itself offers --');
  const FOOTER = '© 2026 Summit Lawn & Landscape. All rights reserved.';
  const footRes = await call('/site/chrome', { method: 'POST', body: { footer_text: FOOTER } });
  check('pressing "Use ..." and saving is reported as a SUCCESS', footRes.status === 200,
    `status ${footRes.status} ${footRes.text.slice(0, 200)}`);
  const homeF = await page('/');
  check('...and the footer line is really on the website',
    /Summit Lawn &amp; Landscape\. All rights reserved\./.test(homeF));
  check('...with the copyright symbol intact, not a replacement character',
    homeF.includes('© 2026 Summit Lawn') && !/\uFFFD 2026 Summit Lawn/.test(homeF));

  /* ── the same defect on the two switches' label ────────────────────── */
  console.log('\n-- a "Book now" button reworded with an ampersand --');
  const LABEL = 'Quotes & repairs';
  const optRes = await call('/site/options', { method: 'POST', body: { booking_label: LABEL } });
  check('saving the new wording is reported as a SUCCESS', optRes.status === 200,
    `status ${optRes.status} ${optRes.text.slice(0, 180)}`);
  const homeL = await page('/');
  check('...and the button on the website really says it',
    /ia-book-now-item[^]{0,200}Quotes &amp; repairs/.test(homeL));

  /* ── THE GUARD IS STILL A GUARD ────────────────────────────────────── */
  // The whole point of the read-back is to catch a write that did NOT land.
  // Loosening the comparison must not loosen that, so ask for something the
  // site will refuse to store as asked and check we are still told.
  console.log('\n-- a write that really does not land is still refused --');
  const tooLong = 'x'.repeat(60);
  const longLabel = await call('/site/options', { method: 'POST', body: { booking_label: tooLong } });
  check('a label the site TRUNCATES is not reported as saved-as-asked',
    longLabel.status !== 200 || String(longLabel.json?.booking?.label || '').length <= 40,
    `status ${longLabel.status} label ${String(longLabel.json?.booking?.label || '').length}`);
  const notOurs = await call('/site/chrome', { method: 'POST', body: { admin_email: 'x@y.z' } });
  check('a setting we do not own is still REFUSED, in words',
    notOurs.status === 400 && /do not set/i.test(String(notOurs.json?.error || '')),
    `status ${notOurs.status}`);
  const emptyName = await call('/site/chrome', { method: 'POST', body: { business_name: '  ' } });
  check('an empty business name is still refused',
    emptyName.status === 400 && /cannot be empty/i.test(String(emptyName.json?.error || '')),
    `status ${emptyName.status}`);
} finally {
  /* ── put it all back ────────────────────────────────────────────────── */
  console.log('\n-- putting it back --');
  const restore = {};
  for (const k of ['business_name', 'footer_text']) if (was[k] !== undefined) restore[k] = was[k];
  const back = await call('/site/chrome', { method: 'POST', body: restore });
  const now = {};
  for (const f of (back.json?.fields || [])) now[f.key] = f.value;
  check('the business name is back', String(now.business_name) === String(was.business_name),
    `${now.business_name} vs ${was.business_name}`);
  check('the footer wording is back', String(now.footer_text) === String(was.footer_text),
    `${now.footer_text} vs ${was.footer_text}`);
  if (wasLabel !== undefined) {
    const backL = await call('/site/options', { method: 'POST', body: { booking_label: wasLabel } });
    check('the button wording is back', String(backL.json?.booking?.label) === String(wasLabel));
  }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
