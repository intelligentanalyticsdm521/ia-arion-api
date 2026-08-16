// Shared prod-target guard for the sandbox setup scripts.
//
// WHY THIS EXISTS: arion-api/.env pins SERVICES_SQL_SERVER=localhost,1433 and
// db/platformPool.js calls dotenv.config(). Because servicesPool.js prefers
// SERVICES_SQL_SERVER over SQL_SERVER, exporting SQL_SERVER alone is silently
// ignored and every "prod" write lands in the local Docker container instead.
// That is exactly how the 2026-08-16 sandbox row got created in the wrong DB.
//
// Gate on the PRESENCE of a production marker, never the absence of a dev one.
export async function assertProd(pool) {
  const r = await pool.request().query(
    `SELECT DB_NAME() db, @@SERVERNAME srv, SUSER_SNAME() login`);
  const { db, srv, login } = r.recordset[0];
  const isProd = /^sql-iadm-prod/i.test(String(srv)) && String(login).includes('@');
  console.log(`target: db=${db} server=${srv} login=${login} -> ${isProd ? 'PROD' : 'NOT PROD'}`);
  if (!isProd) {
    throw new Error(
      `Refusing to run: expected Azure prod (sql-iadm-prod*, AAD login) but got server='${srv}' login='${login}'. ` +
      `Run with SERVICES_SQL_SERVER=sql-iadm-prod-cus.database.windows.net SQL_USER= SQL_PASSWORD=`);
  }
  return { db, srv, login };
}
