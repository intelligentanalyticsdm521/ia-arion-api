// test/seranking-positions-parse.test.js
//
// SE Ranking positions parsing (SEO defect batch, 2026-07-22). Two proven
// facts drive these fixtures (live probe against api4, project 2465230):
//
//   1. /positions day entries are { date, pos, depth, change, price, is_map,
//      map_position, paid_position } — there is NO url field on day entries.
//      The ranked URL is the keyword-level `landing_pages` array
//      ([{ url, ascii_url, date }]), present only with &with_landing_pages=1.
//      The old parser walked day entries looking for url/landing_url/
//      landing_page, so every keyword's url was null and the Portal Pages tab
//      bucketed everything under "(unranked or unknown URL)".
//
//   2. /positions responses are ENGINE BLOCKS ([{ site_engine_id, keywords }]),
//      not flat keyword rows. The old /seo/decay route iterated the blocks as
//      if they were keyword rows (r.keyword_id ?? r.id on a block — both
//      undefined), so it structurally returned decaying: [] forever.

import test from "node:test";
import assert from "node:assert/strict";
import { parsePositions, computeDecayingKeywords } from "../lib/serankingParse.js";

// Day entry in the PROVEN live shape (all real fields present).
const day = (date, pos, change = 0) => ({
  date,
  pos,
  depth: 100,
  change,
  price: 0,
  is_map: 0,
  map_position: 0,
  paid_position: 0,
});

const lp = (url, date) => ({ url, ascii_url: url, date });

test("parsePositions: url comes from latest-dated landing_pages entry; pos/change parse from day entries", () => {
  const blocks = [
    {
      site_engine_id: 55001,
      keywords: [
        {
          id: 101,
          name: "digital marketing agency",
          group_id: 1,
          volume: 720,
          competition: 0.4,
          suggested_bid: 2,
          cpc: 3.1,
          results: 1000000,
          total_sum: 0,
          positions: [day("2026-07-01", 8, 0), day("2026-07-04", 6, 2), day("2026-07-07", 4, 2)],
          landing_pages: [lp("https://example.com/services", "2026-06-20"), lp("https://example.com/", "2026-07-06")],
        },
        {
          id: 202,
          name: "seo company",
          group_id: 1,
          volume: 480,
          competition: 0.2,
          suggested_bid: 1,
          cpc: 2.0,
          results: 900000,
          total_sum: 0,
          positions: [day("2026-07-01", 0), day("2026-07-07", 0)],
          landing_pages: [],
        },
        {
          id: 303,
          name: "web design",
          group_id: 2,
          volume: 260,
          competition: 0.3,
          suggested_bid: 1,
          cpc: 1.5,
          results: 800000,
          total_sum: 0,
          positions: [day("2026-07-01", 15)],
          // no landing_pages on THIS engine — url must merge in from engine 2
        },
      ],
    },
    {
      site_engine_id: 55002,
      keywords: [
        {
          id: 101,
          name: "digital marketing agency",
          positions: [day("2026-07-01", 10, 0), day("2026-07-07", 8, 1)],
          // no landing_pages field at all — url from engine 1 must survive
        },
        {
          id: 303,
          name: "web design",
          positions: [day("2026-07-01", 20)],
          landing_pages: [lp("https://example.com/web-design", "2026-07-01")],
        },
      ],
    },
  ];

  const out = parsePositions(blocks, { rangeStart: "2026-07-01", rangeEnd: "2026-07-07" });
  const byId = Object.fromEntries(out.map((k) => [k.keywordId, k]));

  // kw 101: url = latest-dated landing_pages entry (2026-07-06 beats 2026-06-20)
  assert.equal(byId[101].url, "https://example.com/", "latest-dated landing page wins");
  // positions parse: engine 1 avg (8+6+4)/3 = 6, engine 2 avg (10+8)/2 = 9 → round(7.5) = 8
  assert.equal(byId[101].currentPosition, 8);
  // point-to-point change per engine: +4 and +2 → round(3) = 3
  assert.equal(byId[101].positionChange, 3);
  assert.equal(byId[101].engineCount, 2);
  assert.equal(byId[101].rankingEngineCount, 2);
  // per-engine series preserves pos + change from day entries
  const e1 = byId[101].perEngine.find((e) => e.engineId === "55001");
  assert.deepEqual(e1.series[0], { date: "2026-07-01", pos: 8, change: 0 });
  assert.deepEqual(e1.series[2], { date: "2026-07-07", pos: 4, change: 2 });
  assert.equal(e1.positionChange, 4);

  // kw 202: never ranked, empty landing_pages → honest nulls
  assert.equal(byId[202].url, null);
  assert.equal(byId[202].currentPosition, null);

  // kw 303: landing_pages only on the SECOND engine block → merge fills url
  assert.equal(byId[303].url, "https://example.com/web-design");
  assert.equal(byId[303].currentPosition, 18); // round((15+20)/2)
});

