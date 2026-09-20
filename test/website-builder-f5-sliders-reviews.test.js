// test/website-builder-f5-sliders-reviews.test.js — what the sliders family
// PUBLISHES to a live website.
//
// B-168, family F5. The Portal's own test asserts that every settings key this
// file produces really is a control of the Elementor widget it claims to be —
// that check lives there because that is where the machine-cut fixture lives.
// What this asserts is the arion side of the same contract:
//
//   · the row is complete, and its widgetType is the page engine's own slug;
//   · a stored document publishes the values the author typed, under the names
//     the engine reads, including the spellings a page written before this
//     family carries;
//   · a PRO widget on a plan with no Pro has a FALLBACK that is real content a
//     visitor can read, and answers null rather than an empty band when there
//     is nothing to say (reference_catch_swallow_report_success);
//   · publishing the same page twice produces the same node ids, so the diff on
//     the customer's site is empty.
//
// ── THE MUTATIONS, run by EXECUTING the real functions ────────────────────
// 2026-09-19, each broken on purpose and restored:
//   · `slideRows` stopped reading `items` → "a page written before this family
//     still publishes its reviews" went red;
//   · `stackedFallback` returned a container with no children instead of null →
//     "nothing to say is a refusal, not an empty band" went red;
//   · `testimonial`'s settings dropped the `p.quote` half of its read → "the
//     stored props become Elementor's own names" went red.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { EMITTERS } from '../lib/websiteBuilder/families/f5-sliders-reviews/emitters.js';
import { ELEMENTOR_WIDGETS, FREE, PRO } from '../lib/websiteBuilder/elementorWidgets.js';

const CTX = { seed: 'page-1', nodeId: 'w-1' };

const SLIDES = [
  { content: 'Never had to call twice.', name: 'Hope Ministries', title: 'Google', rating: 5, image: 'https://cdn.test/a.jpg' },
  { content: 'Drive was clear by six.', name: 'Cedar Ridge HOA', title: 'Google', rating: 4 },
];

describe('the sliders family publishes six widgets, and the page engine knows all six', () => {
  test('every row is complete and reaches the one catalogue', () => {
    for (const [kind, row] of Object.entries(EMITTERS)) {
      assert.equal(typeof row.widgetType, 'string', kind);
      assert.ok(row.widgetType, `${kind}: no widgetType`);
      assert.ok(row.tier, `${kind}: no tier`);
      assert.ok(row.label, `${kind}: no label`);
      assert.equal(typeof row.settings, 'function', `${kind}: no settings(props, ctx)`);
      assert.equal(ELEMENTOR_WIDGETS[kind], row, `${kind} did not reach ELEMENTOR_WIDGETS`);
    }
  });

  test('the widgetTypes are the page engine\'s own slugs', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(EMITTERS).map(([k, r]) => [k, r.widgetType])), {
      testimonial: 'testimonial',
      reviews: 'reviews',
      testimonial_carousel: 'testimonial-carousel',
      slides: 'slides',
      media_carousel: 'media-carousel',
    });
  });

  test('one is free and five are paid, and the gate answers for each', () => {
    assert.equal(ELEMENTOR_WIDGETS.testimonial.tier, FREE);
    for (const k of ['reviews', 'testimonial_carousel', 'slides', 'media_carousel']) {
      assert.equal(ELEMENTOR_WIDGETS[k].tier, PRO, k);
    }
  });

  test('Carousel and Loop Carousel are NOT published, and that is on purpose', () => {
    // A row's settings() returns SETTINGS. Carousel's slides are real
    // containers published as `elements: [...]`, which this seam cannot say,
    // and Loop Carousel draws each slide with a saved loop template. Either
    // one would be an empty carousel on a customer's live site.
    for (const k of ['carousel', 'nested_carousel', 'loop_carousel']) {
      assert.equal(EMITTERS[k], undefined, `${k} was published anyway`);
    }
  });
});

