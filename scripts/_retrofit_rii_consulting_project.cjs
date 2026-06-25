const { DefaultAzureCredential } = require('@azure/identity');
const sql = require('mssql');

const RII_TENANT = '12839687-67FA-4144-A152-1219D1A64901';   // Rolling In It client tenant
const IA_TENANT  = '8C9527B9-8999-4B31-A306-F3D4CCC39FBD';   // IA founder tenant (owns the consulting record)

(async () => {
  const cred = new DefaultAzureCredential();
  const tok = await cred.getToken('https://database.windows.net/.default');
  const pool = await sql.connect({
    server: 'sql-iadm-prod-cus.database.windows.net',
    database: 'iadm_services',
    authentication: { type: 'azure-active-directory-access-token', options: { token: tok.token } },
    options: { encrypt: true }
  });

  // 1. Look up the Rolling In It lumen.contact id (Nathan).
  const contactQ = await pool.request().query(`
    SELECT TOP 1 id, first_name, last_name, email
      FROM lumen.contact
     WHERE email = 'rollinginitllc@gmail.com'
        OR (first_name = 'Nathan' AND last_name LIKE 'Dannen%')
     ORDER BY id DESC
  `);
  const contact = contactQ.recordset[0];
  if (!contact) { console.error('FATAL: no lumen.contact row for Nathan / Rolling In It'); process.exit(1); }
  console.log(`Found contact id=${contact.id} (${contact.first_name} ${contact.last_name} <${contact.email}>)`);

  // 2. Look up the onboarding_consulting category + its milestone template.
  const catQ = await pool.request().query(`
    SELECT category_id, name, milestone_template_json
      FROM consulting.project_category
     WHERE slug = 'onboarding_consulting'
  `);
  const cat = catQ.recordset[0];
  if (!cat) { console.error('FATAL: no onboarding_consulting category seeded'); process.exit(1); }
  const milestones = JSON.parse(cat.milestone_template_json);
  console.log(`Found category ${cat.name} with ${milestones.length} milestones`);

  // 3. Idempotency: refuse to create a 2nd project if one already exists.
  const existing = await pool.request().query(`
    SELECT project_id, name, status FROM consulting.project
     WHERE linked_tenant_id = '${RII_TENANT}' AND category_id = '${cat.category_id}'
  `);
  if (existing.recordset.length) {
    console.log(`Project already exists: ${existing.recordset[0].project_id} (${existing.recordset[0].name}, status=${existing.recordset[0].status})`);
    console.log('Skipping insert. Run again with --force-recreate to override (not implemented).');
    await pool.close();
    return;
  }

  // 4. Insert the project. status='completed' since RII is fully onboarded.
  // started_at + completed_at use the onboarding date (2026-06-24).
  const projectId = require('crypto').randomUUID();
  const onboardedAt = '2026-06-24T17:00:00Z';
  const completedAt = '2026-06-24T22:00:00Z';

  await pool.request()
    .input('pid',          sql.UniqueIdentifier, projectId)
    .input('tenantId',     sql.UniqueIdentifier, IA_TENANT)
    .input('categoryId',   sql.UniqueIdentifier, cat.category_id)
    .input('linkedTenant', sql.UniqueIdentifier, RII_TENANT)
    .input('contactId',    sql.Int,              contact.id)
    .input('startedAt',    sql.DateTime2,        onboardedAt)
    .input('completedAt',  sql.DateTime2,        completedAt)
    .query(`
      INSERT INTO consulting.project (
        project_id, tenant_id, category_id, linked_tenant_id, lumen_contact_id,
        name, description, status, started_at, completed_at, internal_notes
      ) VALUES (
        @pid, @tenantId, @categoryId, @linkedTenant, @contactId,
        'Onboarding — Rolling In It',
        'ARION Pro + SEO Essentials + OLIVER Pro + SPARK 10k + SPARK Pro + SPARK Leads Essentials. Retrofitted 2026-06-25 — work completed 2026-06-24 manually before F1 project hub existed.',
        'completed', @startedAt, @completedAt,
        'Retrofitted from pre-F1 onboarding. Friends & Family 100 coupon (kgzALoKz). All milestones marked complete at retrofit time.'
      )
    `);
  console.log(`Inserted project ${projectId}`);

  // 5. Insert milestones — all complete.
  for (let i = 0; i < milestones.length; i++) {
    const m = milestones[i];
    const mid = require('crypto').randomUUID();
    await pool.request()
      .input('mid',          sql.UniqueIdentifier, mid)
      .input('pid',          sql.UniqueIdentifier, projectId)
      .input('sortOrder',    sql.Int,              i + 1)
      .input('name',         sql.NVarChar(200),    m.name)
      .input('description',  sql.NVarChar(sql.MAX), m.description || null)
      .input('startedAt',    sql.DateTime2,        onboardedAt)
      .input('completedAt',  sql.DateTime2,        completedAt)
      .query(`
        INSERT INTO consulting.project_milestone (
          milestone_id, project_id, sort_order, name, description,
          status, started_at, completed_at
        ) VALUES (
          @mid, @pid, @sortOrder, @name, @description,
          'complete', @startedAt, @completedAt
        )
      `);
    console.log(`  milestone ${i + 1}/${milestones.length}: ${m.name} (complete)`);
  }

  // 6. Verify
  const verify = await pool.request().query(`
    SELECT p.project_id, p.name, p.status, p.completed_at,p.tenant_id,
           (SELECT COUNT(*) FROM consulting.project_milestone m WHERE m.project_id = p.project_id) AS milestone_count
      FROM consulting.project p
     WHERE p.linked_tenant_id = '${RII_TENANT}'
  `);
  console.log('\n=== VERIFY ===');
  verify.recordset.forEach(r => console.log(`  ${r.project_id} | ${r.name} | ${r.status} | completed_at=${r.completed_at} | ${r.milestone_count} milestones`));

  await pool.close();
})().catch(e => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1); });
