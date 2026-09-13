# Hosted PostgreSQL demo setup

This is a one-time deployment operation for the fictional Larkin demo. Staff log
in with a saved username and password; they do not manage environment files.
Owner/admin/staff accounts also require a passkey. First login includes password
confirmation, passkey registration and a separate verification. Only the person
holding the device should complete their real passkey enrollment.

The procedure starts fresh operational records. It does not copy legacy KV state,
delete that state, erase Vapi recordings, or modify other projects. Repeated setup
preserves existing account passwords, roles and operational data. An incompatible
existing Atrium schema or bootstrap manifest causes refusal instead of a reset.
This finite fixture is not a general customer-onboarding or backup system.

## Free provider setup

Select a Supabase organization on the **Free** plan and create a dedicated Atrium
project. Verify the selected plan before submission. Do not put a new project in
a paid organization merely because it is selected by default. Use a supported US
region near the application deployment; copy the actual connection host from the
project's Connect dialog.

As verified on 2026-09-10, [Supabase Free](https://supabase.com/pricing) includes a
500 MB database, 5 GB egress and at most two active free projects. It may pause after
one week of inactivity and has no automatic backups. Check the project before a
scheduled presentation. Existing Vercel and Vapi charges are separate. This script
does not select a plan, buy resources or keep a project artificially active.

Use **Session pooler** on port 5432 for maintenance on an IPv4 network, or the
direct project endpoint if IPv6 is reachable. The application uses the same shared
pooler on port 6543 with custom role usernames. No paid IPv4 add-on is necessary.
[Supabase connection documentation](https://supabase.com/docs/guides/database/connecting-to-postgres)
describes the endpoints and custom-role username suffix. TLS verification remains
enabled. If a custom CA is needed, obtain it from the provider's project settings;
never set `rejectUnauthorized:false` or add `sslmode=disable`.

## Private operator input

Keep setup inputs in a private directory outside version control, with directory
mode 0700 and configuration-file mode 0600. The CLI refuses a symbolic-link,
group/world-readable or oversized configuration file. Do not put passwords,
database URLs or hashes in the command line, source, reports or chat.

The JSON configuration has these fields:

| Field | Value |
| --- | --- |
| `version` | `1` |
| `projectRef` | The exact 20-letter project reference shown by Supabase |
| `maintenanceUrl` | The copied direct/session PostgreSQL URL, with the maintenance password percent-encoded; `/postgres`, port 5432, no query or fragment |
| `origin` | Exact canonical HTTPS portal origin, such as `https://ghost-building.vercel.app`; no path or trailing slash |
| `appPassword`, `authPassword`, `sessionSecret` | Three distinct cryptographically random base64url strings, 32–128 characters each |
| `account` | Object containing `username: "larkin"`, `displayName`, and an existing supported `scrypt` `passwordHash`; no raw password |
| `bindings` | Array of `{id, externalId}` objects. `externalId` is the existing Vapi assistant UUID, not its phone number |
| `ca` | Optional trusted PEM certificate chain |

Generate account hashes with the repository's `hashPassword` function using a
private operator input mechanism. This setup can preserve the existing agreed
demo password; it is not a password reset. Database role secrets must be separate
from the account password. The primary demo owner receives only the explicit
Larkin property grant. No public Supabase Data API grants are added.

From the application repository, using Node 22:

```sh
node scripts/hosted-demo.mjs --check /private/operator/setup.json /private/operator/runtime.json
node scripts/hosted-demo.mjs --apply /private/operator/setup.json /private/operator/runtime.json
```

Use actual absolute paths in a private operator directory. `--check` validates
configuration only; it does not contact a database or prove readiness. `--apply`
requires a direct/session maintenance connection whose actual login can create
roles and schemas. The provisioner creates the seven restricted Atrium roles,
applies the ordered checksum-verified migrations, and atomically seeds the demo
account, grants, assistant bindings and published fictional property bundle.
It validates the seed with the same published-property loader used by the runtime.
The original inventory source date remains unchanged.

Before writing the new private output file, the CLI connects as **both actual
runtime roles**, checks that unscoped rows are hidden, and loads every Vapi binding
through the real property runtime. The output is a JSON map of deployment settings
with mode 0600. It never contains the maintenance URL or account hash. An existing
output file is not overwritten; use a new output path for a verified rerun.
Successful setup is not successful deployment or proof of voice quality.

Failures report only a sanitized stage/code, never raw SQL errors or credentials.
Preserve the database and original private input when retrying. Role creation,
migrations and seed are separate resumable phases. Do not delete a partially
initialized schema or regenerate role passwords to solve a failed phase.

## Activation and acceptance

1. Preserve the existing production Vapi webhook secret, Vapi private key, assistant
   routing and canonical webhook URL. Publish no assistant changes for this same
   Larkin database switch; the PostgreSQL assistant publisher is intentionally
   unavailable. Check that no call is active at cutover.
2. Set the generated five runtime variables in Vercel **Production** together:
   `ATRIUM_RUNTIME_MODE`, `ATRIUM_DATABASE_URL`, `ATRIUM_AUTH_DATABASE_URL`,
   `OPS_SESSION_SECRET`, and `ATRIUM_AUTH_ORIGIN`. Add the optional CA if supplied.
   Never deploy the maintenance credentials. Keep preview configuration separate.
3. Deploy the reviewed source with these production settings. Verify `/api/health`
   reports `store: "postgres"`, `ok: true`, `durable: true` and the expected voice
   contract. Its `callHistory: false` currently says nothing about Vapi-key health;
   verify the authorized Calls view separately.
4. Send unique, clearly synthetic Vapi-shaped webhook events directly to the
   backend, using the existing authentication secret. Check rejected credentials,
   unknown assistant IDs, contact capture, availability, tour-slot reads and
   idempotent end-report retries. Read back their scoped PostgreSQL records and
   audit attribution. Do not book a real tour or invoke a paid Vapi/model API.
5. Test a synthetic `tour_change` request: it must create a pending staff request,
   without claiming a tour moved or a notification was sent. Confirm there is no
   extra booking. Synthetic HTTP probes do not create native Vapi recordings.
6. Sign in as Larkin, complete the owner's real passkey setup, then verify Leads,
   Calendar, unit details and account security on desktop and mobile. Confirm
   anonymous and foreign-property requests are refused. Record what actually ran,
   and distinguish transport/database checks from a real voice-call acceptance.

If acceptance fails, restore the recorded prior production deployment/configuration
as one deliberate rollback. The runtime never automatically falls back from a
broken PostgreSQL connection to legacy KV. Do not call rollback a data merge:
records created after the switch exist in the new database only.

Track the selected free project, applied migration versions, exact source and
deployment IDs, role/TLS results, webhook readbacks and the remaining human passkey
step in a private handoff. Do not store secrets in that handoff. The migration
helper and native tests are repeatable setup evidence; hosted acceptance must be
recorded separately.
