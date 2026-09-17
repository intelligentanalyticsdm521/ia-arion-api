// routes/health.js — /health has to say WHICH database is unhappy and WHY.
//
// ADDED 2026-09-17, out of the 2026-09-16 and 2026-09-17 production incidents:
// the SQL server refused ~85% of NEW managed-identity logins to iadm_services
// while iadm_platform kept answering. The old route awaited both pools inside
// ONE try, so a single failure reported nothing about the other database, and
// the error body named neither — which is how a multi-hour P0 was read for
// hours as "both databases are down" when only one was refusing logins.
import express from "express";
import { getPlatformPool } from "../db/platformPool.js";
import { getServicesPool } from "../db/servicesPool.js";

const router = express.Router();

/**
 * Probe one database. NEVER throws: it returns the verdict, so one dead pool
 * cannot hide the state of the other.
 */
export async function probe(getPool) {
  try {
    const pool = await getPool();
    await pool.request().query("SELECT 1 AS ok;");
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      // The CODE is the point: 'ELOGIN' says "the login was refused", which is a
      // different incident from ETIMEOUT or ESOCKET and needs a different fix.
      code: String(err?.code || err?.originalError?.code || err?.number || "UNKNOWN"),
      message: String(err?.message || err),
    };
  }
}

/**
 * Turn two probe verdicts into the response. Pure — the status code and every
 * field are decided here, so they can be pinned without a database.
 */
export function buildHealthBody(platform, services, now = new Date()) {
  const healthy = Boolean(platform.ok && services.ok);
  const body = {
    status: healthy ? "ok" : "error",
    service: "arion-api",
    // NAMED on every path, healthy or not, with the message — never null, never
    // simply absent, so a reader can tell WHICH database is refusing.
    platformDb: platform.ok ? "ok" : "error",
    servicesDb: services.ok ? "ok" : "error",
    ...(platform.ok ? {} : { platformDbCode: platform.code, platformDbError: platform.message }),
    ...(services.ok ? {} : { servicesDbCode: services.code, servicesDbError: services.message }),
    timestampUtc: now.toISOString(),
  };
  // `details` kept for readers pinned to the old error shape.
  if (!healthy) body.details = platform.ok ? services.message : platform.message;

  // 503, not 500: this is "a dependency is unavailable". SAFE TO DO — checked
  // before changing it (2026-09-17): `az webapp show -n app-arion-api-prod
  // -g rg-apps-prod` reports healthCheckPath=null and autoHealEnabled=false, so
  // nothing routes or restarts on this endpoint today. If App Service Health
  // Check is ever turned on, 503 is exactly the signal it needs.
  return { status: healthy ? 200 : 503, body };
}

router.get("/", async (req, res) => {
  // Both probes always run — see probe().
  const [platform, services] = await Promise.all([probe(getPlatformPool), probe(getServicesPool)]);
  const { status, body } = buildHealthBody(platform, services);
  if (status !== 200) {
    console.error(
      `[health] platformDb=${body.platformDb}${platform.ok ? "" : `(${platform.code})`}`
      + ` servicesDb=${body.servicesDb}${services.ok ? "" : `(${services.code})`}`
      + ` — ${body.details}`
    );
  }
  return res.status(status).json(body);
});

export default router;
