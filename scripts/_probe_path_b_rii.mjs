#!/usr/bin/env node
// Probe Path B end-to-end state for Rolling In It LLC.
// Queries:
//  1) core.tenants — tenant exists, owner email, signup_product
//  2) core.tenant_invitations — pending CIAM invitation present
//  3) oliver.tenant_onboarding_state — onboarded_by_founder, finished_at,
//     welcome_token, welcome_token_expires_at, welcome_sent_at,
//     client_first_login_at, state_json sample fields
//  4) lumen.campaign — Welcome campaign rows written by SPARK pipeline
//  5) lumen.campaign_recipient — the recipient row
//  6) lumen.email_event — actual ACS send rows for the welcome
//
// Treats Path B as PASS only when all 4 stages are wired correctly.
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

const TENANT_ID = '12839687-67FA-4144-A152-1219D1A64901';

async function getToken() {
  const cred = new DefaultAzureCredential();
  const tok = await cred.getToken('https://database.windows.net/.default');
  return tok.token;
}

async function connect(database) {
  const accessToken = await getToken();
  return sql.connect({
    server: 'sql-iadm-prod-cus.database.windows.net',
    database,
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-access-token', options: { token: accessToken } },
  });
}

function fmt(v) {
  if (v === null || v === undefined) return '(null)';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 240);
  return String(v).slice(0, 240);
}

async function main() {
  console.log('=== Path B probe — Rolling In It LLC ===');
  console.log('tenant_id:', TENANT_ID);

  // --- iadm_platform: core.tenants + core.tenant_invitations + core.users
  const platform = await connect('iadm_platform');
  try {
    const t = await platform.request()
      .input('tid', sql.UniqueIdentifier, TENANT_ID)
      .query(`
        SELECT tenant_id, business_name, slug,
               saas_stripe_customer_id, saas_stripe_subscription_id,
               signup_product, subscription_tier, created_at
          FROM core.tenants
         WHERE tenant_id = @tid;
      `);
    console.log('\n[1] core.tenants');
    if (t.recordset.length === 0) { console.log('  NO ROW'); }
    else {
      const r = t.recordset[0];
      for (const k of Object.keys(r)) console.log('  ', k.padEnd(34), fmt(r[k]));
    }

    const inv = await platform.request()
      .input('tid', sql.UniqueIdentifier, TENANT_ID)
      .query(`
        SELECT tenant_invitation_id, email, role_key, status,
               invited_at, accepted_at, invited_by
          FROM core.tenant_invitations
         WHERE tenant_id = @tid
         ORDER BY invited_at DESC;
      `);
    console.log('\n[2] core.tenant_invitations (count =', inv.recordset.length, ')');
    for (const r of inv.recordset) {
      console.log('  ', fmt(r.email), 'status=', r.status,
        'role=', r.role_key, 'invited=', fmt(r.invited_at),
        'accepted=', fmt(r.accepted_at));
    }

    const tu = await platform.request()
      .input('tid', sql.UniqueIdentifier, TENANT_ID)
      .query(`
        SELECT tu.user_id, u.email
          FROM core.tenant_users tu
          JOIN core.users u ON u.user_id = tu.user_id
         WHERE tu.tenant_id = @tid;
      `);
    console.log('\n[2b] core.tenant_users (count =', tu.recordset.length, ')');
    for (const r of tu.recordset) {
      console.log('  ', fmt(r.email), 'user_id=', fmt(r.user_id));
    }
  } finally {
    await platform.close();
  }

  // --- iadm_services: oliver.tenant_onboarding_state + lumen.*
  const services = await connect('iadm_services');
  try {
    const os = await services.request()
      .input('tid', sql.UniqueIdentifier, TENANT_ID)
      .query(`
        SELECT tenant_id, step_index, section_id, last_saved_at,
               onboarded_by_founder, onboarded_by_user_id, finished_at,
               welcome_token, welcome_token_expires_at, welcome_sent_at,
               client_first_login_at,
               LEN(state_json) AS state_len
          FROM oliver.tenant_onboarding_state
         WHERE tenant_id = @tid;
      `);
    console.log('\n[3] oliver.tenant_onboarding_state');
    if (os.recordset.length === 0) { console.log('  NO ROW'); }
    else {
      const r = os.recordset[0];
      for (const k of Object.keys(r)) console.log('  ', k.padEnd(34), fmt(r[k]));
    }

    const cmp = await services.request()
      .input('tid', sql.NVarChar, TENANT_ID)
      .query(`
        SELECT TOP 10 id, name, type, subject, from_name, from_email,
               status, sent_at, total_recipients, total_sent
          FROM lumen.campaign
         WHERE tenant_id = @tid
           AND name LIKE 'Welcome%'
         ORDER BY sent_at DESC;
      `);
    console.log('\n[4] lumen.campaign (Welcome — *) count =', cmp.recordset.length);
    for (const r of cmp.recordset) {
      console.log('  id=', r.id, 'name=', fmt(r.name), 'status=', r.status,
        'sent_at=', fmt(r.sent_at), 'recipients=', r.total_recipients);
    }

    if (cmp.recordset.length > 0) {
      const cid = cmp.recordset[0].id;
      const rcp = await services.request()
        .input('cid', sql.Int, cid)
        .query(`
          SELECT TOP 5 cr.id, cr.contact_id, c.email, cr.status, cr.sent_at
            FROM lumen.campaign_recipient cr
            LEFT JOIN lumen.contact c ON c.id = cr.contact_id
           WHERE cr.campaign_id = @cid
           ORDER BY cr.sent_at DESC;
        `);
      console.log('\n[5] lumen.campaign_recipient for latest welcome campaign id=', cid,
        'count =', rcp.recordset.length);
      for (const r of rcp.recordset) {
        console.log('  contact_id=', r.contact_id, 'email=', fmt(r.email),
          'status=', r.status, 'sent_at=', fmt(r.sent_at));
      }
    }

    const ev = await services.request()
      .input('tid', sql.NVarChar, TENANT_ID)
      .query(`
        SELECT TOP 10 id, contact_id, campaign_id, message_id, event_type,
               occurred_at
          FROM lumen.email_event
         WHERE tenant_id = @tid
         ORDER BY occurred_at DESC;
      `);
    console.log('\n[6] lumen.email_event (latest 10) count =', ev.recordset.length);
    for (const r of ev.recordset) {
      console.log('  evt=', r.event_type, 'campaign_id=', r.campaign_id,
        'mid=', fmt(r.message_id), 'at=', fmt(r.occurred_at));
    }
  } finally {
    await services.close();
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e?.stack || e); process.exit(1); });
