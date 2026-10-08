#!/usr/bin/env node
/**
 * encrypt-gbp-tokens.mjs — seal the Google refresh tokens already stored in clear.
 *
 * arion.site.gbp_oauth_token_ref (and gsc_oauth_token_ref) held the Google
 * refresh token in clear text. New connections are sealed by
 * lib/gbpTokenAtRest.js once the server holds GBP_TOKEN_KEY; this script
 * rewrites the rows stored before that.
 *
 *   node scripts/encrypt-gbp-tokens.mjs                       dry run: lists every site with a token
 *   node scripts/encrypt-gbp-tokens.mjs --apply               seal every clear token
 *   node scripts/encrypt-gbp-tokens.mjs --apply --site <id>   seal one site's tokens only
 *   ... --confirm-server <sql host>                           required for any server other than localhost
 *
 * It prints, per site, ONLY the site_id, the tenant_id and the shape of each
 * column (legacy = clear, sealed, empty). It never prints a token, sealed or not.
 * --apply refuses to run without GBP_TOKEN_KEY. Each value is rewritten in its
 * own transaction: the row is locked and re-read, sealed, checked to open back
 * to the same token, written only if it still holds the value that was read,
 * read back and checked again, and only then committed. Running it twice seals
 * nothing the second time (0 legacy).
 *
 * PRODUCTION STEPS (the operator; nothing here runs them):
 *   1. Migration 074 (db/migrations/074_room_for_sealed_google_tokens.sql) is
 *      applied, so both columns are 1000 characters wide. This script checks
 *      the width and refuses a value that would not fit.
 *   2. Create the Key Vault secret ARION-GBP-TOKEN-KEY holding 32 random bytes
 *      as base64 (for example: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *      piped straight into the vault, never pasted anywhere else).
 *   3. On the arion App Service add the setting GBP_TOKEN_KEY as a Key Vault
 *      reference to ARION-GBP-TOKEN-KEY, and restart the app. From then on every
 *      new Google connection is stored sealed, and the existing clear tokens
 *      keep working (they are read as they are).
 *   4. From an operator machine with the same key in GBP_TOKEN_KEY:
 *        dry run  -> node scripts/encrypt-gbp-tokens.mjs --confirm-server <host>
 *        one site -> ... --apply --site <site_id> --confirm-server <host>
 *        check that site: open its Reviews page in the portal (or run the
 *        review replies job for it) and see its Google reviews load.
 *        the rest -> ... --apply --confirm-server <host>
 *        again    -> a dry run reports 0 legacy.
 *   5. If the key is ever lost, the sealed connections cannot be opened: each
 *      business reconnects Google. Do not delete or rotate the secret without
 *      re-running this script under the new key first.
 */
import sql from 'mssql';
import { pathToFileURL } from 'node:url';
import { seal, open, isSealed, tokenKey } from '../lib/gbpTokenAtRest.js';

/** The two columns that hold a Google refresh token. A fixed list: these names go into SQL text. */
export const TOKEN_COLUMNS = ['gbp_oauth_token_ref', 'gsc_oauth_token_ref'];
const TABLE_RE = /^[a-z_]+\.[a-z_]+$/i;

export function shapeOf(value) {
  if (value === null || value === undefined || !String(value).trim()) return 'empty';
  return isSealed(String(value)) ? 'sealed' : 'legacy';
}

const shortCol = (c) => c.replace('_oauth_token_ref', '');

/** A refusal this script raised itself: its words are plain and safe to print. */
class SealRefused extends Error {}

/** One value, one transaction. Returns 'sealed' | 'skipped' | a plain failure sentence. */
async function sealOne(pool, { table, siteId, column, width, env }) {
  const tx = pool.transaction();
  await tx.begin();
  try {
    const cur = (await tx.request()
      .input('s', sql.UniqueIdentifier, siteId)
      .query(`SELECT ${column} AS v FROM ${table} WITH (UPDLOCK, ROWLOCK) WHERE site_id = @s`)).recordset[0];
    if (!cur || shapeOf(cur.v) !== 'legacy') { await tx.rollback(); return 'skipped'; }
    const clear = String(cur.v);
    const sealed = seal(clear, env);
    if (open(sealed, env) !== clear) throw new SealRefused('the sealed value did not open back to the same token');
    if (width && sealed.length > width) throw new SealRefused(`the sealed value is longer than the column (${width} characters); apply migration 074 first`);
    const upd = await tx.request()
      .input('s', sql.UniqueIdentifier, siteId)
      .input('old', sql.NVarChar(sql.MAX), clear)
      .input('new', sql.NVarChar(sql.MAX), sealed)
      .query(`UPDATE ${table} SET ${column} = @new WHERE site_id = @s AND ${column} = @old`);
    if ((upd.rowsAffected?.[0] ?? 0) !== 1) throw new SealRefused('the row changed while it was being sealed');
    const back = (await tx.request()
      .input('s', sql.UniqueIdentifier, siteId)
      .query(`SELECT ${column} AS v FROM ${table} WHERE site_id = @s`)).recordset[0]?.v;
    if (back !== sealed || open(back, env) !== clear) throw new SealRefused('the value read back did not open to the same token');
    await tx.commit();
    return 'sealed';
  } catch (err) {
    try { await tx.rollback(); } catch { /* already rolled back */ }
    // Never the driver's own message: a SQL truncation error can quote the value.
    // Only this script's own refusals are printed; anything else is the site_id
    // and the database's error number, nothing more.
    if (err instanceof SealRefused) return `not sealed: ${err.message}; nothing was changed for this value`;
    const num = Number.isInteger(err?.number) ? ` (database error ${err.number})` : '';
    return `not sealed: the database refused the write for site_id=${siteId}${num}; nothing was changed for this value`;
  }
}

