# Atrium

AI leasing and resident operations for multifamily buildings.

## Where this is

A voice leasing workflow and staff portal, with an opt-in PostgreSQL runtime for
persisted users, organizations, property memberships, scoped operations and atomic
mutation audits. **The Larkin** is a fictional 318-residence building used for local
sample data. This is an implemented leasing and storage slice, not completion of the
resident, maintenance, vendor, messaging or wider building-operations product.

Node 22 runs the TypeScript directly; `pg` is the PostgreSQL runtime dependency.
Run `npm ci` before the checks.

```
npm run check         # types, data validation, unit + handler integration tests
npm run test:database # isolated real PostgreSQL migration, authorization and HTTP tests
npm run build         # build website/dashboard, bundle every API, smoke-test shipped modules
node scripts/validate-data.mjs   # check property data against the runtime contracts
```

See [db/README.md](db/README.md) for the PostgreSQL runtime contract and current
deployment limits; [SETUP.md](SETUP.md) covers the existing phone integration.

The PostgreSQL portal includes **Status → Account security** for changing your own
password, viewing active logins and signing out individual or all other sessions.
Current-password verification, shared database rate limits and registered session
revocation protect these flows; no environment-file edits are needed. This does not
change the hosted legacy demo password or complete customer onboarding. PostgreSQL
passkey enrollment, session verification and recovery are implemented; see
[passkey security](docs/adr/0006-multi-factor-authentication.md) for rollout limits.

## The one idea worth understanding

Every rule that matters is enforced in **code the model cannot argue with** — not in the
system prompt. A prompt instruction is a request. A tool that refuses is a constraint.

A caller who talks the agent into wanting to quote a price still gets a refusal, because
the quote gate lives in the tool implementation, not the prompt.

### Three kinds of question

The *classification* decides what may happen — not the retrieved content, not the model's
confidence.

| Kind | Examples | What the agent may do |
|---|---|---|
| **Restricted** | vouchers, accommodation, eligibility, disputes, legal, money | **Never answers.** Escalates with full context. No confidence level unlocks this. |
| **Volatile** | rent, availability, tour slots, account status | **Never answers from the knowledge base.** Defers to the live source, verified by read-back. |
| **Policy** | pets, parking, hours, amenities | May answer — but only from an article that is published, human-approved, in scope for the property and jurisdiction, and not past its review date. |

Two consequences that are easy to miss, both covered by tests:

- A restricted topic escalates **even with a perfect published article at confidence 1.0**.
- A rent question defers to live inventory **even when an article answers it**. A stale
  quote loses the lease *and* is a compliance problem.

### Three more guards

**The quote gate.** No rent is stated until at least two of move-in timing, bedroom need
and budget are captured. Quoting blind is how a $4,200 residence gets shown to someone with
a $2,500 ceiling, and how the loss reason becomes "went quiet" instead of the truth.

**Priced out is a first-class outcome.** When nothing fits the stated budget, the agent
says so and records the gap **as a number**. It does not quietly offer something dearer.
That number is the countable loss reason the whole product exists to produce.

**Read-back before "confirmed."** A booking is written, then re-read from the calendar and
compared. Only a match may be called confirmed; an unverified write says "being arranged"
and a failure says a person will call back. What the agent may say is derived from booking
state, so no conversational pressure produces a false confirmation.

### Emergencies

Detection runs ahead of intent classification, qualification, knowledge and authority — and
uses fixed approved instructions rather than generated text.

It is keyword-driven on purpose. A model having a bad day can misclassify "I smell gas"; a
keyword list cannot. Probing the first draft found seven false positives — *"can I smoke in
my apartment"* and *"is there a fire pit on the roof"* both routed to a fire emergency. A
leasing line takes far more amenity questions than emergencies, and a detector that cries
wolf trains staff to ignore it. All 20 benign probes and 21 emergency phrasings are now
locked in as tests.

## Evidence, everywhere

Every captured value carries its provenance, confidence, source interaction, and **the words
that justified it**. The dashboard cannot say "budget: $4,200" — it says
*"budget: $4,200, from 'up to about forty-two hundred', call #1, 87% confident."*

Human corrections outrank the model permanently, at any confidence. Between two AI
extractions the later one wins, because people revise mid-call.

This was built in from the first commit deliberately. Retrofitting provenance means going
back through every field and guessing where values came from.

## Layout

