/**
 * "The margin sentence comes back with mojibake in it" (pre-walk pass 3).
 *
 * WHAT WAS REPORTED
 *   arion/agents/settings returns
 *   "…but no price is configured for this tenant â€"…"
 *   — a UTF-8 em dash re-encoded once too often somewhere between the message
 *   constant and the JSON.
 *
 * WHAT IT ACTUALLY IS, MEASURED 2026-09-09 ON THE MERGED LINE
 *   Nothing in this repo re-encodes anything. The constant in
 *   lib/contentAgent/marginMonitor.js holds one em dash as the three correct
 *   UTF-8 bytes E2 80 94; git's blob holds the same three; the served response
 *   carries the same three (Content-Type: application/json; charset=utf-8) and
 *   contains no C3 A2 anywhere; Node's fetch and PowerShell's Invoke-RestMethod
 *   both decode it back to U+2014.
 *
 *   `â€` is UTF-8 read as Windows-1252 — the signature of a READER, not a
 *   writer. It was introduced when the response was captured into the register,
 *   not when it was produced. (The same trap the platform's own note records:
 *   Set-Content and Add-Content default to the system ANSI code page.)
 *
 * SO WHAT THIS SUITE IS FOR
 *   The report was a real class of fault looking for its file, and the fix at
 *   the source is a guard where such a fault WOULD live rather than a replace
 *   over the output. Two halves:
 *
 *     1. the sentence survives the round trip it actually makes — the message
 *        constant -> JSON.stringify -> UTF-8 bytes -> parse;
 *     2. NO tracked source file in this repo carries a Windows-1252
 *        double-encoding. A file saved once in the wrong encoding is how this
 *        would become true, and it is invisible in a diff on a console that
 *        renders it back.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkMargin } from '../lib/contentAgent/marginMonitor.js';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The exact bytes an em dash must be on the wire. */
const EM_DASH_UTF8 = Buffer.from([0xE2, 0x80, 0x94]);

/**
 * Windows-1252 renderings of the leading byte of a UTF-8 multi-byte sequence.
 * `Ã` (C3 83) and `â` (C3 A2) as the FIRST byte of a two-byte pair are what a
 * double-encode looks like once it is stored back as UTF-8.
 */
// The names are built from escapes rather than typed, so THIS FILE does not
// contain the byte sequences it is hunting for. (It did, and it failed its own
// sweep the moment it was committed — which is the guard working.)
const MOJIBAKE = [
  { name: `${String.fromCharCode(0xE2, 0x20AC)} (UTF-8 E2 80 xx read as cp1252)`, bytes: Buffer.from([0xC3, 0xA2, 0xE2, 0x82, 0xAC]) },
  { name: `${String.fromCharCode(0xC3)} (UTF-8 C3 xx read as cp1252)`, bytes: Buffer.from([0xC3, 0x83, 0xC2]) },
  { name: `${String.fromCharCode(0xC2)} (a stray cp1252 nbsp lead)`, bytes: Buffer.from([0xC3, 0x82, 0xC2, 0xA0]) },
];

test('the margin sentence the walk quoted survives the round trip it actually makes', async () => {
  // A pool stand-in, because the sentence is what is under test, not the query.
  const pool = {
    request() {
      return {
        input() { return this; },
        async query() { return { recordset: [{ cost_usd: 0.0741, price_usd_monthly: null }] }; },
      };
    },
  };
  const m = await checkMargin(pool, '00000000-0000-0000-0000-000000000000');
  assert.equal(m.verdict, 'price_not_set');
  assert.match(m.message, /no price is configured for this tenant/);

  // ONE em dash, and it is the real one.
  assert.ok(m.message.includes('—'), 'the sentence must carry U+2014, not a look-alike');
  assert.ok(!/â€/.test(m.message), 'the sentence must not already be double-encoded');

  // The trip a response makes: stringify, write as UTF-8, read back.
  const wire = Buffer.from(JSON.stringify({ data: { margin: m } }), 'utf8');
  assert.ok(wire.includes(EM_DASH_UTF8), 'the serialised body must carry E2 80 94');
  for (const { name, bytes } of MOJIBAKE) {
    assert.ok(!wire.includes(bytes), `the serialised body must not contain ${name}`);
  }
  assert.equal(JSON.parse(wire.toString('utf8')).data.margin.message, m.message);
});

test('no tracked source file in this repo carries a Windows-1252 double-encoding', () => {
  // git, not a directory walk: node_modules, build output and anything ignored
  // are somebody else's bytes and not ours to police.
  const listed = execFileSync('git', ['-C', REPO, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8').split('\0').filter(Boolean);
  const interesting = listed.filter((f) => /\.(js|mjs|cjs|ts|tsx|json|sql|md|html)$/i.test(f));
  assert.ok(interesting.length > 200, `expected a real file list, got ${interesting.length}`);

  // This file is the ONE exception, and it is exempt because it is the file that
  // documents the fault: the header quotes the sequence the walk reported, and
  // two assertions below match on it. Exempting it by path rather than by
  // pattern keeps the exemption to exactly one file — a "skip anything under
  // test/" rule would hide the next real one.
  const SELF = 'test/walk-fixtures-message-encoding.test.mjs';
  assert.ok(interesting.includes(SELF), 'the exemption names a file that is not tracked — rename it or fix the path');

  const bad = [];
  for (const rel of interesting) {
    if (rel === SELF) continue;
    const abs = path.join(REPO, rel);
    let buf;
    try { buf = fs.readFileSync(abs); } catch { continue; }   // a deleted-but-tracked path
    for (const { name, bytes } of MOJIBAKE) {
      if (buf.includes(bytes)) { bad.push(`${rel}: ${name}`); break; }
    }
  }
  assert.deepEqual(bad, [], `these files were saved through a cp1252 decode:\n${bad.join('\n')}`);
});

test('the sentence has exactly one em dash, so a future edit cannot smuggle a second encoding in', () => {
  const src = fs.readFileSync(path.join(REPO, 'lib', 'contentAgent', 'marginMonitor.js'));
  const line = src.toString('utf8').split(/\r?\n/).find((l) => l.includes('no price is configured'));
  assert.ok(line, 'the sentence must still be in marginMonitor.js');
  assert.equal((line.match(/—/g) || []).length, 1);
  assert.ok(!/[Ãâ]€/.test(line));
});
