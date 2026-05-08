/**
 * Lazy secret loader from Azure Key Vault.
 *
 * Uses DefaultAzureCredential which automatically picks up the App Service
 * Managed Identity in production, or local Azure CLI credentials in dev.
 *
 * Resolution order for any secret:
 *   1. process.env.<UPPERCASE_NAME> — direct env var (dev convenience)
 *   2. Key Vault secret with kebab-case name
 *   3. null
 *
 * Cached for the process lifetime — secrets don't change without a redeploy.
 */
import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";

const KEY_VAULT_URI = process.env.KEY_VAULT_URI || "https://kv-iadm-prod.vault.azure.net/";

let _client = null;
const _cache = new Map();

function getClient() {
  if (_client) return _client;
  try {
    _client = new SecretClient(KEY_VAULT_URI, new DefaultAzureCredential());
    return _client;
  } catch (err) {
    console.error('[secrets] Failed to init Key Vault client:', err.message);
    return null;
  }
}

/**
 * Load a secret. Returns null if not found anywhere.
 *
 * @param {string} envName  e.g. 'GOOGLE_API_KEY'
 * @param {string} secretName  e.g. 'arion-google-psi-key' (Key Vault name)
 */
export async function getSecret(envName, secretName) {
  // 1. Env var wins
  if (process.env[envName]) return process.env[envName];

  // 2. Cache check
  if (_cache.has(secretName)) return _cache.get(secretName);

  // 3. Key Vault
  const client = getClient();
  if (!client) {
    _cache.set(secretName, null);
    return null;
  }
  try {
    const secret = await client.getSecret(secretName);
    const val = secret?.value || null;
    _cache.set(secretName, val);
    return val;
  } catch (err) {
    console.error(`[secrets] Failed to read '${secretName}' from Key Vault:`, err.message);
    _cache.set(secretName, null); // negative-cache so we don't hammer the vault
    return null;
  }
}
