/**
 * Probe SE Ranking Project API to find the correct competitor positions
 * endpoint. The previous guess (/sites/{id}/competitors/positions?se_id=X)
 * silently returned nothing — captured zero competitor rows last night.
 */
import 'dotenv/config';

const PROJECT_BASE = "https://api4.seranking.com";
const PROJECT_ID = "2465230"; // intelligentanalyticsdm.com

const key = process.env.SERANKING_API_SYSTEM_KEY;
if (!key) {
  console.error("SERANKING_API_SYSTEM_KEY missing");
  process.exit(1);
}

async function probe(path) {
  try {
    const r = await fetch(`${PROJECT_BASE}${path}`, {
      headers: { Authorization: `Token ${key}` },
    });
    const text = await r.text();
    const sample = text.slice(0, 200).replace(/\s+/g, ' ');
    const isJsonArray = text.trim().startsWith('[');
    const len = isJsonArray ? (JSON.parse(text)?.length ?? '?') : '-';
    console.log(`  ${r.status} arr=${len} ${path}`);
    if (r.ok) console.log(`     body: ${sample}${text.length > 200 ? '...' : ''}`);
  } catch (e) {
    console.log(`  ERR ${path} — ${e.message}`);
  }
}

console.log("=== Discovering tracked engine ids ===");
const posR = await fetch(`${PROJECT_BASE}/sites/${PROJECT_ID}/positions`, {
  headers: { Authorization: `Token ${key}` },
});
const posData = await posR.json();
const engines = Array.from(new Set(posData.map((b) => String(b.site_engine_id))));
console.log(`engines: ${engines.join(', ')}`);
const engineId = engines[0];

console.log("\n=== Discovering competitors ===");
let firstCompId = null;
for (const eid of engines) {
  const compR = await fetch(`${PROJECT_BASE}/sites/${PROJECT_ID}/competitors?se_id=${eid}`, {
    headers: { Authorization: `Token ${key}` },
  });
  const text = await compR.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  console.log(`  se_id=${eid}: status=${compR.status} body=${text.slice(0, 200)}`);
  if (Array.isArray(parsed) && parsed.length > 0) {
    for (const c of parsed) console.log(`    id=${c.id} url=${c.url}`);
    if (!firstCompId) firstCompId = parsed[0]?.id;
  }
}
console.log(`firstCompId for probes: ${firstCompId}`);

console.log("\n=== Probing competitor positions endpoints ===");
const candidates = [
  // Plural / scoped patterns
  `/sites/${PROJECT_ID}/competitors/positions?se_id=${engineId}`,
  `/sites/${PROJECT_ID}/competitor-positions?se_id=${engineId}`,
  `/sites/${PROJECT_ID}/positions/competitors?se_id=${engineId}`,
  // Per-competitor patterns
  `/sites/${PROJECT_ID}/competitors/${firstCompId}/positions`,
  `/sites/${PROJECT_ID}/competitors/${firstCompId}/positions?se_id=${engineId}`,
  // Variants without se_id
  `/sites/${PROJECT_ID}/competitors/positions`,
  `/sites/${PROJECT_ID}/positions?include_competitors=1`,
  `/sites/${PROJECT_ID}/positions?with_competitors=true&se_id=${engineId}`,
  // Engine-scoped patterns
  `/sites/${PROJECT_ID}/engines/${engineId}/competitors/positions`,
  `/sites/${PROJECT_ID}/site-engines/${engineId}/competitors/positions`,
];
for (const p of candidates) await probe(p);

console.log("\n=== Probing date-ranged own-site positions (for 7d window) ===");
const today = new Date().toISOString().split('T')[0];
const sevenAgo = new Date(Date.now() - 7*24*3600*1000).toISOString().split('T')[0];
const datedCandidates = [
  `/sites/${PROJECT_ID}/positions?date_from=${sevenAgo}&date_to=${today}`,
  `/sites/${PROJECT_ID}/positions?date_from=${sevenAgo}&date_to=${today}&se_id=${engineId}`,
];
for (const p of datedCandidates) await probe(p);
