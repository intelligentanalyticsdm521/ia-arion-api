# ARION API

Node + Express API for the ARION website operations module.

## Required app settings

- `AUTH_MODE`
- `AUTH_METADATA_ADDRESS`
- `AUTH_API_AUDIENCE`
- `AUTH_ALLOWED_CLIENT_IDS`
- `AUTH_PROVIDER_KEY`
- `IADM_PORTAL_CLIENT_ID`
- `EMPLOYEE_PORTAL_CLIENT_ID`
- `CUSTOMER_PORTAL_CLIENT_ID`
- `CORS_ORIGINS`
- `PLATFORM_SQL_SERVER`
- `PLATFORM_SQL_DATABASE` (default: `iadm_platform`)
- `SERVICES_SQL_SERVER`
- `SERVICES_SQL_DATABASE` (default: `iadm_services`)
- `ARION_SERVICE_KEY` (default: `arion`)
- `ARION_INGEST_KEY` (shared secret for future WP/plugin ingestion)

## Auth model

This service intentionally reuses the exact token validation pattern from `platform-api`.
Authentication is unchanged. The portal must send:

- `Authorization: Bearer <token>`
- `x-tenant-key: <tenant_id>`

The API validates:
1. token audience and calling portal client
2. tenant resolution
3. tenant membership in `iadm_platform`
4. ARION service entitlement in `iadm_platform`

Operational data is always read/written from `iadm_services.arion`.
