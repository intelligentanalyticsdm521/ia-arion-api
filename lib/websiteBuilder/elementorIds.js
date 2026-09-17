/**
 * The two smallest things every emitter needs — and the only module in the
 * website builder with no imports at all.
 * ---------------------------------------------------------------------------
 * `mintId` and `escapeHtml` were declared in `elementorAdapter.js` AND in
 * `containerEmitters.js`, character for character. Two copies of a hash is not
 * a bug until one of them changes; two copies of an HTML escape is a security
 * defect waiting for somebody to "improve" one of them.
 *
 * They live here because this file is a LEAF. `sectionSchema` ↔
 * `elementorAdapter` ↔ `containerEmitters` already import each other in a
 * cycle, and Node resolves that cycle only as long as nothing reaches for a
 * `let` in a half-initialised module. Putting the shared helpers in a module
 * that imports nothing means a new entry point — `elementorTree.js`, say —
 * can use them without entering the cycle at all.
 */

import crypto from 'node:crypto';

/**
 * A short page-engine-style id. Stable for a given seed, so re-applying the
 * same draft produces the same ids and does not churn the page's revisions.
 */
export function mintId(seed, salt) {
  return crypto.createHash('sha1').update(`${seed || ''}::${salt}`).digest('hex').slice(0, 7);
}

/** HTML-escape a value on its way into a widget's markup. */
export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default { mintId, escapeHtml };
