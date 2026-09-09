#!/usr/bin/env node
/**
 * _dev_verify_walk_fixes.mjs — the half of the final walk fixes that cannot be
 * a unit test: does the brand kit written by ONBOARDING'S OWN CODE reach the
 * CSS a visitor's browser downloads, and does a newsletter issue really become
 * a readable blog post on the site?
 *
 * It drives the real modules — `lib/elementorGlobals.setElementorGlobals` and
 * `lib/websiteBuilder/postComposer.composePostFromHtml` — against the dev
 * WordPress container, asserts on the RENDERED PAGE rather than on the absence
 * of an error, BREAKS THINGS ON PURPOSE, and puts everything back.
 *
 * ⚠ Dev only. It refuses to run against anything but a loopback host.
 * ⚠ It needs the pack 2 plugin (>= 1.7.4) mounted in the dev container.
 * ⚠ IT LEAVES ITS TEST POST IN THE BIN, not gone. The kit is put back exactly,
 *   and the post is trashed, but a trashed post is still listed in the
 *   Portal's "Deleted pages" card by design — so after a run, empty those
 *   "Spring tips walkfix-…" rows from that card before anybody walks the site.
 *
 *   node scripts/_dev_verify_walk_fixes.mjs [--base http://localhost:8084]
 */

import fs from 'node:fs';
import { setElementorGlobals } from '../lib/elementorGlobals.js';
import { composePostFromHtml } from '../lib/websiteBuilder/postComposer.js';
import { fetchKit, writeKit } from '../lib/websiteBuilder/pageClient.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BASE = arg('base', 'http://localhost:8084');
const TOKEN_FILE = arg('token-file', 'C:\\dev\\iadm\\dev-stack\\wordpress\\.site-token');

if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(BASE)) {
  console.error(`Refusing to run against "${BASE}" — this script is for the local dev container only.`);
  process.exit(1);
}

