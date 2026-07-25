#!/usr/bin/env npx tsx
/** READ-ONLY: dump the SE Ranking /positions response shape for one project. */
import fs from 'node:fs';
const src = fs.readFileSync(new URL('./_verify_seranking_rii.mjs', import.meta.url), 'utf8');
const KEY = src.match(/SR_KEY = '([0-9a-f]{20,})'/)![1];
const api = async (path: string) => {
  const r = await fetch(`https://api4.seranking.com${path}`, { headers: { Authorization: `Token ${KEY}` } });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
};
const raw = await api(`/sites/12497786/positions?date_from=2026-06-01&date_to=2026-07-25`);
const walk = (v: any, depth: number): any => {
  if (depth > 3) return typeof v;
  if (Array.isArray(v)) return [`array(${v.length})`, v.length ? walk(v[0], depth + 1) : null];
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 12).map(([k, x]) => [k, walk(x, depth + 1)]));
  return typeof v === 'string' ? `str:${String(v).slice(0, 30)}` : v;
};
console.log(JSON.stringify(walk(raw, 0), null, 2).slice(0, 3500));
