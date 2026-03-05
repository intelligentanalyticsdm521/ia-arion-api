// middleware/requireAuth.js
// Global token validation for ONE Entra External ID tenant.
//
// ✅ CONTRACT (Auth v1.0):
// - Do NOT require x-tenant-key to validate the token.
// - Surface (IADM Portal vs Employee vs Customer) is derived from the token's client app id
//   (azp/appid), NEVER from UI headers like x-portal-context.
// - This middleware validates the access token intended for THIS API (audience check), then
//   attaches req.auth + req.surface for downstream handlers.

import { createRemoteJWKSet, jwtVerify, decodeJwt, decodeProtectedHeader } from "jose";

// Cache: jwks resolvers per jwks_uri
const jwksByUri = new Map();
// Cache: openid config per metadata address
const oidcConfigCache = new Map();

const AUTH_TIMEOUT_MS = Number.parseInt(process.env.AUTH_TIMEOUT_MS || "10000", 10);

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function fetchJsonWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Failed to fetch (${res.status}) from ${url}. ${text}`);
    }
    return await res.json();
  } catch (err) {
    // Normalize AbortError
    if (err && typeof err === "object" && "name" in err && err.name === "AbortError") {
      throw new Error(`Fetch timed out after ${ms}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}


function parseCsv(value) {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function getOidcConfigByMetadata(metadataAddress) {
  const key = metadataAddress;
  if (oidcConfigCache.has(key)) return oidcConfigCache.get(key);

  const json = await fetchJsonWithTimeout(metadataAddress, AUTH_TIMEOUT_MS);
  oidcConfigCache.set(key, json);
  return json;
}

function getJwksFromUri(jwksUri) {
  if (jwksByUri.has(jwksUri)) return jwksByUri.get(jwksUri);
  const jwks = createRemoteJWKSet(new URL(jwksUri));
  jwksByUri.set(jwksUri, jwks);
  return jwks;
}

function resolveSurfaceFromClientId(clientId) {
  const iadmPortal = (process.env.IADM_PORTAL_CLIENT_ID || "").trim();
  const employeePortal = (process.env.EMPLOYEE_PORTAL_CLIENT_ID || "").trim();
  const customerPortal = (process.env.CUSTOMER_PORTAL_CLIENT_ID || "").trim();

  if (clientId && iadmPortal && clientId === iadmPortal) return "iadm_portal";
  if (clientId && employeePortal && clientId === employeePortal) return "employee_portal";
  if (clientId && customerPortal && clientId === customerPortal) return "customer_portal";
  return "unknown";
}

export async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) return res.status(401).json({ error: "Missing Bearer token" });

    const metadataAddress = (process.env.AUTH_METADATA_ADDRESS || "").trim();
    if (!metadataAddress) {
      return res.status(500).json({
        error: "Server auth misconfigured",
        details: "AUTH_METADATA_ADDRESS is required.",
      });
    }

    const allowedAudiences = parseCsv(process.env.AUTH_API_AUDIENCE);
    if (!allowedAudiences.length) {
      return res.status(500).json({
        error: "Server auth misconfigured",
        details: "AUTH_API_AUDIENCE is required (the platform-api app registration audience).",
      });
    }

    // decode only for debug visibility (not trusted for config selection)
    const header = decodeProtectedHeader(token);
    const claimsPreview = decodeJwt(token);

    // ✅ fetch OIDC configuration from metadata address
    const oidc = await getOidcConfigByMetadata(metadataAddress);
    const jwksUri = oidc?.jwks_uri;
    const issuer = oidc?.issuer;

    if (!jwksUri || !issuer) throw new Error("OIDC config missing jwks_uri or issuer");

    const JWKS = getJwksFromUri(jwksUri);

    const { payload } = await withTimeout(jwtVerify(token, JWKS, {
      issuer,
      audience: allowedAudiences,
    }), AUTH_TIMEOUT_MS, "Token verification");

    // Determine calling client (authorized party) to derive surface.
    const clientId = (payload?.azp || payload?.appid || "")?.toString?.() || "";
    const allowedClients = parseCsv(process.env.AUTH_ALLOWED_CLIENT_IDS);

    if (allowedClients.length && (!clientId || !allowedClients.includes(clientId))) {
      return res.status(401).json({
        error: "Unauthorized client",
        details: "Token client application is not allowed for this API.",
      });
    }

    const surface = resolveSurfaceFromClientId(clientId);
    if (surface === "unknown") {
      return res.status(401).json({
        error: "Unknown portal surface",
        details: "Token client application (azp/appid) did not match a configured portal surface.",
      });
    }

    // Keep claims flat
    req.auth = payload;
    req.authClientId = clientId;
    req.surface = surface;

    // Optional debug
    if ((process.env.AUTH_DEBUG || "").toLowerCase() === "true") {
      console.log("[requireAuth] token meta:", {
        kid: header?.kid,
        alg: header?.alg,
        tokenIss: claimsPreview?.iss,
        tokenAud: claimsPreview?.aud,
        clientId,
        surface,
      });
    }

    return next();
  } catch (err) {
    console.error("[requireAuth] token rejected:", err);
    return res.status(401).json({ error: "Invalid token" });
  }
}