const HOST = BASE.replace(/^https?:\/\//, '');
const SITE = { domain: HOST, site_token_raw: fs.readFileSync(TOKEN_FILE, 'utf8').trim() };

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** The page as a visitor gets it, cache defeated. */
async function html(url) {
  if (!url) return { status: 0, body: '' };
  const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_ia_nc=${Date.now()}`, {
    headers: { 'Cache-Control': 'no-cache' },
  });
  return { status: res.status, body: await res.text() };
}

/** Every stylesheet the page pulls in, concatenated. Elementor writes its kit
 *  variables into a generated file, so "stored" and "rendered" are different
 *  questions and only the second one matters to a client. */
async function renderedCss(pageUrl) {
  const page = await html(pageUrl);
  const hrefs = [...page.body.matchAll(/<link[^>]+href=["']([^"']+\.css[^"']*)["']/gi)].map((m) => m[1]);
  const inline = [...page.body.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const files = await Promise.all(hrefs.map(async (h) => {
    const url = h.startsWith('http') ? h : `${BASE}${h.startsWith('/') ? '' : '/'}${h}`;
    if (!url.startsWith(BASE)) return '';
    try { const r = await fetch(url); return r.ok ? await r.text() : ''; } catch { return ''; }
  }));
  return `${inline}\n${files.join('\n')}`;
}

const api = async (path, init) => {
  const res = await fetch(`${BASE}/wp-json/intelligent-analytics/v1${path}${path.includes('?') ? '&' : '?'}_ia_cb=${Date.now()}`, {
    ...init,
    headers: { Accept: 'application/json', 'X-Arion-Site-Token': SITE.site_token_raw, ...(init?.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, text };
};

(async () => {
  console.log(`\n=== final walk fixes, against ${BASE} ===\n`);

  /* ══════════ 0. the plugin build that answers these ══════════ */
  const status = await api('/status');
  check('the dev site is answering, on the pack 2 plugin',
    status.status === 200 && String(status.json?.data?.plugin_version || '') >= '1.7.4',
    String(status.json?.data?.plugin_version));

  /* ══════════ 1. D-81 — a provisioning run's colours reach the CSS ══════════ */
  console.log('\n-- D-81: the brand kit, written the way onboarding writes it --');

  const before = await fetchKit(SITE);
  check('the kit can be read before we touch it', before.ok && Number(before.data?.kit_id) > 0,
    `status ${before.status}`);
  const coloursBefore = (before.data?.colors || []).map((c) => ({ id: c.id, color: c.color }));
  const fontsBefore = (before.data?.typography || []).map((t) => ({
    id: t.id, font_family: t.font_family, font_weight: t.font_weight,
  }));

  // A colour no theme ships with, so finding it in the CSS means WE put it there.
  const PRIMARY = '#7B2D8E';
  const SECONDARY = '#0F7B6C';
  const ACCENT = '#D97706';

  const applied = await setElementorGlobals({
    site: SITE,
    brandName: 'Summit Lawn',
    primaryColor: PRIMARY,
    secondaryColor: SECONDARY,
    accentColor: ACCENT,
    vertical: 'lawn care',
  });
  check('onboarding\'s own call writes the kit through the plugin',
    applied.ok === true && applied.via === 'plugin', JSON.stringify(applied).slice(0, 220));
  check('...and it names the kit it wrote', Number(applied.kit_id) > 0, String(applied.kit_id));

  const after = await fetchKit(SITE);
  const gotPrimary = (after.data?.colors || []).find((c) => c.id === 'primary');
  const gotAccent = (after.data?.colors || []).find((c) => c.id === 'accent');
  const gotFont = (after.data?.typography || []).find((t) => t.id === 'primary');
  check('the website is holding the primary colour',
    String(gotPrimary?.color || '').toLowerCase() === PRIMARY.toLowerCase(), JSON.stringify(gotPrimary));
  check('...and the accent', String(gotAccent?.color || '').toLowerCase() === ACCENT.toLowerCase(), JSON.stringify(gotAccent));
  check('...and the heading font the vertical chose (Inter for a service business)',
    gotFont?.font_family === 'Inter', JSON.stringify(gotFont));

  // THE ONE THAT MATTERS: a visitor's browser.
  const css = await renderedCss(BASE);
  check('THE COLOUR REACHES THE RENDERED CSS a visitor downloads',
    css.toLowerCase().includes(PRIMARY.toLowerCase()),
    `${css.length} bytes of css, no ${PRIMARY}`);
  check('...as an Elementor global, not a one-off',
    /--e-global-color-primary\s*:\s*#7B2D8E/i.test(css),
    (css.match(/--e-global-color-primary[^;]*/i) || ['not found'])[0]);

  // BREAK IT ON PURPOSE — the guards, against the real site.
  const badColour = await setElementorGlobals({
    site: SITE, primaryColor: 'purple', secondaryColor: SECONDARY, accentColor: ACCENT,
  });
  check('a colour that is not a colour never reaches the website',
    badColour.ok === false && badColour.error === 'missing_or_invalid_brand_colors', JSON.stringify(badColour));

  const noSite = await setElementorGlobals({
    primaryColor: PRIMARY, secondaryColor: SECONDARY, accentColor: ACCENT,
  });
  check('a call with no site is refused before anything is sent',
    noSite.ok === false && noSite.error === 'no_domain_for_site', JSON.stringify(noSite));

  const wrongToken = await setElementorGlobals({
    site: { domain: HOST, site_token_raw: 'not-the-token' },
    primaryColor: PRIMARY, secondaryColor: SECONDARY, accentColor: ACCENT,
  });
  check('a site that does not know us is a FAILURE, not a quiet success',
    wrongToken.ok === false, JSON.stringify(wrongToken).slice(0, 200));

  /* ══════════ 2. D-82 — an issue becomes a readable blog post ══════════ */
  console.log('\n-- D-82: a newsletter issue on the website --');

  const marker = `walkfix-${Date.now()}`;
  const post = await composePostFromHtml({
    site: SITE,
    title: `Spring tips ${marker}`,
    contentHtml:
      `<h2>What to do in March</h2><p>Feed the lawn and <strong>${marker}</strong> keep it long.</p>`
      + '<ul><li>Sharpen the blades</li><li>Test the soil</li></ul>'
      + '<script>alert(1)</script><p onclick="x()">Book a visit any time.</p>',
    excerpt: 'The three jobs that matter in March.',
    categories: ['Newsletter'],
  });
  check('the issue is published as a post', post.ok === true, JSON.stringify(post).slice(0, 240));
  check('...and it says where it went', !!post.postUrl, String(post.postUrl));
  if (post.warning) console.log(`        (warning: ${post.warning})`);

  const rendered = await html(post.postUrl);
  check('the post is live and reachable', rendered.status === 200, `status ${rendered.status}`);
  check('THE ARTICLE IS ON THE PAGE', rendered.body.includes(marker), 'the body text is not in the rendered HTML');
  check('...with its heading and its list', /What to do in March/.test(rendered.body) && /Sharpen the blades/.test(rendered.body));
  check('the script never reached the page', !/alert\(1\)/.test(rendered.body));
  check('...nor the click handler', !/onclick="x\(\)"/.test(rendered.body));

  const settings = await api(`/pages/${post.postId}/settings`);
  const fields = settings.json?.post_fields || settings.json?.data?.post_fields || {};
  const cats = (fields.categories || []).map(String);
  check('it is filed under Newsletter', cats.some((c) => /newsletter/i.test(c)), JSON.stringify(cats));
  check('...and it carries the summary', /three jobs/i.test(String(fields.excerpt || '')), String(fields.excerpt));

  // The issue's home is SPARK, not the website — a published post is a COPY,
  // and two editable copies of one article is two answers to "what does it
  // say?". So the section carries our handle for provenance and nothing
  // claims it can be edited here.
  const sections = await api(`/pages/${post.postId}/sections`);
  const list = sections.json?.sections || sections.json?.data?.sections || [];
  check('the post is one section, stamped as ours',
    list.length === 1 && String(list[0].title || list[0].handle || '').startsWith('ia:'),
    JSON.stringify(list).slice(0, 240));

  // BREAK IT ON PURPOSE.
  const empty = await composePostFromHtml({ site: SITE, title: 'Nothing', contentHtml: '<p>  </p>' });
  check('an empty issue is refused rather than published blank',
    empty.ok === false && empty.step === 'body', JSON.stringify(empty));

  const noAuth = await composePostFromHtml({
    site: { domain: HOST, site_token_raw: 'not-the-token' },
    title: 'Refused', contentHtml: '<p>x</p>',
  });
  check('a site that does not know us cannot be published to',
    noAuth.ok === false, JSON.stringify(noAuth).slice(0, 200));

  /* ══════════ PUT IT ALL BACK ══════════ */
  console.log('\n-- putting the dev site back --');

  const restored = await writeKit(SITE, {
    colors: coloursBefore.filter((c) => c.color),
    typography: fontsBefore.filter((t) => t.font_family),
  });
  check('the kit is back the way it was', restored.ok === true, JSON.stringify(restored).slice(0, 200));
  const finalKit = await fetchKit(SITE);
  const finalPrimary = (finalKit.data?.colors || []).find((c) => c.id === 'primary');
  const wasPrimary = coloursBefore.find((c) => c.id === 'primary');
  check('...proved by reading it back',
    String(finalPrimary?.color || '') === String(wasPrimary?.color || ''),
    `${finalPrimary?.color} vs ${wasPrimary?.color}`);
  const cssBack = await renderedCss(BASE);
  check('...and the test colour is gone from the rendered CSS',
    !cssBack.toLowerCase().includes(PRIMARY.toLowerCase()));

  if (post.postId) {
    const trashed = await api(`/pages/${post.postId}/trash`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check('the test post is gone', trashed.status === 200, `status ${trashed.status} ${trashed.text.slice(0, 120)}`);
    const gone = await html(post.postUrl);
    check('...and no longer reachable', gone.status !== 200 || !gone.body.includes(marker), `status ${gone.status}`);
  }
  if (noAuth.postId || empty.postId) {
    check('the refused runs left no draft behind', !noAuth.postId && !empty.postId,
      `${noAuth.postId} / ${empty.postId}`);
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} pass, ${fail} fail\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\nverifier threw:', err);
  process.exit(2);
});
