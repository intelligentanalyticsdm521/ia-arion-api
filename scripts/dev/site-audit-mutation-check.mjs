#!/usr/bin/env node
/**
 * site-audit-mutation-check.mjs — break every guard of the website check on
 * purpose and prove the test that owns it goes RED (feedback_mutation_test_your_guards).
 *
 * Each mutation edits one file, runs test/site-audit.test.mjs, requires the
 * NAMED test to fail, puts the file back and proves it is byte-identical.
 * Pure code: no database, no server, no blob. Safe to run any time.
 *
 *   node scripts/dev/site-audit-mutation-check.mjs          (all)
 *   ONLY=A8,V3 node scripts/dev/site-audit-mutation-check.mjs  (just those)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const REPO = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const f = (rel) => path.join(REPO, rel);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

let caught = 0;
let missed = 0;

function runTests() {
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/site-audit.test.mjs'], { cwd: REPO, encoding: 'utf8', timeout: 300_000 });
  return `${r.stdout}\n${r.stderr}`;
}

function mutate({ id, name, edits, mustFail }) {
  const originals = new Map();
  for (const e of edits) {
    const p = f(e.file);
    if (!originals.has(p)) originals.set(p, { text: fs.readFileSync(p, 'utf8'), sha: sha(p) });
  }
  try {
    for (const e of edits) {
      const p = f(e.file);
      const now = fs.readFileSync(p, 'utf8');
      const count = now.split(e.from).length - 1;
      if (count !== 1) throw new Error(`${e.file}: the line to break was found ${count} times`);
      fs.writeFileSync(p, now.replace(e.from, () => e.to)); // a function: "$" in e.to stays literal
    }
    const out = runTests();
    const red = out.split('\n').filter((l) => /^\s*not ok \d+ - /.test(l)).map((l) => l.replace(/^\s*not ok \d+ - /, '').trim());
    const hit = red.some((l) => l.includes(mustFail));
    if (hit) { caught += 1; console.log(`  RED     ${id} ${name}\n          -> "${mustFail}"`); }
    else { missed += 1; console.log(`  MISSED  ${id} ${name} — red were: ${red.join(' | ') || 'none'}`); }
  } catch (err) {
    missed += 1;
    console.log(`  SKIP    ${id} ${name} — ${err.message}`);
  } finally {
    for (const [p, o] of originals) {
      fs.writeFileSync(p, o.text);
      if (sha(p) !== o.sha) { missed += 1; console.log(`  NOT RESTORED: ${p}`); }
    }
  }
}

const M = [
  { id: 'A1', name: 'signature compare', mustFail: 'a body signed with another secret is refused',
    edits: [{ file: 'lib/audit/signature.js', from: 'if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {', to: 'if (false) {' }] },
  { id: 'A2', name: 'replay window', mustFail: 'a request signed 10 minutes ago is refused',
    edits: [{ file: 'lib/audit/signature.js', from: 'if (Math.abs(Math.floor(nowMs / 1000) - Number(t)) > WINDOW_SECONDS) {', to: 'if (false) {' }] },
  { id: 'A3', name: 'SSRF private-address refusal', mustFail: 'a website on a private address is refused',
    edits: [{ file: 'lib/audit/safeFetch.js', from: "    if (bad) throw new SafeFetchRefused('not_public', `${host} -> ${bad.address}`);", to: '' }] },
  { id: 'A3b', name: 'ANY bad address refuses the host (not just the first)', mustFail: 'a name that answers one public and one private address is refused',
    edits: [{ file: 'lib/audit/safeFetch.js', from: 'const bad = addresses.find(', to: 'const bad = addresses.slice(0, 1).find(' }] },
  { id: 'A3c', name: 'addresses classified as bytes (reverted to the dotted-only text check)', mustFail: 'IPv4 written as IPv6',
    edits: [{ file: 'lib/audit/safeFetch.js', from: "/** True for any address a public website can never have. */\nexport function isBlockedAddress(ip) {\n  const s = String(ip || '').toLowerCase();\n  const v4 = asV4(s);\n  if (v4) {\n    const n = v4ToInt(v4);\n    return n === null || v4InBlocked(n);\n  }\n  const b = v6Bytes(s);\n  if (!b) return true; // not an address at all: refuse\n  // Only global unicast (2000::/3) can be a public website. This one rule\n  // refuses ::, ::1, NAT64 64:ff9b::/96 and 64:ff9b:1::/48 (an IPv4 address\n  // inside), the discard prefix 100::/64, link-local fe80::/10, site-local\n  // fec0::/10, unique-local fc00::/7 and multicast ff00::/8.\n  if ((b[0] & 0xe0) !== 0x20) return true;\n  // Inside 2000::/3, the ranges that carry or relay another address:\n  if (b[0] === 0x20 && b[1] === 0x02) return true; // 2002::/16 6to4 (IPv4 in bytes 2-5)\n  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // 2001::/32 Teredo\n  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation\n  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && (b[3] & 0xf0) === 0x10) return true; // 2001:10::/28 ORCHID\n  return false;\n}\n", to: "/** True for any address a public website can never have. */\nexport function isBlockedAddress(ip) {\n  const s = String(ip || '').toLowerCase();\n  const m = /^::ffff:(d+.d+.d+.d+)$/i.exec(s);\n  const v4 = net.isIPv4(s) ? s : (m ? m[1] : null);\n  if (v4) {\n    const n = v4ToInt(v4);\n    return n === null || v4InBlocked(n);\n  }\n  if (!net.isIPv6(s)) return true;\n  if (s === '::' || s === '::1') return true;\n  const first = parseInt(s.split(':')[0] || '0', 16);\n  if ((first & 0xffc0) === 0xfe80) return true;\n  if ((first & 0xfe00) === 0xfc00) return true;\n  if ((first & 0xff00) === 0xff00) return true;\n  return false;\n}\n" }] },
  { id: 'A3d', name: 'only global unicast IPv6 (NAT64 and friends let through)', mustFail: 'IPv4 written as IPv6',
    edits: [{ file: 'lib/audit/safeFetch.js', from: '  if ((b[0] & 0xe0) !== 0x20) return true;', to: '' }] },
  { id: 'A3e', name: 'IPv4 inside IPv6 is checked as IPv4 (redirect hop)', mustFail: 'a redirect to a hex-mapped metadata or private address is refused at the hop',
    edits: [{ file: 'lib/audit/safeFetch.js', from: '  return mapped || compatible ?', to: '  return false ?' }, { file: 'lib/audit/safeFetch.js', from: '  if ((b[0] & 0xe0) !== 0x20) return true;', to: '' }] },
  { id: 'R1', name: 'robots rules matched without a backtracking regex', mustFail: 'a pathological robots rule against a 5,000-character path',
    edits: [{ file: 'lib/audit/robots.js', from: '  const { pieces, anchored } = rule;\n',
      to: "  const { pieces, anchored } = rule;\n  return new RegExp('^' + pieces.map((x) => x.replace(/[^a-zA-Z0-9\\/]/g, '\\\\$&')).join('.*') + (anchored ? '$' : '')).test(path);\n" }] },
  { id: 'R2', name: 'robots rule caps', mustFail: 'rules are capped',
    edits: [{ file: 'lib/audit/robots.js', from: '|| current.rules.length >= MAX_RULES', to: '' }] },
  { id: 'H1', name: 'comments/scripts/styles cut by the linear scanner (reverted to lazy regexes)', mustFail: '2 MB of "<!--" is checked in under 500 ms',
    edits: [{ file: 'lib/audit/checks.js', from: "  let s = capped(html);\n  s = cutSpans(s, '<!--', '-->', false);",
      to: "  let s = String(html || '').replace(/<!--[\\s\\S]*?-->/g, ' ');" }] },
  { id: 'H2', name: 'anchors read by the linear scanner (reverted to the lazy anchor regex)', mustFail: '2 MB of "<a href=x>" is checked in under 500 ms',
    edits: [{ file: 'lib/audit/checks.js', from: "  for (const b of blocks(vis, asciiLower(vis), 'a')) {\n    const a = attrsOf(b.tag);",
      to: "  const re = /<a\\b([^>]*)>([\\s\\S]*?)<\\/a>/gi; let m;\n  while ((m = re.exec(vis))) {\n    const b = { tag: `<a ${m[1]}>`, inner: m[2] };\n    const a = attrsOf(b.tag);" }] },
  { id: 'H3', name: 'closer searches are remembered (finder cache off)', mustFail: 'is checked in under 500 ms',
    edits: [{ file: 'lib/audit/checks.js', from: '    if (askedFrom >= 0 && pos >= askedFrom && (found === -1 || found >= pos)) return found;\n', to: '' }] },
  { id: 'H4', name: 'a bad numeric entity becomes the replacement character', mustFail: 'a huge numeric entity on the home page does not break the check',
    edits: [{ file: 'lib/audit/checks.js', from: "const fromCode = (n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\\ufffd');",
      to: 'const fromCode = (n) => String.fromCodePoint(n);' }] },
  { id: 'C1', name: 'contact links by whole path segment and whole words (reverted to substrings)', mustFail: 'a Facebook icon, a search box or a /notebooks link',
    edits: [{ file: 'lib/audit/checks.js', from: 'const contactLink = anchors.some((a) => isContactHref(a.href) || CONTACT_WORDS.test(a.text));',
      to: 'const contactLink = anchors.some((a) => /^mailto:/i.test(a.href) || /contact|get-in-touch|quote|book/i.test(a.href) || /\\bcontact\\b|get in touch|book|quote/i.test(a.text));' }] },
  { id: 'C2', name: 'only a form with an email, phone or message box counts', mustFail: 'a Facebook icon, a search box or a /notebooks link',
    edits: [{ file: 'lib/audit/checks.js', from: 'const form = contactForms(vis);', to: "const form = named(scanTags(capped(html), asciiLower(capped(html))), 'form').length > 0;" }] },
  { id: 'B1', name: 'robots-blocked report scores only speed and security', mustFail: 'the report scores only speed and security',
    edits: [{ file: 'lib/audit/score.js', from: '    google: blocked ? none : googleSection(crawl, psiMobile, psiDesktop),', to: '    google: googleSection(crawl, psiMobile, psiDesktop),' }] },
  { id: 'B2', name: 'robots-blocked crawl does not fetch the sitemap', mustFail: 'the report scores only speed and security',
    edits: [{ file: 'lib/audit/crawl.js', from: '  if (!result.sitemapPresent && !blocked) {', to: '  if (!result.sitemapPresent) {' }] },
  { id: 'B3', name: 'a disallowed start page is not read', mustFail: 'robots disallowing the start page itself',
    edits: [{ file: 'lib/audit/crawl.js', from: ' || !isAllowed(robots, pathWithQuery(start));', to: ';' }] },
  { id: 'W1', name: 'the findings heading matches the count', mustFail: 'report words stay true at the edges',
    edits: [{ file: 'lib/audit/report.js', from: "  if (n === 1) return 'The thing to fix first';", to: '' }] },
  { id: 'W2', name: '"Most people leave after 3" only above 3 seconds', mustFail: 'report words stay true at the edges',
    edits: [{ file: 'lib/audit/score.js', from: "${secs > 3 ? ' Most people leave after 3.' : ''}", to: ' Most people leave after 3.' }] },
  { id: 'L1', name: 'a repeat ask keeps the same links (keys made random again)', mustFail: 'a repeat ask of a delivered run answers with the same links',
    edits: [{ file: 'lib/audit/links.js', from: "  return crypto.createHmac('sha256', sub).update(`${kind}:${String(runId).toLowerCase()}`).digest('base64url');",
      to: "  void sub; return crypto.randomBytes(32).toString('base64url');" }] },
  { id: 'S1', name: 'the callback runs outside the audit slots', mustFail: 'a run waiting on a callback retry holds no audit slot',
    edits: [{ file: 'lib/audit/runner.js', from: '        report(r).then(resolve);\n        await r.settled;\n', to: '        await r.settled;\n        resolve(await report(r));\n' }] },
  { id: 'S2', name: 'the slot is held until a capped audit has stopped', mustFail: 'the cap stops the audit',
    edits: [{ file: 'lib/audit/runner.js', from: '        report(r).then(resolve);\n        await r.settled;\n', to: '        report(r).then(resolve);\n' }] },
  { id: 'S3', name: 'a capped audit starts nothing new (cancel checks removed)', mustFail: 'the cap stops the audit',
    edits: [
      { file: 'lib/audit/crawl.js', from: '      stopIfCancelled(); // cap check: before each page\n', to: '' },
      { file: 'lib/audit/runner.js', from: '    stopIfCancelled(); // cap check: after the crawl\n', to: '' },
      { file: 'lib/audit/runner.js', from: '      stopIfCancelled(); // cap check: before the PDF\n', to: '' },
      { file: 'lib/audit/runner.js', from: '      stopIfCancelled(); // cap check: before the blob\n', to: '' },
    ] },
  { id: 'S4', name: 'the cap aborts the audit', mustFail: 'the cap stops the audit',
    edits: [{ file: 'lib/audit/runner.js', from: '      if (err instanceof RunTimeout) ac.abort();\n', to: '' }] },
  { id: 'T1', name: 'a lost run is started again on a repeat ask', mustFail: 'a run lost to a restart is started again',
    edits: [{ file: 'routes/audit.js', from: "      if (revived === 'restart') startRun(row.run_id, base);\n", to: '' }] },
  { id: 'T2', name: 'a run out of starts fails instead of looping', mustFail: 'a run lost to a restart is started again',
    edits: [{ file: 'routes/audit.js', from: "      if (revived === 'failed') return [200, { status: 'failed', error: PLAIN.noReport }];\n", to: '' }] },
  { id: 'T3', name: 'the sweep restarts lost runs', mustFail: 'the sweep restarts lost runs',
    edits: [{ file: 'lib/audit/runner.js', from: "if (revived === 'restart') { start(id, { base }); out.push([id, 'restart']); }", to: "if (revived === 'restart') { out.push([id, 'restart']); }" }] },
  { id: 'D1', name: 'the daily limit is checked in the insert', mustFail: 'a burst of runs cannot go over the daily limit',
    edits: [{ file: 'routes/audit.js', from: '{ dailyLimit: caller.daily_limit ?? 0 }', to: '{ dailyLimit: null }' }] },
  { id: 'D2', name: 'same-website copies are not counted', mustFail: 'same-website copies do not use up the daily limit',
    edits: [{ file: 'routes/audit.js', from: '          copied_from_run_id: today.copied_from_run_id || today.run_id,\n', to: '' }] },
  { id: 'K1', name: 'the signed callback body names the run', mustFail: 'the callback is signed with the caller secret',
    edits: [{ file: 'lib/audit/runner.js', from: "const body = JSON.stringify({ kind: 'result', run_id: run.external_run_id, ...payload });", to: 'const body = JSON.stringify(payload);' }] },
  { id: 'P1', name: 're-registering cannot move a key to another business', mustFail: 're-registering a key id cannot quietly move it',
    edits: [{ file: 'lib/audit/callers.js', from: '  if (!sameOwner && !moveOwner) {', to: '  if (false) {' }] },
  { id: 'P2', name: 're-registering cannot switch a key back on', mustFail: 're-registering a key id cannot quietly move it',
    edits: [{ file: 'lib/audit/callers.js', from: "  if (existing.status !== 'active' && !reactivate) {", to: '  if (false) {' }] },
  { id: 'A4', name: 'every redirect hop is checked again', mustFail: 'a redirect to a private address is refused at the hop',
    edits: [{ file: 'lib/audit/safeFetch.js', from: '    const target = await checkUrl(current, { lookup, env, httpsOnly });',
      to: "    const target = hop === 0 ? await checkUrl(current, { lookup, env, httpsOnly }) : { url: new URL(current), address: '127.0.0.1', family: 4 };" }] },
  { id: 'A5', name: 'robots disallow-all', mustFail: 'robots disallow-all skips the page checks',
    edits: [{ file: 'lib/audit/crawl.js', from: 'const blocked = disallowsEverything(robots) || !isAllowed(robots, pathWithQuery(start));', to: 'const blocked = false;' }] },
  { id: 'A6', name: 'one audit per website per day', mustFail: 'one audit per website per day',
    edits: [{ file: 'routes/audit.js', from: 'const today = await d.repo.findDoneToday(callerId, key, day);', to: 'const today = null;' }] },
  { id: 'A7a', name: 'file key compare', mustFail: "file links: wrong key 404",
    edits: [{ file: 'lib/audit/links.js', from: 'return a.length === b.length && crypto.timingSafeEqual(a, b);', to: 'return true;' }] },
  { id: 'A7b', name: 'visitor link expiry', mustFail: 'file links: visitor key 410 after 30 days',
    edits: [{ file: 'routes/audit.js', from: 'if (!exp || exp < d.now()) {', to: 'if (false) {' }] },
  { id: 'A8', name: 'no paid SEO import from lib/audit', mustFail: 'no lib/audit file imports the paid SEO or intelligence code',
    edits: [{ file: 'lib/audit/score.js', from: "export const SECTIONS = [", to: "import '../seranking.js';\nexport const SECTIONS = [" }] },
  { id: 'V1', name: 'caller-key vault guard (no placeholder key)', mustFail: 'AuditNotConfigured on App Service without the key',
    edits: [{ file: 'lib/audit/callers.js', from: "if (!raw) throw new AuditNotConfigured('not set');", to: 'if (!raw) return Buffer.alloc(32);' }] },
  { id: 'V2', name: 'WEBSITE_SITE_NAME lock on the dev exception', mustFail: 'on App Service the local exception is refused',
    edits: [{ file: 'lib/audit/safeFetch.js', from: "return env.AUDIT_ALLOW_LOCAL === 'true' && !env.WEBSITE_SITE_NAME;", to: "return env.AUDIT_ALLOW_LOCAL === 'true';" }] },
  { id: 'V3', name: 'daily limit', mustFail: 'daily limit: over it',
    edits: [{ file: 'routes/audit.js', from: "      if (ins.overLimit) return res.json({ status: 'failed', error: WORDS.dailyLimit });\n", to: '' }] },
  { id: 'V4', name: 'pages must be HTML', mustFail: 'non-html is refused for pages',
    edits: [{ file: 'lib/audit/safeFetch.js', from: 'if (htmlOnly && status >= 200', to: 'if (false && htmlOnly && status >= 200' }] },
  { id: 'V5', name: 'body cap', mustFail: 'the body cap stops a huge page',
    edits: [{ file: 'lib/audit/safeFetch.js', from: 'if (size > maxBytes) {', to: 'if (false) {' }] },
  { id: 'V6', name: 'a 4xx from the caller is not retried', mustFail: 'a 4xx from the caller is final',
    edits: [{ file: 'lib/audit/runner.js', from: 'if (res.status >= 400 && res.status < 500) {', to: 'if (false) {' }] },
  { id: 'V7', name: 'the callback is https only', mustFail: 'the callback is signed with the caller secret',
    edits: [{ file: 'lib/audit/runner.js', from: '          httpsOnly: true,', to: '          httpsOnly: false,' }] },
  { id: 'V8', name: 'the request must carry a public https callback', mustFail: 'non-https callback is a 400',
    edits: [{ file: 'routes/audit.js', from: '        await checkUrl(msg.callback_url, { httpsOnly: true, lookup: d.lookup, env: d.env });', to: '        void 0;' }] },
  { id: 'V9', name: 'idempotency by external run id (lookup + race guard)', mustFail: 'the same run asked twice is one run',
    edits: [
      { file: 'routes/audit.js', from: 'const existing = await d.repo.findByExternal(callerId, runId);', to: 'const existing = null;' },
      { file: 'routes/audit.js', from: 'if (!ins.inserted) {', to: 'if (false) {' },
    ] },
  { id: 'V10', name: 'report text is escaped', mustFail: 'a visitor business name with markup is escaped',
    edits: [{ file: 'lib/audit/report.js', from: "  return String(s ?? '').replace(/[&<>\"']/g,", to: "  return String(s ?? ''); void String(s ?? '').replace(/[&<>\"']/g," }] },
  { id: 'V11', name: 'odd colours are replaced', mustFail: 'report HTML carries business.name and the colours',
    edits: [{ file: 'lib/audit/report.js', from: "if (typeof v === 'string' && HEX_RE.test(v.trim())) out[k] = v.trim();", to: "if (typeof v === 'string') out[k] = v.trim();" }] },
  { id: 'V12', name: 'no business name in this build (literal inserted)', mustFail: 'no-hardcoded-business',
    edits: [{ file: 'routes/audit.js', from: "export const TOOL_NAME = 'Website check';", to: "export const TOOL_NAME = 'Website check';\nconst AGENCY = 'Intelligent Analytics';" }] },
  { id: 'V13', name: 'no SMS path (an SMS sender added to the runner)', mustFail: 'the visitor is never texted',
    edits: [{ file: 'lib/audit/runner.js', from: 'export const RUN_CAP_MS = 5 * 60 * 1000;', to: 'export const RUN_CAP_MS = 5 * 60 * 1000;\nconst smsSender = null;' }] },
  { id: 'V14', name: 'a refused address is not knocked on twice', mustFail: 'is not retried',
    edits: [{ file: 'lib/audit/runner.js', from: "retryIf: (err) => !signal?.aborted && !(err instanceof SafeFetchRefused && ['bad_url', 'not_public', 'not_https'].includes(err.code)),", to: 'retryIf: () => true,' }] },
  { id: 'V15', name: 'only the visitor website and business name are kept', mustFail: 'a run is accepted, queued once and started',
    edits: [{ file: 'routes/audit.js', from: "          website: site,\n        }),", to: "          website: site,\n          email: msg.visitor?.email,\n        })," }] },
  { id: 'V16', name: "owner reads are scoped to the caller's owner business", mustFail: "only the caller's owner business sees its runs",
    edits: [{ file: 'routes/arion/siteAudits.js', from: 'const row = await repo.getForOwner(tenantId, req.params.runId);\n      if (!row) return', to: 'const row = await repo.getRun?.(req.params.runId) ?? await repo.getForOwner(tenantId, req.params.runId);\n      if (!row) return' }] },
  // 8 Oct 2026 fixes: one-walk tag reader, page/tag/path caps, true failure sentences.
  { id: "H5", name: "the tag walk never goes back (reverted: every opener reads on to the same far \">\")", mustFail: "512 KB of \"<meta \" with one",
    edits: [
      { file: "lib/audit/checks.js", from: "    pos = end;\n", to: "    pos = lt + 1;\n" },
      { file: "lib/audit/checks.js", from: "      if (c === LT) { end = k; break; } // never finished: it ends where the next tag starts\n", to: "" },
      { file: "lib/audit/checks.js", from: "    const limit = Math.min(n, lt + MAX_TAG);\n", to: "    const limit = n;\n" },
    ] },
  { id: "H5b", name: "an unfinished tag ends at the next \"<\"", mustFail: "the tag reader keeps what a browser keeps",
    edits: [
      { file: "lib/audit/checks.js", from: "      if (c === LT) { end = k; break; } // never finished: it ends where the next tag starts\n", to: "" },
    ] },
  { id: "H6", name: "a tag is cut at 4 KB", mustFail: "a tag whose quote never closes stops at 4 KB",
    edits: [
      { file: "lib/audit/checks.js", from: "    const limit = Math.min(n, lt + MAX_TAG);\n", to: "    const limit = n;\n" },
    ] },
  { id: "H7", name: "at most 20,000 tags per page", mustFail: "tags of one page are read",
    edits: [
      { file: "lib/audit/checks.js", from: "  while (out.length < MAX_TAGS) {\n", to: "  for (;;) {\n" },
    ] },
  { id: "H8", name: "forms read in one pass (reverted: each unclosed form re-reads the rest of the page)", mustFail: "512 KB of \"<form>\"",
    edits: [
      { file: "lib/audit/checks.js", from: "function contactForms(html) {\n  const lower = asciiLower(html);\n  const nextClose = finder(lower, '</form');\n  let formEnd = -1; // where the open contact-capable form stops; -1 = none open\n  for (const t of scanTags(html, lower)) {\n    if (t.name === 'form') {\n      const search = String(attrsOf(t.tag).role || '').toLowerCase() === 'search';\n      const close = nextClose(t.end);\n      formEnd = search ? -1 : (close < 0 ? lower.length : close);\n      continue;\n    }\n    if (formEnd < 0 || t.start >= formEnd) { formEnd = -1; continue; }\n    if (t.name === 'textarea') return true;\n    if (t.name === 'input' && /^(?:email|tel)$/i.test(String(attrsOf(t.tag).type || '').trim())) return true;\n  }\n  return false;\n}\n", to: "function contactForms(html) {\n  const lower = asciiLower(html);\n  const nextClose = finder(lower, '</form');\n  return named(scanTags(html, lower), 'form').some((t) => {\n    if (String(attrsOf(t.tag).role || '').toLowerCase() === 'search') return false;\n    const close = nextClose(t.end);\n    const inner = html.slice(t.end, close < 0 ? html.length : close);\n    const tags = scanTags(inner, asciiLower(inner));\n    if (named(tags, 'textarea').length) return true;\n    return named(tags, 'input').map((x) => attrsOf(x.tag)).some((at) => /^(?:email|tel)$/i.test(String(at.type || '').trim()));\n  });\n}\n" },
    ] },
  { id: "H9", name: "only the first 512 KB of a page is read", mustFail: "only the first 512 KB of a page is read",
    edits: [
      { file: "lib/audit/checks.js", from: "const capped = (html) => String(html || '').slice(0, MAX_HTML);", to: "const capped = (html) => String(html || '');" },
    ] },
  { id: "H10", name: "attrsOf reads at most 4 KB of one tag", mustFail: "attrsOf reads at most 4 KB of one tag",
    edits: [
      { file: "lib/audit/checks.js", from: "  let s = String(tag || '').slice(0, MAX_TAG);", to: "  let s = String(tag || '');" },
    ] },
  { id: "R3", name: "robots path-length cap", mustFail: "a path longer than any page address is cut before it is matched",
    edits: [
      { file: "lib/audit/robots.js", from: "  const p = String(pathWithQuery || '/').slice(0, MAX_PATH_LENGTH);", to: "  const p = String(pathWithQuery || '/');" },
    ] },
  { id: "E1", name: "a home page that answered with an error has its own sentence", mustFail: "a website that answered is never told",
    edits: [
      { file: "lib/audit/runner.js", from: "  if (err?.code === 'home_status') return PLAIN.homeError; // the site answered 404, 500 …\n", to: "" },
    ] },
  { id: "E2", name: "a page that is not a web page has its own sentence", mustFail: "a website that answered is never told",
    edits: [
      { file: "lib/audit/runner.js", from: "    if (err.code === 'not_html') return PLAIN.notHtml;\n", to: "" },
    ] },
  { id: "E3", name: "a page that is too big has its own sentence", mustFail: "a website that answered is never told",
    edits: [
      { file: "lib/audit/runner.js", from: "    if (err.code === 'too_big') return PLAIN.tooBig;\n", to: "" },
    ] },
  { id: "E4", name: "a redirect loop has its own sentence", mustFail: "a website that answered is never told",
    edits: [
      { file: "lib/audit/runner.js", from: "    if (err.code === 'too_many_redirects') return PLAIN.redirectLoop;\n", to: "" },
    ] },
  { id: "E5", name: "the daily-limit words say tomorrow (reverted to midnight UTC)", mustFail: "the daily-limit words say",
    edits: [
      { file: "routes/audit.js", from: "checks start again tomorrow.", to: "checks start again after midnight UTC." },
    ] },
  // 8 Oct 2026 — the PDF is painted by pdfkit, not a browser (production has none).
  { id: "F1", name: "the paper says \"Prepared by\" the agency", mustFail: "a real PDF from pdfkit",
    edits: [
      { file: "lib/audit/report.js", from: ".text('Prepared by ', x, pdf.y, { width: W, continued: true });", to: ".text('', x, pdf.y, { width: W, continued: true });" },
    ] },
  { id: "F2", name: "the findings reach the paper", mustFail: "a real PDF from pdfkit",
    edits: [
      { file: "lib/audit/report.js", from: "      pdf.text(f, x + 18, y, { width: W - 18 });\n", to: "" },
    ] },
  { id: "F3", name: "the report module does not import playwright", mustFail: "it does not import playwright",
    edits: [
      { file: "lib/audit/report.js", from: "import PDFDocument from 'pdfkit';\n", to: "import PDFDocument from 'pdfkit';\nimport { chromium } from 'playwright';\n" },
    ] },
];

console.log(`\n=== site audit mutations (${M.length}) — ${REPO} ===\n`);
for (const m of M.filter((x) => (process.env.ONLY || '').split(',').includes(x.id) || !process.env.ONLY)) mutate(m);
console.log(`\n${caught} went red, ${missed} missed or skipped.`);
process.exit(missed ? 1 : 0);
