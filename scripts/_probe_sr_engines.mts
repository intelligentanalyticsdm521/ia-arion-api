#!/usr/bin/env npx tsx
/** READ-ONLY: identify each project's engines so the canonical one is chosen deliberately. */
import fs from 'node:fs';
const src = fs.readFileSync(new URL('./_verify_seranking_rii.mjs', import.meta.url), 'utf8');
const KEY = src.match(/SR_KEY = '([0-9a-f]{20,})'/)![1];
const api = async (p: string) => {
  const r = await fetch(`https://api4.seranking.com${p}`, { headers: { Authorization: `Token ${KEY}` } });
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
};
for (const proj of [2465230, 12497786, 2671555, 2688562]) {
  const engines = await api(`/sites/${proj}/search-engines`).catch(async () => await api(`/sites/${proj}/site-engines`).catch(() => null));
  console.log(`\nproject ${proj}:`, JSON.stringify(engines)?.slice(0, 800));
}
