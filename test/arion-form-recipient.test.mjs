/**
 * D2 — a generated contact form must have somewhere to send the lead.
 *
 * `elementorAdapter.js` set the Elementor Pro form widget's `email_to` from
 * `brand?.email`. `brandContext.js` built no `email` key, so the value was
 * ALWAYS the empty string: every AI-built contact form on every ARION site
 * shipped with no notification recipient. Capture into ARION still worked
 * (the plugin's form interceptor fires regardless of the widget's email
 * settings), so nothing looked broken — the owner just never heard about the
 * lead.
 *
 * Evidence: SCOPE_ARION_SITE_BUILDER_2026-09-05 §2.5, §3.6.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blockToElementorSection,
  resolveFormRecipient,
  FormRecipientError,
} from '../lib/websiteBuilder/elementorAdapter.js';
import { assemblePage } from '../lib/websiteBuilder/pageAssembler.js';
import { __test__ as brandTest } from '../lib/websiteBuilder/brandContext.js';

const CONTACT_BLOCK = {
  headline: 'Get a quote within one business day',
  subheadline: 'Tell us about the facility.',
  contact_methods: [
    { kind: 'phone', label: 'Call us', value: '(319) 555-0142', href: 'tel:+13195550142' },
  ],
  form_config: { fields: ['Name', 'Email', 'Message'], submit_text: 'Send message' },
};

/** Walk an Elementor tree and return every widget node of a given widgetType. */
function findWidgets(node, widgetType, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    node.forEach((n) => findWidgets(n, widgetType, out));
    return out;
  }
  if (node.elType === 'widget' && node.widgetType === widgetType) out.push(node);
  (node.elements || []).forEach((n) => findWidgets(n, widgetType, out));
  return out;
}

test('brand context carries an email key at all', () => {
  // The root cause: the defaulted shape every emitter interpolates had no
  // `email`, so `brand?.email` could only ever be undefined.
  assert.ok('email' in brandTest.EMPTY_BRAND, 'EMPTY_BRAND must define email');
});

test('the generated contact form notifies the business email', () => {
  const section = blockToElementorSection({
    kind: 'contact',
    block: CONTACT_BLOCK,
    brand: { business_name: 'Cedar Ridge Plant Services', email: 'owner@cedarridge.test' },
    seedId: 'seed-1',
  });
  const [form] = findWidgets(section, 'form');
  assert.ok(form, 'a form widget is emitted');
  assert.equal(form.settings.email_to, 'owner@cedarridge.test');
  assert.notEqual(form.settings.email_to, '');
});

test('a form with no resolvable recipient is refused, not shipped empty', () => {
  assert.throws(
    () => blockToElementorSection({
      kind: 'contact', block: CONTACT_BLOCK, brand: { business_name: 'No Email Co' }, seedId: 's',
    }),
    (err) => {
      assert.ok(err instanceof FormRecipientError, 'a typed refusal, not a generic crash');
      assert.match(err.message, /notification email/i);
      assert.equal(err.code, 'form_recipient_missing');
      return true;
    },
  );
});

test('resolveFormRecipient: brand address first, then the section\'s own email method', () => {
  assert.equal(resolveFormRecipient({ email: 'a@b.test' }, {}), 'a@b.test');
  assert.equal(resolveFormRecipient({ notification_email: 'n@b.test' }, {}), 'n@b.test');

  // No brand address — fall back to the mailto: the copy already shows.
  assert.equal(
    resolveFormRecipient({}, {
      contact_methods: [
        { kind: 'phone', href: 'tel:+13195550142' },
        { kind: 'email', href: 'mailto:hello@cedarridge.test?subject=Hi' },
      ],
    }),
    'hello@cedarridge.test',
  );

  // Nothing anywhere — null. Never an invented address.
  assert.equal(resolveFormRecipient({}, {}), null);
  assert.equal(resolveFormRecipient({ email: 'not-an-email' }, {}), null);
  assert.equal(resolveFormRecipient(null, null), null);
});

test('the assembler reports the refusal in skipped[] instead of publishing a dead form', () => {
  const out = assemblePage(
    [{ kind: 'contact', block_id: 'b1', block_json: CONTACT_BLOCK }],
    { business_name: 'No Email Co' },
  );
  assert.equal(out.sectionsBuilt, 0, 'the dead form is not built');
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].code, 'form_recipient_missing');
  assert.match(out.skipped[0].reason, /notification email/i);
});

test('one unbuildable form does not take the rest of the page down', () => {
  const hero = {
    headline: 'Facilities that run themselves',
    subheadline: 'Industrial cleaning across eastern Iowa.',
    cta_text: 'Get a quote',
    cta_href: '#contact',
    background_style: 'solid',
  };
  const out = assemblePage(
    [
      { kind: 'hero', block_id: 'b0', block_json: hero },
      { kind: 'contact', block_id: 'b1', block_json: CONTACT_BLOCK },
    ],
    { business_name: 'No Email Co' },
  );
  assert.equal(out.sectionsBuilt, 1);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].block_id, 'b1');
});
