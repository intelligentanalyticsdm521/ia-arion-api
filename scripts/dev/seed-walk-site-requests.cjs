// seed-walk-site-requests.cjs — give the ARION "Request a change" walk the
// three requests it is written against.
//
// WHY THIS EXISTS
// ---------------
// Walk rows S1, S2 and S10 read:
//   S1  "three requests newest first: Being worked on, Received, Done"
//   S2  "Sent <date> · Finished <date>", the request, "Our reply: Phone number
//        updated on the Contact page"
//   S10 "Reload the client's Support page → Done + finished date + your reply"
// The site the Support page opens on had exactly ONE request, status open, with
// no reply and no finished date. One row is neither "three" nor "newest first",
// there was no Done row to read, and S10 had nothing to compare against — three
// rows reading as product failures when the product had never been shown its
// own fixture.
//
// WHICH SITE. This business has THREE active sites and the Support page reads
// the one the picker lands on, which is the FIRST that GET /arion/sites returns
// — newest created, `localhost:8084`. An earlier cut of this script ordered by
// created_at ASCENDING and seeded the OLDEST site, which left the walk looking
// at an empty list while the rows sat somewhere the client never opens. The
// order here mirrors the API deliberately.
//
// ⚠ A DELETION THIS SCRIPT CAUSED, RECORDED SO IT IS NOT REPEATED.
// The first cut's --undo was `WHERE notes LIKE '%[prewalk2]%'`. In T-SQL the
// square brackets in a LIKE pattern are a CHARACTER CLASS, so that pattern
// means "notes containing any one of p r e w a l k 2" — i.e. every row — and it
// carried no tenant filter either. Running it deleted FOUR pre-existing dev
// fixture requests along with its own three. One of the four had been read in
// full earlier in the session and is restored below with its original id and
// wording; the other three are gone, and are written up in
// MASTER_DEFECT_REGISTER.md §4d. The undo is now an exact equality match on the
// notes strings this file itself defines, scoped to the tenant, so it can only
// ever delete a row it could have written.
//
// IDEMPOTENT: keyed on the exact notes text.
// REVERSIBLE: --undo removes only this script's own three rows.
//
//   node scripts/dev/seed-walk-site-requests.cjs [--undo]
//
// LOCAL ONLY.
require("dotenv/config");
const sql = require("mssql");

const TENANT = "A0000001-0000-0000-0000-000000000001"; // Summit Lawn & Landscape
const STAMP = "[prewalk2]"; // human marker in the notes; NEVER used in a LIKE

const ROWS = [
  {
    status: "in_progress", daysAgo: 2, resolvedDaysAgo: null, type: "content_update",
    notes: "Page: Services (http://localhost:8084/services/)\n\nCan we add snow removal to the services list before the first frost? " + STAMP,
    reply: null,
  },
  {
    status: "open", daysAgo: 5, resolvedDaysAgo: null, type: "content_update",
    notes: "Page: Home (http://localhost:8084/)\n\nThe hero photo is from two summers ago — we have newer ones. " + STAMP,
    reply: null,
  },
  {
    status: "done", daysAgo: 14, resolvedDaysAgo: 9, type: "content_update",
    notes: "Page: Contact (http://localhost:8084/contact/)\n\nOur phone number changed to (515) 555-0142. " + STAMP,
    reply: "Phone number updated on the Contact page.",
  },
];

// The one deleted row whose full content was captured before the deletion.
// Restored with its ORIGINAL id, site, wording, status and requester, so the
// fixture is the one that was there rather than a lookalike.
const RESTORE = {
  id: "E9947A81-198C-4250-ABC7-B556B40FD307",
  siteId: "E68A46AE-B5EE-441D-A71C-2AFECA12A658",
  type: "content_update",
  status: "open",
  email: "avery.rasmussen0@example.com",
  createdAt: "2026-09-04T00:00:00Z",
  notes: "Page: About us (http://localhost:8084/about-us/)\n\nPlease change the phone number in the banner to 01000 960 118.",
};

const server = String(process.env.SERVICES_SQL_SERVER || process.env.SQL_SERVER || "");
if (!/^(localhost|127\.0\.0\.1)/i.test(server)) {
  console.error(`refusing: SQL_SERVER=${server} is not local`);
  process.exit(3);
}
const undo = process.argv.includes("--undo");
const say = (s) => console.log("  " + s);

