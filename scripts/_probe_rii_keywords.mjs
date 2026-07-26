#!/usr/bin/env node
/** READ-ONLY: RII tracked keywords → confirms their vertical for category mapping. */
import fs from 'node:fs';
const src = fs.readFileSync(new URL('./_verify_seranking_rii.mjs', import.meta.url), 'utf8');
const KEY = src.match(/SR_KEY = '([0-9a-f]{20,})'/)[1];
const r = await fetch('https://api4.seranking.com/sites/12497786/keywords', { headers: { Authorization: `Token ${KEY}` } });
const kws = await r.json();
console.log((Array.isArray(kws) ? kws : []).map((k) => k.name).join(' · '));
