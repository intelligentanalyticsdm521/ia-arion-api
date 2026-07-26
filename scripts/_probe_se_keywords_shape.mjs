#!/usr/bin/env node
/** READ-ONLY: getProjectKeywords response shape for Briarwood's project. */
import 'dotenv/config';
import { getProjectKeywords } from '../lib/seranking.js';
const res = await getProjectKeywords('2671555', '45E93346-DBA9-48D5-802B-A4E09A1B03A9');
const walk = (v, d) => {
  if (d > 3) return typeof v;
  if (Array.isArray(v)) return [`array(${v.length})`, v.length ? walk(v[0], d + 1) : null];
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).slice(0, 14).map(([k, x]) => [k, walk(x, d + 1)]));
  return typeof v === 'string' ? `str:${String(v).slice(0, 25)}` : v;
};
console.log(JSON.stringify(walk(res, 0), null, 2).slice(0, 1500));