/**
 * The whole run against a pool. Prints through `out`; never a value.
 * Returns { rows, legacy, sealed, empty, changed, failed }.
 */
export async function runEncrypt({ pool, env = process.env, apply = false, siteId = null, table = 'arion.site', out = console.log }) {
  if (!TABLE_RE.test(table)) throw new Error('bad table name');
  if (apply && !tokenKey(env)) throw new Error('Refusing --apply: GBP_TOKEN_KEY is not set, so there is nothing to seal with.');

  const widths = (await pool.request().query(
    `SELECT COL_LENGTH('${table}', 'gbp_oauth_token_ref') / 2 AS gbp, COL_LENGTH('${table}', 'gsc_oauth_token_ref') / 2 AS gsc`)).recordset[0] || {};
  const req = pool.request();
  if (siteId) req.input('site', sql.UniqueIdentifier, siteId);
  const rows = (await req.query(`
    SELECT site_id, tenant_id, gbp_oauth_token_ref, gsc_oauth_token_ref
      FROM ${table}
     WHERE (gbp_oauth_token_ref IS NOT NULL OR gsc_oauth_token_ref IS NOT NULL)
       ${siteId ? 'AND site_id = @site' : ''}
     ORDER BY tenant_id, site_id`)).recordset;

  const summary = { rows: rows.length, legacy: 0, sealed: 0, empty: 0, changed: 0, failed: 0 };
  out(`${apply ? 'APPLY' : 'Dry run'}: ${rows.length} site(s) with a stored Google token${siteId ? ' (one site asked for)' : ''}. Column widths: gbp ${widths.gbp ?? '?'}, gsc ${widths.gsc ?? '?'} characters.`);
  for (const row of rows) {
    const shapes = TOKEN_COLUMNS.map((c) => [c, shapeOf(row[c])]);
    for (const [, s] of shapes) summary[s] += 1;
    const results = [];
    if (apply) {
      for (const [column, s] of shapes) {
        if (s !== 'legacy') continue;
        const width = column === 'gbp_oauth_token_ref' ? widths.gbp : widths.gsc;
        const r = await sealOne(pool, { table, siteId: row.site_id, column, width, env });
        if (r === 'sealed') summary.changed += 1;
        else if (r !== 'skipped') summary.failed += 1;
        results.push(`${shortCol(column)} ${r}`);
      }
    }
    out(`site_id=${row.site_id} tenant_id=${row.tenant_id} ${shapes.map(([c, s]) => `${shortCol(c)}=${s}`).join(' ')}${results.length ? ` -> ${results.join(', ')}` : ''}`);
  }
  out(apply
    ? `Done: ${summary.changed} value(s) sealed, ${summary.failed} not sealed. Before this run: ${summary.legacy} legacy, ${summary.sealed} sealed.`
    : `Dry run: nothing changed. ${summary.legacy} legacy value(s) would be sealed; ${summary.sealed} already sealed.`);
  return summary;
}

/* ── command line ───────────────────────────────────────────────────────── */

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(argv) {
  await import('dotenv/config');
  const stop = (sentence) => { console.error(sentence); process.exit(1); };
  const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  const apply = argv.includes('--apply');
  const siteId = arg('site');
  if (argv.includes('--site') && (!siteId || !GUID_RE.test(siteId))) stop('Give --site a site_id.');

  let key;
  try { key = tokenKey(process.env); } catch { stop('GBP_TOKEN_KEY is set but is not 32 bytes of base64. Nothing was read or changed.'); }
  if (apply && !key) stop('Refusing --apply: GBP_TOKEN_KEY is not set, so there is nothing to seal with. Nothing was changed.');

  const server = String(process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER || '').split(',')[0].trim();
  const isLocal = /^(localhost|127\.0\.0\.1|\(local\))$/i.test(server);
  if (!isLocal && arg('confirm-server') !== server) {
    stop(`This would read${apply ? ' and rewrite' : ''} the Google tokens on ${server || 'an unknown server'}. Re-run with --confirm-server ${server || '<host>'} if that is what you mean.`);
  }

  const { getServicesPool } = await import('../db/servicesPool.js');
  const pool = await getServicesPool();
  const summary = await runEncrypt({ pool, env: process.env, apply, siteId });
  process.exit(summary.failed ? 2 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => { console.error(`The run stopped on an error before it finished (${err?.code || err?.name || 'error'}). Rows sealed so far stay sealed; run it again.`); process.exit(1); });
}
