/**
 * PUT /arion/agents/settings answered 200 and changed nothing on a body it did
 * not recognise (pre-walk pass 3, 2026-09-09).
 *
 * `routes/arion/agents.js` was `if (body.content && typeof body.content ===
 * 'object') { … }` with NO else, and then re-read and returned the settings. So
 * `{ key: 'content', enabled: false }` — the shape the OLIVER and SPARK agent
 * pages send — got a cheerful 200, an unchanged payload and no clue. Nothing was
 * broken on a screen, because the ARION page happens to send the right shape;
 * what it cost was a wrong reading of walk rows AP16, AP17 and AP21 until the
 * route was read.
 *
 * That is the platform's recurring catch -> swallow -> report success shape with
 * a different coat on: the caller is TOLD it worked. This suite pins the refusal
 * AND pins the two field lists to the writer, so a field can never be accepted
 * and unnamed, or named and unaccepted.
 *
 * The route needs a database and a tenant, so the validator is exercised
 * directly through the module's source rather than over HTTP: what is under test
 * is the DECISION, and the decision is a pure function of the body.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTE = path.join(HERE, '..', 'routes', 'arion', 'agents.js');
// CRLF-tolerant: this repo is checked out on Windows and the offsets below are
// found by text, not by byte.
const src = fs.readFileSync(ROUTE, 'utf8').replace(/\r\n/g, '\n');

/**
 * The validator, lifted out of the route module by source so this suite does not
 * need express, mssql or a tenant. The extraction is asserted first: if the
 * function is renamed or removed, this fails loudly rather than testing nothing.
 */
function loadValidator() {
  const start = src.indexOf('const SETTINGS_SECTIONS');
  const end = src.indexOf('\n}\n', src.indexOf('function whyBodyIsUnusable'));
  assert.ok(start > 0, 'SETTINGS_SECTIONS must still be declared in routes/arion/agents.js');
  assert.ok(end > start, 'whyBodyIsUnusable must still be declared in routes/arion/agents.js');
  const body = src.slice(start, end + 2);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn { whyBodyIsUnusable, SETTINGS_SECTIONS, CONTENT_FIELDS, MOVED_FIELDS, MOVED_WORDS };`)();
}

const { whyBodyIsUnusable, SETTINGS_SECTIONS, CONTENT_FIELDS, MOVED_FIELDS, MOVED_WORDS } = loadValidator();

test('the shape the Portal actually sends is accepted', () => {
  assert.equal(whyBodyIsUnusable({ content: { price_usd_monthly: 199 } }), null);
  assert.equal(whyBodyIsUnusable({ content: { paused: false } }), null);
  assert.equal(whyBodyIsUnusable({
    content: { price_usd_monthly: 49.5, keyword_provider: 'auto', paused: false },
  }), null);
});

// ARGUS employees phase 1 (§G.9): the switch, the posts per week and the kinds
// of post are the web person's jobs now. Sending them here is refused with the
// sentence that says where they live, never accepted and quietly ignored.
test('the moved fields are refused with where they live now', () => {
  assert.deepEqual([...MOVED_FIELDS], ['enabled', 'posts_per_week', 'content_types']);
  for (const f of MOVED_FIELDS) {
    assert.equal(whyBodyIsUnusable({ content: { [f]: f === 'content_types' ? 'blog_post' : 1 } }), MOVED_WORDS, f);
  }
  assert.equal(MOVED_WORDS, "That's set on the job now: ARGUS → Your team → The web person → Jobs.");
  for (const f of MOVED_FIELDS) assert.ok(!CONTENT_FIELDS.includes(f), `${f} must not be accepted any more`);
});

test('THE ONE FROM THE WALK — a body that names no known section is refused, not answered 200', () => {
  const why = whyBodyIsUnusable({ key: 'content', enabled: false });
  assert.ok(why, 'an unrecognised body must be refused');
  assert.match(why, /"key"/, 'the refusal names the field it did not know');
  assert.match(why, /"enabled"/);
  assert.match(why, /"content"/, 'and names the section it does understand');
});

test('the refusal names every field the endpoint accepts, so the caller can fix it in one go', () => {
  const why = whyBodyIsUnusable({});
  assert.ok(why);
  for (const f of CONTENT_FIELDS) {
    assert.ok(why.includes(f), `the refusal must name "${f}"`);
  }
});

test('an empty section, a null section and an array section are all refused', () => {
  assert.ok(whyBodyIsUnusable({ content: {} }), 'nothing to change is not a save');
  assert.ok(whyBodyIsUnusable({ content: null }));
  assert.ok(whyBodyIsUnusable({ content: [] }));
  assert.ok(whyBodyIsUnusable({ content: 'enabled' }));
});

test('a misspelt field INSIDE the section is refused too — the same silent no-op one level down', () => {
  const why = whyBodyIsUnusable({ content: { keyword_provder: 'auto' } });
  assert.ok(why, '{ content: { keyword_provder } } used to save nothing and answer 200');
  assert.match(why, /keyword_provder/);
  assert.match(why, /keyword_provider/, 'and the refusal spells the real one out');
});

test('an extra key ALONGSIDE a good section is refused rather than silently dropped', () => {
  assert.ok(whyBodyIsUnusable({ content: { paused: false }, enabled: false }));
});

test('the two lists are the writer\'s lists, not a second copy', () => {
  assert.deepEqual([...SETTINGS_SECTIONS], ['content']);
  // Every accepted field must be read by the MERGE block; every field the MERGE
  // block reads off `p` must be on the list. This is what stops the refusal
  // sentence and the writer drifting apart.
  const writer = src.slice(src.indexOf("if (body.content && typeof body.content === 'object')"),
    src.indexOf('res.json({ data: await readSettings(pool, tenantId) });', src.indexOf('export const settingsWriteHandler')));
  assert.ok(writer.length > 200, 'the settings writer block must still be findable');
  for (const f of CONTENT_FIELDS) {
    assert.ok(writer.includes(`p.${f}`), `"${f}" is advertised but never read by the writer`);
  }
  const readByWriter = [...writer.matchAll(/\bp\.([a-z_]+)\b/g)].map((m) => m[1]);
  for (const f of new Set(readByWriter)) {
    assert.ok(CONTENT_FIELDS.includes(f), `the writer reads "${f}" but the refusal never names it`);
  }
});

test('the route wires the validator in BEFORE it touches the database', () => {
  const put = src.slice(src.indexOf('export const settingsWriteHandler'));
  const guard = put.indexOf('whyBodyIsUnusable(body)');
  const pool = put.indexOf('await getPool()');
  assert.ok(guard > 0, 'the PUT must call the validator');
  assert.ok(pool > 0);
  assert.ok(guard < pool, 'a body we cannot act on must be refused before a connection is taken');
});