test("parsePositions: keyword with no landing_pages anywhere has url null (day entries carry no url)", () => {
  const blocks = [
    {
      site_engine_id: 55001,
      keywords: [
        { id: 401, name: "plumber near me", volume: 90, positions: [day("2026-07-01", 3), day("2026-07-07", 5)] },
      ],
    },
  ];
  const out = parsePositions(blocks, { rangeStart: "2026-07-01", rangeEnd: "2026-07-07" });
  assert.equal(out.length, 1);
  assert.equal(out[0].url, null);
  assert.equal(out[0].currentPosition, 4); // avg(3,5)
});

test("computeDecayingKeywords: flattens engine blocks (2 blocks x 2 keywords) and reports decayed keywords", () => {
  // Prior period: kw 101 best pos 4 (block A), kw 102 best pos 18 (block B),
  // kw 103 best pos 5.
  const prior = [
    {
      site_engine_id: 55001,
      keywords: [
        { id: 101, name: "decayed kw name", volume: 590, positions: [day("2026-06-05", 4)] },
        { id: 102, name: "improving kw", volume: 110, positions: [day("2026-06-05", 20)] },
        { id: 103, name: "boundary kw name", volume: 90, positions: [day("2026-06-05", 5)] },
      ],
    },
    {
      site_engine_id: 55002,
      keywords: [
        { id: 101, name: "decayed kw name", positions: [day("2026-06-06", 6)] },
        { id: 102, name: "improving kw", positions: [day("2026-06-06", 18)] },
      ],
    },
  ];
  // Current period: kw 101 best pos 9 (block B — but its landing page arrived
  // on block A, so the url must survive the cross-block best-pos update),
  // kw 102 improved to 10, kw 103 decayed by exactly the minimum delta (3).
  const current = [
    {
      site_engine_id: 55001,
      keywords: [
        {
          id: 101,
          name: "decayed kw name",
          volume: 590,
          positions: [day("2026-07-05", 12)],
          landing_pages: [lp("https://example.com/blog/decayed-post", "2026-07-04")],
        },
        { id: 102, name: "improving kw", volume: 110, positions: [day("2026-07-05", 10)] },
        { id: 103, name: "boundary kw name", volume: 90, positions: [day("2026-07-05", 8)] },
      ],
    },
    {
      site_engine_id: 55002,
      keywords: [
        { id: 101, name: "decayed kw name", positions: [day("2026-07-06", 9)] },
        { id: 102, name: "improving kw", positions: [day("2026-07-06", 11)] },
      ],
    },
  ];

  const metaById = {
    101: { keyword: "decaying keyword", volume: 590 },
    103: { keyword: "boundary kw", volume: 90 },
  };

  const decaying = computeDecayingKeywords(current, prior, metaById);

  // kw 102 improved (18 → 10) so exactly the two decayed keywords appear,
  // sorted worst-first.
  assert.equal(decaying.length, 2);
  assert.deepEqual(decaying[0], {
    keywordId: 101,
    keyword: "decaying keyword",
    url: "https://example.com/blog/decayed-post",
    priorPosition: 4,
    currentPosition: 9,
    change: 5,
    searchVolume: 590,
  });
  assert.deepEqual(decaying[1], {
    keywordId: 103,
    keyword: "boundary kw",
    url: null,
    priorPosition: 5,
    currentPosition: 8,
    change: 3, // exactly the minimum delta still counts
    searchVolume: 90,
  });
});

test("computeDecayingKeywords: falls back to block-carried name/volume when metaById has no entry", () => {
  const prior = [{ site_engine_id: 1, keywords: [{ id: 7, name: "fallback kw", volume: 40, positions: [day("2026-06-05", 2)] }] }];
  const current = [{ site_engine_id: 1, keywords: [{ id: 7, name: "fallback kw", volume: 40, positions: [day("2026-07-05", 30)] }] }];
  const decaying = computeDecayingKeywords(current, prior);
  assert.equal(decaying.length, 1);
  assert.equal(decaying[0].keyword, "fallback kw");
  assert.equal(decaying[0].searchVolume, 40);
  assert.equal(decaying[0].change, 28);
});
