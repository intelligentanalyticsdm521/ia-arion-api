// lib/businessTimeZone.js — the clock a BUSINESS keeps, and "tomorrow at
// HH:MM" on that clock.
//
// A DECLARED COPY of the platform rule D-11, owned by oliver-api
// lib/businessDay.js resolveBusinessTimeZone and stated again in
// iadm-webhooks src/shared/business-timezone.js:
//
//   1. oliver.location.timezone for the business's default location
//   2. the platform default, America/Chicago
//
// core.tenants has no time-zone column; the location IS the home. Read on
// arion's services pool. Change all three copies together.
//
// NEVER THROWS. A missing table, a NULL or a nonsense zone falls through to
// the default, which is always usable: a social post scheduled on the
// platform's clock is better than one not scheduled at all.

import sql from 'mssql';

export const DEFAULT_TZ = 'America/Chicago';

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export async function businessTimeZone(pool, tenantId) {
  try {
    const r = await pool.request()
      .input('tenantId', sql.UniqueIdentifier, tenantId)
      .query(`SELECT TOP 1 timezone
                FROM oliver.location
               WHERE tenant_id = @tenantId AND timezone IS NOT NULL
               ORDER BY CASE WHEN is_default = 1 THEN 0 ELSE 1 END`);
    const tz = r.recordset?.[0]?.timezone;
    return isValidTimeZone(tz) ? tz : DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

/** The offset (minutes, local minus UTC) of `tz` at instant `at`. */
function offsetMinutes(tz, at) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - at.getTime()) / 60000);
}

/**
 * Tomorrow at `hhmm` ("10:00") on the business's clock, as an ISO instant.
 * `now` is injectable for tests.
 */
export function nextDayAt(tz, hhmm = '10:00', now = new Date()) {
  const zone = isValidTimeZone(tz) ? tz : DEFAULT_TZ;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  const hour = m ? Math.min(23, Number(m[1])) : 10;
  const minute = m ? Math.min(59, Number(m[2])) : 0;
  const local = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).map((p) => [p.type, p.value]));
  // Wall-clock tomorrow at hh:mm, then corrected by the zone's offset at that moment.
  const wall = Date.UTC(+local.year, +local.month - 1, +local.day + 1, hour, minute, 0);
  let guess = new Date(wall - offsetMinutes(zone, new Date(wall)) * 60000);
  guess = new Date(wall - offsetMinutes(zone, guess) * 60000);
  return guess.toISOString();
}

export default { DEFAULT_TZ, isValidTimeZone, businessTimeZone, nextDayAt };
