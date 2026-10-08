// SCOPE_ACCESS_FOLLOWS_SUBSCRIPTION_2026-10-07 F9 — when a business's ARION
// subscription has ended, middleware/requireArionAccess.js refuses every
// /arion and /intelligence request. The refusal is shown to a business owner,
// so it is a plain sentence and never says "tenant".
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../middleware/requireArionAccess.js", import.meta.url), "utf8");

test("the not-owned refusal is the plain sentence", () => {
  assert.match(src, /return res\.status\(403\)\.json\(\{ error: "ARION isn't part of this business's plan\." \}\);/);
});

test("no 403 body in the gate says 'tenant'", () => {
  const bodies = [...src.matchAll(/res\.status\(403\)\.json\(([^;]*)\);/g)].map((m) => m[1]);
  assert.ok(bodies.length > 0, "the gate's refusals were found (a scan that finds nothing proves nothing)");
  for (const b of bodies) assert.doesNotMatch(b, /\btenant\b/i, b);
});
