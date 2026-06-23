/**
 * _test_seranking_recheck.mjs
 *
 * CLI probe for SE Ranking's audit recheck endpoint. Verifies that
 *   POST https://api4.seranking.com/audit/{auditId}/recheck
 * (no body, legacy SE-RANKING-API-SYSTEM-KEY) returns HTTP 200.
 *
 * Usage:
 *   node scripts/_test_seranking_recheck.mjs                 # uses default audit id 2465230
 *   node scripts/_test_seranking_recheck.mjs --audit-id 1234
 *
 * Idempotent — SE Ranking simply enqueues another crawl. Safe to re-run.
 *
 * Auth: pulls SE-RANKING-API-SYSTEM-KEY from kv-IADM-prod via
 * DefaultAzureCredential (uses your Azure CLI login locally).
 */

import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";

const KV_URI = process.env.KEY_VAULT_URI || "https://kv-iadm-prod.vault.azure.net/";
const SECRET_NAME = "SE-RANKING-API-SYSTEM-KEY";
const HOST = process.env.SERANKING_API_BASE || "https://api4.seranking.com";

function parseArgs(argv) {
  const out = { auditId: "2465230" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--audit-id" || a === "--auditId") {
      out.auditId = argv[i + 1];
      i += 1;
    } else if (a.startsWith("--audit-id=")) {
      out.auditId = a.slice("--audit-id=".length);
    }
  }
  return out;
}

async function loadKey() {
  if (process.env.SERANKING_API_SYSTEM_KEY) {
    return { source: "env", value: process.env.SERANKING_API_SYSTEM_KEY };
  }
  const client = new SecretClient(KV_URI, new DefaultAzureCredential());
  const secret = await client.getSecret(SECRET_NAME);
  return { source: `kv:${KV_URI}`, value: secret?.value || null };
}

async function main() {
  const { auditId } = parseArgs(process.argv.slice(2));
  if (!auditId) {
    console.error("ERROR: --audit-id required");
    process.exit(2);
  }

  console.log(`[recheck-probe] audit_id=${auditId}`);
  console.log(`[recheck-probe] loading ${SECRET_NAME}...`);
  let key;
  try {
    const loaded = await loadKey();
    key = loaded.value;
    console.log(`[recheck-probe] key source=${loaded.source} len=${key ? key.length : 0}`);
  } catch (err) {
    console.error(`[recheck-probe] failed to load secret: ${err.message}`);
    process.exit(3);
  }
  if (!key) {
    console.error(`[recheck-probe] ${SECRET_NAME} not found in env or Key Vault`);
    process.exit(3);
  }

  const url = `${HOST}/audit/${encodeURIComponent(auditId)}/recheck`;
  console.log(`[recheck-probe] POST ${url} (no body)`);

  let status = 0;
  let bodyText = "";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${key}`,
        "Content-Type": "application/json",
      },
    });
    status = res.status;
    bodyText = await res.text();
  } catch (err) {
    console.error(`[recheck-probe] fetch threw: ${err.message}`);
    process.exit(4);
  }

  console.log(`[recheck-probe] status=${status}`);
  console.log(`[recheck-probe] body=${bodyText.slice(0, 500)}`);

  if (status >= 200 && status < 300) {
    console.log("[recheck-probe] OK — recheck queued");
    process.exit(0);
  }
  console.error(`[recheck-probe] FAILED — non-2xx status ${status}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`[recheck-probe] unexpected error: ${err.stack || err.message}`);
  process.exit(5);
});