```
src/knowledge/      the three-way classification, article governance, decision engine
src/leasing/        the quote gate and evidence provenance
src/inventory/      validating loader, matching, the priced-out branch
src/booking/        read-back verification and idempotency
src/escalation/     emergency detection and escalation context
src/conversation/   the tools, where the guards actually live
src/record/         the shared operational record
src/email/          template rendering with escaping
src/vapi/           system prompt and assistant config
src/ops/            the session gate in front of the dashboard and its log
src/auth/           persisted user sessions, membership/grant and channel authorization
src/properties/     validated immutable published property bundles and request context
src/database/       restricted PostgreSQL connections and scoped repositories
src/application/    runtime selection and request-to-property resolution
api/vapi.ts         the webhook Vapi calls; GET serves the dashboard log, gated
api/dashboard.ts    sign-in, property selection and the protected operations dashboard
api/properties.ts   authenticated catalogue of properties the user may open
data/               the demo property, inventory, knowledge and policies
ops/dashboard.html  the dashboard page, compiled into api/dashboard.ts
public/             the building website — and only what is safe to serve openly
scripts/            build, deploy manifest, assistant config, data validation
```

## Who can read the call log

The portal contains caller names, contact details and conversation excerpts. It is
served by `api/dashboard.ts` after sign-in and is never copied into `public/`.

With `ATRIUM_RUNTIME_MODE=postgres`, staff sign in with their username and password;
the server resolves a persisted user. Enrolled users and owner/admin/staff accounts
also verify with a passkey. First setup confirms the existing password, creates the
passkey and verifies it once. No account credentials are reset. Database setup is not
part of each login. The session
contains user identity, credential version and a registered session ID with fixed
expiration, not an active property or cached role. Every request checks that registry;
clearing a cookie alone is not logout. Sessions expire after eight hours, with up to
20 active logins per user. See [session management](docs/adr/0005-revocable-sessions.md)
for migration, revocation ordering and remaining identity controls.
Each page selects its organization/property explicitly; every operational request
rechecks membership, grants and published configuration. Separate tabs can operate
on separate properties with one user session. Viewers can read; staff can operate;
tour-settings changes require `configure`. The UI follows these permissions and the
server independently enforces them.

Interactive PostgreSQL sign-in reserves shared username and client-network budgets
before password verification. Limits survive restarts and multiple application
instances, return a generic retry time, and refuse new sign-ins if the protection
database is unavailable. Existing sessions remain usable. See the
[login protection decision](docs/adr/0004-login-protection.md) for limits, deployment
requirements and remaining identity-security work.

Without the PostgreSQL opt-in, the legacy named-account or shared-passcode adapter
remains available. Those modes and their restrictions are documented in
[TENANCY.md](TENANCY.md). Missing/invalid authentication refuses access. Robots rules
and no-cache headers supplement authentication; they do not grant or deny access.

### Environment variables the deployment reads

| Variable | What it is | If it is wrong |
|---|---|---|
| `ATRIUM_RUNTIME_MODE=postgres` | Selects the PostgreSQL adapter explicitly | Unknown or present blank modes fail closed; database URLs without this mode also fail |
| `ATRIUM_DATABASE_URL`, `ATRIUM_AUTH_DATABASE_URL` | Deployment-level URLs using the exact `atrium_app` and `atrium_authenticator` roles | Requests fail; no fallback to another property's bundle or memory |
| `OPS_SESSION_SECRET` | Independent signing secret, at least 32 characters; required for PostgreSQL and legacy named accounts | Sessions cannot be issued or verified |
| `ATRIUM_AUTH_ORIGIN` | Exact canonical HTTPS portal origin for PostgreSQL passkeys; localhost HTTP is allowed in development | Missing/invalid origins refuse managed access; request headers never choose the origin |
| `ATRIUM_DATABASE_CA` (optional) | PEM CA for a database requiring a custom trusted certificate chain | Untrusted nonlocal TLS connections are refused |
| `OPS_ACCOUNTS_JSON`, `OPS_DASHBOARD_PASSCODE` | Legacy named accounts or shared passcode; ignored as identity sources in PostgreSQL mode | Invalid legacy configuration refuses sign-in |
| `VAPI_API_KEY` (or `VAPI_PRIVATE_KEY`) | Vapi **private** key, from Vapi → Organization → API Keys. The public key is refused with 401 | Status shows "call recordings and transcripts: connected, but not answering"; Calls stays empty. `VAPI_PRIVATE_KEY` wins when both exist |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Legacy Redis/KV storage; both are required in hosted legacy mode | Missing/partial configuration or a failed connection refuses storage operations; hosted mode never uses memory |
| `VAPI_ASSISTANT_ID` (optional, legacy only) | Pins the existing bundled-property publisher; PostgreSQL uses authorized `channel_bindings` instead | Legacy publishing refuses an ambiguous assistant selection; PostgreSQL property publishing is not enabled |

