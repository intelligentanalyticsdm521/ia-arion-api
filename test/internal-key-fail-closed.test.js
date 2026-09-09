// D-49 (2026-09-08): the internal ingest-key gate must fail CLOSED when the key is unset.
// Source-shape test on purpose: the guard is module-private and the property is about the file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'internal.js'), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
const guard = src.slice(src.indexOf('function requireIngestKey'), src.indexOf("router.get('/status'"));
test('an unset ARION_INGEST_KEY refuses every /internal route instead of skipping the check', () => {
  assert.ok(!/if \(!key\) return next\(\)/.test(guard), 'the old fail-open skip is back');
  assert.match(guard, /if \(!key\) \{[\s\S]*status\(503\)[\s\S]*internal_key_not_configured/, 'unset key must answer 503 internal_key_not_configured');
  assert.match(guard, /ARION_INGEST_KEY is not set/, 'the refusal names the missing setting');
});
test('a wrong key is still 401', () => { assert.match(guard, /provided !== key[\s\S]*status\(401\)/); });
