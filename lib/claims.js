export function cleanString(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  if (s.toLowerCase() === "unknown") return null;
  return s;
}

export function getEmailFromClaims(claims) {
  if (!claims) return null;

  const direct =
    cleanString(claims.email) ||
    cleanString(claims.preferred_username) ||
    cleanString(claims.upn);

  if (direct) return direct;

  if (Array.isArray(claims.emails) && claims.emails.length > 0) {
    const e = claims.emails.find((x) => typeof x === "string" && x.includes("@"));
    return cleanString(e) || null;
  }

  return null;
}

export function getExternalSubject(claims) {
  return cleanString(claims?.oid) || cleanString(claims?.sub) || null;
}
