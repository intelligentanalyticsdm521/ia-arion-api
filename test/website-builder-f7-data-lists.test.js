// test/website-builder-f7-data-lists.test.js — the f7-data-lists family
// publishes keys the page engine really has, and values in the shapes it reads.
//
// BUILDER_FULL_WIDGET_PLAN_2026-09-19 §C.3 item 7. Two different ways a widget
// can be quietly wrong on a live page, and this file is the one that catches
// both:
//
//   1. A KEY THE WIDGET DOES NOT HAVE is dropped on publish. The author moves
//      the control, the toast says saved, the page does not change. That is
//      `reference_catch_swallow_report_success` wearing a different hat, and
//      the only defence is the machine file.
//   2. A VALUE IN THE WRONG SHAPE is read as nothing, which looks identical
//      from the outside. Elementor stores a switcher as the STRING "yes", a
//      slider as `{ unit, size, sizes }`, a link as `{ url, is_external,
//      nofollow }` and a picture as `{ url, id }`. A bare `30` where a slider
//      belongs is a gap the page never gets.
//
// ── THE FIXTURE IS A BYTE COPY, ON PURPOSE ────────────────────────────────
// `test/fixtures/WIDGET_SETTINGS_KEYS.json` is copied byte for byte from the
// Portal's, which `scripts/gen-widget-settings-keys.mjs` cut from the
// 2026-09-17 scrape of a real install. It lives here as well as there so this
// suite answers for itself: a test that reached across into a sibling checkout
// would go red whenever the two repos were not side by side, which is a
// failure about the disk and not about the code. Regenerate BOTH from the same
// scrape, and read the diff.
//
// ── MUTATION CHECK (run, not assumed) ─────────────────────────────────────
// See the note at the bottom of this file.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMITTERS } from '../lib/websiteBuilder/families/f7-data-lists/emitters.js';
import { ELEMENTOR_WIDGETS } from '../lib/websiteBuilder/elementorWidgets.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_KEYS = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', 'WIDGET_SETTINGS_KEYS.json'), 'utf8'));

/** The nineteen kinds this family owns, and Elementor's slug for each. */
const SLUG_OF = {
  posts: 'posts',
  portfolio: 'portfolio',
  loop_grid: 'loop-grid',
  archive_posts: 'archive-posts',
  taxonomy_filter: 'taxonomy-filter',
  search: 'search',
  sitemap: 'sitemap',
  template: 'template',
  post_info: 'post-info',
  post_navigation: 'post-navigation',
  post_comments: 'post-comments',
  author_box: 'author-box',
  theme_site_logo: 'theme-site-logo',
  theme_site_title: 'theme-site-title',
  theme_page_title: 'theme-page-title',
  theme_post_title: 'theme-post-title',
  theme_post_excerpt: 'theme-post-excerpt',
  theme_post_featured_image: 'theme-post-featured-image',
  theme_archive_title: 'theme-archive-title',
  /* THE FAMILY'S IA TWIN (B-168 wave 2). `ia_posts` is a REGISTERED Elementor
     widget - the IA plugin's own, 207 controls - so it is in the machine file
     exactly like the nineteen above and every question below is asked of it in
     the same way. The row it replaced published two keys and read a prop the
     Portal never wrote; see the emitter's own header. */
  ia_posts: 'ia_posts',
};

/** The one row of this family that is OURS rather than Elementor Pro's. */
const IA_TWIN = new Set(['ia_posts']);

/**
 * Keys Elementor stores as a slider, per the 2026-09-17 scrape.
 *
 * QUALIFIED BY WIDGET, and that is not tidiness: `image_size` is a SLIDER on
 * Author Box (how big to draw the avatar) and a SELECT on Site Logo and
 * Featured Image (which registered size of the picture to load). One unqualified
 * set said both were sliders and this suite went red on the two image widgets,
 * which is the test doing its job. A key means what the widget says it means.
 */
const SLIDERS = new Set([
  'posts.classic_column_gap', 'posts.classic_row_gap',
  'archive-posts.archive_classic_column_gap', 'archive-posts.archive_classic_row_gap',
  'portfolio.item_ratio', 'portfolio.item_gap', 'portfolio.column_gap', 'portfolio.row_gap',
  'post-info.space_between', 'post-info.icon_size',
  'post-navigation.arrow_size',
  'author-box.image_size',
  'taxonomy-filter.taxonomy_filter_items_space_between',
]);

