// test/reserved-slugs.test.mjs — D-38 in arion-api.
//
// Under the path model the first path segment on customer.ia-dm.com /
// crew.ia-dm.com / book.ia-dm.com names the BUSINESS. Some segments are not
// businesses — the public, token-authenticated pages and the static asset
// directories — and a business minted with one of those as its slug is
// unreachable: its customers land on somebody else's token route.
//
// oliver-api creates tenants, and so does arion-api, from TWO paths
// (lib/coreTenants.js and routes/admin/onboardExisting.js, each with its own
// copy of generateUniqueSlug). Fixing oliver alone would have left the defect
// open in the repo nobody was looking at.
//
// MUTATION-TESTED 2026-09-04 (each break made, the named test failed, reverted):
//   * empty the `segments` array in reserved-slugs.json
//       -> "every reserved segment is repaired away" fails
//   * drop the shape check from repairDerivedSlug
//       -> "a dotted file at the origin root can never be a slug" fails.
//          I predicted the fuzz row would be the one to go; it was not, because
//          the fuzz alphabet happens not to produce a leading dot. Recorded as
//          predicted-wrong rather than quietly re-labelled — the guard held,
//          but not for the reason I assumed.
//   * change one byte of reserved-slugs.json
//       -> "the reserved-slug list has not drifted" fails
//   * remove the repairDerivedSlug call from lib/coreTenants.js
//       -> "both slug minters go through the one module" fails

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { RESERVED_SEGMENTS, SLUG_RE, isReservedSlug, validateSlug, repairDerivedSlug } from "../lib/reservedSlugs.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel) =>
  read(rel)
    .replace(/\r\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));

/** The one source. The SAME bytes are in oliver-api and the three app repos. */
const RESERVED_SLUGS_SHA256 = "db2a4c977c6256edad578c11df59dd98560b81cc898d594ec6015f03d7f4b30f";

test("the reserved-slug list has not drifted from the other four repos", () => {
  // LF-normalised before hashing: git may rewrite endings on checkout, and the
  // bytes that matter are the JSON's, not the worktree's. All five suites
  // normalise the same way, so all five agree.
  const normalised = Buffer.from(read("lib/reserved-slugs.json").replace(/\r\n/g, "\n"), "utf8");
  assert.equal(
    crypto.createHash("sha256").update(normalised).digest("hex"),
    RESERVED_SLUGS_SHA256,
    "lib/reserved-slugs.json is a declared byte-identical copy shared with oliver-api, " +
      "oliver-customer-portal, oliver-employee-portal and oliver-ops. Change it in ALL FIVE and update " +
      "RESERVED_SLUGS_SHA256 in each suite, or change it in none.",
  );
});

test("every reserved segment is repaired away, never returned", () => {
  assert.ok(RESERVED_SEGMENTS.length > 0, "an empty list repairs nothing");
  for (const seg of RESERVED_SEGMENTS) {
    assert.equal(isReservedSlug(seg), true, seg);
    const out = repairDerivedSlug(seg, "3f2a");
    assert.equal(isReservedSlug(out), false, `"${seg}" came back as "${out}"`);
    assert.match(out, SLUG_RE);
  }
});

test("a business whose name IS a reserved word can still be onboarded", () => {
  // The whole reason arion repairs rather than refuses: nothing here is typed
  // by a caller, and a business called "P" must be able to finish onboarding.
  for (const name of ["P", "p", "Present", "Confirm", "Cancel", "Unsubscribe", "assets"]) {
    const derived = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const out = repairDerivedSlug(derived, "3f2a");
    assert.equal(validateSlug(out).ok, true, `${name} -> ${out}`);
  }
});

test("a good name is left exactly alone", () => {
  assert.equal(repairDerivedSlug("summit-lawn", "3f2a"), "summit-lawn");
  assert.equal(repairDerivedSlug("acme2", "3f2a"), "acme2");
});

test("whatever goes in, what comes out is routable", () => {
  // Fuzzed rather than enumerated: repairDerivedSlug has several branches and
  // the property is the same for all of them.
  const alphabet = "abz09-_ .ü/AZ";
  for (let i = 0; i < 500; i += 1) {
    let s = "";
    const n = i % 70;
    for (let j = 0; j < n; j += 1) s += alphabet[(i * 7 + j * 13) % alphabet.length];
    const out = repairDerivedSlug(s, "3f2a");
    assert.equal(SLUG_RE.test(out), true, `${JSON.stringify(s)} -> ${JSON.stringify(out)}`);
    assert.equal(isReservedSlug(out), false, `${JSON.stringify(s)} -> ${JSON.stringify(out)}`);
  }
});

test("a dotted file at the origin root can never be a slug — the shape rule does that", () => {
  for (const f of ["sw.js", "manifest.webmanifest", "favicon.ico", "robots.txt"]) {
    assert.equal(validateSlug(f).ok, false, f);
    assert.equal(RESERVED_SEGMENTS.includes(f), false, `${f} does not need listing`);
  }
});

test("both slug minters go through the one module", () => {
  // arion has TWO copies of generateUniqueSlug and coreTenants.js says so in a
  // comment ("Mirrors generateUniqueSlug in routes/admin/onboardExisting.js").
  // A guard, not a description: a copy that skips the repair re-opens D-38 in
  // half the onboarding paths, which is the hardest kind of hole to notice.
  for (const rel of ["lib/coreTenants.js", "routes/admin/onboardExisting.js"]) {
    const src = code(rel);
    assert.match(src, /repairDerivedSlug\(/, `${rel} mints a slug without the reserved-list repair`);
    assert.match(src, /from ['"][^'"]*reservedSlugs\.js['"]/, `${rel} must import it`);
  }
});

test("no third slug minter has appeared in the runtime code", () => {
  // The two scripts under scripts/ also carry a copy. They are one-shot repair
  // tools that write existing slugs, not onboarding paths, so they are out of
  // scope here — but a NEW one in lib/ or routes/ would not be.
  const src = [code("lib/coreTenants.js"), code("routes/admin/onboardExisting.js")].join("\n");
  const minters = (src.match(/async function generateUniqueSlug/g) || []).length;
  assert.equal(minters, 2, "a third runtime slug minter appeared — it needs the repair too");
});
