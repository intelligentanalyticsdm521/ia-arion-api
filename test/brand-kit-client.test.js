// test/brand-kit-client.test.js — arion reads THE brand kit
// (BUILDER_PLATFORM_SCOPE_2026-09-15 §2, step 0).
//
// The bug this pins: arion.site.branding_* is stamped at provisioning and
// nothing has written it since, so a client could edit Brand Identity every day
// and their own website kept day-one colours. loadBrandContext must prefer the
// kit and keep the site columns only as a fallback.
//
// Mutation check: swap the order in the return block back to
// `site.branding_primary_color || kit.colours.primary` and the ordering test
// goes red.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  getBrandKit,
  neutralBrandKit,
  clearBrandKitCache,
  NEUTRAL_BRAND_COLOURS,
  BRAND_KIT_TTL_MS,
} from "../lib/brandKitClient.js";

const TENANT = "11111111-1111-1111-1111-111111111111";
const KIT = {
  tenant_id: TENANT,
  found: true,
  colours: { primary: "#2F6F4F", secondary: "#E8B54D", accent: "#D94F2B", text: "#111827", background: "#FFFFFF" },
  fonts: { heading: "Montserrat", body: "Lato", catalog: [] },
  logo_url: "https://cdn.example.com/logo.png",
  updated_at: "2026-09-15T12:00:00.000Z",
  sources: {},
};
const silent = { warn() {}, error() {} };
const okFetch = (calls = []) => async (url, init) => {
  calls.push({ url, init });
  return { ok: true, status: 200, json: async () => KIT };
};

describe("the client", () => {
  test("asks platform-api's internal route with the shared secret", async () => {
    clearBrandKitCache();
    process.env.PLATFORM_API_URL = "http://platform.test";
    process.env.PLATFORM_INTERNAL_TOKEN = "s3cret";
    const calls = [];
    const kit = await getBrandKit(TENANT, { fetchImpl: okFetch(calls), log: silent });
    assert.match(calls[0].url, /\/internal\/brand-kit\//);
    assert.equal(calls[0].init.headers["x-internal-token"], "s3cret");
    assert.equal(kit.colours.secondary, "#E8B54D");
  });

  test("caches for 60 seconds, then asks again", async () => {
    clearBrandKitCache();
    const calls = [];
    const f = okFetch(calls);
    let t = 0;
    const now = () => t;
    await getBrandKit(TENANT, { fetchImpl: f, now, log: silent });
    t = BRAND_KIT_TTL_MS - 1;
    await getBrandKit(TENANT, { fetchImpl: f, now, log: silent });
    assert.equal(calls.length, 1);
    t = BRAND_KIT_TTL_MS + 1;
    await getBrandKit(TENANT, { fetchImpl: f, now, log: silent });
    assert.equal(calls.length, 2);
  });

  test("a blip serves the last known kit; with none, the neutral one; never throws", async () => {
    clearBrandKitCache();
    await getBrandKit(TENANT, { fetchImpl: okFetch(), now: () => 0, log: silent });
    const down = async () => { throw new Error("ECONNREFUSED"); };
    const stale = await getBrandKit(TENANT, { fetchImpl: down, now: () => BRAND_KIT_TTL_MS + 1, log: silent });
    assert.equal(stale.colours.primary, "#2F6F4F");
    assert.equal(stale.stale, true);

    clearBrandKitCache();
    const cold = await getBrandKit(TENANT, { fetchImpl: down, log: silent });
    assert.deepEqual(cold.colours, { ...NEUTRAL_BRAND_COLOURS });
    await assert.doesNotReject(() => getBrandKit("", { log: silent }));
  });

  test("the neutral is slate and byte-identical to platform-api's", () => {
    assert.deepEqual({ ...NEUTRAL_BRAND_COLOURS }, {
      primary: "#0F172A", secondary: "#475569", accent: "#334155", text: "#111827", background: "#FFFFFF",
    });
    assert.equal(neutralBrandKit(TENANT).found, false);
  });
});

describe("loadBrandContext prefers the kit over arion.site", () => {
  const SRC = readFileSync(path.join(process.cwd(), "lib", "websiteBuilder", "brandContext.js"), "utf8");

  test("it calls the one kit", () => {
    assert.match(SRC, /getBrandKit\(tenantId\)/);
  });

  test("the kit is read BEFORE the return block builds the colours", () => {
    const kitAt = SRC.indexOf("await getBrandKit(tenantId)");
    const returnAt = SRC.indexOf("primary_color:    kit.colours");
    assert.ok(kitAt > 0 && returnAt > kitAt, "the kit must be resolved before it is used");
  });

  test("the kit WINS and arion.site is the fallback, not the other way round", () => {
    assert.match(SRC, /primary_color:\s+kit\.colours\?\.primary\s+\|\|\s+site\.branding_primary_color/);
    assert.match(SRC, /logo_url:\s+kit\.logo_url\s+\|\|\s+site\.branding_logo_url/);
    assert.match(SRC, /font_family:\s+kit\.fonts\?\.body\s+\|\|\s+site\.branding_font_family/);
  });

  test("secondary and accent are finally carried — buildBrandCssVars had dead branches", () => {
    // pageAssembler.js has emitted --ia-secondary and --ia-accent since it was
    // written; EMPTY_BRAND never had the keys, so neither var could ever be set.
    assert.match(SRC, /secondary_color:\s+kit\.colours\?\.secondary/);
    assert.match(SRC, /accent_color:\s+kit\.colours\?\.accent/);
    const assembler = readFileSync(path.join(process.cwd(), "lib", "websiteBuilder", "pageAssembler.js"), "utf8");
    assert.match(assembler, /--ia-secondary/);
    assert.match(assembler, /--ia-accent/);
  });

  test("EMPTY_BRAND carries every slot a caller reads, so a miss is null and not undefined", () => {
    for (const key of ["secondary_color", "accent_color", "heading_font", "brand_kit_source"]) {
      assert.ok(SRC.includes(`${key}:`), `EMPTY_BRAND is missing ${key}`);
    }
  });
});
