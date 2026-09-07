# Operations dashboard — local preview

`scripts/dev-ops.mjs` runs the operations dashboard on your machine against the real
handlers in `api/`, with a store full of realistic demo data. No build step, no npm
dependencies, nothing leaves the process — the stores are in memory and reset on restart.

## Run it

```sh
npm run dev:ops                     # http://localhost:4300/  — passcode: demo
node scripts/dev-ops.mjs --no-seed  # empty store; the fixture calls are still served
node scripts/dev-ops.mjs --built    # serve ops/dashboard.page.json exactly as built
PORT=5000 npm run dev:ops           # or --port 5000
```

Sign in with the passcode `demo` (or whatever `OPS_DASHBOARD_PASSCODE` is set to in your
shell — that value is respected, and never printed). Use `http://localhost:…`; on another
hostname the cookie still works because the server marks itself as plain http.

For a script or curl, the header works as it does in production:

```sh
curl -H 'x-ops-passcode: demo' http://localhost:4300/api/leads
curl -H 'x-ops-passcode: demo' http://localhost:4300/api/calendar
curl -H 'x-ops-passcode: demo' http://localhost:4300/api/vapi
```

What is real and what is not:

| Path | What answers |
|---|---|
| `/` and `/api/dashboard` | the real `api/dashboard.ts` — sign-in form, cookie, sign-out. On a signed-in `GET` the page body is composed live from `ops/src/` (what `npm run build:ops` writes), so edit, refresh, see it. `--built` serves the embedded build instead. |
| `/api/calendar`, `/api/leads`, `/api/health` | the real handlers, in-memory store |
| `/api/vapi` `POST` | the real webhook — you can drive it with Vapi-shaped posts |
| `/api/vapi` `GET` | the real handler for auth and `events`; `calls` come from `calls.json` when no `VAPI_PRIVATE_KEY`/`VAPI_API_KEY` is set (with a key set, real Vapi history is returned unchanged) |

One line is logged per request. `Ctrl-C` stops it.

## What is seeded

With `--seed` (the default) the server replays every call in `calls.json` through the real
webhook at startup — the caller's lines as `transcript` messages, each tool as a
`tool-calls` message, then an `end-of-call-report` — so the leads, follow-ups, bookings
and decision events are exactly what production would have written. Each call is
replayed with the clock set to the call's own time, which is how a tour can already be in
the past. Times are relative to the day the server starts, so nothing goes stale.

Callers (`-3d` = three days ago, all times New York):

| Call | When | Caller | Outcome | Lead stage afterwards |
|---|---|---|---|---|
| `dev-call-01` | −3d 2:40 pm | Marcus Bell `+1 917 555 0188` | qualified 1BR ≈ $5,000 for Oct 1; asked about parking; **booked 14C for −2d 11:00 am**, no email | tour scheduled |
| `dev-call-02` | −2d 11:05 am | Priya Raman `+1 516 555 0142` | qualified 2BR ≤ $7,000 for Nov 1, two cats; **booked 13L for tomorrow 2:00 pm**, email given | tour scheduled |
| `dev-call-03` | −2d 3:30 pm | `+1 516 555 0195` | wanted 4 bedrooms; none exist; loss reason `bedroom_mismatch` | lost |
| `dev-call-04` | −1d 9:58 am | `+1 201 555 0174` | wrong number, 19 seconds, no tools | new |
| `dev-call-05` | −1d 12:15 pm | Tomás Herrera `+1 347 555 0163` | 1BR for mid-November; asked about a service dog → routed to a person (`reasonable_accommodation`) | escalated |
| `dev-call-06` | −1d 6:40 pm | `+1 631 555 0117` | studio ≤ $2,400 for October; priced out by $765; loss reason `priced_out` | lost |
| `dev-call-07` | today 9:35 am | Marcus Bell again | asked about the application fee and an out-of-state guarantor | **toured** (his tour has passed) |
| `dev-call-08` | today 10:20 am | Lena Okafor `+1 718 555 0129` | qualified 2BR ≈ $6,500 for December; asked about the gym; heard tour times, did not book | qualified |
| `dev-call-09` | today 11:45 am | Aisha Khan `+1 929 555 0151` | qualified 1BR ≤ $4,800 for mid-October; parking; looked up 08E by name; **booked 08E for +3d 5:30 pm**, email given | tour scheduled |
| `dev-call-10` | today 12:30 pm | `+1 646 555 0199` | asked the office hours, hung up | new |
| `dev-call-11` | today 12:52 pm | no number | silence, timed out, no tools | new (phone `unknown`) |
| `dev-call-12` | today 1:05 pm | `+1 718 555 0166` | resident: kitchen flooding → emergency events logged | new |

"Today" calls move to the previous day when the server starts before they would have
ended (a call cannot end in the future).

Names come from `book_tour` only — the real system has no other way to learn one — so
Tomás and Lena are named by staff notes (`name: …` pins a name), seeded through the real
`POST /api/leads`. Two of Marcus's follow-ups are marked done/skipped the same way.