/** Keys Elementor stores as a switcher — the string "yes", or empty. */
const SWITCHERS = new Set([
  'classic_show_title', 'classic_show_excerpt', 'classic_show_read_more',
  'archive_classic_show_title', 'archive_classic_show_excerpt', 'archive_classic_show_read_more',
  'masonry', 'equal_height', 'show_title', 'show_filter_bar', 'show_label', 'show_arrow',
  'show_borders', 'show_avatar', 'show_name', 'show_biography', 'show_link',
  'multiple_selection', 'show_empty_items', 'show_first_item', 'divider',
  'live_results', 'enable_nothing_found_message', 'sitemap_add_nofollow',
  'sitemap_password_protected', 'posts_avoid_duplicates', 'post_query_avoid_duplicates',
]);

/** Keys Elementor stores as a link, and keys it stores as a picture. */
const LINKS = new Set(['link', 'posts_url', 'author_website']);
const MEDIA = new Set(['image', 'author_avatar']);

test('the family publishes exactly the twenty kinds it owns', () => {
  // PRESENCE first: the failure that matters is a widget quietly not published.
  assert.deepEqual(Object.keys(EMITTERS).sort(), Object.keys(SLUG_OF).sort());
});

test('every row of this family reached ELEMENTOR_WIDGETS', () => {
  for (const kind of Object.keys(EMITTERS)) {
    assert.equal(ELEMENTOR_WIDGETS[kind], EMITTERS[kind],
      `${kind} is declared and does not reach the catalogue, so publishing it would draw nothing`);
  }
});

describe('every key published is a key the widget really has', () => {
  for (const [kind, slug] of Object.entries(SLUG_OF)) {
    test(`${kind} → ${slug}`, () => {
      const row = EMITTERS[kind];
      assert.equal(row.widgetType, slug);
      if (IA_TWIN.has(kind)) {
        /* NOT `pro`. It needs the IA PLUGIN, not an Elementor licence, and
           `reference_nav_visibility_semantics` refuses one word for the two. */
        assert.equal(row.tier, 'ia:arion', `${kind}: an IA twin needs our plugin, not Elementor Pro`);
      } else {
        assert.equal(row.tier, 'pro', 'all nineteen Elementor widgets here are Pro ones');
      }
      assert.ok(row.label, 'a row needs a label for the message when a plan cannot carry it');

      const w = SETTINGS_KEYS.widgets[slug];
      assert.ok(w, `${slug} is not in the 2026-09-17 Elementor catalogue`);
      const emitted = row.settings({}, {});

      assert.ok(w.keys.length,
        `${slug}: the catalogue reports no controls for this widget, so nothing can be checked `
        + `against it. A widget in that state does not get built - see Breadcrumbs in the handoff.`);

      const legal = new Set(w.keys);
      const stray = Object.keys(emitted).filter((k) => !legal.has(k) && !legal.has(k.replace(/_(tablet|mobile)$/, '')));
      assert.deepEqual(stray, [],
        `${slug}: the page engine drops these on publish and the author's change does nothing`);
    });
  }
});

