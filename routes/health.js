import express from "express";
import { withPlatformPool } from "../db/platformPool.js";
import { withServicesPool } from "../db/servicesPool.js";

const router = express.Router();

/**
 * Probe one database. NEVER throws: it returns the verdict, so one dead pool
 * cannot hide the state of the other. (The old route awaited both inside one
 * try — and resolved BOTH pools before querying either — so a platform failure
 * reported nothing at all about services, and the error path named neither.)
 *
 * Goes through withXPool, so a probe is also the cheapest ELOGIN recovery
 * trigger the app has: a refused managed-identity token gets the pool rebuilt
 * and the probe retried once, exactly as on a request path.
 */
export async function probe(withPool) {
  try {
    await withPool((pool) => pool.request().query("SELECT 1 AS ok;"));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      // The CODE is the point: 'ELOGIN' says "the token was refused", which is
      // a different incident from ETIMEOUT or ESOCKET and needs a different
      // response. Reporting only a message made 2026-09-16 a three-hour guess.
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
    // NAMED on every path, healthy or not. On 2026-09-16 oliver-api's error
    // path said nothing about either database, so a reader could not tell a
    // refused token from an unreachable server without opening the app's log.
    platformDb: platform.ok ? "ok" : "error",
    servicesDb: services.ok ? "ok" : "error",
    ...(platform.ok ? {} : { platformDbCode: platform.code, platformDbError: platform.message }),
    ...(services.ok ? {} : { servicesDbCode: services.code, servicesDbError: services.message }),
    timestampUtc: now.toISOString(),
  };
  // `details` kept for readers pinned to the old error shape, now alongside the
  // per-database fields.
  if (!healthy) body.details = platform.ok ? services.message : platform.message;

  // 503, not 500: this is "a dependency is unavailable", which is what a load
  // balancer, an uptime check and App Service auto-heal all need to read.
  // SAFE TO DO — checked before changing it (2026-09-16):
  //   · azure-pipelines.yml has NO post-deploy health gate (its only post-deploy
  //     step is the migration runner), so no deploy can fail on this;
  //   · `az webapp show -n app-arion-api-prod -g rg-apps-prod` reports
  //     healthCheckPath=null and autoHealEnabled=false, so App Service is not
  //     routing or restarting on this endpoint today either.
  // If App Service Health Check is later turned on, a 503 is exactly the signal
  // it needs to pull a poisoned instance out of rotation.
  return { status: healthy ? 200 : 503, body };
}

router.get("/", async (req, res) => {
  // Both probes always run — see probe().
  const [platform, services] = await Promise.all([probe(withPlatformPool), probe(withServicesPool)]);
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
