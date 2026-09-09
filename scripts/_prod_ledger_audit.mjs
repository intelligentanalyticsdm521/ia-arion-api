/**
 * _prod_ledger_audit.mjs — READ-ONLY. Which rows in production's migration
 * ledger claim work that is not there?
 *
 * §6 of the defect register: "the migration ledger cannot be trusted".
 * `db.schema_migrations` on prod records `LUMEN-API/041_leadgen_inbox_visit` and
 * `LUMEN-API/044_leadgen_worker_registry` as applied, with `applied_by='backfill'`,
 * and NEITHER table exists. A ledger that says a thing ran is worth nothing if
 * nobody has ever checked that the thing it ran is there — and every deploy
 * decision since has been made on that ledger.
 *
 * WHAT IT DOES
 *   1. reads `db.schema_migrations` from PRODUCTION;
 *   2. finds each row's migration FILE in the local checkout of its repo;
 *   3. extracts the objects that file creates — tables, views, procedures,
 *      functions, and the columns it adds;
 *   4. asks EVERY production database whether they exist;
 *   5. for anything missing, checks whether a LATER migration DROPS it, and
 *      whether the migration ITSELF said the object might not be there.
 *
 * TWO THINGS THAT WOULD MAKE THIS LIE, both learned by getting them wrong on
 * the first run of it (2026-09-09):
 *
 *   ONE DATABASE IS NOT THE ESTATE. `core.*` lives in `iadm_platform` and the
 *   product schemas in `iadm_services`, on the same server. Auditing only
 *   `iadm_services` reported SEVEN `core.*` objects as missing that are
 *   perfectly present next door. An object is PRESENT if it is in any of them.
 *
 *   A CONDITIONAL IS NOT A CLAIM. `oliver-api/117` guards its ALTER with
 *   `IF OBJECT_ID('oliver.consulting_document') IS NOT NULL` and says in a
 *   comment that the table may not exist in every environment; `LUMEN/057`
 *   adds a column to `core.tenant` AND `core.tenants`, whichever is there.
 *   Neither is a hole. A file that guards on its own object being NULL and
 *   then creates it — the ordinary idempotent create, `LUMEN/041` — IS.
 *
 * IT WRITES NOTHING. Every statement is a SELECT. There is no INSERT, UPDATE,
 * DELETE, ALTER, CREATE or DROP anywhere in this file, and
 * `test/prod-ledger-audit.test.mjs` asserts that by reading it.
 *
 *   node scripts/_prod_ledger_audit.mjs [--out <path.md>] [--dbs iadm_services,iadm_platform]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prodPool } from './_prodsql.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

// Every database on the production server that holds any of our schemas. One
// of them is not the estate: `core.*` is in iadm_platform and the product
// schemas are in iadm_services.
const DBS = arg('dbs', 'iadm_services,iadm_platform').split(',').map((d) => d.trim()).filter(Boolean);
const OUT = arg('out', null);

/** Where each repo's migrations live on this machine. */
const REPOS = {
  'LUMEN-API': arg('lumen', 'C:\\dev\\iadm\\LUMEN-API-septa-loose\\db\\migrations'),
  'oliver-api': arg('oliver', 'C:\\dev\\oliver-api-septa-loose\\db\\migrations'),
  'arion-api': arg('arion', 'C:\\dev\\iadm\\arion-api-septa-loose\\db\\migrations'),
  'platform-api': arg('platform', 'C:\\dev\\iadm\\platform-api\\db\\migrations'),
};

/* ── reading a migration file ─────────────────────────────────────────────── */

const strip = (sql) => sql
  .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
  .replace(/^\s*--.*$/gm, ' ');        // line comments

