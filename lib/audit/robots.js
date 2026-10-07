// lib/audit/robots.js
//
// robots.txt, honoured. We read the group for our own name ("ARGUS-Audit")
// when the site has one, otherwise the "*" group — the standard rule that the
// most specific group wins and groups do not merge. Inside a group the longest
// matching rule wins, and Allow wins a tie. `*` and a trailing `$` in a path
// pattern work as in the common robots dialect.
//
// Sitemap: lines are collected whatever group they sit in.

export const OUR_AGENT = 'argus-audit';

function patternToRegex(p) {
  const anchored = p.endsWith('$');
  const body = (anchored ? p.slice(0, -1) : p)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** Parse robots.txt text into { rules: [{allow, path, re}], sitemaps: [] } for OUR group. */
export function parseRobots(text) {
  const groups = []; // { agents: [], rules: [] }
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const field = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (field === 'sitemap') { if (value) sitemaps.push(value); continue; }
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' || field === 'disallow') {
      // An empty Disallow means "nothing is disallowed".
      if (!value) continue;
      current.rules.push({ allow: field === 'allow', path: value, re: patternToRegex(value) });
    }
  }
  const ours = groups.find((g) => g.agents.includes(OUR_AGENT))
    || groups.find((g) => g.agents.includes('*'));
  return { rules: ours ? ours.rules : [], sitemaps };
}

/** Is this path (with query) allowed for us? */
export function isAllowed(parsed, pathWithQuery) {
  const p = pathWithQuery || '/';
  let best = null;
  for (const r of parsed.rules) {
    if (!r.re.test(p)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

/** True when the site asks us not to read its home page at all. */
export function disallowsEverything(parsed) {
  return !isAllowed(parsed, '/');
}

/**
 * Fetch and parse /robots.txt for an origin.
 * A missing file (404) means everything is allowed. A robots.txt we could not
 * reach at all is treated the same way — the standard behaviour — and noted.
 */
export async function fetchRobots(origin, fetcher) {
  try {
    const res = await fetcher(`${origin}/robots.txt`, { maxBytes: 512 * 1024 });
    if (res.status >= 200 && res.status < 300) {
      return { present: true, ...parseRobots(res.body.toString('utf8')) };
    }
    return { present: false, rules: [], sitemaps: [] };
  } catch (err) {
    return { present: false, rules: [], sitemaps: [], error: err.message };
  }
}

export default { parseRobots, isAllowed, disallowsEverything, fetchRobots, OUR_AGENT };