describe('every value published is in the shape the engine reads', () => {
  for (const [kind, slug] of Object.entries(SLUG_OF)) {
    test(`${kind} → ${slug}`, () => {
      const emitted = EMITTERS[kind].settings({}, {});
      for (const [key, value] of Object.entries(emitted)) {
        const at = `${slug}.${key}`;
        if (SLIDERS.has(at)) {
          assert.equal(typeof value, 'object', `${slug}.${key} is a slider, not a number`);
          assert.equal(typeof value.size, 'number', `${slug}.${key}.size`);
          assert.ok('unit' in value && Array.isArray(value.sizes), `${slug}.${key} needs unit and sizes`);
        } else if (SWITCHERS.has(key)) {
          assert.ok(value === 'yes' || value === '',
            `${slug}.${key} is a switcher: the string "yes" or empty, never ${JSON.stringify(value)}`);
        } else if (LINKS.has(key)) {
          assert.equal(typeof value, 'object', `${slug}.${key} is a link control`);
          assert.equal(typeof value.url, 'string');
          assert.ok('is_external' in value && 'nofollow' in value, `${slug}.${key}`);
        } else if (MEDIA.has(key)) {
          assert.equal(typeof value, 'object', `${slug}.${key} is a media control`);
          assert.equal(typeof value.url, 'string');
        }
      }
    });
  }

  test('an author who changed nothing still publishes the engine\'s own defaults', () => {
    // Presence, not absence: the Posts widget with no props must still say it
    // is the classic skin, still ask for three columns and still ask for six.
    const s = EMITTERS.posts.settings({}, {});
    assert.equal(s._skin, 'classic');
    assert.equal(s.classic_columns, '3');
    assert.equal(s.classic_posts_per_page, 6);
    assert.equal(s.posts_orderby, 'post_date');
    const a = EMITTERS.archive_posts.settings({}, {});
    assert.equal(a._skin, 'archive_classic');
    /* THE SWITCHERS TOO, and this is the case that caught a real one: a switch
       the author never touched arrives as `undefined`, and reading that as
       "off" turned every title, excerpt and Read More OFF the moment the grid
       was published. Elementor's own default for those three is "yes". Found by
       executing the emitter with no props and reading what came out. */
    assert.equal(s.classic_show_title, 'yes');
    assert.equal(s.classic_show_excerpt, 'yes');
    assert.equal(s.classic_show_read_more, 'yes');
    assert.equal(a.archive_classic_show_title, 'yes');
    assert.equal(EMITTERS.author_box.settings({}, {}).show_avatar, 'yes');
    /* ...and a switch the author really turned off stays off. */
    assert.equal(EMITTERS.posts.settings({ classic_show_title: '' }, {}).classic_show_title, '');
    /* ...and one whose Elementor default is "no" is not quietly turned on. */
    assert.equal(EMITTERS.author_box.settings({}, {}).show_link, '');
    assert.equal(a.posts_post_type, undefined, 'an archive has no query of its own');
  });

  test('a value the engine does not know is refused, not passed through', () => {
    const s = EMITTERS.posts.settings({ classic_columns: '9', posts_order: 'sideways' }, {});
    assert.equal(s.classic_columns, '3', 'nine columns is not one of Elementor\'s six');
    assert.equal(s.posts_order, 'desc');
  });

  test('Search ships with Live Results off, so the published page needs no script', () => {
    const s = EMITTERS.search.settings({}, {});
    assert.equal(s.live_results, '');
    assert.equal(s.pagination_type_options, 'none');
    assert.equal(s.search_query_offset, undefined, 'Search has no offset — its query is the visitor\'s words');
  });
});

/*
 * MUTATION CHECK — run on 2026-09-19, by executing this file, not by reading it.
 *
 *   · `posts.settings` gained `classic_colums: '3'` (one letter out) →
 *     "every key published is a key the widget really has › posts → posts" went
 *     red naming the key. Removed → green.
 *   · `classic_column_gap` was changed from `slider(...)` to a bare `30` →
 *     "every value published is in the shape the engine reads › posts → posts"
 *     went red saying it is a slider, not a number. Restored → green.
 *   · `breadcrumbs.settings` returned `{ align: 'left' }` → its case went red
 *     saying the catalogue reports no controls. Restored → green.
 */

/* ══════════════════════════════════════════════════════════════════════════
   IA POSTS — EVERY CONTROL, PUBLISHED (B-168 wave 2)
   ══════════════════════════════════════════════════════════════════════════

   The keys are checked above. This asks the other half: does the value the
   author chose really come out the other side? The row this one replaces is
   the reason the question is worth asking — it published
   `posts_per_page: Number(p.count) || 3` when the Portal's panel had never
   written `count` in its life, so the emitter looked correct, the fixture
   agreed, and the number on the page was always three. */
