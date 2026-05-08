import { getSecret } from "../lib/secrets.js";

console.log("Testing Key Vault secret retrieval...");
const key = await getSecret('GOOGLE_API_KEY', 'arion-google-psi-key');
if (!key) {
  console.log("✗ Could not retrieve secret. Check vault access and secret name.");
  process.exit(1);
}
console.log(`✓ Got secret (length=${key.length}, prefix=${key.slice(0, 8)}...)`);
console.log(`Match expected: ${key.startsWith('AIzaSyAnEb') ? 'YES' : 'NO'}`);
