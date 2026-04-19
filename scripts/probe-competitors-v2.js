/**
 * Deep-probe SE Ranking competitor endpoints. The previous probe found
 * /sites/{id}/competitors?se_id=X returns 400 — let's find what works.
 */
import 'dotenv/config';

const BASE = "https://api4.seranking.com";
const PROJECT_ID = "2465230";

const key = process.env.SERANKING_API_SYSTEM_KEY;
if (!key) { console.error("SERANKING_API_SYSTEM_KEY missing"); process.exit(1); }

async function probe(path, label = '') {
  try {
    const r = await fetch(`${BASE}${path}`, { headers: { Authorization: `Token ${key}` } });
    const text = await r.text();
    const sample = text.slice(0, 400).replace(/\s+/g, ' ');
    let arrLen = '-';
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) arrLen = parsed.length;
      else if (Array.isArray(parsed?.competitors)) arrLen = `obj.competitors[${parsed.competitors.length}]`;
      else if (Array.isArray(parsed?.data)) arrLen = `obj.data[${parsed.data.length}]`;
    } catch {}
    console.log(`  ${r.status} arr=${arrLen} ${path}${label ? ` (${label})` : ''}`);
    if (r.ok) console.log(`     body: ${sample}${text.length > 400 ? '...' : ''}`);
  } catch (e) { console.log(`  ERR ${path} — ${e.message}`); }
}

console.log("\n=== Competitor list endpoints ===");
const compCandidates = [
  "/sites/2465230/competitors",
  "/sites/2465230/competitor-list",
  "/sites/2465230/competitor",
  "/sites/2465230/competitors/list",
  "/sites/2465230/competitors?mode=domain",
  "/sites/2465230/competitors?se_id=46877",
  "/sites/2465230/competitors?engine_id=46877",
  "/sites/2465230/competitors?site_engine_id=46877",
  "/competitors?site_id=2465230",
  "/projects/2465230/competitors",
  "/sites/2465230?include=competitors",
];
for (const c of compCandidates) await probe(c);

console.log("\n=== Search engine list (to verify engine ids) ===");
await probe("/sites/2465230/search-engines");
await probe("/sites/2465230/site-engines");
await probe("/sites/2465230/engines");

console.log("\n=== Project / site detail ===");
await probe("/sites/2465230");