const clean = (name) => String(name).replace(/[[\]"]/g, '').trim();

/**
 * The objects a migration file creates. Deliberately conservative: a name this
 * misses is a finding that never appears, which is the safe direction for an
 * audit whose output somebody will act on.
 */
export function objectsCreatedBy(sqlText) {
  const src = strip(sqlText);
  const tables = new Set();
  const modules = new Set();
  const columns = new Set();

  const named = /CREATE\s+(?:OR\s+ALTER\s+)?(TABLE|VIEW|PROCEDURE|PROC|FUNCTION|TRIGGER)\s+((?:\[[^\]]+\]|[A-Za-z0-9_]+)\.(?:\[[^\]]+\]|[A-Za-z0-9_]+))/gi;
  for (const m of src.matchAll(named)) {
    const kind = m[1].toUpperCase();
    const name = clean(m[2]);
    if (name.includes('#')) continue;                 // temp table
    (kind === 'TABLE' ? tables : modules).add(name);
  }

  const added = /ALTER\s+TABLE\s+((?:\[[^\]]+\]|[A-Za-z0-9_]+)\.(?:\[[^\]]+\]|[A-Za-z0-9_]+))\s+ADD\s+(?!CONSTRAINT\b)(\[?[A-Za-z0-9_]+\]?)/gi;
  for (const m of src.matchAll(added)) columns.add(`${clean(m[1])}.${clean(m[2])}`);

  return { tables: [...tables], modules: [...modules], columns: [...columns] };
}

/** Does any migration file DROP this object? "Removed on purpose" is not a hole. */
export function droppedBy(sqlText, objectName) {
  const src = strip(sqlText);
  const bare = objectName.split('.').pop();
  const re = new RegExp(
    `DROP\\s+(?:TABLE|VIEW|PROCEDURE|PROC|FUNCTION|TRIGGER)\\s+(?:IF\\s+EXISTS\\s+)?[^;\\n]*\\b${bare}\\b`, 'i');
  return re.test(src);
}

export function columnDroppedBy(sqlText, qualified) {
  const src = strip(sqlText);
  const parts = qualified.split('.');
  const col = parts.pop();
  const table = parts.pop();
  const re = new RegExp(`ALTER\\s+TABLE\\s+[^;\\n]*\\b${table}\\b[^;\\n]*DROP\\s+COLUMN\\s+[^;\\n]*\\b${col}\\b`, 'i');
  return re.test(src);
}

/**
 * Did the migration itself say this object might not be there?
 *
 * `IF OBJECT_ID('x') IS NOT NULL` before touching x means "only if it exists",
 * which is a different statement from "I create x". The ordinary idempotent
 * create — `IF OBJECT_ID('x') IS NULL` then CREATE x — is NOT conditional, and
 * that is exactly the shape of the two rows §6 caught.
 */
export function guardedAsOptional(sqlText, objectName) {
  const src = strip(sqlText);
  const table = objectName.split('.').slice(0, 2).join('.');
  const re = new RegExp(
    `OBJECT_ID\\(\\s*'${table.replace('.', "\\.")}'[^)]*\\)\\s*IS\\s+NOT\\s+NULL`, 'i');
  return re.test(src);
}

const num = (filename) => {
  const m = /^(\d+)/.exec(filename);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
};

/* ── the run ──────────────────────────────────────────────────────────────── */