describe('IA Posts: what the author chose is what is published', () => {
  const row = EMITTERS.ia_posts;

  /** One moved value per control on the Portal's panel, and what must come out. */
  const MOVED = [
    ['post_skin', 'magazine', 'magazine'],
    ['image_mode', 'none', 'none'],
    ['post_theme', 'dark', 'dark'],
    ['post_preset', 'bold', 'bold'],
    ['columns', '2', '2'],
    ['posts_per_page', 4, 4],
    ['post_type', 'portfolio', 'portfolio'],
    ['orderby', 'title', 'title'],
    ['order', 'ASC', 'ASC'],
    ['show_category', '', ''],
    ['show_title', '', ''],
    ['title_tag', 'h2', 'h2'],
    ['show_excerpt', '', ''],
    ['excerpt_length', 45, 45],
    ['show_author', '', ''],
    ['show_date', '', ''],
    ['show_read_time', '', ''],
    ['show_tags', '', ''],
    ['show_read_more', '', ''],
    ['read_more_text', 'Read the whole thing', 'Read the whole thing'],
    ['image_position', 'top left', 'top left'],
    ['pagination_type', 'load_more', 'load_more'],
    ['archive_label', 'Everything we have written', 'Everything we have written'],
    ['title_typography_font_weight', '300', '300'],
  ];

  for (const [key, given, expected] of MOVED) {
    test(`ia_posts.${key}`, () => {
      const out = row.settings({ [key]: given }, {});
      assert.deepEqual(out[key], expected,
        `the author set ${key} and the page engine is handed something else`);
    });
  }

  for (const key of ['card_gap', 'card_border_radius', 'card_padding',
    'title_typography_font_size', 'excerpt_typography_font_size', 'meta_typography_font_size']) {
    test(`ia_posts.${key} is a slider, in the shape the engine reads`, () => {
      const out = row.settings({ [key]: 37 }, {});
      assert.deepEqual(out[key], { unit: 'px', size: 37, sizes: [] },
        'a bare number where a slider belongs is a gap the page never gets');
    });

    test(`ia_posts.${key} carries its tablet and mobile twins`, () => {
      const out = row.settings({ [key + '_tablet']: 11, [key + '_mobile']: 5 }, {});
      assert.deepEqual(out[key + '_tablet'], { unit: 'px', size: 11, sizes: [] });
      assert.deepEqual(out[key + '_mobile'], { unit: 'px', size: 5, sizes: [] });
    });

    test(`ia_posts.${key} leaves the twins OFF when nobody set one`, () => {
      // An absent responsive key is how Elementor says "inherit the desktop
      // value". Publishing one anyway pins a phone to a number the author
      // never chose, and they would have to find the device switcher to undo it.
      const out = row.settings({}, {});
      assert.equal(key + '_tablet' in out, false);
      assert.equal(key + '_mobile' in out, false);
    });
  }

  test('a switcher the author has not touched keeps the PLUGIN default, not "off"', () => {
    // The `yn(v, dflt)` rule, at the boundary that matters. Reading an absent
    // switcher as off turned every title, excerpt and Read More off on publish.
    const out = row.settings({}, {});
    for (const k of ['show_category', 'show_title', 'show_excerpt', 'show_author',
      'show_date', 'show_read_time', 'show_tags', 'show_read_more']) {
      assert.equal(out[k], 'yes', `${k} was quietly switched off on publish`);
    }
  });

  test('…and one the author really switched off stays off', () => {
    const out = row.settings({ show_excerpt: '', show_tags: '' }, {});
    assert.equal(out.show_excerpt, '');
    assert.equal(out.show_tags, '');
  });

  test('a page published before B-168 keeps the number it was given', () => {
    // `count` is arion's own legacy prop for this widget. Nothing upgrades the
    // stored pages, so the emitter reads it — and the new key wins when both
    // are there, because that is the one the panel writes today.
    assert.equal(row.settings({ count: 5 }, {}).posts_per_page, 5);
    assert.equal(row.settings({ count: 5, posts_per_page: 2 }, {}).posts_per_page, 2);
  });

  test('a value the plugin does not offer is refused, never passed through', () => {
    const out = row.settings({
      post_skin: 'whatever', columns: '9', post_type: 'invoice',
      title_tag: 'marquee', pagination_type: 'infinite', image_position: 'nowhere',
    }, {});
    assert.equal(out.post_skin, 'signal');
    assert.equal(out.columns, '3');
    assert.equal(out.post_type, 'any');
    assert.equal(out.title_tag, 'h3');
    assert.equal(out.pagination_type, 'numbers');
    assert.equal(out.image_position, 'center center');
  });

  test('the archive link is published as a plain address, however the panel stored it', () => {
    // The Portal's `link` control writes `{ url, is_external, nofollow }`; the
    // plugin's `archive_link` is a TEXT control and reads a string. Both spellings.
    assert.equal(row.settings({ archive_link: 'https://example.test/news' }, {}).archive_link,
      'https://example.test/news');
    assert.equal(row.settings({ archive_link: { url: 'https://example.test/news' } }, {}).archive_link,
      'https://example.test/news');
  });

  test('the row the family replaced is GONE from the catalogue', () => {
    // Replace means delete. `mergeEmitters` would have made the family win
    // anyway, but a dead row of the same name is the next agent's confusion.
    assert.equal(ELEMENTOR_WIDGETS.ia_posts, EMITTERS.ia_posts);
    assert.ok('post_skin' in ELEMENTOR_WIDGETS.ia_posts.settings({}, {}),
      'the catalogue is still serving the two-key row');
  });
});
