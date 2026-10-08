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

// Limits on what a site's own robots file can make us do. The file, the
// rules and the link paths are all chosen by whoever owns the website, so a
// check must stay cheap whatever they write.
export const MAX_RULES = 500;
export const MAX_RULE_LENGTH = 1000;
export const MAX_PATH_LENGTH = 2048;

/**
 * A rule as plain pieces: the text between its `*`s, and whether a trailing
 * `$` pins it to the end. Matching is a left-to-right scan with indexOf (no
 * regular expression), so it cannot backtrack: a hostile rule like
 * "/*a*a*a*a*b" costs one pass over the path, not exponential time.
 */
function compileRule(p) {
  const anchored = p.endsWith('$');
  return { anchored, pieces: (anchored ? p.slice(0, -1) : p).split('*') };
}

/** Does the rule match the start of this path (the robots "prefix" match, with * and $)? */
export function ruleMatches(rule, path) {
  const { pieces, anchored } = rule;
  if (!path.startsWith(pieces[0])) return false;
  let at = pieces[0].length;
  const last = pieces.length - 1;
  for (let i = 1; i <= last; i++) {
    const piece = pieces[i];
    if (i === last && anchored) {
      // The final piece must sit at the very end, after where we are.
      return path.length - piece.length >= at && path.endsWith(piece);
    }
    const found = path.indexOf(piece, at);
    if (found < 0) return false;
    at = found + piece.length;
  }
  return anchored ? at === path.length : true;
}

/** Parse robots.txt text into { rules: [{allow, path, pieces, anchored}], sitemaps: [] } for OUR group. */
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
      if (!value || value.length > MAX_RULE_LENGTH || current.rules.length >= MAX_RULES) continue;
      current.rules.push({ allow: field === 'allow', path: value, ...compileRule(value) });
    }
  }
  const ours = groups.find((g) => g.agents.includes(OUR_AGENT))
    || groups.find((g) => g.agents.includes('*'));
  return { rules: ours ? ours.rules : [], sitemaps };
}

/** Is this path (with query) allowed for us? */
export function isAllowed(parsed, pathWithQuery) {
  // A path longer than any real page address is cut, so one check stays cheap.
  const p = String(pathWithQuery || '/').slice(0, MAX_PATH_LENGTH);
  let best = null;
  for (const r of parsed.rules) {
    if (!ruleMatches(r, p)) continue;
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

export default { parseRobots, isAllowed, disallowsEverything, fetchRobots, ruleMatches, OUR_AGENT };