async function main() {
  const ledgerPool = await prodPool(DBS[0]);
  const rows = (await ledgerPool.request().query(
    `SELECT repo, filename, sha256, applied_at, applied_by
       FROM db.schema_migrations
      ORDER BY repo, filename`)).recordset;
  await ledgerPool.close();

  // Every object name any ledgered migration claims, gathered first so the
  // existence questions are TWO round trips rather than one per object.
  const files = new Map();       // "repo/filename" -> { text, dir }
  const wanted = { tables: new Set(), modules: new Set(), columns: new Set() };
  const claims = [];             // { repo, filename, applied_at, applied_by, tables, modules, columns }
  const noFile = [];

  for (const r of rows) {
    const dir = REPOS[r.repo];
    const abs = dir ? path.join(dir, r.filename) : null;
    if (!abs || !fs.existsSync(abs)) { noFile.push(r); continue; }
    const text = fs.readFileSync(abs, 'utf8');
    files.set(`${r.repo}/${r.filename}`, { text, dir });
    const found = objectsCreatedBy(text);
    for (const t of found.tables) wanted.tables.add(t.toLowerCase());
    for (const m of found.modules) wanted.modules.add(m.toLowerCase());
    for (const c of found.columns) wanted.columns.add(c.toLowerCase());
    claims.push({ ...r, ...found });
  }

  // PRESENT ANYWHERE ON THE SERVER. Two databases hold our schemas and a
  // migration's objects land in whichever one its repo writes to.
  const existingObjects = new Map();   // name -> [databases]
  const existingColumns = new Map();
  for (const db of DBS) {
    const pool = await prodPool(db);
    for (const x of (await pool.request().query(
      `SELECT LOWER(s.name + '.' + o.name) AS n
         FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id`)).recordset) {
      existingObjects.set(x.n, [...(existingObjects.get(x.n) || []), db]);
    }
    for (const x of (await pool.request().query(
      `SELECT LOWER(s.name + '.' + o.name + '.' + c.name) AS n
         FROM sys.columns c
         JOIN sys.objects o ON o.object_id = c.object_id
         JOIN sys.schemas s ON s.schema_id = o.schema_id`)).recordset) {
      existingColumns.set(x.n, [...(existingColumns.get(x.n) || []), db]);
    }
    await pool.close();
  }

  // Anything missing — and then, was it dropped later on purpose?
  const byRepo = new Map();
  for (const c of claims) {
    const missingTables = c.tables.filter((t) => !existingObjects.has(t.toLowerCase()));
    const missingModules = c.modules.filter((m) => !existingObjects.has(m.toLowerCase()));
    const missingColumns = c.columns.filter((col) => !existingColumns.has(col.toLowerCase()));
    const own = files.get(`${c.repo}/${c.filename}`)?.text || '';
    if (!missingTables.length && !missingModules.length && !missingColumns.length) continue;

    const later = [...files.entries()]
      .filter(([k]) => k.startsWith(`${c.repo}/`) && num(k.split('/')[1]) > num(c.filename))
      .map(([, v]) => v.text);

    const verdict = (name, isColumn) => {
      const dropped = later.some((t) => (isColumn ? columnDroppedBy(t, name) : droppedBy(t, name)));
      return { name, dropped, conditional: guardedAsOptional(own, name) };
    };

    const entry = {
      repo: c.repo,
      filename: c.filename,
      applied_at: c.applied_at,
      applied_by: c.applied_by,
      tables: missingTables.map((t) => verdict(t, false)),
      modules: missingModules.map((m) => verdict(m, false)),
      columns: missingColumns.map((col) => verdict(col, true)),
    };
    if (!byRepo.has(c.repo)) byRepo.set(c.repo, []);
    byRepo.get(c.repo).push(entry);
  }

  const report = render({ rows, claims, noFile, byRepo, dbs: DBS });
  if (OUT) {
    fs.writeFileSync(OUT, report, 'utf8');
    console.log(`written: ${OUT}`);
  } else {
    console.log(report);
  }
}

