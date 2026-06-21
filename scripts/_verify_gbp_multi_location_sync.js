// scripts/_verify_gbp_multi_location_sync.js
//
// Verifier for Onboarding V3 Phase 3 GBP multi-location auto-import.
//
// What this checks:
//   1. mapToColumns + parseLocationName extract the right pieces from a
//      gbpApi.listAllGbpLocations entry — no DB needed.
//   2. syncAllLocations with an injected fixture handles:
//        - first-time INSERTs (added counter)
//        - re-running with same fixture (updated counter, no dupes)
//        - removed locations (removed counter)
//        - automatic primary promotion
//
// The DB-touching part is opt-in:
//   ARION_SQL_DB=iadm_services node scripts/_verify_gbp_multi_location_sync.js
//
// Without ARION_SQL_DB the script runs ONLY the pure-function checks, which
// is what CI / the post-commit verifier runs. Pure checks should always
// pass; failure means the column mapper regressed.

import assert from 'node:assert/strict';
import { parseLocationName, mapToColumns } from '../lib/integrations/gbpSync.js';

const FIXTURE_LOCATIONS = [
  {
    account_name: 'accounts/111',
    account_display_name: 'Acme Plumbing Co',
    location_name: 'accounts/111/locations/L_NORTH',
    title: 'Acme Plumbing — North Branch',
    address: '100 Main St, Springfield, IL 62701',
    website_uri: 'https://acmeplumbing.example.com',
    primary_phone: '+1-217-555-0100',
    category: 'Plumber',
    match_score: 1.0,
    place_id: 'ChIJ_NORTH_PLACE_ID',
    review_uri: 'https://search.google.com/local/writereview?placeid=ChIJ_NORTH_PLACE_ID',
  },
  {
    account_name: 'accounts/111',
    account_display_name: 'Acme Plumbing Co',
    location_name: 'accounts/111/locations/L_SOUTH',
    title: 'Acme Plumbing — South Branch',
    address: '500 Oak Ave, Decatur, IL 62521',
    website_uri: 'https://acmeplumbing.example.com',
    primary_phone: '+1-217-555-0200',
    category: 'Plumber',
    match_score: 1.0,
    place_id: 'ChIJ_SOUTH_PLACE_ID',
    review_uri: 'https://search.google.com/local/writereview?placeid=ChIJ_SOUTH_PLACE_ID',
  },
  {
    account_name: 'accounts/111',
    account_display_name: 'Acme Plumbing Co',
    location_name: 'accounts/111/locations/L_EAST',
    title: 'Acme Plumbing — East Branch',
    address: '50 Elm St, Champaign, IL 61820',
    website_uri: 'https://acmeplumbing.example.com',
    primary_phone: '+1-217-555-0300',
    category: 'Plumber',
    match_score: 1.0,
    place_id: 'ChIJ_EAST_PLACE_ID',
    review_uri: 'https://search.google.com/local/writereview?placeid=ChIJ_EAST_PLACE_ID',
  },
  {
    account_name: 'accounts/111',
    account_display_name: 'Acme Plumbing Co',
    location_name: 'accounts/111/locations/L_WEST',
    title: 'Acme Plumbing — West Branch',
    address: '777 Maple Rd, Peoria, IL 61602',
    website_uri: 'https://acmeplumbing.example.com',
    primary_phone: '+1-217-555-0400',
    category: 'Plumber',
    match_score: 1.0,
    place_id: 'ChIJ_WEST_PLACE_ID',
    review_uri: 'https://search.google.com/local/writereview?placeid=ChIJ_WEST_PLACE_ID',
  },
];

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); pass += 1; }
  catch (e) { console.log(`  FAIL ${name}: ${e.message}`); fail += 1; }
}

console.log('── parseLocationName ──');
check('parses full resource name', () => {
  const r = parseLocationName('accounts/111/locations/L_NORTH');
  assert.equal(r.accountId, '111');
  assert.equal(r.locationId, 'L_NORTH');
});
check('parses bare locations/L', () => {
  const r = parseLocationName('locations/L_NORTH');
  assert.equal(r.accountId, null);
  assert.equal(r.locationId, 'L_NORTH');
});
check('returns nulls on garbage', () => {
  const r = parseLocationName('');
  assert.equal(r.accountId, null);
  assert.equal(r.locationId, null);
});

console.log('── mapToColumns ──');
check('maps a complete entry', () => {
  const cols = mapToColumns(FIXTURE_LOCATIONS[0], parseLocationName(FIXTURE_LOCATIONS[0].location_name));
  assert.equal(cols.gbpAccountId, '111');
  assert.equal(cols.locationName, 'accounts/111/locations/L_NORTH');
  assert.equal(cols.displayName, 'Acme Plumbing — North Branch');
  assert.equal(cols.addressLine1, '100 Main St');
  assert.equal(cols.city, 'Springfield');
  assert.equal(cols.region, 'IL');
  assert.equal(cols.postalCode, '62701');
  assert.equal(cols.phone, '+1-217-555-0100');
  assert.equal(cols.website, 'https://acmeplumbing.example.com');
  assert.equal(cols.primaryCategory, 'Plumber');
  assert.equal(cols.placeId, 'ChIJ_NORTH_PLACE_ID');
  assert.equal(cols.reviewUri, 'https://search.google.com/local/writereview?placeid=ChIJ_NORTH_PLACE_ID');
});
check('survives a tiny address', () => {
  const cols = mapToColumns({ title: 'X', address: 'Just one part' }, { accountId: null, locationId: 'Z' });
  assert.equal(cols.addressLine1, 'Just one part');
  assert.equal(cols.city, null);
});

