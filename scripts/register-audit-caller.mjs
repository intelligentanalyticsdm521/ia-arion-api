#!/usr/bin/env node
/**
 * register-audit-caller.mjs — let one agency's chat workflow call the website
 * check as its custom action (contract §E.1, §I step 2).
 *
 * The agency adds the tool in SPARK → Leads → Lead sources → Website chat →
 * Your own tools, which shows a key id (wfk_…) and, once, the secret. This
 * script stores the same pair here so both sides can sign and verify. Running
 * it again with the same --key-id replaces the secret ("Replace the secret").
 *
 *   node scripts/register-audit-caller.mjs --label "<agency name>" --owner-tenant <business id> \
 *        --key-id wfk_… --secret-stdin [--daily-limit 50] [--confirm-server <sql host>]
 *
 * The secret is read from standard input (never an argument, so it stays out of
 * shell history) and stored encrypted under AUDIT_CALLER_KEY. It is never
 * printed. Against any SQL server other than localhost the script refuses
 * unless --confirm-server names that server exactly.
 */
import 'dotenv/config';
import { getServicesPool } from '../db/servicesPool.js';
import { upsertCaller, getCallerByKeyId, callerKey } from '../lib/audit/callers.js';

const argv = process.argv.slice(2);
const arg = (n, d = null) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stop(sentence) {
  console.error(sentence);
  process.exit(1);
}

const label = arg('label');
const owner = arg('owner-tenant');
const keyId = arg('key-id');
const dailyLimit = Number(arg('daily-limit', '50'));
if (!label) stop('Give the agency a name with --label "…".');
if (!owner || !GUID_RE.test(owner)) stop('Give the business that owns these checks with --owner-tenant <id>.');
if (!keyId || !/^wfk_[A-Za-z0-9_-]{4,36}$/.test(keyId)) stop('Give the key id the tool screen showed (it starts wfk_) with --key-id.');
if (!argv.includes('--secret-stdin')) stop('Pass --secret-stdin and paste the secret on standard input.');
if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 1000) stop('--daily-limit must be a whole number from 1 to 1000.');

try { callerKey(); } catch (err) { stop(`${err.message} Set it before registering a tool.`); }

const server = String(process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER || '').split(',')[0].trim();
const isLocal = /^(localhost|127\.0\.0\.1|\(local\))$/i.test(server);
if (!isLocal && arg('confirm-server') !== server) {
  stop(`This would write to ${server || 'an unknown server'}. Re-run with --confirm-server ${server} if that is what you mean.`);
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const secret = Buffer.concat(chunks).toString('utf8').trim();
if (secret.length < 16) stop('The secret on standard input is missing or too short.');

const pool = await getServicesPool();
const before = await getCallerByKeyId(pool, keyId);
const callerId = await upsertCaller(pool, { keyId, label, ownerTenantId: owner, secret, dailyLimit, createdBy: 'register-audit-caller.mjs' });
console.log(`${before ? 'Replaced the secret for' : 'Registered'} ${label} (key ${keyId}) on ${server}. caller_id=${callerId}, daily limit ${dailyLimit}.`);
process.exit(0);