async function main() {
  const pool = await new sql.ConnectionPool({
    server: server.split(",")[0],
    port: Number(server.split(",")[1] || 1433),
    database: process.env.SERVICES_SQL_DATABASE || process.env.SQL_DATABASE || "iadm_services",
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    options: { encrypt: false, trustServerCertificate: true },
  }).connect();

  try {
    console.log(`${undo ? "undo" : "seed"} — website change requests, ${server}`);

    if (undo) {
      let n = 0;
      for (const r of ROWS) {
        const d = await pool.request()
          .input("t", sql.UniqueIdentifier, TENANT)
          .input("n", sql.NVarChar(sql.MAX), r.notes)
          .query("DELETE FROM arion.site_request WHERE tenant_id = @t AND notes = @n");
        n += d.rowsAffected[0];
      }
      say(`${n} of this script's own rows deleted; nothing else could be matched`);
      return;
    }

    // Mirror GET /arion/sites: newest active site first — the one the Support
    // page's picker lands on.
    const site = (await pool.request().input("t", sql.UniqueIdentifier, TENANT).query(`
      SELECT TOP 1 site_id, domain FROM arion.site
       WHERE tenant_id = @t AND status = 'active' ORDER BY created_at DESC`)).recordset[0];
    if (!site) throw new Error("no active ARION site for this business");
    say(`site ${site.domain}`);

    const rest = await pool.request()
      .input("id", sql.UniqueIdentifier, RESTORE.id)
      .input("t", sql.UniqueIdentifier, TENANT)
      .input("s", sql.UniqueIdentifier, RESTORE.siteId)
      .input("ty", sql.NVarChar(60), RESTORE.type)
      .input("n", sql.NVarChar(sql.MAX), RESTORE.notes)
      .input("st", sql.NVarChar(40), RESTORE.status)
      .input("e", sql.NVarChar(320), RESTORE.email)
      .input("c", sql.DateTime2, new Date(RESTORE.createdAt))
      .query(`
        IF NOT EXISTS (SELECT 1 FROM arion.site_request WHERE site_request_id = @id)
        BEGIN
          INSERT INTO arion.site_request
            (site_request_id, tenant_id, site_id, request_type, notes, status,
             requested_by_email, created_at, updated_at)
          VALUES (@id, @t, @s, @ty, @n, @st, @e, @c, @c);
          SELECT 1 AS ins;
        END ELSE SELECT 0 AS ins;`);
    say(rest.recordset[0].ins
      ? "restored the About-us request this pass's first cut deleted"
      : "the About-us request is already there");

    let added = 0;
    for (const r of ROWS) {
      const res = await pool.request()
        .input("t", sql.UniqueIdentifier, TENANT)
        .input("s", sql.UniqueIdentifier, site.site_id)
        .input("ty", sql.NVarChar(60), r.type)
        .input("n", sql.NVarChar(sql.MAX), r.notes)
        .input("st", sql.NVarChar(40), r.status)
        .input("e", sql.NVarChar(320), "avery.rasmussen0@example.com")
        .input("d", sql.Int, r.daysAgo)
        .input("rd", sql.Int, r.resolvedDaysAgo)
        .input("rn", sql.NVarChar(sql.MAX), r.reply)
        .query(`
          IF NOT EXISTS (SELECT 1 FROM arion.site_request WHERE tenant_id = @t AND notes = @n)
          BEGIN
            INSERT INTO arion.site_request
              (site_request_id, tenant_id, site_id, request_type, notes, status, requested_by_email,
               created_at, updated_at, resolved_at, resolution_notes)
            VALUES
              (NEWID(), @t, @s, @ty, @n, @st, @e,
               DATEADD(day, -@d, SYSUTCDATETIME()), DATEADD(day, -@d, SYSUTCDATETIME()),
               CASE WHEN @rd IS NULL THEN NULL ELSE DATEADD(day, -@rd, SYSUTCDATETIME()) END,
               @rn);
            SELECT 1 AS ins;
          END ELSE SELECT 0 AS ins;`);
      if (res.recordset[0].ins) { added++; say(`added ${r.status}`); } else say(`${r.status} already there`);
    }

    // Assert what the Support page asks for, not what the INSERT did.
    const check = await pool.request()
      .input("t", sql.UniqueIdentifier, TENANT)
      .input("s", sql.UniqueIdentifier, site.site_id).query(`
      SELECT status, CONVERT(varchar(10), created_at, 23) AS sent,
             CONVERT(varchar(10), resolved_at, 23) AS finished,
             CASE WHEN resolution_notes IS NULL THEN 'no reply' ELSE 'reply' END AS reply
        FROM arion.site_request WHERE tenant_id = @t AND site_id = @s ORDER BY created_at DESC`);
    say(`the Support page for this site now shows ${check.recordset.length}, newest first:`);
    for (const c of check.recordset) say(`  ${c.status.padEnd(12)} sent ${c.sent}  finished ${c.finished || "—"}  ${c.reply}`);
    const statuses = new Set(check.recordset.map((c) => c.status));
    for (const need of ["open", "in_progress", "done"]) {
      if (!statuses.has(need)) { say(`MISSING a "${need}" row — S1 cannot be judged`); process.exitCode = 4; }
    }
    if (!added) say("no new rows written");
  } finally {
    await pool.close();
  }
}

main().then(() => process.exit(process.exitCode || 0))
  .catch((e) => { console.error(e.message); process.exit(1); });