// ── syncAllLocations with a mocked pool ──
// We stub out getServicesPool by intercepting via a module-level shim. The
// sync layer treats the pool as opaque mssql request/query, so we record
// every query and return canned recordsets.
console.log('── syncAllLocations (mocked pool) ──');

// Hot-patch the servicesPool module BEFORE importing gbpSync's siblings.
const mockState = {
  rows: new Map(), // key = gbp_location_id → row
  queries: [],
};
function makeRequest() {
  const inputs = {};
  const req = {
    input(name, _type, value) { inputs[name] = value; return req; },
    async query(sqlText) {
      const s = sqlText.replace(/\s+/g, ' ').trim();
      mockState.queries.push({ sql: s.slice(0, 100), inputs: { ...inputs } });
      // Recognize the canonical queries from gbpSync.js.
      if (/SELECT location_id, gbp_location_id, is_primary/i.test(s)) {
        const out = [...mockState.rows.values()]
          .filter((r) => r.tenant_id === inputs.tenantId)
          .map((r) => ({ location_id: r.location_id, gbp_location_id: r.gbp_location_id, is_primary: r.is_primary }));
        return { recordset: out };
      }
      if (/INSERT INTO arion\.business_location/i.test(s)) {
        const id = crypto.randomUUID();
        mockState.rows.set(inputs.gbpLocationId, {
          location_id: id,
          tenant_id: inputs.tenantId,
          gbp_location_id: inputs.gbpLocationId,
          display_name: inputs.displayName,
          is_primary: inputs.isPrimary === 1,
          location_name: inputs.locationName,
        });
        return { recordset: [], rowsAffected: [1] };
      }
      if (/UPDATE arion\.business_location SET gbp_account_id/i.test(s)) {
        const existing = mockState.rows.get(inputs.gbpLocationId);
        if (existing) existing.display_name = inputs.displayName;
        return { recordset: [], rowsAffected: [1] };
      }
      if (/DELETE FROM arion\.business_location/i.test(s)) {
        mockState.rows.delete(inputs.gbpLocationId);
        return { recordset: [], rowsAffected: [1] };
      }
      if (/UPDATE TOP \(1\) arion\.business_location/i.test(s)) {
        const first = [...mockState.rows.values()].find((r) => r.tenant_id === inputs.tenantId && !r.is_primary);
        if (first) { first.is_primary = true; return { recordset: [{ location_name: first.location_name }] }; }
        return { recordset: [] };
      }
      if (/MERGE arion\.site_integration_status/i.test(s)) {
        return { recordset: [], rowsAffected: [1] };
      }
      return { recordset: [], rowsAffected: [0] };
    },
  };
  return req;
}
const mockPool = { request: makeRequest };

// Use the injectedPool seam exposed on syncAllLocations so we don't have to
// hot-patch the ESM servicesPool module (its exports are frozen).
const crypto = await import('node:crypto').then((m) => m.default || m);
const { syncAllLocations } = await import('../lib/integrations/gbpSync.js');

const TENANT = '11111111-2222-3333-4444-555555555555';

// First sync — empty start → all 4 inserted.
const fakeClient = async () => FIXTURE_LOCATIONS;
const r1 = await syncAllLocations(TENANT, 'fake-token', { injectedClient: fakeClient, injectedPool: mockPool });
check('first sync adds 4 locations', () => {
  assert.equal(r1.added, 4, `expected added=4, got ${r1.added}`);
  assert.equal(r1.updated, 0);
  assert.equal(r1.removed, 0);
  assert.equal(r1.total, 4);
  assert.equal(mockState.rows.size, 4);
});
check('first sync promotes one row to primary', () => {
  const primaryRows = [...mockState.rows.values()].filter((r) => r.is_primary);
  assert.equal(primaryRows.length, 1, `expected 1 primary, got ${primaryRows.length}`);
});

// Second sync, same input → all 4 updated, none added/removed.
const r2 = await syncAllLocations(TENANT, 'fake-token', { injectedClient: fakeClient, injectedPool: mockPool });
check('re-sync updates without dupes', () => {
  assert.equal(r2.added, 0);
  assert.equal(r2.updated, 4);
  assert.equal(r2.removed, 0);
  assert.equal(mockState.rows.size, 4);
});

// Third sync with one location removed → removed=1, total=3.
const reducedFixture = FIXTURE_LOCATIONS.slice(0, 3);
const r3 = await syncAllLocations(TENANT, 'fake-token', { injectedClient: async () => reducedFixture, injectedPool: mockPool });
check('removing a location decrements the row count', () => {
  assert.equal(r3.added, 0);
  assert.equal(r3.updated, 3);
  assert.equal(r3.removed, 1);
  assert.equal(r3.total, 3);
  assert.equal(mockState.rows.size, 3);
});

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
