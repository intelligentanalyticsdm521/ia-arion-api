/**
 * Extract email from Entra External ID JWT claims.
 * Supports multiple claim formats across different Entra configurations.
 */
export function getEmailFromClaims(claims) {
  return claims.email || claims.preferred_username || claims.emails?.[0] || null;
}

/**
 * Extract the external subject identifier from JWT claims.
 * Used for matching against core.users.external_subject in iadm_platform.
 */
export function getExternalSubject(claims) {
  return claims.sub || claims.oid || null;
}