describe('a stored document publishes the values the author typed', () => {
  test('the testimonial\'s stored props become Elementor\'s own names', () => {
    const s = EMITTERS.testimonial.settings({
      quote: 'They were out before we opened.', attribution: 'Hope Ministries',
      job: 'Property manager', image: 'https://cdn.test/face.jpg', align: 'left',
    }, CTX);
    assert.equal(s.testimonial_content, 'They were out before we opened.');
    assert.equal(s.testimonial_name, 'Hope Ministries');
    assert.equal(s.testimonial_job, 'Property manager');
    assert.equal(s.testimonial_image.url, 'https://cdn.test/face.jpg');
    /* Elementor's control offers start / center / end, so a document that
       stored `left` publishes as `start` - the same thing on the page -
       rather than being dropped and quietly becoming centre. */
    assert.equal(s.testimonial_alignment, 'start');
  });

  test('…and a testimonial that came back out of a published page publishes unchanged', () => {
    const s = EMITTERS.testimonial.settings({
      testimonial_content: 'Back from the page.', testimonial_name: 'Cedar Ridge HOA',
    }, CTX);
    assert.equal(s.testimonial_content, 'Back from the page.');
    assert.equal(s.testimonial_name, 'Cedar Ridge HOA');
  });

  test('Reviews publishes one repeater row per review, with the rating as a number', () => {
    const s = EMITTERS.reviews.settings({ slides: SLIDES }, CTX);
    assert.equal(s.slides.length, 2);
    assert.equal(s.slides[0].content, 'Never had to call twice.');
    assert.equal(s.slides[0].name, 'Hope Ministries');
    assert.equal(s.slides[0].rating, 5);
    assert.equal(s.slides[1].rating, 4);
    assert.equal(s.slides[0].image.url, 'https://cdn.test/a.jpg');
  });

  test('a page written before this family still publishes its reviews', () => {
    // MUTATION: drop `items` from the emitter's own slide reader → red here.
    const s = EMITTERS.reviews.settings({
      items: [{ quote: 'From the old shape.', author: 'Hope Ministries', rating: 5 }],
    }, CTX);
    assert.equal(s.slides.length, 1);
    assert.equal(s.slides[0].content, 'From the old shape.');
    assert.equal(s.slides[0].name, 'Hope Ministries');
  });

  test('a switcher publishes "yes" or nothing, never false', () => {
    // Elementor reads any present value as on, so `false` would turn autoplay ON.
    const off = EMITTERS.reviews.settings({ slides: SLIDES, autoplay: false, loop: false }, CTX);
    assert.equal(off.autoplay, '');
    assert.equal(off.loop, '');
    const on = EMITTERS.reviews.settings({ slides: SLIDES }, CTX);
    assert.equal(on.autoplay, 'yes');
  });

  test('a slider control publishes Elementor\'s own unit shape', () => {
    const s = EMITTERS.slides.settings({ slides: [{ heading: 'One' }], slides_height: 520 }, CTX);
    assert.deepEqual(s.slides_height, { unit: 'px', size: 520, sizes: [] });
  });

  test('a media slide says whether it is a picture or a video', () => {
    const s = EMITTERS.media_carousel.settings({
      slides: [{ type: 'video', image: 'https://cdn.test/poster.jpg', video: 'https://cdn.test/clip' }],
    }, CTX);
    assert.equal(s.slides[0].type, 'video');
    assert.equal(s.slides[0].video.url, 'https://cdn.test/clip');
  });

  test('publishing the same page twice produces the same bytes', () => {
    for (const [kind, row] of Object.entries(EMITTERS)) {
      const a = JSON.stringify(row.settings({ slides: SLIDES }, CTX));
      const b = JSON.stringify(row.settings({ slides: SLIDES }, CTX));
      assert.equal(a, b, kind);
    }
  });
});

describe('a plan with no Pro widgets still gets something a visitor can read', () => {
  test('every paid row has a fallback, and the free one needs none', () => {
    for (const k of ['reviews', 'testimonial_carousel', 'slides', 'media_carousel']) {
      assert.equal(typeof EMITTERS[k].fallback, 'function', k);
    }
    assert.equal(EMITTERS.testimonial.fallback, undefined);
  });

  test('the fallback carries the author\'s own words onto the page', () => {
    const node = EMITTERS.reviews.fallback({ slides: SLIDES }, CTX);
    const json = JSON.stringify(node);
    assert.equal(node.elType, 'container');
    assert.match(json, /Never had to call twice\./);
    assert.match(json, /Hope Ministries/);
    // Free widgets only: a Lite site has no Pro at all.
    for (const w of node.elements) assert.ok(['heading', 'text-editor'].includes(w.widgetType), w.widgetType);
  });

  test('a media carousel falls back to the pictures, not to words about them', () => {
    const node = EMITTERS.media_carousel.fallback({
      slides: [{ image: 'https://cdn.test/a.jpg' }, { image: 'https://cdn.test/b.jpg' }],
    }, CTX);
    assert.equal(node.widgetType, 'image-gallery');
    assert.equal(node.settings.wp_gallery.length, 2);
  });

  test('nothing to say is a refusal, not an empty band', () => {
    // MUTATION: return the container anyway → red here. An empty bordered box
    // on a live page with a green toast over it is the failure this refuses.
    for (const k of ['reviews', 'testimonial_carousel', 'slides', 'media_carousel']) {
      assert.equal(EMITTERS[k].fallback({ slides: [] }, CTX), null, k);
    }
  });

  test('the fallback\'s node ids are the same every publish', () => {
    const a = JSON.stringify(EMITTERS.reviews.fallback({ slides: SLIDES }, CTX));
    const b = JSON.stringify(EMITTERS.reviews.fallback({ slides: SLIDES }, CTX));
    assert.equal(a, b);
  });
});
