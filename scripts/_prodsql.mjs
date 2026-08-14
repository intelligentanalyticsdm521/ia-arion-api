/**
 * _prodsql.mjs — shared read helper for prod Azure SQL from a dev machine.
 *
 * Prod SQL has no password in Key Vault: the App Services connect with managed
 * identity. From here the equivalent is an Entra access token for Brandon's own
 * account, which is the SQL Entra admin.
 *
 * Tokens come from `az account get-access-token`, which still works even while
 * `az keyvault` / `az sql` fail TLS against the AVG Web Shield root cert
 * (Python/OpenSSL 3 rejects it: "Basic Constraints of CA cert not marked
 * critical"). Node's TLS stack accepts the same cert, so anything routed
 * through Node connects fine.
 *
 * import { prodPool } from './_prodsql.mjs'
 */
import { execSync } from 'node:child_process';
import sql from 'mssql';

const SERVER = process.env.PROD_SQL_SERVER || 'sql-iadm-prod-cus.database.windows.net';

export async function prodPool(database = 'iadm_services') {
  const token = execSync(
    'az account get-access-token --resource https://database.windows.net --query accessToken -o tsv',
    { encoding: 'utf8', maxBuffer: 10 << 20 }
  ).trim();

  return sql.connect({
    server: SERVER,
    database,
    options: { encrypt: true, trustServerCertificate: false },
    authentication: { type: 'azure-active-directory-access-token', options: { token } },
    connectionTimeout: 30000,
    requestTimeout: 120000,
  });
}
