/**
 * D-05 — "Save draft" on a live page must never take it off the internet.
 *
 * BUILDER_USER_TEST_2026-09-16, §9, the honourable mention:
 *
 *   "pressing Save draft on your live home page takes your website off the
 *    internet, with no warning, and tells you only by moving the page into a
 *    list headed 'Nobody can see these until you publish them'."
 *
 * The behaviour it names is one boolean — "is this save about to unpublish a
 * live page" — so it is tested as one boolean, on the pure function the route
 * calls, rather than as a shape you have to reproduce against WordPress.
 *
 * The store's own contract is tested beside it with a fake pool, because the
 * half that matters is the one the walk did not have: a write that did not land
 * is reported as a failure, never as "Saved".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  wouldUnpublish, UNPUBLISH_REFUSAL, saveDraft, getDraft, clearDraft, draftPageIds, MAX_DRAFT_BYTES,
} from '../lib/websiteBuilder/pageDraftStore.js';

/* ── the guard ─────────────────────────────────────────────────────────── */

test('D-05: saving a LIVE page as a draft is refused', () => {
  assert.equal(
    wouldUnpublish({ currentStatus: 'publish', requestedStatus: 'draft', unpublish: undefined }),
    true,
    'the exact call the walk made must be caught',
  );
});

test('D-05: Unpublish still works — an explicit intention is the one way through', () => {
  assert.equal(
    wouldUnpublish({ currentStatus: 'publish', requestedStatus: 'draft', unpublish: true }),
    false,
  );
});

test('D-05: the guard gates on the PRESENCE of the intention, not the absence of a flag', () => {
  // feedback_absence_based_guards_fail_open. Anything that is not exactly
  // `true` is not an intention to unpublish — a client that sends "true", 1, or
  // nothing at all is refused rather than let through.
  for (const flag of [undefined, null, false, 'true', 1, {}, 'yes']) {
    assert.equal(
      wouldUnpublish({ currentStatus: 'publish', requestedStatus: 'draft', unpublish: flag }),
      true,
      `unpublish: ${JSON.stringify(flag)} must not talk its way past the guard`,
    );
  }
});

test('D-05: a page that is already a draft saves as a draft, as it always did', () => {
  assert.equal(wouldUnpublish({ currentStatus: 'draft', requestedStatus: 'draft' }), false);
});

test('D-05: publishing is never the thing this guard stops', () => {
  assert.equal(wouldUnpublish({ currentStatus: 'publish', requestedStatus: 'publish' }), false);
  assert.equal(wouldUnpublish({ currentStatus: 'draft', requestedStatus: 'publish' }), false);
});

test('D-05: a save with no status at all is not an unpublish', () => {
  assert.equal(wouldUnpublish({ currentStatus: 'publish', requestedStatus: null }), false);
  assert.equal(wouldUnpublish({ currentStatus: 'publish', requestedStatus: undefined }), false);
});

test('D-05: the refusal tells the author what happens instead, and how to unpublish', () => {
  assert.match(UNPUBLISH_REFUSAL, /draft beside it/i);
  assert.match(UNPUBLISH_REFUSAL, /Unpublish/);
  assert.doesNotMatch(UNPUBLISH_REFUSAL, /tenant/i, 'no "tenant" in anything a client reads');
});

/* ── the store ─────────────────────────────────────────────────────────── */

const IDS = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  siteId: '22222222-2222-2222-2222-222222222222',
  pageId: 10,
};

/** A pool whose one request answers with whatever the test hands it. */
function fakePool(answer) {
  const calls = [];
  return {
    calls,
    request() {
      const req = {
        input(name, _type, value) { calls.push([name, value]); return req; },
        query(text) {
          calls.push(['__sql', text]);
          if (answer instanceof Error) throw answer;
          return answer;
        },
      };
      return req;
    },
  };
}

test('saveDraft reports the time the row actually took', async () => {
  const pool = fakePool({ recordset: [{ saved_at: '2026-09-17T01:02:03.000Z' }] });
  const out = await saveDraft(pool, { ...IDS, sections: [{ kind: 'hero' }], title: 'Home' });
  assert.equal(out.ok, true);
  assert.equal(out.savedAt, new Date('2026-09-17T01:02:03.000Z').toISOString());
});

test('a write that did not land is NOT reported as saved', async () => {
  // The whole family of "catch → swallow → report success" bugs in one case.
  const pool = fakePool({ recordset: [] });
  const out = await saveDraft(pool, { ...IDS, sections: [{ kind: 'hero' }] });
  assert.equal(out.ok, false);
  assert.match(out.reason, /Nothing was changed on your website/);
});

test('a database that threw is NOT reported as saved', async () => {
  const pool = fakePool(new Error('Invalid object name arion.site_page_draft.'));
  const out = await saveDraft(pool, { ...IDS, sections: [{ kind: 'hero' }] });
  assert.equal(out.ok, false);
  assert.match(out.reason, /could not hold that draft/i);
});

test('a page too big to hold is refused before the database is touched', async () => {
  const pool = fakePool({ recordset: [{ saved_at: new Date().toISOString() }] });
  const huge = [{ blob: 'x'.repeat(MAX_DRAFT_BYTES + 100) }];
  const out = await saveDraft(pool, { ...IDS, sections: huge });
  assert.equal(out.ok, false);
  assert.equal(pool.calls.length, 0, 'nothing should reach the database');
});

test('getDraft is best effort — an unreadable draft opens the live page instead', async () => {
  assert.equal(await getDraft(fakePool(new Error('no such table')), IDS), null);
  assert.equal(await getDraft(fakePool({ recordset: [] }), IDS), null);
  assert.equal(
    await getDraft(fakePool({ recordset: [{ sections_json: '{not json' }] }), IDS), null,
    'a corrupt row must not throw a page open',
  );
  assert.equal(
    await getDraft(fakePool({ recordset: [{ sections_json: '{"kind":"hero"}' }] }), IDS), null,
    'a draft that is not a list of sections is not a draft',
  );
});

test('getDraft returns the sections verbatim', async () => {
  const pool = fakePool({
    recordset: [{
      sections_json: '[{"kind":"hero","fields":{"heading":"Snow & ice"}}]',
      title: 'Home', saved_at: '2026-09-17T01:02:03.000Z', saved_by: 'a@b.test',
    }],
  });
  const draft = await getDraft(pool, IDS);
  assert.deepEqual(draft.sections, [{ kind: 'hero', fields: { heading: 'Snow & ice' } }]);
  assert.equal(draft.title, 'Home');
  assert.equal(draft.savedBy, 'a@b.test');
});

test('clearDraft says how many rows went, and never throws a publish', async () => {
  assert.deepEqual(await clearDraft(fakePool({ recordset: [{ removed: 1 }] }), IDS), { ok: true, removed: 1 });
  assert.deepEqual(await clearDraft(fakePool(new Error('gone')), IDS), { ok: false, removed: 0 });
});

test('draftPageIds answers with a Set, and an empty one when the table is not there', async () => {
  const some = await draftPageIds(fakePool({ recordset: [{ page_id: 10 }, { page_id: 12 }] }), IDS);
  assert.equal(some.has(10), true);
  assert.equal(some.has(11), false);
  const none = await draftPageIds(fakePool(new Error('no table')), IDS);
  assert.equal(none.size, 0);
});
