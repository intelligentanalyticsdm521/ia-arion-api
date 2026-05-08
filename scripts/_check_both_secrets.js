import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";

const client = new SecretClient("https://kv-iadm-prod.vault.azure.net/", new DefaultAzureCredential());

for (const name of ['GOOGLE-PAGESPEED-API-KEY', 'arion-google-psi-key']) {
  try {
    const s = await client.getSecret(name);
    console.log(`✓ ${name}: length=${s.value.length}, prefix=${s.value.slice(0, 10)}, suffix=${s.value.slice(-6)}`);
  } catch (err) {
    console.log(`✗ ${name}: ${err.message.split('\n')[0]}`);
  }
}