function render({ rows, claims, noFile, byRepo, dbs }) {
  const L = [];
  const unexplained = [];
  for (const [, list] of byRepo) {
    for (const e of list) {
      const holes = [...e.tables, ...e.modules, ...e.columns].filter((x) => !x.dropped && !x.conditional);
      if (holes.length) unexplained.push({ ...e, holes });
    }
  }

  L.push(`# Production migration-ledger audit — ${new Date().toISOString().slice(0, 10)}`);
  L.push('');
  L.push('READ-ONLY. Every statement behind this report is a SELECT.');
  L.push('');
  L.push(`Databases: ${dbs.map((d) => `\`${d}\``).join(' + ')} on the production server. An object is PRESENT if it is in either.`);
  L.push(`Ledger rows: **${rows.length}**. Rows whose migration file was found locally: **${claims.length}**.`);
  L.push('');
  L.push('## What this checks');
  L.push('');
  L.push('For every row in `db.schema_migrations`, read the migration file it names,');
  L.push('take the tables, views, procedures, functions and columns that file creates,');
  L.push('and ask production whether they are there. Anything missing is then checked');
  L.push('against every LATER migration in the same repo: an object created and then');
  L.push('deliberately dropped is not a hole, and is reported separately.');
  L.push('');
  L.push('This is the check that would have caught `LUMEN-API/041_leadgen_inbox_visit`');
  L.push('and `044_leadgen_worker_registry` — recorded as applied, with neither table');
  L.push('ever created (§6).');
  L.push('');

  L.push('## Findings — ledger rows whose objects are NOT in production');
  L.push('');
  if (!unexplained.length) {
    L.push('**None.** Every object every ledgered migration creates is present, or was');
    L.push('dropped by a later migration on purpose.');
  } else {
    L.push(`**${unexplained.length}** row(s), across ${new Set(unexplained.map((u) => u.repo)).size} repo(s).`);
    L.push('');
    L.push('| repo | migration | applied | by | missing |');
    L.push('|---|---|---|---|---|');
    for (const u of unexplained) {
      const when = u.applied_at ? new Date(u.applied_at).toISOString().slice(0, 10) : '(no date)';
      L.push(`| ${u.repo} | \`${u.filename}\` | ${when} | ${u.applied_by || '(none)'} | ${u.holes.map((h) => `\`${h.name}\``).join(', ')} |`);
    }
  }
  L.push('');

  const explained = [];
  for (const [, list] of byRepo) {
    for (const e of list) {
      const d = [...e.tables, ...e.modules, ...e.columns].filter((x) => x.dropped || x.conditional);
      if (d.length) explained.push({ ...e, d });
    }
  }
  L.push('## Explained — not holes');
  L.push('');
  L.push('`conditional` = the migration guards the statement on the object already');
  L.push('existing and says so; it never claimed to create it. `dropped later` = a');
  L.push('later migration in the same repo removes it on purpose.');
  L.push('');
  if (!explained.length) L.push('None.');
  else {
    L.push('| repo | migration | object | why |');
    L.push('|---|---|---|---|');
    for (const e of explained) {
      for (const x of e.d) {
        L.push(`| ${e.repo} | \`${e.filename}\` | \`${x.name}\` | ${x.dropped ? 'dropped later' : 'conditional'} |`);
      }
    }
  }
  L.push('');

  L.push('## Ledger rows with no migration file in the local checkout');
  L.push('');
  L.push('Not necessarily wrong — a renamed or deleted file leaves a row behind (§6');
  L.push('already records that shape) — but each is a row nothing can verify.');
  L.push('');
  if (!noFile.length) L.push('None.');
  else {
    L.push('| repo | filename | applied | by |');
    L.push('|---|---|---|---|');
    for (const r of noFile) {
      const when = r.applied_at ? new Date(r.applied_at).toISOString().slice(0, 10) : '(no date)';
      L.push(`| ${r.repo} | \`${r.filename}\` | ${when} | ${r.applied_by || '(none)'} |`);
    }
  }
  L.push('');
  L.push('## How to re-run');
  L.push('');
  L.push('```');
  L.push('cd C:\\dev\\iadm\\arion-api        # any checkout with node_modules + az login');
  L.push('node scripts/_prod_ledger_audit.mjs --out <path>.md');
  L.push('```');
  L.push('');
  return L.join('\n');
}

/**
 * ONLY when a person runs it. Importing this module — a unit test reading the
 * extractor, say — must never open a connection to PRODUCTION. `npm test`
 * reaching another process is the D-71 defect; `npm test` reaching production
 * is that defect with the stakes turned up.
 */
const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedDirectly) {
  main().catch((err) => {
    console.error('audit failed:', err.message);
    process.exit(1);
  });
}
