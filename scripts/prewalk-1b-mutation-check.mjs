#!/usr/bin/env node
// scripts/prewalk-1b-mutation-check.mjs
//
// Make each pre-walk-1b ARION guard fail on purpose, and prove
// test/prewalk-1b-arion.test.mjs (and site-request.test.mjs) catches it.
//
// A green suite proves nothing about a guard until you have watched it go red
// (feedback_mutation_test_your_guards). Files are edited in place and restored
// in a `finally`. Nothing here touches a database or the network.
//
//   node scripts/prewalk-1b-mutation-check.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** An LF view to match against; the file's own endings go back on the way out.
 *  (These files are checked out CRLF and every multi-line anchor here is
 *  written with a bare newline — the trap that made nine LUMEN guards read as
 *  "anchor moved" while the code had not been touched.) */
function readSource(abs) {
  const raw = fs.readFileSync(abs, "utf8");
  const crlf = raw.includes("\r\n");
  return {
    raw,
    text: crlf ? raw.replace(/\r\n/g, "\n") : raw,
    write: (next) => fs.writeFileSync(abs, crlf ? next.replace(/\n/g, "\r\n") : next, "utf8"),
    restore: () => fs.writeFileSync(abs, raw, "utf8"),
  };
}

const MUTATIONS = [
  {
    id: "name_from_questionnaire",
    what: "read the business name from the onboarding questionnaire again",
    file: "lib/websiteBuilder/brandContext.js",
    from: "  const businessName = identityNamed ? String(identity.display_name || '').trim() : '';",
    to: "  const businessName = answers.businessName || answers.business_name || '';",
    suite: "test/prewalk-1b-arion.test.mjs",
    caughtBy: "the email local-part is never a business name again",
  },
  {
    id: "name_from_mailbox",
    what: "call a business after its mailbox, on its own website",
    file: "lib/websiteBuilder/brandContext.js",
    from: "  let contactEmail = String(identity?.support_email || identity?.email || '').trim();",
    to: "  let businessName2 = contactEmail0.split('@')[0];\n  let contactEmail = String(identity?.support_email || identity?.email || '').trim();",
    suite: "test/prewalk-1b-arion.test.mjs",
    caughtBy: "the email local-part is never a business name again",
  },
  {
    id: "no_name_is_the_neutral_brand",
    what: "print 'Your Service Provider' as a business's own brand",
    file: "lib/websiteBuilder/brandContext.js",
    from: "export const BUSINESS_NAME_NOT_SET = 'Business name not set';",
    to: "export const BUSINESS_NAME_NOT_SET = 'Your Service Provider';",
    suite: "test/prewalk-1b-arion.test.mjs",
    caughtBy: "no recorded name is a SENTENCE, never the neutral brand and never a guess",
  },
  {
    id: "founder_is_told_nowhere",
    what: "log the missing name and tell nobody",
    file: "lib/websiteBuilder/brandContext.js",
    from: "      eventType: 'arion.brand.business_name_missing',",
    to: "      eventType: 'arion.brand.something_else',",
    suite: "test/prewalk-1b-arion.test.mjs",
    caughtBy: "the founder is told, through the event stream, not only a log line",
  },
  {
    id: "library_serves_a_blank",
    what: "serve an empty business name to the editor rather than the sentence",
    file: "routes/arion/pages.js",
    from: "        businessName: brand.business_name_status === 'set'",
    to: "        businessName: true\n          ? String(brand.business_name || '')\n          : brand.business_name_status === 'set'",
    suite: "test/prewalk-1b-arion.test.mjs",
    caughtBy: "the section library serves the sentence, not an empty string or a guess",
  },
  {
    id: "founder_outage_is_500",
    what: "answer 500 when we could not check whether the caller is the founder",
    file: "middleware/requireFounder.js",
    from: '    res.set("Retry-After", "5");\n    return res.status(503).json({',
    to: '    return res.status(500).json({',
    suite: "test/prewalk-1b-arion.test.mjs",
    caughtBy: "a founder check that could not RUN is a retryable 503 with a Retry-After",
  },
  {
    id: "founder_outage_opens_the_queue",
    what: "let an outage through the founder gate",
    file: "middleware/requireFounder.js",
    from: '    res.set("Retry-After", "5");\n    return res.status(503).json({',
    to: '    return next();\n    // eslint-disable-next-line no-unreachable\n    return res.status(503).json({',
    suite: "test/site-request.test.mjs",
    caughtBy: "the role gate lets a founder through and refuses everyone else — 403, and a retryable 503 if it cannot tell",
  },
];

let caught = 0;
const survivors = [];
for (const m of MUTATIONS) {
  const abs = path.join(ROOT, m.file);
  const src = readSource(abs);
  if (!src.text.includes(m.from)) {
    survivors.push({ ...m, why: "the anchor text has moved" });
    console.log(`  ??  ${m.id.padEnd(30)} ANCHOR MOVED in ${m.file}`);
    continue;
  }
  try {
    src.write(src.text.replace(m.from, m.to));
    const r = spawnSync(process.execPath, ["--test", m.suite], { cwd: ROOT, encoding: "utf8", timeout: 300000 });
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((x) => x[1].trim());
    if (failed.includes(m.caughtBy)) { caught += 1; console.log(`  OK  ${m.id.padEnd(30)} caught by "${m.caughtBy}"`); }
    else if (failed.length) { caught += 1; console.log(`  ok  ${m.id.padEnd(30)} caught by: ${failed.join(" | ")}`); }
    else { survivors.push({ ...m, why: "the suite still passed" }); console.log(`  !!  ${m.id.padEnd(30)} SURVIVED — ${m.what}`); }
  } finally {
    src.restore();
  }
}

console.log(`\n${caught}/${MUTATIONS.length} mutations caught.`);
if (survivors.length) {
  console.log("\nSURVIVORS — each of these is a guard that is not actually guarding:");
  for (const s of survivors) console.log(`  · ${s.id}: ${s.what} (${s.why})`);
  process.exit(1);
}
process.exit(0);
