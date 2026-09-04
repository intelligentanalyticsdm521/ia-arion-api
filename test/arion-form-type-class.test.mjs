/**
 * D3 — a generated form must carry its type.
 *
 * The plugin's form interceptor decides what a submission IS from the form
 * widget's `form_css_class`
 * (ia-plugin-septa/includes/class-ia-form-interceptor.php:127):
 *
 *   [ 'ia-booking' => 'booking', 'ia-quote' => 'quote',
 *     'ia-newsletter' => 'newsletter', 'ia-lead' => 'lead',
 *     'ia-contact' => 'contact' ]
 *
 * Generated forms set no class at all, so no form the builder produced could
 * ever be typed booking, quote or lead — every one landed as "contact" via
 * the form-name substring fallback.
 *
 * Evidence: SCOPE_ARION_SITE_BUILDER_2026-09-05 §2.5, §3.6.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blockToElementorSection,
  formCssClassFor,
  __test__ as adapterTest,
} from '../lib/websiteBuilder/elementorAdapter.js';

const BRAND = { business_name: 'Cedar Ridge Plant Services', email: 'owner@cedarridge.test' };

const CONTACT_BLOCK = {
  headline: 'Get a quote within one business day',
  subheadline: '',
  contact_methods: [
    { kind: 'phone', label: 'Call us', value: '(319) 555-0142', href: 'tel:+13195550142' },
  ],
  form_config: { fields: ['Name', 'Email', 'Message'], submit_text: 'Send message' },
};

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

const formOf = (block) => findWidgets(
  blockToElementorSection({ kind: 'contact', block, brand: BRAND, seedId: 's' }),
  'form',
)[0];

test('a contact section emits a form typed for the interceptor', () => {
  const form = formOf(CONTACT_BLOCK);
  assert.ok(form, 'a form widget is emitted');
  assert.equal(form.settings.form_css_class, 'ia-lead');
});

test('an explicit form purpose wins over the section kind', () => {
  assert.equal(
    formOf({ ...CONTACT_BLOCK, form_config: { ...CONTACT_BLOCK.form_config, purpose: 'booking' } })
      .settings.form_css_class,
    'ia-booking',
  );
  assert.equal(
    formOf({ ...CONTACT_BLOCK, form_purpose: 'quote' }).settings.form_css_class,
    'ia-quote',
  );
  assert.equal(
    formOf({ ...CONTACT_BLOCK, form_purpose: 'newsletter' }).settings.form_css_class,
    'ia-newsletter',
  );
});

test('the class is stable across re-emits of the same block', () => {
  assert.equal(formOf(CONTACT_BLOCK).settings.form_css_class, formOf(CONTACT_BLOCK).settings.form_css_class);
});

test('every token we emit is one the plugin interceptor actually routes', () => {
  // The interceptor's table, transcribed from class-ia-form-interceptor.php:127.
  const INTERCEPTOR_TOKENS = new Set(['ia-booking', 'ia-quote', 'ia-newsletter', 'ia-lead', 'ia-contact']);
  for (const cls of Object.values(adapterTest.FORM_PURPOSE_CLASS)) {
    assert.ok(INTERCEPTOR_TOKENS.has(cls), `${cls} must be a token the interceptor knows`);
  }
  assert.ok(INTERCEPTOR_TOKENS.has(formCssClassFor('anything-unrecognised')));
});

test('formCssClassFor maps each purpose and never returns an untyped value', () => {
  assert.equal(formCssClassFor('contact'), 'ia-lead');
  assert.equal(formCssClassFor('lead'), 'ia-lead');
  assert.equal(formCssClassFor('quote'), 'ia-quote');
  assert.equal(formCssClassFor('Booking'), 'ia-booking');
  assert.equal(formCssClassFor('newsletter'), 'ia-newsletter');
  assert.equal(formCssClassFor(''), 'ia-lead');
  assert.equal(formCssClassFor(null), 'ia-lead');
  assert.equal(formCssClassFor('nonsense'), 'ia-lead');
});
