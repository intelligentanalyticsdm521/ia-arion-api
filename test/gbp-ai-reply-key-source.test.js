// test/gbp-ai-reply-key-source.test.js — the review-reply writer reads its
// provider key by the same rule as the content writer: the setting, or Key
// Vault ONLY on the live service. Off the live service a missing setting fails
// closed, so a dev machine never spends real money through the production
// vault (8 Oct 2026: it did, four times, before this rule).
import { test } from "node:test";
import assert from "node:assert/strict";
import { getApiKey, _resetApiKeyCache } from "../lib/gbpAiReply.js";

const vaultMustNotBeRead = { getSecret: async () => { throw new Error("Key Vault was read off the live service"); } };

test("off the live service with no setting: fails closed with a plain 'not set' error, and never reads Key Vault", async () => {
  _resetApiKeyCache();
  await assert.rejects(
    () => getApiKey({ env: {}, live: false, kvClient: vaultMustNotBeRead }),
    (e) => e.code === "no_api_key" && /ANTHROPIC_API_KEY is not set/.test(e.message) && !/Key Vault/.test(e.message),
  );
});

test("the setting wins everywhere, and is cached", async () => {
  _resetApiKeyCache();
  assert.equal(await getApiKey({ env: { ANTHROPIC_API_KEY: "test-key-not-real" }, live: false, kvClient: vaultMustNotBeRead }), "test-key-not-real");
  assert.equal(await getApiKey({ env: {}, live: false, kvClient: vaultMustNotBeRead }), "test-key-not-real", "cached after the first read");
  _resetApiKeyCache();
});

test("on the live service with no setting: Key Vault is the fallback", async () => {
  _resetApiKeyCache();
  const vault = { getSecret: async (name) => ({ value: name === "ANTHROPIC-API-KEY" ? "vault-key-not-real" : null }) };
  assert.equal(await getApiKey({ env: {}, live: true, kvClient: vault }), "vault-key-not-real");
  _resetApiKeyCache();
});
