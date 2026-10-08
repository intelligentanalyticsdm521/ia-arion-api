// scripts/dev/gbp-fake.mjs — put a fake Google review on a dev business.
//
// ARGUS employees, phase 1 (CONTRACT_ARGUS_EMPLOYEES_PHASE1 §G.5).
//
//   node scripts/dev/gbp-fake.mjs --tenant <business id> --site <site id> \
//        --add-review --stars 2 --text "Late twice and the edges were missed." [--name "Sam"]
//   node scripts/dev/gbp-fake.mjs --tenant <id> --site <id> --show
//
// Writes the review into the file named by ARION_GBP_FAKE_FILE (the arion
// .env), under the site's location name. lib/gbpFake.js then serves the file
// instead of Google, but only on a machine where WEBSITE_SITE_NAME is unset
// (never on an App Service).
//
// A SITE THAT IS ALREADY CONNECTED IS LEFT ALONE. A dev site can hold a real
// Google connection; overwriting its token would lose it. Its own location
// name is used as the key in the fake file, and nothing on the row changes.
// Only a site with no connection is marked connected to the fake profile:
// gbp_connected = 1, gbp_oauth_token_ref = 'dev-fake',
// gbp_location_name = 'locations/dev-fake'.
//
// LOCAL ONLY: refuses a SQL server that is not this machine. Nothing in here
// knows a business; the business and site are the command line.

import 'dotenv/config';
import fs from 'node:fs';
import sql from 'mssql';
import { getServicesPool } from '../../db/servicesPool.js';
import { fakeEnabled } from '../../lib/gbpFake.js';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCATION = 'locations/dev-fake';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : (process.argv[i + 1] ?? '');
}
const has = (name) => process.argv.includes(`--${name}`);

function die(msg) { console.error(msg); process.exit(1); }

const server = String(process.env.SQL_SERVER || process.env.SERVICES_SQL_SERVER || '');
if (process.env.WEBSITE_SITE_NAME) die('Refusing: this looks like an App Service (WEBSITE_SITE_NAME is set).');
if (!/^(localhost|127\.0\.0\.1|\.|\(local\))([\\,].*)?$/i.test(server)) die(`Refusing: SQL server "${server}" is not this machine.`);
const file = String(process.env.ARION_GBP_FAKE_FILE || '').trim();
if (!file) die('Set ARION_GBP_FAKE_FILE in the arion .env to a scratch file path first.');
if (!fakeEnabled()) die('The fake is not enabled on this machine (both locks are needed).');

const tenant = arg('tenant');
const site = arg('site');
if (!GUID.test(String(tenant))) die('--tenant <business id> is required');
if (!GUID.test(String(site))) die('--site <site id> is required');

const pool = await getServicesPool();
const cur = await pool.request()
  .input('t', sql.UniqueIdentifier, tenant)
  .input('s', sql.UniqueIdentifier, site)
  .query('SELECT gbp_connected, gbp_oauth_token_ref, gbp_location_name FROM arion.site WHERE tenant_id = @t AND site_id = @s');
const row = cur.recordset[0];
if (!row) die("That site is not this business's, so nothing was written.");
const connected = (row.gbp_connected === true || row.gbp_connected === 1) && row.gbp_oauth_token_ref && row.gbp_location_name;
const location = connected ? String(row.gbp_location_name) : LOCATION;
if (!connected) {
  await pool.request()
    .input('t', sql.UniqueIdentifier, tenant)
    .input('s', sql.UniqueIdentifier, site)
    .input('loc', sql.NVarChar(200), LOCATION)
    .query(`UPDATE arion.site SET gbp_connected = 1, gbp_oauth_token_ref = 'dev-fake', gbp_location_name = @loc
             WHERE tenant_id = @t AND site_id = @s`);
  console.log(`site ${site} now reads its reviews from the fake profile`);
} else {
  console.log(`site ${site} is already connected; its connection is left alone and the fake file uses its location name`);
}

const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8') || '{}') : {};
const loc = all[location] || (all[location] = { reviews: [], replies: [] });

if (has('add-review')) {
  const stars = Number(arg('stars'));
  if (!(stars >= 1 && stars <= 5)) die('--stars 1..5 is required with --add-review');
  const text = arg('text') || '';
  const id = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  loc.reviews.push({ reviewId: id, reviewerName: arg('name') || 'A customer', starRating: stars, comment: text, createTime: new Date().toISOString() });
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
  console.log(`added review ${id} (${stars} stars) to ${file}`);
}

if (has('show')) console.log(JSON.stringify(loc, null, 2));
await pool.close?.();
process.exit(0);
