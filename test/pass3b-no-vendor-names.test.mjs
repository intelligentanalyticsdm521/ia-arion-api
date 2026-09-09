/**
 * Pass 3b, rows A2-52 / A2-54 — NO VENDOR NAME ON A CLIENT SCREEN.
 *
 * Walking the pre-walk with the page engine switched off for two minutes put
 * five vendor mentions on the one screen the ARION pack exists to make
 * vendor-free: the colours card said "Elementor is not active on this
 * website…", and four greyed settings each said "Your website's theme (Hello
 * Elementor) does not offer this".
 *
 * The behaviour was right; only the words were wrong. A client did not choose
 * the page engine or the theme, cannot install either, and is not being invited
 * to try — naming them gives them a homework assignment for somebody else's
 * software (`feedback_no_third_party_product_surface`).
 *
 * The names are NOT deleted from the system. They stay on the wire, where our
 * own diagnostics read them: `capability.elementorVersion`,
 * `capability.proVersion`, `chrome.theme`. This file pins the SENTENCE only.
 *
 * ONE SENTENCE IN TWO REPOSITORIES. `siteCapability.js` refuses early so the
 * Undo ring is not asked to undo nothing; the plugin's own writer refuses the
 * write and cannot be bypassed. A client who trips both must be told the same
 * thing twice, so `ia-plugin intelligent-analytics.php IA_NO_ELEMENTOR_MESSAGE`
 * carries these exact words. If you change one, change the other.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_ELEMENTOR_MESSAGE, NO_ELEMENTOR_PRO_MESSAGE,
} from '../lib/websiteBuilder/siteCapability.js';

/** Every name a client must never be handed on one of these screens. */
const VENDORS = /elementor|wordpress|wp[- ]admin|hello elementor|astra|rank ?math|yoast|divi/i;

test('the page-engine refusal names nobody', () => {
  assert.doesNotMatch(NO_ELEMENTOR_MESSAGE, VENDORS);
  // Presence, not just absence: a blank string would pass the line above.
  assert.match(NO_ELEMENTOR_MESSAGE, /your website/i);
  assert.match(NO_ELEMENTOR_MESSAGE, /blank/i, 'says what would happen');
  assert.match(NO_ELEMENTOR_MESSAGE, /tell us/i, 'and what to do about it');
  assert.ok(NO_ELEMENTOR_MESSAGE.length > 60, 'still a sentence, not a code');
});

test('the form-widget refusal names nobody', () => {
  assert.doesNotMatch(NO_ELEMENTOR_PRO_MESSAGE, VENDORS);
  assert.match(NO_ELEMENTOR_PRO_MESSAGE, /form/i, 'says what the section needs');
  assert.match(NO_ELEMENTOR_PRO_MESSAGE, /everything else/i,
    'and that the rest of the editor still works');
});
