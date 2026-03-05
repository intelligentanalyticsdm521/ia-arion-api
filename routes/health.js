import express from "express";
import sql from "mssql";
import { getPlatformPool } from "../db/platformPool.js";
import { getServicesPool } from "../db/servicesPool.js";

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const platformPool = await getPlatformPool();
    const servicesPool = await getServicesPool();

    await platformPool.request().query("SELECT 1 AS ok;");
    await servicesPool.request().query("SELECT 1 AS ok;");

    return res.status(200).json({
      status: "ok",
      service: "arion-api",
      platformDb: "ok",
      servicesDb: "ok",
      timestampUtc: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[health] error:", err);
    return res.status(500).json({
      status: "error",
      service: "arion-api",
      details: err.message,
      timestampUtc: new Date().toISOString(),
    });
  }
});

export default router;
