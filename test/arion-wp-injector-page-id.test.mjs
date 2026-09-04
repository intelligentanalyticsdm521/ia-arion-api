/**
 * D1 — a newly created page must come back with its real WordPress id.
 *
 * `wpInjector.js` read `data.post_id || data.postId`. The IA plugin has never
 * sent either: `upsert_elementor_page` returns
 *   [ 'success' => true, 'page_id' => (int) $page_id, 'edit_url' => …, 'permalink' => … ]
 * (ia-plugin-septa/intelligent-analytics.php). On an UPDATE the bug hid,
 * because the injector falls back to the pageId it was handed. On a CREATE
 * there is no pageId to fall back to, so every AI-built page returned
 * `postId: null` — no Elementor edit URL, and the drafts were never stamped
 * with `persisted_to_post_id`.
 *
 * Evidence: SCOPE_ARION_SITE_BUILDER_2026-09-05 §2.6 "New assembled pages
 * return a null page id".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { injectPageToWordpress } from '../lib/websiteBuilder/wpInjector.js';

const SITE = {
  site_id: '11111111-1111-1111-1111-111111111111',
  domain: 'example.test',
  site_token_raw: 'tok_abc123',
};

function fetchReturning(status, payload) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  });
}

test('a newly created page reports the page_id the plugin actually returns', async () => {
  const res = await injectPageToWordpress(SITE, null, [{ elType: 'section' }], {
    title: 'Services',
    status: 'draft',
    fetchImpl: fetchReturning(200, {
      success: true,
      page_id: 4242,
      edit_url: 'https://example.test/wp-admin/post.php?post=4242&action=edit',
      permalink: 'https://example.test/services/',
    }),
  });

  assert.equal(res.success, true);
  assert.equal(res.postId, 4242, "postId must be the plugin's page_id, not null");
  assert.match(res.elementorEditUrl, /post=4242&action=elementor/);
});

test('an older plugin build that sends post_id still works', async () => {
  const res = await injectPageToWordpress(SITE, null, [], {
    title: 'Services',
    fetchImpl: fetchReturning(200, { success: true, post_id: 77 }),
  });
  assert.equal(res.postId, 77);
});

test('updating an existing page still reports the id it was handed', async () => {
  const res = await injectPageToWordpress(SITE, 88, [], {
    fetchImpl: fetchReturning(200, { success: true, page_id: 88 }),
  });
  assert.equal(res.postId, 88);
});

test('a plugin error is still a failure, not a page id of zero', async () => {
  const res = await injectPageToWordpress(SITE, null, [], {
    title: 'Services',
    fetchImpl: fetchReturning(500, { error: 'Failed to create page: db down' }),
  });
  assert.equal(res.success, false);
  assert.equal(res.httpStatus, 500);
  assert.match(res.error, /Failed to create page/);
});