Configure database URLs, the session secret and authentication origin once for each deployment environment.
Create additional staff users and client/property access in PostgreSQL, not new
environment files. URLs contain no query parameters or fragments; runtime roles must
not be administrators or inherit each other. Account records and grants require an
authorized provisioning workflow; these runtime settings do not create users or complete
customer onboarding. See [.env.example](.env.example) and [account modes](TENANCY.md).

PostgreSQL properties require a complete published bundle, including
`property.tourSettings`; they never inherit bundled Larkin defaults. Stored calendar
settings can override the published initial tour rules. Publishing new property
facts advances the configuration version and requires open pages to reload.

## Working in this repo

Node runs the TypeScript in **strip-only mode**, without
TypeScript syntax needing real transformation: no `enum`, no constructor parameter
properties, no `namespace`, no decorators. Types, interfaces and `satisfies` are fine.

`pg` is a runtime dependency. TypeScript, esbuild, the simulator SDK, and the isolated
PostgreSQL test tooling are development dependencies. API bundles include their
JavaScript dependencies and an ESM `createRequire` bridge for CommonJS dependencies.
Every build imports the actual bundled handlers in a clean child process, outside
`node_modules`, and checks safe refusal with unconfigured storage.

### Simulated calls

`npm run simulate` plays synthetic callers against the real webhook handler in a dedicated
worker for each scenario. It uses the model, prompt and tool schemas from the repository's
assistant configuration (`src/vapi/assistant.ts`), which may differ from the published Vapi
assistant until a coordinated release.

Assistant publishing now checks `/api/health` for the exact tool-schema fingerprint
and working durable storage before changing Vapi. It also requires
`VAPI_WEBHOOK_CREDENTIAL_ID` and `VAPI_WEBHOOK_SECRET`; the credential must send the
matching secret to the webhook. Publish the backend and assistant as one reviewed
release, then verify the saved assistant and run conversation tests. A matching
fingerprint proves compatibility, not voice quality, latency, or a passing call.

The fictional Larkin catalogue has explicit source metadata in
`data/inventory-source.json`. Its original date and version remain visible to the
tools; sample rents and availability can be demonstrated without relabeling old
data as a live PMS feed. Real inventory, including sources without demo provenance,
still requires the freshness checks. Published PostgreSQL configurations carry this
declaration in `inventoryProvenance`; changing it requires a new configuration version.
Every tool call goes through `api/vapi.ts`, so the quote gate, the calendar and the
knowledge guard are the real ones. The scenarios in `src/sim/scenarios.ts` are the calls
that went badly: a two bedroom on a four thousand budget, a tour booking, a specific
residence, a floor plan, pets and amenities, a service animal, a gas smell, a caller who
wants a price first, a caller who hangs up.

Each call is checked by rules (`src/sim/grade.ts` — money in words, no repeated line, no
residence a tool did not return, no rent before a lookup, the booking or escalation the
scenario expects) and then by a stronger model as a judge. The report is written to
`sim-reports/` (git-ignored) and the command exits non-zero if anything failed.

```
ANTHROPIC_API_KEY=… npm run simulate                  # everything, judged
npm run simulate -- --scenario evan --no-judge        # one call, rules only
npm run simulate -- --list
npm run simulate -- --preflight                      # no model key or model calls
```

Each worker uses a new synthetic tenant, memory storage and generated local credentials.
It does not inherit production environment variables; application network transports are
blocked before the handler loads. This is application isolation, not an operating-system
sandbox for untrusted code. Model requests run in the parent process against the fixed
Anthropic Messages endpoint; their API key is not passed to workers or written to reports.

The preflight checks isolation without evaluating an assistant. Full runs test text, tool
arguments and real handler behavior; they do not measure speech quality, transcription,
interruptions or voice latency. Vapi-native simulations require every live tool to be
mocked and event delivery reviewed before running against a saved assistant.

Keep secrets out of source, browser bootstrap, logs and reports. The credential
inventory is in `src/config/env.ts`; runtime configuration is also validated at the
database, account and webhook boundaries. Provision database-owner credentials only
to the separate administrative workflow, never to an API connection.

## What is not real yet

