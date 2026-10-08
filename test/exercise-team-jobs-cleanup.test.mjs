// test/exercise-team-jobs-cleanup.test.mjs — scripts/dev/exercise-team-jobs.mjs
// says "removed what this exercise wrote", so it must remove the social post
// draft the Automatic social scenario's real LUMEN hand-off writes
// (core.tenant_social_post and its targets), found by the id on the output
// row (scheduled_social_post_id), before the output rows that hold that id
// are deleted (fixer pass, 2026-10-08). Goes red when the removal is taken out.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../scripts/dev/exercise-team-jobs.mjs', import.meta.url), 'utf8');
const cleanup = SRC.slice(SRC.indexOf('/* ── tidy up what this run wrote'));

test('the cleanup removes the hand-off\'s social post draft, found by the output row\'s id', () => {
  assert.ok(cleanup.length > 0, 'the cleanup section is missing');
  assert.match(cleanup, /scheduled_social_post_id/, 'the social post id is not read from the output rows');
  const target = cleanup.indexOf('DELETE FROM core.tenant_social_post_target');
  const post = cleanup.indexOf('DELETE FROM core.tenant_social_post WHERE');
  const outputs = cleanup.indexOf('DELETE FROM arion.content_agent_output');
  const readIds = cleanup.indexOf('await contentRows(createdRuns)');
  assert.ok(target > -1 && post > -1, 'the social post draft is left behind');
  assert.ok(target < post, 'targets go before the post (foreign key)');
  assert.ok(readIds > -1 && readIds < outputs, 'the ids are read after the outputs that hold them are gone');
  assert.match(cleanup, /tenant_id = @t AND post_id IN/, 'the post delete is not limited to this business');
});

test('the cleanup sentence names what it removed, social posts included', () => {
  assert.match(cleanup, /social post draft\(s\) the hand-off made/);
});
