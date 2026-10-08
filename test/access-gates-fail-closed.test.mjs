// ARION's access gate fails to READ-ONLY, never to admin (2026-10-08).
//
// The twin of oliver-api test/access-gates-fail-closed.test.mjs, which covers
// requireOliverAccess and requireStellaAccess. The rule is one rule across the
// three gates and FORGE's, so a drift in either copy goes red in its own repo.
//
// THE DEFECT. requireOliverAccess, requireStellaAccess and (in arion-api)
// requireArionAccess resolved the platform tenant role inside a try/catch whose
// catch read:
//
//     tenantRole = "admin";
//     productDenied = false;
//
// So when the role read FAILED - a transient database error, a pool that could
// not be had - the gate granted admin, and whoever was asking could write. The
// same shape was a security defect in FORGE and was changed on 2026-09-30
// (forge-api middleware/requireForgeAccess.js falls back to read_only).
//
// THE RULE, and the distinction that matters:
//   no role ROW      -> admin. Deliberate: every existing user has no row and
//                       must keep working. The question was asked and answered
//                       "nothing recorded".
//   the read FAILED  -> read_only + roleUnknown. Reads still work, because a
//                       hiccup must never lock a paying business out of looking
//                       at its own data. A WRITE waits until we can check, and
//                       is refused 503 with a transient sentence - never 403
//                       "your account has read-only access", which would blame
//                       the owner for our outage.
//
// Pinned by source rule because these gates take their pool from a static
// import; there is no seam to inject a failing pool into without rewriting a
// security-critical file. Each assertion below goes red if the catch is put
// back the way it was.
//
// MUTATION-TESTED (each broken on purpose, the catching assertion named):
//   · catch sets tenantRole = "admin" again
//        caught by "no gate grants admin when the read failed"
//   · catch drops roleUnknown
//        caught by "a failed read is a transient refusal, not the owner's role"
//   · the 503 branch removed
//        caught by "a failed read is a transient refusal, not the owner's role"
//   · the no-row default changed to read_only
//        caught by "a user with no role row is still admin"
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATES = [
  ["requireArionAccess", "middleware/requireArionAccess.js"],
];
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** The body of the try/catch that resolves the role, for one gate. */
function roleCatch(text, fn) {
  const at = text.indexOf(`[${fn}] role/product read failed`);
  assert.ok(at > 0, `${fn} still logs when the role read fails`);
  const open = text.lastIndexOf("} catch (e) {", at);
  const close = text.indexOf("}", text.indexOf("roleUnknown", at) >= 0 ? text.indexOf("roleUnknown", at) : at);
  return text.slice(open, close + 1);
}

test("no gate grants admin when the role read failed", () => {
  for (const [fn, rel] of GATES) {
    const body = roleCatch(src(rel), fn);
    assert.match(body, /tenantRole = "read_only";/, `${fn} falls back to read_only`);
    assert.ok(!/tenantRole = "admin";/.test(body), `${fn} must not grant admin from a failed read`);
    // The per-user product gate still opens: being unable to read it is not
    // evidence that someone was denied.
    assert.match(body, /productDenied = false;/, `${fn} does not invent a denial`);
  }
});

test("a failed read is a transient refusal, not the owner's role", () => {
  for (const [fn, rel] of GATES) {
    const text = src(rel);
    assert.match(roleCatch(text, fn), /roleUnknown = true;/, `${fn} records that it could not tell`);
    const at = text.indexOf('tenantRole === "read_only" && isMutation');
    assert.ok(at > 0, `${fn} still blocks mutations for a read-only role`);
    const branch = text.slice(at, at + 700);
    assert.match(branch, /if \(roleUnknown\) \{/, `${fn} separates "could not tell" from "read-only"`);
    assert.match(branch, /status\(503\)/, `${fn} answers 503, not 403, when it could not tell`);
    assert.match(branch, /access_check_unavailable/);
    assert.match(branch, /We couldn't check your access just now, so nothing was changed\./);
    // And the owner's real read-only role still says what it meant.
    assert.match(branch, /Your account has read-only access to this business\./);
  }
});

test("a user with no role row is still admin: existing users keep working", () => {
  for (const [fn, rel] of GATES) {
    const text = src(rel);
    const at = text.indexOf('let tenantRole = "admin";');
    assert.ok(at > 0, `${fn} still defaults to admin when nothing is recorded`);
    // The default is set BEFORE the read, and only a recorded 'user' or
    // 'read_only' row lowers it.
    assert.ok(at < text.indexOf(`[${fn}] role/product read failed`), "the default comes first");
    assert.match(text, /if \(rr\.role === "user" \|\| rr\.role === "read_only"\) tenantRole = rr\.role;/);
  }
});

test("the founder acting on a client is never caught by either refusal", () => {
  for (const [, rel] of GATES) {
    const text = src(rel);
    const at = text.indexOf('tenantRole === "read_only" && isMutation');
    assert.match(text.slice(at, at + 120), /!isFounderActingOnClient/);
  }
});

test("no gate returns the exception text to the screen", () => {
  for (const [, rel] of GATES) {
    const text = src(rel);
    const lines = text.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l));
    const leaks = lines.filter((l) => /res\.status\(/.test(l) || /details:/.test(l)).filter((l) => /err\.message|e\.message/.test(l));
    assert.deepEqual(leaks, [], `${rel} returns a sentence, never the exception`);
  }
});