- **SMS** — needs 10DLC, which needs the EIN.
- **Apple Messages for Business** — needs the entity and Apple's review.
- **The tour calendar** persists through the selected PostgreSQL or legacy KV adapter. Only nonhosted legacy development may use memory. It is not connected to Google Calendar or a PMS.
- **Decision events** remain process-local and reset on cold start. Call history comes from Vapi; profiles, follow-ups and active call state use the selected durable adapter. Transactional mutation audits are separate from conversation decision events.
- **Customer onboarding and operations** still need provisioning/publication UI, normalized operational models, durable workers/outbox, backup/recovery operations, maintenance/vendor/resident workflows, and full product acceptance. No hosted database or production restore is established by the local tests.
- **The building is fictional.** Every residence, rent and policy is invented.

## Traceability

Dashboard access control and the credential inventory are SOW §15.2 and §18.2.

Knowledge governance is SOW §7.3; the never-guess rule §5.2(3), §6.2 and §7.1;
restricted-topic escalation §3.2, §5.2(7) and §10; the quote gate §5.2(4); evidence-linked
prospect records §6.3; loss-reason capture §6.2; read-back verification and truthful
messaging §13.3; emergency routing §8.1; escalation context §10; secrets and credential
inventory §15.2 and §18.2.

## Quality and CRM refresh

The operations workspace uses a white and navy theme, with shared styling for the Today,
Calls, Leads, Calendar and Status views. The PostgreSQL page uses authoritative
property branding, timezone and contact details, an authorized property switcher,
and read-only controls for viewers. Switching properties loads a new page; no shared
active-property cookie can silently retarget another tab.

Run `npm run dev:ops` for the local preview at `http://localhost:4300/`;
`npm run dev:ops -- --port 4301` chooses another HTTP port. The preview owns a private
loopback PostgreSQL database in ignored `.atrium-local/`. It imports the existing
`larkin` account hash from `.env.demo-account.json` once, preserving that password.
If no local account exists, startup creates one and shows its generated password
once in the terminal. Later starts authenticate against persisted database users;
they do not overwrite password changes, memberships or staff edits. Editing the old
import file does not reset a persisted password. The local fixture maps legacy
`demo-larkin` to PostgreSQL organization `org-demo-larkin` and property `prop-demo`;
it does not copy accounts or credentials into a hosted deployment.

Sample calls are imported once, with checkpointed progress and retained dates.
`--no-seed` skips call import without clearing saved data. Only one preview process
may open the same local database, even on different HTTP ports. Stop it normally
before reopening. Invalid files or uncertain interrupted imports refuse rather
than reset data. The preview ignores external database/KV/Vapi credentials and
does not connect to a PMS; bundled fictional inventory retains its source timestamp.
Users sign in normally after startup; no per-user environment setup is needed.
See [local database notes](db/README.md#local-preview-and-verification) and
[local account persistence](TENANCY.md#persistent-local-preview).

The Calendar view can browse any supported date with previous/next controls or **Go to
date**; it loads the displayed day or week instead of stopping after two weeks. **Tour
settings** controls staff capacity, duration, start-time spacing, preparation/reset
buffers, minimum notice, advance booking limits, same-apartment sharing and weekly hours.
Leaving the booking limit empty allows bookings without an advance limit. Settings apply
to new availability; existing tour times and their reserved staff time remain unchanged.
Settings and bookings belong to the selected authorized property. The verified Vapi
channel binding selects that same property's data and showing rules.

Scheduling and spoken/follow-up times use the property's IANA timezone, including
daylight-saving transitions. Existing callers without an explicit legacy timezone
default to New York. This is Atrium's own calendar, without PMS or external-calendar
synchronization. See [the PostgreSQL request contract](db/README.md#http-and-portal-contract)
and [legacy calendar API](TENANCY.md#tour-settings-and-calendar-api).

`npm run build` regenerates the website and embedded dashboard, removes retired API
bundles, and verifies all current handlers, including `/api/properties`. Git-based
deployments discover `api/*.ts`; `scripts/deploy-manifest.mjs` packages every bundled
`api/*.mjs` for the separate manifest path. No rewrite redirects API paths to public
HTML. API no-cache/no-index headers cover both paths. This follows Vercel's
[Node.js function file routing](https://vercel.com/docs/functions/runtimes/node-js).
GitHub Actions runs checks, real database tests and the build on pushes and pull requests.

The Vapi configuration includes `capture_contact`, so callers' names and emails can be
saved without booking a tour. `scripts/vapi-assistant.mjs` generates artifacts for the
bundled fictional Larkin assistant and its configured server origin. It is not a
general PostgreSQL property publisher. Property assistant publication remains disabled
until the versioned configuration/webhook rollout is implemented. Tool scheduling
uses the verified property's timezone; the simulator uses its injected clock.

See [QUALITY_REVIEW.md](QUALITY_REVIEW.md) for the fixes, validation and remaining live-service checks.
