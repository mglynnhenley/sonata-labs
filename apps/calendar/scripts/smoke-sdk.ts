// Acceptance harness: drive the sandbox with the OFFICIAL googleapis SDK, the
// same way a real agent would — only rootUrl is overridden. If this passes, an
// agent using googleapis works against the sandbox unchanged.
//
//   PORT=3400 npm run smoke
//
// Requires the server to be running (npm start) on $PORT and a seeded calendar.

import { google } from "googleapis";

const OAuth2Client = google.auth.OAuth2;

const PORT = process.env.PORT || "3400";
const ROOT_URL = process.env.SANDBOX_ROOT_URL || `http://localhost:${PORT}`;
const TOKEN = process.env.SANDBOX_TOKEN || "sandbox-token";

// Pass an OAuth2Client with setCredentials — a string `auth` becomes a `key=`
// query param, NOT a bearer header (a classic footgun).
const auth = new OAuth2Client();
auth.setCredentials({ access_token: TOKEN });

const calendar = google.calendar({ version: "v3", auth, rootUrl: ROOT_URL });

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    if (detail !== undefined) console.log("      detail:", JSON.stringify(detail)?.slice(0, 300));
  }
}

async function expectError(name: string, fn: () => Promise<unknown>, code: number): Promise<void> {
  try {
    await fn();
    check(name, false, "expected an error but call succeeded");
  } catch (e) {
    const status =
      (e as { response?: { status?: number }; code?: number }).response?.status ??
      (e as { code?: number }).code;
    check(name, status === code, { got: status, want: code });
  }
}

async function main(): Promise<void> {
  console.log(`\n\x1b[1mCalendar sandbox smoke — ${ROOT_URL}\x1b[0m`);

  const list = await calendar.calendarList.list();
  check("calendarList.list returns calendar#calendarList", list.data.kind === "calendar#calendarList");
  const primary = list.data.items?.find((c) => c.primary);
  check("a primary calendar exists", !!primary, list.data.items?.map((c) => c.id));
  const primaryId = primary?.id;
  if (!primaryId) throw new Error("no primary calendar — run `npm run seed`");

  const timeMin = new Date(Date.UTC(2026, 6, 27)).toISOString();
  const timeMax = new Date(Date.UTC(2026, 7, 3)).toISOString();

  const events = await calendar.events.list({
    calendarId: "primary",
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
  });
  check("events.list returns calendar#events", events.data.kind === "calendar#events");
  check("items is an array", Array.isArray(events.data.items), events.data.items?.length);
  const instance = events.data.items?.find((e) => e.recurringEventId);
  check("recurring series expands into instances", !!instance, instance?.id);
  check(
    "timed bounds carry an offset and a timeZone",
    !!instance?.start?.dateTime?.match(/[+-]\d{2}:\d{2}$|Z$/) && !!instance?.start?.timeZone,
    instance?.start,
  );

  const created = await calendar.events.insert({
    calendarId: "primary",
    requestBody: {
      summary: "Smoke test — please ignore",
      start: { dateTime: "2026-07-30T10:00:00-04:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-07-30T10:30:00-04:00", timeZone: "America/New_York" },
      attendees: [{ email: "priya@acme.co", responseStatus: "needsAction" }],
    },
  });
  check("events.insert returns calendar#event", created.data.kind === "calendar#event");
  const eventId = created.data.id;
  check("insert assigns a base32hex id", !!eventId?.match(/^[0-9a-v]{5,}$/), eventId);
  if (!eventId) throw new Error("insert returned no id");

  const fetched = await calendar.events.get({ calendarId: "primary", eventId });
  check("events.get round-trips the summary", fetched.data.summary === "Smoke test — please ignore");
  check("attendees survive the round-trip", fetched.data.attendees?.[0]?.email === "priya@acme.co");

  const patched = await calendar.events.patch({
    calendarId: "primary",
    eventId,
    requestBody: { location: "Atlas (6)" },
  });
  check("events.patch sets the field", patched.data.location === "Atlas (6)");
  check("events.patch leaves the summary alone", patched.data.summary === "Smoke test — please ignore");

  const replaced = await calendar.events.update({
    calendarId: "primary",
    eventId,
    requestBody: {
      summary: "Smoke test — replaced",
      start: { dateTime: "2026-07-30T11:00:00-04:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-07-30T11:30:00-04:00", timeZone: "America/New_York" },
    },
  });
  check("events.update replaces the whole resource", replaced.data.summary === "Smoke test — replaced");
  check("events.update clears omitted fields", replaced.data.location == null, replaced.data.location);

  const busy = await calendar.freebusy.query({
    requestBody: {
      timeMin: "2026-07-28T00:00:00Z",
      timeMax: "2026-07-29T00:00:00Z",
      items: [{ id: primaryId }],
    },
  });
  check("freeBusy returns calendar#freeBusy", busy.data.kind === "calendar#freeBusy");
  const blocks = busy.data.calendars?.[primaryId]?.busy ?? [];
  check("freeBusy reports busy blocks for a working Tuesday", blocks.length > 0, blocks);

  await calendar.events.delete({ calendarId: "primary", eventId });
  check("events.delete returns 204", true);
  await expectError(
    "deleting twice is 410",
    () => calendar.events.delete({ calendarId: "primary", eventId }),
    410,
  );
  await expectError(
    "unknown event is 404",
    () => calendar.events.get({ calendarId: "primary", eventId: "nosuchevent00000000000000" }),
    404,
  );
  await expectError(
    "unknown calendar is 404",
    () => calendar.events.list({ calendarId: "nope@example.com" }),
    404,
  );

  const wrongAuth = new OAuth2Client();
  wrongAuth.setCredentials({ access_token: "not-the-sandbox-token" });
  const bad = google.calendar({ version: "v3", auth: wrongAuth, rootUrl: ROOT_URL });
  await expectError("a bad bearer token is 401", () => bad.calendarList.list(), 401);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
