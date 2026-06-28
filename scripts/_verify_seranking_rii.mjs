import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';
const cred = new DefaultAzureCredential();
const tok = await cred.getToken('https://database.windows.net/.default');
const cfg = (db) => ({ server: 'sql-iadm-prod-cus.database.windows.net', database: db, options: { encrypt: true }, authentication: { type: 'azure-active-directory-access-token', options: { token: tok.token } } });

const sp = await sql.connect(cfg('iadm_services'));

const site = await sp.request().query(`
  SELECT site_id, tenant_id, domain, arion_tier, seo_addon_tier,
         se_ranking_project_id, se_ranking_audit_id
  FROM arion.site WHERE site_id = '4E3B2AE2-4133-4813-84AA-4196661ED6F9'`);
console.log('arion.site row (post-update):');
console.log(JSON.stringify(site.recordset[0], null, 2));

const ic = await sp.request().query(`
  SELECT tic.tenant_integration_config_id, tic.tenant_id, p.provider_code,
         p.provider_name, ia.account_name, tic.status, tic.config_json,
         tic.created_at, tic.updated_at
  FROM integrations.tenant_integration_configs tic
  JOIN integrations.providers p ON p.provider_id = tic.provider_id
  JOIN integrations.integration_accounts ia ON ia.integration_account_id = tic.integration_account_id
  WHERE tic.tenant_id = '12839687-67FA-4144-A152-1219D1A64901'`);
console.log('\nintegrations.tenant_integration_configs row:');
for (const r of ic.recordset) {
  const cj = JSON.parse(r.config_json);
  console.log({
    id: r.tenant_integration_config_id,
    provider: `${r.provider_code} (${r.provider_name})`,
    account: r.account_name,
    status: r.status,
    project_id: cj.project_id,
    audit_id: cj.audit_id,
    tier: cj.tier,
    engines: cj.engines,
    site_engine_ids: cj.site_engine_ids,
  });
}

await sp.close();

// Verify SE Ranking project state via API
const SR_KEY = '5f7bb47c36f37ec1edce20ccdda941da1ba2dea5';
const proj = await fetch('https://api4.seranking.com/sites', {
  headers: { Authorization: `Token ${SR_KEY}` }
}).then(r => r.json());
const rii = proj.find(p => p.id === 12497786);
console.log('\nSE Ranking project 12497786 state:');
console.log({
  id: rii?.id,
  name: rii?.name,
  title: rii?.title,
  is_active: rii?.is_active,
  keyword_count: rii?.keyword_count,
  check_freq: rii?.check_freq,
});

const kws = await fetch('https://api4.seranking.com/sites/12497786/keywords', {
  headers: { Authorization: `Token ${SR_KEY}` }
}).then(r => r.json());
console.log(`\nSE Ranking keywords on project (n=${kws.length}):`);
for (const k of kws) console.log(`  ${k.id} | "${k.name}" | engines=${(k.site_engine_ids||[]).join(',')}`);
