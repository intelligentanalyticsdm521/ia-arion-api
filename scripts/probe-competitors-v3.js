/**
 * Round 3: get the FULL body for the include=competitors query, and try
 * the SE Ranking docs' modern competitor endpoint patterns.
 */
import 'dotenv/config';

const BASE = "https://api4.seranking.com";
const PROJECT_ID = "2465230";
const key = process.env.SERANKING_API_SYSTEM_KEY;

async function full(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Token ${key}` } });
  const text = await r.text();
  console.log(`\n--- ${r.status} ${path}`);
  console.log(text.length > 4000 ? text.slice(0, 4000) + '...[truncated]' : text);
}

await full("/sites/2465230?include=competitors");
await full("/sites/2465230?include=competitors,positions");

console.log("\n\n=== Look for competitors in another shape ===");
await full("/sites/2465230/competitors?se_id=46877&date=2026-04-19");
// Some SE Ranking accounts use POST for project-detail queries
const compR = await fetch(`${BASE}/sites/2465230/competitors`, {
  method: 'POST',
  headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ site_engine_id: 46877 }),
});
console.log(`\n--- POST /sites/2465230/competitors body={site_engine_id:46877}: ${compR.status}`);
console.log((await compR.text()).slice(0, 600));
