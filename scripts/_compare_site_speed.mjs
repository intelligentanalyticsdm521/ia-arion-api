#!/usr/bin/env node
/**
 * _compare_site_speed.mjs — did the plugin change cost the visitor anything?
 *
 * Measures each site BOTH ways, because the two numbers answer different
 * questions and only one of them is about a real visitor:
 *
 *   cached   — a plain GET, which LiteSpeed serves from its page cache. This is
 *              what a customer actually experiences.
 *   uncached — a GET with a cache-busting param, forcing a full PHP render.
 *              This is what our own tooling sees, and it is the number that
 *              moves if a plugin got heavier.
 *
 * Runs an upgraded site next to one still on the previous version, so the
 * comparison is against a control rather than against a memory of yesterday.
 *
 * Read-only. Usage: node scripts/_compare_site_speed.mjs <domain> [domain ...]
 */
const DOMAINS = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!DOMAINS.length) { console.error('usage: node scripts/_compare_site_speed.mjs <domain> [domain ...]'); process.exit(1); }

const REPS = 3;

async function timeGet(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
    const body = await r.text();
    return { ms: Date.now() - t0, status: r.status, kb: Math.round(body.length / 1024),
             fatal: /Fatal error|critical error/i.test(body) };
  } catch (e) { return { ms: Date.now() - t0, status: 0, err: e.message }; }
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

console.log(`\n${'domain'.padEnd(30)} ${'cached'.padStart(9)} ${'uncached'.padStart(10)}   status`);
console.log('─'.repeat(66));

for (const d of DOMAINS) {
  const cached = [], uncached = [];
  let last = null;
  for (let i = 0; i < REPS; i++) {
    const a = await timeGet(`https://${d}/`);                       // real visitor path
    const b = await timeGet(`https://${d}/?_cb=${Date.now()}${i}`); // forced render
    cached.push(a.ms); uncached.push(b.ms); last = a;
  }
  const flag = last.fatal ? '  PHP ERROR IN PAGE' : '';
  console.log(`${d.padEnd(30)} ${(median(cached) + 'ms').padStart(9)} ${(median(uncached) + 'ms').padStart(10)}   HTTP ${last.status}, ${last.kb}KB${flag}`);
}

console.log(`\n  cached   = what a customer sees (LiteSpeed page cache)`);
console.log(`  uncached = a full PHP render, which is where a heavier plugin would show up`);