Follow-ups the real code derives from the above (see `src/leads/followups.ts`): Marcus —
confirm tour (done), collect email (skipped), post-tour call (overdue); Priya — reminder
due today, confirmation tomorrow; Tomás — urgent callback (overdue since yesterday);
`+1 631…` — priced-out watch in two weeks; Aisha — reminder the day before, confirmation
three hours before.

Calendar (all relative to today):

| Target | Reason | Note |
|---|---|---|
| whole day, +2d | Fire alarm inspection — no tours | via `POST /api/calendar {action:'block'}` |
| +1d 10:00 and 10:30 | Residence 13L being photographed | see below |
| +4d 3:00 pm | Leasing team meeting | see below |
| bookings | Marcus −2d 11:00 am (past), Priya +1d 2:00 pm, Aisha +3d 5:30 pm | made by the real `book_tour` tool; slot ids come from `GET /api/calendar` |

Slot-level blocks: `api/calendar.ts` currently rejects the minute-precision slot ids the
API itself emits (`slot-2026-09-08T14:00` fails its `target` regex, which was written for
hour-precision ids). The seeder tries the API first and, when it gets that 400, writes the
block straight into the same in-memory store, printing a warning. When the handler is
fixed the warning disappears and the API path is used. Day blocks go through the API.

## The fixture format

`calls.json` is `{ comment, blocks, staff, calls }`.

Each entry in `calls` has **exactly** the keys of a call in `GET /api/vapi`
(`src/ops/vapi-calls.ts` `VapiCall`): `id, startedAt, endedAt, durationSeconds,
endedReason, customerNumber, transcript, recordingUrl, toolCalls, cost`; each tool call
is `{ name, arguments, result }`. The server refuses to start on a missing or extra key.
Three things are templated so the data never dates:

- `startedAt`: `"-2d 11:05"` — days before today, New York wall time. An ISO instant is
  also accepted. `endedAt: null` means `startedAt + durationSeconds`.
- `book_tour.arguments.slotId`: `"$slot:+1@14:00"` — a real open slot on today+1 at
  2:00 pm New York, or the nearest later slot that day, or the first open slot that day.
  Negative offsets are fine for a call replayed in the past (`-2` from a call at `-3d` is
  "tomorrow" for that caller).
- `{{tour_when}}` (`Tuesday, September 8 at 2:00 PM`), `{{tour_day}}`, `{{tour_date}}`,
  `{{tour_time}}` in any string become the booked slot's time.

`transcript` uses Vapi's format: lines prefixed `AI: ` and `User: `, newline-separated.
Every `User:` line is posted to the webhook as a `transcript` message before the tools,
so an emergency phrase in a transcript produces real emergency events.

With `--seed`, every `result` is replaced by what the real handler returned for that tool
call, so what the Calls view shows is what the agent was actually told. Without seeding,
`list_tour_slots` results are rebuilt from the real calendar and the other results are
served as written.

`blocks`: `{ target: "+2" | "+1@10:00", reason }`. `staff`: `{ action: 'note', phone,
text }` or `{ action: 'followup_status', phone, kind, status }` — applied after the calls
through `POST /api/leads`.

## Adding a call

1. Copy an entry in `calls`, give it a new `id` and `customerNumber` (a new number is a
   new lead; an existing one adds a call to that lead), and pick a `startedAt`.
2. Write the transcript, then list the tools the agent would have called, in order, with
   the arguments from `vapi-assistant.json` (`capture_signal` values: an ISO date for
   `moveInTiming`, a number for `budget`, a number or `studio` for `bedrooms`).
3. Put anything in `result` — with seeding it is replaced by the real answer. To bake the
   real answers into the file, start the server and copy them out of
   `curl -H 'x-ops-passcode: demo' localhost:4300/api/vapi`.
4. For a booking, use `"$slot:+N@HH:MM"` for the slot id and the `{{tour_…}}` tokens in
   the text. For a tour that has already happened, start the call in the past and give it
   a negative offset that is still after the call.
5. Restart the server; the startup line reports the lead, follow-up, booking and block
   counts, and refuses the file if a key is wrong.

## Things worth knowing

- The store is memory: restart to reset, or use the dashboard's own test controls.
- `GET /api/health` reports `callHistory: false` (no Vapi key) even while the fixture
  calls are being served — that field is the real handler's honest answer.
- `api/vapi.ts` caches the inventory snapshot with the clock of the first tool call and
  `src/inventory/match.ts` treats it as stale after 15 minutes. The seeder warms it first so
  replayed calls are unaffected, but a `check_availability` you post by hand more than
  15 minutes after startup will get the "re-check availability" branch — the same thing
  happens on a warm production instance.
- Screenshots and browser checks: `playwright-core` is not a dependency of this repo; the
  team's copy lives outside it. Sign in through the form, then load `/`.
